import type { ChildProcess } from 'node:child_process'
/* eslint-disable style/max-statements-per-line -- compact synthetic SQL setup and close operations keep the integration schedules readable */
import type { DatabaseSync } from 'node:sqlite'

import { fork } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as SqliteDatabase } from 'node:sqlite'

import { afterEach, describe, expect, it } from 'vitest'

import { captureDeletionObligations, createVerifiedBackup, replayDeletionObligations, restoreVerifiedBackup, verifyDatabase } from './backup.js'
import { classifySqliteFailure, openSqliteDatabase } from './connection-profile.js'
import { executeIdempotently } from './idempotency.js'
import { migrate } from './migration-runner.js'
import { migrations } from './migrations/index.js'
import { ReconciliationQueue } from './reconciliation-queue.js'
import { UnitOfWork } from './unit-of-work.js'

const roots: string[] = []
async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'dc-bot-imp208-')); roots.push(value); return value }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

function tables(database: DatabaseSync): void {
  database.exec(`CREATE TABLE imp208_operations(id TEXT PRIMARY KEY, room TEXT NOT NULL, room_sequence INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(room,room_sequence)); CREATE TABLE imp208_crash_rows(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE imp208_canaries(id TEXT PRIMARY KEY,eligible INTEGER NOT NULL CHECK(eligible IN(0,1)))`)
}

function child(path: string, mode: string): Promise<ChildProcess> {
  const fixture = new URL('./fixtures/crash-child.mjs', import.meta.url)
  return new Promise((resolve, reject) => {
    const process = fork(fixture, [path, mode], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    process.once('error', reject)
    if (mode === 'before-begin')
      process.once('exit', () => resolve(process))
    else process.once('message', () => resolve(process))
  })
}

async function exited(process: ChildProcess): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null)
    return
  await new Promise<void>(resolve => process.once('exit', () => resolve()))
}

