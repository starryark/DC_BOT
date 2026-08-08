import type { MeasurementRecord, RunManifest } from './contracts'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'

import { describe, expect, it } from 'vitest'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { buildPerformanceReport, recomputeSummary } from './report'
import { cleanupFinding } from './run-findings'
import { workloadCorrectnessClean } from './sample-results'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Performance report builder tests for the IMP-803 benchmark.
 *
 * These assert the artifact set is content-free, the disposition is never
 * `G8 passed`, the published rows are sufficient to independently recompute the
 * whole-run correctness state, and the redaction scan catches prohibited
 * content.
 */

const WORKLOAD_ID = 'text-append'

function measurement(workloadId: string, overrides: Partial<MeasurementRecord> = {}): MeasurementRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId,
    metricId: `${workloadId}.p95`,
    role: 'active',
    unit: 'milliseconds',
    statistic: 'p95',
    outcome: { disposition: 'observed', value: 12.5 },
    observationCount: 3,
    retainedSamples: 3,
    sampleCapacity: 256,
    percentileMethod: 'exact-nearest-rank',
    correctnessClean: true,
    thresholdEvaluation: 'not_evaluated',
    ...overrides,
  }
}

function passedAttempt(workloadId: string, ordinal: number): SampleAttemptRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId,
    ordinal,
    outcome: 'passed',
    durationMs: 1.25,
  }
}

function failedAttempt(workloadId: string, ordinal: number, failedPostconditionIds: readonly string[]): SampleAttemptRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId,
    ordinal,
    outcome: 'failed',
    failedPostconditionIds: [...failedPostconditionIds],
  }
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    commitSha: 'a'.repeat(40),
    dirtyWorktree: false,
    suite: 'smoke',
    seed: 20260802,
    environment: { nodeVersion: 'v24.0.0', pnpmVersion: '10.33.0', platform: 'linux', architecture: 'x64', cpuModel: 'synthetic', cpuCount: 8, totalMemoryBytes: 1, sqliteVersion: '3.51.2' },
    configuration: [],
    timerSource: 'performance.now',
    startedAt: '2026-08-06T00:00:00Z',
    completedAt: '2026-08-06T00:01:00Z',
    workloadPlan: [{ workloadId: WORKLOAD_ID, warmupCount: 0, sampleCount: 3, sampleCapacity: 256 }],
    workloadsCompleted: [WORKLOAD_ID],
    importedLiveArtifactDigests: [],
    limitations: [],
    ...overrides,
  }
}

/** A clean three-attempt run over one workload. */
function cleanReport(overrides: {
  attempts?: readonly SampleAttemptRecord[]
  runFindings?: readonly RunFindingRecord[]
  measurements?: readonly MeasurementRecord[]
  manifest?: RunManifest
  limitations?: readonly string[]
} = {}) {
  return buildPerformanceReport({
    runId: 'bench-1',
    manifest: overrides.manifest ?? manifest(),
    attempts: overrides.attempts ?? [passedAttempt(WORKLOAD_ID, 0), passedAttempt(WORKLOAD_ID, 1), passedAttempt(WORKLOAD_ID, 2)],
    runFindings: overrides.runFindings ?? [],
    measurements: overrides.measurements ?? [measurement(WORKLOAD_ID)],
    skippedWorkloadIds: [],
    activeControlDeltas: {},
    importedLiveArtifactDigests: [],
    costAvailability: 'unavailable',
    costUnavailableReason: 'no-price-document-supplied',
    limitations: overrides.limitations ?? [],
  })
}

