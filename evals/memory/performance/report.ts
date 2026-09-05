import type { MeasurementRecord, RunManifest } from './contracts'
import type { CostDerivation, CostEvidence } from './cost-evidence'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'
import type { VoiceSampleDiagnosticRecord } from './voice-sample-diagnostics'

import * as v from 'valibot'

import { prohibitedContentFindings } from '../redaction'
import { measurementRecordSchema, PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION, runManifestSchema } from './contracts'
import { parseRunFindingsJsonl, runFindingsJsonl } from './run-findings'
import { attemptsForWorkload, parseSampleAttemptsJsonl, sampleAttemptsJsonl, summarizeSampleAttempts, validateSampleAttempts } from './sample-results'
import { voiceSampleDiagnosticsJsonl } from './voice-sample-diagnostics'
import { WORKLOAD_CATALOG, WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Report assembly for the IMP-803 deterministic performance benchmark.
 *
 * Produces a content-free artifact set whose raw rows — the run manifest, the
 * measured attempts, the cleanup findings, and the measurements — are
 * sufficient to reconstruct every correctness count and the whole-run
 * disposition without trusting `summary.json`.
 *
 * v1 could not do this. `buildPerformanceReport()` received an independently
 * supplied correctness-failure count that nothing published could contradict,
 * and cleanup failures forced the run to `failed` while appearing in no
 * artifact at all. v2 derives both from rows, so a summary that disagrees with
 * its own evidence is detectable.
 *
 * The contract digest is deterministic (identical for matched runs of the same
 * workload catalog); timings are environment-bound and allowed to differ. The
 * overall disposition is never called `G8 passed`.
 */

/** The overall disposition of a benchmark run. */
export const RUN_DISPOSITIONS = Object.freeze([
  'correctness_clean_measured_not_evaluated',
  'correctness_clean_thresholds_passed',
  'failed',
] as const)
export type RunDisposition = typeof RUN_DISPOSITIONS[number]

/** At most this many sample-validation reasons are published; the count is always exact. */
const MAX_PUBLISHED_VALIDATION_REASONS = 32

/**
 * Measured-attempt counts, with the v1 naming ambiguity resolved.
 *
 * `attempted` is the number of published attempt rows, which must equal the
 * configured sample count from the manifest plan. `passed` is the latency
 * denominator: a failed attempt contributes no observation.
 */
export interface SampleCounts {
  readonly attempted: number
  readonly passed: number
  readonly failed: number
}

/** The whole-run summary written to `summary.json`. */
export interface PerformanceSummary {
  readonly schemaVersion: typeof PERFORMANCE_SCHEMA_VERSION
  readonly contractId: typeof PERFORMANCE_CONTRACT_ID
  readonly contractDigest: string
  readonly runId: string
  readonly disposition: RunDisposition
  readonly workloadCounts: { readonly completed: number, readonly failed: number, readonly skipped: number }
  readonly sampleCounts: SampleCounts
  /** Failed measured attempts. Named for v1 compatibility; it is an attempt count, not a predicate count. */
  readonly correctnessFailures: number
  /** Total failed postcondition ids summed across failed attempts. */
  readonly failedPostconditions: number
  readonly cleanupFailures: number
  /**
   * Warmup executions that failed.
   *
   * Warmups are discarded work and contribute no attempt row, so this count
   * sits deliberately outside `sampleCounts`: the measured denominator must
   * keep matching the configured sample count. It is still a correctness fact,
   * and a nonzero count forces the run to `failed`.
   */
  readonly warmupFailures: number
  readonly sampleCompleteness: 'complete' | 'incomplete'
  readonly sampleValidationFailureCount: number
  readonly sampleValidationFailures: readonly string[]
  /** Whether every measurement's `observationCount` equals its workload's passed attempts. */
  readonly measurementDenominatorsConsistent: boolean
  readonly redactionFindings: readonly string[]
  readonly metricStatusCounts: { readonly passed: number, readonly failed: number, readonly measuredNotEvaluated: number }
  readonly approvedThresholdFailures: number
  readonly activeControlDeltas: Readonly<Record<string, number>>
  readonly baselineComparison?: { readonly status: string, readonly reasons?: readonly string[], readonly deltas?: ReadonlyArray<{ readonly metricId: string, readonly delta: number, readonly unit: string, readonly statistic: string }> }
  readonly environmentFingerprint: { readonly nodeVersion: string, readonly platform: string, readonly architecture: string }
  readonly importedLiveArtifactDigests: readonly string[]
  /**
   * Derived from {@link PerformanceReportInputs.cost}, never asserted.
   *
   * It stays in the summary because accepted baselines and external consumers
   * read it, but it is a consistency indicator: `available` is published only
   * alongside the {@link costEvidence} that produced it, and proof lives in
   * that evidence.
   */
  readonly costAvailability: 'available' | 'unavailable'
  readonly costUnavailableReason?: string
  /**
   * Sanitized evidence sufficient to recompute the calculated cost.
   *
   * Absent whenever cost is unavailable — including on every run that predates
   * cost derivation, which is why it is optional rather than nullable.
   */
  readonly costEvidence?: CostEvidence
  readonly limitations: readonly string[]
}

/** Inputs to the performance report builder; every correctness field is derived from these rows. */
export interface PerformanceReportInputs {
  readonly runId: string
  readonly manifest: RunManifest
  readonly attempts: readonly SampleAttemptRecord[]
  readonly runFindings: readonly RunFindingRecord[]
  readonly measurements: readonly MeasurementRecord[]
  /**
   * Supplementary per-sample timing trails for the two condition-5 voice
   * workloads.
   *
   * Optional because they are additive evidence, not part of the correctness
   * derivation: a run that produced none — every suite that does not include
   * the pair — publishes an empty file rather than omitting the artifact.
   */
  readonly voiceSampleDiagnostics?: readonly VoiceSampleDiagnosticRecord[]
  readonly skippedWorkloadIds: readonly string[]
  readonly activeControlDeltas: Readonly<Record<string, number>>
  readonly baselineComparison?: { readonly status: string, readonly reasons?: readonly string[], readonly deltas?: ReadonlyArray<{ readonly metricId: string, readonly delta: number, readonly unit: string, readonly statistic: string }> }
  readonly importedLiveArtifactDigests: readonly string[]
  /**
   * The derived cost outcome for this run.
   *
   * One discriminated value rather than an availability flag beside a reason:
   * `available` carries the evidence that justifies it, so a caller cannot
   * express a calculated cost it cannot substantiate.
   */
  readonly cost: CostDerivation
  readonly limitations: readonly string[]
}

/** The built performance report artifacts. */
export interface BuiltPerformanceReport {
  readonly summary: PerformanceSummary
  readonly attemptsJsonl: string
  readonly runFindingsJsonl: string
  readonly measurementsJsonl: string
  readonly voiceSampleDiagnosticsJsonl: string
  readonly markdown: string
  readonly redactionFindings: readonly string[]
}

/** Every correctness fact a run publishes, derived from raw rows alone. */
export interface DerivedRunState {
  readonly workloadCounts: { readonly completed: number, readonly failed: number, readonly skipped: number }
  readonly sampleCounts: SampleCounts
  readonly correctnessFailures: number
  readonly failedPostconditions: number
  readonly cleanupFailures: number
  readonly warmupFailures: number
  readonly sampleCompleteness: 'complete' | 'incomplete'
  readonly sampleValidationFailureCount: number
  readonly sampleValidationFailures: readonly string[]
  readonly measurementDenominatorsConsistent: boolean
  readonly metricStatusCounts: { readonly passed: number, readonly failed: number, readonly measuredNotEvaluated: number }
  readonly approvedThresholdFailures: number
  readonly disposition: RunDisposition
}

/**
 * Derive every correctness fact from raw rows.
 *
 * This is the single definition of what the counts mean. `buildPerformanceReport`
 * calls it with in-memory rows and `recomputeSummary` calls it with rows parsed
 * back out of the published artifacts, so a difference between the two can only
 * come from the artifacts being insufficient — which is exactly what the
 * recomputation test is meant to detect.
 */
export function deriveRunState(
  manifest: RunManifest,
  attempts: readonly SampleAttemptRecord[],
  runFindings: readonly RunFindingRecord[],
  measurements: readonly MeasurementRecord[],
  skippedWorkloadIds: readonly string[],
): DerivedRunState {
  const attemptSummary = summarizeSampleAttempts(attempts)
  const validationFailures = validateSampleAttempts(attempts, manifest.workloadPlan, WORKLOAD_CATALOG)
  const cleanupFailures = runFindings.filter(finding => finding.kind === 'cleanup-failure').length
  const warmupFailures = runFindings.filter(finding => finding.kind === 'warmup-failure').length

  // A planned workload counts as completed once it produced any measured
  // attempt; it counts as failed when its evidence is not clean. Both are read
  // from rows so a workload cannot report itself clean.
  let completed = 0
  let failedWorkloads = 0
  for (const entry of manifest.workloadPlan) {
    const own = attemptsForWorkload(attempts, entry.workloadId)
    if (own.length > 0)
      completed += 1
    const ordinals = new Set(own.map(attempt => attempt.ordinal))
    const complete = ordinals.size === entry.sampleCount && [...ordinals].every(ordinal => ordinal < entry.sampleCount)
    const ownFindings = runFindings.filter(finding => finding.workloadId === entry.workloadId).length
    if (!complete || own.some(attempt => attempt.outcome === 'failed') || ownFindings > 0)
      failedWorkloads += 1
  }

  // A latency statistic computed over a different number of observations than
  // the attempts that passed is a denominator the artifacts contradict.
  let denominatorsConsistent = true
  for (const record of measurements) {
    const passedForWorkload = attemptSummary.byWorkload[record.workloadId]?.passed ?? 0
    if (record.observationCount !== passedForWorkload)
      denominatorsConsistent = false
  }

  const metricStatusCounts = { passed: 0, failed: 0, measuredNotEvaluated: 0 }
  let approvedThresholdFailures = 0
  for (const record of measurements) {
    if (record.thresholdEvaluation === 'passed') {
      metricStatusCounts.passed += 1
    }
    else if (record.thresholdEvaluation === 'failed') {
      metricStatusCounts.failed += 1
      approvedThresholdFailures += 1
    }
    else {
      metricStatusCounts.measuredNotEvaluated += 1
    }
  }

  const sampleCompleteness = validationFailures.length === 0 ? 'complete' : 'incomplete'
  const correctnessFailed = attemptSummary.failedAttempts > 0
    || cleanupFailures > 0
    // A workload whose warmup failed is already counted in `failedWorkloads`,
    // but only for as long as it stays in the effective plan. Naming the count
    // here states the rule about the run itself, not about one attribution path.
    || warmupFailures > 0
    || sampleCompleteness === 'incomplete'
    || !denominatorsConsistent
    || failedWorkloads > 0

  const disposition: RunDisposition = (correctnessFailed || metricStatusCounts.failed > 0)
    ? 'failed'
    : metricStatusCounts.passed > 0
      ? 'correctness_clean_thresholds_passed'
      : 'correctness_clean_measured_not_evaluated'

  return {
    workloadCounts: { completed, failed: failedWorkloads, skipped: skippedWorkloadIds.length },
    sampleCounts: {
      attempted: attemptSummary.attemptedAttempts,
      passed: attemptSummary.passedAttempts,
      failed: attemptSummary.failedAttempts,
    },
    correctnessFailures: attemptSummary.failedAttempts,
    failedPostconditions: attemptSummary.failedPostconditions,
    cleanupFailures,
    warmupFailures,
    sampleCompleteness,
    sampleValidationFailureCount: validationFailures.length,
    sampleValidationFailures: Object.freeze(validationFailures.slice(0, MAX_PUBLISHED_VALIDATION_REASONS)),
    measurementDenominatorsConsistent: denominatorsConsistent,
    metricStatusCounts,
    approvedThresholdFailures,
    disposition,
  }
}

/**
 * Assemble every performance report artifact from raw run rows.
 *
 * The redaction scan runs over every published artifact; any finding is
 * surfaced so the CLI turns it into exit code 4 and leaves no final artifact set.
 */
export function buildPerformanceReport(inputs: PerformanceReportInputs): BuiltPerformanceReport {
  const { manifest, measurements, attempts, runFindings, skippedWorkloadIds } = inputs
  const derived = deriveRunState(manifest, attempts, runFindings, measurements, skippedWorkloadIds)

  const summary: PerformanceSummary = {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    runId: inputs.runId,
    disposition: derived.disposition,
    workloadCounts: derived.workloadCounts,
    sampleCounts: derived.sampleCounts,
    correctnessFailures: derived.correctnessFailures,
    failedPostconditions: derived.failedPostconditions,
    cleanupFailures: derived.cleanupFailures,
    warmupFailures: derived.warmupFailures,
    sampleCompleteness: derived.sampleCompleteness,
    sampleValidationFailureCount: derived.sampleValidationFailureCount,
    sampleValidationFailures: derived.sampleValidationFailures,
    measurementDenominatorsConsistent: derived.measurementDenominatorsConsistent,
    redactionFindings: [],
    metricStatusCounts: derived.metricStatusCounts,
    approvedThresholdFailures: derived.approvedThresholdFailures,
    activeControlDeltas: { ...inputs.activeControlDeltas },
    ...(inputs.baselineComparison
      ? {
          baselineComparison: {
            status: inputs.baselineComparison.status,
            ...(inputs.baselineComparison.reasons ? { reasons: [...inputs.baselineComparison.reasons] } : {}),
            ...(inputs.baselineComparison.deltas ? { deltas: [...inputs.baselineComparison.deltas] } : {}),
          },
        }
      : {}),
    environmentFingerprint: { nodeVersion: manifest.environment.nodeVersion, platform: manifest.environment.platform, architecture: manifest.environment.architecture },
    importedLiveArtifactDigests: [...inputs.importedLiveArtifactDigests],
    costAvailability: inputs.cost.status === 'available' ? 'available' : 'unavailable',
    ...(inputs.cost.status === 'unavailable' ? { costUnavailableReason: inputs.cost.reason } : {}),
    ...(inputs.cost.status === 'available' ? { costEvidence: inputs.cost.evidence } : {}),
    limitations: [...inputs.limitations],
  }

  const attemptsJsonlBody = sampleAttemptsJsonl(attempts)
  const runFindingsJsonlBody = runFindingsJsonl(runFindings)
  const measurementsJsonl = measurements.length === 0 ? '' : `${measurements.map(record => JSON.stringify(record)).join('\n')}\n`
  const voiceDiagnosticsJsonlBody = voiceSampleDiagnosticsJsonl(inputs.voiceSampleDiagnostics ?? [])
  const markdown = renderMarkdown(summary, manifest)
  const redactionFindings = scanAllArtifacts({
    manifest: JSON.stringify(manifest),
    summary: JSON.stringify(summary),
    attempts: attemptsJsonlBody,
    runFindings: runFindingsJsonlBody,
    measurements: measurementsJsonl,
    // Scanned on exactly the same terms as every other published body: a timing
    // artifact is published evidence, so a finding in it makes the run unsafe
    // rather than merely degrading a diagnostic.
    voiceSampleDiagnostics: voiceDiagnosticsJsonlBody,
    markdown,
  })

  return {
    summary: { ...summary, redactionFindings },
    attemptsJsonl: attemptsJsonlBody,
    runFindingsJsonl: runFindingsJsonlBody,
    measurementsJsonl,
    voiceSampleDiagnosticsJsonl: voiceDiagnosticsJsonlBody,
    markdown,
    redactionFindings,
  }
}

/** The serialized artifact bodies a verifier reads back from disk. */
export interface SerializedRunArtifacts {
  readonly runManifestJson: string
  readonly attemptsJsonl: string
  readonly runFindingsJsonl: string
  readonly measurementsJsonl: string
}

/**
 * Independently reconstruct a run's correctness state from published artifacts.
 *
 * Every input is reparsed through the strict v2 schemas rather than trusted as
 * already-valid, so an artifact set that was hand-edited, truncated, or written
 * by a drifted producer fails here instead of being silently accepted. The
 * caller compares the result with `summary.json`; any disagreement means the
 * summary overclaims relative to its own evidence.
 */
export function recomputeSummary(artifacts: SerializedRunArtifacts, skippedWorkloadIds: readonly string[] = []): DerivedRunState & { readonly contractDigest: string } {
  const manifest = v.parse(runManifestSchema, JSON.parse(artifacts.runManifestJson))
  const attempts = parseSampleAttemptsJsonl(artifacts.attemptsJsonl)
  const runFindings = parseRunFindingsJsonl(artifacts.runFindingsJsonl)
  const measurements: MeasurementRecord[] = []
  for (const line of artifacts.measurementsJsonl.split('\n')) {
    if (line.trim().length === 0)
      continue
    measurements.push(v.parse(measurementRecordSchema, JSON.parse(line)))
  }

  return {
    ...deriveRunState(manifest, attempts, runFindings, measurements, skippedWorkloadIds),
    contractDigest: manifest.contractDigest,
  }
}

/**
 * Scan every published artifact for prohibited content.
 *
 * The shared {@link prohibitedContentFindings} snowflake pattern matches any
 * 17-20 digit run, which false-positives on legitimate floating-point
 * measurement values (e.g. `0.024199999999950705`). Performance artifacts carry
 * float-valued latencies by design, so this scan applies the IMP-802 patterns
 * for non-numeric content (UUIDs, durable ids, canaries, secret fields) and a
 * snowflake check that requires a standalone integer — bounded by a non-digit,
 * non-decimal boundary — rather than a digit run inside a fraction.
 */
function scanAllArtifacts(artifacts: Readonly<Record<string, string>>): readonly string[] {
  const findings = new Set<string>()
  const snowflakePattern = /(?<![\d.])\d{17,20}(?!\d)/
  for (const [name, artifact] of Object.entries(artifacts)) {
    // Reuse the shared scan for everything except the over-broad bare-snowflake rule.
    for (const rule of prohibitedContentFindings(artifact)) {
      if (rule === 'discord-snowflake') {
        // Apply the decimal-boundary-aware snowflake check instead.
        if (snowflakePattern.test(artifact))
          findings.add('discord-snowflake')
      }
      else {
        findings.add(rule)
      }
    }
    // Performance-specific: absolute or relative path in a JSON string value or markdown line.
    if (/[[,:]\s*"(?:\/[^"]*|[A-Z]:\\[^"]*|\.\.?\/[^"]*)"/i.test(artifact))
      findings.add('absolute-or-relative-path')
    if (name === 'markdown' && /(?:^|\n)[-: ]\s*(?:\/\S+|[A-Z]:\\\S+)/i.test(artifact))
      findings.add('absolute-or-relative-path')
  }
  return Object.freeze([...findings])
}

/** Render the content-free Markdown report. */
function renderMarkdown(summary: PerformanceSummary, manifest: RunManifest): string {
  const lines: string[] = []
  lines.push('# IMP-803 deterministic performance benchmark report')
  lines.push('')
  lines.push(`- Run id: \`${summary.runId}\``)
  lines.push(`- Contract: \`${summary.contractId}\` (digest \`${summary.contractDigest}\`)`)
  lines.push(`- Suite: \`${manifest.suite}\``)
  lines.push(`- Seed: \`${manifest.seed}\``)
  lines.push(`- Commit: \`${manifest.commitSha}\``)
  lines.push(`- Dirty worktree: \`${manifest.dirtyWorktree}\``)
  lines.push(`- Platform: \`${summary.environmentFingerprint.platform}\` / \`${summary.environmentFingerprint.architecture}\``)
  lines.push(`- Disposition: \`${summary.disposition}\``)
  lines.push('')
  lines.push('## Workload counts')
  lines.push('')
  lines.push(`- Completed: \`${summary.workloadCounts.completed}\``)
  lines.push(`- Failed: \`${summary.workloadCounts.failed}\``)
  lines.push(`- Skipped: \`${summary.workloadCounts.skipped}\``)
  lines.push('')
  lines.push('## Measured attempts')
  lines.push('')
  lines.push(`- Attempted: \`${summary.sampleCounts.attempted}\``)
  lines.push(`- Passed: \`${summary.sampleCounts.passed}\``)
  lines.push(`- Failed: \`${summary.sampleCounts.failed}\``)
  lines.push(`- Failed postconditions: \`${summary.failedPostconditions}\``)
  lines.push(`- Cleanup failures: \`${summary.cleanupFailures}\``)
  lines.push(`- Warmup failures: \`${summary.warmupFailures}\``)
  lines.push(`- Sample completeness: \`${summary.sampleCompleteness}\``)
  lines.push(`- Measurement denominators consistent: \`${summary.measurementDenominatorsConsistent}\``)
  lines.push('')
  lines.push('## Measurement evaluation')
  lines.push('')
  lines.push(`- Passed: \`${summary.metricStatusCounts.passed}\``)
  lines.push(`- Failed: \`${summary.metricStatusCounts.failed}\``)
  lines.push(`- Measured-not-evaluated: \`${summary.metricStatusCounts.measuredNotEvaluated}\``)
  lines.push(`- Approved threshold failures: \`${summary.approvedThresholdFailures}\``)
  lines.push('')
  lines.push('## Workload plan')
  lines.push('')
  lines.push('| Workload | Warmup | Samples | Capacity |')
  lines.push('|---|---|---|---|')
  for (const entry of manifest.workloadPlan)
    lines.push(`| ${entry.workloadId} | ${entry.warmupCount} | ${entry.sampleCount} | ${entry.sampleCapacity} |`)
  lines.push('')
  if (Object.keys(summary.activeControlDeltas).length > 0) {
    lines.push('## Active/control deltas (mean ms)')
    lines.push('')
    lines.push('| Workload | Active - Inert (ms) |')
    lines.push('|---|---|')
    for (const [workloadId, delta] of Object.entries(summary.activeControlDeltas))
      lines.push(`| ${workloadId} | ${delta.toFixed(3)} |`)
    lines.push('')
  }
  if (summary.baselineComparison) {
    lines.push('## Baseline comparison')
    lines.push('')
    lines.push(`- Status: \`${summary.baselineComparison.status}\``)
    for (const reason of summary.baselineComparison.reasons ?? [])
      lines.push(`- Incompatible: \`${reason}\``)
    if (summary.baselineComparison.status === 'compatible' && summary.baselineComparison.deltas) {
      lines.push('')
      lines.push('| Metric | Delta |')
      lines.push('|---|---|')
      for (const delta of summary.baselineComparison.deltas)
        lines.push(`| ${delta.metricId} | ${delta.delta > 0 ? '+' : ''}${delta.delta.toFixed(3)} |`)
    }
    lines.push('')
  }
  lines.push('## Cost')
  lines.push('')
  lines.push(`- Availability: \`${summary.costAvailability}\``)
  if (summary.costUnavailableReason)
    lines.push(`- Reason: \`${summary.costUnavailableReason}\``)
  if (summary.costEvidence) {
    // Calculated from one observed usage sample and an approved price document;
    // not a billed invoice amount.
    lines.push(`- Calculated amount: \`${summary.costEvidence.amount}\` ${summary.costEvidence.currency}`)
    lines.push(`- Usage sample: \`${summary.costEvidence.liveArtifact.sampleId}\` (digest \`${summary.costEvidence.liveArtifactDigest}\`)`)
    lines.push(`- Price document digest: \`${summary.costEvidence.priceDocumentDigest}\``)
    for (const dimension of summary.costEvidence.dimensions)
      lines.push(`- ${dimension.dimension}: \`${dimension.tokens}\` x \`${dimension.pricePerUnit}\` = \`${dimension.subtotal}\``)
  }
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  for (const limitation of summary.limitations)
    lines.push(`- ${limitation}`)
  lines.push('')
  return lines.join('\n')
}
