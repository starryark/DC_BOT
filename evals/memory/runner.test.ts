import type { Dataset, ScenarioResult } from './contracts'

import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { activeV1Digest, datasetForSuite } from './dataset'
import { buildReport } from './report'
import { runScenario } from './runner'
import { disposeEvaluationRun, removeRunRoot, startEvaluationRun } from './runtime-adapter'

/**
 * Runner integration tests for the G8-1 evaluator (IMP-802, T004/T006).
 *
 * These drive the real production memory runtime through the adapter and the
 * runner, then assert the determinism and whole-run-validity properties the
 * plan requires: every scenario produces a result, equal-seed normalized
 * digests are reproducible, scenario order does not change a result, and a
 * clean smoke run has no zero-tolerance failures.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../..')

const scratchRoots: string[] = []

beforeEach(() => {
  scratchRoots.length = 0
})
afterEach(() => {
  for (const root of scratchRoots)
    removeRunRoot(root)
})

async function runSuite(suite: 'smoke' | 'active-v1', seed = 20260802): Promise<{ dataset: Dataset, results: (ScenarioResult & { elapsedMs: number })[] }> {
  const { dataset, scenarios } = datasetForSuite(suite)
  const run = startEvaluationRun({ repoRoot: REPO_ROOT })
  scratchRoots.push(run.parentRoot)
  try {
    const results = []
    for (const scenario of scenarios)
      results.push(await runScenario(run, scenario, { seed, datasetVersion: dataset.datasetVersion, repoRoot: REPO_ROOT }))
    return { dataset, results }
  }
  finally {
    disposeEvaluationRun(run)
  }
}

describe('runner smoke suite', () => {
  it('produces a result for every smoke scenario', async () => {
    const { dataset, results } = await runSuite('smoke')
    const expected = dataset.scenarios.filter(s => s.suites.includes('smoke')).map(s => s.scenarioId)
    const got = results.map(r => r.scenarioId)
    expect(got.sort()).toEqual([...expected].sort())
  }, 60000)

  it('a clean smoke run has no zero-tolerance failures', async () => {
    const { dataset, results } = await runSuite('smoke')
    const report = buildReport({ dataset, datasetDigest: activeV1Digest(), seed: 20260802, commitSha: 'a'.repeat(40), platform: 'test', generatedAt: '2026-08-06T00:00:00Z', results })
    expect(report.summary.zeroToleranceFailures).toEqual([])
  }, 60000)

  // ROOT CAUSE:
  //
  // The evaluator defined threshold documents and normalized measurements, but
  // every production scenario driver returned an empty measurement list. The
  // aggregate G8 qualifier requires an evaluated measurement, so no real
  // active-v1 or multilingual-v1 run could ever satisfy that condition even
  // when a complete threshold document was supplied.
  //
  // The runner now publishes one stable, thresholdable elapsed-time identity
  // per scenario while the normalized result digest continues to exclude the
  // volatile value.
  it('publishes one thresholdable elapsed-time measurement per scenario', async () => {
    const { results } = await runSuite('smoke')
    for (const result of results) {
      expect(result.measurements).toHaveLength(1)
      expect(result.measurements[0]).toEqual({
        name: `${result.scenarioId}.elapsed_ms`,
        value: expect.any(Number),
        unit: 'ms',
        evaluated: false,
      })
      expect(result.measurements[0]!.value).toBeGreaterThanOrEqual(0)
    }
  }, 60000)

  it('cAP-001 passes on a refusal while staying unsupported', async () => {
    const { dataset, results } = await runSuite('smoke')
    const cap = results.find(r => r.scenarioId === 'CAP-001')!
    expect(cap.outcome).toBe('passed')
    expect(cap.capabilityDisposition).toBe('unsupported')
    void dataset
  }, 30000)
})

describe('runner determinism', () => {
  it('two equal-seed smoke runs produce the same normalized digest', async () => {
    const { dataset, results: a } = await runSuite('smoke', 20260802)
    const reportA = buildReport({ dataset, datasetDigest: activeV1Digest(), seed: 20260802, commitSha: 'a'.repeat(40), platform: 'test', generatedAt: '2026-08-06T00:00:00Z', results: a })
    const { results: b } = await runSuite('smoke', 20260802)
    const reportB = buildReport({ dataset, datasetDigest: activeV1Digest(), seed: 20260802, commitSha: 'a'.repeat(40), platform: 'test', generatedAt: '2026-08-06T00:00:00Z', results: b })
    expect(reportA.summary.normalizedResultDigest).toBe(reportB.summary.normalizedResultDigest)
  }, 120000)

  it('scenario order does not change per-scenario normalized results', async () => {
    const { dataset, scenarios } = datasetForSuite('smoke')
    const run = startEvaluationRun({ repoRoot: REPO_ROOT })
    scratchRoots.push(run.parentRoot)
    const forward: (ScenarioResult & { elapsedMs: number })[] = []
    const reverse: (ScenarioResult & { elapsedMs: number })[] = []
    try {
      for (const scenario of scenarios)
        forward.push(await runScenario(run, scenario, { seed: 20260802, datasetVersion: dataset.datasetVersion, repoRoot: REPO_ROOT }))
      for (const scenario of [...scenarios].reverse())
        reverse.push(await runScenario(run, scenario, { seed: 20260802, datasetVersion: dataset.datasetVersion, repoRoot: REPO_ROOT }))
    }
    finally {
      disposeEvaluationRun(run)
    }
    const digestOf = (result: ScenarioResult) => JSON.stringify({ id: result.scenarioId, outcome: result.outcome, capabilityDisposition: result.capabilityDisposition, cleanup: result.cleanup, assertions: result.assertions.map(a => [a.assertionId, a.passed]) })
    const forwardMap = new Map(forward.map(r => [digestOf(r), r.scenarioId]))
    for (const r of reverse)
      expect(forwardMap.has(digestOf(r)), `${r.scenarioId} changed under reordering`).toBe(true)
  }, 120000)
})
