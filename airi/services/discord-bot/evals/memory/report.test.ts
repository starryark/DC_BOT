import type { Dataset, ScenarioResult, ThresholdDocument } from './contracts'

import { describe, expect, it } from 'vitest'

import { EVALUATOR_SCHEMA_VERSION, parseThresholdDocument } from './contracts'
import { activeV1Dataset, activeV1Digest } from './dataset'
import { prohibitedContentFindings } from './redaction'
import { buildReport, runIsValidForGate } from './report'

/**
 * Report, threshold, and redaction tests for the G8-1 evaluator (IMP-802, T004).
 *
 * These cover the whole-run-validity rules: a zero-tolerance failure
 * invalidates the run for gate review; a missing scenario result leaves the
 * total short; unsupported/unverified categories stay visible but leave the
 * pass-rate denominator; no threshold document means
 * `measured_not_evaluated`, never `passed`; and the redaction scan catches raw
 * identifiers, canaries, paths, and the redaction key.
 */

const dataset: Dataset = activeV1Dataset()

function makeResult(overrides: Partial<ScenarioResult> & { scenarioId: string }): ScenarioResult & { elapsedMs: number } {
  const spec = dataset.scenarios.find(s => s.scenarioId === overrides.scenarioId)!
  return {
    scenarioId: overrides.scenarioId,
    datasetVersion: dataset.datasetVersion,
    seed: 20260802,
    requirements: spec.assertions.map(a => a.id),
    category: spec.category,
    capabilityDisposition: overrides.capabilityDisposition ?? spec.expectation.capabilityDisposition,
    outcome: overrides.outcome ?? spec.expectation.outcome,
    assertions: overrides.assertions ?? spec.assertions.map(a => ({ assertionId: a.id, passed: true, diagnostic: 'redacted:kind:0000000000000000' })),
    operationCounts: overrides.operationCounts ?? {},
    measurements: overrides.measurements ?? [],
    limitations: overrides.limitations ?? [...(spec.limitations ?? [])],
    cleanup: overrides.cleanup ?? 'clean',
    elapsedMs: 1,
  }
}

function allPassing(): (ScenarioResult & { elapsedMs: number })[] {
  return dataset.scenarios.map(spec => makeResult({ scenarioId: spec.scenarioId }))
}

function build(results: ReturnType<typeof allPassing>, thresholds?: ThresholdDocument) {
  return buildReport({ dataset, datasetDigest: activeV1Digest(), seed: 20260802, commitSha: 'a'.repeat(40), platform: 'test', generatedAt: '2026-08-06T00:00:00Z', results, thresholds })
}

/** A threshold document approved against the running dataset, with one limit. */
function approvedThreshold(limit: { name: string, metric: string, operation: '<=' | '>=' | '<' | '>' | '==', value: number }): ThresholdDocument {
  return parseThresholdDocument(
    {
      format: 1,
      approver: 'owner',
      approvedAt: '2026-08-06T00:00:00Z',
      source: 'eval-thresholds',
      repositoryCommit: 'a'.repeat(40),
      datasetVersion: dataset.datasetVersion,
      datasetDigest: activeV1Digest(),
      evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
      limits: [limit],
    },
    { datasetVersion: dataset.datasetVersion, datasetDigest: activeV1Digest(), evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION },
  )
}

/** DELIV-001 with a single latency measurement; `value` overrides the metric. */
function delivWithMeasurement(value: number, name = 'latency_p95_ms'): (ScenarioResult & { elapsedMs: number })[] {
  const results = allPassing()
  const idx = results.findIndex(r => r.scenarioId === 'DELIV-001')
  results[idx] = makeResult({ scenarioId: 'DELIV-001', measurements: [{ name, value, unit: 'ms', evaluated: false }] })
  return results
}

