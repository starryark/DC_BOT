import type { AppendEventInput } from './events'

import { describe, expect, it } from 'vitest'

import { buildCausalEdges, causeEventIds, generationsCausedBy, triggerEventIds } from './causality'
import {
  assertAppendable,
  assertPersonScopedWritable,
  canTransitionEvent,
  isPersonScopedEvent,
  MAX_EVENT_CONTENT_LENGTH,
  orderEvents,
  transitionEvent,
} from './events'
import {
  FIXTURE_ALEX_ONE,
  FIXTURE_GENERATION_ID,
  FIXTURE_GROUP_CAUSAL_EDGES,
  FIXTURE_GROUP_TURN_EVENTS,
  FIXTURE_VOICE_LOCATION,
  FIXTURE_VOICE_ROOM_ID,
} from './fixtures'
import { asEventId, asGenerationId, asRequestId, asTimestamp } from './ids'
import { physicalRoomIdOf } from './rooms'

function appendInput(overrides: Partial<AppendEventInput> = {}): AppendEventInput {
  return {
    idempotencyKey: asRequestId('req-1'),
    kind: 'user_voice',
    actor: FIXTURE_ALEX_ONE,
    physicalRoomId: physicalRoomIdOf(FIXTURE_VOICE_LOCATION),
    logicalRoomId: FIXTURE_VOICE_ROOM_ID,
    occurredAt: asTimestamp('2026-08-02T10:00:00.000Z'),
    payload: { content: 'hello', lang: 'en' },
    retentionClass: 'transcript',
    ...overrides,
  }
}

describe('append validation', () => {
  it('accepts a well-formed voice event', () => {
    expect(() => assertAppendable(appendInput())).not.toThrow()
  })

  it('rejects an empty user utterance', () => {
    expect(() => assertAppendable(appendInput({ payload: { content: '   ' } }))).toThrowError(/require content/)
  })

  it('rejects content beyond the bound', () => {
    const payload = { content: 'x'.repeat(MAX_EVENT_CONTENT_LENGTH + 1) }
    expect(() => assertAppendable(appendInput({ payload }))).toThrowError(/exceeds/)
  })

  it('rejects an unnegotiated event kind rather than guessing', () => {
    const input = appendInput()
    expect(() => assertAppendable({ ...input, kind: 'telepathy' as AppendEventInput['kind'] }))
      .toThrowError(/unknown event kind/)
  })

  it('allows a system event with no content', () => {
    expect(() => assertAppendable(appendInput({ kind: 'system', payload: {} }))).not.toThrow()
  })
})

// FIND-017 / SCN-006 / TEST-CONCURRENCY-001: an append is never a compare-and-swap.
describe('appends are unconditional (ADR-015)', () => {
  it.each(['expectedVersion', 'expectedRoomVersion', 'ifMatch', 'snapshotVersion'])(
    'rejects an append carrying %s',
    (precondition) => {
      const smuggled = { ...appendInput(), [precondition]: 7 } as AppendEventInput
      expect(() => assertAppendable(smuggled)).toThrowError(/not a conflict/)
    },
  )

  it('accepts concurrent appends from three speakers with no ordering precondition', () => {
    for (const event of FIXTURE_GROUP_TURN_EVENTS) {
      expect(() => assertAppendable({
        idempotencyKey: event.idempotencyKey,
        kind: event.kind,
        actor: event.actor,
        physicalRoomId: event.physicalRoomId,
        logicalRoomId: event.logicalRoomId,
        occurredAt: event.occurredAt,
        payload: { content: event.payload.content },
        retentionClass: event.retentionClass,
      })).not.toThrow()
    }
  })
})

describe('person-scoped writes (REQ-ID-003)', () => {
  it('permits a write for an attributed event', () => {
    expect(isPersonScopedEvent(FIXTURE_GROUP_TURN_EVENTS[0])).toBe(true)
    expect(() => assertPersonScopedWritable(FIXTURE_GROUP_TURN_EVENTS[0])).not.toThrow()
  })

  // SCN-012 / SCN-018: a cache miss must not fall back to a display-name key.
  it('refuses a person-scoped write for an anonymous event', () => {
    const anonymous = {
      ...FIXTURE_GROUP_TURN_EVENTS[0],
      actor: { kind: 'anonymous' as const, displayNameAtEvent: 'Alex', observedAt: FIXTURE_GROUP_TURN_EVENTS[0].occurredAt, reason: 'cacheMiss' as const },
    }
    expect(isPersonScopedEvent(anonymous)).toBe(false)
    expect(() => assertPersonScopedWritable(anonymous)).toThrowError(/cannot be written to person-scoped memory/)
  })
})

