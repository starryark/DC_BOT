import type { VoiceSampleDiagnosticRecord } from './voice-sample-diagnostics'

import { describe, expect, it } from 'vitest'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { classifyDurableStatement } from './fixtures/voice'
import {
  canonicalVoiceDiagnostics,
  isVoiceDiagnosticWorkloadId,
  parseVoiceSampleDiagnostic,
  parseVoiceSampleDiagnosticsJsonl,
  voiceSampleDiagnosticsJsonl,
} from './voice-sample-diagnostics'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Strict-contract tests for the condition-5 voice timing artifact.
 *
 * These are about the record shape alone: that an unknown field, an
 * un-instrumented workload, an invented stage, or a trail that runs backwards
 * cannot be published, and that a partial trail from a wedged sample can. The
 * runner tests prove the trails actually localise a failure.
 */

function record(overrides: Partial<VoiceSampleDiagnosticRecord> = {}): VoiceSampleDiagnosticRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: 'voice-active-memory',
    role: 'active',
    phase: 'measured',
    ordinal: 2,
    outcome: 'passed',
    elapsedMs: 41.5,
    events: [
      { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'entered', offsetMs: 0.5 },
      { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'resolved', offsetMs: 1.25 },
      { kind: 'memory', method: 'prepareGeneration', callOrdinal: 0, transition: 'entered', offsetMs: 1.5 },
      { kind: 'memory', method: 'prepareGeneration', callOrdinal: 0, transition: 'resolved', offsetMs: 9 },
      { kind: 'stage', stageId: 'provider-entered', offsetMs: 9.5 },
      { kind: 'stage', stageId: 'first-generated-chunk', offsetMs: 10 },
      { kind: 'stage', stageId: 'tts-entered', offsetMs: 11 },
      { kind: 'stage', stageId: 'tts-completed', offsetMs: 12 },
      { kind: 'stage', stageId: 'playback-enqueued', offsetMs: 13 },
      { kind: 'memory', method: 'recordPlayback', callOrdinal: 0, transition: 'entered', offsetMs: 14 },
      { kind: 'memory', method: 'recordPlayback', callOrdinal: 0, transition: 'resolved', offsetMs: 20 },
      { kind: 'memory', method: 'completeGeneration', callOrdinal: 0, transition: 'entered', offsetMs: 21 },
      { kind: 'memory', method: 'completeGeneration', callOrdinal: 0, transition: 'resolved', offsetMs: 41 },
    ],
    ...overrides,
  }
}

