import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import {
  canonicalJson,
  MEASUREMENT_STATISTICS,
  MEASUREMENT_UNITS,
  measurementRecordSchema,
  PERFORMANCE_CONTRACT_ID,
  PERFORMANCE_DEFAULT_SEED,
  PERFORMANCE_SCHEMA_VERSION,
  RUNNER_FAMILIES,
  runManifestSchema,
  validateMeasurementRecords,
  validateWorkloadCatalog,
  workloadCatalogDigest,
  workloadSpecSchema,
  WORKLOAD_ROLES,
} from './contracts'
import { WORKLOAD_CATALOG, WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Contract and invariant tests for the IMP-803 performance benchmark.
 *
 * These assert the frozen catalog is internally consistent, the canonical
 * digest is stable, strict schemas reject unknown or out-of-range values, and
 * the cross-record validators catch duplicate ids and dangling references.
 */

describe('performance contract constants', () => {
  it('pins the schema version, contract id, and default seed', () => {
    expect(PERFORMANCE_SCHEMA_VERSION).toBe(1)
    expect(PERFORMANCE_CONTRACT_ID).toBe('performance-v1')
    expect(PERFORMANCE_DEFAULT_SEED).toBe(20260802)
  })

  it('lists runner families, roles, units, and statistics as frozen explicit sets', () => {
    expect(RUNNER_FAMILIES).toEqual(['runtime', 'text-controller', 'voice-controller'])
    expect(WORKLOAD_ROLES).toEqual(['active', 'inert-control', 'timer-control'])
    expect(MEASUREMENT_UNITS).toContain('milliseconds')
    expect(MEASUREMENT_UNITS).toContain('total_tokens')
    expect(MEASUREMENT_STATISTICS).toEqual(['count', 'min', 'max', 'mean', 'p50', 'p95', 'p99'])
  })
})

describe('workload catalog invariants', () => {
  it('declares unique workload ids', () => {
    expect(validateWorkloadCatalog(WORKLOAD_CATALOG)).toEqual([])
    const ids = WORKLOAD_CATALOG.map(workload => workload.workloadId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('parses every catalog entry against the strict workload spec schema', () => {
    for (const workload of WORKLOAD_CATALOG)
      expect(() => v.parse(workloadSpecSchema, workload)).not.toThrow()
  })

  it('reports a stable contract digest that is a 64-char hex sha256', () => {
    expect(WORKLOAD_CATALOG_DIGEST).toMatch(/^[0-9a-f]{64}$/)
    expect(workloadCatalogDigest(WORKLOAD_CATALOG)).toBe(WORKLOAD_CATALOG_DIGEST)
  })

  it('the contract digest is deterministic across repeated computations of the same catalog', () => {
    // The frozen catalog is declared in a stable order; that order is part of
    // its identity, so repeated computations over the same array must match.
    expect(workloadCatalogDigest(WORKLOAD_CATALOG)).toBe(workloadCatalogDigest([...WORKLOAD_CATALOG]))
  })

  it('the contract digest changes when a workload id changes', () => {
    const mutated = WORKLOAD_CATALOG.map((workload, index) =>
      index === 0 ? { ...workload, workloadId: 'mutated-id' } : workload,
    )
    expect(workloadCatalogDigest(mutated)).not.toBe(WORKLOAD_CATALOG_DIGEST)
  })

  it('detects a duplicate workload id', () => {
    const duplicated = [WORKLOAD_CATALOG[0], WORKLOAD_CATALOG[0]]
    expect(validateWorkloadCatalog(duplicated)).toContainEqual(expect.stringContaining('duplicate workload id'))
  })
})

describe('measurement record schema', () => {
  function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      contractId: PERFORMANCE_CONTRACT_ID,
      contractDigest: WORKLOAD_CATALOG_DIGEST,
      workloadId: 'text-append',
      metricId: 'text.append.p95Ms',
      role: 'active',
      unit: 'milliseconds',
      statistic: 'p95',
      outcome: { disposition: 'observed', value: 12.5 },
      observationCount: 64,
      retainedSamples: 64,
      sampleCapacity: 256,
      percentileMethod: 'exact-nearest-rank',
      correctnessClean: true,
      thresholdEvaluation: 'not_evaluated',
      ...overrides,
    }
  }

  it('accepts a well-formed observed record', () => {
    expect(() => v.parse(measurementRecordSchema, validRecord())).not.toThrow()
  })

  it('accepts an explicit unavailable disposition with a content-free reason', () => {
    expect(() => v.parse(measurementRecordSchema, validRecord({
      outcome: { disposition: 'unavailable', reason: 'sdk does not expose final usage metadata' },
    }))).not.toThrow()
  })

  it('rejects an unknown unit', () => {
    expect(() => v.parse(measurementRecordSchema, validRecord({ unit: 'megawatts' }))).toThrow()
  })

  it('rejects a negative observed value', () => {
    expect(() => v.parse(measurementRecordSchema, validRecord({ outcome: { disposition: 'observed', value: -1 } }))).toThrow()
  })

  it('rejects an unknown extra field', () => {
    expect(() => v.parse(measurementRecordSchema, validRecord({ secret: 'leak' }))).toThrow()
  })

  it('rejects a contract id from a different family', () => {
    expect(() => v.parse(measurementRecordSchema, validRecord({ contractId: 'performance-v2' }))).toThrow()
  })
})

describe('cross-record measurement validation', () => {
  function record(workloadId: string, metricId: string): Record<string, unknown> {
    return {
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      contractId: PERFORMANCE_CONTRACT_ID,
      contractDigest: WORKLOAD_CATALOG_DIGEST,
      workloadId,
      metricId,
      role: 'active',
      unit: 'milliseconds',
      statistic: 'p95',
      outcome: { disposition: 'observed', value: 1 },
      observationCount: 1,
      retainedSamples: 1,
      sampleCapacity: 256,
      percentileMethod: 'exact-nearest-rank',
      correctnessClean: true,
      thresholdEvaluation: 'not_evaluated',
    }
  }

  it('passes for records that each reference a declared workload with unique metric ids', () => {
    const parsed = [
      v.parse(measurementRecordSchema, record('text-append', 'text.append.p95Ms')),
      v.parse(measurementRecordSchema, record('text-ingress', 'text.ingress.p95Ms')),
    ]
    expect(validateMeasurementRecords(parsed, WORKLOAD_CATALOG)).toEqual([])
  })

  it('flags a measurement referencing an undeclared workload', () => {
    const parsed = [v.parse(measurementRecordSchema, record('not-in-catalog', 'm.p95Ms'))]
    expect(validateMeasurementRecords(parsed, WORKLOAD_CATALOG)).toContainEqual(expect.stringContaining('undeclared workload'))
  })

  it('flags a duplicate metric id within a run', () => {
    const parsed = [
      v.parse(measurementRecordSchema, record('text-append', 'dup.p95Ms')),
      v.parse(measurementRecordSchema, record('text-ingress', 'dup.p95Ms')),
    ]
    expect(validateMeasurementRecords(parsed, WORKLOAD_CATALOG)).toContainEqual(expect.stringContaining('duplicate metric id'))
  })
})

describe('run manifest schema', () => {
  function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      contractId: PERFORMANCE_CONTRACT_ID,
      contractDigest: WORKLOAD_CATALOG_DIGEST,
      commitSha: 'a'.repeat(40),
      dirtyWorktree: false,
      suite: 'performance-v1',
      seed: PERFORMANCE_DEFAULT_SEED,
      environment: {
        nodeVersion: 'v24.0.0',
        pnpmVersion: '10.33.0',
        platform: 'linux',
        architecture: 'x64',
        cpuModel: 'synthetic',
        cpuCount: 8,
        totalMemoryBytes: 1,
        sqliteVersion: '3.51.2',
      },
      configuration: [{ key: 'sampleCapacity', value: '256' }],
      timerSource: 'performance.now',
      startedAt: '2026-08-06T00:00:00Z',
      completedAt: '2026-08-06T00:01:00Z',
      workloadsCompleted: ['text-append'],
      importedLiveArtifactDigests: [],
      limitations: [],
      ...overrides,
    }
  }

  it('accepts a well-formed manifest without optional provenance digests', () => {
    expect(() => v.parse(runManifestSchema, validManifest())).not.toThrow()
  })

  it('accepts optional threshold and price provenance digests', () => {
    expect(() => v.parse(runManifestSchema, validManifest({
      thresholdDocumentDigest: '0'.repeat(64),
      priceDocumentDigest: '1'.repeat(64),
    }))).not.toThrow()
  })

  it('rejects an unknown extra manifest field', () => {
    expect(() => v.parse(runManifestSchema, validManifest({ absolutePath: '/secret' }))).toThrow()
  })
})

describe('canonical json helper reexport', () => {
  it('produces key-sorted, whitespace-free canonical encoding', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
  })
})