// FIND-018 / TEST-AUDIT-001: payload immutability and lifecycle are separate.
describe('event lifecycle (ADR-008)', () => {
  it('permits recorded -> redacted -> tombstoned', () => {
    expect(canTransitionEvent('recorded', 'redacted')).toBe(true)
    expect(canTransitionEvent('redacted', 'tombstoned')).toBe(true)
  })

  it('treats tombstoned as terminal', () => {
    expect(canTransitionEvent('tombstoned', 'recorded')).toBe(false)
    expect(() => transitionEvent(asEventId('event-1'), 'tombstoned', 'recorded', asTimestamp('2026-08-02T10:00:00.000Z'), 'oops'))
      .toThrowError(/not permitted/)
  })

  it('records the reason on every transition', () => {
    const transition = transitionEvent(asEventId('event-1'), 'recorded', 'redacted', asTimestamp('2026-08-02T10:00:00.000Z'), 'subject erasure')
    expect(transition).toEqual({
      eventId: 'event-1',
      from: 'recorded',
      to: 'redacted',
      at: '2026-08-02T10:00:00.000Z',
      reason: 'subject erasure',
    })
  })
})

// REQ-EVENT-009 / SCN-033: database order is not causal visibility.
describe('event ordering', () => {
  it('orders by when it happened, not when it was recorded', () => {
    const late = { ...FIXTURE_GROUP_TURN_EVENTS[0], recordedAt: asTimestamp('2026-08-02T11:00:00.000Z') }
    const ordered = orderEvents([FIXTURE_GROUP_TURN_EVENTS[2], late, FIXTURE_GROUP_TURN_EVENTS[1]])
    expect(ordered.map(event => event.eventId)).toEqual(['event-alex-one', 'event-alex-two', 'event-bob'])
  })

  it('breaks ties deterministically by event id', () => {
    const a = { ...FIXTURE_GROUP_TURN_EVENTS[0], eventId: asEventId('event-b') }
    const b = { ...FIXTURE_GROUP_TURN_EVENTS[0], eventId: asEventId('event-a') }
    expect(orderEvents([a, b]).map(event => event.eventId)).toEqual(['event-a', 'event-b'])
  })
})

// TEST-ATTRIB-001 / TEST-CAUSAL-001 / SCN-010.
describe('many-to-many causality (ADR-014)', () => {
  it('links one generation to all three speakers', () => {
    const edges = buildCausalEdges(FIXTURE_GENERATION_ID, FIXTURE_GROUP_TURN_EVENTS.map(event => ({
      inboundEventId: event.eventId,
      role: 'trigger' as const,
    })))
    expect(edges).toHaveLength(3)
    expect(triggerEventIds(edges)).toEqual(['event-alex-one', 'event-alex-two', 'event-bob'])
  })

  it('keeps every speaker rather than the first one only', () => {
    // The current runtime uses `input.utterances[0]` and drops the rest
    // (conversation-controller.ts:269). The contract cannot express that.
    expect(causeEventIds(FIXTURE_GROUP_CAUSAL_EDGES)).toHaveLength(FIXTURE_GROUP_TURN_EVENTS.length)
  })

  it('rejects a generation with no causes', () => {
    expect(() => buildCausalEdges(FIXTURE_GENERATION_ID, [])).toThrowError(/at least one cause/)
  })

  it('rejects a generation whose causes are all context, with no trigger', () => {
    expect(() => buildCausalEdges(FIXTURE_GENERATION_ID, [{ inboundEventId: asEventId('event-bob'), role: 'context' }]))
      .toThrowError(/at least one trigger/)
  })

  it('rejects an unknown cause role', () => {
    const bad = [{ inboundEventId: asEventId('event-bob'), role: 'vibes' as 'trigger' }]
    expect(() => buildCausalEdges(FIXTURE_GENERATION_ID, bad)).toThrowError(/unknown cause role/)
  })

  it('is idempotent when a retry re-declares the same causes', () => {
    const declarations = [
      { inboundEventId: asEventId('event-bob'), role: 'trigger' as const },
      { inboundEventId: asEventId('event-bob'), role: 'trigger' as const },
    ]
    expect(buildCausalEdges(FIXTURE_GENERATION_ID, declarations)).toHaveLength(1)
  })

  it('allows one event under two roles', () => {
    const declarations = [
      { inboundEventId: asEventId('event-bob'), role: 'trigger' as const },
      { inboundEventId: asEventId('event-bob'), role: 'correction' as const },
    ]
    expect(buildCausalEdges(FIXTURE_GENERATION_ID, declarations)).toHaveLength(2)
  })

  // TEST-CAUSAL-002: one event can cause several generations.
  it('traverses back from one event to every generation it caused', () => {
    const second = asGenerationId('generation-followup')
    const edges = [
      ...FIXTURE_GROUP_CAUSAL_EDGES,
      { generationId: second, inboundEventId: asEventId('event-bob'), role: 'trigger' as const },
    ]
    expect(generationsCausedBy(edges, asEventId('event-bob'))).toEqual([FIXTURE_GENERATION_ID, second])
    expect(generationsCausedBy(edges, asEventId('event-alex-one'))).toEqual([FIXTURE_GENERATION_ID])
  })
})