describe('report whole-run validity', () => {
  it('a clean full run is valid for gate review with no zero-tolerance failures', () => {
    const report = build(allPassing())
    expect(report.summary.zeroToleranceFailures).toEqual([])
    expect(report.summary.cleanupFailures).toBe(0)
    expect(runIsValidForGate(report.summary)).toBe(true)
  })

  it('a zero-tolerance assertion failure invalidates the run', () => {
    const results = allPassing()
    const id001Index = results.findIndex(r => r.scenarioId === 'ID-001')
    results[id001Index] = makeResult({ scenarioId: 'ID-001', assertions: [{ assertionId: 'ID-001-A', passed: false, diagnostic: 'redacted:kind:0000000000000000' }] })
    const report = build(results)
    expect(report.summary.zeroToleranceFailures).toContain('ID-001/ID-001-A')
    expect(runIsValidForGate(report.summary)).toBe(false)
  })

  it('a missing scenario result leaves the summary total short', () => {
    const report = build(allPassing().slice(0, -1))
    expect(report.summary.counts.total).toBe(dataset.scenarios.length - 1)
  })

  it('unsupported and unverified categories stay visible but are excluded from the pass-rate denominator', () => {
    const report = build(allPassing())
    expect(report.summary.unsupportedCategories.length).toBeGreaterThan(0)
    expect(report.summary.unverifiedCategories.length).toBeGreaterThan(0)
    expect(report.summary.applicableTotal).toBeLessThan(report.summary.counts.total)
  })

  it('without a threshold document, measurement status is measured_not_evaluated', () => {
    const results = allPassing()
    const idx = results.findIndex(r => r.scenarioId === 'DELIV-001')
    results[idx] = makeResult({ scenarioId: 'DELIV-001', measurements: [{ name: 'latency_p95_ms', value: 120, unit: 'ms', evaluated: false }] })
    const report = build(results)
    expect(report.summary.measurementStatus).toBe('measured_not_evaluated')
    expect(report.summary.approval.thresholdsApproved).toBe(false)
    expect(report.summary.approval.signedDecision).toBe(false)
  })
})

