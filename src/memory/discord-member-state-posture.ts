/**
 * Discord member-state posture (IMP-305 / FIND-010 / OQ-BLOCK-004).
 *
 * Two distinct claims are separated here so the weaker one can never be silently
 * upgraded into the stronger:
 *
 * - **Event-local presentation** (what M1 actually has): the fields already
 *   present on an inbound gateway event — platform user id, username, global
 *   name, guild nickname, rendered display name. They are observations of what
 *   the actor looked like *at that instant*, captured by
 *   {@link import('./discord-actor-snapshot').buildDiscordActorEvidence}.
 * - **Continuously-current guild-member state** (what M1 does NOT claim): a live
 *   view of nickname/avatar/roles that stays fresh between events. That requires
 *   the privileged `GUILD_MEMBERS` gateway intent, a populated member cache, and
 *   `guildMemberAdd`/`Update`/`Remove` handling. None of those are activated in
 *   this milestone, so no code path may behave as if they were.
 *
 * The durable identity authority is always the Discord user snowflake
 * (ADR-003). A missing nickname or display name stays absent; it is never
 * synthesised and never becomes an identity key (FIND-007, SCN-018). Alias
 * visibility, room binding, and memory authorization are decided by the
 * persisted scope lattice in `memory-domain`, not by whatever nickname happened
 * to be cached, so a stale or missing member row cannot move an authorization
 * boundary (FIND-010 failure sequence).
 *
 * Surfacing this posture as a frozen record — and failing closed when a stronger
 * one is requested without its prerequisites — is the operational close for
 * FIND-010: the intent matrix, cache-miss behaviour, REST-fallback limit, and
 * stale-data policy are all stated in one place and re-emitted at startup.
 */

import { GatewayIntentBits } from 'discord.js'

/**
 * The member-state claims a capability may require.
 *
 * Ordered by strength: a capability is only satisfied when the running posture
 * is at least as strong, checked by {@link assertMemberStateCapability}.
 */
export type DiscordMemberStateCapability
  = | 'event-local-presentation'
    | 'continuously-current-member-state'

/** Strength order; higher numbers require strictly more operational support. */
const CAPABILITY_RANK: Record<DiscordMemberStateCapability, number> = {
  'event-local-presentation': 0,
  'continuously-current-member-state': 1,
}

/**
 * Every gateway intent the Milestone 1 Discord client requests.
 *
 * `GUILD_MEMBERS` is deliberately absent: identity, alias authorization, room
 * authorization, and memory retrieval are all snowflake-keyed and do not need
 * continuously-current member state. Adding an intent here without also raising
 * the posture capability would be a least-privilege violation, not a quiet
 * upgrade.
 */
export const DISCORD_M1_GATEWAY_INTENTS: readonly GatewayIntentBits[] = Object.freeze([
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
  GatewayIntentBits.GuildVoiceStates,
])

/** The frozen Milestone 1 member-state posture; the single source for diagnostics. */
export interface DiscordMemberStatePosture {
  /** The strongest member-state claim this process is authorized to make. */
  readonly capability: DiscordMemberStateCapability
  /** Gateway intents actually requested; `GUILD_MEMBERS` is absent for M1. */
  readonly gatewayIntents: readonly GatewayIntentBits[]
  /** True only when the privileged members intent is requested. Always false in M1. */
  readonly guildMembersIntentRequested: boolean
  /** The durable attribution authority. Presentation fields are never this. */
  readonly identityAuthority: 'discord-user-snowflake'
  /**
   * Whether presentation fields are guaranteed continuously current between
   * events. Always false in M1: they are event-local snapshots.
   */
  readonly continuouslyCurrentMemberState: boolean
  /** Operator-facing summary, emitted at startup. */
  readonly summary: string
}

/**
 * The Milestone 1 posture.
 *
 * Presentation enrichment from a single-member REST fetch (voice ingress) is
 * permitted because it is best-effort, event-scoped, and never becomes an
 * identity key; it does not raise the capability.
 */
export const M1_MEMBER_STATE_POSTURE: DiscordMemberStatePosture = Object.freeze({
  capability: 'event-local-presentation',
  gatewayIntents: DISCORD_M1_GATEWAY_INTENTS,
  guildMembersIntentRequested: false,
  identityAuthority: 'discord-user-snowflake',
  continuouslyCurrentMemberState: false,
  summary: 'Discord member-state posture: event-local presentation only. GUILD_MEMBERS is not requested; '
    + 'guild nickname/display-name are ingress snapshots, not continuously-current member state; '
    + 'durable identity is the Discord user snowflake.',
})

/**
 * Fail closed when a caller needs a stronger member-state capability than the
 * running posture provides.
 *
 * The realistic future hazard is a feature written against continuously-current
 * member state (e.g. live nickname-driven addressing) landing while the process
 * still runs without `GUILD_MEMBERS`, a member cache, and member-update handling.
 * Silently degrading such a feature would re-open the FIND-010 failure sequence
 * (stale nickname treated as current → wrong addressing/privacy). Throwing keeps
 * the absence explicit.
 */
export function assertMemberStateCapability(requested: DiscordMemberStateCapability, posture: DiscordMemberStateCapability): void {
  if (CAPABILITY_RANK[requested] > CAPABILITY_RANK[posture]) {
    throw new Error(
      `Discord member-state capability '${requested}' is not satisfied by the active posture '${posture}'. `
      + 'Continuously-current guild-member state requires the GUILD_MEMBERS gateway intent, a populated member cache, '
      + 'and guildMemberAdd/Update/Remove handling; none are activated in Milestone 1.',
    )
  }
}

/** True when the named intent is part of the posture's requested set. */
export function postureRequestsIntent(posture: DiscordMemberStatePosture, intent: GatewayIntentBits): boolean {
  return posture.gatewayIntents.includes(intent)
}
