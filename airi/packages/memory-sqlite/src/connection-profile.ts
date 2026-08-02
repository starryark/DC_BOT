import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SqliteDatabase } from 'node:sqlite'

import { MemoryError } from '@proj-airi/memory-domain'

import { migrate } from './migration-runner.js'

export const recommendedBusyTimeoutMs = 250

export interface SqliteProfile {
  readonly busyTimeoutMs?: number
  readonly readOnly?: boolean
}

/** Opens an explicitly selected file using the milestone-one durability profile. */
export function openSqliteDatabase(path: string, profile: SqliteProfile = {}): DatabaseSync {
  if (!path || path === ':memory:' || path.startsWith('file::memory:'))
    throw new MemoryError('INVALID_PAYLOAD', 'the production-shaped SQLite profile requires an explicit file path')
  const timeout = profile.busyTimeoutMs ?? recommendedBusyTimeoutMs
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60_000)
    throw new MemoryError('INVALID_PAYLOAD', 'busy timeout must be a bounded integer from 0 through 60000 ms')
  const database = new SqliteDatabase(path, { enableForeignKeyConstraints: true, readOnly: profile.readOnly, timeout })
  try {
    database.exec('PRAGMA foreign_keys = ON')
    if (!profile.readOnly) {
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = FULL')
      migrate(database)
    }
    verifySqliteProfile(database, { busyTimeoutMs: timeout, requireWal: !profile.readOnly })
    return database
  }
  catch (error) {
    database.close()
    throw error
  }
}

export function verifySqliteProfile(database: DatabaseSync, input: { busyTimeoutMs: number, requireWal?: boolean }): void {
  const pragmas = database.prepare('SELECT (SELECT * FROM pragma_foreign_keys) foreign_keys, (SELECT * FROM pragma_journal_mode) journal_mode, (SELECT * FROM pragma_synchronous) synchronous, (SELECT * FROM pragma_busy_timeout) busy_timeout').get() as Record<string, number | string>
  if (pragmas.foreign_keys !== 1 || (input.requireWal !== false && String(pragmas.journal_mode).toLowerCase() !== 'wal') || pragmas.synchronous !== 2 || pragmas.busy_timeout !== input.busyTimeoutMs)
    throw new MemoryError('PERSISTENCE_FAILED', 'SQLite connection does not match the required durability profile', { details: pragmas })
}

/** Converts exhausted SQLite lock waits to the persistence contract without retrying indefinitely. */
export function classifySqliteFailure(error: unknown): never {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'ERR_SQLITE_ERROR' && String((error as Error).message).includes('locked'))
    throw new MemoryError('PERSISTENCE_FAILED', 'SQLite busy timeout was exhausted', { cause: error, details: { classification: 'SQLITE_BUSY_EXHAUSTED' } })
  throw error
}
