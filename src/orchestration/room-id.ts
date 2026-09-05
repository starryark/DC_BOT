/**
 * Conversation room identity (Runtime V2, `02-public-contracts.md` §2.1).
 *
 * Replaces the per-guild history key used by `GuildSession`. A room is the
 * unit of shared conversation context: two unrelated channels in one guild
 * MUST NOT share recent turns, but two speakers in one voice room MUST share
 * that room's history (`01-architecture.md` invariant #2, `04-decisions.md`
 * D003).
 *
 * Room ids are **deterministic strings** built from the (guild, channel) pair
 * plus a medium tag, so the same physical place always maps to the same room.
 * Optional explicit room binding (Wave 3B) lets a voice room + text channel
 * share a logical room; unbound channels stay isolated.
 */

/**
 * Opaque, deterministic identifier for a conversation room.
 *
 * Shape: `guild:<guildId>:<medium>:<channelId>` where `<medium>` is `text`,
 * `thread`, or `voice`. Treated as opaque downstream — callers should build
 * ids via {@link textRoom} / {@link threadRoom} / {@link voiceRoom} and only
 * compare them by equality.
 */
export type ConversationRoomId = string

/** Room id for a guild text channel. */
export function textRoom(guildId: string, channelId: string): ConversationRoomId {
  return `guild:${guildId}:text:${channelId}`
}

/** Room id for a guild thread (a thread is its own context, not its parent's). */
export function threadRoom(guildId: string, threadId: string): ConversationRoomId {
  return `guild:${guildId}:thread:${threadId}`
}

/** Room id for a voice channel — everyone in the channel shares one room. */
export function voiceRoom(guildId: string, voiceChannelId: string): ConversationRoomId {
  return `guild:${guildId}:voice:${voiceChannelId}`
}
