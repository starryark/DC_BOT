import type { DatabaseSync } from 'node:sqlite'

import process from 'node:process'

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync as SqliteDatabase } from 'node:sqlite'

import { MemoryError } from '@proj-airi/memory-domain'

import { openSqliteDatabase } from './connection-profile.js'

/** Versioned so a future incompatible lease protocol cannot silently share ownership. */
export const sqliteWriterOwnershipGuardVersion = 1

/** Short enough for startup, long enough to distinguish ordinary filesystem scheduling from contention. */
export const recommendedOwnershipTimeoutMs = 500

export interface SqliteWriterOwnershipOptions {
  readonly acquisitionTimeoutMs?: number
}

export interface OpenAuthoritativeSqliteOptions extends SqliteWriterOwnershipOptions {
  readonly busyTimeoutMs?: number
}

/** A typed, sanitized startup failure: callers never need to parse native SQLite text. */
export class SqliteWriterOwnershipError extends MemoryError {
  constructor(acquisitionTimeoutMs: number, cause?: unknown) {
    super('UNAVAILABLE', 'authoritative SQLite write ownership is already held by another process; stop the duplicate instance or retry after the active owner exits', {
      cause,
      retryable: true,
      details: {
        classification: 'SQLITE_WRITER_OWNERSHIP_UNAVAILABLE',
        acquisitionTimeoutMs,
        guardVersion: sqliteWriterOwnershipGuardVersion,
      },
    })
    this.name = 'SqliteWriterOwnershipError'
  }
}

export interface SqliteWriterOwnership {
  readonly authorityIdentity: string
  readonly leasePath: string
  readonly acquisitionTimeoutMs: number
  readonly held: boolean
  close: () => void
}

export interface AuthoritativeSqliteHandle {
  readonly database: DatabaseSync
  readonly ownership: SqliteWriterOwnership
  readonly closed: boolean
  close: () => void
}

function boundedTimeout(value: number | undefined): number {
  const timeout = value ?? recommendedOwnershipTimeoutMs
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
    throw new MemoryError('INVALID_PAYLOAD', 'ownership acquisition timeout must be a bounded integer from 1 through 60000 ms')
  return timeout
}

/**
 * Canonicalizes an authority path for ownership comparison.
 *
 * Before:
 * - "C:\\data\\folder\\..\\memory.db"
 * - an existing symlink or junction alias
 *
 * After:
 * - the real parent/file identity, with case folded on Windows
 */
export function canonicalSqliteAuthorityIdentity(path: string): string {
  if (!path || path === ':memory:' || path.startsWith('file::memory:'))
    throw new MemoryError('INVALID_PAYLOAD', 'authoritative SQLite ownership requires an explicit file path')

  const absolute = resolve(path)
  // Existing files can be resolved directly. For first startup, resolving the
  // existing parent still collapses junction/symlink aliases before creation.
  const canonical = existsSync(absolute)
    ? realpathSync.native(absolute)
    : join(realpathSync.native(dirname(absolute)), basename(absolute))
  return process.platform === 'win32' ? canonical.toLocaleLowerCase('en-US') : canonical
}

/** Derives a collision-resistant lease file without placing the authority path in its name. */
export function sqliteWriterLeasePath(authorityPath: string): string {
  const identity = canonicalSqliteAuthorityIdentity(authorityPath)
  const digest = createHash('sha256').update(`dc-bot-sqlite-writer-v${sqliteWriterOwnershipGuardVersion}\0${identity}`).digest('hex')
  return join(dirname(identity), `.dc-bot-writer-${digest}.lease.sqlite`)
}

function sqliteLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error == null)
    return false
  const code = 'code' in error ? String(error.code) : ''
  const message = 'message' in error ? String(error.message).toLowerCase() : ''
  return code === 'ERR_SQLITE_ERROR' && (message.includes('locked') || message.includes('busy'))
}

/**
 * Acquires process-level authority using a separate SQLite/VFS lock.
 *
 * The lease database contains no application data. Its live rollback-journal
 * transaction is the authority; the file's existence is not. OS handle cleanup
 * therefore releases ownership after either orderly close or abrupt death.
 */
export function acquireSqliteWriterOwnership(authorityPath: string, options: SqliteWriterOwnershipOptions = {}): SqliteWriterOwnership {
  const acquisitionTimeoutMs = boundedTimeout(options.acquisitionTimeoutMs)
  const authorityIdentity = canonicalSqliteAuthorityIdentity(authorityPath)
  const leasePath = sqliteWriterLeasePath(authorityIdentity)
  let lease: DatabaseSync | undefined
  try {
    lease = new SqliteDatabase(leasePath, { timeout: acquisitionTimeoutMs })
    lease.exec(`PRAGMA busy_timeout = ${acquisitionTimeoutMs}`)
    lease.exec('PRAGMA journal_mode = DELETE')
    lease.exec('PRAGMA synchronous = FULL')
    lease.exec('BEGIN IMMEDIATE')
  }
  catch (error) {
    try {
      lease?.close()
    }
    catch {}
    if (sqliteLockContention(error))
      throw new SqliteWriterOwnershipError(acquisitionTimeoutMs, error)
    throw new MemoryError('PERSISTENCE_FAILED', 'SQLite writer ownership could not be initialized', {
      cause: error,
      details: { classification: 'SQLITE_WRITER_OWNERSHIP_INITIALIZATION_FAILED', guardVersion: sqliteWriterOwnershipGuardVersion },
    })
  }

  let held = true
  return {
    authorityIdentity,
    leasePath,
    acquisitionTimeoutMs,
    get held() { return held },
    close() {
      if (!held)
        return
      held = false
      try {
        lease.exec('ROLLBACK')
      }
      finally {
        lease.close()
      }
    },
  }
}

/** Opens the deployment authority only after acquiring process-level write ownership. */
export function openAuthoritativeSqliteDatabase(path: string, options: OpenAuthoritativeSqliteOptions = {}): AuthoritativeSqliteHandle {
  const ownership = acquireSqliteWriterOwnership(path, options)
  let database: DatabaseSync
  try {
    database = openSqliteDatabase(path, { busyTimeoutMs: options.busyTimeoutMs })
  }
  catch (error) {
    ownership.close()
    throw error
  }

  let closed = false
  return {
    database,
    ownership,
    get closed() { return closed },
    close() {
      if (closed)
        return
      closed = true
      try {
        database.close()
      }
      finally {
        ownership.close()
      }
    },
  }
}
