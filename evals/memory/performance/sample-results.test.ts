import type { WorkloadPlanEntry } from './contracts'
import type { SampleAttemptRecord } from './sample-results'

import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import {
  attemptsForWorkload,
  sampleAttemptRecordSchema,
  summarizeSampleAttempts,
  validateSampleAttempts,
} from './sample-results'
import { WORKLOAD_CATALOG_DIGEST, workloadById } from './workloads'

/**
 * Measured-attempt evidence tests for the IMP-803 performance-v2 contract.
 *
 * v1 published a single `correctnessClean` boolean per measurement and no
 * per-attempt record, so a verifier could not tell whether a workload ran its
 * configured sample count, which attempts failed, or whether the latency
 * denominator matched the passing attempts. These tests pin the row-level
 * evidence that replaces that boolean.
 */

/** `text-append` declares `append-returned-event-id`; used for the failed-postcondition cases. */
const WORKLOAD_ID = 'text-append'
const DECLARED_POSTCONDITION = 'append-returned-event-id'

function passed(ordinal: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: WORKLOAD_ID,
    ordinal,
    outcome: 'passed',
    durationMs: 1.5,
    ...overrides,
  }
}

function failed(ordinal: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: WORKLOAD_ID,
    ordinal,
    outcome: 'failed',
    failedPostconditionIds: [DECLARED_POSTCONDITION],
    ...overrides,
  }
}

function plan(sampleCount: number): readonly WorkloadPlanEntry[] {
  return [{ workloadId: WORKLOAD_ID, warmupCount: 0, sampleCount, sampleCapacity: 256 }]
}

function parse(input: Record<string, unknown>): SampleAttemptRecord {
  return v.parse(sampleAttemptRecordSchema, input)
}

describe('sample attempt record schema', () => {
  it('accepts a valid passed attempt carrying its duration', () => {
    expect(() => parse(passed(0))).not.toThrow()
  })

  it('accepts a valid failed attempt carrying its failed postcondition ids', () => {
    expect(() => parse(failed(0))).not.toThrow()
  })

  it('rejects a failed attempt that also carries a duration', () => {
    // A failed attempt has no meaningful latency; allowing the field would let a
    // failed sample be summed into a latency denominator downstream.
    expect(() => parse(failed(0, { durationMs: 1.5 }))).toThrow()
  })

  it('rejects a passed attempt with no duration', () => {
    const record = passed(0)
    delete record.durationMs
    expect(() => parse(record)).toThrow()
  })

  it('rejects a negative ordinal', () => {
    expect(() => parse(passed(-1))).toThrow()
  })

  it('rejects an unknown extra field', () => {
    expect(() => parse(passed(0, { transcript: 'leak' }))).toThrow()
  })

  it('rejects a v1 contract id', () => {
    expect(() => parse(passed(0, { contractId: 'performance-v1' }))).toThrow()
  })

  it('rejects an empty failed postcondition list', () => {
    expect(() => parse(failed(0, { failedPostconditionIds: [] }))).toThrow()
  })

  it('accepts a failed attempt carrying closed-set diagnostics alongside its postconditions', () => {
    const record = parse(failed(0, { diagnosticIds: ['context-deadline-exceeded'] }))
    expect(record).toMatchObject({ outcome: 'failed', failedPostconditionIds: [DECLARED_POSTCONDITION], diagnosticIds: ['context-deadline-exceeded'] })
  })

  it('accepts a failed attempt published before diagnostics existed', () => {
    // The field is additive: every retained artifact set was written without it
    // and must stay loadable as a baseline.
    const record = parse(failed(0))
    expect(record.outcome === 'failed' && record.diagnosticIds).toBeUndefined()
  })

  it('rejects a diagnostic outside the closed vocabulary', () => {
    // This is the leak guard: an arbitrary string is what an exception message,
    // a filesystem path, or a transcript fragment would arrive as.
    expect(() => parse(failed(0, { diagnosticIds: ['C:/Users/operator/.local/memory'] }))).toThrow()
    expect(() => parse(failed(0, { diagnosticIds: ['durable voice context deadline exceeded'] }))).toThrow()
  })

  it('rejects an empty diagnostic list rather than publishing a meaningless key', () => {
    expect(() => parse(failed(0, { diagnosticIds: [] }))).toThrow()
  })

  it('rejects a passed attempt carrying diagnostics', () => {
    expect(() => parse(passed(0, { diagnosticIds: ['context-deadline-exceeded'] }))).toThrow()
  })
})

