import type { Dataset, ScenarioResult } from './contracts'

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

function build(results: ReturnType<typeof allPassing>) {
  return buildReport({ dataset, datasetDigest: activeV1Digest(), seed: 20260802, commitSha: 'a'.repeat(40), platform: 'test', generatedAt: '2026-08-06T00:00:00Z', results })
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
