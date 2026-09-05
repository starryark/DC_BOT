import type { Discord } from '@proj-airi/server-shared/types'

import { describe, expect, it } from 'vitest'

import { chunkDiscordText, normalizeDiscordMetadata } from './airi-adapter'

describe('chunkDiscordText', () => {
  it('keeps every chunk within the requested maximum and preserves content', () => {
    const text = `${'paragraph one '.repeat(20)}\n\n${'paragraph two '.repeat(20)}`
    const chunks = chunkDiscordText(text, 80)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 80)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim())
  })

  it('makes progress through an unbroken string', () => {
    const chunks = chunkDiscordText('x'.repeat(4_001), 1_900)

    expect(chunks.map(chunk => chunk.length)).toEqual([1_900, 1_900, 201])
    expect(chunks.join('')).toBe('x'.repeat(4_001))
  })

  it('rejects limits outside Discord’s supported range', () => {
    expect(() => chunkDiscordText('hello', 0)).toThrow(RangeError)
    expect(() => chunkDiscordText('hello', 2_001)).toThrow(RangeError)
  })
})

describe('normalizeDiscordMetadata (IMP-305 / FIND-010 / SCN-018)', () => {
  it('preserves a durable guildMember id unchanged', () => {
    const discord: Discord = {
      guildId: '987',
      channelId: '321',
      guildMember: { id: '123456789012345678', nickname: 'Christina', displayName: 'Christina' },
    }
    expect(normalizeDiscordMetadata(discord)?.guildMember?.id).toBe('123456789012345678')
  })

  it('never turns a missing id into a display name or nickname', () => {
    // The regression: a cache miss must not promote presentation text into the
    // identity position. An absent id stays empty (and empty is not a snowflake).
    const discord: Discord = {
      guildId: '987',
      channelId: '321',
      guildMember: { id: '', nickname: 'DisplayOnly', displayName: 'DisplayOnly' },
    }
    const normalized = normalizeDiscordMetadata(discord)?.guildMember
    expect(normalized?.id).toBe('')
    expect(normalized?.id).not.toBe('DisplayOnly')
  })

  it('cross-fills a missing nickname/displayName as presentation only', () => {
    // Defensive: a malformed payload with an undefined presentation field
    // borrows from the other so downstream display text is not empty. The ??
    // operator treats empty string as intentional, so only null/undefined
    // trigger the fallback — the id field is never a source for presentation.
    const discord = {
      guildMember: { id: '1', displayName: 'Rendered' },
    } as unknown as Discord
    const normalized = normalizeDiscordMetadata(discord)?.guildMember
    expect(normalized?.nickname).toBe('Rendered')
    expect(normalized?.displayName).toBe('Rendered')
    expect(normalized?.id).toBe('1')
  })

  it('passes payloads without a guildMember through untouched', () => {
    const discord: Discord = { guildId: '987', channelId: '321' }
    expect(normalizeDiscordMetadata(discord)).toEqual(discord)
    expect(normalizeDiscordMetadata(undefined)).toBeUndefined()
  })
})
