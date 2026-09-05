/**
 * Attributable inbound events (IMP-106; ADR-006, ADR-008, ADR-013, ADR-015).
 *
 * Three properties, each of which fixes a specific confirmed defect:
 *
 * - The payload envelope is immutable and the lifecycle is a separate append
 *   record, so "immutable raw events" and "delivery status changes" stop
 *   contradicting each other (FIND-018).
 * - Every speaker contribution is its own event. A group turn is N events, not
 *   one event authored by `Discord group` (FIND-006).
 * - An append never takes an expected version. A concurrent append is not a
 *   conflict; the snapshot version is evidence of what generation saw, not a
 *   lock (FIND-017, ADR-015).
 */

import type { EventActor } from './identity'
import type { EventId, LogicalRoomId, PhysicalRoomId, RequestId, Timestamp } from './ids'

import { MemoryError } from './errors'
import { isPersonScoped } from './identity'

/** What kind of inbound occurrence this is. */
export type InboundEventKind = 'user_text' | 'user_voice' | 'command' | 'system'

/** Every kind the contract accepts. An unknown kind is rejected, never guessed. */
export const INBOUND_EVENT_KINDS: readonly InboundEventKind[] = Object.freeze([
  'user_text',
  'user_voice',
  'command',
  'system',
] as const)

/** Kinds that assert something about a person and therefore need attribution. */
const PERSON_SCOPED_KINDS: readonly InboundEventKind[] = Object.freeze(['user_text', 'user_voice', 'command'] as const)

/** How long a payload class may be retained. Resolved by governance policy, carried here. */
export type RetentionClass = 'transcript' | 'command' | 'systemMetadata'

/**
 * The immutable content of an event.
 *
 * `content` becomes `undefined` after a governed redaction — the row survives
 * so the causal graph stays intact, but the personal payload is gone
 * (ADR-012, TEST-DELETE-RAW-001).
 */
export interface EventPayload {
  content?: string
  /** BCP-47-ish language tag as detected, e.g. `ja`. Never inferred from the speaker. */
  lang?: string
  /** Reference to out-of-band media; the media itself is not stored inline. */
  mediaRef?: string
  /** True once the payload has been redacted by a governance action. */
  redacted: boolean
}

/** Largest accepted payload. Bounded so one event cannot blow a context window or a row. */
export const MAX_EVENT_CONTENT_LENGTH = 16_000

/** An immutable, attributable inbound event. */
export interface InboundEventEnvelope {
  eventId: EventId
  /** Caller-supplied de-duplication key; a retry with the same key is the same event. */
  idempotencyKey: RequestId
  kind: InboundEventKind
  actor: EventActor
  physicalRoomId: PhysicalRoomId
  logicalRoomId: LogicalRoomId
  /** Logical-room append version allocated with this event. */
  roomVersion?: number
  /** When it happened on Discord. */
  occurredAt: Timestamp
  /** When the bot durably recorded it. Never used as causal evidence. */
  recordedAt: Timestamp
  payload: EventPayload
  retentionClass: RetentionClass
}

/** Lifecycle states of an event, tracked separately from its payload. */
export type EventLifecycleState = 'recorded' | 'superseded' | 'redacted' | 'tombstoned'

/**
 * Legal lifecycle transitions.
 *
 * `tombstoned` is terminal: once a subject's erasure has been executed, nothing
 * may bring the row back into a servable state.
 */
export const EVENT_LIFECYCLE_TRANSITIONS: Readonly<Record<EventLifecycleState, readonly EventLifecycleState[]>> = Object.freeze({
  recorded: Object.freeze(['superseded', 'redacted', 'tombstoned'] as const),
  superseded: Object.freeze(['redacted', 'tombstoned'] as const),
  redacted: Object.freeze(['tombstoned'] as const),
  tombstoned: Object.freeze([] as const),
})

/** An append-only record of one lifecycle change. */
export interface EventLifecycleTransition {
  eventId: EventId
  from: EventLifecycleState
  to: EventLifecycleState
  at: Timestamp
  reason: string
}

/** True when `from -> to` is a legal event lifecycle transition. */
export function canTransitionEvent(from: EventLifecycleState, to: EventLifecycleState): boolean {
  return EVENT_LIFECYCLE_TRANSITIONS[from].includes(to)
}

/** Build a transition record, rejecting illegal moves. */
export function transitionEvent(eventId: EventId, from: EventLifecycleState, to: EventLifecycleState, at: Timestamp, reason: string): EventLifecycleTransition {
  if (!canTransitionEvent(from, to)) {
    throw new MemoryError('ILLEGAL_STATE_TRANSITION', `event lifecycle ${from} -> ${to} is not permitted`, {
      retryable: false,
      details: { eventId, from, to },
    })
  }
  return { eventId, from, to, at, reason }
}

