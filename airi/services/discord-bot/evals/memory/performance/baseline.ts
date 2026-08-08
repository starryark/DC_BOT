import type { EnvironmentFingerprint, MeasurementRecord, RunManifest, WorkloadPlanEntry } from './contracts'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'

import * as v from 'valibot'

import { measurementRecordSchema, runManifestSchema } from './contracts'
import { deriveRunState } from './report'
import { parseRunFindingsJsonl } from './run-findings'
import { parseSampleAttemptsJsonl } from './sample-results'

/**
 * Baseline compatibility for the IMP-803 performance-v2 benchmark.
 *
 * v1 treated a matching `contractDigest` as sufficient and skipped any metric
 * the baseline lacked with a bare `continue`, so a failed, half-complete, or
 * differently-configured run could serve as a reference and the resulting
 * deltas would be computed over whatever metrics happened to overlap.
 *
 * v2 refuses a reference unless the contract, the effective execution plan, the
 * host, and the measurement coverage all match, and unless both runs are
 * themselves correctness-clean. Every refusal is reported as a content-free
 * reason rather than one implicit message.
 *
 * Threshold presence is deliberately not part of compatibility: a clean run
 * whose metrics are all `not_evaluated` is a valid raw latency reference. A
 * threshold document governs policy evaluation, not whether two samples were
 * taken under comparable conditions.
 */

/** Why a candidate and a baseline are not comparable; content-free and stable. */
export const INCOMPATIBILITY_REASONS = Object.freeze([
  'schema-version-mismatch',
  'contract-id-mismatch',
  'contract-digest-mismatch',
  'suite-mismatch',
  'workload-plan-mismatch',
  'sample-capacity-mismatch',
  'baseline-correctness-failed',
  'candidate-correctness-failed',
  'baseline-sample-incomplete',
  'candidate-sample-incomplete',
  'baseline-cleanup-failed',
  'candidate-cleanup-failed',
  'baseline-summary-unrecomputable',
  'platform-mismatch',
  'architecture-mismatch',
  'node-version-mismatch',
  'pnpm-version-mismatch',
  'sqlite-version-mismatch',
  'cpu-model-mismatch',
  'cpu-count-mismatch',
  'total-memory-mismatch',
  'metric-missing',
  'metric-unit-mismatch',
  'metric-statistic-mismatch',
  'metric-role-mismatch',
] as const)
export type IncompatibilityReason = typeof INCOMPATIBILITY_REASONS[number]

export const baselineComparisonResultSchema = v.strictObject({
  status: v.picklist(['compatible', 'incompatible'] as const),
  reasons: v.optional(v.array(v.picklist(INCOMPATIBILITY_REASONS))),
  deltas: v.optional(v.array(v.strictObject({
    metricId: v.string(),
    baselineValue: v.number(),
    candidateValue: v.number(),
    delta: v.number(),
    unit: v.string(),
    statistic: v.string(),
  }))),
})

export type BaselineComparisonResult = v.InferOutput<typeof baselineComparisonResultSchema>

/** One complete v2 run: the raw rows a comparison is entitled to trust. */
export interface LoadedRun {
  readonly manifest: RunManifest
  readonly attempts: readonly SampleAttemptRecord[]
  readonly runFindings: readonly RunFindingRecord[]
  readonly measurements: readonly MeasurementRecord[]
}

/**
 * Environment fields that must match exactly for two runs to be comparable.
 *
 * NOTICE:
 * Exact equality — including `totalMemoryBytes` — is deliberate. A tolerance is
 * a policy decision with a numeric bound, and inventing one here would put an
 * unapproved threshold into source. If governance wants a tolerance it belongs
 * in the runbook first, and this list changes to match it.
 */
const ENVIRONMENT_CHECKS: ReadonlyArray<{ readonly field: keyof EnvironmentFingerprint, readonly reason: IncompatibilityReason }> = Object.freeze([
  { field: 'platform', reason: 'platform-mismatch' },
  { field: 'architecture', reason: 'architecture-mismatch' },
  { field: 'nodeVersion', reason: 'node-version-mismatch' },
  { field: 'pnpmVersion', reason: 'pnpm-version-mismatch' },
  { field: 'sqliteVersion', reason: 'sqlite-version-mismatch' },
  { field: 'cpuModel', reason: 'cpu-model-mismatch' },
  { field: 'cpuCount', reason: 'cpu-count-mismatch' },
  { field: 'totalMemoryBytes', reason: 'total-memory-mismatch' },
])

