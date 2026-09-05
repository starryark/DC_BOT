/* eslint-disable antfu/consistent-list-newline, antfu/if-newline, perfectionist/sort-named-imports, style/brace-style, style/max-statements-per-line, ts/consistent-type-definitions */
import type { DatabaseSync } from 'node:sqlite'

import type { AppendEventInput, CharacterId, EventId, EventLifecycleState, EventLifecycleTransition, InboundEventEnvelope, LogicalRoomId, PhysicalRoomId, Timestamp } from '@proj-airi/memory-domain'

import { createHash, randomUUID } from 'node:crypto'

import { asEventId, asLogicalRoomId, asPersonId, asPhysicalRoomId, asRequestId, asTimestamp, assertAppendable, attributedActor, MemoryError, transitionEvent } from '@proj-airi/memory-domain'

export interface AppendEventResult { envelope: InboundEventEnvelope, deduplicated: boolean }
export interface ExactEventScope { logicalRoomId: LogicalRoomId, physicalRoomId: PhysicalRoomId }

type EventRow = Record<string, string | number | null>
type LifecycleRow = { event_id: string, from_state: EventLifecycleState, to_state: EventLifecycleState, transitioned_at: string, reason: string }

function persistence(message: string, cause: unknown): never {
  if (cause instanceof MemoryError)
    throw cause
  throw new MemoryError('PERSISTENCE_FAILED', message, { cause })
}

function inputHash(input: AppendEventInput): string {
  return createHash('sha256').update(JSON.stringify({ kind: input.kind, actor: input.actor, physicalRoomId: input.physicalRoomId, logicalRoomId: input.logicalRoomId, occurredAt: input.occurredAt, payload: input.payload, retentionClass: input.retentionClass })).digest('hex')
}

function envelope(row: EventRow): InboundEventEnvelope {
  const actor = JSON.parse(String(row.actor_json)) as InboundEventEnvelope['actor']
  if (actor.kind === 'attributed')
    attributedActor(asPersonId(String(row.author_person_id)), actor.snapshot)
  return {
    eventId: asEventId(String(row.event_id)), idempotencyKey: asRequestId(String(row.idempotency_key)), kind: String(row.event_kind) as InboundEventEnvelope['kind'], actor,
    physicalRoomId: asPhysicalRoomId(String(row.physical_room_id)), logicalRoomId: asLogicalRoomId(String(row.logical_room_id)), roomVersion: Number(row.room_sequence), occurredAt: asTimestamp(String(row.occurred_at)), recordedAt: asTimestamp(String(row.recorded_at)),
    payload: JSON.parse(String(row.payload_json)) as InboundEventEnvelope['payload'], retentionClass: String(row.retention_class) as InboundEventEnvelope['retentionClass'],
  }
}

/** Stores immutable attributable inbound envelopes and separate append-only lifecycle evidence. */
export class EventRepository {
  constructor(private readonly db: DatabaseSync, private readonly id: () => string = randomUUID, private readonly now: () => Timestamp = () => asTimestamp(new Date().toISOString())) {}