describe('imp-208 file-backed SQLite profile', () => {
  it('serializes different-room and same-room writers without lost or duplicate operations', async () => {
    const path = join(await root(), 'concurrency.db')
    const first = openSqliteDatabase(path, { busyTimeoutMs: 500 })
    tables(first)
    const second = openSqliteDatabase(path, { busyTimeoutMs: 500 })
    new UnitOfWork(first).run(db => db.prepare('INSERT INTO imp208_operations VALUES (?,?,?,?)').run('a', 'room-a', 1, 'synthetic'))
    new UnitOfWork(second).run(db => db.prepare('INSERT INTO imp208_operations VALUES (?,?,?,?)').run('b', 'room-b', 1, 'synthetic'))
    for (const [id, sequence] of [['same-1', 1], ['same-2', 2]] as const)
      new UnitOfWork(sequence === 1 ? first : second).run(db => db.prepare('INSERT INTO imp208_operations VALUES (?,?,?,?)').run(id, 'same-room', sequence, 'synthetic'))
    expect(first.prepare('SELECT id FROM imp208_operations ORDER BY room,room_sequence').all()).toHaveLength(4)
    expect(() => second.prepare('INSERT INTO imp208_operations VALUES (?,?,?,?)').run('collision', 'same-room', 2, 'synthetic')).toThrow()
    verifyDatabase(first)
    first.close(); second.close()
  })

  it('provides a committed WAL snapshot to a reader and bounds writer-lock exhaustion', async () => {
    const path = join(await root(), 'locks.db')
    const setup = openSqliteDatabase(path, { busyTimeoutMs: 100 }); tables(setup)
    const reader = openSqliteDatabase(path, { busyTimeoutMs: 100 })
    setup.prepare('INSERT INTO imp208_operations VALUES (\'visible\',\'room\',1,\'before\')').run(); setup.close()
    const holder = openSqliteDatabase(path, { busyTimeoutMs: 100 })
    holder.exec('BEGIN IMMEDIATE')
    holder.prepare('INSERT INTO imp208_crash_rows(id,value) VALUES (?,?)').run('held-uncommitted', 'synthetic')
    expect(reader.prepare('SELECT payload FROM imp208_operations WHERE id=?').get('visible')).toMatchObject({ payload: 'before' })
    const started = performance.now()
    expect(() => {
      try { new UnitOfWork(reader).run(db => db.prepare('INSERT INTO imp208_operations VALUES (\'blocked\',\'room\',2,\'never\')').run()) }
      catch (error) { classifySqliteFailure(error) }
    }).toThrow(/busy timeout was exhausted/)
    expect(performance.now() - started).toBeGreaterThanOrEqual(75)
    expect(performance.now() - started).toBeLessThan(600)
    expect(reader.prepare('SELECT count(*) count FROM imp208_operations WHERE id=\'blocked\'').get()).toMatchObject({ count: 0 })
    holder.exec('ROLLBACK')
    verifyDatabase(reader); reader.close(); holder.close()
  })

  it('fences competing queue claimers and safely reclaims an expired reused-worker lease', async () => {
    const path = join(await root(), 'queue.db')
    const one = openSqliteDatabase(path); const two = openSqliteDatabase(path)
    new ReconciliationQueue(one).enqueue({ jobId: 'job', jobType: 'test', dedupeKey: 'one', payload: { safe: true }, availableAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', maxAttempts: 3 })
    const first = new ReconciliationQueue(one, () => 'token-1').claim('worker', '2026-01-01T00:00:00.000Z', 1000)!
    expect(new ReconciliationQueue(two).claim('other', '2026-01-01T00:00:00.000Z', 1000)).toBeUndefined()
    const reclaimed = new ReconciliationQueue(two, () => 'token-2').claim('worker', '2026-01-01T00:00:02.000Z', 1000)!
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken)
    expect(() => new ReconciliationQueue(one).succeed('job', first.leaseToken!, '2026-01-01T00:00:02.100Z')).toThrow(/stale/)
    new ReconciliationQueue(two).succeed('job', reclaimed.leaseToken!, '2026-01-01T00:00:02.100Z')
    verifyDatabase(one); one.close(); two.close()
  })

  it.each(['before-begin', 'after-begin', 'before-commit', 'after-commit', 'wal-workload', 'before-checkpoint'])('recovers after abrupt process death at %s', async (mode) => {
    const path = join(await root(), `${mode}.db`)
    const setup = openSqliteDatabase(path); tables(setup); setup.close()
    const process = await child(path, mode); await exited(process)
    const reopened = openSqliteDatabase(path)
    verifyDatabase(reopened)
    expect(reopened.prepare('SELECT count(*) count FROM imp208_crash_rows WHERE id=\'interrupted\'').get()).toMatchObject({ count: 0 })
    if (mode === 'after-commit')
      expect(reopened.prepare('SELECT count(*) count FROM imp208_crash_rows WHERE id=\'committed\'').get()).toMatchObject({ count: 1 })
    reopened.exec('PRAGMA wal_checkpoint(TRUNCATE)'); reopened.close()
  })

  it('backs up, verifies, restores, and reapplies a post-backup deletion obligation before publication', async () => {
    const directory = await root(); const sourcePath = join(directory, 'source.db'); const backupPath = join(directory, 'snapshot.db'); const restorePath = join(directory, 'restored.db')
    const source = openSqliteDatabase(sourcePath); tables(source)
    source.prepare('INSERT INTO imp208_canaries VALUES (\'privacy-canary\',1)').run()
    executeIdempotently(source, { namespace: 'test', key: 'stable', request: { value: 1 }, createdAt: '2026-01-01T00:00:00.000Z' }, () => ({ result: 'ok' }))
    new ReconciliationQueue(source).enqueue({ jobId: 'backup-job', jobType: 'test', dedupeKey: 'backup', payload: { safe: true }, availableAt: '2026-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z', maxAttempts: 3 })
    const manifest = await createVerifiedBackup(source, sourcePath, backupPath, '2026-01-01T00:00:01.000Z')
    expect(JSON.parse(await readFile(`${backupPath}.manifest.json`, 'utf8'))).toEqual(manifest)
    const orphan = join(directory, 'orphan.db')
    await copyFile(backupPath, orphan)
    await expect(restoreVerifiedBackup(orphan, join(directory, 'rejected.db'), () => {})).rejects.toThrow(/restore failed/)
    await restoreVerifiedBackup(backupPath, restorePath, (db) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('UPDATE imp208_canaries SET eligible=0 WHERE id=\'privacy-canary\'').run()
        db.prepare('INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (\'restore-forget\',\'fact_id\',\'privacy-canary\',\'{}\',\'2026-01-01T00:00:02.000Z\',\'completed\',1,\'2026-01-01T00:00:02.000Z\',\'{}\',\'restore-forget\')').run()
        db.prepare('INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,verified_at,evidence_json) VALUES (\'restore-tombstone\',\'restore-forget\',\'imp208_canaries\',\'privacy-canary\',\'verified\',\'2026-01-01T00:00:02.000Z\',\'2026-01-01T00:00:02.000Z\',\'{}\')').run()
        db.exec('COMMIT')
      }
      catch (error) { db.exec('ROLLBACK'); throw error }
    })
    const restored = openSqliteDatabase(restorePath)
    expect(restored.prepare('SELECT count(*) count FROM imp208_canaries WHERE id=\'privacy-canary\' AND eligible=1').get()).toMatchObject({ count: 0 })
    expect(restored.prepare('SELECT count(*) count FROM worker_jobs').get()).toMatchObject({ count: 1 })
    expect(restored.prepare('SELECT count(*) count FROM idempotency_records').get()).toMatchObject({ count: 1 })
    verifyDatabase(restored); restored.close(); source.close()
  })

  // ROOT CAUSE:
  //
  // Restore previously required the backup manifest to equal the current
  // schema exactly, so shipping schema v8 would have made every existing v7
  // backup unrestorable — including the ones holding deletion obligations.
  //
  // Restore now accepts a known migration *prefix* and runs the forward-only
  // migration runner inside the isolated candidate before verification.
  // `verifyDatabase` itself is unchanged, so live databases and newly created
  // backups still require the complete current history.
  it('restores a verified v7 backup by migrating the isolated candidate to v8 and replaying obligations', async () => {
    const directory = await root()
    const backupPath = join(directory, 'v7-snapshot.db')
    const restorePath = join(directory, 'v7-restored.db')

    // A database exactly as an older build left it: seven migrations applied.
    // `openSqliteDatabase` migrates to latest on open, so a version-pinned
    // fixture must use a raw handle.
    const legacy = new SqliteDatabase(backupPath, { enableForeignKeyConstraints: true })
    migrate(legacy, migrations.slice(0, 7))
    legacy.prepare('INSERT INTO logical_rooms(logical_room_id,isolation_scope_type,isolation_scope_id,room_kind,created_at) VALUES (\'logical\',\'unbound_channel\',\'logical\',\'unbound_channel\',\'2026-01-01T00:00:00Z\')').run()
    legacy.prepare('INSERT INTO physical_room_records(physical_room_id,locator_key,platform,channel_id,channel_kind,guild_id,lifecycle,observed_at) VALUES (\'physical\',\'discord:guild:1:2\',\'discord\',\'2\',\'guild_text\',\'1\',\'active\',\'2026-01-01T00:00:00Z\')').run()
    legacy.prepare('INSERT INTO inbound_event_records(event_id,idempotency_key,event_kind,actor_kind,actor_json,physical_room_id,logical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash) VALUES (\'legacy-canary\',\'canary-key\',\'system\',\'anonymous\',\'{"kind":"anonymous","source":"system"}\',\'physical\',\'logical\',1,\'2026-01-01T00:00:00Z\',\'2026-01-01T00:00:00Z\',\'{"content":"pre-migration secret"}\',\'transcript\',\'hash\')').run()
    legacy.prepare('INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (\'legacy-forget\',\'fact_id\',\'legacy-canary\',\'{}\',\'2026-01-01T00:00:00.000Z\',\'completed\',1,\'2026-01-01T00:00:00.000Z\',\'{}\',\'legacy-forget\')').run()
    legacy.prepare('INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,verified_at,evidence_json) VALUES (\'legacy-tombstone\',\'legacy-forget\',\'inbound_event_records\',\'legacy-canary\',\'verified\',\'2026-01-01T00:00:00.000Z\',\'2026-01-01T00:00:00.000Z\',\'{}\')').run()
    const obligations = captureDeletionObligations(legacy)
    legacy.close()

    // The manifest an older build would have written: prefix version and checksums.
    const v7Manifest = { format: 1 as const, createdAt: '2026-01-01T00:00:01.000Z', schemaVersion: 7, migrationChecksums: migrations.slice(0, 7).map(item => item.checksum), bytes: (await stat(backupPath)).size }
    await writeFile(`${backupPath}.manifest.json`, JSON.stringify(v7Manifest), 'utf8')

    await restoreVerifiedBackup(backupPath, restorePath, database => replayDeletionObligations(database, obligations))

    const restored = openSqliteDatabase(restorePath)
    expect(restored.prepare('SELECT version FROM memory_schema_migrations ORDER BY version').all()).toEqual(migrations.map(item => ({ version: item.version })))
    // The v8 tables exist in the restored candidate and start empty.
    expect(restored.prepare('SELECT count(*) count FROM generation_context_manifests').get()).toMatchObject({ count: 0 })
    // The obligation survived the version gap: the row remains as topology
    // evidence while its content is redacted, exactly as the privacy model says.
    expect(restored.prepare('SELECT count(*) count FROM inbound_event_records WHERE event_id=\'legacy-canary\'').get()).toMatchObject({ count: 1 })
    expect(restored.prepare('SELECT payload_json FROM inbound_event_records WHERE event_id=\'legacy-canary\'').get()).toMatchObject({ payload_json: '{"redacted":true}' })
    verifyDatabase(restored)
    restored.close()
  })

  it('rejects an altered checksum, a future schema version, and a byte-count mismatch', async () => {
    const directory = await root()
    const source = join(directory, 'reject-source.db')
    const database = new SqliteDatabase(source, { enableForeignKeyConstraints: true })
    migrate(database, migrations.slice(0, 7))
    database.close()
    const bytes = (await stat(source)).size
    const base = { format: 1 as const, createdAt: '2026-01-01T00:00:01.000Z', schemaVersion: 7, migrationChecksums: migrations.slice(0, 7).map(item => item.checksum), bytes }

    const rejected: Record<string, unknown> = {
      alteredChecksum: { ...base, migrationChecksums: [...base.migrationChecksums.slice(0, 6), 'f'.repeat(64)] },
      futureSchemaVersion: { ...base, schemaVersion: migrations.length + 1, migrationChecksums: [...migrations.map(item => item.checksum), 'f'.repeat(64)] },
      byteMismatch: { ...base, bytes: bytes + 1 },
      // A truncated checksum list cannot describe the version it claims.
      inconsistentPrefixLength: { ...base, migrationChecksums: base.migrationChecksums.slice(0, 5) },
    }

    for (const [name, manifest] of Object.entries(rejected)) {
      const candidate = join(directory, `${name}.db`)
      await copyFile(source, candidate)
      await writeFile(`${candidate}.manifest.json`, JSON.stringify(manifest), 'utf8')
      await expect(restoreVerifiedBackup(candidate, join(directory, `${name}-out.db`), () => {})).rejects.toThrow(/restore failed/)
    }
  })

  it('upgrades every supported exact schema version and rejects malformed manifests', async () => {
    const directory = await root()
    for (let version = 0; version <= migrations.length; version++) {
      const database = openSqliteDatabase(join(directory, `v${version}.db`))
      database.close()
      const exact = new (await import('node:sqlite')).DatabaseSync(join(directory, `exact-${version}.db`))
      if (version > 0)
        migrate(exact, migrations.slice(0, version))
      expect(migrate(exact)).toEqual(migrations.slice(version).map(item => item.version))
      expect(exact.prepare('SELECT version FROM memory_schema_migrations ORDER BY version').all()).toHaveLength(8)
      verifyDatabase(exact); exact.close()
    }
    const malformed = new (await import('node:sqlite')).DatabaseSync(':memory:')
    expect(() => migrate(malformed, [migrations[1]!, migrations[0]!])).toThrow(/strictly increasing/)
    malformed.close()
  })
})
