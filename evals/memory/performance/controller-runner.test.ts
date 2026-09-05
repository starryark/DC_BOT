import type { CharacterId } from '@proj-airi/memory-domain'

import type { VoiceMemoryAdapter } from '../../../src/memory/voice-memory-adapter'
import type { MeasurementRecord, VoiceSampleDiagnosticId } from './contracts'
import type { ControllerWorkloadResult } from './controller-runner'
import type { SampleAttemptRecord } from './sample-results'
import type { VoiceSampleDiagnosticRecord, VoiceTimedMemoryMethod, VoiceTimingStageId } from './voice-sample-diagnostics'

import { resolve } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { disposeEvaluationRun, startEvaluationRun } from '../runtime-adapter'
import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { buildActiveControlDeltaMeasurements, runControllerWorkloads } from './controller-runner'
import { parseSampleAttemptsJsonl, sampleAttemptsJsonl } from './sample-results'
import { applyPerformanceThresholds, parsePerformanceThresholdDocument } from './threshold-contract'
import { parseVoiceSampleDiagnosticsJsonl, voiceSampleDiagnosticsJsonl } from './voice-sample-diagnostics'
import { WORKLOAD_CATALOG_DIGEST, workloadById, workloadsForSuite } from './workloads'

/**
 * Controller workload runner tests for the IMP-803 deterministic benchmark.
 *
 * These exercise the real MentionResponder and ConversationController through
 * benchmark-owned deterministic fakes: the complete text memory lifecycle in
 * both arms, the four distinct barge-in trigger stages, real provider and TTS
 * failure injection, and the semantic queue/multi-room claims.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const CHARACTER: CharacterId = asCharacterId('bench-character')

let run: ReturnType<typeof startEvaluationRun> | undefined

beforeEach(() => {
  run = startEvaluationRun({ repoRoot: REPO_ROOT })
})
afterEach(() => {
  if (run)
    disposeEvaluationRun(run)
  run = undefined
})

function workload(id: string) {
  return workloadsForSuite('performance-v2').find(candidate => candidate.workloadId === id)!
}

function options(overrides: { warmupCount?: number, sampleCount?: number, sampleCapacity?: number } = {}) {
  return {
    repoRoot: REPO_ROOT,
    run: run!,
    characterId: CHARACTER,
    seed: 20260802,
    warmupCount: overrides.warmupCount ?? 0,
    sampleCount: overrides.sampleCount ?? 1,
    ...(overrides.sampleCapacity != null ? { sampleCapacity: overrides.sampleCapacity } : {}),
  }
}

/** Failed postcondition ids for an attempt, or an empty list when it passed. */
function failedIds(attempt: SampleAttemptRecord): readonly string[] {
  return attempt.outcome === 'failed' ? attempt.failedPostconditionIds : []
}

/** Diagnostics an attempt published, or an empty list when it carried none. */
function diagnosticIds(attempt: SampleAttemptRecord): readonly VoiceSampleDiagnosticId[] {
  return attempt.outcome === 'failed' ? attempt.diagnosticIds ?? [] : []
}

describe('controller runner text lifecycle', () => {
  it('the active arm drives the real adapter lifecycle and receives prepared memory', async () => {
    // ROOT CAUSE:
    //
    // v1's `respondOnce` did `void memory` and passed `{ status: 'disabled' }`
    // to the responder in both arms, so `text-active-memory` never touched the
    // active adapter and `active-memory-terminal-state` was satisfied by
    // `brain.callCount > 0`.
    //
    // The active arm now must complete admit -> prepareForModel -> generated ->
    // delivering -> deliveredSegment -> delivered and receive an `available`
    // context, or the attempt fails.
    const result = await runControllerWorkloads([workload('text-active-memory')], options({ sampleCount: 2 }))
    const active = result.results.find(entry => entry.workloadId === 'text-active-memory')!
    expect(active.attempts.map(attempt => attempt.ordinal)).toEqual([0, 1])
    expect(active.attempts.flatMap(failedIds)).toEqual([])
    expect(active.correctnessClean).toBe(true)
    const countRecord = active.measurements.find(measurement => measurement.statistic === 'count')
    expect(countRecord?.outcome).toMatchObject({ disposition: 'observed', value: 2 })
  })

  it('the inert control executes the same lifecycle shape with disabled context', async () => {
    const result = await runControllerWorkloads([workload('text-inert-control')], options())
    const inert = result.results.find(entry => entry.workloadId === 'text-inert-control')!
    expect(inert.attempts.flatMap(failedIds)).toEqual([])
    expect(inert.measurements[0]!.role).toBe('inert-control')
  })

  it('both arms declare the same lifecycle postcondition, so the delta compares the same work', () => {
    expect(workloadById('text-active-memory').postconditions).toContain('lifecycle-sequence-complete')
    expect(workloadById('text-inert-control').postconditions).toContain('lifecycle-sequence-complete')
  })

  it('the active arm fails its attempt when the durable context is not available', async () => {
    // A mutation test: the inert arm resolves `disabled`, so requiring
    // `active-memory-terminal-state` of it must fail rather than pass on a
    // proxy like "the provider was called".
    const mutated = { ...workload('text-inert-control'), postconditions: ['active-memory-terminal-state'] }
    const result = await runControllerWorkloads([mutated], options())
    expect(result.results[0]!.attempts[0]!.outcome).toBe('failed')
  })

  it('applies sample capacity override and performs reservoir sampling', async () => {
    const result = await runControllerWorkloads([workload('text-active-memory')], options({ sampleCount: 5, sampleCapacity: 2 }))
    const active = result.results.find(entry => entry.workloadId === 'text-active-memory')!
    const countRecord = active.measurements.find(measurement => measurement.statistic === 'count')!
    expect(countRecord.observationCount).toBe(5)
    expect(countRecord.retainedSamples).toBe(2)
    expect(countRecord.sampleCapacity).toBe(2)
  })
})

