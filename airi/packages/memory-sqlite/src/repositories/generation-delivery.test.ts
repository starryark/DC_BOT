/* eslint-disable perfectionist/sort-imports, style/max-statements-per-line, style/quotes, test/prefer-lowercase-title */
import type { DatabaseSync } from 'node:sqlite'
import type { DeliveryAttempt, GenerationAttempt, OutputSegment } from '@proj-airi/memory-domain'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'
import { asCharacterId, asDeliveryId, asGenerationId, asPersonId, asRequestId, asSegmentId, asTimestamp, attributedActor, digestSnapshotContextManifest, MemoryError } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { DeliveryRepository } from './deliveries.js'
import { EventRepository } from './events.js'
import { GenerationRepository } from './generations.js'
import { OutputRepository } from './outputs.js'
import { RoomRepository } from './rooms.js'

let db: DatabaseSync
const time = (second: number) => asTimestamp(`2026-08-02T10:00:${String(second).padStart(2, '0')}.000Z`)
const characterId = asCharacterId('character-a')
const location = { platform: 'discord' as const, guildId: '99999999999999999', channelId: '18446744073709551615', channelKind: 'guildVoice' as const }

beforeEach(() => { db = new SQLiteDatabase(':memory:'); migrate(db); db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run('person-a', '18446744073709551615', time(0), 'account_subject', time(0)) })
afterEach(() => db.close())

function setup() {
  const rooms = new RoomRepository(db); const physicalRoomId = rooms.observe({ location, observedAt: time(0) }).physicalRoomId; const logicalRoomId = rooms.resolve(location, characterId, time(0)).logicalRoomId
  const actor = attributedActor(asPersonId('person-a'), { platform: 'discord', platformUserId: '18446744073709551615', displayNameAtEvent: 'Alice', guildId: location.guildId, observedAt: time(0), source: 'gateway' })
  let eventNo = 0; const events = new EventRepository(db, () => `event-${++eventNo}`, () => time(1)); const event = events.append({ idempotencyKey: asRequestId('event-key'), kind: 'user_text', actor, physicalRoomId, logicalRoomId, occurredAt: time(1), payload: { content: 'hello' }, retentionClass: 'transcript' }).envelope
  const generation: GenerationAttempt = { generationId: asGenerationId('generation-a'), idempotencyKey: asRequestId('generation-key'), logicalRoomId, characterId, state: 'prepared', evidence: { observedRoomVersion: 1, observedEventIds: [event.eventId], contextManifestHash: '', contextManifest: { formatVersion: 1, logicalRoomVersion: 1, bindingRevision: 0, maxItems: 0, maxCharacters: 0, candidateReadLimit: 0, truncated: false, items: [] }, observedBindingVersion: 0, capturedAt: time(2) }, modelRef: 'provider/model/prompt-v1', startedAt: time(2) }
  let idNo = 0; const generations = new GenerationRepository(db, () => `transition-${++idNo}`); const outputs = new OutputRepository(db); const deliveries = new DeliveryRepository(db, () => `delivery-transition-${++idNo}`)
  return { physicalRoomId, logicalRoomId, events, event, generation, generations, outputs, deliveries }
}

function delivery(segmentId: OutputSegment['segmentId'], overrides: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return { deliveryId: asDeliveryId('delivery-a'), segmentId, transport: 'discord_text', destinationId: '18446744073709551615', idempotencyKey: asRequestId('delivery-key'), attemptNumber: 1, state: 'pending', evidence: { kind: 'none' }, startedAt: time(5), lastTransitionAt: time(5), ...overrides }
}

