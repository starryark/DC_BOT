import type { MeasurementRecord, RunManifest } from './contracts'

import { sha256Canonical } from '../contracts'
import { prohibitedContentFindings } from '../redaction'
import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Report assembly for the IMP-803 deterministic performance benchmark.
 *
 * Produces a content-free artifact set: a run manifest, a measurements JSONL
 * that is sufficient to recompute every summary percentile/count, a summary,
 * and a Markdown report. Every artifact is scanned for prohibited content
 * before publication; any finding leaves no final artifact set.
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

/** The whole-run summary written to `summary.json`. */
export interface PerformanceSummary {
  readonly schemaVersion: typeof PERFORMANCE_SCHEMA_VERSION
  readonly contractId: typeof PERFORMANCE_CONTRACT_ID
  readonly contractDigest: string
  readonly runId: string
  readonly disposition: RunDisposition
  readonly workloadCounts: { readonly completed: number, readonly failed: number, readonly skipped: number }
  readonly correctnessFailures: number
  readonly cleanupFailures: number
  readonly redactionFindings: readonly string[]
  readonly metricStatusCounts: { readonly passed: number, readonly failed: number, readonly measuredNotEvaluated: number }
  readonly approvedThresholdFailures: number
  readonly activeControlDeltas: Readonly<Record<string, number>>
  readonly baselineComparison?: { readonly status: string, readonly deltas?: ReadonlyArray<{ readonly metricId: string, readonly delta: number, readonly unit: string, readonly statistic: string }> }
  readonly environmentFingerprint: { readonly nodeVersion: string, readonly platform: string, readonly architecture: string }
  readonly importedLiveArtifactDigests: readonly string[]
  readonly costAvailability: 'available' | 'unavailable'
  readonly costUnavailableReason?: string
  readonly limitations: readonly string[]
}

/** Inputs to the performance report builder. */
export interface PerformanceReportInputs {
  readonly runId: string
  readonly manifest: RunManifest
  readonly measurements: readonly MeasurementRecord[]
  readonly workloadResults: ReadonlyArray<{ readonly workloadId: string, readonly correctnessFailures: number, readonly cleanupFailures: number }>
  readonly skippedWorkloadIds: readonly string[]
  readonly activeControlDeltas: Readonly<Record<string, number>>
  readonly baselineComparison?: { readonly status: string, readonly deltas?: ReadonlyArray<{ readonly metricId: string, readonly delta: number, readonly unit: string, readonly statistic: string }> }
  readonly importedLiveArtifactDigests: readonly string[]
  readonly costAvailability: 'available' | 'unavailable'
  readonly costUnavailableReason?: string
  readonly limitations: readonly string[]
}

/** The built performance report artifacts. */
export interface BuiltPerformanceReport {
  readonly summary: PerformanceSummary
  readonly measurementsJsonl: string
  readonly markdown: string
  readonly redactionFindings: readonly string[]
}

/**
 * Assemble every performance report artifact from run results.
 *
 * The summary counts are derived from the measurements and workload results;
 * the measurements JSONL is sufficient to recompute every percentile/count.
 * The redaction scan runs over every artifact; any finding is surfaced so the
 * CLI turns it into exit code 4 and leaves no final artifact set.
 */
export function buildPerformanceReport(inputs: PerformanceReportInputs): BuiltPerformanceReport {
  const { manifest, measurements, workloadResults, skippedWorkloadIds } = inputs
  const completed = workloadResults.length
  const failed = workloadResults.reduce((sum, result) => sum + (result.correctnessFailures > 0 ? 1 : 0), 0)
  const skipped = skippedWorkloadIds.length
  const correctnessFailures = workloadResults.reduce((sum, result) => sum + result.correctnessFailures, 0)
  const cleanupFailures = workloadResults.reduce((sum, result) => sum + result.cleanupFailures, 0)

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

  const hasFailures = failed > 0 || correctnessFailures > 0 || cleanupFailures > 0
  const disposition: RunDisposition = (hasFailures || metricStatusCounts.failed > 0)
    ? 'failed'
    : metricStatusCounts.passed > 0
      ? 'correctness_clean_thresholds_passed'
      : 'correctness_clean_measured_not_evaluated'

  const summary: PerformanceSummary = {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    runId: inputs.runId,
    disposition,
    workloadCounts: { completed, failed, skipped },
    correctnessFailures,
    cleanupFailures,
    redactionFindings: [],
    metricStatusCounts,
    approvedThresholdFailures,
    activeControlDeltas: { ...inputs.activeControlDeltas },
    ...(inputs.baselineComparison ? { baselineComparison: { status: inputs.baselineComparison.status, ...(inputs.baselineComparison.deltas ? { deltas: [...inputs.baselineComparison.deltas] } : {}) } } : {}),
    environmentFingerprint: { nodeVersion: manifest.environment.nodeVersion, platform: manifest.environment.platform, architecture: manifest.environment.architecture },
    importedLiveArtifactDigests: [...inputs.importedLiveArtifactDigests],
    costAvailability: inputs.costAvailability,
    ...(inputs.costUnavailableReason != null ? { costUnavailableReason: inputs.costUnavailableReason } : {}),
    limitations: [...inputs.limitations],
  }

  const measurementsJsonl = measurements.map(record => JSON.stringify(record)).join('\n').concat('\n')
  const markdown = renderMarkdown(summary, manifest)
  const redactionFindings = scanAllArtifacts(summary, measurementsJsonl, markdown)

  return { summary: { ...summary, redactionFindings }, measurementsJsonl, markdown, redactionFindings }
}