describe('controller runner text semantic claims', () => {
  it('same-room requests reach the provider in request order and never overlap', async () => {
    const result = await runControllerWorkloads([workload('text-same-room-queue')], options())
    expect(result.results[0]!.attempts[0]!.outcome).toBe('passed')
  })

  it('distinct rooms all reach the provider concurrently and carry no other room context', async () => {
    const result = await runControllerWorkloads([workload('text-eight-room-parallelism')], options())
    const parallel = result.results[0]!
    expect(failedIds(parallel.attempts[0]!)).toEqual([])
  })

  it('the multi-room predicate fails for a single-room driver', async () => {
    const mutated = { ...workload('text-active-memory'), postconditions: ['multi-room-generation-overlapped'] }
    const result = await runControllerWorkloads([mutated], options())
    expect(result.results[0]!.attempts[0]!.outcome).toBe('failed')
  })

  it('the queue-order predicate fails for a driver that issues one request', async () => {
    const mutated = { ...workload('text-active-memory'), postconditions: ['per-room-order-preserved'] }
    const result = await runControllerWorkloads([mutated], options())
    expect(result.results[0]!.attempts[0]!.outcome).toBe('failed')
  })
})

describe('controller runner barge-in stages', () => {
  const stages = [
    ['barge-in-before-provider-response', 'before-provider-response'],
    ['barge-in-during-streamed-generation', 'streamed-generation'],
    ['barge-in-during-tts', 'tts'],
    ['barge-in-during-playback', 'playback'],
  ] as const

  for (const [workloadId, stage] of stages) {
    it(`cancels at the ${stage} stage with every cancellation postcondition observed`, async () => {
      const result = await runControllerWorkloads([workload(workloadId)], options())
      const bargeIn = result.results.find(entry => entry.workloadId === workloadId)!
      expect(workloadById(workloadId).triggerStage).toBe(stage)
      expect(failedIds(bargeIn.attempts[0]!)).toEqual([])
    }, 30_000)
  }

  it('the smoke cancellation workload runs the same driver as the full suite', async () => {
    const smoke = workloadsForSuite('smoke').find(candidate => candidate.workloadId === 'smoke-voice-controller-cancellation')!
    const result = await runControllerWorkloads([smoke], options())
    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('a cancellation postcondition fails when the workload never cancels', async () => {
    // A mutation test: the nominal voice workload never fires a barge-in, so
    // requiring cancellation evidence of it must fail. v1 could not fail this
    // check because four of the six predicates were hardcoded `ok = true`.
    const mutated = { ...workload('voice-active-memory'), postconditions: ['generation-cancelled', 'provider-abort-signal-fired'] }
    const result = await runControllerWorkloads([mutated], options())
    const attempt = result.results[0]!.attempts[0]!
    expect(attempt.outcome).toBe('failed')
    expect(failedIds(attempt)).toEqual(['generation-cancelled', 'provider-abort-signal-fired'])
  }, 30_000)

  it('each measured attempt observes its own cancellation, not an earlier sample state', async () => {
    // v1 shared one brain fake across a workload, so once any sample aborted,
    // `signals.some(s => s.aborted)` stayed true for every later sample.
    const result = await runControllerWorkloads([workload('barge-in-during-playback')], options({ sampleCount: 2 }))
    const bargeIn = result.results[0]!
    expect(bargeIn.attempts.map(attempt => attempt.ordinal)).toEqual([0, 1])
    expect(bargeIn.attempts.flatMap(failedIds)).toEqual([])
  }, 30_000)

  it('accepts the follow-up after streamed-generation cancellation through measured ordinal 26', async () => {
    // IEV-803-008 recorded one failure at ordinal 26. Keep that position in
    // this deterministic driver run without treating it as the floor defect's
    // historical root cause.
    const result = await runControllerWorkloads(
      [workload('barge-in-during-streamed-generation')],
      options({ warmupCount: 2, sampleCount: 27 }),
    )
    const bargeIn = result.results[0]!

    expect(bargeIn.attempts).toHaveLength(27)
    expect(bargeIn.attempts.at(-1)?.ordinal).toBe(26)
    expect(bargeIn.attempts.flatMap(failedIds)).toEqual([])
  }, 30_000)

  it('records a barge-in cancellation as controller cancellation path, never acoustic', async () => {
    const result = await runControllerWorkloads([workload('barge-in-during-playback')], options())
    const serialized = JSON.stringify(result.results[0]!)
    expect(serialized).not.toMatch(/acoustic/i)
    expect(serialized).not.toMatch(/barge-in qualification/i)
  }, 30_000)
})

describe('controller runner failure injection', () => {
  it('actually injects the provider failure and proves the controller takes another turn', async () => {
    const result = await runControllerWorkloads([workload('provider-timeout')], options())
    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('actually invokes TTS, injects its failure, and recovers', async () => {
    const result = await runControllerWorkloads([workload('tts-failure')], options())
    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('the injection predicates fail for a workload that injects nothing', async () => {
    const mutated = { ...workload('voice-active-memory'), postconditions: ['provider-failure-injected', 'tts-failure-injected'] }
    const result = await runControllerWorkloads([mutated], options())
    expect(result.results[0]!.attempts[0]!.outcome).toBe('failed')
  }, 30_000)
})

describe('controller runner voice nominal path', () => {
  it('measures the voice turn through to its durable terminal state', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const voiceActive = result.results.find(entry => entry.workloadId === 'voice-active-memory')!
    expect(failedIds(voiceActive.attempts[0]!)).toEqual([])
    expect(voiceActive.measurements.find(measurement => measurement.statistic === 'mean')?.outcome.disposition).toBe('observed')
  }, 30_000)

  it('completes every configured inert warmup and measured turn', async () => {
    const result = await runControllerWorkloads(
      [workload('voice-inert-control')],
      options({ warmupCount: 2, sampleCount: 32 }),
    )
    const inert = result.results[0]!

    expect(result.runFindings).toEqual([])
    expect(inert.attempts).toHaveLength(32)
    expect(inert.attempts.flatMap(failedIds)).toEqual([])
    expect(result.voiceSampleDiagnostics).toHaveLength(34)
    expect(result.voiceSampleDiagnostics.every(record => record.outcome === 'passed')).toBe(true)
  }, 30_000)
})

describe('controller runner active/control delta', () => {
  it('reports the stable contract digest', async () => {
    const result = await runControllerWorkloads([workload('text-active-memory')], options())
    expect(result.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
  })

  it('computes an active-minus-inert delta when both arms are clean', async () => {
    const result = await runControllerWorkloads([workload('text-inert-control'), workload('text-active-memory')], options({ sampleCount: 2 }))
    expect(typeof result.activeControlDeltas['text-active-memory']).toBe('number')
  })

  it('omits the delta when one arm is not correctness-clean', async () => {
    // A delta computed across a failed arm is a number with no meaning; v1
    // published it anyway because it only checked that both means existed.
    const brokenInert = { ...workload('text-inert-control'), postconditions: ['unrecognised-postcondition'] }
    const result = await runControllerWorkloads([brokenInert, workload('text-active-memory')], options({ sampleCount: 2 }))
    expect(result.activeControlDeltas['text-active-memory']).toBeUndefined()
  })

  it('publishes the delta as a measurement record, not only as a report field', async () => {
    const result = await runControllerWorkloads([workload('text-inert-control'), workload('text-active-memory')], options({ sampleCount: 2 }))
    const record = result.activeControlDeltaMeasurements.find(candidate => candidate.metricId === 'text-active-memory.activeControlDelta.mean')!
    expect(record.outcome).toEqual({ disposition: 'observed', value: result.activeControlDeltas['text-active-memory'] })
    // The denominator check in `deriveRunState` compares a record's observation
    // count against the passed attempts of the workload it names.
    const arm = result.results.find(entry => entry.workloadId === 'text-active-memory')!
    expect(record.observationCount).toBe(arm.measurements.find(m => m.statistic === 'mean')!.observationCount)
  })
})

/**
 * Active/control delta measurement records.
 *
 * Driven from synthetic arm results rather than a live run: the properties under
 * test are the *publication rules* — which delta becomes a number, which becomes
 * an unavailable reason, and whether a threshold can bind to either — and a live
 * run cannot produce a negative or unequal-denominator pair on demand.
 */
describe('active/control delta measurement records', () => {
  function arm(workloadId: string, role: MeasurementRecord['role'], mean: number | null, overrides: { correctnessClean?: boolean, observationCount?: number } = {}): ControllerWorkloadResult {
    const correctnessClean = overrides.correctnessClean ?? true
    const observationCount = overrides.observationCount ?? 8
    return {
      workloadId,
      attempts: [],
      correctnessClean,
      measurements: [{
        schemaVersion: PERFORMANCE_SCHEMA_VERSION,
        contractId: PERFORMANCE_CONTRACT_ID,
        contractDigest: WORKLOAD_CATALOG_DIGEST,
        workloadId,
        metricId: `${workloadId}.mean`,
        role,
        unit: 'milliseconds',
        statistic: 'mean',
        outcome: mean == null ? { disposition: 'unavailable', reason: 'no observations recorded' } : { disposition: 'observed', value: mean },
        observationCount,
        retainedSamples: observationCount,
        sampleCapacity: 64,
        percentileMethod: 'exact-nearest-rank',
        correctnessClean,
        thresholdEvaluation: 'not_evaluated',
      }],
    }
  }

  const voicePair = (activeMean: number | null, overrides: Parameters<typeof arm>[3] = {}, inertMean = 12) =>
    [arm('voice-active-memory', 'active', activeMean, overrides), arm('voice-inert-control', 'inert-control', inertMean)]

  const voiceDelta = (results: ControllerWorkloadResult[]) =>
    buildActiveControlDeltaMeasurements(results).find(record => record.metricId === 'voice-active-memory.activeControlDelta.mean')

  it('carries the active workload id and a metric id distinct from that arm\'s own mean', () => {
    const record = voiceDelta(voicePair(40))!
    expect(record.workloadId).toBe('voice-active-memory')
    // The workload id must stay a declared catalog workload — a threshold entry
    // naming an unknown workload is rejected by the compatibility check — while
    // the metric id must not collide with `voice-active-memory.mean`.
    expect(record.metricId).not.toBe('voice-active-memory.mean')
    expect(record.outcome).toEqual({ disposition: 'observed', value: 28 })
  })

  it('emits the record as unavailable rather than dropping it when an arm is unclean', () => {
    const record = voiceDelta(voicePair(40, { correctnessClean: false }))
    // Dropping it would read as `metric-missing` against a baseline that has it,
    // which is a compatibility failure rather than a withheld measurement.
    expect(record).toBeDefined()
    expect(record!.outcome.disposition).toBe('unavailable')
    expect(record!.correctnessClean).toBe(false)
  })

  it('withholds a delta whose arms observed different sample counts', () => {
    const record = voiceDelta(voicePair(40, { observationCount: 5 }))!
    expect(record.outcome).toEqual({ disposition: 'unavailable', reason: expect.stringContaining('different sample counts') })
  })

  it('withholds a negative delta instead of clamping it to a value nobody measured', () => {
    const record = voiceDelta(voicePair(4))!
    expect(record.outcome).toEqual({ disposition: 'unavailable', reason: expect.stringContaining('faster than its inert control') })
  })

  it('emits nothing for a pair whose arms did not both run', () => {
    expect(buildActiveControlDeltaMeasurements([arm('voice-active-memory', 'active', 40)])).toEqual([])
  })

  it('is actually evaluated by a threshold document, passing and failing on the bound', () => {
    // The point of the record. `activeControlDeltas` is a report field that
    // `applyPerformanceThresholds` never sees, so a bound named against it would
    // validate and then silently never fire.
    const document = parsePerformanceThresholdDocument({
      format: 'performance-thresholds',
      schemaVersion: PERFORMANCE_SCHEMA_VERSION,
      contractId: PERFORMANCE_CONTRACT_ID,
      contractDigest: WORKLOAD_CATALOG_DIGEST,
      source: 'test',
      approver: 'test',
      approvedAt: '2026-08-13T00:00:00Z',
      provenance: 'test',
      thresholds: [{ workloadId: 'voice-active-memory', metricId: 'voice-active-memory.activeControlDelta.mean', statistic: 'mean', unit: 'milliseconds', comparator: 'lte', bound: 30 }],
    })
    const evaluate = (activeMean: number) => applyPerformanceThresholds([voiceDelta(voicePair(activeMean))!], document)[0]!.thresholdEvaluation

    expect(evaluate(40)).toBe('passed')
    expect(evaluate(50)).toBe('failed')
    // An unavailable delta is never scored against the bound.
    expect(applyPerformanceThresholds([voiceDelta(voicePair(40, { correctnessClean: false }))!], document)[0]!.thresholdEvaluation).toBe('not_evaluated')
  })
})

describe('controller runner isolation', () => {
  it('uses stable metric ids derived from the workload id', async () => {
    const result = await runControllerWorkloads([workload('text-active-memory')], options())
    for (const measurement of result.results[0]!.measurements)
      expect(measurement.metricId).toMatch(/^text-active-memory\./)
  })

  it('no attempt or measurement carries prompt, transcript, snowflake, or path content', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const serialized = JSON.stringify({
      attempts: result.results.flatMap(entry => entry.attempts),
      measurements: result.results.flatMap(entry => entry.measurements),
    })
    expect(serialized).not.toMatch(/(?<![\d.])\d{17,20}(?!\d)/)
    expect(serialized).not.toMatch(/prompt text|transcript content|generated text/i)
  }, 30_000)
})

/**
 * Voice failure diagnostics.
 *
 * ROOT CAUSE:
 *
 * `voice-active-memory` declares one postcondition, and the runner's exception
 * path collapsed any thrown failure onto the workload's whole postcondition
 * list:
 *
 *   return { outcome: { durationMs: 0, failedPostconditionIds: canonicalPostconditions(workload.postconditions) }, harness }
 *
 * So every way that workload could fail — a durable context deadline, an
 * unavailable authority, a turn that simply never completed — published the
 * identical row: `failed`, `['active-memory-terminal-state']`. The historical
 * intermittent failure could not be classified from artifacts at all.
 *
 * The failure modes are injected through the runner's own voice-memory fault
 * seam, which wraps the adapter the workload is handed. Production is untouched:
 * the errors below are the ones `createVoiceMemoryAdapter` itself raises.
 *
 * The watchdog is shortened per workload because these turns are deliberately
 * wedged — the sample can only end by timing out, and the catalog's 30s bound
 * exists to protect healthy samples under load, not these.
 */
describe('controller runner voice failure diagnostics', () => {
  const WEDGED_WATCHDOG_MS = 1_000

  /** Replace one lifecycle method on the delegate the voice workload is handed. */
  function fault(overrides: Partial<VoiceMemoryAdapter>) {
    return (delegate: VoiceMemoryAdapter): VoiceMemoryAdapter => ({ ...delegate, ...overrides })
  }

  it('names the production context deadline rather than only the postcondition it failed', async () => {
    const wedged = { ...workload('voice-active-memory'), timeoutMs: WEDGED_WATCHDOG_MS }
    const result = await runControllerWorkloads([wedged], {
      ...options(),
      voiceMemoryFault: fault({
        // The exact rejection `boundedVoiceContext` produces at 250ms.
        prepareGeneration: async () => { throw new Error('Durable voice context deadline exceeded') },
      }),
    })

    const attempt = result.results[0]!.attempts[0]!
    expect(attempt.outcome).toBe('failed')
    expect(failedIds(attempt)).toEqual(['active-memory-terminal-state'])
    expect(diagnosticIds(attempt)).toEqual(['context-deadline-exceeded'])
  })

  it('separates a generic preparation failure from the deadline', async () => {
    const wedged = { ...workload('voice-active-memory'), timeoutMs: WEDGED_WATCHDOG_MS }
    const result = await runControllerWorkloads([wedged], {
      ...options(),
      voiceMemoryFault: fault({
        prepareGeneration: async () => { throw new Error('Required durable voice generation authority is unavailable') },
      }),
    })

    const attempt = result.results[0]!.attempts[0]!
    expect(failedIds(attempt)).toEqual(['active-memory-terminal-state'])
    expect(diagnosticIds(attempt)).toEqual(['context-preparation-failed'])
  })

  it('names a turn that never reached its durable terminal state', async () => {
    // The inert control owns no runtime, so a lifecycle call that never settles
    // leaves nothing to close underneath it.
    const wedged = { ...workload('voice-inert-control'), timeoutMs: WEDGED_WATCHDOG_MS }
    const result = await runControllerWorkloads([wedged], {
      ...options(),
      voiceMemoryFault: fault({ completeGeneration: () => new Promise<void>(() => {}) }),
    })

    const attempt = result.results[0]!.attempts[0]!
    expect(attempt.outcome).toBe('failed')
    expect(diagnosticIds(attempt)).toEqual(['generation-completion-not-observed'])
  })

  it('cannot carry the exception text that produced the diagnostic', async () => {
    // A production error message is the one place a filesystem path or a
    // transcript fragment could reach an artifact. The classifier reads it and
    // publishes an id; nothing else survives.
    const leaky = 'C:\\Users\\operator\\.local\\memory failed for transcript "remember my address"'
    const wedged = { ...workload('voice-active-memory'), timeoutMs: WEDGED_WATCHDOG_MS }
    const result = await runControllerWorkloads([wedged], {
      ...options(),
      voiceMemoryFault: fault({ prepareGeneration: async () => { throw new Error(leaky) } }),
    })

    const attempts = result.results[0]!.attempts
    const serialized = sampleAttemptsJsonl(attempts)
    expect(serialized).toContain('context-preparation-failed')
    expect(serialized).not.toContain('operator')
    expect(serialized).not.toContain('transcript')
    expect(serialized).not.toContain('remember my address')
    // The row is not merely free of the message; it round-trips through the
    // published artifact unchanged, so a verifier reads exactly this evidence.
    expect(parseSampleAttemptsJsonl(serialized)).toEqual(attempts)
  })

  it('publishes a failed warmup as a finding without changing the measured denominator', async () => {
    // ROOT CAUSE:
    //
    // The voice warmup loop discarded everything but the harness:
    //
    //   for (let ordinal = 0; ordinal < warmupCount; ordinal++)
    //     lastHarness = (await runVoiceSample(...)).harness
    //
    // A warmup that failed left its message on stderr and nothing else, so a run
    // could publish a complete, clean-looking artifact set whose first turns had
    // not worked. That is how the previously observed warmup timeout survived
    // only as console output.
    const wedged = { ...workload('voice-active-memory'), timeoutMs: WEDGED_WATCHDOG_MS }
    let preparations = 0
    const result = await runControllerWorkloads([wedged], {
      ...options({ warmupCount: 1, sampleCount: 2 }),
      voiceMemoryFault: delegate => ({
        ...delegate,
        // Only the warmup fails, so the measured section stays genuinely clean
        // and the assertions below are about the warmup alone.
        prepareGeneration: async (turnId, events) => {
          preparations += 1
          if (preparations === 1)
            throw new Error('Durable voice context deadline exceeded')
          return delegate.prepareGeneration(turnId, events)
        },
      }),
    })

    expect(result.runFindings).toEqual([expect.objectContaining({
      kind: 'warmup-failure',
      workloadId: 'voice-active-memory',
      warmupOrdinal: 0,
      diagnosticIds: ['context-deadline-exceeded'],
    })])

    // The denominator is exactly the configured sample count, and no warmup
    // became a synthetic attempt.
    const attempts = result.results[0]!.attempts
    expect(attempts.map(attempt => attempt.ordinal)).toEqual([0, 1])
    expect(attempts.flatMap(failedIds)).toEqual([])
    // The workload is still not usable as clean evidence.
    expect(result.results[0]!.correctnessClean).toBe(false)
    expect(result.results[0]!.measurements.every(measurement => measurement.correctnessClean)).toBe(false)
  }, 30_000)

  it('names the context half when the terminal state was reached but the context was not available', async () => {
    // The inert arm reaches its terminal state with `disabled` context, which is
    // correct for it. Demanding the active postcondition of it fails a check
    // that is about durable memory, so the context half is named — but nothing
    // claims a deadline or a stalled completion that did not happen.
    const mutated = { ...workload('voice-inert-control'), postconditions: ['active-memory-terminal-state'] }
    const result = await runControllerWorkloads([mutated], options())
    const attempt = result.results[0]!.attempts[0]!
    expect(failedIds(attempt)).toEqual(['active-memory-terminal-state'])
    expect(diagnosticIds(attempt)).toEqual(['context-preparation-failed'])
  }, 30_000)
})

/**
 * Condition-5 voice sample timing diagnostics.
 *
 * ROOT CAUSE:
 *
 * A `voice-active-memory` sample took 1836.157 ms, passed every postcondition,
 * and moved the 32-sample active/control mean by ~56 ms — enough to fail the
 * 38 ms bound on its own. Its attempt row was
 * `{outcome: 'passed', durationMs: 1836.157}`, which localises nothing. A
 * `voice-inert-control` warmup separately stalled until the 30 s watchdog and
 * published a `warmup-failure` finding that names the workload and the ordinal
 * but not the boundary the turn was sitting in.
 *
 * These assert that both shapes now produce a trail an interval can be read
 * off. They deliberately assert no millisecond value: what matters is which
 * boundaries were crossed, which were not, and in what order.
 */
describe('controller runner voice sample timing diagnostics', () => {
  const WEDGED_WATCHDOG_MS = 1_000

  /** Replace one lifecycle method on the delegate the voice workload is handed. */
  function fault(overrides: Partial<VoiceMemoryAdapter>) {
    return (delegate: VoiceMemoryAdapter): VoiceMemoryAdapter => ({ ...delegate, ...overrides })
  }

  function diagnosticFor(records: readonly VoiceSampleDiagnosticRecord[], workloadId: string, phase: 'warmup' | 'measured', ordinal: number): VoiceSampleDiagnosticRecord {
    const found = records.find(record => record.workloadId === workloadId && record.phase === phase && record.ordinal === ordinal)
    expect(found, `no ${phase} diagnostic at ordinal ${ordinal} for ${workloadId}`).toBeDefined()
    return found!
  }

  function stageIds(record: VoiceSampleDiagnosticRecord): readonly VoiceTimingStageId[] {
    return record.events.flatMap(event => event.kind === 'stage' ? [event.stageId] : [])
  }

  /** Transitions observed for one memory method, in order. */
  function transitionsOf(record: VoiceSampleDiagnosticRecord, method: VoiceTimedMemoryMethod): readonly string[] {
    return record.events.flatMap(event => event.kind === 'memory' && event.method === method ? [event.transition] : [])
  }

  /** Memory calls that were entered and never observed to exit. */
  function unresolvedMethods(record: VoiceSampleDiagnosticRecord): readonly VoiceTimedMemoryMethod[] {
    return record.events.flatMap((event) => {
      if (event.kind !== 'memory' || event.transition !== 'entered')
        return []
      const exited = record.events.some(other => other.kind === 'memory' && other.method === event.method && other.callOrdinal === event.callOrdinal && other.transition !== 'entered')
      return exited ? [] : [event.method]
    })
  }

  /** Every trail must be finite, non-negative, chronologically ordered, and publishable. */
  function expectWellFormed(record: VoiceSampleDiagnosticRecord): void {
    expect(Number.isFinite(record.elapsedMs)).toBe(true)
    expect(record.elapsedMs).toBeGreaterThanOrEqual(0)
    for (const event of record.events) {
      expect(Number.isFinite(event.offsetMs)).toBe(true)
      expect(event.offsetMs).toBeGreaterThanOrEqual(0)
    }
    const offsets = record.events.map(event => event.offsetMs)
    expect(offsets).toEqual([...offsets].sort((left, right) => left - right))
    // Round-tripping through the strict parser is what proves the row is
    // publishable, not merely well-shaped in memory.
    expect(parseVoiceSampleDiagnosticsJsonl(voiceSampleDiagnosticsJsonl([record]))).toEqual([record])
  }

  it('records every stage and memory boundary of a successful voice-inert-control sample, in order', async () => {
    const result = await runControllerWorkloads([workload('voice-inert-control')], options())

    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-inert-control', 'measured', 0)
    expectWellFormed(record)
    expect(record.outcome).toBe('passed')
    expect(record.role).toBe('inert-control')
    expect(record.diagnosticIds).toBeUndefined()

    expect(transitionsOf(record, 'admit')).toEqual(['entered', 'resolved'])
    expect(transitionsOf(record, 'prepareGeneration')).toEqual(['entered', 'resolved'])
    expect(transitionsOf(record, 'recordPlayback')).toEqual(['entered', 'resolved'])
    expect(transitionsOf(record, 'completeGeneration')).toEqual(['entered', 'resolved'])
    expect(stageIds(record)).toEqual(['provider-entered', 'first-generated-chunk', 'tts-entered', 'tts-completed', 'playback-enqueued'])
    expect(unresolvedMethods(record)).toEqual([])

    // Role and context correctness are unchanged by the observation, and the
    // trail brackets exactly the interval the measured sample reported.
    const attempt = result.results[0]!.attempts[0]!
    expect(failedIds(attempt)).toEqual([])
    expect(record.elapsedMs).toBe(attempt.outcome === 'passed' ? attempt.durationMs : Number.NaN)
  }, 30_000)

  it('times the real durable calls of a successful voice-active-memory sample with the same vocabulary', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())

    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 'measured', 0)
    expectWellFormed(record)
    expect(record.outcome).toBe('passed')
    expect(record.role).toBe('active')

    // The same stage vocabulary as the inert arm. The delta subtracts two
    // observations of the same shape, so a stage present in one arm and absent
    // in the other would mean the arms did not measure the same work.
    expect(stageIds(record)).toEqual(['provider-entered', 'first-generated-chunk', 'tts-entered', 'tts-completed', 'playback-enqueued'])
    for (const method of ['admit', 'prepareGeneration', 'recordPlayback', 'completeGeneration'] as const)
      expect(transitionsOf(record, method)).toEqual(['entered', 'resolved'])

    // These are real durable calls rather than the inert no-ops, so the trail
    // spans them. Asserting only the ordering keeps the test off any
    // machine-speed value.
    const admitEntered = record.events.find(event => event.kind === 'memory' && event.method === 'admit' && event.transition === 'entered')!
    const completeResolved = record.events.findLast(event => event.kind === 'memory' && event.method === 'completeGeneration' && event.transition === 'resolved')!
    expect(completeResolved.offsetMs).toBeGreaterThanOrEqual(admitEntered.offsetMs)

    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('localizes a prepareGeneration deadline rejection to that call, with no provider entry after it', async () => {
    const wedged = { ...workload('voice-active-memory'), timeoutMs: WEDGED_WATCHDOG_MS }
    const result = await runControllerWorkloads([wedged], {
      ...options(),
      voiceMemoryFault: fault({ prepareGeneration: async () => { throw new Error('Durable voice context deadline exceeded') } }),
    })

    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 'measured', 0)
    expectWellFormed(record)
    expect(record.outcome).toBe('failed')
    expect(transitionsOf(record, 'prepareGeneration')).toEqual(['entered', 'rejected'])
    expect(record.diagnosticIds).toEqual(['context-deadline-exceeded'])
    // The turn ended at `failGeneration`, so nothing downstream of preparation
    // ran. A provider entry here would mean the rejection was not what stopped it.
    expect(stageIds(record)).not.toContain('provider-entered')

    // Attempt and finding semantics are exactly what they were before.
    const attempt = result.results[0]!.attempts[0]!
    expect(failedIds(attempt)).toEqual(['active-memory-terminal-state'])
    expect(diagnosticIds(attempt)).toEqual(['context-deadline-exceeded'])
    expect(result.runFindings).toEqual([])
  }, 30_000)

  it('separates a generic preparation rejection from the deadline without copying the error text', async () => {
    const leaky = 'C:\\Users\\operator\\.local\\memory failed for transcript "remember my address"'
    const wedged = { ...workload('voice-active-memory'), timeoutMs: WEDGED_WATCHDOG_MS }
    const result = await runControllerWorkloads([wedged], {
      ...options(),
      voiceMemoryFault: fault({ prepareGeneration: async () => { throw new Error(leaky) } }),
    })

    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 'measured', 0)
    expectWellFormed(record)
    expect(transitionsOf(record, 'prepareGeneration')).toEqual(['entered', 'rejected'])
    expect(record.diagnosticIds).toEqual(['context-preparation-failed'])
    expect(stageIds(record)).not.toContain('provider-entered')

    // A rejection publishes that it rejected, and nothing about why in words.
    const serialized = voiceSampleDiagnosticsJsonl(result.voiceSampleDiagnostics)
    expect(serialized).not.toContain('operator')
    expect(serialized).not.toContain('transcript')
    expect(serialized).not.toContain('remember my address')
  }, 30_000)

  it('names completeGeneration as the unresolved boundary when a turn stalls inside it', async () => {
    // The inert control owns no runtime, so a lifecycle call that never settles
    // leaves nothing to close underneath it.
    const wedged = { ...workload('voice-inert-control'), timeoutMs: WEDGED_WATCHDOG_MS }
    const result = await runControllerWorkloads([wedged], {
      ...options(),
      voiceMemoryFault: fault({ completeGeneration: () => new Promise<void>(() => {}) }),
    })

    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-inert-control', 'measured', 0)
    expectWellFormed(record)
    expect(record.outcome).toBe('failed')
    expect(record.diagnosticIds).toEqual(['generation-completion-not-observed'])

    // Everything before the stall is present, the stalled call is entered, and
    // it is the only boundary left open. That is the whole attribution: without
    // it, a watchdog timeout looks identical wherever the turn actually stopped.
    expect(stageIds(record)).toEqual(['provider-entered', 'first-generated-chunk', 'tts-entered', 'tts-completed', 'playback-enqueued'])
    expect(transitionsOf(record, 'recordPlayback')).toEqual(['entered', 'resolved'])
    expect(transitionsOf(record, 'completeGeneration')).toEqual(['entered'])
    expect(unresolvedMethods(record)).toEqual(['completeGeneration'])

    expect(diagnosticIds(result.results[0]!.attempts[0]!)).toEqual(['generation-completion-not-observed'])
  }, 30_000)

  it('publishes a failed warmup trail without touching the measured denominator', async () => {
    // The warmup stall is the anomaly this artifact exists for, and a warmup
    // produces no attempt row by design. Its trail therefore has to come from
    // the diagnostic collection or from nowhere at all.
    const wedged = { ...workload('voice-active-memory'), timeoutMs: WEDGED_WATCHDOG_MS }
    let preparations = 0
    const result = await runControllerWorkloads([wedged], {
      ...options({ warmupCount: 1, sampleCount: 2 }),
      voiceMemoryFault: delegate => ({
        ...delegate,
        prepareGeneration: async (turnId, events) => {
          preparations += 1
          if (preparations === 1)
            throw new Error('Durable voice context deadline exceeded')
          return delegate.prepareGeneration(turnId, events)
        },
      }),
    })

    const warmup = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 'warmup', 0)
    expectWellFormed(warmup)
    expect(warmup.outcome).toBe('failed')
    expect(transitionsOf(warmup, 'prepareGeneration')).toEqual(['entered', 'rejected'])
    expect(warmup.diagnosticIds).toEqual(['context-deadline-exceeded'])

    // The finding remains the run-level statement; the trail is additive.
    expect(result.runFindings).toEqual([expect.objectContaining({ kind: 'warmup-failure', workloadId: 'voice-active-memory', warmupOrdinal: 0 })])

    // No warmup became a synthetic attempt, and the measured section is exactly
    // the configured sample set in its own separate ordinal space.
    const attempts = result.results[0]!.attempts
    expect(attempts.map(attempt => attempt.ordinal)).toEqual([0, 1])
    expect(attempts.flatMap(failedIds)).toEqual([])
    expect(result.voiceSampleDiagnostics.filter(record => record.phase === 'measured').map(record => record.ordinal)).toEqual([0, 1])
  }, 30_000)

  it('emits no timing rows for voice workloads outside the condition-5 pair', async () => {
    // Condition 5 is a claim about one delta over one pair. Instrumenting the
    // cancellation or first-stage workloads would publish rows under a contract
    // that says nothing about them.
    const result = await runControllerWorkloads([workload('barge-in-during-playback'), workload('voice-first-tts-request')], options())
    expect(result.voiceSampleDiagnostics).toEqual([])
  }, 30_000)

  it('leaves the existing correctness trace and its ordering untouched', async () => {
    // The cancellation postconditions read the correctness trace through
    // `since(mark)`. An `entered` record inserted there would silently change
    // what "the calls observed after the barge-in" means, which is why the
    // timing transitions live in a trace of their own.
    const result = await runControllerWorkloads([workload('barge-in-during-playback')], options())
    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)
})

/**
 * Durable authority timing beneath the adapter calls.
 *
 * ROOT CAUSE:
 *
 * Adapter-level timing localised a 515.795 ms `voice-active-memory` sample to
 * 480.337 ms inside one `recordPlayback` call and stopped there. That call
 * issues up to four durable operations, so "inside `recordPlayback`" was still
 * four candidates wide and the tail could not be attributed to a specific
 * durable write.
 *
 * The authority is decorated at the injection seam the benchmark already owns —
 * it constructs the runtime itself — so production is untouched.
 */
describe('controller runner durable authority timing', () => {
  function diagnosticFor(records: readonly VoiceSampleDiagnosticRecord[], workloadId: string, ordinal: number): VoiceSampleDiagnosticRecord {
    const found = records.find(record => record.workloadId === workloadId && record.phase === 'measured' && record.ordinal === ordinal)
    expect(found, `no measured diagnostic at ordinal ${ordinal} for ${workloadId}`).toBeDefined()
    return found!
  }

  /** The authority events of a trail, narrowed off the timing-event union. */
  function authorityEvents(record: VoiceSampleDiagnosticRecord) {
    return record.events.flatMap(event => event.kind === 'authority' ? [event] : [])
  }

  /** Authority operations observed strictly between one memory call's entry and its exit. */
  function operationsWithin(record: VoiceSampleDiagnosticRecord, method: VoiceTimedMemoryMethod): readonly string[] {
    const entered = record.events.findIndex(event => event.kind === 'memory' && event.method === method && event.transition === 'entered')
    const exited = record.events.findIndex((event, index) => index > entered && event.kind === 'memory' && event.method === method && event.transition !== 'entered')
    expect(entered, `${method} was never entered`).toBeGreaterThanOrEqual(0)
    expect(exited, `${method} never exited`).toBeGreaterThan(entered)
    return record.events.slice(entered + 1, exited)
      .flatMap(event => event.kind === 'authority' && event.transition === 'entered' ? [event.operation] : [])
  }

  it('decomposes each adapter call into the durable operations it issues', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 0)

    // The whole point: `recordPlayback` is no longer opaque. A tail inside it
    // now names one of these four writes instead of the call that contains them.
    expect(operationsWithin(record, 'recordPlayback')).toEqual(['appendSegments', 'beginDelivery', 'transitionDelivery', 'transitionDelivery'])
    expect(operationsWithin(record, 'admit')).toEqual(['appendEvent'])
    expect(operationsWithin(record, 'prepareGeneration')).toEqual(['beginGeneration'])
    expect(operationsWithin(record, 'completeGeneration')).toEqual(['transitionGeneration', 'transitionGeneration'])

    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('pairs every authority operation and nests it inside its issuing call', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 0)

    const authority = authorityEvents(record)
    expect(authority.length).toBeGreaterThan(0)
    for (const entered of authority.filter(event => event.transition === 'entered')) {
      const exits = authority.filter(other => other.operation === entered.operation && other.callOrdinal === entered.callOrdinal && other.transition !== 'entered')
      expect(exits, `${entered.operation}#${entered.callOrdinal} never exited`).toHaveLength(1)
    }
    // Repeated operations are distinguished by call ordinal alone, with no turn,
    // segment, or delivery identity riding along.
    const transitions = authority.filter(event => event.operation === 'transitionDelivery' && event.transition === 'entered')
    expect(transitions.map(event => event.callOrdinal)).toEqual([0, 1])

    // Nesting: no authority event falls outside some memory call's span.
    const firstMemory = record.events.findIndex(event => event.kind === 'memory')
    const lastMemory = record.events.map(event => event.kind).lastIndexOf('memory')
    for (const [index, event] of record.events.entries()) {
      if (event.kind !== 'authority')
        continue
      expect(index).toBeGreaterThan(firstMemory)
      expect(index).toBeLessThan(lastMemory)
    }
  }, 30_000)

  it('publishes no authority events for the inert control, which has no durable authority', async () => {
    // Not a choice: the inert arm is constructed without a runtime. The two arms
    // differ here by construction, which is what the delta measures.
    const result = await runControllerWorkloads([workload('voice-inert-control')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-inert-control', 0)
    expect(record.events.filter(event => event.kind === 'authority')).toEqual([])
    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('numbers authority calls within the sample, not across the workload', async () => {
    // The runtime is opened once per workload but the trail is per sample, so a
    // second sample must not inherit the first sample's call ordinals.
    const result = await runControllerWorkloads([workload('voice-active-memory')], options({ sampleCount: 2 }))
    for (const ordinal of [0, 1]) {
      const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', ordinal)
      const appends = authorityEvents(record).filter(event => event.operation === 'appendSegments')
      expect(appends.map(event => event.callOrdinal)).toEqual([0, 0])
    }
  }, 30_000)
})

/**
 * Transaction boundaries beneath the durable authority.
 *
 * ROOT CAUSE:
 *
 * Authority-level timing localised a 410.899 ms `voice-active-memory` sample to
 * 369.074 ms inside one `DeliveryRepository.transition` and stopped there.
 * `transition` is a `BEGIN IMMEDIATE`, five prepared statements, and a `COMMIT`,
 * so "inside `transition`" is still three intervals wide: the lock acquisition,
 * the statements, and the durable commit.
 *
 * The runtime opens its own database and does not expose it, so the probe
 * patches `DatabaseSync.prototype.exec` for the duration of the workload. These
 * tests are what keep that patch honest: that it observes rather than alters,
 * that it is scoped to the operations under investigation, and that it is gone
 * again afterwards.
 */
describe('controller runner durable statement timing', () => {
  function diagnosticFor(records: readonly VoiceSampleDiagnosticRecord[], workloadId: string, ordinal: number): VoiceSampleDiagnosticRecord {
    const found = records.find(record => record.workloadId === workloadId && record.phase === 'measured' && record.ordinal === ordinal)
    expect(found, `no measured diagnostic at ordinal ${ordinal} for ${workloadId}`).toBeDefined()
    return found!
  }

  /** The durable events of a trail, narrowed off the timing-event union. */
  function durableEvents(record: VoiceSampleDiagnosticRecord) {
    return record.events.flatMap(event => event.kind === 'durable' ? [event] : [])
  }

  /** Statements observed strictly between one authority operation's entry and its exit. */
  function statementsWithin(record: VoiceSampleDiagnosticRecord, operation: string, callOrdinal: number): readonly string[] {
    const entered = record.events.findIndex(event => event.kind === 'authority' && event.operation === operation && event.callOrdinal === callOrdinal && event.transition === 'entered')
    const exited = record.events.findIndex((event, index) => index > entered && event.kind === 'authority' && event.operation === operation && event.callOrdinal === callOrdinal && event.transition !== 'entered')
    expect(entered, `${operation} at ordinal ${callOrdinal} was never entered`).toBeGreaterThanOrEqual(0)
    expect(exited, `${operation} at ordinal ${callOrdinal} never exited`).toBeGreaterThan(entered)
    return record.events.slice(entered + 1, exited)
      .flatMap(event => event.kind === 'durable' && event.transition === 'entered' ? [event.statement] : [])
  }

  it('decomposes each durable write into its transaction control', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 0)

    // The whole point: the delivery transition that owned the tail is no longer
    // opaque. Its lock acquisition and its durable commit are separate intervals
    // now, and what is left between them is the statement work.
    expect(statementsWithin(record, 'transitionDelivery', 1)).toEqual(['begin', 'commit'])
    expect(statementsWithin(record, 'appendSegments', 0)).toEqual(['begin', 'commit'])
    expect(statementsWithin(record, 'beginDelivery', 0)).toEqual(['begin', 'commit'])

    // An authority operation is not one transaction. `beginGeneration` runs
    // three - `generations.create`, `causalEdges.appendSet`, and
    // `generations.transition` - which is why it is the largest single
    // operation in every campaign trail, and which the operation-level timing
    // could not show.
    expect(statementsWithin(record, 'beginGeneration', 0)).toEqual(['begin', 'commit', 'begin', 'commit', 'begin', 'commit'])

    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('pairs every statement and nests it inside the operation that executed it', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 0)

    const durable = durableEvents(record)
    expect(durable.length).toBeGreaterThan(0)
    for (const entered of durable.filter(event => event.transition === 'entered')) {
      const exits = durable.filter(other => other.statement === entered.statement && other.callOrdinal === entered.callOrdinal && other.transition !== 'entered')
      expect(exits, `a ${entered.statement} at ordinal ${entered.callOrdinal} never exited`).toHaveLength(1)
    }

    // Nesting: every durable event falls inside some authority operation's span,
    // which is what the gating buys. An ungated probe would also publish the
    // open-time pragmas and the reconciliation passes.
    const firstAuthority = record.events.findIndex(event => event.kind === 'authority')
    const lastAuthority = record.events.map(event => event.kind).lastIndexOf('authority')
    for (const [index, event] of record.events.entries()) {
      if (event.kind !== 'durable')
        continue
      expect(index, 'a durable event fell outside every authority span').toBeGreaterThan(firstAuthority)
      expect(index).toBeLessThan(lastAuthority)
    }
  }, 30_000)

  it('publishes only transaction control, never a statement it did not classify', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 0)

    // An `other` would mean an `exec` reached the probe that is not part of the
    // transaction triple, which would widen the vocabulary without saying so.
    const statements = new Set(durableEvents(record).map(event => event.statement))
    expect([...statements].sort()).toEqual(['begin', 'commit'])
  }, 30_000)

  it('publishes no durable events for the inert control, which has no database', async () => {
    const result = await runControllerWorkloads([workload('voice-inert-control')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-inert-control', 0)
    expect(record.events.filter(event => event.kind === 'durable')).toEqual([])
    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)

  it('numbers statements within the sample, not across the workload', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], options({ sampleCount: 2 }))
    for (const ordinal of [0, 1]) {
      const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', ordinal)
      const commits = durableEvents(record).filter(event => event.statement === 'commit' && event.transition === 'entered')
      // Ten transactions in a nominal turn - eight authority operations, of
      // which `beginGeneration` is three - renumbered from zero each sample.
      expect(commits.map(event => event.callOrdinal)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    }
  }, 30_000)

  it('restores the patched method once the workload is done', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const before = DatabaseSync.prototype.exec
    await runControllerWorkloads([workload('voice-active-memory')], options())
    expect(DatabaseSync.prototype.exec).toBe(before)
  }, 30_000)

  it('leaves the measured lifecycle and its correctness unchanged', async () => {
    // The probe delegates unconditionally and rethrows unchanged, so the
    // workload it observes must still be the workload that ran without it.
    const result = await runControllerWorkloads([workload('voice-active-memory')], options())
    const record = diagnosticFor(result.voiceSampleDiagnostics, 'voice-active-memory', 0)

    expect(record.events.flatMap(event => event.kind === 'authority' && event.transition === 'entered' ? [event.operation] : []))
      .toEqual(['appendEvent', 'beginGeneration', 'appendSegments', 'beginDelivery', 'transitionDelivery', 'transitionDelivery', 'transitionGeneration', 'transitionGeneration'])
    expect(durableEvents(record).some(event => event.transition === 'rejected')).toBe(false)
    expect(failedIds(result.results[0]!.attempts[0]!)).toEqual([])
  }, 30_000)
})