/**
 * Compare a candidate run against a baseline run.
 *
 * Deltas are produced only for a fully compatible pair. An incompatible pair
 * returns every reason it failed, so a reviewer sees the whole problem rather
 * than the first check that tripped.
 */
export function compareAgainstBaseline(baseline: LoadedRun, candidate: LoadedRun): BaselineComparisonResult {
  const reasons = new Set<IncompatibilityReason>()

  if (baseline.manifest.schemaVersion !== candidate.manifest.schemaVersion)
    reasons.add('schema-version-mismatch')
  if (baseline.manifest.contractId !== candidate.manifest.contractId)
    reasons.add('contract-id-mismatch')
  if (baseline.manifest.contractDigest !== candidate.manifest.contractDigest)
    reasons.add('contract-digest-mismatch')
  if (baseline.manifest.suite !== candidate.manifest.suite)
    reasons.add('suite-mismatch')

  for (const { field, reason } of ENVIRONMENT_CHECKS) {
    if (baseline.manifest.environment[field] !== candidate.manifest.environment[field])
      reasons.add(reason)
  }

  collectPlanReasons(baseline.manifest.workloadPlan, candidate.manifest.workloadPlan, reasons)
  collectEligibilityReasons(baseline, 'baseline', reasons)
  collectEligibilityReasons(candidate, 'candidate', reasons)

  const baselineByMetric = new Map(baseline.measurements.map(record => [record.metricId, record]))
  const candidateByMetric = new Map(candidate.measurements.map(record => [record.metricId, record]))
  // Coverage must match in both directions: a metric present in only one run
  // means the two runs did not measure the same thing.
  for (const metricId of new Set([...baselineByMetric.keys(), ...candidateByMetric.keys()])) {
    const base = baselineByMetric.get(metricId)
    const cand = candidateByMetric.get(metricId)
    if (!base || !cand) {
      reasons.add('metric-missing')
      continue
    }
    if (base.unit !== cand.unit)
      reasons.add('metric-unit-mismatch')
    if (base.statistic !== cand.statistic)
      reasons.add('metric-statistic-mismatch')
    if (base.role !== cand.role)
      reasons.add('metric-role-mismatch')
  }

  if (reasons.size > 0)
    return { status: 'incompatible', reasons: [...reasons].sort() }

  const deltas: NonNullable<BaselineComparisonResult['deltas']> = []
  for (const cand of candidate.measurements) {
    const base = baselineByMetric.get(cand.metricId)!
    if (cand.outcome.disposition === 'observed' && base.outcome.disposition === 'observed') {
      deltas.push({
        metricId: cand.metricId,
        baselineValue: base.outcome.value,
        candidateValue: cand.outcome.value,
        delta: cand.outcome.value - base.outcome.value,
        unit: cand.unit,
        statistic: cand.statistic,
      })
    }
  }

  return { status: 'compatible', deltas }
}

/** The effective plan must match entry for entry; a different plan is a different experiment. */
function collectPlanReasons(baselinePlan: readonly WorkloadPlanEntry[], candidatePlan: readonly WorkloadPlanEntry[], reasons: Set<IncompatibilityReason>): void {
  const baselineById = new Map(baselinePlan.map(entry => [entry.workloadId, entry]))
  const candidateById = new Map(candidatePlan.map(entry => [entry.workloadId, entry]))
  for (const workloadId of new Set([...baselineById.keys(), ...candidateById.keys()])) {
    const base = baselineById.get(workloadId)
    const cand = candidateById.get(workloadId)
    if (!base || !cand) {
      reasons.add('workload-plan-mismatch')
      continue
    }
    if (base.warmupCount !== cand.warmupCount || base.sampleCount !== cand.sampleCount)
      reasons.add('workload-plan-mismatch')
    // Reservoir capacity decides which samples a percentile was computed over,
    // so two runs with different capacities produced different statistics even
    // when every other input matched.
    if (base.sampleCapacity !== cand.sampleCapacity)
      reasons.add('sample-capacity-mismatch')
  }
}