describe('voice sample diagnostic contract', () => {
  it('round-trips a complete nominal trail through the published JSONL body', () => {
    const rows = [record(), record({ workloadId: 'voice-inert-control', role: 'inert-control', ordinal: 0 })]
    const serialized = voiceSampleDiagnosticsJsonl(rows)

    expect(serialized.endsWith('\n')).toBe(true)
    expect(serialized.trimEnd().split('\n')).toHaveLength(2)
    expect(parseVoiceSampleDiagnosticsJsonl(serialized)).toEqual(rows)
  })

  it('serializes an empty collection as an empty body', () => {
    expect(voiceSampleDiagnosticsJsonl([])).toBe('')
    expect(parseVoiceSampleDiagnosticsJsonl('')).toEqual([])
  })

  it('serializes deterministically: the same rows produce the same bytes', () => {
    expect(voiceSampleDiagnosticsJsonl([record()])).toBe(voiceSampleDiagnosticsJsonl([record()]))
  })

  it('rejects an unknown field on the record', () => {
    expect(() => parseVoiceSampleDiagnostic({ ...record(), turnId: 'turn-1' })).toThrow()
  })

  it('rejects an unknown field on a timing event', () => {
    const rogue = record({ events: [{ kind: 'stage', stageId: 'tts-entered', offsetMs: 1, text: 'hello' } as never] })
    expect(() => parseVoiceSampleDiagnostic(rogue)).toThrow()
  })

  it('rejects a workload outside the condition-5 pair', () => {
    // Only the pair the delta is defined over may publish these rows; a
    // barge-in or first-chunk workload writing one would make the artifact a
    // general voice trace with no governing claim.
    expect(() => parseVoiceSampleDiagnostic(record({ workloadId: 'voice-first-tts-request' as never }))).toThrow()
    expect(isVoiceDiagnosticWorkloadId('voice-first-tts-request')).toBe(false)
    expect(isVoiceDiagnosticWorkloadId('voice-active-memory')).toBe(true)
    expect(isVoiceDiagnosticWorkloadId('voice-inert-control')).toBe(true)
  })

  it('rejects an unknown phase', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ phase: 'cooldown' as never }))).toThrow()
  })

  it('rejects an unknown outcome', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ outcome: 'wedged' as never }))).toThrow()
  })

  it('rejects an unknown stage id', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'stage', stageId: 'asr-entered', offsetMs: 1 } as never] }))).toThrow()
  })

  it('rejects an unknown memory method', () => {
    const rogue = record({ events: [{ kind: 'memory', method: 'cancelGeneration', callOrdinal: 0, transition: 'entered', offsetMs: 1 } as never] })
    expect(() => parseVoiceSampleDiagnostic(rogue)).toThrow()
  })

  it('rejects an unknown transition', () => {
    const rogue = record({ events: [{ kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'settled', offsetMs: 1 } as never] })
    expect(() => parseVoiceSampleDiagnostic(rogue)).toThrow()
  })

  it('rejects an unknown event kind', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'log', offsetMs: 1 } as never] }))).toThrow()
  })

  it('rejects a negative offset', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'stage', stageId: 'tts-entered', offsetMs: -0.001 }] }))).toThrow()
  })

  it('rejects a non-finite offset', () => {
    // JSON cannot carry Infinity, so this can only arrive from an in-memory
    // producer — which is exactly the caller `parse` is guarding against.
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'stage', stageId: 'tts-entered', offsetMs: Number.POSITIVE_INFINITY }] }))).toThrow()
    expect(() => parseVoiceSampleDiagnostic(record({ elapsedMs: Number.NaN }))).toThrow()
  })

  it('rejects a negative elapsed duration', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ elapsedMs: -1 }))).toThrow()
  })

  it('rejects events that run backwards in serialized order', () => {
    // Serialized order is the chronology. A consumer forced to sort first could
    // not tell a genuinely out-of-order observation from a producer bug.
    const backwards = record({
      events: [
        { kind: 'stage', stageId: 'tts-entered', offsetMs: 12 },
        { kind: 'stage', stageId: 'tts-completed', offsetMs: 11 },
      ],
    })
    expect(() => parseVoiceSampleDiagnostic(backwards)).toThrow()
  })

  it('accepts equal offsets, which two transitions on one clock reading produce', () => {
    const simultaneous = record({
      events: [
        { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'entered', offsetMs: 3 },
        { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'resolved', offsetMs: 3 },
      ],
    })
    expect(parseVoiceSampleDiagnostic(simultaneous).events).toHaveLength(2)
  })

  it('rejects a negative or non-integer ordinal', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ ordinal: -1 }))).toThrow()
    expect(() => parseVoiceSampleDiagnostic(record({ ordinal: 1.5 }))).toThrow()
  })

  it('rejects an unbounded ordinal or call ordinal', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ ordinal: 1_000_000 }))).toThrow()
    const rogue = record({ events: [{ kind: 'memory', method: 'recordPlayback', callOrdinal: 1_000_000, transition: 'entered', offsetMs: 1 }] })
    expect(() => parseVoiceSampleDiagnostic(rogue)).toThrow()
  })

  it('pairs repeated recordPlayback calls by call ordinal rather than by turn id', () => {
    const repeated = record({
      events: [
        { kind: 'memory', method: 'recordPlayback', callOrdinal: 0, transition: 'entered', offsetMs: 1 },
        { kind: 'memory', method: 'recordPlayback', callOrdinal: 0, transition: 'resolved', offsetMs: 2 },
        { kind: 'memory', method: 'recordPlayback', callOrdinal: 1, transition: 'entered', offsetMs: 3 },
        { kind: 'memory', method: 'recordPlayback', callOrdinal: 1, transition: 'resolved', offsetMs: 4 },
      ],
    })
    const parsed = parseVoiceSampleDiagnostic(repeated)
    expect(parsed.events.filter(event => event.kind === 'memory' && event.callOrdinal === 1)).toHaveLength(2)
    expect(JSON.stringify(parsed)).not.toMatch(/turnId/)
  })

  it('accepts canonically sorted, unique diagnostics and rejects any other order', () => {
    expect(parseVoiceSampleDiagnostic(record({ outcome: 'failed', diagnosticIds: ['context-deadline-exceeded'] })).diagnosticIds)
      .toEqual(['context-deadline-exceeded'])
    expect(() => parseVoiceSampleDiagnostic(record({ outcome: 'failed', diagnosticIds: ['generation-completion-not-observed', 'context-deadline-exceeded'] }))).toThrow()
    expect(() => parseVoiceSampleDiagnostic(record({ outcome: 'failed', diagnosticIds: ['context-deadline-exceeded', 'context-deadline-exceeded'] }))).toThrow()
    expect(canonicalVoiceDiagnostics(['generation-completion-not-observed', 'context-deadline-exceeded', 'context-deadline-exceeded']))
      .toEqual(['context-deadline-exceeded', 'generation-completion-not-observed'])
  })

  it('rejects an empty diagnostics array rather than treating it as unclassified', () => {
    // Absent means unclassified; present-but-empty would be a third state the
    // attempt and finding rows do not have.
    expect(() => parseVoiceSampleDiagnostic(record({ outcome: 'failed', diagnosticIds: [] }))).toThrow()
  })

  it('accepts a partial trail that stops at the boundary a wedged sample died inside', () => {
    // The completion-stall shape: `completeGeneration` entered and never left.
    // The truncation is the evidence, so it must parse rather than being
    // rejected as an incomplete record.
    const stalled = parseVoiceSampleDiagnostic(record({
      outcome: 'failed',
      diagnosticIds: ['generation-completion-not-observed'],
      events: [
        { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'entered', offsetMs: 0.5 },
        { kind: 'memory', method: 'admit', callOrdinal: 0, transition: 'resolved', offsetMs: 1 },
        { kind: 'stage', stageId: 'provider-entered', offsetMs: 2 },
        { kind: 'memory', method: 'completeGeneration', callOrdinal: 0, transition: 'entered', offsetMs: 30 },
      ],
    }))

    const memoryEvents = stalled.events.filter(event => event.kind === 'memory')
    const unresolved = memoryEvents.filter(event => event.transition === 'entered')
      .filter(entered => !memoryEvents.some(other => other.method === entered.method && other.callOrdinal === entered.callOrdinal && other.transition !== 'entered'))
    expect(unresolved.map(event => event.method)).toEqual(['completeGeneration'])
  })

  it('accepts an empty trail, which is what a sample that died before any boundary leaves', () => {
    expect(parseVoiceSampleDiagnostic(record({ outcome: 'failed', diagnosticIds: ['unknown-voice-sample-failure'], events: [] })).events).toEqual([])
  })

  it('carries an unknown-voice-sample-failure without describing it', () => {
    // The end-to-end seam cannot reach this id without a manufactured defect in
    // the driver itself, so it is exercised here: the point is that the closed
    // vocabulary can express "unclassified" without carrying an exception
    // message, and that nothing else rides along.
    const unclassified = record({ outcome: 'failed', diagnosticIds: ['unknown-voice-sample-failure'], events: [] })
    const serialized = voiceSampleDiagnosticsJsonl([unclassified])
    expect(serialized).toContain('unknown-voice-sample-failure')
    expect(parseVoiceSampleDiagnosticsJsonl(serialized)).toEqual([unclassified])
  })

  it('carries no snowflake, path, or free-form text beyond the contract digest', () => {
    const serialized = voiceSampleDiagnosticsJsonl([record(), record({ outcome: 'failed', diagnosticIds: ['context-deadline-exceeded'] })])
    expect(serialized).not.toMatch(/(?<![\d.])\d{17,20}(?!\d)/)
    expect(serialized).not.toMatch(/[A-Z]:\\|\/[a-z]+\//)
    const digests = serialized.match(/[0-9a-f]{64}/g) ?? []
    expect(new Set(digests)).toEqual(new Set([WORKLOAD_CATALOG_DIGEST]))
  })

  it('round-trips authority operations nested inside their issuing memory call', () => {
    // The variant that makes a 480 ms `recordPlayback` attributable to one
    // durable write rather than to the call that contains four of them.
    const nested = record({
      events: [
        { kind: 'memory', method: 'recordPlayback', callOrdinal: 0, transition: 'entered', offsetMs: 18.6 },
        { kind: 'authority', operation: 'appendSegments', callOrdinal: 0, transition: 'entered', offsetMs: 18.6 },
        { kind: 'authority', operation: 'appendSegments', callOrdinal: 0, transition: 'resolved', offsetMs: 20.8 },
        { kind: 'authority', operation: 'transitionDelivery', callOrdinal: 0, transition: 'entered', offsetMs: 23.7 },
        { kind: 'authority', operation: 'transitionDelivery', callOrdinal: 0, transition: 'resolved', offsetMs: 25.1 },
        { kind: 'authority', operation: 'transitionDelivery', callOrdinal: 1, transition: 'entered', offsetMs: 25.1 },
        { kind: 'authority', operation: 'transitionDelivery', callOrdinal: 1, transition: 'resolved', offsetMs: 27.8 },
        { kind: 'memory', method: 'recordPlayback', callOrdinal: 0, transition: 'resolved', offsetMs: 27.8 },
      ],
    })
    expect(parseVoiceSampleDiagnostic(nested).events).toHaveLength(8)
    expect(parseVoiceSampleDiagnosticsJsonl(voiceSampleDiagnosticsJsonl([nested]))).toEqual([nested])
  })

  it('rejects an unknown authority operation or a stray field on one', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'authority', operation: 'vacuum', callOrdinal: 0, transition: 'entered', offsetMs: 1 } as never] }))).toThrow()
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'authority', operation: 'appendSegments', callOrdinal: 0, transition: 'entered', offsetMs: 1, segmentId: 'voice:t:0' } as never] }))).toThrow()
    // `method` belongs to the memory variant; the two must not blur.
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'authority', method: 'appendSegments', callOrdinal: 0, transition: 'entered', offsetMs: 1 } as never] }))).toThrow()
  })

  it('records an authority rejection without describing it', () => {
    const rejected = record({
      outcome: 'failed',
      diagnosticIds: ['context-preparation-failed'],
      events: [
        { kind: 'memory', method: 'prepareGeneration', callOrdinal: 0, transition: 'entered', offsetMs: 1 },
        { kind: 'authority', operation: 'beginGeneration', callOrdinal: 0, transition: 'entered', offsetMs: 2 },
        { kind: 'authority', operation: 'beginGeneration', callOrdinal: 0, transition: 'rejected', offsetMs: 9 },
        { kind: 'memory', method: 'prepareGeneration', callOrdinal: 0, transition: 'rejected', offsetMs: 9 },
      ],
    })
    const serialized = voiceSampleDiagnosticsJsonl([rejected])
    expect(parseVoiceSampleDiagnosticsJsonl(serialized)).toEqual([rejected])
    expect(serialized).not.toMatch(/message|error|stack/i)
  })

  it('round-trips durable statements nested inside the authority operation that ran them', () => {
    // The variant that makes a 369 ms `transitionDelivery` attributable to its
    // lock acquisition, its statements, or its durable commit.
    const nested = record({
      events: [
        { kind: 'authority', operation: 'transitionDelivery', callOrdinal: 1, transition: 'entered', offsetMs: 25.1 },
        { kind: 'durable', statement: 'begin', callOrdinal: 5, transition: 'entered', offsetMs: 25.2 },
        { kind: 'durable', statement: 'begin', callOrdinal: 5, transition: 'resolved', offsetMs: 25.3 },
        { kind: 'durable', statement: 'commit', callOrdinal: 5, transition: 'entered', offsetMs: 25.9 },
        { kind: 'durable', statement: 'commit', callOrdinal: 5, transition: 'resolved', offsetMs: 27.7 },
        { kind: 'authority', operation: 'transitionDelivery', callOrdinal: 1, transition: 'resolved', offsetMs: 27.8 },
      ],
    })
    expect(parseVoiceSampleDiagnostic(nested).events).toHaveLength(6)
    expect(parseVoiceSampleDiagnosticsJsonl(voiceSampleDiagnosticsJsonl([nested]))).toEqual([nested])
  })

  it('rejects an unknown statement, a stray field, or SQL smuggled onto one', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'durable', statement: 'vacuum', callOrdinal: 0, transition: 'entered', offsetMs: 1 } as never] }))).toThrow()
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'durable', statement: 'begin', callOrdinal: 0, transition: 'entered', offsetMs: 1, sql: 'BEGIN IMMEDIATE' } as never] }))).toThrow()
    // `operation` belongs to the authority variant; the two must not blur.
    expect(() => parseVoiceSampleDiagnostic(record({ events: [{ kind: 'durable', operation: 'begin', callOrdinal: 0, transition: 'entered', offsetMs: 1 } as never] }))).toThrow()
  })

  it('records a rolled-back transaction without describing why', () => {
    const rolledBack = record({
      outcome: 'failed',
      diagnosticIds: ['context-preparation-failed'],
      events: [
        { kind: 'authority', operation: 'beginGeneration', callOrdinal: 0, transition: 'entered', offsetMs: 2 },
        { kind: 'durable', statement: 'begin', callOrdinal: 0, transition: 'entered', offsetMs: 2.1 },
        { kind: 'durable', statement: 'begin', callOrdinal: 0, transition: 'resolved', offsetMs: 2.2 },
        { kind: 'durable', statement: 'rollback', callOrdinal: 0, transition: 'entered', offsetMs: 8.5 },
        { kind: 'durable', statement: 'rollback', callOrdinal: 0, transition: 'resolved', offsetMs: 8.9 },
        { kind: 'authority', operation: 'beginGeneration', callOrdinal: 0, transition: 'rejected', offsetMs: 9 },
      ],
    })
    const serialized = voiceSampleDiagnosticsJsonl([rolledBack])
    expect(parseVoiceSampleDiagnosticsJsonl(serialized)).toEqual([rolledBack])
    expect(serialized).not.toMatch(/message|error|stack|SELECT|INSERT|UPDATE/i)
  })

  it('classifies only the transaction triple, and never echoes the statement', () => {
    expect(classifyDurableStatement('BEGIN IMMEDIATE')).toBe('begin')
    expect(classifyDurableStatement('  begin exclusive ')).toBe('begin')
    expect(classifyDurableStatement('COMMIT')).toBe('commit')
    expect(classifyDurableStatement('ROLLBACK')).toBe('rollback')
    // Anything else collapses to the catch-all rather than widening the
    // vocabulary or carrying its own text out of the classifier.
    expect(classifyDurableStatement('PRAGMA journal_mode = WAL')).toBe('other')
    expect(classifyDurableStatement(`DELETE FROM memory_search_latin`)).toBe('other')
    expect(classifyDurableStatement('')).toBe('other')
  })

  it('rejects a row from a drifted schema version or contract', () => {
    expect(() => parseVoiceSampleDiagnostic(record({ schemaVersion: 1 as never }))).toThrow()
    expect(() => parseVoiceSampleDiagnostic(record({ contractId: 'performance-v1' as never }))).toThrow()
    expect(() => parseVoiceSampleDiagnostic(record({ contractDigest: 'not-a-digest' }))).toThrow()
  })
})
