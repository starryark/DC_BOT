import { describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'

describe('discord actor evidence', () => {
  it('captures all available fields and freezes nickname precedence at ingress', () => {
    const input = {
      userId: '123456789012345678',
      username: 'kurisu',
      globalName: 'Makise',
      guildNickname: 'Christina',
      displayName: 'Rendered name',
      avatarUrl: 'https://cdn.example/avatar.png',
      guildId: '987654321098765432',
      observedAtEpochMs: 1_700_000_000_123,
      source: 'gateway' as const,
    }
    const evidence = buildDiscordActorEvidence(input)

    expect(evidence.kind).toBe('attributed')
    if (evidence.kind !== 'attributed')
      return
    expect(evidence.snapshot).toEqual({
      platform: 'discord',
      platformUserId: input.userId,
      username: 'kurisu',
      globalName: 'Makise',
      guildNickname: 'Christina',
      displayNameAtEvent: 'Christina',
      avatarRef: 'https://cdn.example/avatar.png',
      guildId: input.guildId,
      observedAt: '2023-11-14T22:13:20.123Z',
      source: 'gateway',
    })
    expect(Object.isFrozen(evidence)).toBe(true)
    expect(Object.isFrozen(evidence.snapshot)).toBe(true)
    expect(input.displayName).toBe('Rendered name')
  })

  it.each([
    ['username only', { userId: '1', username: 'user' }, 'user'],
    ['global name only', { userId: '1', globalName: 'Global' }, 'Global'],
    ['DM without guild fields', { userId: '1', displayName: 'DM user' }, 'DM user'],
    ['cache miss with stable id', { userId: '1', displayName: 'Known', anonymousReason: 'cacheMiss' as const }, 'Known'],
    ['absent avatar and null optionals', { userId: '1', username: 'user', avatarUrl: null, globalName: null }, 'user'],
  ])('keeps an identified actor attributed: %s', (_label, fields, expectedDisplayName) => {
    const evidence = buildDiscordActorEvidence({ ...fields, observedAtEpochMs: 0, source: 'gateway' })
    expect(evidence.kind).toBe('attributed')
    if (evidence.kind === 'attributed') {
      expect(evidence.snapshot.displayNameAtEvent).toBe(expectedDisplayName)
      expect(evidence.snapshot.avatarRef).toBeUndefined()
    }
  })

  it('marks actual REST evidence without performing a fetch', () => {
    const evidence = buildDiscordActorEvidence({ userId: '1', username: 'user', observedAtEpochMs: 0, source: 'restFetch' })
    expect(evidence.kind === 'attributed' && evidence.snapshot.source).toBe('restFetch')
  })

  it.each([
    ['missing id', { displayName: 'Unknown' }, 'missingUserId'],
    ['explicit system message', { userId: '1', displayName: 'System', anonymousReason: 'systemMessage' as const }, 'systemMessage'],
  ])('creates anonymous evidence for %s', (_label, fields, reason) => {
    const evidence = buildDiscordActorEvidence({ ...fields, observedAtEpochMs: 0, source: 'gateway' })
    expect(evidence.kind).toBe('anonymous')
    if (evidence.kind === 'anonymous')
      expect(evidence.actor.reason).toBe(reason)
  })
})
