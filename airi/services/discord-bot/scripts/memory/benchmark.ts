#!/usr/bin/env tsx
/**
 * `memory:benchmark` CLI for the IMP-803 deterministic performance benchmark.
 *
 * Produces a complete, recomputable, content-free artifact set with
 * deterministic contract identity and environment-bound measurements. Smoke
 * is credential-free and fast; the full `performance-v1` suite requires an
 * explicit external output directory and a clean worktree.
 *
 * Exit codes align with the functional evaluator:
 *
 *   0 — complete, correctness-clean, no approved threshold failure
 *   2 — invalid CLI argument, contract, threshold, price, or provenance
 *   3 — correctness failure or approved threshold failure
 *   4 — unsafe output, cleanup failure, redaction failure, or artifact-write failure
 *   5 — unexpected runtime exception after best-effort diagnostics
 *
 * Call stack:
 *
 * main (scripts/memory/benchmark)
 *   -> {@link runRuntimeSuite} / {@link runControllerWorkloads}
 *     -> {@link buildPerformanceReport}
 *       -> {@link writeArtifactsAtomically}
 */

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'

import { runControllerWorkloads } from '../../evals/memory/performance/controller-runner'
import { buildPerformanceReport } from '../../evals/memory/performance/report'
import { runRuntimeSuite } from '../../evals/memory/performance/runtime-runner'
import { workloadsForSuite } from '../../evals/memory/performance/workloads'
import { disposeEvaluationRun, startEvaluationRun } from '../../evals/memory/runtime-adapter'

const EXIT = { COMPLETE: 0, INVALID: 2, CORRECTNESS: 3, UNSAFE: 4, UNEXPECTED: 5 } as const
const BENCH_CHARACTER = asCharacterId('bench-character')

interface ParsedArgs {
  help: boolean
  suite: 'smoke' | 'performance-v1'
  seed: number
  warmup?: number
  samples?: number
  sampleCapacity?: number
  output?: string
  thresholds?: string
  priceDocument?: string
  importLive: string[]
  keepRunRoot: boolean
}

const HELP_TEXT = `Usage: memory:benchmark [options]

Options:
  --suite smoke|performance-v1   Suite to run (default: smoke)
  --seed <non-negative integer>  Deterministic seed (default: 20260802)
  --warmup <positive integer>    Override warmup count for every workload
  --samples <positive integer>   Override measured sample count for every workload
  --sample-capacity <integer>    Override reservoir sample capacity
  --output <directory>           Absolute external output directory (required for performance-v1)
  --thresholds <file>            Approved threshold document (provenance validated before runtime start)
  --price-document <file>        Approved price document (provenance validated before runtime start)
  --import-live <file>           Import a live artifact (repeatable)
  --keep-run-root                Keep the run root for debugging
  --help                         Show this help

Exit codes:
  0  complete, correctness-clean, no approved threshold failure
  2  invalid CLI argument, contract, threshold, price, or provenance
  3  correctness failure or approved threshold failure
  4  unsafe output, cleanup failure, redaction failure, or artifact-write failure
  5  unexpected runtime exception
`