/**
 * Recompute a summary from a measurements JSONL and a manifest.
 *
 * The report builder must be able to reproduce `summary.json` from the JSONL
 * alone (plus the manifest for environment/disposition context). This is the
 * recomputation test target.
 */
export function recomputeSummary(measurementsJsonl: string, _manifest: RunManifest, _runId: string, _limitations: readonly string[]): { metricStatusCounts: { passed: number, failed: number, measuredNotEvaluated: number }, contractDigest: string, recomputeDigest: string } {
  const records: MeasurementRecord[] = []
  for (const line of measurementsJsonl.split('\n').filter(line => line.length > 0))
    records.push(JSON.parse(line) as MeasurementRecord)
  const metricStatusCounts = { passed: 0, failed: 0, measuredNotEvaluated: 0 }
  for (const record of records) {
    if (record.thresholdEvaluation === 'passed')
      metricStatusCounts.passed += 1
    else if (record.thresholdEvaluation === 'failed')
      metricStatusCounts.failed += 1
    else
      metricStatusCounts.measuredNotEvaluated += 1
  }
  return {
    metricStatusCounts,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    recomputeDigest: sha256Canonical({ records: records.map(record => record.metricId), metricStatusCounts }),
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
function scanAllArtifacts(summary: PerformanceSummary, measurementsJsonl: string, markdown: string): readonly string[] {
  const findings = new Set<string>()
  const snowflakePattern = /(?<![\d.])\d{17,20}(?!\d)/
  const artifacts: ReadonlyArray<[string, string]> = [
    ['summary', JSON.stringify(summary)],
    ['measurements', measurementsJsonl],
    ['markdown', markdown],
  ]
  for (const [, artifact] of artifacts) {
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
  }
  if (/(?:^|\n)[-: ]\s*(?:\/\S+|[A-Z]:\\\S+)/i.test(markdown))
    findings.add('absolute-or-relative-path')
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
  lines.push(`- Correctness failures: \`${summary.correctnessFailures}\``)
  lines.push(`- Cleanup failures: \`${summary.cleanupFailures}\``)
  lines.push('')
  lines.push('## Measurement evaluation')
  lines.push('')
  lines.push(`- Passed: \`${summary.metricStatusCounts.passed}\``)
  lines.push(`- Failed: \`${summary.metricStatusCounts.failed}\``)
  lines.push(`- Measured-not-evaluated: \`${summary.metricStatusCounts.measuredNotEvaluated}\``)
  lines.push(`- Approved threshold failures: \`${summary.approvedThresholdFailures}\``)
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
  if (summary.baselineComparison && summary.baselineComparison.status === 'compatible' && summary.baselineComparison.deltas) {
    lines.push('## Baseline comparison deltas')
    lines.push('')
    lines.push('| Metric | Delta |')
    lines.push('|---|---|')
    for (const delta of summary.baselineComparison.deltas) {
      lines.push(`| ${delta.metricId} | ${delta.delta > 0 ? '+' : ''}${delta.delta.toFixed(3)} |`)
    }
    lines.push('')
  }
  lines.push('## Cost')
  lines.push('')
  lines.push(`- Availability: \`${summary.costAvailability}\``)
  if (summary.costUnavailableReason)
    lines.push(`- Reason: \`${summary.costUnavailableReason}\``)
  lines.push('')
  lines.push('## Limitations')
  lines.push('')
  for (const limitation of summary.limitations)
    lines.push(`- ${limitation}`)
  lines.push('')
  return lines.join('\n')
}