describe('report measurement evaluation gate', () => {
  it('with no measurements and no threshold document, all counts are zero and the run stays valid', () => {
    const report = build(allPassing())
    expect(report.summary.measurementEvaluations).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      measuredNotEvaluated: 0,
      failedMetricIds: [],
    })
    expect(runIsValidForGate(report.summary)).toBe(true)
  })

  it('with measurements but no threshold document, every measurement is measured_not_evaluated and the run stays valid', () => {
    const report = build(delivWithMeasurement(120))
    expect(report.summary.measurementEvaluations.total).toBe(1)
    expect(report.summary.measurementEvaluations.measuredNotEvaluated).toBe(1)
    expect(report.summary.measurementEvaluations.failed).toBe(0)
    expect(report.summary.measurementEvaluations.failedMetricIds).toEqual([])
    // Missing approval is a limitation, not a software failure (T004).
    expect(runIsValidForGate(report.summary)).toBe(true)
  })

  it('an approved threshold that the measurement satisfies is counted as passed and keeps the run valid', () => {
    const thresholds = approvedThreshold({ name: 'latency_p95', metric: 'latency_p95_ms', operation: '<=', value: 200 })
    const report = build(delivWithMeasurement(120), thresholds)
    expect(report.summary.measurementEvaluations).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      measuredNotEvaluated: 0,
      failedMetricIds: [],
    })
    expect(report.summary.measurementStatus).toBe('evaluated')
    expect(runIsValidForGate(report.summary)).toBe(true)
  })

  // ROOT CAUSE:
  //
  // Before this change, a failed approved measurement did not block the
  // functional evaluator: runIsValidForGate only checked zero-tolerance and
  // cleanup failures, so an approved latency limit that was breached still
  // produced a gate-valid run. That conflated "software did not crash" with
  // "the approved threshold was met".
  //
  // We fixed this by deriving a failed count from evaluateMeasurements and
  // adding `measurementEvaluations.failed === 0` to runIsValidForGate. Missing
  // approval (measured_not_evaluated) is intentionally not a failure.
  it('an approved threshold that the measurement breaches fails the gate', () => {
    const thresholds = approvedThreshold({ name: 'latency_p95', metric: 'latency_p95_ms', operation: '<=', value: 100 })
    const report = build(delivWithMeasurement(120), thresholds)
    expect(report.summary.measurementEvaluations.failed).toBe(1)
    expect(report.summary.measurementEvaluations.failedMetricIds).toEqual(['latency_p95_ms'])
    expect(runIsValidForGate(report.summary)).toBe(false)
  })

  it('partial threshold coverage with no failure leaves unmatched measurements measured_not_evaluated', () => {
    const results = allPassing()
    // Two measurements on DELIV-001; only the first has an approved limit.
    const idx = results.findIndex(r => r.scenarioId === 'DELIV-001')
    results[idx] = makeResult({
      scenarioId: 'DELIV-001',
      measurements: [
        { name: 'latency_p95_ms', value: 120, unit: 'ms', evaluated: false },
        { name: 'latency_p99_ms', value: 200, unit: 'ms', evaluated: false },
      ],
    })
    const thresholds = approvedThreshold({ name: 'latency_p95', metric: 'latency_p95_ms', operation: '<=', value: 200 })
    const report = build(results, thresholds)
    expect(report.summary.measurementEvaluations.passed).toBe(1)
    expect(report.summary.measurementEvaluations.measuredNotEvaluated).toBe(1)
    expect(report.summary.measurementEvaluations.failed).toBe(0)
    expect(runIsValidForGate(report.summary)).toBe(true)
  })

  it('partial threshold coverage with one failure fails the gate and reports only the failed metric id', () => {
    const results = allPassing()
    const idx = results.findIndex(r => r.scenarioId === 'DELIV-001')
    results[idx] = makeResult({
      scenarioId: 'DELIV-001',
      measurements: [
        { name: 'latency_p95_ms', value: 120, unit: 'ms', evaluated: false },
        { name: 'latency_p99_ms', value: 200, unit: 'ms', evaluated: false },
      ],
    })
    const thresholds = approvedThreshold({ name: 'latency_p95', metric: 'latency_p95_ms', operation: '<=', value: 100 })
    const report = build(results, thresholds)
    expect(report.summary.measurementEvaluations.passed).toBe(0)
    expect(report.summary.measurementEvaluations.failed).toBe(1)
    expect(report.summary.measurementEvaluations.measuredNotEvaluated).toBe(1)
    expect(report.summary.measurementEvaluations.failedMetricIds).toEqual(['latency_p95_ms'])
    expect(runIsValidForGate(report.summary)).toBe(false)
  })

  it('a threshold document whose limits match no metric makes no approval claim', () => {
    const thresholds = approvedThreshold({ name: 'unrelated', metric: 'does_not_exist_ms', operation: '<=', value: 100 })
    const report = build(delivWithMeasurement(120), thresholds)
    // The measurement is still measured_not_evaluated because no limit matched it.
    expect(report.summary.measurementEvaluations.measuredNotEvaluated).toBe(1)
    expect(report.summary.measurementEvaluations.passed).toBe(0)
    expect(report.summary.measurementEvaluations.failed).toBe(0)
    expect(report.summary.measurementStatus).toBe('measured_not_evaluated')
    expect(runIsValidForGate(report.summary)).toBe(true)
  })

  it('a zero-tolerance assertion failure plus a threshold failure both invalidate the run', () => {
    const results = delivWithMeasurement(120)
    const id001Index = results.findIndex(r => r.scenarioId === 'ID-001')
    results[id001Index] = makeResult({ scenarioId: 'ID-001', assertions: [{ assertionId: 'ID-001-A', passed: false, diagnostic: 'redacted:kind:0000000000000000' }] })
    const thresholds = approvedThreshold({ name: 'latency_p95', metric: 'latency_p95_ms', operation: '<=', value: 100 })
    const report = build(results, thresholds)
    expect(report.summary.zeroToleranceFailures).toContain('ID-001/ID-001-A')
    expect(report.summary.measurementEvaluations.failed).toBe(1)
    expect(runIsValidForGate(report.summary)).toBe(false)
  })

  it('the normalized result digest is unchanged when only a measurement value changes', () => {
    // The digest excludes measurements (volatile timing), so a different value
    // must not change the byte-identical artifact identity.
    const a = build(delivWithMeasurement(120))
    const b = build(delivWithMeasurement(999))
    expect(a.summary.normalizedResultDigest).toBe(b.summary.normalizedResultDigest)
  })

  it('failed metric ids are sorted and carry no measurement value', () => {
    const results = allPassing()
    const idx = results.findIndex(r => r.scenarioId === 'DELIV-001')
    // Insert in non-sorted order to prove the summary sorts them.
    results[idx] = makeResult({
      scenarioId: 'DELIV-001',
      measurements: [
        { name: 'zzz_last_ms', value: 5, unit: 'ms', evaluated: false },
        { name: 'aaa_first_ms', value: 5, unit: 'ms', evaluated: false },
        { name: 'mmm_middle_ms', value: 5, unit: 'ms', evaluated: false },
      ],
    })
    const thresholds: ThresholdDocument = approvedThreshold({ name: 'n/a', metric: 'n/a', operation: '<=', value: 0 })
    // Replace the single placeholder limit with three failing limits in a
    // deliberately unsorted order.
    const unsorted: ThresholdDocument = {
      ...thresholds,
      limits: [
        { name: 'zzz', metric: 'zzz_last_ms', operation: '<=', value: 1 },
        { name: 'aaa', metric: 'aaa_first_ms', operation: '<=', value: 1 },
        { name: 'mmm', metric: 'mmm_middle_ms', operation: '<=', value: 1 },
      ],
    }
    const report = build(results, unsorted)
    expect(report.summary.measurementEvaluations.failedMetricIds).toEqual([
      'aaa_first_ms',
      'mmm_middle_ms',
      'zzz_last_ms',
    ])
    // The serialized summary must not echo any of the numeric values back.
    const serialized = JSON.stringify(report.summary.measurementEvaluations)
    expect(serialized).not.toContain('value')
  })
})

