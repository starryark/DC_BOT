import type { CharacterId } from '@proj-airi/memory-domain'

import { resolve } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { disposeEvaluationRun, startEvaluationRun } from '../runtime-adapter'
import { runControllerWorkloads } from './controller-runner'
import { WORKLOAD_CATALOG_DIGEST, workloadsForSuite } from './workloads'

/**
 * Controller workload runner tests for the IMP-803 deterministic benchmark.
 *
 * These exercise the real MentionResponder and ConversationController through
 * benchmark-owned deterministic fakes, with small sample counts: text response
 * admission, voice playback lifecycle, barge-in cancellation postconditions,
 * matched active/inert pairs, and failure scenarios recorded without crashing.
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
  return workloadsForSuite('performance-v1').find(workload => workload.workloadId === id)!
}

describe('controller runner text path', () => {
  it('produces one response per accepted text request', async () => {
    const result = await runControllerWorkloads([workload('text-active-memory')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 2 })
    const textActive = result.results.find(result => result.workloadId === 'text-active-memory')!
    expect(textActive.correctnessFailures).toEqual([])
    const countRecord = textActive.measurements.find(measurement => measurement.statistic === 'count')
    expect(countRecord?.outcome).toMatchObject({ disposition: 'observed', value: 2 })
  })

  it('the inert text control runs the same workload shape and produces measurements', async () => {
    const result = await runControllerWorkloads([workload('text-inert-control')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const inert = result.results.find(result => result.workloadId === 'text-inert-control')!
    expect(inert.correctnessFailures).toEqual([])
    expect(inert.measurements.length).toBeGreaterThan(0)
    expect(inert.measurements[0].role).toBe('inert-control')
  })
})

describe('controller runner voice path', () => {
  it('measures the voice playback lifecycle end to end', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const voiceActive = result.results.find(result => result.workloadId === 'voice-active-memory')!
    expect(voiceActive.correctnessFailures).toEqual([])
    const meanRecord = voiceActive.measurements.find(measurement => measurement.statistic === 'mean')
    expect(meanRecord?.outcome.disposition).toBe('observed')
  })

  it('records a barge-in cancellation as controller cancellation path, never acoustic', async () => {
    const result = await runControllerWorkloads([workload('barge-in-during-playback')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const bargeIn = result.results.find(result => result.workloadId === 'barge-in-during-playback')!
    // The workload must not carry an acoustic-qualification label in its metrics.
    const serialized = JSON.stringify(bargeIn)
    expect(serialized).not.toMatch(/acoustic/i)
    expect(serialized).not.toMatch(/barge-in qualification/i)
  })

  it('records provider timeout and TTS failure scenarios without crashing the runner', async () => {
    const result = await runControllerWorkloads([workload('provider-timeout'), workload('tts-failure')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const ids = result.results.map(result => result.workloadId)
    expect(ids).toEqual(expect.arrayContaining(['provider-timeout', 'tts-failure']))
  })
})

describe('controller runner active/inert pairing', () => {
  it('reports the stable contract digest', async () => {
    const result = await runControllerWorkloads([workload('text-active-memory')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
  })

  it('computes an active-minus-inert delta for matched text pairs', async () => {
    const result = await runControllerWorkloads([workload('text-inert-control'), workload('text-active-memory')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 2 })
    expect(result.activeControlDeltas['text-active-memory']).toBeDefined()
    expect(typeof result.activeControlDeltas['text-active-memory']).toBe('number')
  })
})

describe('controller runner isolation', () => {
  it('uses stable metric ids derived from the workload id', async () => {
    const result = await runControllerWorkloads([workload('text-active-memory')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const textActive = result.results.find(result => result.workloadId === 'text-active-memory')!
    for (const measurement of textActive.measurements)
      expect(measurement.metricId).toMatch(/^text-active-memory\./)
  })

  it('no measurement carries prompt, transcript, snowflake, or path content', async () => {
    const result = await runControllerWorkloads([workload('voice-active-memory')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toMatch(/\b\d{17,20}\b/) // snowflake
    expect(serialized).not.toMatch(/prompt text|transcript content|generated text/i)
  })
})
