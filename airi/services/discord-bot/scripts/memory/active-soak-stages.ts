import type { SoakVerdict } from '../../src/memory/active-soak'

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { createVerifiedBackup, latestSchemaVersion, openAuthoritativeSqliteDatabase, openReadOnlySqliteDatabase, verifyDatabase } from '@proj-airi/memory-sqlite'

import { assertPrivateGuildSoakBinding, buildSoakReport, parseAttestation, parseRunState, SOAK_SCENARIOS, verifySoakReport } from '../../src/memory/active-soak'
import { loadRoomBindingFile } from '../../src/memory/room-bindings'
import { resolveMemoryRuntimePaths } from '../../src/memory/runtime-paths'

/**
 * The three stages of the private active-memory soak, separated from the CLI so
 * the repository checkout they guard is an explicit parameter rather than a
 * fixed process fact.
 *
 * Every stage fails closed. `prepare` refuses to arm a run whose checkout,
 * runtime, output location, or binding specification could make the resulting
 * evidence unattributable or leakable; `report` refuses to read any authority
 * other than the one `prepare` bound; `verify` refuses a report that cannot be
 * tied to the exact commit under review.
 */

/** Options each stage accepts; the CLI fills them from argv. */
export interface SoakStageOptions {
  readonly runId?: string
  readonly commit?: string
  readonly root?: string
  readonly bindingFile?: string
  readonly out?: string
  readonly state?: string
  readonly attestation?: string
  readonly report?: string
}

/**
 * Which mechanism actually protects the private artifacts on this platform.
 *
 * Reported by `prepare` so an operator on Windows is told, in the run output,
 * that the mode bits the tool sets are not the thing keeping the evidence
 * private.
 */
export type PrivateArtifactProtection = 'posix-mode' | 'windows-acl-required'

export interface PreparedSoakRun {
  readonly runId: string
  readonly commitSha: string
  readonly statePath: string
  readonly backupPath: string
  readonly schemaVersion: number
  readonly scenarios: number
  readonly privateArtifactProtection: PrivateArtifactProtection
}

export interface SoakRunReport {
  readonly reportPath: string
  readonly assertions: readonly { readonly id: string, readonly passed: boolean }[]
}

// NOTICE:
// Windows honours no POSIX permission bit except read-only, so the modes set
// below are advisory there and cannot be asserted afterwards. The operator must
// instead place the evidence directory on an ACL-protected private path; the
// runbook records that requirement and `prepare` reports which regime applied.
// Removal condition: none, this is a permanent platform difference.
const privateArtifactProtection: PrivateArtifactProtection = process.platform === 'win32' ? 'windows-acl-required' : 'posix-mode'

/**
 * Arms a run only when the evidence it will produce can be attributed to one
 * commit, one isolated runtime, one private guild, and one private output
 * location.
 */
export async function prepareSoakRun(options: SoakStageOptions, repoRoot: string): Promise<PreparedSoakRun> {
  const runId = options.runId ?? ''
  if (!/^[a-z0-9][\w-]{2,63}$/.test(runId))
    throw new Error('--run-id must be a short slug of 3 to 64 word characters')

  // A dirty worktree means the running code is not the commit being qualified.
  const status = git(repoRoot, ['status', '--porcelain'])
  if (status.trim() !== '')
    throw new Error('Refusing to prepare: the git worktree is dirty. Commit or stash every change first.')
  const head = git(repoRoot, ['rev-parse', 'HEAD']).trim()
  const commitSha = requiredFullSha(options.commit)
  if (head !== commitSha)
    throw new Error(`Refusing to prepare: HEAD is ${head} but --commit is ${commitSha}`)

  const paths = resolveMemoryRuntimePaths(repoRoot, requiredAbsolute(options.root, '--root'))
  if (insideRepository(repoRoot, paths.root))
    throw new Error('Refusing to prepare: the soak runtime root must be isolated from the repository checkout')
  if (!existsSync(paths.authority))
    throw new Error(`Memory authority does not exist: ${paths.authority}`)

  const outputDirectory = requiredAbsolute(options.out, '--out')
  assertPrivateOutputDirectory(outputDirectory, repoRoot)
  const statePath = join(outputDirectory, `${runId}.run-state.json`)
  if (existsSync(statePath))
    throw new Error(`Refusing to prepare: run identity ${runId} already has state at ${statePath}`)

  const bindingFile = requiredAbsolute(options.bindingFile, '--binding-file')
  assertPrivateGuildSoakBinding(loadRoomBindingFile(bindingFile))
  const bindingFileDigest = createHash('sha256').update(readFileSync(bindingFile)).digest('hex')

  // Acquiring write ownership proves no bot process is still running against
  // this authority; the handle is released before the operator starts the bot.
  const handle = openAuthoritativeSqliteDatabase(paths.authority)
  let backupPath: string
  let backupDigest: string
  try {
    verifyDatabase(handle.database)
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
    restrictPrivateDirectory(outputDirectory)
    backupPath = join(outputDirectory, `${runId}.pre-soak.db`)
    if (existsSync(backupPath))
      throw new Error(`Refusing to prepare: a pre-soak backup already exists at ${backupPath}`)
    await createVerifiedBackup(handle.database, paths.authority, backupPath, new Date().toISOString())
    // The snapshot and its manifest carry raw content and schema identity;
    // `createVerifiedBackup` publishes them owner-only, and this re-checks it
    // rather than trusting the umask that was in effect.
    assertPrivateArtifact(backupPath)
    assertPrivateArtifact(`${backupPath}.manifest.json`)
    backupDigest = createHash('sha256').update(readFileSync(backupPath)).digest('hex')
  }
  finally { handle.close() }

  const runState = parseRunState({
    format: 1,
    runId,
    commitSha,
    createdAt: new Date().toISOString(),
    runtimeRoot: paths.root,
    authorityPath: paths.authority,
    bindingFileDigest,
    memoryMode: 'active',
    schemaVersion: latestSchemaVersion,
    preSoakBackupPath: backupPath,
    preSoakBackupDigest: backupDigest,
    redactionKey: randomBytes(32).toString('hex'),
    scenarios: SOAK_SCENARIOS.map(scenario => scenario.id),
  })
  writeFileSync(statePath, `${JSON.stringify(runState, null, 2)}\n`, { mode: 0o600 })
  assertPrivateArtifact(statePath)

  return {
    runId,
    commitSha,
    statePath,
    backupPath,
    schemaVersion: latestSchemaVersion,
    scenarios: SOAK_SCENARIOS.length,
    privateArtifactProtection,
  }
}

