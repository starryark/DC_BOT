/* eslint-disable antfu/if-newline, perfectionist/sort-imports, style/max-statements-per-line, style/quotes, test/prefer-lowercase-title */
import type { DatabaseSync } from 'node:sqlite'
import type { AppendEventInput } from '@proj-airi/memory-domain'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'
import { asCharacterId, asGenerationId, asPersonId, asRequestId, asTimestamp, attributedActor, MemoryError } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { CausalEdgeRepository } from './causal-edges.js'
import { EventRepository } from './events.js'
import { RoomRepository } from './rooms.js'

let db: DatabaseSync
const time = (second: number) => asTimestamp(`2026-08-02T10:00:${String(second).padStart(2, '0')}.000Z`)
const location = { platform: 'discord' as const, guildId: '99999999999999999', channelId: '18446744073709551615', channelKind: 'guildVoice' as const }
const personId = asPersonId('person-a')

beforeEach(() => { db = new SQLiteDatabase(':memory:'); migrate(db); db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run(personId, '18446744073709551615', time(0), 'account_subject', time(0)) })
afterEach(() => db.close())

function setup() {
  const rooms = new RoomRepository(db); const physicalRoomId = rooms.observe({ location, observedAt: time(0) }).physicalRoomId; const logicalRoomId = rooms.resolve(location, asCharacterId('character-a'), time(0)).logicalRoomId
  const actor = attributedActor(personId, { platform: 'discord', platformUserId: '18446744073709551615', displayNameAtEvent: 'Alice', guildId: location.guildId, voiceCharacteristics: { ssrc: 4 }, observedAt: time(0), source: 'voiceState' })
  const input = (key: string, kind: 'user_text' | 'user_voice' = 'user_text', occurredAt = time(1)): AppendEventInput => ({ idempotencyKey: asRequestId(key), kind, actor, physicalRoomId, logicalRoomId, occurredAt, payload: { content: `${kind}-${key}`, lang: 'en' }, retentionClass: 'transcript' })
  return { events: new EventRepository(db, (() => { let n = 0; return () => `event-${++n}` })(), () => time(9)), physicalRoomId, logicalRoomId, input }
}

function generation(generationId: string): void {
  const sequence = (db.prepare('SELECT COALESCE(MAX(room_sequence),1000)+1 value FROM events').get() as { value: number }).value
  db.prepare("INSERT INTO events(event_id,logical_room_id,room_sequence,event_kind,direction,modality,content_json,source_system,occurred_at,received_at,committed_at,immutability_hash,writer_version) VALUES (?,?,?,'assistant','outbound','text','{}','test',?,?,?,'hash','test')").run(`legacy-${generationId}`, (db.prepare('SELECT logical_room_id FROM logical_room_repository_records LIMIT 1').get() as { logical_room_id: string }).logical_room_id, sequence, time(1), time(1), time(1))
  db.prepare("INSERT INTO assistant_generations(generation_id,assistant_event_id,generation_idempotency_key,context_snapshot_version,generation_started_at,generation_status,context_eligibility) VALUES (?,?,?,0,?,'generated','eligible')").run(generationId, `legacy-${generationId}`, `key-${generationId}`, time(1))
}

