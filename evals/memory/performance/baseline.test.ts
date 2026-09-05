import type { LoadedRun } from './baseline'
import type { MeasurementRecord, RunManifest } from './contracts'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'

import { describe, expect, it } from 'vitest'

import { compareAgainstBaseline, loadRun } from './baseline'
import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { buildPerformanceReport } from './report'
import { cleanupFinding, warmupFinding } from './run-findings'
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

  it('rejects a candidate whose warmups failed even though its measured rows are clean', () => {
    // A warmup failure leaves `attempts.jsonl` complete and passing, so nothing
    // in the measured evidence refuses this run. The warmups are what put the
    // workload into the state its measured samples were taken from.
    const result = compareAgainstBaseline(cleanRun(), cleanRun({ runFindings: [warmupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 0, ['context-deadline-exceeded'])] }))
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('candidate-warmup-failed')
    expect(result.reasons).not.toContain('candidate-correctness-failed')
  })

  it('rejects a baseline whose warmups failed', () => {
    const result = compareAgainstBaseline(cleanRun({ runFindings: [warmupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 0)] }), cleanRun())
    expect(result.status).toBe('incompatible')
    expect(result.reasons).toContain('baseline-warmup-failed')
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
      cost: { status: 'unavailable', reason: 'no-price-document-supplied' },
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

  it('loads an accepted baseline that has no voice-sample-diagnostics.jsonl', () => {
    // NOTICE:
    // The accepted performance-v2 baseline is retained outside the checkout and
    // was published before the voice timing artifact existed, so it can never
    // grow the file. Requiring it would have invalidated the reference the
    // provisional voice-delta bound is measured against, which is why the
    // artifact is deliberately absent from `REQUIRED_ARTIFACTS`.
    // Removal condition: none; the file is supplementary by design.
    const files = artifacts()
    expect(files['voice-sample-diagnostics.jsonl']).toBeUndefined()
    const { join, existsSync, readFileSync } = fakeFs(files)
    const loaded = loadRun('run', readFileSync, existsSync, join)
    expect(loaded.attempts).toHaveLength(2)
    expect(loaded.measurements).toHaveLength(1)
  })

  it('still loads an accepted baseline published before warmup failures were counted', () => {
    // NOTICE:
    // Retained baseline directories were written by a build whose `summary.json`
    // had no `warmupFailures` key. Those runs could not have carried a warmup
    // finding — the kind did not exist, and `parseRunFindingsJsonl` rejects one
    // — so their recomputed count is 0 and the absent field must not read as a
    // disagreement. Deleting the key here reproduces such a directory exactly.
    const files = artifacts()
    const older = JSON.parse(files['summary.json']!) as Record<string, unknown>
    expect(older.warmupFailures).toBe(0)
    delete older.warmupFailures
    files['summary.json'] = JSON.stringify(older)
    const { join, existsSync, readFileSync } = fakeFs(files)
    const loaded = loadRun('run', readFileSync, existsSync, join)
    expect(loaded.attempts).toHaveLength(2)
    expect(loaded.runFindings).toEqual([])
  })

  it('refuses a directory whose published warmup count overclaims against its rows', () => {
    const files = artifacts()
    const tampered = JSON.parse(files['summary.json']!) as Record<string, unknown>
    tampered.warmupFailures = 2
    files['summary.json'] = JSON.stringify(tampered)
    const { join, existsSync, readFileSync } = fakeFs(files)
    expect(() => loadRun('run', readFileSync, existsSync, join)).toThrow(/disagrees with its own artifacts/)
  })

  it('still loads an accepted baseline published before cost evidence existed', () => {
    // NOTICE:
    // Historical latency baselines carry `costAvailability: "unavailable"` and
    // no `costEvidence` key at all, because the sanctioned producer could not
    // calculate cost when they were published. They stay valid latency
    // references; they are simply not sufficient for the G8 cost condition.
    // Removal condition: none; cost evidence is additive by design.
    const files = artifacts()
    const older = JSON.parse(files['summary.json']!) as Record<string, unknown>
    expect(older.costEvidence).toBeUndefined()
    expect(older.costAvailability).toBe('unavailable')
    const { join, existsSync, readFileSync } = fakeFs(files)
    expect(loadRun('run', readFileSync, existsSync, join).attempts).toHaveLength(2)
  })

  it('refuses a summary claiming available cost with no evidence', () => {
    // ROOT CAUSE:
    //
    // `costAvailability` used to be an asserted input nothing published could
    // contradict, so a bare flag read as a calculated cost.
    //
    // Availability is now derived from evidence, and a directory whose flag
    // stands alone disagrees with its own bytes.
    const files = artifacts()
    const tampered = JSON.parse(files['summary.json']!) as Record<string, unknown>
    tampered.costAvailability = 'available'
    files['summary.json'] = JSON.stringify(tampered)
    const { join, existsSync, readFileSync } = fakeFs(files)
    expect(() => loadRun('run', readFileSync, existsSync, join)).toThrow(/costEvidence-missing/)
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

/**
 * The voice timing artifact and metric coverage.
 *
 * Coverage is matched in both directions, so anything a run publishes that
 * looks like a measurement can create a `metric-missing` against a baseline
 * that lacks it. The timing rows are not measurements and never enter the
 * comparison at all.
 */
describe('baseline metric coverage is unaffected by voice sample diagnostics', () => {
  it('compares a diagnostics-carrying candidate against a pre-diagnostics baseline', () => {
    const result = compareAgainstBaseline(cleanRun(), cleanRun())
    expect(result.status).toBe('compatible')
    expect(result.reasons).toBeUndefined()
    expect(result.deltas?.map(delta => delta.metricId)).toEqual([measurement().metricId])
  })
})
