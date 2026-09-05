import type { MeasurementRecord, RunManifest } from './contracts'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'
import type { VoiceSampleDiagnosticRecord } from './voice-sample-diagnostics'

import { describe, expect, it } from 'vitest'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { deriveCostEvidence } from './cost-evidence'
import { liveArtifactDigest, parseLiveArtifact } from './live-artifact'
import { parsePriceDocument, priceDocumentDigest } from './price-contract'
import { buildPerformanceReport, recomputeSummary } from './report'
import { cleanupFinding, warmupFinding } from './run-findings'
import { workloadCorrectnessClean } from './sample-results'
import { parseVoiceSampleDiagnosticsJsonl } from './voice-sample-diagnostics'
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
  voiceSampleDiagnostics?: readonly VoiceSampleDiagnosticRecord[]
} = {}) {
  return buildPerformanceReport({
    runId: 'bench-1',
    manifest: overrides.manifest ?? manifest(),
    attempts: overrides.attempts ?? [passedAttempt(WORKLOAD_ID, 0), passedAttempt(WORKLOAD_ID, 1), passedAttempt(WORKLOAD_ID, 2)],
    runFindings: overrides.runFindings ?? [],
    measurements: overrides.measurements ?? [measurement(WORKLOAD_ID)],
    ...(overrides.voiceSampleDiagnostics ? { voiceSampleDiagnostics: overrides.voiceSampleDiagnostics } : {}),
    skippedWorkloadIds: [],
    activeControlDeltas: {},
    importedLiveArtifactDigests: [],
    cost: { status: 'unavailable', reason: 'no-price-document-supplied' },
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

  it('a failed warmup is published as a row and fails the run without joining the denominator', () => {
    // ROOT CAUSE:
    //
    // `attempts.jsonl` deliberately excludes warmups, and the voice runner
    // discarded a warmup's outcome entirely:
    //
    //   for (let ordinal = 0; ordinal < warmupCount; ordinal++)
    //     lastHarness = (await runVoiceSample(...)).harness
    //
    // A warmup that never worked therefore left a run whose measured rows were
    // complete and clean, with the failure visible only on stderr.
    //
    // The warmup now publishes a finding: outside the measured denominator, but
    // inside the run's correctness state.
    const report = cleanReport({
      runFindings: [warmupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 0, ['context-deadline-exceeded'])],
    })
    expect(report.summary.warmupFailures).toBe(1)
    expect(report.summary.cleanupFailures).toBe(0)
    expect(report.summary.sampleCounts).toEqual({ attempted: 3, passed: 3, failed: 0 })
    expect(report.summary.correctnessFailures).toBe(0)
    expect(report.summary.workloadCounts.failed).toBe(1)
    expect(report.summary.disposition).toBe('failed')
    expect(report.runFindingsJsonl).toContain('warmup-failure')
    expect(report.markdown).toContain('Warmup failures: `1`')
  })

  it('carries a warmup diagnostic without carrying what produced it', () => {
    const report = cleanReport({
      runFindings: [warmupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 1, ['context-deadline-exceeded'])],
    })
    expect(report.runFindingsJsonl).toContain('context-deadline-exceeded')
    expect(report.redactionFindings).toEqual([])
    // The finding names the ordinal it belongs to, so a reader can tell a first
    // warmup that never worked from a later one that regressed.
    expect(JSON.parse(report.runFindingsJsonl.trim())).toMatchObject({ kind: 'warmup-failure', warmupOrdinal: 1 })
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
      runFindings: [
        cleanupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 'runtime-close-failed'),
        warmupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 0, ['generation-completion-not-observed']),
      ],
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
    expect(recomputed.warmupFailures).toBe(built.summary.warmupFailures)
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
      cost: { status: 'unavailable', reason: 'no-price-document-supplied' },
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

/**
 * The supplementary voice-sample timing artifact.
 *
 * It is published beside the correctness rows and scanned on the same terms,
 * but it is deliberately inert with respect to every count the summary
 * publishes. These pin both halves: that it travels through the pipeline, and
 * that adding it changed nothing a run's disposition rests on.
 */
describe('performance report voice sample diagnostics', () => {
  function diagnostic(overrides: Partial<VoiceSampleDiagnosticRecord> = {}): VoiceSampleDiagnosticRecord {
    return {
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      contractId: PERFORMANCE_CONTRACT_ID,
      contractDigest: WORKLOAD_CATALOG_DIGEST,
      workloadId: 'voice-active-memory',
      role: 'active',
      phase: 'measured',
      ordinal: 0,
      outcome: 'passed',
      elapsedMs: 37.5,
      events: [
        { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'entered', offsetMs: 0.2 },
        { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'resolved', offsetMs: 7.7 },
        { kind: 'stage', stageId: 'provider-entered', offsetMs: 18.8 },
      ],
      ...overrides,
    }
  }

  it('serializes the rows to their own body and parses them back unchanged', () => {
    const rows = [diagnostic(), diagnostic({ phase: 'warmup', ordinal: 1, outcome: 'failed', diagnosticIds: ['context-deadline-exceeded'] })]
    const report = cleanReport({ voiceSampleDiagnostics: rows })

    expect(parseVoiceSampleDiagnosticsJsonl(report.voiceSampleDiagnosticsJsonl)).toEqual(rows)
    // The rows live in their own artifact and nowhere else: a timing trail in
    // `attempts.jsonl` would enter the measured denominator.
    expect(report.attemptsJsonl).not.toContain('offsetMs')
    expect(report.measurementsJsonl).not.toContain('offsetMs')
    expect(JSON.stringify(report.summary)).not.toContain('offsetMs')
  })

  it('produces a valid empty body when a run published no diagnostics', () => {
    // Every suite that does not run the condition-5 pair takes this path, and
    // the file is still written so the artifact set has a fixed shape.
    expect(cleanReport().voiceSampleDiagnosticsJsonl).toBe('')
    expect(parseVoiceSampleDiagnosticsJsonl(cleanReport().voiceSampleDiagnosticsJsonl)).toEqual([])
  })

  it('is redaction-scanned exactly like every other published artifact', () => {
    const contaminated = diagnostic()
    ;(contaminated as { leakedTurnId?: string }).leakedTurnId = '123456789012345678'
    expect(cleanReport({ voiceSampleDiagnostics: [contaminated] }).redactionFindings).toContain('discord-snowflake')
  })

  it('does not change sample counts, denominators, threshold status, or disposition', () => {
    // The whole safety argument for adding an artifact to a governed benchmark:
    // the correctness state is byte-identical with and without it.
    const withoutRows = cleanReport()
    const withRows = cleanReport({ voiceSampleDiagnostics: [diagnostic(), diagnostic({ ordinal: 1 })] })

    expect(withRows.summary.sampleCounts).toEqual(withoutRows.summary.sampleCounts)
    expect(withRows.summary.measurementDenominatorsConsistent).toBe(withoutRows.summary.measurementDenominatorsConsistent)
    expect(withRows.summary.metricStatusCounts).toEqual(withoutRows.summary.metricStatusCounts)
    expect(withRows.summary.approvedThresholdFailures).toBe(withoutRows.summary.approvedThresholdFailures)
    expect(withRows.summary.warmupFailures).toBe(withoutRows.summary.warmupFailures)
    expect(withRows.summary.disposition).toBe(withoutRows.summary.disposition)
    expect(withRows.summary).toEqual(withoutRows.summary)
  })

  it('leaves the summary recomputable from the core artifacts alone', () => {
    // `recomputeSummary` is not given the diagnostics body, so a run whose
    // disposition depended on it would fail to reconstruct here.
    const report = cleanReport({ voiceSampleDiagnostics: [diagnostic()] })
    const recomputed = recomputeSummary({
      runManifestJson: JSON.stringify(manifest()),
      attemptsJsonl: report.attemptsJsonl,
      runFindingsJsonl: report.runFindingsJsonl,
      measurementsJsonl: report.measurementsJsonl,
    })
    expect(recomputed.disposition).toBe(report.summary.disposition)
    expect(recomputed.sampleCounts).toEqual(report.summary.sampleCounts)
  })

  it('a failed warmup trail does not become an attempt row', () => {
    const report = cleanReport({
      runFindings: [warmupFinding(WORKLOAD_CATALOG_DIGEST, WORKLOAD_ID, 0)],
      voiceSampleDiagnostics: [diagnostic({ phase: 'warmup', ordinal: 0, outcome: 'failed', diagnosticIds: ['generation-completion-not-observed'] })],
    })
    expect(report.summary.sampleCounts.attempted).toBe(3)
    expect(report.summary.warmupFailures).toBe(1)
    expect(report.voiceSampleDiagnosticsJsonl).toContain('"phase":"warmup"')
  })
})

/**
 * Cost is a derived summary field, not an asserted one.
 *
 * The builder takes one discriminated derivation, so `available` cannot be
 * published without the evidence that justifies it, and an unavailable run
 * publishes a content-free reason instead.
 */
describe('performance report cost evidence', () => {
  const priceDocument = parsePriceDocument({
    format: 1,
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    billingUnit: 'token',
    currency: 'USD',
    dimensions: [
      { dimension: 'input', unit: 'token', pricePerUnit: 0.000001 },
      { dimension: 'output', unit: 'token', pricePerUnit: 0.000002 },
    ],
    effectiveStart: '2026-01-01T00:00:00Z',
    source: 'test-approval',
    approver: 'test-approver',
    approvedAt: '2026-08-01T00:00:00Z',
    provenance: 'test price document',
  })

  const brainArtifact = parseLiveArtifact({
    format: 1,
    kind: 'brain-usage-sample',
    sampleId: 'brain-usage-001',
    fileDigest: 'b'.repeat(64),
    fileSizeBytes: 512,
    hostProvenance: 'operator-host-a',
    configProvenance: 'brain-capture-v1',
    observedAt: '2026-08-06T00:00:30Z',
    usage: {
      schemaVersion: 1,
      provider: 'gemini',
      model: 'gemini-3.6-flash',
      correlationId: 'usage-probe-brain-usage-001',
      inputTokens: 1000,
      outputTokens: 200,
      thinkingTokens: null,
      totalTokens: 1200,
      disposition: 'complete',
      retryCount: 0,
      observedAt: '2026-08-06T00:00:30Z',
    },
  })

  function costedReport() {
    const digest = liveArtifactDigest(brainArtifact)
    return buildPerformanceReport({
      runId: 'bench-1',
      manifest: manifest({ importedLiveArtifactDigests: [digest], priceDocumentDigest: priceDocumentDigest(priceDocument) }),
      attempts: [passedAttempt(WORKLOAD_ID, 0), passedAttempt(WORKLOAD_ID, 1), passedAttempt(WORKLOAD_ID, 2)],
      runFindings: [],
      measurements: [measurement(WORKLOAD_ID)],
      skippedWorkloadIds: [],
      activeControlDeltas: {},
      importedLiveArtifactDigests: [digest],
      cost: deriveCostEvidence({ liveArtifacts: [brainArtifact], price: { document: priceDocument, digest: priceDocumentDigest(priceDocument) } }),
      limitations: [],
    })
  }

  it('publishes evidence whose availability follows from it', () => {
    const report = costedReport()
    expect(report.summary.costAvailability).toBe('available')
    expect(report.summary.costUnavailableReason).toBeUndefined()
    expect(report.summary.costEvidence?.liveArtifactDigest).toBe(liveArtifactDigest(brainArtifact))
    expect(report.summary.costEvidence?.dimensions.map(entry => entry.dimension)).toEqual(['input', 'output'])
    expect(report.markdown).toContain('Calculated amount')
  })

  it('publishes a content-free reason and no evidence when cost is unavailable', () => {
    const report = cleanReport()
    expect(report.summary.costAvailability).toBe('unavailable')
    expect(report.summary.costUnavailableReason).toBe('no-price-document-supplied')
    expect(report.summary.costEvidence).toBeUndefined()
  })

  it('leaves the deterministic contract digest untouched', () => {
    // Live and price inputs are separately-digested evidence; they must never
    // reach the workload contract identity.
    expect(costedReport().summary.contractDigest).toBe(cleanReport().summary.contractDigest)
    expect(costedReport().summary.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
  })

  it('keeps every published artifact content-free with evidence embedded', () => {
    const report = costedReport()
    expect(report.redactionFindings).toEqual([])
  })
})
