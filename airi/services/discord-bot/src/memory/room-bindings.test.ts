import { MemoryError } from '@proj-airi/memory-domain'
import { describe, expect, it } from 'vitest'

import { parseRoomBindingFile } from './room-bindings'

const text = { kind: 'guildText', guildId: '10000000000000001', channelId: '20000000000000001' }
const voice = { kind: 'guildVoice', guildId: '10000000000000001', channelId: '20000000000000002' }

describe('room binding file', () => {
  it('accepts deliberate same-guild text and voice continuity', () => {
    const [binding] = parseRoomBindingFile({ version: 1, bindings: [{ id: 'lab', characterId: 'kurisu', locations: [text, voice] }] })
    expect(binding?.locations).toHaveLength(2)
    expect(binding?.characterId).toBe('kurisu')
  })

  it.each([
    ['unknown version', { version: 2, bindings: [] }],
    ['invalid snowflake', { version: 1, bindings: [{ id: 'x', characterId: 'kurisu', locations: [text, { ...voice, channelId: 'voice' }] }] }],
    ['cross guild', { version: 1, bindings: [{ id: 'x', characterId: 'kurisu', locations: [text, { ...voice, guildId: '10000000000000002' }] }] }],
    ['DM and guild mixing', { version: 1, bindings: [{ id: 'x', characterId: 'kurisu', locations: [text, { kind: 'dm', channelId: '30000000000000001' }] }] }],
  ])('fails closed for %s', (_, input) => {
    expect(() => parseRoomBindingFile(input)).toThrow(MemoryError)
  })

  it('rejects overlaps for the same character', () => {
    expect(() => parseRoomBindingFile({ version: 1, bindings: [
      { id: 'a', characterId: 'kurisu', locations: [text, voice] },
      { id: 'b', characterId: 'kurisu', locations: [text, { ...voice, channelId: '20000000000000003' }] },
    ] })).toThrow(/overlaps/)
  })

  it('keeps identical locations isolated between characters', () => {
    expect(parseRoomBindingFile({ version: 1, bindings: [
      { id: 'a', characterId: 'kurisu', locations: [text, voice] },
      { id: 'b', characterId: 'airi', locations: [text, voice] },
    ] })).toHaveLength(2)
  })
})
