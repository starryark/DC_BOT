import { GatewayIntentBits } from 'discord.js'
import { describe, expect, it } from 'vitest'

import {
  assertMemberStateCapability,
  DISCORD_M1_GATEWAY_INTENTS,
  M1_MEMBER_STATE_POSTURE,
  postureRequestsIntent,
} from './discord-member-state-posture'

describe('discord M1 member-state posture (IMP-305 / FIND-010)', () => {
  it('requests exactly the least-privilege M1 intent set and no GUILD_MEMBERS', () => {
    expect(DISCORD_M1_GATEWAY_INTENTS).toEqual([
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildVoiceStates,
    ])
    // SCN-017: the bot runs without the GUILD_MEMBERS privileged intent.
    expect(postureRequestsIntent(M1_MEMBER_STATE_POSTURE, GatewayIntentBits.GuildMembers)).toBe(false)
    expect(M1_MEMBER_STATE_POSTURE.guildMembersIntentRequested).toBe(false)
  })

  it('does not claim continuously-current guild-member state', () => {
    // The posture must not assert freshness M1 cannot deliver; a nickname seen
    // on ingress is a snapshot, not a live member view.
    expect(M1_MEMBER_STATE_POSTURE.capability).toBe('event-local-presentation')
    expect(M1_MEMBER_STATE_POSTURE.continuouslyCurrentMemberState).toBe(false)
  })

  it('keeps the Discord user snowflake as the durable identity authority', () => {
    // Presentation text is never the identity authority; this is the invariant
    // that makes a cache miss safe (SCN-018) and a same-name collision non-merging.
    expect(M1_MEMBER_STATE_POSTURE.identityAuthority).toBe('discord-user-snowflake')
  })

  it('is frozen so the posture cannot be mutated at runtime', () => {
    expect(Object.isFrozen(M1_MEMBER_STATE_POSTURE)).toBe(true)
    expect(Object.isFrozen(DISCORD_M1_GATEWAY_INTENTS)).toBe(true)
  })

  it('allows a caller that only needs event-local presentation', () => {
    expect(() => assertMemberStateCapability('event-local-presentation', M1_MEMBER_STATE_POSTURE.capability)).not.toThrow()
  })

  it('fails closed when a future feature requires continuously-current member state without its prerequisites', () => {
    // A stronger capability requested under the M1 posture must throw rather
    // than silently degrade into stale-nickname-as-current (FIND-010 sequence).
    expect(() => assertMemberStateCapability('continuously-current-member-state', M1_MEMBER_STATE_POSTURE.capability)).toThrow(
      /not satisfied by the active posture 'event-local-presentation'/,
    )
  })

  it('allows the stronger capability only when the posture actually provides it', () => {
    // A process that genuinely raised its posture (separate, future work) may
    // request the stronger capability without throwing.
    expect(() => assertMemberStateCapability('continuously-current-member-state', 'continuously-current-member-state')).not.toThrow()
    expect(() => assertMemberStateCapability('event-local-presentation', 'continuously-current-member-state')).not.toThrow()
  })
})