describe('performance report disposition', () => {
  it('is correctness_clean_measured_not_evaluated when no threshold covers any metric', () => {
    expect(cleanReport().summary.disposition).toBe('correctness_clean_measured_not_evaluated')
  })

  it('one failed measured attempt keeps the full denominator and fails the run', () => {
    // ROOT CAUSE:
    //
    // v1 dropped a failed sample with `continue`, recorded no attempt row, and
    // published `correctnessClean: true` from a hardcoded literal. A run where
    // a third of the samples failed was indistinguishable from a clean one.
    //
    // v2 records every configured ordinal exactly once, so the attempted count
    // stays at the configured denominator while the failed attempt contributes
    // no latency observation.
    const attempts = [passedAttempt(WORKLOAD_ID, 0), passedAttempt(WORKLOAD_ID, 1), failedAttempt(WORKLOAD_ID, 2, ['append-returned-event-id'])]
    const report = cleanReport({
      attempts,
      measurements: [measurement(WORKLOAD_ID, { observationCount: 2, retainedSamples: 2, correctnessClean: false })],
    })
    expect(report.summary.sampleCounts.attempted).toBe(3)
    expect(report.summary.sampleCounts.passed).toBe(2)
    expect(report.summary.sampleCounts.failed).toBe(1)
    expect(report.summary.correctnessFailures).toBe(1)
    expect(report.summary.failedPostconditions).toBe(1)
    expect(report.summary.workloadCounts.failed).toBe(1)
    expect(report.summary.disposition).toBe('failed')
    // The latency denominator is the passing attempts, not the attempted count.
    expect(report.summary.measurementDenominatorsConsistent).toBe(true)
    expect(workloadCorrectnessClean(attempts, WORKLOAD_ID, 3, 0)).toBe(false)
  })

  it('an incomplete sample set fails the run even when every recorded attempt passed', () => {
    const report = cleanReport({
      attempts: [passedAttempt(WORKLOAD_ID, 0), passedAttempt(WORKLOAD_ID, 1)],
      measurements: [measurement(WORKLOAD_ID, { observationCount: 2, retainedSamples: 2 })],
    })
    expect(report.summary.sampleCompleteness).toBe('incomplete')
    expect(report.summary.sampleValidationFailureCount).toBeGreaterThan(0)
    expect(report.summary.disposition).toBe('failed')
  })

  it('a measurement denominator that disagrees with the passed attempts fails the run', () => {
    const report = cleanReport({
      measurements: [measurement(WORKLOAD_ID, { observationCount: 5 })],
    })
    expect(report.summary.measurementDenominatorsConsistent).toBe(false)
    expect(report.summary.disposition).toBe('failed')
  })

  it('a cleanup failure is published as a row and fails the run', () => {
    // v1 let a cleanup failure force `failed` while publishing nothing a
    // verifier could recompute that disposition from.
    const report = cleanReport({
      runFindings: [cleanupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 'runtime-close-failed')],
    })
    expect(report.summary.cleanupFailures).toBe(1)
    expect(report.summary.disposition).toBe('failed')
    expect(report.runFindingsJsonl).toContain('runtime-close-failed')
  })

  it('is never called G8 passed', () => {
    const report = cleanReport({ measurements: [measurement(WORKLOAD_ID, { thresholdEvaluation: 'passed' })] })
    expect(report.summary.disposition).not.toMatch(/g8/i)
    expect(report.markdown).not.toMatch(/g8 passed/i)
  })

  it('every measured attempt failing still emits metrics with a zero denominator', () => {
    const report = cleanReport({
      attempts: [0, 1, 2].map(ordinal => failedAttempt(WORKLOAD_ID, ordinal, ['append-returned-event-id'])),
      measurements: [measurement(WORKLOAD_ID, {
        observationCount: 0,
        retainedSamples: 0,
        correctnessClean: false,
        outcome: { disposition: 'unavailable', reason: 'no observations recorded' },
      })],
    })
    expect(report.summary.sampleCounts.attempted).toBe(3)
    expect(report.summary.sampleCounts.passed).toBe(0)
    expect(report.summary.measurementDenominatorsConsistent).toBe(true)
    expect(report.summary.disposition).toBe('failed')
  })
})

