#!/usr/bin/env tsx
/**
 * `memory:benchmark` CLI for the IMP-803 deterministic performance benchmark.
 *
 * Produces a complete, recomputable, content-free artifact set with
 * deterministic contract identity and environment-bound measurements. Smoke
 * is credential-free and fast; the full `performance-v2` suite requires an
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

import type { BaselineComparisonResult, LoadedRun } from '../../evals/memory/performance/baseline'
import type { CostDerivation } from '../../evals/memory/performance/cost-evidence'
import type { LiveArtifact } from '../../evals/memory/performance/live-artifact'
import type { PriceDocument } from '../../evals/memory/performance/price-contract'
import type { PerformanceThresholdDocument } from '../../evals/memory/performance/threshold-contract'

import process from 'node:process'

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from '../../evals/memory/performance/contracts'
import { runControllerWorkloads } from '../../evals/memory/performance/controller-runner'
import { deriveCostEvidence } from '../../evals/memory/performance/cost-evidence'
import { collectEnvironmentFingerprint } from '../../evals/memory/performance/environment'
import { liveArtifactDigest, parseLiveArtifact } from '../../evals/memory/performance/live-artifact'
import { parsePriceDocument, priceDocumentDigest } from '../../evals/memory/performance/price-contract'
import { buildPerformanceReport } from '../../evals/memory/performance/report'
import { runRuntimeSuite } from '../../evals/memory/performance/runtime-runner'
import { applyPerformanceThresholds, parsePerformanceThresholdDocument, performanceThresholdDocumentDigest, validatePerformanceThresholdCompatibility } from '../../evals/memory/performance/threshold-contract'
import { WORKLOAD_CATALOG_DIGEST, workloadsForSuite } from '../../evals/memory/performance/workloads'
import { disposeEvaluationRun, startEvaluationRun } from '../../evals/memory/runtime-adapter'
import { assertSafeOutputDirectory, insideRepository } from './output-safety'

const EXIT = { COMPLETE: 0, INVALID: 2, CORRECTNESS: 3, UNSAFE: 4, UNEXPECTED: 5 } as const
const BENCH_CHARACTER = asCharacterId('bench-character')

interface ParsedArgs {
  help: boolean
  suite: 'smoke' | 'performance-v2'
  seed: number
  warmup?: number
  samples?: number
  sampleCapacity?: number
  output?: string
  thresholds?: string
  priceDocument?: string
  importLive: string[]
  keepRunRoot: boolean
  baseline?: string
}

const HELP_TEXT = `Usage: memory:benchmark [options]

Options:
  --suite smoke|performance-v2   Suite to run (default: smoke)
  --seed <non-negative integer>  Deterministic seed (default: 20260802)
  --warmup <positive integer>    Override warmup count for every workload
  --samples <positive integer>   Override measured sample count for every workload
  --sample-capacity <integer>    Override reservoir sample capacity
  --output <directory>           Absolute external output directory (required for performance-v2)
  --thresholds <file>            Approved threshold document (provenance validated before runtime start)
  --price-document <file>        Approved price document (provenance validated before runtime start)
  --import-live <file>           Import a live artifact (repeatable). One cost-eligible
                                 brain-usage-sample plus a matching price document derives
                                 calculated cost; capture one with memory:capture-brain-usage
  --baseline <directory>         Compare against an accepted compatible baseline
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

  const workspaceRoot = resolve(import.meta.dirname, '../..')
  let gitRoot: string
  try {
    gitRoot = execFileSync('git', ['-C', workspaceRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  }
  catch {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'failed to resolve Git top-level directory' })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }

  let outputDirectory: string | undefined

  // Output validation: smoke may use a temp dir; performance-v2 requires explicit --output.
  if (parsed.output) {
    outputDirectory = resolve(parsed.output)
    const pathCheck = assertSafeOutputDirectory(outputDirectory, gitRoot, 'summary.json')
    if (pathCheck.error) {
      // An output inside the checkout is an unsafe-output condition (4); a
      // nonempty or non-absolute directory is an invalid-config condition (2).
      const isUnsafe = pathCheck.kind === 'unsafe'
      process.stderr.write(`${JSON.stringify({ status: isUnsafe ? 'unsafe' : 'invalid', message: pathCheck.error })}\n`)
      process.exitCode = isUnsafe ? EXIT.UNSAFE : EXIT.INVALID
      return
    }
  }
  else if (parsed.suite === 'performance-v2') {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'performance-v2 requires an explicit --output directory' })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }
  else {
    outputDirectory = makeTempOutputDir(gitRoot)
  }

  // Full-suite guards: reject dirty worktree and unknown git head.
  const commitSha = gitHead(gitRoot)
  const dirtyWorktree = gitDirty(gitRoot)
  if (parsed.suite === 'performance-v2') {
    if (commitSha.length !== 40 || commitSha === 'unknown'.repeat(10).slice(0, 40)) {
      process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'performance-v2 requires a known git HEAD' })}\n`)
      process.exitCode = EXIT.INVALID
      return
    }
    if (dirtyWorktree) {
      process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'performance-v2 requires a clean worktree' })}\n`)
      process.exitCode = EXIT.INVALID
      return
    }
  }

  mkdirSync(outputDirectory, { recursive: true })

  const runId = `bench-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}-${commitSha.slice(0, 8)}`

  const startedAt = new Date().toISOString()

  let thresholdDocument: PerformanceThresholdDocument | undefined
  let thresholdDocumentDigestValue: string | null = null
  let priceDocumentDigestValue: string | null = null
  const importedLiveArtifactDigests: string[] = []
  const importedLiveArtifacts: LiveArtifact[] = []
  // Derived before the runtime starts: cost depends only on the imported
  // evidence and the approved price document, so an ambiguous or unusable set
  // fails as invalid input (exit 2) rather than after a full suite has run.
  let cost: CostDerivation = { status: 'unavailable', reason: 'no-price-document-supplied' }
  let baselineRun: LoadedRun | undefined

  try {
    if (parsed.baseline) {
      const { loadRun } = await import('../../evals/memory/performance/baseline')
      // `loadRun` parses the whole v2 set through the strict schemas and
      // recomputes the summary from the raw rows; a directory whose summary
      // disagrees with its own evidence is rejected here rather than being
      // silently accepted as a reference.
      baselineRun = loadRun(parsed.baseline, readFileSync, existsSync, join)
      if (baselineRun.manifest.contractDigest !== WORKLOAD_CATALOG_DIGEST) {
        throw new Error(`Baseline contractDigest mismatch (expected ${WORKLOAD_CATALOG_DIGEST}, got ${baselineRun.manifest.contractDigest})`)
      }
    }

    if (parsed.thresholds) {
      const raw = readFileSync(parsed.thresholds, 'utf8')
      const parsedDoc = JSON.parse(raw)
      thresholdDocument = parsePerformanceThresholdDocument(parsedDoc)
      const failures = validatePerformanceThresholdCompatibility(thresholdDocument, WORKLOAD_CATALOG_DIGEST, workloadsForSuite(parsed.suite))
      if (failures.length > 0)
        throw new Error(`Threshold compatibility failed: ${failures.join(', ')}`)
      thresholdDocumentDigestValue = performanceThresholdDocumentDigest(thresholdDocument)
    }

    let priceDocument: PriceDocument | undefined
    if (parsed.priceDocument) {
      const raw = readFileSync(parsed.priceDocument, 'utf8')
      const parsedDoc = JSON.parse(raw)
      priceDocument = parsePriceDocument(parsedDoc)
      priceDocumentDigestValue = priceDocumentDigest(priceDocument)
    }

    for (const livePath of parsed.importLive) {
      const raw = readFileSync(livePath, 'utf8')
      const parsedDoc = JSON.parse(raw)
      const doc = parseLiveArtifact(parsedDoc)
      const digest = liveArtifactDigest(doc)
      if (importedLiveArtifactDigests.includes(digest))
        throw new Error(`Duplicate live artifact digest: ${digest}`)
      importedLiveArtifactDigests.push(digest)
      importedLiveArtifacts.push(doc)
    }

    // This benchmark never calls a provider. Cost is derived offline from the
    // sanitized usage a separate capture already observed, priced by the
    // approved document; two cost-eligible samples are ambiguous and throw.
    cost = deriveCostEvidence({
      liveArtifacts: importedLiveArtifacts,
      ...(priceDocument && priceDocumentDigestValue ? { price: { document: priceDocument, digest: priceDocumentDigestValue } } : {}),
    })
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }

  try {
    const evaluationRun = startEvaluationRun({ repoRoot: workspaceRoot, keepRunRoot: parsed.keepRunRoot })
    try {
      // The effective plan is resolved once, before any runner starts, and the
      // same values are handed to both runner families and written to the
      // manifest. Without it a verifier cannot tell whether `attempted` equals
      // the configured sample count, because the counts lived only in argv.
      const selectedWorkloads = workloadsForSuite(parsed.suite)
      const workloadPlan = selectedWorkloads.map(workload => ({
        workloadId: workload.workloadId,
        warmupCount: parsed.warmup ?? workload.warmupCount,
        sampleCount: parsed.samples ?? workload.sampleCount,
        sampleCapacity: parsed.sampleCapacity ?? workload.sampleCapacity,
      }))

      const runnerOptions = {
        repoRoot: workspaceRoot,
        run: evaluationRun,
        characterId: BENCH_CHARACTER,
        seed: parsed.seed,
        warmupCount: parsed.warmup,
        sampleCount: parsed.samples,
        sampleCapacity: parsed.sampleCapacity,
      }
      const runtimeResult = await runRuntimeSuite(parsed.suite, runnerOptions)
      const controllerResult = await runControllerWorkloads(selectedWorkloads.filter(w => w.runner !== 'runtime'), runnerOptions)

      const completedAt = new Date().toISOString()

      let allMeasurements = [
        ...runtimeResult.results.flatMap(result => result.measurements),
        ...controllerResult.results.flatMap(result => result.measurements),
        // Active/control deltas are measurements, not just a report field, so a
        // threshold document can bind to them; they must be in this list before
        // `applyPerformanceThresholds` or a delta bound never fires.
        ...controllerResult.activeControlDeltaMeasurements,
      ]

      allMeasurements = applyPerformanceThresholds(allMeasurements, thresholdDocument)

      const attempts = [
        ...runtimeResult.results.flatMap(result => result.attempts),
        ...controllerResult.results.flatMap(result => result.attempts),
      ]
      const runFindings = [...runtimeResult.runFindings, ...controllerResult.runFindings]

      const completedIds = [...runtimeResult.results, ...controllerResult.results].map(r => r.workloadId)
      const skippedIds = selectedWorkloads.map(w => w.workloadId).filter(id => !completedIds.includes(id))

      const manifest = {
        schemaVersion: PERFORMANCE_SCHEMA_VERSION,
        contractId: PERFORMANCE_CONTRACT_ID,
        contractDigest: runtimeResult.contractDigest,
        commitSha,
        dirtyWorktree,
        suite: parsed.suite,
        seed: parsed.seed,
        environment: collectEnvironmentFingerprint('10.33.0'),
        configuration: [
          ...(parsed.warmup ? [{ key: 'warmupOverride', value: parsed.warmup.toString() }] : []),
          ...(parsed.samples ? [{ key: 'sampleOverride', value: parsed.samples.toString() }] : []),
          ...(parsed.sampleCapacity ? [{ key: 'sampleCapacityOverride', value: parsed.sampleCapacity.toString() }] : []),
          { key: 'suite', value: parsed.suite },
        ],
        timerSource: 'performance.now',
        startedAt,
        completedAt,
        workloadPlan,
        workloadsCompleted: completedIds,
        importedLiveArtifactDigests,
        ...(thresholdDocumentDigestValue ? { thresholdDocumentDigest: thresholdDocumentDigestValue } : {}),
        ...(priceDocumentDigestValue ? { priceDocumentDigest: priceDocumentDigestValue } : {}),
        limitations: [],
      }

      let baselineComparison: BaselineComparisonResult | undefined
      if (baselineRun) {
        const { compareAgainstBaseline } = await import('../../evals/memory/performance/baseline')
        baselineComparison = compareAgainstBaseline(baselineRun, {
          manifest,
          attempts,
          runFindings,
          measurements: allMeasurements,
        })
      }

      const report = buildPerformanceReport({
        runId,
        manifest,
        attempts,
        runFindings,
        measurements: allMeasurements,
        voiceSampleDiagnostics: controllerResult.voiceSampleDiagnostics,
        skippedWorkloadIds: skippedIds,
        activeControlDeltas: controllerResult.activeControlDeltas,
        importedLiveArtifactDigests,
        cost,
        ...(baselineComparison ? { baselineComparison } : {}),
        limitations: [
          'Deterministic stub benchmark; does not establish live Discord transport performance.',
          'Barge-in results are controller cancellation path, not acoustic barge-in qualification.',
          cost.status === 'available'
            ? 'Calculated cost is derived from one observed usage sample and an approved price document; it is not verified billing truth.'
            : 'Cost is unavailable without both a matching approved price document and one cost-eligible brain usage sample.',
        ],
      })

      if (report.redactionFindings.length > 0) {
        process.stderr.write(`${JSON.stringify({ status: 'unsafe', message: 'redaction scan found prohibited content', findings: report.redactionFindings })}\n`)
        process.exitCode = EXIT.UNSAFE
        return
      }

      if (parsed.suite === 'performance-v2') {
        const currentSha = gitHead(gitRoot)
        const currentDirty = gitDirty(gitRoot)
        if (currentSha !== commitSha || currentDirty !== dirtyWorktree) {
          process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'Git worktree changed during benchmark execution' })}\n`)
          process.exitCode = EXIT.INVALID
          return
        }
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

/**
 * Write every artifact atomically: temp sibling files renamed only after
 * successful serialization and scan.
 *
 * The v2 set is seven files. `attempts.jsonl` and `run-findings.jsonl` are what
 * make the summary independently recomputable, so a set missing them is not a
 * v2 artifact set even if the other five parse.
 *
 * `voice-sample-diagnostics.jsonl` is supplementary: it is written on every run
 * — empty when the suite ran neither condition-5 voice workload — but a run
 * directory without it is still loadable, because accepted baselines predate it
 * and their evidence did not change when it was added.
 */
