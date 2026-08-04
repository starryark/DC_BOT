/**
 * Canonical contract fixtures (IMP-101; artifact 21 §11.3 IC-01).
 *
 * These are a shipped part of the package, not test-only helpers. The backlog
 * requires that the text adapter, the voice adapter, and the persistence
 * adapter all consume *the same* fixtures, so that "we each tested it" cannot
 * mean "we each tested a different shape".
 *
 * Every fixture is deterministic — fixed ids, fixed timestamps, no clock and no
 * randomness — so a conformance suite can compare results byte for byte.
 */

import type { AliasRecord } from './aliases'
import type { AuthorizationContext } from './authorization'
import type { CausalEdge } from './causality'
import type { DeliveryAttempt, OutputSegment } from './delivery'
import type { InboundEventEnvelope } from './events'
import type { SnapshotEvidence } from './generation'
import type { ActorSnapshot, AttributedActor } from './identity'
import type { SemanticFact } from './memory-records'
import type { PhysicalLocation, RoomBinding } from './rooms'

import { attributedActor } from './identity'
import {
  asAliasId,
  asCharacterId,
  asDeliveryId,
  asEventId,
  asFactId,
  asGenerationId,
  asLogicalRoomId,
  asPersonId,
  asRequestId,
  asSegmentId,
  asTimestamp,
} from './ids'
import { physicalRoomIdOf } from './rooms'

const T0 = asTimestamp('2026-08-02T10:00:00.000Z')
const T1 = asTimestamp('2026-08-02T10:00:01.000Z')
const T2 = asTimestamp('2026-08-02T10:00:02.000Z')

/** The guild and voice channel every guild fixture uses. */
export const FIXTURE_GUILD_ID = '900000000000000001'
export const FIXTURE_VOICE_CHANNEL_ID = '900000000000000002'
export const FIXTURE_TEXT_CHANNEL_ID = '900000000000000003'
export const FIXTURE_DM_CHANNEL_ID = '900000000000000004'

export const FIXTURE_CHARACTER = asCharacterId('makise-kurisu')

export const FIXTURE_VOICE_LOCATION: PhysicalLocation = Object.freeze({
  platform: 'discord',
  guildId: FIXTURE_GUILD_ID,
  channelId: FIXTURE_VOICE_CHANNEL_ID,
  channelKind: 'guildVoice',
})

export const FIXTURE_TEXT_LOCATION: PhysicalLocation = Object.freeze({
  platform: 'discord',
  guildId: FIXTURE_GUILD_ID,
  channelId: FIXTURE_TEXT_CHANNEL_ID,
  channelKind: 'guildText',
})

export const FIXTURE_DM_LOCATION: PhysicalLocation = Object.freeze({
  platform: 'discord',
  channelId: FIXTURE_DM_CHANNEL_ID,
  channelKind: 'dm',
})

function snapshot(userId: string, displayName: string, nickname?: string): ActorSnapshot {
  return {
    platform: 'discord',
    platformUserId: userId,
    username: displayName.toLowerCase(),
    globalName: displayName,
    guildNickname: nickname,
    displayNameAtEvent: nickname ?? displayName,
    guildId: FIXTURE_GUILD_ID,
    observedAt: T0,
    source: 'gateway',
  }
}

/**
 * Two distinct people who both answer to "Alex" (TEST-ID-001, TEST-ALIAS-002).
 *
 * The whole point of ADR-003 in one fixture: same display text, different
 * snowflakes, and they must never converge on one person record.
 */
export const FIXTURE_ALEX_ONE: AttributedActor = attributedActor(
  asPersonId('person-alex-one'),
  snapshot('100000000000000001', 'Alex'),
)

export const FIXTURE_ALEX_TWO: AttributedActor = attributedActor(
  asPersonId('person-alex-two'),
  snapshot('100000000000000002', 'Alexander', 'Alex'),
)

export const FIXTURE_BOB: AttributedActor = attributedActor(
  asPersonId('person-bob'),
  snapshot('100000000000000003', 'Bob'),
)