  append(input: AppendEventInput): AppendEventResult {
    assertAppendable(input)
    const hash = inputHash(input)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const retry = this.db.prepare('SELECT * FROM inbound_event_records WHERE idempotency_key=?').get(input.idempotencyKey) as EventRow | undefined
      if (retry) {
        if (retry.envelope_hash !== hash)
          throw new MemoryError('POLICY_VIOLATION', 'event idempotency key was reused with conflicting input', { details: { idempotencyKey: input.idempotencyKey } })
        this.db.exec('COMMIT')
        return { envelope: envelope(retry), deduplicated: true }
      }
      this.assertExactWritableScope(input.logicalRoomId, input.physicalRoomId)
      if (input.actor.kind === 'attributed') {
        attributedActor(input.actor.personId, input.actor.snapshot)
        const person = this.db.prepare('SELECT discord_user_id FROM people WHERE person_id=?').get(input.actor.personId) as { discord_user_id: string } | undefined
        if (!person || input.actor.snapshot.platformUserId !== person.discord_user_id)
          throw new MemoryError('INVALID_ACTOR', 'event actor does not match the durable person identity')
      }
      const allocated = this.db.prepare('UPDATE logical_rooms SET current_version=current_version+1,next_sequence=next_sequence+1 WHERE logical_room_id=? RETURNING current_version').get(input.logicalRoomId) as { current_version: number } | undefined
      if (!allocated)
        throw new MemoryError('ROOM_NOT_FOUND', 'logical room does not exist')
      const eventId = asEventId(this.id()); const recordedAt = this.now()
      this.db.prepare('INSERT INTO inbound_event_records(event_id,idempotency_key,event_kind,actor_kind,author_person_id,actor_json,physical_room_id,logical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(eventId, input.idempotencyKey, input.kind, input.actor.kind, input.actor.kind === 'attributed' ? input.actor.personId : null, JSON.stringify(input.actor), input.physicalRoomId, input.logicalRoomId, allocated.current_version, input.occurredAt, recordedAt, JSON.stringify({ ...input.payload, redacted: false }), input.retentionClass, hash)
      this.db.prepare('INSERT INTO inbound_event_lifecycle(transition_id,event_id,from_state,to_state,transitioned_at,reason,ordinal) VALUES (?,?,\'recorded\',\'recorded\',?,\'initial durable append\',0)').run(this.id(), eventId, recordedAt)
      const stored = this.db.prepare('SELECT * FROM inbound_event_records WHERE event_id=?').get(eventId) as EventRow
      this.db.exec('COMMIT')
      return { envelope: envelope(stored), deduplicated: false }
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {} persistence('SQLite event append failed and was rolled back', error) }
  }

  get(scope: ExactEventScope, eventId: EventId): InboundEventEnvelope | undefined {
    try {
      const row = this.db.prepare(`SELECT e.* FROM inbound_event_records e JOIN physical_room_records p ON p.physical_room_id=e.physical_room_id JOIN logical_room_repository_records l ON l.logical_room_id=e.logical_room_id WHERE e.event_id=? AND e.logical_room_id=? AND e.physical_room_id=? AND p.lifecycle NOT IN ('inaccessible','deleted')`).get(eventId, scope.logicalRoomId, scope.physicalRoomId) as EventRow | undefined
      return row ? envelope(row) : undefined
    }
    catch (error) { persistence('SQLite exact event lookup failed', error) }
  }

  /** Reads one event through its logical-room and character boundary for background workers. */
  getForLogical(scope: { logicalRoomId: LogicalRoomId, characterId: CharacterId }, eventId: EventId): InboundEventEnvelope | undefined {
    try {
      const row = this.db.prepare(`SELECT e.* FROM inbound_event_records e JOIN logical_room_repository_records l ON l.logical_room_id=e.logical_room_id WHERE e.event_id=? AND e.logical_room_id=? AND l.character_id=? AND json_extract(e.payload_json,'$.redacted') IS NOT 1 AND (SELECT to_state FROM inbound_event_lifecycle x WHERE x.event_id=e.event_id ORDER BY ordinal DESC LIMIT 1) NOT IN ('redacted','tombstoned')`).get(eventId, scope.logicalRoomId, scope.characterId) as EventRow | undefined
      return row ? envelope(row) : undefined
    }
    catch (error) { persistence('SQLite logical-room event lookup failed', error) }
  }

  list(scope: ExactEventScope): readonly InboundEventEnvelope[] {
    try {
      return (this.db.prepare(`SELECT e.* FROM inbound_event_records e JOIN physical_room_records p ON p.physical_room_id=e.physical_room_id JOIN logical_room_repository_records l ON l.logical_room_id=e.logical_room_id WHERE e.logical_room_id=? AND e.physical_room_id=? AND p.lifecycle NOT IN ('inaccessible','deleted') ORDER BY e.occurred_at,e.event_id`).all(scope.logicalRoomId, scope.physicalRoomId) as EventRow[]).map(envelope)
    }
    catch (error) { persistence('SQLite ordered event read failed', error) }
  }