describe('performance report recomputation', () => {
  it('the published artifact set alone reconstructs the whole-run correctness state', () => {
    const built = cleanReport({
      attempts: [passedAttempt(WORKLOAD_ID, 0), passedAttempt(WORKLOAD_ID, 1), failedAttempt(WORKLOAD_ID, 2, ['append-returned-event-id'])],
      runFindings: [cleanupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 'runtime-close-failed')],
      measurements: [measurement(WORKLOAD_ID, { observationCount: 2, retainedSamples: 2, correctnessClean: false })],
    })
    const recomputed = recomputeSummary({
      runManifestJson: JSON.stringify(manifest()),
      attemptsJsonl: built.attemptsJsonl,
      runFindingsJsonl: built.runFindingsJsonl,
      measurementsJsonl: built.measurementsJsonl,
    })

    expect(recomputed.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
    expect(recomputed.workloadCounts).toEqual(built.summary.workloadCounts)
    expect(recomputed.sampleCounts).toEqual(built.summary.sampleCounts)
    expect(recomputed.correctnessFailures).toBe(built.summary.correctnessFailures)
    expect(recomputed.failedPostconditions).toBe(built.summary.failedPostconditions)
    expect(recomputed.cleanupFailures).toBe(built.summary.cleanupFailures)
    expect(recomputed.sampleCompleteness).toBe(built.summary.sampleCompleteness)
    expect(recomputed.measurementDenominatorsConsistent).toBe(built.summary.measurementDenominatorsConsistent)
    expect(recomputed.metricStatusCounts).toEqual(built.summary.metricStatusCounts)
    expect(recomputed.approvedThresholdFailures).toBe(built.summary.approvedThresholdFailures)
    expect(recomputed.disposition).toBe(built.summary.disposition)
  })

  it('a clean run recomputes to the same clean disposition', () => {
    const built = cleanReport()
    const recomputed = recomputeSummary({
      runManifestJson: JSON.stringify(manifest()),
      attemptsJsonl: built.attemptsJsonl,
      runFindingsJsonl: built.runFindingsJsonl,
      measurementsJsonl: built.measurementsJsonl,
    })
    expect(recomputed.disposition).toBe('correctness_clean_measured_not_evaluated')
    expect(recomputed.sampleCounts).toEqual({ attempted: 3, passed: 3, failed: 0 })
  })

  it('rejects a hand-edited attempt row rather than recomputing from it', () => {
    // Recomputation reparses through the strict schemas; a failed row carrying a
    // duration would otherwise be summed into a latency denominator.
    const tampered = `${JSON.stringify({ ...failedAttempt(WORKLOAD_ID, 0, ['append-returned-event-id']), durationMs: 1 })}\n`
    expect(() => recomputeSummary({
      runManifestJson: JSON.stringify(manifest()),
      attemptsJsonl: tampered,
      runFindingsJsonl: '',
      measurementsJsonl: '',
    })).toThrow()
  })

  it('rejects a manifest missing the effective workload plan', () => {
    const withoutPlan = { ...manifest() } as Record<string, unknown>
    delete withoutPlan.workloadPlan
    expect(() => recomputeSummary({
      runManifestJson: JSON.stringify(withoutPlan),
      attemptsJsonl: '',
      runFindingsJsonl: '',
      measurementsJsonl: '',
    })).toThrow()
  })
})

describe('performance report redaction', () => {
  it('a clean report produces no redaction findings', () => {
    expect(cleanReport().redactionFindings).toEqual([])
  })

  it('flags a snowflake in the measurements', () => {
    const contaminated = measurement(WORKLOAD_ID)
    ;(contaminated as { leaked?: string }).leaked = '123456789012345678'
    expect(cleanReport({ measurements: [contaminated] }).redactionFindings).toContain('discord-snowflake')
  })

  it('flags an absolute path in the summary', () => {
    expect(cleanReport({ limitations: ['/secret/path/leak'] }).redactionFindings).toContain('absolute-or-relative-path')
  })
})

describe('performance report artifact shape', () => {
  it('the markdown reports the contract digest, disposition, and effective plan', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      attempts: [passedAttempt(WORKLOAD_ID, 0), passedAttempt(WORKLOAD_ID, 1), passedAttempt(WORKLOAD_ID, 2)],
      runFindings: [],
      measurements: [measurement(WORKLOAD_ID)],
      skippedWorkloadIds: [],
      activeControlDeltas: { 'text-active-memory': 0.5 },
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    expect(report.markdown).toContain(WORKLOAD_CATALOG_DIGEST)
    expect(report.markdown).toContain('correctness_clean_measured_not_evaluated')
    expect(report.markdown).toContain('text-active-memory')
    expect(report.markdown).toContain('## Workload plan')
  })

  it('emits one attempt row per measured ordinal', () => {
    const report = cleanReport()
    expect(report.attemptsJsonl.trim().split('\n')).toHaveLength(3)
  })

  it('no serialized artifact carries prompt, transcript, snowflake, or generated text content', () => {
    const report = cleanReport()
    const serialized = JSON.stringify(report.summary) + report.attemptsJsonl + report.runFindingsJsonl + report.measurementsJsonl + report.markdown
    expect(serialized).not.toMatch(/prompt text|transcript content|generated text/i)
  })
})