/** Aliases for the two Alexes, plus a private DM-only nickname (TEST-ALIAS-001). */
export const FIXTURE_ALIASES: readonly AliasRecord[] = Object.freeze([
  {
    aliasId: asAliasId('alias-alex-one-platform'),
    personId: FIXTURE_ALEX_ONE.personId,
    scope: 'platform',
    normalizedValue: 'alex',
    displayValue: 'Alex',
    visibility: 'public',
    validFrom: T0,
    source: 'discordGlobalName',
  },
  {
    aliasId: asAliasId('alias-alex-two-guild'),
    personId: FIXTURE_ALEX_TWO.personId,
    scope: 'guild',
    scopeId: FIXTURE_GUILD_ID,
    normalizedValue: 'alex',
    displayValue: 'Alex',
    visibility: 'public',
    validFrom: T0,
    source: 'discordNickname',
  },
  {
    aliasId: asAliasId('alias-bob-private'),
    personId: FIXTURE_BOB.personId,
    scope: 'private',
    scopeId: `dm:${FIXTURE_DM_CHANNEL_ID}`,
    normalizedValue: 'bobby bear',
    displayValue: 'Bobby Bear',
    visibility: 'private',
    validFrom: T0,
    source: 'userStated',
  },
])

const voiceRoomId = asLogicalRoomId(`room:${FIXTURE_CHARACTER}:${physicalRoomIdOf(FIXTURE_VOICE_LOCATION)}`)

function voiceEvent(id: string, actor: AttributedActor, content: string, at: string): InboundEventEnvelope {
  return {
    eventId: asEventId(id),
    idempotencyKey: asRequestId(`req-${id}`),
    kind: 'user_voice',
    actor,
    physicalRoomId: physicalRoomIdOf(FIXTURE_VOICE_LOCATION),
    logicalRoomId: voiceRoomId,
    occurredAt: asTimestamp(at),
    recordedAt: asTimestamp(at),
    payload: { content, lang: 'en', redacted: false },
    retentionClass: 'transcript',
  }
}

/**
 * The three-speaker group turn (TEST-ATTRIB-001, SCN-010).
 *
 * Three events, three durable authors. The current runtime produces one turn
 * authored by `Discord group` for this exact input
 * (`conversation-controller.ts:268-278`), which is the regression this fixture
 * exists to catch.
 */
export const FIXTURE_GROUP_TURN_EVENTS: readonly InboundEventEnvelope[] = Object.freeze([
  voiceEvent('event-alex-one', FIXTURE_ALEX_ONE, 'did you finish the report', '2026-08-02T10:00:00.000Z'),
  voiceEvent('event-alex-two', FIXTURE_ALEX_TWO, 'i think it is due tomorrow', '2026-08-02T10:00:00.400Z'),
  voiceEvent('event-bob', FIXTURE_BOB, 'no it was due today', '2026-08-02T10:00:00.900Z'),
])

export const FIXTURE_GENERATION_ID = asGenerationId('generation-group-1')

/** One generation, three trigger edges — the many-to-many shape (TEST-CAUSAL-001). */
export const FIXTURE_GROUP_CAUSAL_EDGES: readonly CausalEdge[] = Object.freeze(
  FIXTURE_GROUP_TURN_EVENTS.map(event => ({
    generationId: FIXTURE_GENERATION_ID,
    inboundEventId: event.eventId,
    role: 'trigger' as const,
  })),
)

export const FIXTURE_SNAPSHOT_EVIDENCE: SnapshotEvidence = Object.freeze({
  observedRoomVersion: 10,
  observedEventIds: FIXTURE_GROUP_TURN_EVENTS.map(event => event.eventId),
  contextManifestHash: 'manifest-abc123',
  contextManifest: Object.freeze({ formatVersion: 1, logicalRoomVersion: 10, bindingRevision: 0, maxItems: 10, maxCharacters: 2_000, candidateReadLimit: 40, truncated: false, items: Object.freeze([]) }),
  observedBindingVersion: 0,
  capturedAt: T1,
})