  /** Reads at most `limit` newest usable inbound events across one authorized logical room. */
  recentForLogical(scope: { logicalRoomId: LogicalRoomId, characterId: CharacterId, limit: number, excludeEventIds?: readonly EventId[] }): readonly InboundEventEnvelope[] {
    if (!Number.isSafeInteger(scope.limit) || scope.limit < 1 || scope.limit > 1_000)
      throw new RangeError('logical-room event limit must be between 1 and 1000')
    const excluded = scope.excludeEventIds ?? []
    const exclusion = excluded.length ? `AND e.event_id NOT IN (${excluded.map(() => '?').join(',')})` : ''
    try {
      const rows = this.db.prepare(`SELECT e.* FROM inbound_event_records e JOIN logical_room_repository_records l ON l.logical_room_id=e.logical_room_id WHERE e.logical_room_id=? AND l.character_id=? ${exclusion} AND json_extract(e.payload_json,'$.redacted') IS NOT 1 AND (SELECT to_state FROM inbound_event_lifecycle x WHERE x.event_id=e.event_id ORDER BY ordinal DESC LIMIT 1) NOT IN ('redacted','tombstoned') ORDER BY e.occurred_at DESC,e.room_sequence DESC,e.event_id DESC LIMIT ?`).all(scope.logicalRoomId, scope.characterId, ...excluded, scope.limit) as EventRow[]
      return rows.reverse().map(envelope)
    }
    catch (error) { persistence('SQLite bounded logical-room event read failed', error) }
  }

  lifecycle(eventId: EventId): readonly EventLifecycleTransition[] {
    try { return (this.db.prepare('SELECT event_id,from_state,to_state,transitioned_at,reason FROM inbound_event_lifecycle WHERE event_id=? ORDER BY ordinal').all(eventId) as LifecycleRow[]).map(row => ({ eventId: asEventId(row.event_id), from: row.from_state, to: row.to_state, at: asTimestamp(row.transitioned_at), reason: row.reason })) }
    catch (error) { persistence('SQLite event lifecycle read failed', error) }
  }

  transition(eventId: EventId, from: EventLifecycleState, to: EventLifecycleState, at: Timestamp, reason: string, redactPayload = false): EventLifecycleTransition {
    const next = transitionEvent(eventId, from, to, at, reason)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const current = this.db.prepare('SELECT to_state,ordinal FROM inbound_event_lifecycle WHERE event_id=? ORDER BY ordinal DESC LIMIT 1').get(eventId) as { to_state: EventLifecycleState, ordinal: number } | undefined
      if (!current) throw new MemoryError('TARGET_NOT_FOUND', 'event lifecycle does not exist')
      if (current.to_state !== from) throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'event lifecycle precondition is stale')
      if (redactPayload || to === 'redacted') this.db.prepare(`UPDATE inbound_event_records SET payload_json=json_object('redacted',json('true')) WHERE event_id=?`).run(eventId)
      this.db.prepare('INSERT INTO inbound_event_lifecycle(transition_id,event_id,from_state,to_state,transitioned_at,reason,ordinal) VALUES (?,?,?,?,?,?,?)').run(this.id(), eventId, from, to, at, reason, current.ordinal + 1)
      this.db.exec('COMMIT'); return next
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {} persistence('SQLite lifecycle transition failed and was rolled back', error) }
  }

  private assertExactWritableScope(logical: LogicalRoomId, physical: PhysicalRoomId): void {
    const row = this.db.prepare(`SELECT 1 ok FROM physical_room_records p JOIN logical_room_repository_records l ON l.logical_room_id=? WHERE p.physical_room_id=? AND p.lifecycle NOT IN ('inaccessible','deleted') AND ((l.singleton_physical_room_id=p.physical_room_id) OR EXISTS (SELECT 1 FROM room_binding_records b WHERE b.logical_room_id=l.logical_room_id AND b.physical_room_id=p.physical_room_id AND b.active_version IS NOT NULL))`).get(logical, physical)
    if (!row) throw new MemoryError('UNAUTHORIZED_ROOM', 'physical and logical room boundary is not writable')
  }
}
