import { describe, expect, it } from 'vitest'

import type { MeasurementRecord, WorkloadSpec } from './contracts'
import {
  applyPerformanceThresholds,
  parsePerformanceThresholdDocument,
  performanceThresholdDocumentDigest,
  validatePerformanceThresholdCompatibility,
} from './threshold-contract'

describe('threshold-contract', () => {
  const validDocument = {
    format: 'performance-thresholds',
    schemaVersion: 2,
    contractId: 'performance-v2',
    contractDigest: '0000000000000000000000000000000000000000000000000000000000000000',
    source: 'test',
    approver: 'test-approver',
    approvedAt: '2026-08-01T00:00:00Z',
    provenance: 'test-provenance',
    thresholds: [
      {
        workloadId: 'test-workload',
        metricId: 'test-metric',
        statistic: 'p95',
        unit: 'milliseconds',
        comparator: 'lte',
        bound: 100,
      },
      {
        workloadId: 'test-workload',
        metricId: 'test-metric-gte',
        statistic: 'p95',
        unit: 'milliseconds',
        comparator: 'gte',
        bound: 10,
      },
    ],
  }

  const workloads: WorkloadSpec[] = [
    {
      workloadId: 'test-workload',
      runner: 'runtime',
      operation: 'test',
      role: 'active',
      driverCase: 'runtime-operation',
      triggerStage: null,
      suites: ['performance-v2'],
      warmupCount: 1,
      sampleCount: 1,
      sampleCapacity: 1,
      roomCount: 1,
      payloadSizeClass: 'small',
      timeoutMs: 1000,
      postconditions: ['test'],
    },
  ]

  const baseMeasurement: MeasurementRecord = {
    schemaVersion: 2,
    contractId: 'performance-v2',
    contractDigest: '0000000000000000000000000000000000000000000000000000000000000000',
    workloadId: 'test-workload',
    metricId: 'test-metric',
    role: 'active',
    unit: 'milliseconds',
    statistic: 'p95',
    outcome: { disposition: 'observed', value: 50 },
    observationCount: 1,
    retainedSamples: 1,
    sampleCapacity: 1,
    percentileMethod: 'exact-nearest-rank',
    correctnessClean: true,
    thresholdEvaluation: 'not_evaluated',
  }

  it('parses a valid document and generates a stable digest', () => {
    const parsed = parsePerformanceThresholdDocument(validDocument)
    expect(parsed.contractId).toBe('performance-v2')
    const digest = performanceThresholdDocumentDigest(parsed)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects unknown fields', () => {
    expect(() => parsePerformanceThresholdDocument({ ...validDocument, unknownField: true })).toThrow()
  })

  it('validates compatibility with known workloads', () => {
    const parsed = parsePerformanceThresholdDocument(validDocument)
    const failures = validatePerformanceThresholdCompatibility(parsed, validDocument.contractDigest, workloads)
    expect(failures).toHaveLength(0)
  })

  it('rejects wrong contract digest', () => {
    const parsed = parsePerformanceThresholdDocument(validDocument)
    const failures = validatePerformanceThresholdCompatibility(parsed, '1111111111111111111111111111111111111111111111111111111111111111', workloads)
    expect(failures).toContainEqual(expect.stringContaining('contract digest'))
  })

  it('rejects duplicate entries', () => {
    const document = {
      ...validDocument,
      thresholds: [validDocument.thresholds[0], validDocument.thresholds[0]],
    }
    const parsed = parsePerformanceThresholdDocument(document)
    const failures = validatePerformanceThresholdCompatibility(parsed, validDocument.contractDigest, workloads)
    expect(failures).toContainEqual(expect.stringContaining('duplicate threshold identity'))
  })

  it('rejects unknown workload', () => {
    const document = {
      ...validDocument,
      thresholds: [{ ...validDocument.thresholds[0], workloadId: 'unknown-workload' }],
    }
    const parsed = parsePerformanceThresholdDocument(document)
    const failures = validatePerformanceThresholdCompatibility(parsed, validDocument.contractDigest, workloads)
    expect(failures).toContainEqual(expect.stringContaining('unknown workload'))
  })

  it('applies thresholds (lte pass/fail)', () => {
    const parsed = parsePerformanceThresholdDocument(validDocument)
    const passed = applyPerformanceThresholds([{ ...baseMeasurement, outcome: { disposition: 'observed', value: 50 } }], parsed)
    expect(passed[0].thresholdEvaluation).toBe('passed')

    const failed = applyPerformanceThresholds([{ ...baseMeasurement, outcome: { disposition: 'observed', value: 150 } }], parsed)
    expect(failed[0].thresholdEvaluation).toBe('failed')
  })

  it('applies thresholds (gte pass/fail)', () => {
    const parsed = parsePerformanceThresholdDocument(validDocument)
    const gteMeasurement = { ...baseMeasurement, metricId: 'test-metric-gte' }
    
    const passed = applyPerformanceThresholds([{ ...gteMeasurement, outcome: { disposition: 'observed', value: 50 } }], parsed)
    expect(passed[0].thresholdEvaluation).toBe('passed')

    const failed = applyPerformanceThresholds([{ ...gteMeasurement, outcome: { disposition: 'observed', value: 5 } }], parsed)
    expect(failed[0].thresholdEvaluation).toBe('failed')
  })

  it('leaves uncovered metrics as not_evaluated', () => {
    const parsed = parsePerformanceThresholdDocument(validDocument)
    const uncovered = applyPerformanceThresholds([{ ...baseMeasurement, metricId: 'uncovered-metric' }], parsed)
    expect(uncovered[0].thresholdEvaluation).toBe('not_evaluated')
  })

  it('leaves unavailable measurements as not_evaluated', () => {
    const parsed = parsePerformanceThresholdDocument(validDocument)
    const unavailable = applyPerformanceThresholds([{ ...baseMeasurement, outcome: { disposition: 'unavailable', reason: 'test' } }], parsed)
    expect(unavailable[0].thresholdEvaluation).toBe('not_evaluated')
  })

  it('handles absent document by preserving not_evaluated', () => {
    const result = applyPerformanceThresholds([baseMeasurement], undefined)
    expect(result[0].thresholdEvaluation).toBe('not_evaluated')
  })
})