/** Three voice clauses; the second one fails synthesis (SCN-034, TEST-DELIVERY-VOICE-001). */
export const FIXTURE_VOICE_SEGMENTS: readonly OutputSegment[] = Object.freeze([
  { segmentId: asSegmentId('segment-1'), generationId: FIXTURE_GENERATION_ID, ordinal: 0, modality: 'voice', text: 'It was due today.' },
  { segmentId: asSegmentId('segment-2'), generationId: FIXTURE_GENERATION_ID, ordinal: 1, modality: 'voice', text: 'You are both a day off.' },
  { segmentId: asSegmentId('segment-3'), generationId: FIXTURE_GENERATION_ID, ordinal: 2, modality: 'voice', text: 'Send it before the deadline.' },
])

/**
 * The partial-delivery fixture the G1 gate requires.
 *
 * Clause 1 played, clause 2 failed synthesis, clause 3 was never attempted.
 * Only clause 1 may ever reach the next prompt.
 */
export const FIXTURE_VOICE_DELIVERIES: readonly DeliveryAttempt[] = Object.freeze([
  {
    deliveryId: asDeliveryId('delivery-1'),
    segmentId: asSegmentId('segment-1'),
    transport: 'discord_voice',
    destinationId: FIXTURE_VOICE_CHANNEL_ID,
    idempotencyKey: asRequestId('req-delivery-1'),
    attemptNumber: 1,
    state: 'unheard',
    evidence: { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 1400 } },
    startedAt: T1,
    lastTransitionAt: T2,
  },
  {
    deliveryId: asDeliveryId('delivery-2'),
    segmentId: asSegmentId('segment-2'),
    transport: 'discord_voice',
    destinationId: FIXTURE_VOICE_CHANNEL_ID,
    idempotencyKey: asRequestId('req-delivery-2'),
    attemptNumber: 1,
    state: 'failed',
    evidence: { kind: 'transportError', errorClass: 'ttsSynthesisFailed' },
    startedAt: T1,
    lastTransitionAt: T2,
  },
  {
    deliveryId: asDeliveryId('delivery-3'),
    segmentId: asSegmentId('segment-3'),
    transport: 'discord_voice',
    destinationId: FIXTURE_VOICE_CHANNEL_ID,
    idempotencyKey: asRequestId('req-delivery-3'),
    attemptNumber: 1,
    state: 'pending',
    evidence: { kind: 'none' },
    startedAt: T1,
    lastTransitionAt: T1,
  },
])

/** A durable fact stated by a user, used by the correction fixtures. */
export const FIXTURE_CITY_FACT: SemanticFact = Object.freeze<SemanticFact>({
  layer: 'semantic',
  factId: asFactId('fact-city-1'),
  personId: FIXTURE_BOB.personId,
  scopeKind: 'guild',
  scopeId: FIXTURE_GUILD_ID,
  predicate: 'livesIn',
  value: 'Osaka',
  confidence: 0.9,
  provenance: {
    source: 'userStated',
    method: 'explicitCommand',
    sourceEventIds: [asEventId('event-bob')],
    statedAt: T0,
  },
  validity: { validFrom: T0, recordedAt: T0 },
})

/** The bot process principal: broad scope grants, but not an operator. */
export const FIXTURE_BOT_CONTEXT: AuthorizationContext = Object.freeze<AuthorizationContext>({
  principal: {
    botUserId: '800000000000000001',
    operations: [
      'room:read',
      'identity:observe',
      'event:write',
      'draft:write',
      'delivery:write',
      'context:read',
      'memory:search',
      'intent:write',
      'alias:read',
      'system:read',
    ],
    scopes: [
      { kind: 'guild', id: FIXTURE_GUILD_ID },
      { kind: 'character', id: FIXTURE_CHARACTER },
    ],
    operator: false,
  },
  characterId: FIXTURE_CHARACTER,
  logicalRoomId: voiceRoomId,
})

/** The logical room every guild-voice fixture resolves to. */
export const FIXTURE_VOICE_ROOM_ID = voiceRoomId

/** No bindings: the default isolated topology (AC-013). */
export const FIXTURE_NO_BINDINGS: readonly RoomBinding[] = Object.freeze([])
