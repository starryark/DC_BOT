import type { DatabaseSync } from 'node:sqlite'

import type { Migration } from './migrations/index.js'

import { createHash } from 'node:crypto'

import { MemoryError } from '@proj-airi/memory-domain'

import { migrations as knownMigrations } from './migrations/index.js'

const migrationTableSql = `
CREATE TABLE IF NOT EXISTS memory_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT
`

function fail(message: string, details: Readonly<Record<string, string | number>> = {}, cause?: unknown): never {
  throw new MemoryError('PERSISTENCE_FAILED', message, { cause, details })
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

function validateMigrations(migrations: readonly Migration[]): readonly Migration[] {
  const ordered = [...migrations]
  const versions = new Set<number>()

  for (const [index, migration] of ordered.entries()) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= 0)
      fail('Migration versions must be positive safe integers', { version: migration.version })
    if (versions.has(migration.version))
      fail('Duplicate migration version', { version: migration.version })
    if (index > 0 && ordered[index - 1]!.version >= migration.version)
      fail('Migration definitions must be supplied in strictly increasing order', { version: migration.version })
    versions.add(migration.version)

    const actualChecksum = checksum(migration.sql)
    if (actualChecksum !== migration.checksum)
      fail('Migration source checksum does not match its manifest', { version: migration.version, expected: migration.checksum, actual: actualChecksum })
  }

  return ordered
}

/**
 * Applies all known migrations in version order using one exclusive transaction
 * per migration. The function is idempotent and fails closed on future versions,
 * altered checksums, or a SQLite connection that cannot enforce foreign keys.
 */
export function migrate(database: DatabaseSync, migrations: readonly Migration[] = knownMigrations): readonly number[] {
  const ordered = validateMigrations(migrations)

  try {
    database.exec('PRAGMA foreign_keys = ON')
    const foreignKeys = database.prepare('PRAGMA foreign_keys').get() as { foreign_keys?: number } | undefined
    if (foreignKeys?.foreign_keys !== 1)
      fail('SQLite foreign-key enforcement is unavailable')

    database.exec(migrationTableSql)
    const appliedRows = database.prepare('SELECT version, checksum FROM memory_schema_migrations ORDER BY version').all() as Array<{ version: number, checksum: string }>
    const latestKnown = ordered.at(-1)?.version ?? 0
    const future = appliedRows.find(row => row.version > latestKnown)
    if (future)
      fail('Database schema is newer than this application supports', { databaseVersion: future.version, latestKnown })

    const byVersion = new Map(ordered.map(migration => [migration.version, migration]))
    for (const applied of appliedRows) {
      const migration = byVersion.get(applied.version)
      if (!migration)
        fail('Database contains an unknown migration version', { version: applied.version })
      if (migration.checksum !== applied.checksum)
        fail('Applied migration checksum does not match this application', { version: applied.version, expected: migration.checksum, actual: applied.checksum })
    }

    const appliedVersions = new Set(appliedRows.map(row => row.version))
    const newlyApplied: number[] = []
    for (const migration of ordered) {
      if (appliedVersions.has(migration.version))
        continue

      database.exec('BEGIN EXCLUSIVE')
      try {
        database.exec(migration.sql)
        database.prepare('INSERT INTO memory_schema_migrations(version, name, checksum) VALUES (?, ?, ?)').run(migration.version, migration.name, migration.checksum)
        database.exec('COMMIT')
        newlyApplied.push(migration.version)
      }
      catch (error) {
        database.exec('ROLLBACK')
        fail('SQLite migration failed and was rolled back', { version: migration.version }, error)
      }
    }
    return Object.freeze(newlyApplied)
  }
  catch (error) {
    if (error instanceof MemoryError)
      throw error
    fail('SQLite migration failed', {}, error)
  }
}
