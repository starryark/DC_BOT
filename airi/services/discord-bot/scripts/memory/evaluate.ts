import type { ScenarioResult } from '../../evals/memory/contracts'

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseThresholdDocument } from '../../evals/memory/contracts'
import { ACTIVE_V1_VERSION, activeV1Digest, datasetForSuite, DEFAULT_SEED } from '../../evals/memory/dataset'
import { buildReport, runIsValidForGate } from '../../evals/memory/report'
import { runScenario } from '../../evals/memory/runner'
import { disposeEvaluationRun, startEvaluationRun } from '../../evals/memory/runtime-adapter'

/**
 * CLI entry point for the G8-1 functional-baseline evaluator (IMP-802, T005).
 *
 * Owns only argv, stdout, and the exit code. Every guard lives in the evaluator
 * modules; this file wires them to the process and refuses to proceed when the
 * output location, dataset, or configuration is unsafe.
 *
 * Exit codes (T005):
 *   0 — all applicable assertions pass and outputs validate
 *   2 — CLI, dataset, threshold, or configuration invalid
 *   3 — scenario assertion or zero-tolerance failure
 *   4 — unsafe path, cleanup, redaction, or report-publication failure
 *   5 — unexpected evaluator/runtime exception after best-effort report capture
 */

const HELP = `Usage: pnpm memory:evaluate -- [options]

Runs the G8-1 functional baseline against the active memory profile using
synthetic fixtures and isolated temporary storage. No provider, Discord client,
or operational configuration is touched.

Options:
  --suite smoke|active-v1   Scenario suite (default: smoke)
  --seed <integer>          Deterministic seed (default: ${DEFAULT_SEED})
  --output <directory>      Output directory for machine artifacts (required for active-v1)
  [--thresholds <file>]     Approved threshold document
  [--keep-run-root]         Retain scenario runtime roots for debugging
  --help                    Show this help
`

type CliSuite = 'smoke' | 'active-v1'

interface ParsedArgs {
  suite: CliSuite
  seed: number
  output?: string
  thresholds?: string
  keepRunRoot: boolean
  help: boolean
}

const EXIT = {
  OK: 0,
  INVALID_CONFIG: 2,
  ASSERTION_FAILURE: 3,
  UNSAFE: 4,
  UNEXPECTED: 5,
} as const