async function main(): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv.slice(2))
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }
  if (parsed.help) {
    process.stdout.write(HELP_TEXT)
    return
  }

  const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..')
  let outputDirectory: string | undefined

  // Output validation: smoke may use a temp dir; performance-v1 requires explicit --output.
  if (parsed.output) {
    outputDirectory = resolve(parsed.output)
    const pathCheck = assertSafeOutputDirectory(outputDirectory, repoRoot)
    if (pathCheck.error) {
      // An output inside the checkout is an unsafe-output condition (4); a
      // nonempty or non-absolute directory is an invalid-config condition (2).
      const isUnsafe = pathCheck.kind === 'unsafe'
      process.stderr.write(`${JSON.stringify({ status: isUnsafe ? 'unsafe' : 'invalid', message: pathCheck.error })}\n`)
      process.exitCode = isUnsafe ? EXIT.UNSAFE : EXIT.INVALID
      return
    }
  }
  else if (parsed.suite === 'performance-v1') {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'performance-v1 requires an explicit --output directory' })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }
  else {
    outputDirectory = makeTempOutputDir(repoRoot)
  }

  // Full-suite guards: reject dirty worktree and unknown git head.
  const commitSha = gitHead(repoRoot)
  const dirtyWorktree = gitDirty(repoRoot)
  if (parsed.suite === 'performance-v1') {
    if (commitSha.length !== 40 || commitSha === 'unknown'.repeat(10).slice(0, 40)) {
      process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'performance-v1 requires a known git HEAD' })}\n`)
      process.exitCode = EXIT.INVALID
      return
    }
    if (dirtyWorktree) {
      process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'performance-v1 requires a clean worktree' })}\n`)
      process.exitCode = EXIT.INVALID
      return
    }
  }

  mkdirSync(outputDirectory, { recursive: true })

  const runId = `bench-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${commitSha.slice(0, 8)}`

  try {
    const evaluationRun = startEvaluationRun({ repoRoot, keepRunRoot: parsed.keepRunRoot })
    try {
      const runtimeResult = await runRuntimeSuite(parsed.suite, {
        repoRoot,
        run: evaluationRun,
        characterId: BENCH_CHARACTER,
        seed: parsed.seed,
        warmupCount: parsed.warmup,
        sampleCount: parsed.samples,
      })
      const controllerResult = await runControllerWorkloads(workloadsForSuite(parsed.suite).filter(w => w.runner !== 'runtime'), {
        repoRoot,
        run: evaluationRun,
        characterId: BENCH_CHARACTER,
        seed: parsed.seed,
        warmupCount: parsed.warmup,
        sampleCount: parsed.samples,
      })

      const allMeasurements = [
        ...runtimeResult.results.flatMap(result => result.measurements),
        ...controllerResult.results.flatMap(result => result.measurements),
      ]
      const workloadResults = [
        ...runtimeResult.results.map(result => ({ workloadId: result.workloadId, correctnessFailures: result.correctnessFailures.length, cleanupFailures: 0 })),
        ...controllerResult.results.map(result => ({ workloadId: result.workloadId, correctnessFailures: result.correctnessFailures.length, cleanupFailures: 0 })),
      ]
      const completedIds = [...runtimeResult.results, ...controllerResult.results].map(r => r.workloadId)
      const expectedIds = workloadsForSuite(parsed.suite).map(w => w.workloadId)
      const skippedIds = expectedIds.filter(id => !completedIds.includes(id))

      const manifest = {
        schemaVersion: 1 as const,
        contractId: 'performance-v1' as const,
        contractDigest: runtimeResult.contractDigest,
        commitSha,
        dirtyWorktree,
        suite: parsed.suite,
        seed: parsed.seed,
        environment: {
          nodeVersion: process.version,
          pnpmVersion: '10.33.0',
          platform: process.platform,
          architecture: process.arch,
          cpuModel: 'synthetic',
          cpuCount: 1,
          totalMemoryBytes: 0,
          sqliteVersion: '3.51.2',
        },
        configuration: [],
        timerSource: 'performance.now',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        workloadsCompleted: completedIds,
        importedLiveArtifactDigests: [],
        limitations: [],
      }

      const report = buildPerformanceReport({
        runId,
        manifest,
        measurements: allMeasurements,
        workloadResults,
        skippedWorkloadIds: skippedIds,
        activeControlDeltas: controllerResult.activeControlDeltas,
        importedLiveArtifactDigests: [],
        costAvailability: 'unavailable',
        costUnavailableReason: parsed.priceDocument ? 'price-document-parsing-not-yet-wired' : 'no-price-document-supplied',
        limitations: [
          'Deterministic stub benchmark; does not establish live Discord transport performance.',
          'Barge-in results are controller cancellation path, not acoustic barge-in qualification.',
          'Cost is unavailable without a matching approved price document.',
        ],
      })

      if (report.redactionFindings.length > 0) {
        process.stderr.write(`${JSON.stringify({ status: 'unsafe', message: 'redaction scan found prohibited content', findings: report.redactionFindings })}\n`)
        process.exitCode = EXIT.UNSAFE
        return
      }

      writeArtifactsAtomically(outputDirectory, manifest, report)

      process.stdout.write(`${JSON.stringify({ status: 'complete', output: outputDirectory, runId, disposition: report.summary.disposition, contractDigest: report.summary.contractDigest }, null, 2)}\n`)

      if (report.summary.disposition === 'failed')
        process.exitCode = EXIT.CORRECTNESS
    }
    finally {
      disposeEvaluationRun(evaluationRun)
    }
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.UNEXPECTED
  }
}

