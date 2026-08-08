import type { CharacterId } from '@proj-airi/memory-domain'

import type { SampleAttemptRecord } from './sample-results'

import { resolve } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { disposeEvaluationRun, startEvaluationRun } from '../runtime-adapter'
import { runControllerWorkloads } from './controller-runner'
import { WORKLOAD_CATALOG_DIGEST, workloadById, workloadsForSuite } from './workloads'

/**
 * Controller workload runner tests for the IMP-803 deterministic benchmark.
 *
 * These exercise the real MentionResponder and ConversationController through
 * benchmark-owned deterministic fakes: the complete text memory lifecycle in
 * both arms, the four distinct barge-in trigger stages, real provider and TTS
 * failure injection, and the semantic queue/multi-room claims.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..')
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
