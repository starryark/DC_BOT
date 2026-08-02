/**
 * Discord identity, actor snapshots, and current presentation (IMP-102).
 *
 * Two rules drive everything in this file:
 *
 * - **ADR-003** — the Discord snowflake is the only durable person key.
 *   Usernames, global names, guild nicknames, avatars and voice characteristics
 *   are attributes. A missing snowflake yields an anonymous, event-only actor
 *   that can never merge into a person record (FIND-007).
 * - **ADR-004** — what a speaker looked like *at event time* and how the bot
 *   should address them *now* are different questions with different answers.
 *   Snapshots are frozen evidence; presentation is a mutable projection.
 */

import type { PersonId, Timestamp } from './ids'

import { MemoryError } from './errors'

/** The only platform this milestone models. */
export const PLATFORM = 'discord' as const
export type Platform = typeof PLATFORM

/**
 * The durable identity key, e.g. `discord:user:123456789012345678`.
 *
 * This identifies a **Discord account**, not a verified human. Cross-platform
 * linkage is out of scope, and the domain deliberately offers no type that
 * could express it (ADR-003, FIND-008).
 */
export type IdentityKey = `discord:user:${string}`

/**
 * Discord snowflakes are 64-bit ids rendered in decimal. The range check is
 * deliberately loose on length (17-20) because the epoch keeps growing; it is
 * strict on "digits only", which is what stops a display name being used as a
 * key (FIND-007).
 */
const SNOWFLAKE_PATTERN = /^\d{17,20}$/

/** True when `value` is shaped like a Discord snowflake. */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE_PATTERN.test(value)
}

/** Build the durable identity key for a Discord user id. */
export function identityKeyFor(discordUserId: string): IdentityKey {
  if (!isSnowflake(discordUserId)) {
    throw new MemoryError('INVALID_SNOWFLAKE', 'a durable Discord identity requires a numeric snowflake; presentation text is never an identity key', {
      retryable: false,
      details: { received: discordUserId.slice(0, 32) },
    })
  }
  return `discord:user:${discordUserId}`
}

/** Recover the Discord user id from an identity key, or `undefined` if malformed. */
export function discordUserIdFrom(key: string): string | undefined {
  const prefix = 'discord:user:'
  if (!key.startsWith(prefix))
    return undefined
  const id = key.slice(prefix.length)
  return isSnowflake(id) ? id : undefined
}

/** Voice attributes observed on an utterance. Attributes only — never identity. */
export interface VoiceCharacteristics {
  /** Discord SSRC the audio arrived on, when the adapter knows it. */
  ssrc?: number
  /** Language detected by ASR for this utterance, e.g. `ja`. */
  detectedLanguage?: string
}

/**
 * Frozen presentation fields captured when an event happened (`09-…` §11.2).
 *
 * Absent fields stay absent. Synthesising a `displayNameAtEvent` from whatever
 * happens to be available is how a nickname becomes an identity (REQ-EVENT-002),
 * so the only required presentation field is the one the adapter genuinely
 * rendered at the time.
 */
export interface ActorSnapshot {
  platform: Platform
  /** Required: this is what makes the snapshot attributable. */
  platformUserId: string
  username?: string
  globalName?: string
  guildNickname?: string
  /** What the bot actually displayed or spoke for this actor at event time. */
  displayNameAtEvent: string
  avatarRef?: string
  guildId?: string
  voiceCharacteristics?: VoiceCharacteristics
  observedAt: Timestamp
  /** Which gateway signal produced this snapshot. */
  source: 'gateway' | 'guildMemberUpdate' | 'voiceState' | 'restFetch'
}

/**
 * An event whose author could not be resolved to a Discord user id.
 *
 * Such an event may still be retained under room policy, but it can never be
 * written to person-scoped memory and can never merge with a person record
 * (REQ-ID-003). Modelling it explicitly is what keeps the fallback from being
 * "use the display name as the key".
 */
export interface AnonymousActor {
  kind: 'anonymous'
  /** Whatever was displayed, retained as room evidence only. */
  displayNameAtEvent: string
  observedAt: Timestamp
  /** Why attribution failed, for the audit trail. */
  reason: 'missingUserId' | 'cacheMiss' | 'systemMessage'
}

/** An actor resolved to a durable Discord identity. */
export interface AttributedActor {
  kind: 'attributed'
  personId: PersonId
  identityKey: IdentityKey
  snapshot: ActorSnapshot
}

/** The author of an inbound event. */
export type EventActor = AttributedActor | AnonymousActor

/** True when this actor may be written to person-scoped memory. */
export function isPersonScoped(actor: EventActor): actor is AttributedActor {
  return actor.kind === 'attributed'
}

