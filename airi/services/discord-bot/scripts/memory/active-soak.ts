import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createVerifiedBackup, latestSchemaVersion, openAuthoritativeSqliteDatabase, openReadOnlySqliteDatabase, verifyDatabase } from '@proj-airi/memory-sqlite'

import { assertPrivateGuildSoakBinding, buildSoakReport, parseAttestation, parseRunState, SOAK_SCENARIOS, verifySoakReport } from '../../src/memory/active-soak'
import { loadRoomBindingFile } from '../../src/memory/room-bindings'
import { resolveMemoryRuntimePaths } from '../../src/memory/runtime-paths'

type Command = 'prepare' | 'report' | 'verify'

const HELP = `Usage: pnpm memory:active-soak -- <prepare|report|verify> [options]

Qualifies one exact commit and configuration for deliberate active opt-in.
It never changes the default rollout state.

Commands:
  prepare   Guard the checkout and runtime, take a verified pre-soak backup,
            and write private run state (contains the report redaction key).
  report    Correlate durable records with operator attestations and emit a
            redacted JSON report. Run only after the bot is stopped.
  verify    Apply the acceptance rules to a report. Exits nonzero on failure.

Options:
  --run-id <slug>            Run identity (prepare)
  --commit <full-sha>        Exact 40-character candidate commit (prepare, verify)
  --root <absolute-dir>      Isolated memory runtime root
  --binding-file <path>      Private guild-only binding specification (prepare)
  --out <absolute-dir>       Run output directory (prepare, report)
  --state <path>             Private run state file (report)
  --attestation <path>       Operator attestation file (report)
  --report <path>            Redacted report file (verify)
  --help                     Show this help
`

/**
 * Runs one stage of the private active-memory soak.
 *
 * Every stage fails closed: `prepare` refuses to arm a run whose checkout,
 * runtime, or binding specification could make the resulting evidence
 * unattributable, and `verify` refuses a report that cannot be tied to the
 * exact commit under review.
 *
 * Call stack:
 *
 * main
 *   -> {@link prepare} | {@link report} | {@link verify}
 *     -> {@link buildSoakReport} | {@link verifySoakReport} (../../src/memory/active-soak)
 *       -> memory-sqlite backup / read-only inspection facilities
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (!args.command)
    throw new Error('An active-soak command is required. Use --help for usage.')

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
  if (args.command === 'prepare')
    await prepare(args, repoRoot)
  else if (args.command === 'report')
    report(args, repoRoot)
  else
    verify(args)
}

/**
 * Arms a run only when the evidence it will produce can be attributed to one
 * commit, one isolated runtime, and one private guild.
 */