describe('report threshold provenance', () => {
  it('accepts a threshold document whose provenance matches', () => {
    const doc = parseThresholdDocument(validThresholdObject(), { datasetVersion: dataset.datasetVersion, datasetDigest: activeV1Digest(), evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION })
    expect(doc.limits).toHaveLength(1)
  })

  it('rejects a threshold document whose dataset digest mismatches', () => {
    expect(() => parseThresholdDocument(validThresholdObject(), { datasetVersion: dataset.datasetVersion, datasetDigest: '0'.repeat(64), evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION })).toThrow(/provenance does not match/)
  })

  it('rejects a threshold document whose evaluator schema version mismatches', () => {
    expect(() => parseThresholdDocument(validThresholdObject(), { datasetVersion: dataset.datasetVersion, datasetDigest: activeV1Digest(), evaluatorSchemaVersion: 999 })).toThrow(/provenance does not match/)
  })
})

describe('report redaction scan', () => {
  it('flags a summary carrying a raw discord snowflake', () => {
    const report = build(allPassing())
    const contaminated = { ...report.summary, leak: '123456789012345678' }
    expect(prohibitedContentFindings(JSON.stringify(contaminated))).toContain('discord-snowflake')
  })

  it('flags a summary carrying the redaction key by field name', () => {
    const report = build(allPassing())
    expect(prohibitedContentFindings(JSON.stringify({ ...report.summary, redactionKey: 'a'.repeat(64) }))).toContain('redaction-key-field')
  })

  it('flags a summary carrying a raw durable identifier', () => {
    const report = build(allPassing())
    expect(prohibitedContentFindings(JSON.stringify({ ...report.summary, path: 'discord:guild:abc:def:ghi' }))).toContain('raw-durable-identifier')
  })

  it('a clean report produces no redaction findings', () => {
    const report = build(allPassing())
    expect(report.redactionFindings).toEqual([])
  })
})

function validThresholdObject(): unknown {
  return {
    format: 1,
    approver: 'owner',
    approvedAt: '2026-08-06T00:00:00Z',
    source: 'eval-thresholds',
    repositoryCommit: 'a'.repeat(40),
    datasetVersion: dataset.datasetVersion,
    datasetDigest: activeV1Digest(),
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    limits: [{ name: 'latency_p95', metric: 'latency_p95_ms', operation: '<=', value: 200 }],
  }
}