async function main(): Promise<void> {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.INVALID_CONFIG
    return
  }
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  // scripts/memory -> scripts -> discord-bot -> services -> airi -> repository root
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

  try {
    const code = await run(args, repoRoot)
    process.exitCode = code
  }
  catch (error) {
    // Best-effort report capture already happened inside run(); here we only
    // surface the unexpected exception and exit nonzero.
    process.stderr.write(`${JSON.stringify({ status: 'error', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.UNEXPECTED
  }
}

async function run(args: ParsedArgs, repoRoot: string): Promise<number> {
  // Resolve the suite and dataset before touching the filesystem.
  let suiteData
  try {
    suiteData = datasetForSuite(args.suite)
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: messageOf(error) })}\n`)
    return EXIT.INVALID_CONFIG
  }
  const { dataset, scenarios } = suiteData
  const datasetDigest = activeV1Digest()

  // Output directory: smoke may default to a temp dir; active-v1 requires an explicit --output.
  let outputDirectory: string | undefined
  if (args.output) {
    outputDirectory = resolve(args.output)
    const pathError = assertSafeOutputDirectory(outputDirectory, repoRoot)
    if (pathError) {
      process.stderr.write(`${JSON.stringify({ status: 'unsafe', message: pathError })}\n`)
      return EXIT.UNSAFE
    }
  }
  else if (args.suite === 'active-v1') {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'active-v1 requires an explicit --output directory' })}\n`)
    return EXIT.INVALID_CONFIG
  }

  // Threshold document: parsed and provenance-checked before any runtime opens.
  let thresholds
  if (args.thresholds) {
    const thresholdPath = resolve(args.thresholds)
    if (!existsSync(thresholdPath)) {
      process.stderr.write(`${JSON.stringify({ status: 'invalid', message: `threshold file not found: ${thresholdPath}` })}\n`)
      return EXIT.INVALID_CONFIG
    }
    try {
      thresholds = parseThresholdDocument(JSON.parse(readFileSync(thresholdPath, 'utf8')), { datasetVersion: dataset.datasetVersion, datasetDigest, evaluatorSchemaVersion: 1 })
    }
    catch (error) {
      process.stderr.write(`${JSON.stringify({ status: 'invalid', message: messageOf(error) })}\n`)
      return EXIT.INVALID_CONFIG
    }
  }

  // Print resolved configuration before creating a runtime.
  const commitSha = gitHead(repoRoot)
  const resolvedConfig = {
    suite: args.suite,
    seed: args.seed,
    datasetVersion: dataset.datasetVersion,
    datasetDigest,
    output: outputDirectory ?? '<temp>',
    thresholds: thresholds ? { approver: thresholds.approver, commit: thresholds.repositoryCommit } : undefined,
    commitSha,
    platform: process.platform,
  }
  process.stdout.write(`${JSON.stringify({ status: 'resolved', ...resolvedConfig }, null, 2)}\n`)

  // Run every scenario against a fresh isolated runtime.
  const results: (ScenarioResult & { elapsedMs: number })[] = []
  const run = startEvaluationRun({ repoRoot, keepRunRoot: args.keepRunRoot })
  try {
    for (const scenario of scenarios) {
      const result = await runScenario(run, scenario, { seed: args.seed, datasetVersion: dataset.datasetVersion, repoRoot })
      results.push(result)
    }
  }
  finally {
    disposeEvaluationRun(run)
  }

  // Build the report artifacts.
  const report = buildReport({ dataset, datasetDigest, seed: args.seed, commitSha, platform: process.platform, generatedAt: new Date().toISOString(), results, thresholds })

  // Redaction scan: any prohibited content is a publication failure.
  if (report.redactionFindings.length > 0) {
    process.stderr.write(`${JSON.stringify({ status: 'unsafe', message: `redaction scan failed: ${report.redactionFindings.join(', ')}` })}\n`)
    return EXIT.UNSAFE
  }

  // Write artifacts to the output directory (or a temp dir for smoke).
  const target = outputDirectory ?? makeTempOutputDir(repoRoot)
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'summary.json'), `${JSON.stringify(report.summary, null, 2)}\n`)
  writeFileSync(join(target, 'scenario-results.jsonl'), report.scenarioJsonl)
  writeFileSync(join(target, 'report.md'), report.markdown)

  process.stdout.write(`${JSON.stringify({ status: 'complete', output: target, summary: { applicablePassed: report.summary.applicablePassed, applicableTotal: report.summary.applicableTotal, zeroToleranceFailures: report.summary.zeroToleranceFailures.length, normalizedResultDigest: report.summary.normalizedResultDigest } }, null, 2)}\n`)

  // Decide the exit code from the whole-run result.
  if (!runIsValidForGate(report.summary))
    return EXIT.ASSERTION_FAILURE
  return EXIT.OK
}

/** Parse argv into a validated ParsedArgs or throw on invalid input. */
function parseArgs(values: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { suite: 'smoke', seed: DEFAULT_SEED, keepRunRoot: false, help: false }
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (value === '--') {
      continue
    }
    else if (value === '--help' || value === '-h') {
      result.help = true
    }
    else if (value === '--suite') {
      const next = values[++index]
      if (next !== 'smoke' && next !== 'active-v1')
        throw new Error(`--suite must be smoke or active-v1, got ${next ?? '(missing)'}`)
      result.suite = next
    }
    else if (value === '--seed') {
      const next = values[++index]
      const seed = Number(next)
      if (!Number.isSafeInteger(seed) || seed < 0)
        throw new Error(`--seed must be a non-negative integer, got ${next ?? '(missing)'}`)
      result.seed = seed
    }
    else if (value === '--output') {
      result.output = values[++index]
      if (!result.output)
        throw new Error('--output requires a directory argument')
    }
    else if (value === '--thresholds') {
      result.thresholds = values[++index]
      if (!result.thresholds)
        throw new Error('--thresholds requires a file argument')
    }
    else if (value === '--keep-run-root') {
      result.keepRunRoot = true
    }
    else {
      throw new Error(`Unknown or incomplete argument: ${value}`)
    }
  }
  return result
}

/** Refuse an output directory inside the repository or one with unexpected contents. */
function assertSafeOutputDirectory(directory: string, repoRoot: string): string | undefined {
  if (!isAbsolute(directory))
    return `--output must be an absolute path, got ${directory}`
  if (insideRepository(repoRoot, directory))
    return `--output ${directory} is inside the repository checkout; use a private directory outside it`
  // Refuse unsafe path aliases after realpath resolution.
  let real
  try {
    real = realpath(directory)
  }
  catch {
    // Not yet existing is fine; a later mkdirSync creates it.
    return undefined
  }
  if (real !== directory && insideRepository(repoRoot, real))
    return `--output ${directory} resolves inside the repository checkout via symlink`
  if (existsSync(directory) && statSync(directory).isDirectory()) {
    const entries = readdirSync(directory)
    if (entries.length > 0) {
      // Allow a previously initialized matching run directory.
      const hasMatchingRun = entries.includes('summary.json')
      if (!hasMatchingRun)
        return `--output ${directory} is nonempty and not a previously initialized run directory`
    }
  }
  return undefined
}

function insideRepository(repoRoot: string, target: string): boolean {
  const step = relative(resolve(repoRoot), resolve(target))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

function realpath(path: string): string {
  return execFileSync('node', ['-e', `process.stdout.write(require('fs').realpathSync(${JSON.stringify(path)}))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function makeTempOutputDir(repoRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), `g8-eval-out-${ACTIVE_V1_VERSION}-`))
  if (insideRepository(repoRoot, dir))
    throw new Error('temp output directory landed inside the repository checkout; pass --output explicitly')
  return dir
}

function gitHead(repoRoot: string): string {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  }
  catch {
    return 'unknown'.repeat(10).slice(0, 40)
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string')
    return (error as { message: string }).message
  return String(error)
}

void datasetForSuite
main().catch(() => {
  process.exitCode = EXIT.UNEXPECTED
})