/** A run is eligible as evidence only when its own rows say it is clean and complete. */
function collectEligibilityReasons(run: LoadedRun, side: 'baseline' | 'candidate', reasons: Set<IncompatibilityReason>): void {
  const derived = deriveRunState(run.manifest, run.attempts, run.runFindings, run.measurements, [])
  if (derived.sampleCounts.failed > 0)
    reasons.add(side === 'baseline' ? 'baseline-correctness-failed' : 'candidate-correctness-failed')
  if (derived.sampleCompleteness !== 'complete' || !derived.measurementDenominatorsConsistent)
    reasons.add(side === 'baseline' ? 'baseline-sample-incomplete' : 'candidate-sample-incomplete')
  if (derived.cleanupFailures > 0)
    reasons.add(side === 'baseline' ? 'baseline-cleanup-failed' : 'candidate-cleanup-failed')
}

/** Filenames the v2 artifact set must contain for a directory to be a loadable run. */
const REQUIRED_ARTIFACTS = Object.freeze(['run-manifest.json', 'attempts.jsonl', 'run-findings.jsonl', 'measurements.jsonl', 'summary.json'] as const)

/**
 * Load a complete v2 run directory, verifying it against its own evidence.
 *
 * `summary.json` is reparsed and reconciled with a summary recomputed from the
 * raw rows. A directory whose published summary disagrees with its artifacts is
 * rejected outright: it cannot be trusted as a reference no matter which of the
 * two is wrong. v1 loaded only the manifest and measurements and trusted both.
 */
export function loadRun(
  directory: string,
  readFileSync: (path: string, enc: 'utf8') => string,
  existsSync: (path: string) => boolean,
  join: (...paths: string[]) => string,
): LoadedRun {
  if (!existsSync(directory))
    throw new Error(`Directory not found: ${directory}`)
  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(directory, artifact)))
      throw new Error(`Missing ${artifact} in run directory; a performance-v2 baseline requires the complete artifact set`)
  }

  const manifest = v.parse(runManifestSchema, JSON.parse(readFileSync(join(directory, 'run-manifest.json'), 'utf8')))
  const attempts = parseSampleAttemptsJsonl(readFileSync(join(directory, 'attempts.jsonl'), 'utf8'))
  const runFindings = parseRunFindingsJsonl(readFileSync(join(directory, 'run-findings.jsonl'), 'utf8'))
  const measurements: MeasurementRecord[] = []
  for (const line of readFileSync(join(directory, 'measurements.jsonl'), 'utf8').split('\n')) {
    if (line.trim().length === 0)
      continue
    measurements.push(v.parse(measurementRecordSchema, JSON.parse(line)))
  }

  const published = JSON.parse(readFileSync(join(directory, 'summary.json'), 'utf8')) as Record<string, unknown>
  const recomputed = deriveRunState(manifest, attempts, runFindings, measurements, [])
  const disagreements = summaryDisagreements(published, recomputed)
  if (disagreements.length > 0)
    throw new Error(`Published summary disagrees with its own artifacts: ${disagreements.join(', ')}`)

  return { manifest, attempts, runFindings, measurements }
}

/** Fields of a published summary that must equal the recomputed state. */
function summaryDisagreements(published: Record<string, unknown>, recomputed: ReturnType<typeof deriveRunState>): readonly string[] {
  const disagreements: string[] = []
  const compare = (field: string, publishedValue: unknown, recomputedValue: unknown): void => {
    if (JSON.stringify(publishedValue) !== JSON.stringify(recomputedValue))
      disagreements.push(field)
  }
  compare('disposition', published.disposition, recomputed.disposition)
  compare('sampleCounts', published.sampleCounts, recomputed.sampleCounts)
  compare('correctnessFailures', published.correctnessFailures, recomputed.correctnessFailures)
  compare('failedPostconditions', published.failedPostconditions, recomputed.failedPostconditions)
  compare('cleanupFailures', published.cleanupFailures, recomputed.cleanupFailures)
  compare('sampleCompleteness', published.sampleCompleteness, recomputed.sampleCompleteness)
  compare('measurementDenominatorsConsistent', published.measurementDenominatorsConsistent, recomputed.measurementDenominatorsConsistent)
  compare('metricStatusCounts', published.metricStatusCounts, recomputed.metricStatusCounts)
  compare('approvedThresholdFailures', published.approvedThresholdFailures, recomputed.approvedThresholdFailures)
  compare('workloadCounts', published.workloadCounts, recomputed.workloadCounts)
  return disagreements
}