/**
 * The input an adapter hands to `appendEvent`.
 *
 * Note what is *not* here: there is no `expectedRoomVersion`. Appends are
 * unconditional by design (ADR-015); {@link assertAppendable} actively rejects
 * any attempt to smuggle one in.
 */
export interface AppendEventInput {
  idempotencyKey: RequestId
  kind: InboundEventKind
  actor: EventActor
  physicalRoomId: PhysicalRoomId
  logicalRoomId: LogicalRoomId
  occurredAt: Timestamp
  payload: Omit<EventPayload, 'redacted'>
  retentionClass: RetentionClass
}

/**
 * Property names that would turn an append into a compare-and-swap.
 *
 * Checked at runtime rather than trusted to the type system, because the
 * realistic failure is an adapter passing a wider object it built for its own
 * store. A rejected append is loud; a silently honoured CAS drops valid
 * responses whenever a second person speaks (FIND-017, SCN-006).
 */
const FORBIDDEN_APPEND_PRECONDITIONS: readonly string[] = Object.freeze([
  'expectedVersion',
  'expectedRoomVersion',
  'ifMatch',
  'snapshotVersion',
] as const)

/**
 * Validate an append before it reaches storage.
 *
 * Throws on the first problem: unlike flag validation, there is no operator
 * reading a list here — the caller is code, and it needs one actionable code.
 */
export function assertAppendable(input: AppendEventInput): void {
  for (const forbidden of FORBIDDEN_APPEND_PRECONDITIONS) {
    if (forbidden in input) {
      throw new MemoryError('UNSUPPORTED_APPEND_PRECONDITION', `appendEvent does not accept ${forbidden}: a concurrent append is not a conflict (ADR-015)`, {
        retryable: false,
        details: { precondition: forbidden },
      })
    }
  }

  if (!INBOUND_EVENT_KINDS.includes(input.kind)) {
    throw new MemoryError('UNKNOWN_EVENT_KIND', `unknown event kind; kinds are negotiated explicitly, never inferred`, {
      retryable: false,
      details: { kind: String(input.kind) },
    })
  }

  if (PERSON_SCOPED_KINDS.includes(input.kind)) {
    const content = input.payload.content ?? ''
    if (content.trim().length === 0) {
      throw new MemoryError('EMPTY_CONTENT', `${input.kind} events require content; an empty utterance is not evidence of anything`, {
        retryable: false,
      })
    }
    if (content.length > MAX_EVENT_CONTENT_LENGTH) {
      throw new MemoryError('PAYLOAD_TOO_LARGE', `event content exceeds ${MAX_EVENT_CONTENT_LENGTH} characters`, {
        retryable: false,
        details: { length: content.length },
      })
    }
  }
}

/**
 * Whether this event may contribute to person-scoped memory.
 *
 * An anonymous actor's event can still be retained as room evidence, but it
 * must never reach a person record — that is the fail-safe for a cache miss
 * (REQ-ID-003, SCN-012, SCN-018).
 */
export function isPersonScopedEvent(envelope: InboundEventEnvelope): boolean {
  return isPersonScoped(envelope.actor)
}

/**
 * Guard a person-scoped write.
 *
 * Separate from {@link assertAppendable} because appending an anonymous event
 * is legal; *attributing a fact to a person* from one is not.
 */
export function assertPersonScopedWritable(envelope: InboundEventEnvelope): void {
  if (!isPersonScopedEvent(envelope)) {
    throw new MemoryError('ANONYMOUS_ACTOR_NOT_PERSON_SCOPED', 'an event without a durable Discord user id cannot be written to person-scoped memory', {
      retryable: false,
      details: { eventId: envelope.eventId },
    })
  }
}

/**
 * Order events for context assembly.
 *
 * `occurredAt` first, `eventId` as the deterministic tie-break. `recordedAt` is
 * deliberately not used: database write order is not causal visibility
 * (REQ-EVENT-009, SCN-033), and two events recorded out of order must still
 * read back in the order they actually happened.
 */
export function orderEvents(events: readonly InboundEventEnvelope[]): readonly InboundEventEnvelope[] {
  return [...events].sort((a, b) => {
    const byTime = Date.parse(a.occurredAt) - Date.parse(b.occurredAt)
    return byTime !== 0 ? byTime : a.eventId.localeCompare(b.eventId)
  })
}
