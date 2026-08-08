import type { LoadedRun } from './baseline'
import type { MeasurementRecord, RunManifest } from './contracts'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'

import { describe, expect, it } from 'vitest'

import { compareAgainstBaseline, loadRun } from './baseline'
import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { buildPerformanceReport } from './report'
import { cleanupFinding } from './run-findings'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Baseline compatibility tests for the IMP-803 performance-v2 benchmark.
 *
 * v1 accepted any run whose contract digest matched and silently skipped
 * metrics the baseline lacked, so a failed or differently-configured run could
 * serve as a reference. These pin the refusals that replace that behaviour.
 */

const WORKLOAD_ID = 'text-append'

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    commitSha: 'a'.repeat(40),
    dirtyWorktree: false,
    suite: 'smoke',
    seed: 20260802,
    environment: { nodeVersion: 'v24.0.0', pnpmVersion: '10.33.0', platform: 'linux', architecture: 'x64', cpuModel: 'synthetic', cpuCount: 8, totalMemoryBytes: 1024, sqliteVersion: '3.51.2' },
    configuration: [],
    timerSource: 'performance.now',
    startedAt: '2026-08-06T00:00:00Z',
    completedAt: '2026-08-06T00:01:00Z',
    workloadPlan: [{ workloadId: WORKLOAD_ID, warmupCount: 1, sampleCount: 2, sampleCapacity: 256 }],
    workloadsCompleted: [WORKLOAD_ID],
    importedLiveArtifactDigests: [],
    limitations: [],
    ...overrides,
  }
}

function measurement(overrides: Partial<MeasurementRecord> = {}): MeasurementRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: WORKLOAD_ID,
    metricId: `${WORKLOAD_ID}.p50`,
    role: 'active',
    unit: 'milliseconds',
    statistic: 'p50',
    outcome: { disposition: 'observed', value: 100 },
    observationCount: 2,
    retainedSamples: 2,
    sampleCapacity: 256,
    percentileMethod: 'exact-nearest-rank',
    correctnessClean: true,
    thresholdEvaluation: 'not_evaluated',
    ...overrides,
  }
}

function passed(ordinal: number): SampleAttemptRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: WORKLOAD_ID,
    ordinal,
    outcome: 'passed',
    durationMs: 1,
  }
}

function failed(ordinal: number): SampleAttemptRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: WORKLOAD_ID,
    ordinal,
    outcome: 'failed',
    failedPostconditionIds: ['append-returned-event-id'],
  }
}

/** A clean, complete two-attempt run. */
function cleanRun(overrides: {
  manifest?: RunManifest
  attempts?: readonly SampleAttemptRecord[]
  runFindings?: readonly RunFindingRecord[]
  measurements?: readonly MeasurementRecord[]
} = {}): LoadedRun {
  return {
    manifest: overrides.manifest ?? manifest(),
    attempts: overrides.attempts ?? [passed(0), passed(1)],
    runFindings: overrides.runFindings ?? [],
    measurements: overrides.measurements ?? [measurement()],
  }
}

