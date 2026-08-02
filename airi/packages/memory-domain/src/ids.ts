/**
 * Branded identifiers for the shared-memory domain (IMP-101).
 *
 * Every id in this domain is a string at runtime, which makes them trivially
 * interchangeable by accident — passing a `LogicalRoomId` where an `EventId`
 * belongs would compile and then quietly corrupt a causal edge. The brands
 * exist only at the type level and cost nothing at runtime.
 *
 * Ids are *minted by adapters*, not here: generation needs a clock or a random
 * source, and a domain package that owns neither stays deterministic and
 * testable. This module owns the shape and the validation.
 */

import { MemoryError } from './errors'

declare const brandTag: unique symbol

/** Attach a compile-time-only tag to an underlying primitive. */
type Branded<T, Tag extends string> = T & { readonly [brandTag]: Tag }

/** Stable internal surrogate for a person. Never printed, never spoken. */
export type PersonId = Branded<string, 'PersonId'>
/** An immutable inbound event. */
export type EventId = Branded<string, 'EventId'>
/** One attempt to generate assistant content. */
export type GenerationId = Branded<string, 'GenerationId'>
/** One contiguous piece of generated output (a message chunk or a spoken clause). */
export type SegmentId = Branded<string, 'SegmentId'>
/** One attempt to put a segment onto a transport. */
export type DeliveryId = Branded<string, 'DeliveryId'>
/** A conversation context, which may span more than one Discord channel. */
export type LogicalRoomId = Branded<string, 'LogicalRoomId'>
/** A concrete Discord place (channel, thread, voice channel, DM). */
export type PhysicalRoomId = Branded<string, 'PhysicalRoomId'>
/** A physical-to-logical room binding. */
export type BindingId = Branded<string, 'BindingId'>
/** A scoped alias record. */
export type AliasId = Branded<string, 'AliasId'>
/** A durable fact. */
export type FactId = Branded<string, 'FactId'>
/** A stored summary. */
export type SummaryId = Branded<string, 'SummaryId'>
/** A governance (redact / tombstone / purge) action. */
export type GovernanceId = Branded<string, 'GovernanceId'>
/** The bot persona a memory belongs to. */
export type CharacterId = Branded<string, 'CharacterId'>
/** Caller-supplied de-duplication key for a write. */
export type RequestId = Branded<string, 'RequestId'>

/** Every branded id in this domain. */
export type MemoryId
  = | PersonId | EventId | GenerationId | SegmentId | DeliveryId
    | LogicalRoomId | PhysicalRoomId | BindingId | AliasId
    | FactId | SummaryId | GovernanceId | CharacterId | RequestId

/**
 * Longest id we accept. Ids reach log lines, prompt manifests, and (in the
 * remote transport) URLs; an unbounded id is a denial-of-service and a log
 * injection vector at the same time.
 */
const MAX_ID_LENGTH = 128

/**
 * An id must be a single non-empty token. Whitespace is rejected because a
 * whitespace-bearing "id" is almost always a display name that leaked into an
 * identifier position — the exact confusion that lets `Discord group` become a
 * durable author (ADR-006).
 */
const ID_PATTERN = /^[\w:.-]{1,128}$/

/** True when `value` is shaped like a domain id. */
export function isValidId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value)
}

/**
 * Brand a raw string after validating its shape.
 *
 * Throws {@link MemoryError} with `INVALID_ID` rather than returning a result
 * type: an id that fails this check is a programming error in the adapter, not
 * a runtime condition the caller can recover from.
 */
export function asId<T extends MemoryId>(value: string, kind: string): T {
  if (!isValidId(value)) {
    throw new MemoryError('INVALID_ID', `${kind} must be a non-empty token of [A-Za-z0-9_:.-] up to ${MAX_ID_LENGTH} characters`, {
      retryable: false,
      details: { kind, length: value.length },
    })
  }
  return value as T
}

export const asPersonId = (value: string): PersonId => asId<PersonId>(value, 'PersonId')
export const asEventId = (value: string): EventId => asId<EventId>(value, 'EventId')
export const asGenerationId = (value: string): GenerationId => asId<GenerationId>(value, 'GenerationId')
export const asSegmentId = (value: string): SegmentId => asId<SegmentId>(value, 'SegmentId')
export const asDeliveryId = (value: string): DeliveryId => asId<DeliveryId>(value, 'DeliveryId')
export const asLogicalRoomId = (value: string): LogicalRoomId => asId<LogicalRoomId>(value, 'LogicalRoomId')
export const asPhysicalRoomId = (value: string): PhysicalRoomId => asId<PhysicalRoomId>(value, 'PhysicalRoomId')
export const asBindingId = (value: string): BindingId => asId<BindingId>(value, 'BindingId')
export const asAliasId = (value: string): AliasId => asId<AliasId>(value, 'AliasId')
export const asFactId = (value: string): FactId => asId<FactId>(value, 'FactId')
export const asSummaryId = (value: string): SummaryId => asId<SummaryId>(value, 'SummaryId')
export const asGovernanceId = (value: string): GovernanceId => asId<GovernanceId>(value, 'GovernanceId')
export const asCharacterId = (value: string): CharacterId => asId<CharacterId>(value, 'CharacterId')
export const asRequestId = (value: string): RequestId => asId<RequestId>(value, 'RequestId')

/**
 * RFC 3339 UTC instant, as a string.
 *
 * Stored as a string rather than a `Date` so that a record round-trips through
 * SQLite, JSON, and the HTTP DTO without a timezone ever being reinterpreted.
 */
export type Timestamp = Branded<string, 'Timestamp'>

const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/

/** True when `value` is an RFC 3339 instant expressed in UTC (`Z`). */
export function isTimestamp(value: string): boolean {
  return RFC3339_UTC.test(value) && !Number.isNaN(Date.parse(value))
}

/**
 * Brand an RFC 3339 UTC string.
 *
 * Local-offset forms such as `2026-08-02T00:00:00+09:00` are rejected: two
 * adapters disagreeing about the local zone would order events wrongly, and
 * event order is the backbone of every replay in this system.
 */
export function asTimestamp(value: string): Timestamp {
  if (!isTimestamp(value)) {
    throw new MemoryError('INVALID_TIMESTAMP', 'timestamps must be RFC 3339 instants in UTC, e.g. 2026-08-02T00:00:00Z', {
      retryable: false,
      details: { value },
    })
  }
  return value as Timestamp
}

/** Format an epoch-milliseconds value as a domain {@link Timestamp}. */
export function timestampFromEpochMs(epochMs: number): Timestamp {
  if (!Number.isFinite(epochMs))
    throw new MemoryError('INVALID_TIMESTAMP', 'epoch milliseconds must be finite', { retryable: false })
  return new Date(epochMs).toISOString() as Timestamp
}

/** Compare two timestamps chronologically; suitable for `Array.prototype.sort`. */
export function compareTimestamps(a: Timestamp, b: Timestamp): number {
  return Date.parse(a) - Date.parse(b)
}