/**
 * Labels that must never appear as a durable author.
 *
 * `Discord group` is the concrete regression: `conversation-controller.ts:274`
 * passes it as a display name today, and a persistence layer added beneath
 * that call site would faithfully store a person who does not exist
 * (ADR-006, FIND-006).
 */
const SYNTHETIC_AUTHOR_LABELS: readonly string[] = Object.freeze([
  'discord group',
  'group',
  'everyone',
  'system',
  'assistant',
])

/**
 * Reject a person id that is really a human-readable label.
 *
 * A `PersonId` is an opaque surrogate. If it contains spaces or matches a known
 * synthetic label, an adapter has passed presentation text into an identity
 * position and the write must not proceed.
 */
export function assertNotSyntheticAuthor(personId: string): void {
  const normalized = personId.trim().toLowerCase()
  if (/\s/.test(personId) || SYNTHETIC_AUTHOR_LABELS.includes(normalized)) {
    throw new MemoryError('SYNTHETIC_AUTHOR_FORBIDDEN', 'a durable author must be an opaque person id, not a display label', {
      retryable: false,
      details: { received: personId.slice(0, 64) },
    })
  }
}

/** Build an attributed actor, validating the snowflake and the person id. */
export function attributedActor(personId: PersonId, snapshot: ActorSnapshot): AttributedActor {
  assertNotSyntheticAuthor(personId)
  const identityKey = identityKeyFor(snapshot.platformUserId)
  if (snapshot.displayNameAtEvent.length === 0) {
    throw new MemoryError('INVALID_ACTOR', 'displayNameAtEvent is required: it is the evidence of what was actually shown', {
      retryable: false,
    })
  }
  return { kind: 'attributed', personId, identityKey, snapshot }
}

/**
 * The mutable "who is this now" projection (`09-…` §11.2 `current_identity`).
 *
 * Separate from {@link ActorSnapshot} on purpose: updating this row does not
 * rewrite history, and history does not pin this row.
 */
export interface CurrentPresentation {
  identityKey: IdentityKey
  personId: PersonId
  /** Fingerprint of the watched fields; the write-amplification control. */
  fingerprint: string
  username?: string
  globalName?: string
  guildNickname?: string
  avatarRef?: string
  updatedAt: Timestamp
}

/**
 * Presentation fields that are worth a projection write.
 *
 * `observedAt`, `source` and voice characteristics are deliberately excluded:
 * they change on literally every event, and including them would make the
 * fingerprint useless as a change detector (RISK-G, FIND-009 rename storm).
 */
const WATCHED_FIELDS: readonly (keyof ActorSnapshot)[] = Object.freeze([
  'platformUserId',
  'username',
  'globalName',
  'guildNickname',
  'avatarRef',
  'guildId',
])

/**
 * Deterministic 32-bit FNV-1a fingerprint of a snapshot's watched fields.
 *
 * FNV-1a rather than a cryptographic digest because this is a change detector,
 * not a security boundary, and the domain package must not depend on `node:crypto`
 * (it has to run unchanged in any host). Collisions cost one skipped projection
 * update, which the freshness policy re-checks anyway.
 *
 * Before:
 * - `{ platformUserId: '1', username: 'kris', guildNickname: undefined }`
 *
 * After:
 * - `"fnv1a32:5c2f1a03"`
 */
export function snapshotFingerprint(snapshot: ActorSnapshot): string {
  // Field name is folded in with the value so that moving a value between
  // fields (nickname -> username) still changes the fingerprint.
  const canonical = WATCHED_FIELDS
    .map(field => `${field}=${String(snapshot[field] ?? '')}`)
    .join('')

  let hash = 0x811C9DC5
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i)
    // FNV prime 16777619, via shifts to stay inside 32-bit integer maths.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return `fnv1a32:${hash.toString(16).padStart(8, '0')}`
}

/**
 * True when a snapshot differs from the stored projection in a way worth
 * writing. `undefined` previous means "no projection yet", which always writes.
 */
export function hasMaterialChange(previous: CurrentPresentation | undefined, snapshot: ActorSnapshot): boolean {
  if (!previous)
    return true
  return previous.fingerprint !== snapshotFingerprint(snapshot)
}

/**
 * Project a snapshot into the current-presentation row.
 *
 * Callers should gate this on {@link hasMaterialChange}; the function itself is
 * pure and will happily produce an identical row.
 */
export function projectPresentation(actor: AttributedActor): CurrentPresentation {
  const { snapshot } = actor
  return {
    identityKey: actor.identityKey,
    personId: actor.personId,
    fingerprint: snapshotFingerprint(snapshot),
    username: snapshot.username,
    globalName: snapshot.globalName,
    guildNickname: snapshot.guildNickname,
    avatarRef: snapshot.avatarRef,
    updatedAt: snapshot.observedAt,
  }
}
