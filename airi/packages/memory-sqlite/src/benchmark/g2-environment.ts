/**
 * Environment and SQLite-profile evidence capture.
 *
 * Everything recorded here is something a reviewer would otherwise have to
 * take on trust. The module is deliberately conservative about what it claims:
 * it can prove which pragmas a connection reports, and it cannot prove that a
 * path is on physically local storage, so it says so instead of guessing.
 */

import type { DatabaseSync } from 'node:sqlite'

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { arch, cpus, hostname, platform, release, totalmem } from 'node:os'
import { parse } from 'node:path'

import { migrations } from '../migrations/index.js'

/** How the claim "this database is on local, non-network storage" is supported. */
export type StorageLocalityVerification
  /** Proven by an automated check. The harness never emits this; no portable Node API establishes it. */
  = | 'automated'
  /** A named operator asserted it via `G2_STORAGE_ATTESTATION`. */
    | 'operator-attested'
  /** Nothing supports the claim yet. */
    | 'unknown'

/** Host, runtime, and repository identity for one run. */
export interface G2Environment {
  readonly nodeVersion: string
  readonly platform: string
  readonly osRelease: string
  readonly architecture: string
  readonly hostname: string
  readonly cpuCount: number
  readonly cpuModel: string
  readonly totalMemoryBytes: number
  readonly sqliteVersion: string
  readonly packageName: string
  readonly packageVersion: string
  readonly repositoryRevision: string
  readonly repositoryDirty: boolean | null
  readonly processId: number
  readonly parentProcessId: number
  readonly databasePath: string
  /** Drive letter or mount root of the database path; recorded as context, not as proof of locality. */
  readonly databaseVolumeRoot: string
  readonly storageLocalityVerification: StorageLocalityVerification
  readonly storageAttestation: string | null
  readonly storageLocalityNote: string
}

/** Values reported by the production-representative connection, plus the validation verdict. */
export interface SqliteProfileEvidence {
  readonly foreignKeys: number
  readonly journalMode: string
  readonly synchronous: number
  readonly busyTimeoutMs: number
  readonly schemaVersion: number
  readonly walAutocheckpointPages: number
  readonly migrationVersions: readonly number[]
  readonly expectedMigrationVersions: readonly number[]
  readonly migrationChecksumsMatch: boolean
  readonly valid: boolean
  readonly violations: readonly string[]
}

function git(args: readonly string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }
  catch {
    // A soak may legitimately run from an exported tree with no git available;
    // the report then records `unknown` rather than failing the run.
    return undefined
  }
}

function packageIdentity(): { name: string, version: string } {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { name?: string, version?: string }
    return { name: manifest.name ?? 'unknown', version: manifest.version ?? 'unknown' }
  }
  catch {
    return { name: 'unknown', version: 'unknown' }
  }
}

/**
 * Capture host and repository identity.
 *
 * @param database An open connection, used only to read the linked SQLite version.
 * @param databasePath Absolute path of the synthetic authority database.
 * @param attestation Operator-supplied storage attestation text, if any.
 * @param repositoryRoot Directory to run `git` in; `undefined` when the harness runs outside a checkout.
 */