describe('baseline compatibility', () => {
  it('accepts a clean, complete, matched pair and reports deltas', () => {
    const result = compareAgainstBaseline(cleanRun(), cleanRun({ measurements: [measurement({ outcome: { disposition: 'observed', value: 120 } })] }))
    expect(result.status).toBe('compatible')
    expect(result.deltas).toHaveLength(1)
    expect(result.deltas![0]!.delta).toBe(20)
  })

  it('accepts a clean run whose metrics are all measured-not-evaluated', () => {
    // Threshold presence governs policy evaluation, not whether two latency
    // samples were taken under comparable conditions.
    const notEvaluated = cleanRun({ measurements: [measurement({ thresholdEvaluation: 'not_evaluated' })] })
    expect(compareAgainstBaseline(notEvaluated, notEvaluated).status).toBe('compatible')
  })

  it('rejects a contract digest mismatch', () => {
    const other = cleanRun({ manifest: manifest({ contractDigest: 'b'.repeat(64) }) })
    const result = compareAgainstBaseline(other, cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('contract-digest-mismatch')
  })

  it('rejects a v1 baseline outright', () => {
    // A performance-v1 artifact can never be a v2 reference, even when a subset
    // of workload ids happens to overlap.
    const v1 = cleanRun({ manifest: { ...manifest(), schemaVersion: 1, contractId: 'performance-v1' } as unknown as RunManifest })
    const result = compareAgainstBaseline(v1, cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toEqual(expect.arrayContaining(['schema-version-mismatch', 'contract-id-mismatch']))
  })

  it('rejects a baseline with a failed measured attempt', () => {
    const result = compareAgainstBaseline(cleanRun({ attempts: [passed(0), failed(1)], measurements: [measurement({ observationCount: 1, retainedSamples: 1 })] }), cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('baseline-correctness-failed')
  })

  it('rejects a baseline whose sample set is incomplete', () => {
    const result = compareAgainstBaseline(cleanRun({ attempts: [passed(0)], measurements: [measurement({ observationCount: 1, retainedSamples: 1 })] }), cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('baseline-sample-incomplete')
  })

  it('rejects a candidate whose sample set is incomplete', () => {
    const result = compareAgainstBaseline(cleanRun(), cleanRun({ attempts: [passed(0)], measurements: [measurement({ observationCount: 1, retainedSamples: 1 })] }))
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('candidate-sample-incomplete')
  })

  it('rejects a baseline with a cleanup failure', () => {
    const result = compareAgainstBaseline(cleanRun({ runFindings: [cleanupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 'runtime-close-failed')] }), cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('baseline-cleanup-failed')
  })

  it('rejects a workload plan mismatch', () => {
    const differentPlan = cleanRun({ manifest: manifest({ workloadPlan: [{ workloadId: WORKLOAD_ID, warmupCount: 5, sampleCount: 2, sampleCapacity: 256 }] }) })
    const result = compareAgainstBaseline(differentPlan, cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('workload-plan-mismatch')
  })

  it('rejects a sample capacity mismatch', () => {
    // Capacity decides which samples a percentile was computed over, so two
    // runs with different capacities produced different statistics.
    const differentCapacity = cleanRun({ manifest: manifest({ workloadPlan: [{ workloadId: WORKLOAD_ID, warmupCount: 1, sampleCount: 2, sampleCapacity: 8 }] }) })
    const result = compareAgainstBaseline(differentCapacity, cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('sample-capacity-mismatch')
  })

  it('rejects a platform mismatch', () => {
    const other = cleanRun({ manifest: manifest({ environment: { ...manifest().environment, platform: 'win32' } }) })
    const result = compareAgainstBaseline(other, cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('platform-mismatch')
  })

  it('rejects a required toolchain mismatch', () => {
    const other = cleanRun({ manifest: manifest({ environment: { ...manifest().environment, nodeVersion: 'v22.0.0', sqliteVersion: '3.40.0' } }) })
    const result = compareAgainstBaseline(other, cleanRun())
    expect(result.reasons).toEqual(expect.arrayContaining(['node-version-mismatch', 'sqlite-version-mismatch']))
  })

  it('rejects a missing metric instead of silently skipping it', () => {
    const result = compareAgainstBaseline(cleanRun({ measurements: [] }), cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('metric-missing')
    expect(result.deltas).toBeUndefined()
  })

  it('rejects a unit or statistic mismatch on a shared metric', () => {
    const other = cleanRun({ measurements: [measurement({ unit: 'count', statistic: 'p95' })] })
    const result = compareAgainstBaseline(other, cleanRun())
    expect(result.reasons).toEqual(expect.arrayContaining(['metric-unit-mismatch', 'metric-statistic-mismatch']))
  })

  it('reports every reason a pair failed, not just the first', () => {
    const other = cleanRun({
      manifest: manifest({ environment: { ...manifest().environment, platform: 'win32', cpuCount: 4 } }),
      measurements: [],
    })
    const result = compareAgainstBaseline(other, cleanRun())
    expect(result.reasons!.length).toBeGreaterThan(2)
  })
})

describe('baseline run loading', () => {
  /** Build an in-memory v2 artifact set for a run directory. */
  function artifacts(overrides: { attempts?: readonly SampleAttemptRecord[] } = {}): Record<string, string> {
    const built = buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest(),
      attempts: overrides.attempts ?? [passed(0), passed(1)],
      runFindings: [],
      measurements: [measurement()],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [],
      costAvailability: 'unavailable',
      limitations: [],
    })
    return {
      'run-manifest.json': JSON.stringify(manifest()),
      'attempts.jsonl': built.attemptsJsonl,
      'run-findings.jsonl': built.runFindingsJsonl,
      'measurements.jsonl': built.measurementsJsonl,
      'summary.json': JSON.stringify(built.summary),
    }
  }

  function fakeFs(files: Record<string, string>) {
    const join = (...paths: string[]): string => paths.join('/')
    return {
      join,
      existsSync: (path: string) => path === 'run' || files[path.replace('run/', '')] != null,
      readFileSync: (path: string) => {
        const content = files[path.replace('run/', '')]
        if (content == null)
          throw new Error(`missing ${path}`)
        return content
      },
    }
  }

  it('loads a complete artifact set', () => {
    const { join, existsSync, readFileSync } = fakeFs(artifacts())
    const loaded = loadRun('run', readFileSync, existsSync, join)
    expect(loaded.attempts).toHaveLength(2)
    expect(loaded.measurements).toHaveLength(1)
    expect(loaded.manifest.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
  })

  it('refuses a directory missing the attempts artifact', () => {
    const files = artifacts()
    delete files['attempts.jsonl']
    const { join, existsSync, readFileSync } = fakeFs(files)
    expect(() => loadRun('run', readFileSync, existsSync, join)).toThrow(/attempts\.jsonl/)
  })

  it('refuses a directory whose published summary disagrees with its own rows', () => {
    // v1 trusted `summary.json` because it parsed. A summary that overclaims
    // relative to its evidence cannot be a reference no matter which is wrong.
    const files = artifacts()
    const tampered = JSON.parse(files['summary.json']!) as Record<string, unknown>
    tampered.disposition = 'correctness_clean_thresholds_passed'
    files['summary.json'] = JSON.stringify(tampered)
    const { join, existsSync, readFileSync } = fakeFs(files)
    expect(() => loadRun('run', readFileSync, existsSync, join)).toThrow(/disagrees with its own artifacts/)
  })

  it('refuses a directory whose attempts do not parse against the v2 schema', () => {
    const files = artifacts()
    files['attempts.jsonl'] = `${JSON.stringify({ ...passed(0), contractId: 'performance-v1' })}\n`
    const { join, existsSync, readFileSync } = fakeFs(files)
    expect(() => loadRun('run', readFileSync, existsSync, join)).toThrow()
  })
})
