import type { DatabaseSync } from 'node:sqlite'

import { randomUUID } from 'node:crypto'
import { access, copyFile, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { backup, DatabaseSync as SqliteDatabase } from 'node:sqlite'

import { MemoryError } from '@proj-airi/memory-domain'

import { latestSchemaVersion, migrations } from './migrations/index.js'

export interface BackupManifest { readonly format: 1, readonly createdAt: string, readonly schemaVersion: number, readonly migrationChecksums: readonly string[], readonly bytes: number }

export interface DeletionObligation {
  readonly forgetRequestId: string
  readonly targetTable: string
  readonly targetId: string
}

/** Capture the minimal, content-free deletion fence that must survive backup age. */
export function captureDeletionObligations(database: DatabaseSync): readonly DeletionObligation[] {
  return (database.prepare(`SELECT t.forget_request_id,t.target_table,t.target_id FROM deletion_tombstones t JOIN forget_requests f ON f.forget_request_id=t.forget_request_id WHERE f.status='completed' ORDER BY t.created_at,t.tombstone_id`).all() as Array<{ forget_request_id: string, target_table: string, target_id: string }>).map(row => ({ forgetRequestId: row.forget_request_id, targetTable: row.target_table, targetId: row.target_id }))
}

/** Reapply known obligations to an isolated restore candidate and verify absence. */
export function replayDeletionObligations(database: DatabaseSync, obligations: readonly DeletionObligation[]): void {
  const supported: Record<string, { sql: string, verify: string }> = {
    inbound_event_records: { sql: `UPDATE inbound_event_records SET payload_json=json_object('redacted',json('true')) WHERE event_id=?`, verify: `SELECT count(*) count FROM inbound_event_records WHERE event_id=? AND json_extract(payload_json,'$.redacted') IS NOT 1` },
    semantic_fact_repository_records: { sql: `UPDATE semantic_fact_repository_records SET tombstoned_by=coalesce(tombstoned_by,'restore-obligation') WHERE fact_id=?`, verify: `SELECT count(*) count FROM semantic_fact_repository_records WHERE fact_id=? AND tombstoned_by IS NULL` },
    episodic_repository_records: { sql: `UPDATE episodic_repository_records SET tombstoned_by=coalesce(tombstoned_by,'restore-obligation') WHERE episodic_id=?`, verify: `SELECT count(*) count FROM episodic_repository_records WHERE episodic_id=? AND tombstoned_by IS NULL` },
    summary_repository_records: { sql: `UPDATE summary_repository_records SET stale=1,tombstoned_by=coalesce(tombstoned_by,'restore-obligation') WHERE summary_id=?`, verify: `SELECT count(*) count FROM summary_repository_records WHERE summary_id=? AND tombstoned_by IS NULL` },
  }
  database.exec('BEGIN IMMEDIATE')
  try {
    for (const obligation of obligations) {
      const target = supported[obligation.targetTable]
      if (!target)
        throw new MemoryError('POLICY_VIOLATION', `unsupported deletion obligation target: ${obligation.targetTable}`)
      database.prepare(target.sql).run(obligation.targetId)
      const remaining = database.prepare(target.verify).get(obligation.targetId) as { count: number }
      if (remaining.count !== 0)
        throw new MemoryError('PERSISTENCE_FAILED', 'restore deletion obligation verification failed')
    }
    database.exec('COMMIT')
  }
  catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

function distinct(source: string, destination: string): void {
  if (resolve(source).toLowerCase() === resolve(destination).toLowerCase())
    throw new MemoryError('POLICY_VIOLATION', 'backup and restore paths must not overwrite the authoritative database')
}

async function requireUnused(path: string): Promise<void> {
  try {
    await access(path)
    throw new MemoryError('POLICY_VIOLATION', 'verified backup destinations must not overwrite an existing artifact')
  }
  catch (error) {
    if (error instanceof MemoryError)
      throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error
  }
}

export function verifyDatabase(database: DatabaseSync): void {
  const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
  const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
  if (integrity.integrity_check !== 'ok' || foreignKeys.length !== 0)
    throw new MemoryError('PERSISTENCE_FAILED', 'SQLite integrity verification failed')
  const rows = database.prepare('SELECT version,checksum FROM memory_schema_migrations ORDER BY version').all() as Array<{ version: number, checksum: string }>
  if (rows.length !== migrations.length || rows.some((row, index) => row.version !== migrations[index]!.version || row.checksum !== migrations[index]!.checksum))
    throw new MemoryError('PERSISTENCE_FAILED', 'backup migration history does not match the application manifest')
}

/** Creates and verifies an online SQLite snapshot, publishing data and manifest by atomic renames. */
export async function createVerifiedBackup(source: DatabaseSync, sourcePath: string, destination: string, createdAt: string): Promise<BackupManifest> {
  distinct(sourcePath, destination)
  const partial = `${destination}.partial-${randomUUID()}`
  const manifestPath = `${destination}.manifest.json`
  const manifestPartial = `${manifestPath}.partial-${randomUUID()}`
  try {
    await requireUnused(destination)
    await requireUnused(manifestPath)
    await backup(source, partial)
    const verification = new SqliteDatabase(partial, { readOnly: true })
    try {
      verifyDatabase(verification)
    }
    finally { verification.close() }
    const bytes = (await stat(partial)).size
    const manifest = Object.freeze({ format: 1 as const, createdAt, schemaVersion: latestSchemaVersion, migrationChecksums: migrations.map(item => item.checksum), bytes })
    await writeFile(manifestPartial, JSON.stringify(manifest), { encoding: 'utf8', flag: 'wx' })
    await rename(manifestPartial, manifestPath)
    await rename(partial, destination)
    return manifest
  }
  catch (error) {
    await Promise.all([rm(partial, { force: true }), rm(manifestPartial, { force: true })])
    throw new MemoryError('PERSISTENCE_FAILED', 'verified SQLite backup failed', { cause: error })
  }
}

/** Restores to an isolated path and applies required tombstones before publishing it. */
export async function restoreVerifiedBackup(backupPath: string, destination: string, reapplyObligations: (database: DatabaseSync) => void): Promise<void> {
  distinct(backupPath, destination)
  const partial = `${destination}.partial-${randomUUID()}`
  try {
    await requireUnused(destination)
    const manifest = JSON.parse(await readFile(`${backupPath}.manifest.json`, 'utf8')) as BackupManifest
    const backupBytes = (await stat(backupPath)).size
    if (manifest.format !== 1 || manifest.schemaVersion !== latestSchemaVersion || manifest.bytes !== backupBytes || manifest.migrationChecksums.length !== migrations.length || manifest.migrationChecksums.some((value, index) => value !== migrations[index]!.checksum))
      throw new MemoryError('PERSISTENCE_FAILED', 'backup manifest is missing, malformed, or does not match the snapshot')
    await copyFile(backupPath, partial)
    const restored = new SqliteDatabase(partial)
    try {
      restored.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL')
      verifyDatabase(restored)
      reapplyObligations(restored)
      verifyDatabase(restored)
      restored.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    }
    finally { restored.close() }
    await rename(partial, destination)
  }
  catch (error) {
    await rm(partial, { force: true })
    throw new MemoryError('PERSISTENCE_FAILED', 'verified SQLite restore failed', { cause: error })
  }
}