describe('IMP-205 generation repository', () => {
  it('creates exact snapshot evidence idempotently and follows the legal lifecycle', () => {
    const { generation, generations } = setup(); const first = generations.create(generation); const retry = generations.create(generation)
    const canonical = { ...generation, evidence: { ...generation.evidence, contextManifestHash: digestSnapshotContextManifest(generation.evidence.contextManifest) } }
    expect(first.attempt).toEqual(canonical); expect(retry).toEqual({ attempt: canonical, deduplicated: true }); generations.transition(generation.generationId, 'prepared', 'running', time(3)); generations.transition(generation.generationId, 'running', 'generated', time(4)); const saved = generations.transition(generation.generationId, 'generated', 'persisted', time(5))
    expect(saved.state).toBe('persisted'); expect(saved.completedAt).toBe(time(5)); expect(generations.lifecycle(generation.generationId).map(value => value.to)).toEqual(['prepared', 'running', 'generated', 'persisted']); expect(db.prepare('SELECT COUNT(*) count FROM generation_snapshot_events').get()).toEqual({ count: 1 })
  })

  it('rejects conflicts, skipped/stale transitions, terminal moves, and supersedes legally without writes', () => {
    const { generation, generations } = setup(); generations.create(generation)
    expect(() => generations.create({ ...generation, modelRef: 'other' })).toThrowError(expect.objectContaining({ code: 'POLICY_VIOLATION' })); expect(() => generations.transition(generation.generationId, 'prepared', 'generated', time(3))).toThrowError(expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' })); generations.transition(generation.generationId, 'prepared', 'running', time(3)); expect(() => generations.transition(generation.generationId, 'prepared', 'cancelled', time(4))).toThrowError(expect.objectContaining({ code: 'ILLEGAL_STATE_TRANSITION' })); generations.transition(generation.generationId, 'running', 'superseded', time(4)); expect(() => generations.transition(generation.generationId, 'superseded', 'running', time(5))).toThrowError(MemoryError); expect(generations.lifecycle(generation.generationId)).toHaveLength(3)
  })

  it('treats a concurrent room append as divergence evidence rather than a generation CAS failure', () => {
    const { generation, generations, events, logicalRoomId } = setup(); generations.create(generation); const original = events.get.bind(events)
    const event = original({ logicalRoomId, physicalRoomId: (db.prepare('SELECT physical_room_id FROM inbound_event_records LIMIT 1').get() as { physical_room_id: typeof generation.logicalRoomId }).physical_room_id as never }, generation.evidence.observedEventIds[0]!)!; events.append({ idempotencyKey: asRequestId('later-event'), kind: event.kind, actor: event.actor, physicalRoomId: event.physicalRoomId, logicalRoomId, occurredAt: time(3), payload: { content: 'later' }, retentionClass: 'transcript' })
    generations.transition(generation.generationId, 'prepared', 'running', time(3)); expect(generations.transition(generation.generationId, 'running', 'generated', time(4)).evidence.observedRoomVersion).toBe(1); expect(db.prepare('SELECT current_version FROM logical_rooms WHERE logical_room_id=?').get(logicalRoomId)).toEqual({ current_version: 2 })
  })

  it('rolls back foreign-key and injected initial/transition failures', () => {
    const { generation, generations } = setup(); db.exec("CREATE TRIGGER fail_generation_lifecycle BEFORE INSERT ON generation_lifecycle_records BEGIN SELECT RAISE(ABORT,'forced'); END"); expect(() => generations.create(generation)).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(db.prepare('SELECT COUNT(*) count FROM generation_attempt_records').get()).toEqual({ count: 0 }); expect(db.prepare('SELECT COUNT(*) count FROM generation_identifiers WHERE generation_id=?').get(generation.generationId)).toEqual({ count: 0 }); db.exec('DROP TRIGGER fail_generation_lifecycle'); generations.create(generation); db.exec("CREATE TRIGGER fail_generation_transition BEFORE INSERT ON generation_lifecycle_records WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'forced'); END"); expect(() => generations.transition(generation.generationId, 'prepared', 'running', time(3))).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(generations.get({ logicalRoomId: generation.logicalRoomId, characterId }, generation.generationId)?.state).toBe('prepared'); expect(generations.lifecycle(generation.generationId)).toHaveLength(1)
  })

  it('denies a character-mismatched generation without allocating its identity', () => {
    const { generation, generations } = setup(); expect(() => generations.create({ ...generation, characterId: asCharacterId('other-character') })).toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED_ROOM' })); expect(db.prepare('SELECT COUNT(*) count FROM generation_identifiers WHERE generation_id=?').get(generation.generationId)).toEqual({ count: 0 })
  })
})

describe('IMP-205 output and delivery repositories', () => {
  it('stores ordered immutable text and voice sets, deduplicates retries, and rolls back conflicts', () => {
    const { generation, generations, outputs } = setup(); generations.create(generation); const segments: OutputSegment[] = [{ segmentId: asSegmentId('segment-b'), generationId: generation.generationId, ordinal: 1, modality: 'voice', text: 'Second exact clause.' }, { segmentId: asSegmentId('segment-a'), generationId: generation.generationId, ordinal: 0, modality: 'text', text: 'First exact text.' }]
    expect(outputs.appendSet(generation.generationId, segments).segments.map(value => value.text)).toEqual(['First exact text.', 'Second exact clause.']); expect(outputs.appendSet(generation.generationId, segments).deduplicated).toBe(true); expect(() => outputs.appendSet(generation.generationId, [{ ...segments[0]!, text: 'changed' }, segments[1]!])).toThrowError(expect.objectContaining({ code: 'POLICY_VIOLATION' })); expect(outputs.list(generation.generationId)).toHaveLength(2); expect(() => outputs.appendSet(asGenerationId('missing'), [{ ...segments[0]!, generationId: asGenerationId('missing'), segmentId: asSegmentId('missing-segment'), ordinal: 0 }])).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' }))
  })

  it('delivers receipt-backed text, rejects false text/voice delivery, and exposes unknown attempts', () => {
    const { generation, generations, outputs, deliveries } = setup(); generations.create(generation); const segment = { segmentId: asSegmentId('segment-a'), generationId: generation.generationId, ordinal: 0, modality: 'text' as const, text: 'hello' }; outputs.appendSet(generation.generationId, [segment]); const pending = delivery(segment.segmentId); expect(deliveries.create(pending).deduplicated).toBe(false); expect(deliveries.create(pending).deduplicated).toBe(true); deliveries.transition({ deliveryId: pending.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) }); expect(() => deliveries.transition({ deliveryId: pending.deliveryId, from: 'delivering', to: 'delivered', evidence: { kind: 'none' }, at: time(7) })).toThrowError(expect.objectContaining({ code: 'MISSING_MESSAGE_ID' })); deliveries.transition({ deliveryId: pending.deliveryId, from: 'delivering', to: 'unknownAfterCrash', evidence: { kind: 'none' }, at: time(7) }); expect(deliveries.unresolved().map(value => value.deliveryId)).toEqual([pending.deliveryId]); expect(deliveries.lifecycle(pending.deliveryId)).toHaveLength(3)
    const voice = { ...delivery(segment.segmentId, { deliveryId: asDeliveryId('voice-delivery'), idempotencyKey: asRequestId('voice-key'), attemptNumber: 2, transport: 'discord_voice' }), destinationId: 'voice-channel' }; deliveries.create(voice); deliveries.transition({ deliveryId: voice.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) }); expect(() => deliveries.transition({ deliveryId: voice.deliveryId, from: 'delivering', to: 'delivered', evidence: { kind: 'platformMessageId', platformMessageId: 'x' }, at: time(7) })).toThrowError(expect.objectContaining({ code: 'INVALID_OUTCOME' }))
  })

  it('keeps exact retries distinct from new physical attempts and rolls back injected transitions', () => {
    const { generation, generations, outputs, deliveries } = setup(); generations.create(generation); const segment = { segmentId: asSegmentId('segment-a'), generationId: generation.generationId, ordinal: 0, modality: 'text' as const, text: 'hello' }; outputs.appendSet(generation.generationId, [segment]); const first = delivery(segment.segmentId); deliveries.create(first); expect(() => deliveries.create({ ...first, destinationId: 'other' })).toThrowError(expect.objectContaining({ code: 'POLICY_VIOLATION' })); deliveries.create({ ...first, deliveryId: asDeliveryId('delivery-b'), idempotencyKey: asRequestId('delivery-key-b'), attemptNumber: 2 }); expect(deliveries.forSegment(segment.segmentId)).toHaveLength(2); db.exec("CREATE TRIGGER fail_delivery_transition BEFORE INSERT ON delivery_lifecycle_records WHEN NEW.ordinal=1 BEGIN SELECT RAISE(ABORT,'forced'); END"); expect(() => deliveries.transition({ deliveryId: first.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) })).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(deliveries.get(first.deliveryId)?.state).toBe('pending'); expect(deliveries.lifecycle(first.deliveryId)).toHaveLength(1)
  })

  it('rolls back a delivery base row when initial lifecycle evidence fails', () => {
    const { generation, generations, outputs, deliveries } = setup(); generations.create(generation); const segment = { segmentId: asSegmentId('segment-a'), generationId: generation.generationId, ordinal: 0, modality: 'text' as const, text: 'hello' }; outputs.appendSet(generation.generationId, [segment]); db.exec("CREATE TRIGGER fail_delivery_initial BEFORE INSERT ON delivery_lifecycle_records BEGIN SELECT RAISE(ABORT,'forced'); END"); expect(() => deliveries.create(delivery(segment.segmentId))).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(db.prepare('SELECT COUNT(*) count FROM delivery_attempt_records').get()).toEqual({ count: 0 })
  })

  it('evaluates strict and explicit partial context policy from current durable evidence', () => {
    const { generation, generations, outputs, deliveries, logicalRoomId, physicalRoomId } = setup(); generations.create(generation); const segments: OutputSegment[] = [{ segmentId: asSegmentId('text'), generationId: generation.generationId, ordinal: 0, modality: 'text', text: 'Delivered text.' }, { segmentId: asSegmentId('voice-ok'), generationId: generation.generationId, ordinal: 1, modality: 'voice', text: 'Played clause.' }, { segmentId: asSegmentId('voice-failed'), generationId: generation.generationId, ordinal: 2, modality: 'voice', text: 'Failed clause.' }, { segmentId: asSegmentId('never'), generationId: generation.generationId, ordinal: 3, modality: 'voice', text: 'Never attempted.' }]; outputs.appendSet(generation.generationId, segments)
    const textAttempt = delivery(segments[0]!.segmentId); deliveries.create(textAttempt); deliveries.transition({ deliveryId: textAttempt.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) }); deliveries.transition({ deliveryId: textAttempt.deliveryId, from: 'delivering', to: 'delivered', evidence: { kind: 'platformMessageId', platformMessageId: '18446744073709550000' }, at: time(7) })
    const played = delivery(segments[1]!.segmentId, { deliveryId: asDeliveryId('played'), idempotencyKey: asRequestId('played'), transport: 'discord_voice' }); deliveries.create(played); deliveries.transition({ deliveryId: played.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) }); deliveries.transition({ deliveryId: played.deliveryId, from: 'delivering', to: 'partiallyDelivered', evidence: { kind: 'localPlaybackCompleted', deliveredRange: { characters: 6, playedMs: 500 } }, at: time(7) })
    const failed = delivery(segments[2]!.segmentId, { deliveryId: asDeliveryId('failed'), idempotencyKey: asRequestId('failed'), transport: 'discord_voice' }); deliveries.create(failed); deliveries.transition({ deliveryId: failed.deliveryId, from: 'pending', to: 'failed', evidence: { kind: 'transportError', errorClass: 'tts' }, at: time(6) }); const scope = { logicalRoomId, physicalRoomId, characterId }
    expect(deliveries.eligible(scope).map(value => value.text)).toEqual(['Delivered text.']); expect(deliveries.eligible(scope, { allowPartialAssistantOutput: true, treatCompletedPlaybackAsEligible: false }).map(value => value.text)).toEqual(['Delivered text.', 'Played']); db.prepare("UPDATE physical_room_records SET lifecycle='inaccessible' WHERE physical_room_id=?").run(physicalRoomId); expect(deliveries.eligible(scope)).toEqual([])
  })

  it('admits only receipt-reconciled text and explicitly opted-in completed voice evidence', () => {
    const { generation, generations, outputs, deliveries, logicalRoomId, physicalRoomId } = setup(); generations.create(generation); const segments: OutputSegment[] = [{ segmentId: asSegmentId('receipt'), generationId: generation.generationId, ordinal: 0, modality: 'text', text: 'Receipt.' }, { segmentId: asSegmentId('error'), generationId: generation.generationId, ordinal: 1, modality: 'text', text: 'Error.' }, { segmentId: asSegmentId('played'), generationId: generation.generationId, ordinal: 2, modality: 'voice', text: 'Played.' }, { segmentId: asSegmentId('unknown-prefix'), generationId: generation.generationId, ordinal: 3, modality: 'voice', text: 'Unknown.' }]; outputs.appendSet(generation.generationId, segments)
    const receipt = delivery(segments[0]!.segmentId); deliveries.create(receipt); deliveries.transition({ deliveryId: receipt.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) }); deliveries.transition({ deliveryId: receipt.deliveryId, from: 'delivering', to: 'delivered', evidence: { kind: 'platformMessageId', platformMessageId: 'message-id' }, at: time(7) }); deliveries.transition({ deliveryId: receipt.deliveryId, from: 'delivered', to: 'reconciled', evidence: { kind: 'platformMessageId', platformMessageId: 'message-id' }, at: time(8) })
    const error = delivery(segments[1]!.segmentId, { deliveryId: asDeliveryId('error-delivery'), idempotencyKey: asRequestId('error-key') }); deliveries.create(error); deliveries.transition({ deliveryId: error.deliveryId, from: 'pending', to: 'failed', evidence: { kind: 'transportError', errorClass: 'send' }, at: time(6) }); deliveries.transition({ deliveryId: error.deliveryId, from: 'failed', to: 'reconciled', evidence: { kind: 'transportError', errorClass: 'confirmed-failed' }, at: time(7) })
    const played = delivery(segments[2]!.segmentId, { deliveryId: asDeliveryId('played-delivery'), idempotencyKey: asRequestId('played-key'), transport: 'discord_voice' }); deliveries.create(played); deliveries.transition({ deliveryId: played.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) }); deliveries.transition({ deliveryId: played.deliveryId, from: 'delivering', to: 'unheard', evidence: { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 500 } }, at: time(7) })
    const unknown = delivery(segments[3]!.segmentId, { deliveryId: asDeliveryId('unknown-delivery'), idempotencyKey: asRequestId('unknown-key'), transport: 'discord_voice' }); deliveries.create(unknown); deliveries.transition({ deliveryId: unknown.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) }); deliveries.transition({ deliveryId: unknown.deliveryId, from: 'delivering', to: 'partiallyDelivered', evidence: { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 200 } }, at: time(7) }); const scope = { logicalRoomId, physicalRoomId, characterId }
    expect(deliveries.eligible(scope).map(value => value.text)).toEqual(['Receipt.']); expect(deliveries.eligible(scope, { allowPartialAssistantOutput: true, treatCompletedPlaybackAsEligible: true }).map(value => value.text)).toEqual(['Receipt.', 'Played.'])
  })
})