export function captureEnvironment(database: DatabaseSync, databasePath: string, attestation: string | undefined, repositoryRoot: string | undefined): G2Environment {
  const identity = packageIdentity()
  const revision = repositoryRoot == null ? undefined : git(['rev-parse', 'HEAD'], repositoryRoot)
  const status = repositoryRoot == null ? undefined : git(['status', '--porcelain'], repositoryRoot)
  const processors = cpus()
  return Object.freeze({
    nodeVersion: process.version,
    platform: platform(),
    osRelease: release(),
    architecture: arch(),
    hostname: hostname(),
    cpuCount: processors.length,
    cpuModel: processors[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    sqliteVersion: (database.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
    packageName: identity.name,
    packageVersion: identity.version,
    repositoryRevision: revision ?? 'unknown',
    repositoryDirty: status == null ? null : status.length > 0,
    processId: process.pid,
    parentProcessId: process.ppid,
    databasePath,
    databaseVolumeRoot: parse(databasePath).root,
    storageLocalityVerification: attestation == null ? 'unknown' : 'operator-attested',
    storageAttestation: attestation ?? null,
    storageLocalityNote: 'No portable Node API proves that a path is on physically local, non-network storage. This field is either an operator attestation or unknown; collect host evidence with the commands in docs/memory/g2-operational-evidence-runbook.md.',
  })
}

/**
 * Read and validate the durability profile of an open connection.
 *
 * Expectations come from ADR-003 §10.3 (REQ-OPS-010 WAL, REQ-OPS-014 foreign
 * keys plus a bounded busy timeout, REQ-OPS-015 `synchronous=FULL`) and from
 * `openSqliteDatabase`, which is what production composition would use. A
 * violation invalidates the run rather than merely warning, because a soak run
 * on a weaker profile measures something the deployment will never do.
 */
export function captureSqliteProfile(database: DatabaseSync, expectedBusyTimeoutMs: number): SqliteProfileEvidence {
  const pragmas = database.prepare('SELECT (SELECT * FROM pragma_foreign_keys) AS foreign_keys, (SELECT * FROM pragma_journal_mode) AS journal_mode, (SELECT * FROM pragma_synchronous) AS synchronous, (SELECT * FROM pragma_busy_timeout) AS busy_timeout, (SELECT * FROM pragma_schema_version) AS schema_version').get() as Record<string, number | string>
  // NOTICE: `wal_autocheckpoint` has no table-valued `pragma_*` function, so it
  // cannot join the query above and is read as a statement instead.
  const autocheckpoint = database.prepare('PRAGMA wal_autocheckpoint').get() as Record<string, number> | undefined
  const history = database.prepare('SELECT version, checksum FROM memory_schema_migrations ORDER BY version').all() as Array<{ version: number, checksum: string }>

  const foreignKeys = Number(pragmas.foreign_keys)
  const journalMode = String(pragmas.journal_mode).toLowerCase()
  const synchronous = Number(pragmas.synchronous)
  const busyTimeoutMs = Number(pragmas.busy_timeout)
  const schemaVersion = Number(pragmas.schema_version)
  const checksumsMatch = history.length === migrations.length && history.every((row, index) => row.version === migrations[index]!.version && row.checksum === migrations[index]!.checksum)

  const violations: string[] = []
  if (foreignKeys !== 1)
    violations.push('foreign keys are not enabled (ADR-003 REQ-OPS-014)')
  if (journalMode !== 'wal')
    violations.push(`journal mode is ${journalMode}, not WAL (ADR-003 REQ-OPS-010)`)
  if (synchronous !== 2)
    violations.push(`synchronous is ${synchronous}, not FULL (ADR-003 REQ-OPS-015)`)
  if (busyTimeoutMs !== expectedBusyTimeoutMs)
    violations.push(`busy timeout is ${busyTimeoutMs} ms, not the configured ${expectedBusyTimeoutMs} ms (ADR-003 REQ-OPS-014)`)
  if (schemaVersion <= 0)
    violations.push('schema version is not initialised')
  if (!checksumsMatch)
    violations.push('migration history does not match the application migration manifest')

  return Object.freeze({
    foreignKeys,
    journalMode,
    synchronous,
    busyTimeoutMs,
    schemaVersion,
    walAutocheckpointPages: Number(Object.values(autocheckpoint ?? {})[0] ?? -1),
    migrationVersions: Object.freeze(history.map(row => row.version)),
    expectedMigrationVersions: Object.freeze(migrations.map(migration => migration.version)),
    migrationChecksumsMatch: checksumsMatch,
    valid: violations.length === 0,
    violations: Object.freeze(violations),
  })
}