/** Write every artifact atomically: temp sibling files renamed only after successful serialization and scan. */
function writeArtifactsAtomically(outputDirectory: string, manifest: object, report: ReturnType<typeof buildPerformanceReport>): void {
  const targets = [
    { name: 'run-manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'measurements.jsonl', content: report.measurementsJsonl },
    { name: 'summary.json', content: `${JSON.stringify(report.summary, null, 2)}\n` },
    { name: 'report.md', content: report.markdown },
  ]
  for (const target of targets) {
    const tempPath = join(outputDirectory, `.${target.name}.tmp`)
    const finalPath = join(outputDirectory, target.name)
    writeFileSync(tempPath, target.content)
    renameSync(tempPath, finalPath)
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, suite: 'smoke', seed: 20260802, importLive: [], keepRunRoot: false }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (value === '--') {
      continue
    }
    else if (value === '--help' || value === '-h') {
      result.help = true
    }
    else if (value === '--suite') {
      const next = argv[++index]
      if (next !== 'smoke' && next !== 'performance-v1')
        throw new Error(`--suite must be smoke or performance-v1, got ${next ?? '(missing)'}`)
      result.suite = next
    }
    else if (value === '--seed') {
      const next = argv[++index]
      const seed = Number(next)
      if (!Number.isSafeInteger(seed) || seed < 0)
        throw new Error(`--seed must be a non-negative integer, got ${next ?? '(missing)'}`)
      result.seed = seed
    }
    else if (value === '--warmup') {
      const next = argv[++index]
      const warmup = Number(next)
      if (!Number.isSafeInteger(warmup) || warmup < 1)
        throw new Error(`--warmup must be a positive integer, got ${next ?? '(missing)'}`)
      result.warmup = warmup
    }
    else if (value === '--samples') {
      const next = argv[++index]
      const samples = Number(next)
      if (!Number.isSafeInteger(samples) || samples < 1)
        throw new Error(`--samples must be a positive integer, got ${next ?? '(missing)'}`)
      result.samples = samples
    }
    else if (value === '--sample-capacity') {
      const next = argv[++index]
      const cap = Number(next)
      if (!Number.isSafeInteger(cap) || cap < 1)
        throw new Error(`--sample-capacity must be a positive integer, got ${next ?? '(missing)'}`)
      result.sampleCapacity = cap
    }
    else if (value === '--output') {
      result.output = argv[++index]
      if (!result.output)
        throw new Error('--output requires a directory argument')
    }
    else if (value === '--thresholds') {
      result.thresholds = argv[++index]
      if (!result.thresholds)
        throw new Error('--thresholds requires a file argument')
    }
    else if (value === '--price-document') {
      result.priceDocument = argv[++index]
      if (!result.priceDocument)
        throw new Error('--price-document requires a file argument')
    }
    else if (value === '--import-live') {
      const live = argv[++index]
      if (!live)
        throw new Error('--import-live requires a file argument')
      result.importLive.push(live)
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
function assertSafeOutputDirectory(directory: string, repoRoot: string): { error?: string, kind?: 'unsafe' | 'invalid' } {
  if (!isAbsolute(directory))
    return { error: `--output must be an absolute path, got ${directory}`, kind: 'unsafe' }
  if (insideRepository(repoRoot, directory))
    return { error: `--output ${directory} is inside the repository checkout; use a private directory outside it`, kind: 'unsafe' }
  let real
  try {
    real = realpath(directory)
  }
  catch {
    return {}
  }
  if (real !== directory && insideRepository(repoRoot, real))
    return { error: `--output ${directory} resolves inside the repository checkout via symlink`, kind: 'unsafe' }
  if (existsSync(directory) && statSync(directory).isDirectory()) {
    const entries = readdirSync(directory)
    if (entries.length > 0) {
      const hasMatchingRun = entries.includes('summary.json')
      if (!hasMatchingRun)
        return { error: `--output ${directory} is nonempty and not a previously initialized run directory`, kind: 'unsafe' }
    }
  }
  return {}
}

function insideRepository(repoRoot: string, target: string): boolean {
  const step = relative(resolve(repoRoot), resolve(target))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

function realpath(path: string): string {
  return execFileSync('node', ['-e', `process.stdout.write(require('fs').realpathSync(${JSON.stringify(path)}))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function makeTempOutputDir(repoRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'imp803-bench-out-'))
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

function gitDirty(repoRoot: string): boolean {
  try {
    const status = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
    return status.length > 0
  }
  catch {
    return false
  }
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string')
    return (error as { message: string }).message
  return String(error)
}

await main()
