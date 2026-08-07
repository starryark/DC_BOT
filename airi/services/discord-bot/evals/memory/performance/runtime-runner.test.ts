import type { CharacterId } from '@proj-airi/memory-domain'

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
 * small sample counts: deterministic workload selection, warmups excluded from
 * measured statistics, no latency sample on a failed postcondition, context
 * sizes, isolation, and cleanup on success and thrown error.
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

describe('runtime runner deterministic selection', () => {
  it('runs only the runtime-family workloads of the requested suite', async () => {
    const result = await runRuntimeSuite('smoke', { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const runtimeWorkloadIds = result.results.map(result => result.workloadId)
    // Every result must be a runtime-family workload, never a controller one.
    for (const workloadId of runtimeWorkloadIds) {
      const workload = workloadsForSuite('smoke').find(workload => workload.workloadId === workloadId)
      expect(workload?.runner).toBe('runtime')
    }
    expect(result.results.length).toBeGreaterThan(0)
  })

  it('reports the stable contract digest for every run', async () => {
    const result = await runRuntimeSuite('smoke', { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
    expect(result.contractDigest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('runtime runner measurement', () => {
  it('excludes warmups from measured statistics', async () => {
    const workload = workloadsForSuite('performance-v1').find(workload => workload.workloadId === 'text-append')!
    const result = await runRuntimeWorkloads([workload], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 3, sampleCount: 2 })
    const textAppend = result.results.find(result => result.workloadId === 'text-append')!
    const countRecord = textAppend.measurements.find(measurement => measurement.statistic === 'count')
    expect(countRecord?.outcome).toMatchObject({ disposition: 'observed', value: 2 })
  })

  it('produces p50/p95/p99 latency measurements for a successful workload', async () => {
    const workload = workloadsForSuite('performance-v1').find(workload => workload.workloadId === 'text-append')!
    const result = await runRuntimeWorkloads([workload], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 1, sampleCount: 5 })
    const textAppend = result.results.find(result => result.workloadId === 'text-append')!
    expect(textAppend.correctnessFailures).toEqual([])
    const statistics = ['p50', 'p95', 'p99', 'min', 'max', 'mean'] as const
    for (const statistic of statistics) {
      const measurement = textAppend.measurements.find(measurement => measurement.statistic === statistic)
      expect(measurement?.outcome).toMatchObject({ disposition: 'observed' })
    }
  })

  it('applies sample capacity override and performs reservoir sampling', async () => {
    const workload = workloadsForSuite('performance-v1').find(workload => workload.workloadId === 'text-append')!
    const result = await runRuntimeWorkloads([workload], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 5, sampleCapacity: 2 })
    const textAppend = result.results.find(result => result.workloadId === 'text-append')!
    
    const countRecord = textAppend.measurements.find(measurement => measurement.statistic === 'count')!
    expect(countRecord.observationCount).toBe(5)
    expect(countRecord.retainedSamples).toBe(2)
    expect(countRecord.sampleCapacity).toBe(2)
  })

  it('records no latency sample when a correctness postcondition fails', async () => {
    // A workload whose postconditions the runner cannot satisfy produces a
    // correctness failure and zero measured samples.
    const bogus = { ...workloadsForSuite('performance-v1').find(workload => workload.workloadId === 'text-append')!, postconditions: ['unrecognised-postcondition'] }
    const result = await runRuntimeWorkloads([bogus], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 3 })
    const textAppend = result.results.find(result => result.workloadId === 'text-append')!
    expect(textAppend.correctnessFailures.length).toBeGreaterThan(0)
    const countRecord = textAppend.measurements.find(measurement => measurement.statistic === 'count')
    // No sample was recorded because every attempt failed the postcondition.
    expect(countRecord?.outcome).toMatchObject({ disposition: 'observed', value: 0 })
  })
})

describe('runtime runner context sizes', () => {
  it('assembles context with 0, 8, and 24 retained turns', async () => {
    for (const retainedTurns of [0, 8, 24]) {
      const workloadId = `context-assembly-${retainedTurns}`
      const workload = workloadsForSuite('performance-v1').find(workload => workload.workloadId === workloadId)!
      const result = await runRuntimeWorkloads([workload], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
      const context = result.results.find(result => result.workloadId === workloadId)!
      expect(context.correctnessFailures).toEqual([])
    }
  })
})

describe('runtime runner lifecycle', () => {
  it('closes the scenario root on the success path', async () => {
    const workload = workloadsForSuite('performance-v1').find(workload => workload.workloadId === 'text-append')!
    const result = await runRuntimeWorkloads([workload], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.results[0].correctnessFailures).toEqual([])
  })

  it('reports a cleanup failure when close throws', async () => {
    // A workload whose close fails records a correctness failure against the
    // runtime-closed-clean postcondition rather than crashing the runner.
    const workload = workloadsForSuite('performance-v1').find(workload => workload.workloadId === 'text-append')!
    // Override the run's openScenario to return a scenario whose close rejects.
    const failingRun = {
      ...run!,
      openScenario: async () => {
        const scenario = await run!.openScenario({ scenarioLabel: 'failing-close', characterId: CHARACTER })
        return { ...scenario, close: async () => Promise.reject(new Error('close boom')) }
      },
    }
    const result = await runRuntimeWorkloads([workload], { repoRoot: REPO_ROOT, run: failingRun, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    expect(result.results[0].correctnessFailures.some(failure => failure.postcondition === 'runtime-closed-clean')).toBe(true)
  })
})

describe('runtime runner isolation', () => {
  it('rejects a run root inside the repository checkout', async () => {
    const inside = `${REPO_ROOT}/.local/memory`
    expect(() => startEvaluationRun({ repoRoot: REPO_ROOT, explicitParentRoot: inside })).toThrow(/inside the repository checkout/)
  })

  it('uses stable metric ids derived from the workload id', async () => {
    const workload = workloadsForSuite('performance-v1').find(workload => workload.workloadId === 'text-append')!
    const result = await runRuntimeWorkloads([workload], { repoRoot: REPO_ROOT, run: run!, characterId: CHARACTER, seed: 20260802, warmupCount: 0, sampleCount: 1 })
    const textAppend = result.results.find(result => result.workloadId === 'text-append')!
    for (const measurement of textAppend.measurements)
      expect(measurement.metricId).toMatch(/^text-append\./)
  })
})
