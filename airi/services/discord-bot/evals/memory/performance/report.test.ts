import type { MeasurementRecord, RunManifest } from './contracts'

import { describe, expect, it } from 'vitest'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { buildPerformanceReport, recomputeSummary } from './report'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Performance report builder tests for the IMP-803 benchmark.
 *
 * These assert the artifact set is content-free, the disposition is never
 * `G8 passed`, the measurements JSONL is sufficient to recompute the summary,
 * and the redaction scan catches prohibited content.
 */

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
    observationCount: 32,
    retainedSamples: 32,
    sampleCapacity: 256,
    percentileMethod: 'exact-nearest-rank',
    correctnessClean: true,
    thresholdEvaluation: 'not_evaluated',
    ...overrides,
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
    workloadsCompleted: ['text-append'],
    importedLiveArtifactDigests: [],
    limitations: [],
    ...overrides,
  }
}

describe('performance report disposition', () => {
  it('is correctness_clean_measured_not_evaluated when no threshold covers any metric', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [measurement('text-append')],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      costUnavailableReason: 'no-price-document-supplied',
      limitations: [],
    })
    expect(report.summary.disposition).toBe('correctness_clean_measured_not_evaluated')
  })

  it('is failed when a workload has correctness failures', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 2, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    expect(report.summary.disposition).toBe('failed')
  })

  it('is never called G8 passed', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [measurement('text-append', { thresholdEvaluation: 'passed' })],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    expect(report.summary.disposition).not.toMatch(/g8/i)
    expect(report.markdown).not.toMatch(/g8 passed/i)
  })
})

describe('performance report recomputation', () => {
  it('the measurements JSONL is sufficient to recompute the summary metric counts', () => {
    const measurements = [
      measurement('text-append', { thresholdEvaluation: 'passed' }),
      measurement('text-append', { statistic: 'p50', metricId: 'text-append.p50', thresholdEvaluation: 'not_evaluated' }),
      measurement('voice-active-memory', { thresholdEvaluation: 'not_evaluated' }),
    ]
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements,
      workloadResults: [
        { workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 },
        { workloadId: 'voice-active-memory', correctnessFailures: 0, cleanupFailures: 0 },
      ],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    const recomputed = recomputeSummary(report.measurementsJsonl, manifest(), 'bench-1', [])
    expect(recomputed.metricStatusCounts).toEqual(report.summary.metricStatusCounts)
    expect(recomputed.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
  })
})

describe('performance report redaction', () => {
  it('a clean report produces no redaction findings', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [measurement('text-append')],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    expect(report.redactionFindings).toEqual([])
  })

  it('flags a snowflake in the measurements', () => {
    const contaminated = measurement('text-append')
    ;(contaminated as { leaked?: string }).leaked = '123456789012345678'
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [contaminated],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    expect(report.redactionFindings).toContain('discord-snowflake')
  })

  it('flags an absolute path in the summary', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [measurement('text-append')],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: ['/secret/path/leak'],
    })
    expect(report.redactionFindings).toContain('absolute-or-relative-path')
  })
})

describe('performance report artifact shape', () => {
  it('the markdown reports the contract digest and disposition', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [measurement('text-append')],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: { 'text-active-memory': 0.5 },
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    expect(report.markdown).toContain(WORKLOAD_CATALOG_DIGEST)
    expect(report.markdown).toContain('correctness_clean_measured_not_evaluated')
    expect(report.markdown).toContain('text-active-memory')
  })

  it('no serialized artifact carries prompt, transcript, snowflake, or generated text content', () => {
    const report = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      measurements: [measurement('text-append')],
      workloadResults: [{ workloadId: 'text-append', correctnessFailures: 0, cleanupFailures: 0 }],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    const serialized = JSON.stringify(report.summary) + report.measurementsJsonl + report.markdown
    expect(serialized).not.toMatch(/prompt text|transcript content|generated text/i)
  })
})