async function prepare(args: ParsedArgs, repoRoot: string): Promise<void> {
  const runId = args.runId ?? ''
  if (!/^[a-z0-9][\w-]{2,63}$/.test(runId))
    throw new Error('--run-id must be a short slug of 3 to 64 word characters')

  // A dirty worktree means the running code is not the commit being qualified.
  const status = git(repoRoot, ['status', '--porcelain'])
  if (status.trim() !== '')
    throw new Error('Refusing to prepare: the git worktree is dirty. Commit or stash every change first.')
  const head = git(repoRoot, ['rev-parse', 'HEAD']).trim()
  const commitSha = requiredFullSha(args.commit)
  if (head !== commitSha)
    throw new Error(`Refusing to prepare: HEAD is ${head} but --commit is ${commitSha}`)

  const root = requiredAbsolute(args.root, '--root')
  const paths = resolveMemoryRuntimePaths(repoRoot, root)
  if (!relative(repoRoot, paths.root).startsWith('..'))
    throw new Error('Refusing to prepare: the soak runtime root must be isolated from the repository checkout')
  if (!existsSync(paths.authority))
    throw new Error(`Memory authority does not exist: ${paths.authority}`)

  const outputDirectory = requiredAbsolute(args.out, '--out')
  const statePath = join(outputDirectory, `${runId}.run-state.json`)
  if (existsSync(statePath))
    throw new Error(`Refusing to prepare: run identity ${runId} already has state at ${statePath}`)

  const bindingFile = requiredAbsolute(args.bindingFile, '--binding-file')
  assertPrivateGuildSoakBinding(loadRoomBindingFile(bindingFile))
  const bindingFileDigest = createHash('sha256').update(readFileSync(bindingFile)).digest('hex')

  // Acquiring write ownership proves no bot process is still running against
  // this authority; the handle is released before the operator starts the bot.
  const handle = openAuthoritativeSqliteDatabase(paths.authority)
  let backupPath: string
  let backupDigest: string
  try {
    verifyDatabase(handle.database)
    mkdirSync(outputDirectory, { recursive: true })
    backupPath = join(outputDirectory, `${runId}.pre-soak.db`)
    if (existsSync(backupPath))
      throw new Error(`Refusing to prepare: a pre-soak backup already exists at ${backupPath}`)
    await createVerifiedBackup(handle.database, paths.authority, backupPath, new Date().toISOString())
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

  print({
    status: 'ok',
    runId,
    commitSha,
    statePath,
    backupPath,
    schemaVersion: latestSchemaVersion,
    scenarios: SOAK_SCENARIOS.length,
    reminder: 'Run state holds the report redaction key. Keep it, the backup, and the binding file out of version control.',
  })
}

/** Emits the redacted report; the authority is opened read-only so reporting can never mutate evidence. */
function report(args: ParsedArgs, repoRoot: string): void {
  const runState = parseRunState(JSON.parse(readFileSync(requiredAbsolute(args.state, '--state'), 'utf8')))
  const attestation = parseAttestation(JSON.parse(readFileSync(requiredAbsolute(args.attestation, '--attestation'), 'utf8')))
  const paths = resolveMemoryRuntimePaths(repoRoot, args.root ?? runState.runtimeRoot)
  const database = openReadOnlySqliteDatabase(paths.authority)
  try {
    const built = buildSoakReport({ database, runState, attestation, generatedAt: new Date().toISOString() })
    const outputDirectory = args.out ? requiredAbsolute(args.out, '--out') : dirname(requiredAbsolute(args.state, '--state'))
    mkdirSync(outputDirectory, { recursive: true })
    const reportPath = join(outputDirectory, `${runState.runId}.report.json`)
    writeFileSync(reportPath, `${JSON.stringify(built, null, 2)}\n`)
    print({ status: 'ok', reportPath, assertions: built.assertions.map(item => ({ id: item.id, passed: item.passed })) })
  }
  finally { database.close() }
}

/** Applies the acceptance rules a reviewer relies on and fails the process when any rule is unmet. */
function verify(args: ParsedArgs): void {
  const verdict = verifySoakReport({
    report: JSON.parse(readFileSync(requiredAbsolute(args.report, '--report'), 'utf8')),
    expectedCommitSha: requiredFullSha(args.commit),
    expectedSchemaVersion: latestSchemaVersion,
  })
  print({ status: verdict.ok ? 'ok' : 'failed', failures: verdict.failures })
  if (!verdict.ok)
    process.exitCode = 1
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' })
}

interface ParsedArgs { command?: Command, runId?: string, commit?: string, root?: string, bindingFile?: string, out?: string, state?: string, attestation?: string, report?: string, help: boolean }

function parseArgs(values: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { help: false }
  const commands = new Set<Command>(['prepare', 'report', 'verify'])
  const options: Record<string, keyof ParsedArgs> = { '--run-id': 'runId', '--commit': 'commit', '--root': 'root', '--binding-file': 'bindingFile', '--out': 'out', '--state': 'state', '--attestation': 'attestation', '--report': 'report' }
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    // `pnpm memory:active-soak -- prepare` forwards the separator verbatim.
    if (value === '--')
      continue
    else if (commands.has(value as Command) && !result.command)
      result.command = value as Command
    else if (value === '--help' || value === '-h')
      result.help = true
    else if (options[value])
      Object.assign(result, { [options[value]!]: values[++index] })
    else throw new Error(`Unknown or incomplete argument: ${value}`)
  }
  return result
}

function requiredFullSha(value: string | undefined): string {
  if (!value || !/^[0-9a-f]{40}$/.test(value))
    throw new Error('--commit must be the exact full 40-character candidate commit SHA')
  return value
}

function requiredAbsolute(value: string | undefined, option: string): string {
  if (!value || !isAbsolute(value))
    throw new Error(`${option} must be an absolute path`)
  return resolve(value)
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

main().catch((error: unknown) => {
  let message = String(error)
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    message = error.message
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
})
