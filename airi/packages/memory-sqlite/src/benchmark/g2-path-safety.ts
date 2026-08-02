/**
 * Path admission rules for the G2 operational soak harness.
 *
 * The harness writes a real file-backed SQLite database on the operator's
 * intended deployment volume, so the only thing standing between an evidence
 * run and someone's real data is this module. It therefore fails closed:
 * a directory is usable only when it is empty or when it carries the synthetic
 * marker this harness itself wrote. There is deliberately no override flag —
 * a mis-typed path must be a startup error, never a recoverable warning.
 */

import type { Dirent } from 'node:fs'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, parse, resolve, sep } from 'node:path'

import { MemoryError } from '@proj-airi/memory-domain'

/** Marker file written into a database or output directory the harness owns. */
export const syntheticDirectoryMarkerFilename = 'g2-synthetic-directory.json'

/** Run manifest written into every run output directory. */
export const runManifestFilename = 'run-manifest.json'

/** Stable purpose string; the safety checks match on it, so it is a contract value. */
export const syntheticPurpose = 'DC_BOT G2 synthetic operational soak'

/** File suffixes that indicate a SQLite database (including WAL/SHM sidecars). */
const databaseSuffixes: readonly string[] = Object.freeze(['.db', '.db3', '.sqlite', '.sqlite3', '.db-wal', '.db-shm', '.sqlite-wal', '.sqlite-shm'])

/**
 * Marker proving a directory was created by this harness for synthetic data.
 *
 * `syntheticDataOnly` is asserted, not inferred: the harness only ever writes
 * generated content, and a directory that claims otherwise is rejected.
 */
export interface SyntheticDirectoryMarker {
  readonly format: 1
  readonly purpose: typeof syntheticPurpose
  readonly syntheticDataOnly: true
  readonly role: 'database-authority' | 'evidence-output'
  readonly createdAt: string
  readonly createdBy: string
}

/** Every absolute path a single run may touch. */
export interface G2RunPaths {
  readonly runId: string
  readonly databaseDirectory: string
  readonly databasePath: string
  readonly outputDirectory: string
  readonly runOutputDirectory: string
  readonly backupsDirectory: string
  readonly restoreDirectory: string
  readonly logsDirectory: string
  readonly eventsPath: string
  readonly runManifestPath: string
}

function normalizeForComparison(path: string): string {
  const withSeparator = path.endsWith(sep) ? path : `${path}${sep}`
  return process.platform === 'win32' ? withSeparator.toLowerCase() : withSeparator
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInsideDirectory(parent: string, child: string): boolean {
  return normalizeForComparison(resolve(child)).startsWith(normalizeForComparison(resolve(parent)))
}

/** True for `\\server\share` style paths, which ADR-003 REQ-OPS-011 excludes outright. */
export function isNetworkSharePath(path: string): boolean {
  return path.startsWith('\\\\') || path.startsWith('//')
}

/**
 * Resolve an operator-supplied directory to an absolute path and reject the
 * shapes that can never be a valid SQLite authority location.
 *
 * This rejects network shares and filesystem roots; it deliberately does not
 * decide whether the volume is physically local, because no portable Node API
 * can prove that (see `g2-environment.ts`).
 */
export function resolveOperatorDirectory(variable: string, raw: string | undefined): string {
  const trimmed = (raw ?? '').trim()
  if (trimmed.length === 0)
    throw new MemoryError('INVALID_PAYLOAD', `${variable} must be set to an explicit directory on the intended deployment volume`)
  if (isNetworkSharePath(trimmed))
    throw new MemoryError('POLICY_VIOLATION', `${variable} looks like a network share; ADR-003 REQ-OPS-011 excludes network filesystems from the supported SQLite topology`)
  const resolved = resolve(trimmed)
  if (parse(resolved).root === resolved)
    throw new MemoryError('POLICY_VIOLATION', `${variable} must not be a filesystem root`)
  return resolved
}

/** Reject overlapping database and evidence directories so evidence can never overwrite the authority. */
export function assertDirectoriesSeparate(databaseDirectory: string, outputDirectory: string): void {
  if (isInsideDirectory(databaseDirectory, outputDirectory) || isInsideDirectory(outputDirectory, databaseDirectory))
    throw new MemoryError('POLICY_VIOLATION', 'G2_DATABASE_DIRECTORY and G2_OUTPUT_DIRECTORY must be separate directories; neither may contain the other')
}

/**
 * Outermost ancestor containing `.git`, or `undefined` outside any checkout.
 *
 * Outermost rather than nearest: a monorepo may contain a nested checkout, a
 * submodule, or a leftover `.git` directory, and stopping at the first match
 * would leave the rest of the enclosing repository looking like a safe place to
 * write run data. Every inner root is contained by the outermost one, so this
 * single answer covers them all.
 */
export async function findRepositoryRoot(from: string): Promise<string | undefined> {
  let current = resolve(from)
  let outermost: string | undefined
  for (;;) {
    if (await stat(join(current, '.git')).then(() => true, () => false))
      outermost = current
    const parent = dirname(current)
    if (parent === current)
      return outermost
    current = parent
  }
}

/**
 * Keep run data out of the checkout.
 *
 * Evidence output and a synthetic authority database are operational data, not
 * source. Writing them inside the repository invites an accidental commit of
 * database files, so the harness refuses instead of relying on `.gitignore`.
 */
export async function assertOutsideRepositoryCheckout(label: string, directory: string, searchFrom: string): Promise<void> {
  const repository = await findRepositoryRoot(searchFrom)
  if (repository != null && isInsideDirectory(repository, directory))
    throw new MemoryError('POLICY_VIOLATION', `${label} must not live inside the repository checkout at ${repository}`)
}

function looksLikeDatabaseArtifact(entry: Dirent): boolean {
  const name = entry.name.toLowerCase()
  return databaseSuffixes.some(suffix => name.endsWith(suffix))
}

/** Parse and validate a marker file; returns `undefined` when it is absent or unusable. */
export async function readSyntheticDirectoryMarker(directory: string): Promise<SyntheticDirectoryMarker | undefined> {
  const raw = await readFile(join(directory, syntheticDirectoryMarkerFilename), 'utf8').catch(() => undefined)
  if (raw == null)
    return undefined
  try {
    const parsed = JSON.parse(raw) as Partial<SyntheticDirectoryMarker>
    if (parsed.format !== 1 || parsed.purpose !== syntheticPurpose || parsed.syntheticDataOnly !== true)
      return undefined
    return parsed as SyntheticDirectoryMarker
  }
  catch {
    return undefined
  }
}

/**
 * Admit a directory for harness use, or throw.
 *
 * Accepted: a missing directory, an empty directory, or a directory carrying a
 * valid marker from a previous G2 run. Everything else — including a directory
 * that merely *contains* an unmarked SQLite file — is refused, because the
 * harness cannot distinguish an operator's real authority database from an
 * abandoned experiment and must not guess.
 */
export async function assertSyntheticDirectory(directory: string, role: SyntheticDirectoryMarker['role']): Promise<'absent' | 'empty' | 'marked'> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT')
      return undefined
    throw new MemoryError('POLICY_VIOLATION', `${directory} could not be inspected before use`, { cause: error })
  })
  if (entries == null)
    return 'absent'
  if (entries.length === 0)
    return 'empty'
  const marker = await readSyntheticDirectoryMarker(directory)
  if (marker == null) {
    const databaseArtifact = entries.find(looksLikeDatabaseArtifact)
    const reason = databaseArtifact
      ? `it already contains ${databaseArtifact.name}, which may be a real database`
      : 'it is not empty and carries no G2 synthetic-run marker'
    throw new MemoryError('POLICY_VIOLATION', `refusing to use ${directory} as the ${role} directory because ${reason}. Point the harness at an empty directory on the intended deployment volume; there is intentionally no override.`)
  }
  if (marker.role !== role)
    throw new MemoryError('POLICY_VIOLATION', `${directory} is marked as a G2 ${marker.role} directory and must not be reused as the ${role} directory`)
  return 'marked'
}

