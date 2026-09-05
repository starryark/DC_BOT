import type { RoomBinding } from './rooms'

import { describe, expect, it } from 'vitest'

import {
  FIXTURE_CHARACTER,
  FIXTURE_DM_LOCATION,
  FIXTURE_GUILD_ID,
  FIXTURE_NO_BINDINGS,
  FIXTURE_TEXT_LOCATION,
  FIXTURE_VOICE_LOCATION,
} from './fixtures'
import { asBindingId, asCharacterId, asLogicalRoomId, asTimestamp } from './ids'
import { assertBindable, isolatedLogicalRoomId, physicalRoomIdOf, resolveLogicalRoom } from './rooms'

const NOW = asTimestamp('2026-08-02T12:00:00.000Z')
const BOUND_ROOM = asLogicalRoomId('room:makise-kurisu:shared-standup')

function binding(overrides: Partial<RoomBinding> = {}): RoomBinding {
  return {
    bindingId: asBindingId('binding-1'),
    physicalRoomId: physicalRoomIdOf(FIXTURE_VOICE_LOCATION),
    logicalRoomId: BOUND_ROOM,
    characterId: FIXTURE_CHARACTER,
    bindingKind: 'explicit',
    policy: { crossChannelHistory: true, direction: 'bidirectional' },
    validFrom: asTimestamp('2026-08-01T00:00:00.000Z'),
    createdBy: 'operator:starryark',
    ...overrides,
  }
}

describe('physical room identity', () => {
  it('encodes guild, medium and channel so two mediums never collide', () => {
    expect(physicalRoomIdOf(FIXTURE_VOICE_LOCATION))
      .toBe(`discord:guild:${FIXTURE_GUILD_ID}:guildVoice:900000000000000002`)
    expect(physicalRoomIdOf(FIXTURE_TEXT_LOCATION))
      .toBe(`discord:guild:${FIXTURE_GUILD_ID}:guildText:900000000000000003`)
    expect(physicalRoomIdOf(FIXTURE_VOICE_LOCATION)).not.toBe(physicalRoomIdOf(FIXTURE_TEXT_LOCATION))
  })

  it('keeps DMs in their own namespace with no guild component', () => {
    expect(physicalRoomIdOf(FIXTURE_DM_LOCATION)).toBe('discord:dm:900000000000000004')
  })

  it('refuses a guild channel with no guild id', () => {
    expect(() => physicalRoomIdOf({ platform: 'discord', channelId: '1', channelKind: 'guildText' }))
      .toThrowError(/requires a guildId/)
  })

  it('refuses a DM that carries a guild id', () => {
    expect(() => physicalRoomIdOf({ platform: 'discord', guildId: '2', channelId: '1', channelKind: 'dm' }))
      .toThrowError(/must not carry a guildId/)
  })
})

// AC-013 / TEST-SCOPE-002: unbound channels share nothing by default.
describe('default isolation (REQ-SCOPE-002)', () => {
  it('gives each unbound channel its own logical room', () => {
    const voice = resolveLogicalRoom({ location: FIXTURE_VOICE_LOCATION, characterId: FIXTURE_CHARACTER, bindings: FIXTURE_NO_BINDINGS, at: NOW })
    const text = resolveLogicalRoom({ location: FIXTURE_TEXT_LOCATION, characterId: FIXTURE_CHARACTER, bindings: FIXTURE_NO_BINDINGS, at: NOW })

    expect(voice.roomKind).toBe('isolated')
    expect(text.roomKind).toBe('isolated')
    expect(voice.logicalRoomId).not.toBe(text.logicalRoomId)
  })

  it('separates the same channel across two characters (TEST-SCOPE-003)', () => {
    const kurisu = isolatedLogicalRoomId(physicalRoomIdOf(FIXTURE_VOICE_LOCATION), FIXTURE_CHARACTER)
    const other = isolatedLogicalRoomId(physicalRoomIdOf(FIXTURE_VOICE_LOCATION), asCharacterId('other-character'))
    expect(kurisu).not.toBe(other)
  })

  // SCN-019: two channels called #general are still two rooms.
  it('never merges rooms by name — only an explicit binding id joins them', () => {
    const a = resolveLogicalRoom({
      location: { platform: 'discord', guildId: FIXTURE_GUILD_ID, channelId: '111', channelKind: 'guildText' },
      characterId: FIXTURE_CHARACTER,
      bindings: FIXTURE_NO_BINDINGS,
      at: NOW,
    })
    const b = resolveLogicalRoom({
      location: { platform: 'discord', guildId: FIXTURE_GUILD_ID, channelId: '222', channelKind: 'guildText' },
      characterId: FIXTURE_CHARACTER,
      bindings: FIXTURE_NO_BINDINGS,
      at: NOW,
    })
    expect(a.logicalRoomId).not.toBe(b.logicalRoomId)
  })
})