describe('IMP-204 real SQLite event repository', () => {
  it('appends separately attributed text and voice envelopes with exact snowflakes and lifecycle evidence', () => {
    const { events, input } = setup(); const text = events.append(input('text')); const voice = events.append(input('voice', 'user_voice'))
    expect(text.envelope.actor.kind).toBe('attributed'); expect(text.envelope.actor.kind === 'attributed' && text.envelope.actor.snapshot.platformUserId).toBe('18446744073709551615')
    expect(voice.envelope.kind).toBe('user_voice'); expect(events.lifecycle(text.envelope.eventId).map(x => x.to)).toEqual(['recorded']); expect(db.prepare('SELECT COUNT(*) count FROM inbound_event_records').get()).toEqual({ count: 2 })
  })

  it('deduplicates exact retries and rejects conflicting reuse without sequence or lifecycle writes', () => {
    const { events, input, logicalRoomId } = setup(); const first = events.append(input('same')); const retry = events.append(input('same'))
    expect(retry).toEqual({ envelope: first.envelope, deduplicated: true }); const version = db.prepare('SELECT current_version FROM logical_rooms WHERE logical_room_id=?').get(logicalRoomId)
    expect(() => events.append({ ...input('same'), payload: { content: 'conflict' } })).toThrowError(expect.objectContaining({ code: 'POLICY_VIOLATION' })); expect(db.prepare('SELECT current_version FROM logical_rooms WHERE logical_room_id=?').get(logicalRoomId)).toEqual(version); expect(events.lifecycle(first.envelope.eventId)).toHaveLength(1)
  })

  it('retains independent appends and orders by occurredAt then eventId, never recordedAt', () => {
    const { events, input, physicalRoomId, logicalRoomId } = setup(); events.append(input('late', 'user_text', time(3))); events.append(input('early', 'user_text', time(1))); events.append(input('tie', 'user_text', time(1)))
    expect(events.list({ physicalRoomId, logicalRoomId }).map(x => x.idempotencyKey)).toEqual(['early', 'tie', 'late']); expect(db.prepare('SELECT current_version,next_sequence FROM logical_rooms WHERE logical_room_id=?').get(logicalRoomId)).toEqual({ current_version: 3, next_sequence: 4 })
  })

  it('retains appends and retry races from independent repository instances exactly once', () => {
    const { events, input, logicalRoomId } = setup(); let n = 100; const other = new EventRepository(db, () => `event-${++n}`, () => time(8))
    const a = events.append(input('independent-a')); const b = other.append(input('independent-b')); const retried = other.append(input('independent-a'))
    expect([a.envelope.idempotencyKey, b.envelope.idempotencyKey]).toEqual(['independent-a', 'independent-b']); expect(retried).toEqual({ envelope: a.envelope, deduplicated: true }); expect(db.prepare('SELECT COUNT(*) count FROM inbound_event_records').get()).toEqual({ count: 2 }); expect(db.prepare('SELECT current_version FROM logical_rooms WHERE logical_room_id=?').get(logicalRoomId)).toEqual({ current_version: 2 })
  })

  it('rejects CAS fields, mismatched actors, and inaccessible or different exact room scopes', () => {
    const { events, input, physicalRoomId, logicalRoomId } = setup(); expect(() => events.append({ ...input('cas'), expectedRoomVersion: 0 } as AppendEventInput)).toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_APPEND_PRECONDITION' }))
    const source = input('bad'); if (source.actor.kind !== 'attributed') throw new Error('fixture actor must be attributed'); const bad = { ...source, actor: attributedActor(asPersonId('missing'), source.actor.snapshot) }; expect(() => events.append(bad)).toThrowError(expect.objectContaining({ code: 'INVALID_ACTOR' }))
    const stored = events.append(input('ok')).envelope; expect(events.get({ physicalRoomId, logicalRoomId: `${logicalRoomId}-other` as typeof logicalRoomId }, stored.eventId)).toBeUndefined(); new RoomRepository(db).observe({ location, observedAt: time(2), lifecycle: 'inaccessible' }); expect(events.get({ physicalRoomId, logicalRoomId }, stored.eventId)).toBeUndefined()
  })

  it('appends legal lifecycle history, rejects stale/terminal moves, and atomically redacts payload', () => {
    const { events, input, physicalRoomId, logicalRoomId } = setup(); const saved = events.append(input('life')).envelope; events.transition(saved.eventId, 'recorded', 'superseded', time(2), 'corrected'); events.transition(saved.eventId, 'superseded', 'redacted', time(3), 'governed')
    expect(events.get({ physicalRoomId, logicalRoomId }, saved.eventId)?.payload).toEqual({ redacted: true }); expect(events.lifecycle(saved.eventId).map(x => x.to)).toEqual(['recorded', 'superseded', 'redacted']); expect(() => events.transition(saved.eventId, 'recorded', 'tombstoned', time(4), 'stale')).toThrowError(MemoryError)
    events.transition(saved.eventId, 'redacted', 'tombstoned', time(4), 'done'); expect(() => events.transition(saved.eventId, 'tombstoned', 'redacted', time(5), 'illegal')).toThrowError(MemoryError)
  })

  it('rolls back failed envelope/lifecycle and failed redaction writes as PERSISTENCE_FAILED', () => {
    const { events, input, physicalRoomId, logicalRoomId } = setup(); db.exec("CREATE TRIGGER fail_initial BEFORE INSERT ON inbound_event_lifecycle BEGIN SELECT RAISE(ABORT,'forced'); END")
    expect(() => events.append(input('fail'))).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(db.prepare('SELECT COUNT(*) count FROM inbound_event_records').get()).toEqual({ count: 0 }); expect(db.prepare('SELECT current_version FROM logical_rooms WHERE logical_room_id=?').get(logicalRoomId)).toEqual({ current_version: 0 }); db.exec('DROP TRIGGER fail_initial')
    const saved = events.append(input('redact')).envelope; db.exec("CREATE TRIGGER fail_redact BEFORE INSERT ON inbound_event_lifecycle WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'forced'); END"); expect(() => events.transition(saved.eventId, 'recorded', 'redacted', time(2), 'governed')).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(events.get({ physicalRoomId, logicalRoomId }, saved.eventId)?.payload.redacted).toBe(false); expect(events.lifecycle(saved.eventId)).toHaveLength(1)
  })
})