describe('measured attempt set validation', () => {
  it('accepts a complete set covering every configured ordinal exactly once', () => {
    const attempts = [parse(passed(0)), parse(passed(1)), parse(passed(2))]
    expect(validateSampleAttempts(attempts, plan(3), [workloadById(WORKLOAD_ID)])).toEqual([])
  })

  it('rejects a duplicate (workloadId, ordinal) pair', () => {
    const attempts = [parse(passed(0)), parse(passed(0))]
    expect(validateSampleAttempts(attempts, plan(1), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('duplicate attempt'))
  })

  it('reports an incomplete workload when an ordinal inside the configured range is missing', () => {
    const attempts = [parse(passed(0)), parse(passed(2))]
    expect(validateSampleAttempts(attempts, plan(3), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('missing attempt ordinal'))
  })

  it('rejects an ordinal at or beyond the configured sample count', () => {
    const attempts = [parse(passed(0)), parse(passed(1)), parse(passed(2))]
    expect(validateSampleAttempts(attempts, plan(2), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('out-of-range attempt ordinal'))
  })

  it('rejects duplicate failed postcondition ids inside one attempt', () => {
    const attempts = [parse(failed(0, { failedPostconditionIds: [DECLARED_POSTCONDITION, DECLARED_POSTCONDITION] }))]
    expect(validateSampleAttempts(attempts, plan(1), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('duplicate failed postcondition'))
  })

  it('rejects a failed postcondition the workload does not declare', () => {
    const attempts = [parse(failed(0, { failedPostconditionIds: ['not-declared-by-workload'] }))]
    expect(validateSampleAttempts(attempts, plan(1), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('undeclared failed postcondition'))
  })

  it('requires failed postcondition ids in canonical sorted order', () => {
    // Two runs that failed the same predicates must produce byte-identical rows,
    // otherwise same-seed reproducibility comparison reports a false difference.
    const workload = workloadById('smoke-voice-controller-cancellation')
    const attempts = [parse(failed(0, {
      workloadId: workload.workloadId,
      failedPostconditionIds: ['playback-stopped', 'generation-cancelled'],
    }))]
    expect(validateSampleAttempts(attempts, [{ workloadId: workload.workloadId, warmupCount: 0, sampleCount: 1, sampleCapacity: 256 }], [workload]))
      .toContainEqual(expect.stringContaining('not in canonical sorted order'))
  })

  it('requires diagnostics in canonical sorted order and without duplicates', () => {
    const unsorted = [parse(failed(0, { diagnosticIds: ['generation-completion-not-observed', 'context-deadline-exceeded'] }))]
    expect(validateSampleAttempts(unsorted, plan(1), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('not in canonical sorted order'))

    const duplicated = [parse(failed(0, { diagnosticIds: ['context-deadline-exceeded', 'context-deadline-exceeded'] }))]
    expect(validateSampleAttempts(duplicated, plan(1), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('duplicate diagnostic'))
  })

  it('accepts canonical diagnostics on an otherwise valid failed attempt', () => {
    const attempts = [parse(failed(0, { diagnosticIds: ['context-deadline-exceeded', 'generation-completion-not-observed'] }))]
    expect(validateSampleAttempts(attempts, plan(1), [workloadById(WORKLOAD_ID)])).toEqual([])
  })

  it('rejects an attempt referencing a workload outside the plan', () => {
    const attempts = [parse(passed(0, { workloadId: 'voice-append' }))]
    expect(validateSampleAttempts(attempts, plan(1), [workloadById(WORKLOAD_ID)]))
      .toContainEqual(expect.stringContaining('unplanned workload'))
  })
})

describe('measured attempt summary', () => {
  it('a failed attempt contributes zero observations to latency statistics', () => {
    const attempts = [parse(passed(0)), parse(passed(1)), parse(failed(2))]
    const summary = summarizeSampleAttempts(attempts)
    expect(summary.attemptedAttempts).toBe(3)
    expect(summary.passedAttempts).toBe(2)
    expect(summary.failedAttempts).toBe(1)
    // The latency denominator is the passing attempts, never the attempted count.
    expect(summary.byWorkload[WORKLOAD_ID]!.passed).toBe(2)
  })

  it('counts every failed postcondition id across failed attempts', () => {
    const workload = workloadById('smoke-voice-controller-cancellation')
    const attempts = [
      parse(failed(0, { workloadId: workload.workloadId, failedPostconditionIds: ['generation-cancelled', 'playback-stopped'] })),
      parse(failed(1, { workloadId: workload.workloadId, failedPostconditionIds: ['no-stale-commit'] })),
    ]
    const summary = summarizeSampleAttempts(attempts)
    expect(summary.failedAttempts).toBe(2)
    expect(summary.failedPostconditions).toBe(3)
  })

  it('the same attempt set always produces the same summary counts', () => {
    const attempts = [parse(passed(0)), parse(failed(1)), parse(passed(2))]
    expect(summarizeSampleAttempts(attempts)).toEqual(summarizeSampleAttempts([...attempts].reverse()))
  })

  it('selects attempts for one workload without leaking another workload rows', () => {
    const attempts = [parse(passed(0)), parse(passed(0, { workloadId: 'voice-append' }))]
    expect(attemptsForWorkload(attempts, WORKLOAD_ID)).toHaveLength(1)
    expect(attemptsForWorkload(attempts, WORKLOAD_ID)[0]!.workloadId).toBe(WORKLOAD_ID)
  })
})