function writeArtifactsAtomically(outputDirectory: string, manifest: object, report: ReturnType<typeof buildPerformanceReport>): void {
  const targets = [
    { name: 'run-manifest.json', content: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: 'attempts.jsonl', content: report.attemptsJsonl },
    { name: 'run-findings.jsonl', content: report.runFindingsJsonl },
    { name: 'measurements.jsonl', content: report.measurementsJsonl },
    { name: 'voice-sample-diagnostics.jsonl', content: report.voiceSampleDiagnosticsJsonl },
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
      if (next !== 'smoke' && next !== 'performance-v2')
        throw new Error(`--suite must be smoke or performance-v2, got ${next ?? '(missing)'}`)
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
    else if (value === '--baseline') {
      result.baseline = argv[++index]
      if (!result.baseline)
        throw new Error('--baseline requires a directory argument')
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

function makeTempOutputDir(gitRoot: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'imp803-bench-out-'))
  if (insideRepository(gitRoot, dir))
    throw new Error('temp output directory landed inside the repository checkout; pass --output explicitly')
  return dir
}

function gitHead(gitRoot: string): string {
  try {
    return execFileSync('git', ['-C', gitRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  }
  catch {
    return 'unknown'.repeat(10).slice(0, 40)
  }
}

function gitDirty(gitRoot: string): boolean {
  try {
    const status = execFileSync('git', ['-C', gitRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim()
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