/** Write the marker if it is absent. Never overwrites an existing marker. */
export async function writeSyntheticDirectoryMarker(directory: string, role: SyntheticDirectoryMarker['role'], createdAt: string): Promise<SyntheticDirectoryMarker> {
  const existing = await readSyntheticDirectoryMarker(directory)
  if (existing != null)
    return existing
  const marker: SyntheticDirectoryMarker = Object.freeze({
    format: 1,
    purpose: syntheticPurpose,
    syntheticDataOnly: true,
    role,
    createdAt,
    createdBy: '@proj-airi/memory-sqlite g2-operational-soak',
  })
  await writeFile(join(directory, syntheticDirectoryMarkerFilename), `${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return marker
}

/**
 * Mint a run identifier that sorts chronologically and cannot collide.
 *
 * The timestamp is caller-supplied so the identifier, the manifest, and the
 * report all agree on one wall-clock instant.
 */
export function createRunId(startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `g2-${stamp}-${randomUUID().slice(0, 8)}`
}

/** Derive every run-scoped path. The database filename embeds the run id so runs never share a file. */
export function createRunPaths(directories: { readonly databaseDirectory: string, readonly outputDirectory: string }, runId: string): G2RunPaths {
  const runOutputDirectory = join(directories.outputDirectory, runId)
  return Object.freeze({
    runId,
    databaseDirectory: directories.databaseDirectory,
    databasePath: join(directories.databaseDirectory, `${runId}.db`),
    outputDirectory: directories.outputDirectory,
    runOutputDirectory,
    backupsDirectory: join(runOutputDirectory, 'backups'),
    restoreDirectory: join(runOutputDirectory, 'restore'),
    logsDirectory: join(runOutputDirectory, 'logs'),
    eventsPath: join(runOutputDirectory, 'events.jsonl'),
    runManifestPath: join(runOutputDirectory, runManifestFilename),
  })
}

/**
 * Reject a backup or restore destination that could damage the authority.
 *
 * `createVerifiedBackup`/`restoreVerifiedBackup` already refuse an identical
 * path; this widens the rule to the whole authority directory so a WAL/SHM
 * sidecar can never be clobbered either.
 */
export function assertDerivedArtifactPath(kind: 'backup' | 'restore', databasePath: string, destination: string): void {
  if (resolve(destination) === resolve(databasePath))
    throw new MemoryError('POLICY_VIOLATION', `the ${kind} destination must differ from the authority database path`)
  if (isInsideDirectory(dirname(databasePath), destination))
    throw new MemoryError('POLICY_VIOLATION', `the ${kind} destination must live outside the authority database directory`)
}