describe('explicit bindings (TEST-SCOPE-002)', () => {
  it('joins a channel to a shared logical room when a binding is active', () => {
    const resolution = resolveLogicalRoom({
      location: FIXTURE_VOICE_LOCATION,
      characterId: FIXTURE_CHARACTER,
      bindings: [binding()],
      at: NOW,
    })
    expect(resolution).toMatchObject({ roomKind: 'bound', logicalRoomId: BOUND_ROOM, bindingId: 'binding-1' })
  })

  it('ignores a binding that has been revoked', () => {
    const resolution = resolveLogicalRoom({
      location: FIXTURE_VOICE_LOCATION,
      characterId: FIXTURE_CHARACTER,
      bindings: [binding({ validUntil: asTimestamp('2026-08-02T00:00:00.000Z') })],
      at: NOW,
    })
    expect(resolution.roomKind).toBe('isolated')
  })

  it('ignores a binding that shares addressing but not history', () => {
    const resolution = resolveLogicalRoom({
      location: FIXTURE_VOICE_LOCATION,
      characterId: FIXTURE_CHARACTER,
      bindings: [binding({ policy: { crossChannelHistory: false, direction: 'bidirectional' } })],
      at: NOW,
    })
    expect(resolution.roomKind).toBe('isolated')
  })

  it('ignores a binding belonging to another character', () => {
    const resolution = resolveLogicalRoom({
      location: FIXTURE_VOICE_LOCATION,
      characterId: asCharacterId('another-character'),
      bindings: [binding()],
      at: NOW,
    })
    expect(resolution.roomKind).toBe('isolated')
  })

  it('refuses to guess when two active bindings claim the same location', () => {
    const bindings = [binding(), binding({ bindingId: asBindingId('binding-2'), logicalRoomId: asLogicalRoomId('room:makise-kurisu:other') })]
    expect(() => resolveLogicalRoom({ location: FIXTURE_VOICE_LOCATION, characterId: FIXTURE_CHARACTER, bindings, at: NOW }))
      .toThrowError(/more than one active history binding/)
  })
})

// TEST-SCOPE-001 / FIND-011: DM isolation is absolute.
describe('direct-message isolation (ADR-005)', () => {
  it('refuses to bind a DM to a guild-scoped room', () => {
    expect(() => assertBindable(FIXTURE_DM_LOCATION, {
      logicalRoomId: BOUND_ROOM,
      characterId: FIXTURE_CHARACTER,
      kind: 'guildVoice',
      bindingVersion: 0,
    })).toThrowError(/DM/)
  })

  it('refuses to bind a guild channel into a DM room', () => {
    expect(() => assertBindable(FIXTURE_TEXT_LOCATION, {
      logicalRoomId: BOUND_ROOM,
      characterId: FIXTURE_CHARACTER,
      kind: 'dm',
      bindingVersion: 0,
    })).toThrowError(/DM/)
  })

  it('rejects a cross-channel history binding applied to a DM', () => {
    const dmBinding = binding({ physicalRoomId: physicalRoomIdOf(FIXTURE_DM_LOCATION) })
    expect(() => resolveLogicalRoom({ location: FIXTURE_DM_LOCATION, characterId: FIXTURE_CHARACTER, bindings: [dmBinding], at: NOW }))
      .toThrowError(/DM/)
  })

  it('leaves an unbound DM isolated', () => {
    const resolution = resolveLogicalRoom({ location: FIXTURE_DM_LOCATION, characterId: FIXTURE_CHARACTER, bindings: FIXTURE_NO_BINDINGS, at: NOW })
    expect(resolution.roomKind).toBe('isolated')
  })
})