describe('IMP-204 real SQLite causal graph', () => {
  it('preserves many-to-many roles, deterministic traversal, retries, and edges after redaction', () => {
    const { events, input, physicalRoomId, logicalRoomId } = setup(); const a = events.append(input('a')).envelope; const b = events.append(input('b', 'user_voice')).envelope; generation('generation-a'); generation('generation-b'); const causes = new CausalEdgeRepository(db)
    causes.appendSet(asGenerationId('generation-a'), [{ inboundEventId: a.eventId, role: 'trigger' }, { inboundEventId: a.eventId, role: 'correction' }, { inboundEventId: b.eventId, role: 'trigger' }]); causes.appendSet(asGenerationId('generation-a'), [{ inboundEventId: a.eventId, role: 'trigger' }]); causes.appendSet(asGenerationId('generation-b'), [{ inboundEventId: a.eventId, role: 'trigger' }])
    expect(causes.forGeneration(asGenerationId('generation-a')).map(x => `${x.inboundEventId}:${x.role}`)).toEqual([`${a.eventId}:correction`, `${a.eventId}:trigger`, `${b.eventId}:trigger`]); expect(causes.forEvent(a.eventId).map(x => x.generationId)).toEqual(['generation-a', 'generation-a', 'generation-b'])
    events.transition(a.eventId, 'recorded', 'redacted', time(2), 'governed'); expect(events.get({ physicalRoomId, logicalRoomId }, a.eventId)?.payload.redacted).toBe(true); expect(causes.forEvent(a.eventId)).toHaveLength(3)
  })

  it('requires a trigger, enforces foreign keys, and rolls back a partial causal set', () => {
    const { events, input } = setup(); const a = events.append(input('a')).envelope; const b = events.append(input('b')).envelope; generation('generation-a'); const causes = new CausalEdgeRepository(db)
    expect(() => causes.appendSet(asGenerationId('generation-a'), [{ inboundEventId: a.eventId, role: 'context' }])).toThrowError(expect.objectContaining({ code: 'INVALID_TRIGGER_EVENTS' })); db.exec("CREATE TRIGGER fail_edge BEFORE INSERT ON generation_causal_edges WHEN NEW.cause_role='context' BEGIN SELECT RAISE(ABORT,'forced'); END")
    expect(() => causes.appendSet(asGenerationId('generation-a'), [{ inboundEventId: a.eventId, role: 'trigger' }, { inboundEventId: b.eventId, role: 'context' }])).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(causes.forGeneration(asGenerationId('generation-a'))).toEqual([]); expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1); expect(() => db.prepare("INSERT INTO generation_causal_edges VALUES ('missing','missing','trigger')").run()).toThrow()
  })
})
