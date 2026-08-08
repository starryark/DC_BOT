import type { CharacterId } from '@proj-airi/memory-domain'

import type { SampleAttemptRecord } from './sample-results'

import { resolve } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { disposeEvaluationRun, startEvaluationRun } from '../runtime-adapter'
import { runRuntimeSuite, runRuntimeWorkloads } from './runtime-runner'
import { WORKLOAD_CATALOG_DIGEST, workloadsForSuite } from './workloads'

/**
 * Runtime workload runner tests for the IMP-803 deterministic benchmark.
 *
 * These exercise the real production memory runtime through the adapter with
 * small sample counts: deterministic identity, one attempt row per configured
 * ordinal, failed attempts excluded from latency, semantic postconditions that
 * can actually fail, and cleanup published as a run finding.
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

/** The comparable correctness shape of an attempt; durations are environment-bound. */
function correctnessPattern(attempts: readonly SampleAttemptRecord[]) {
  return attempts.map(attempt => ({
    workloadId: attempt.workloadId,
    ordinal: attempt.ordinal,
    outcome: attempt.outcome,
    failedPostconditionIds: attempt.outcome === 'failed' ? attempt.failedPostconditionIds : [],
  }))
}

describe('runtime runner deterministic selection', () => {
  it('runs only the runtime-family workloads of the requested suite', async () => {
    const result = await runRuntimeSuite('smoke', { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    for (const entry of result.results) {
      const spec = workloadsForSuite('smoke').find(candidate => candidate.workloadId === entry.workloadId)
      expect(spec?.runner).toBe('runtime')
    }
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('reports the stable contract digest for every run', async () => {
    const result = await runRuntimeSuite('smoke', { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
    expect(result.contractDigest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('runtime runner measured attempts', () => {
  it('records exactly one attempt per configured measured ordinal and excludes warmups', async () => {
    const result = await runRuntimeWorkloads([workload('text-append')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 3, sampleCount: 2 })
    const textAppend = result.results.find(entry => entry.workloadId === 'text-append')!
    expect(textAppend.attempts.map(attempt => attempt.ordinal)).toEqual([0, 1])
    expect(textAppend.attempts.every(attempt => attempt.outcome === 'passed')).toBe(true)
    const countRecord = textAppend.measurements.find(measurement => measurement.statistic === 'count')
    expect(countRecord?.outcome).toMatchObject({ disposition: 'observed', value: 2 })
  })

  it('produces p50/p95/p99 latency measurements for a successful workload', async () => {
    const result = await runRuntimeWorkloads([workload('text-append')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 1, sampleCount: 5 })
    const textAppend = result.results.find(entry => entry.workloadId === 'text-append')!
    expect(textAppend.attempts.filter(attempt => attempt.outcome === 'failed')).toEqual([])
    for (const statistic of ['p50', 'p95', 'p99', 'min', 'max', 'mean'] as const) {
      const measurement = textAppend.measurements.find(candidate => candidate.statistic === statistic)
      expect(measurement?.outcome).toMatchObject({ disposition: 'observed' })
    }
  })

  it('applies sample capacity override and performs reservoir sampling', async () => {
    const result = await runRuntimeWorkloads([workload('text-append')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 5, sampleCapacity: 2 })
    const textAppend = result.results.find(entry => entry.workloadId === 'text-append')!
    const countRecord = textAppend.measurements.find(measurement => measurement.statistic === 'count')!
    expect(countRecord.observationCount).toBe(5)
    expect(countRecord.retainedSamples).toBe(2)
    expect(countRecord.sampleCapacity).toBe(2)
  })

  it('a failed postcondition still records its ordinal but contributes no latency observation', async () => {
    // ROOT CAUSE:
    //
    // v1 dropped the failed sample with `continue` and recorded nothing, so the
    // published denominator could not be reconciled with the configured sample
    // count. The attempt row now exists and is marked failed.
    const bogus = { ...workload('text-append'), postconditions: ['unrecognised-postcondition'] }
    const result = await runRuntimeWorkloads([bogus], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 3 })
    const textAppend = result.results.find(entry => entry.workloadId === 'text-append')!
    expect(textAppend.attempts.map(attempt => attempt.ordinal)).toEqual([0, 1, 2])
    expect(textAppend.attempts.every(attempt => attempt.outcome === 'failed')).toBe(true)
    const countRecord = textAppend.measurements.find(measurement => measurement.statistic === 'count')
    expect(countRecord?.outcome).toMatchObject({ disposition: 'observed', value: 0 })
    expect(countRecord?.correctnessClean).toBe(false)
  })

  it('marks a workload correctness-clean only when every configured ordinal passed', async () => {
    const result = await runRuntimeWorkloads([workload('text-append')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 2 })
    const textAppend = result.results.find(entry => entry.workloadId === 'text-append')!
    expect(textAppend.measurements.every(measurement => measurement.correctnessClean)).toBe(true)
  })
})

describe('runtime runner determinism', () => {
  it('two runs of the same seed produce identical correctness patterns', async () => {
    const options = { repoRoot: REPO_ROOT, characterId: CHARACTER, seed: 20260802, warmupCount: 1, sampleCount: 3 }
    const first = await runRuntimeWorkloads([workload('text-append')], { ...options, run: run! })
    const secondRun = startEvaluationRun({ repoRoot: REPO_ROOT })
    try {
      const second = await runRuntimeWorkloads([workload('text-append')], { ...options, run: secondRun })
      expect(correctnessPattern(second.results[0]!.attempts)).toEqual(correctnessPattern(first.results[0]!.attempts))
    }
    finally {
      disposeEvaluationRun(secondRun)
    }
  })

  it('mints no identifier from a random source, so repeated ordinals stay reproducible', async () => {
    // A `Math.random()` idempotency key made every run unique by construction,
    // which is the opposite of what a deterministic benchmark needs.
    const result = await runRuntimeWorkloads([workload('generation-begin')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 1, sampleCount: 2 })
    const begin = result.results.find(entry => entry.workloadId === 'generation-begin')!
    expect(begin.attempts.every(attempt => attempt.outcome === 'passed')).toBe(true)
  })
})

describe('runtime runner semantic postconditions', () => {
  it('same-room concurrent appends are observed to serialize into contiguous versions', async () => {
    const result = await runRuntimeWorkloads([workload('same-room-serialized-load')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 2 })
    const serialized = result.results.find(entry => entry.workloadId === 'same-room-serialized-load')!
    expect(serialized.attempts.every(attempt => attempt.outcome === 'passed')).toBe(true)
  })

  it('multi-room appends are observed to advance each room independently', async () => {
    const result = await runRuntimeWorkloads([workload('eight-room-concurrent-load')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 2 })
    const multiRoom = result.results.find(entry => entry.workloadId === 'eight-room-concurrent-load')!
    expect(multiRoom.attempts.every(attempt => attempt.outcome === 'passed')).toBe(true)
  })

  it('the multi-room predicate fails when the driver only touched one room', async () => {
    // A mutation test: `text-append` appends into a single room, so it cannot
    // establish per-room independence. v1's predicate accepted it because it
    // only asked whether an event id came back.
    const mutated = { ...workload('text-append'), postconditions: ['multi-room-progress-independent'] }
    const result = await runRuntimeWorkloads([mutated], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const attempt = result.results[0]!.attempts[0]!
    expect(attempt.outcome).toBe('failed')
    expect(attempt.outcome === 'failed' && attempt.failedPostconditionIds).toContain('multi-room-progress-independent')
  })

  it('the same-room serialization predicate fails when the driver issued one write', async () => {
    const mutated = { ...workload('text-append'), postconditions: ['same-room-writes-serialized'] }
    const result = await runRuntimeWorkloads([mutated], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const attempt = result.results[0]!.attempts[0]!
    expect(attempt.outcome).toBe('failed')
  })

  it('segment ordinals are checked against the ordinals actually requested', async () => {
    const result = await runRuntimeWorkloads([workload('text-segment-delivery-lifecycle')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const lifecycle = result.results[0]!
    expect(lifecycle.attempts[0]!.outcome).toBe('passed')
  })

  it('the segment-ordinal predicate fails for a driver that appends no segments', async () => {
    const mutated = { ...workload('text-append'), postconditions: ['segment-ordinals-correct'] }
    const result = await runRuntimeWorkloads([mutated], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.results[0]!.attempts[0]!.outcome).toBe('failed')
  })

  it('an interrupted delivery is observed to be cancelled and not durably delivered', async () => {
    // v1 returned `generationId !== 'committed'`, a comparison against a string
    // a generation id never holds, so the predicate was true by construction.
    const result = await runRuntimeWorkloads([workload('interrupted-delivery-recovery')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.results[0]!.attempts[0]!.outcome).toBe('passed')
  })

  it('context assembly counts are checked against the turns actually seeded', async () => {
    for (const retainedTurns of [0, 8, 24]) {
      const workloadId = `context-assembly-${retainedTurns}`
      const result = await runRuntimeWorkloads([workload(workloadId)], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
      const context = result.results.find(entry => entry.workloadId === workloadId)!
      expect(context.attempts[0]!.outcome, workloadId).toBe('passed')
    }
  })
})

describe('runtime runner lifecycle', () => {
  it('publishes a close failure as a run finding rather than a sample correctness failure', async () => {
    // A close failure is a run-level cleanup fact. Attributing it to a sample
    // would corrupt that sample's latency evidence; publishing nothing at all
    // (v1) made the disposition unrecomputable from artifacts.
    const failingRun = {
      ...run!,
      openScenario: async () => {
        const scenario = await run!.openScenario({ scenarioLabel: 'failing-close', characterId: CHARACTER })
        return { ...scenario, close: async () => Promise.reject(new Error('close boom')) }
      },
    }
    const result = await runRuntimeWorkloads([workload('text-append')], { repoRoot: REPO_ROOT, run: failingRun, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.runFindings).toHaveLength(1)
    expect(result.runFindings[0]!.findingId).toBe('runtime-close-failed')
    expect(result.runFindings[0]!.workloadId).toBe('text-append')
    // The sample itself still passed; only the cleanup failed.
    expect(result.results[0]!.attempts[0]!.outcome).toBe('passed')
    expect(result.results[0]!.measurements.every(measurement => measurement.correctnessClean)).toBe(false)
  })
})

describe('runtime runner isolation', () => {
  it('rejects a run root inside the repository checkout', async () => {
    const inside = `${REPO_ROOT}/.local/memory`
    expect(() => startEvaluationRun({ repoRoot: REPO_ROOT, explicitParentRoot: inside })).toThrow(/inside the repository checkout/)
  })

  it('uses stable metric ids derived from the workload id', async () => {
    const result = await runRuntimeWorkloads([workload('text-append')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const textAppend = result.results.find(entry => entry.workloadId === 'text-append')!
    for (const measurement of textAppend.measurements)
      expect(measurement.metricId).toMatch(/^text-append\./)
  })

  it('no attempt or measurement carries prompt, transcript, snowflake, or path content', async () => {
    const result = await runRuntimeWorkloads([workload('text-append')], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const serialized = JSON.stringify({ attempts: result.results.flatMap(entry => entry.attempts), measurements: result.results.flatMap(entry => entry.measurements) })
    expect(serialized).not.toMatch(/(?<![\d.])\d{17,20}(?!\d)/)
    expect(serialized).not.toMatch(/prompt text|transcript content|generated text/i)
  })
})