/** Emits the redacted report; the authority is opened read-only so reporting can never mutate evidence. */
export function reportSoakRun(options: SoakStageOptions, repoRoot: string): SoakRunReport {
  const statePath = requiredAbsolute(options.state, '--state')
  const runState = parseRunState(JSON.parse(readFileSync(statePath, 'utf8')))

  // The bound authority is the only evidence source a report may read. Opening
  // a different database under this run's identity and redaction key would
  // produce evidence that looks attributable to the candidate but is not, so
  // `--root` may only restate what `prepare` already recorded.
  const bound = resolveMemoryRuntimePaths(repoRoot, runState.runtimeRoot)
  if (bound.authority !== runState.authorityPath)
    throw new Error(`Refusing to report: runtime root ${runState.runtimeRoot} no longer resolves to the bound authority ${runState.authorityPath}`)
  if (options.root !== undefined && resolve(options.root) !== runState.runtimeRoot)
    throw new Error(`Refusing to report: --root ${resolve(options.root)} is not the runtime root bound during preparation (${runState.runtimeRoot})`)
  if (!existsSync(runState.authorityPath))
    throw new Error(`Memory authority does not exist: ${runState.authorityPath}`)

  const attestation = parseAttestation(JSON.parse(readFileSync(requiredAbsolute(options.attestation, '--attestation'), 'utf8')))
  const outputDirectory = options.out === undefined ? dirname(statePath) : requiredAbsolute(options.out, '--out')
  assertPrivateOutputDirectory(outputDirectory, repoRoot)

  const database = openReadOnlySqliteDatabase(runState.authorityPath)
  try {
    const built = buildSoakReport({ database, runState, attestation, generatedAt: new Date().toISOString() })
    mkdirSync(outputDirectory, { recursive: true, mode: 0o700 })
    const reportPath = join(outputDirectory, `${runState.runId}.report.json`)
    writeFileSync(reportPath, `${JSON.stringify(built, null, 2)}\n`)
    return { reportPath, assertions: built.assertions.map(item => ({ id: item.id, passed: item.passed })) }
  }
  finally { database.close() }
}

/** Applies the acceptance rules a reviewer relies on; the caller decides the process exit code. */
export function verifySoakRun(options: SoakStageOptions): SoakVerdict {
  return verifySoakReport({
    report: JSON.parse(readFileSync(requiredAbsolute(options.report, '--report'), 'utf8')),
    expectedCommitSha: requiredFullSha(options.commit),
    expectedSchemaVersion: latestSchemaVersion,
  })
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
}

export function requiredFullSha(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{40}$/.test(value))
    throw new Error('--commit must be the exact full 40-character candidate commit SHA')
  return value
}

export function requiredAbsolute(value: string | undefined, option: string): string {
  if (!value || !isAbsolute(value))
    throw new Error(`${option} must be an absolute path`)
  return resolve(value)
}

/**
 * True when `target` is the repository checkout itself or lives inside it.
 *
 * `relative` returns an absolute path when the two sides sit on different
 * Windows drives, which a bare `startsWith('..')` test would misread as
 * containment and reject; checking for that keeps an evidence directory on a
 * separate drive usable.
 */
function insideRepository(repoRoot: string, target: string): boolean {
  const step = relative(repoRoot, target)
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

/**
 * Keeps every soak artifact out of the checkout.
 *
 * The run state holds the redaction key, the pre-soak backup holds raw
 * content, and the manifest holds schema identity. Inside the checkout any of
 * them could be published by an ordinary `git add`, so the location is refused
 * rather than merely warned about.
 */
function assertPrivateOutputDirectory(directory: string, repoRoot: string): void {
  if (insideRepository(repoRoot, directory))
    throw new Error(`Refusing to continue: soak output directory ${directory} is inside the repository checkout; use a private absolute directory outside it`)
}

function restrictPrivateDirectory(path: string): void {
  // mkdir applies its mode only to directories it creates and only after the
  // umask; an existing or umask-widened directory still has to be narrowed.
  if (privateArtifactProtection === 'posix-mode')
    chmodSync(path, 0o700)
}

/** Fails closed when a private artifact is group- or world-accessible on a platform where POSIX modes are authoritative. */
function assertPrivateArtifact(path: string): void {
  if (privateArtifactProtection !== 'posix-mode')
    return
  const shared = statSync(path).mode & 0o077
  if (shared !== 0)
    throw new Error(`Refusing to continue: ${path} is accessible outside the owner account (mode bits ${shared.toString(8).padStart(3, '0')})`)
}
