import type { ConversationTurn } from './room'

import { describe, expect, it } from 'vitest'

import { config, resetConfigCache } from '../config'
import { InMemoryRoomStore } from './room'
import { textRoom, threadRoom, voiceRoom } from './room-id'

/**
 * Room identity + isolation invariants (`01-architecture.md` invariant #2,
 * `04-decisions.md` D003, `02-public-contracts.md` §2):
 * - Room ids are deterministic strings.
 * - Two channels in one guild MUST NOT share recent history.
 * - Two speakers in one voice room MUST share that room's history.
 * - recentTurns is bounded; clear() empties a room.
 */

function turn(role: 'user' | 'assistant', text: string, n = 1): ConversationTurn {
  return {
    turnId: `t${n}`,
    role,
    speaker: role === 'user' ? `speaker${n}` : undefined,
    text,
    timestamp: 1000 * n,
  }
}

describe('room-id — deterministic room ids', () => {
  it('builds distinct, deterministic ids per medium+channel', () => {
    expect(textRoom('g', 'a')).toBe('guild:g:text:a')
    expect(threadRoom('g', 't1')).toBe('guild:g:thread:t1')
    expect(voiceRoom('g', 'vc')).toBe('guild:g:voice:vc')
  })

  it('isolates two text channels in the same guild', () => {
    expect(textRoom('g', 'a')).not.toBe(textRoom('g', 'b'))
    // Same inputs always produce the same id (deterministic).
    expect(textRoom('g', 'a')).toBe(textRoom('g', 'a'))
  })

  it('keeps text/thread/voice of the same channel id distinct', () => {
    const id = 'chan'
    expect(new Set([textRoom('g', id), threadRoom('g', id), voiceRoom('g', id)]).size).toBe(3)
  })

  it('isolates the same channel id across different guilds', () => {
    expect(textRoom('g1', 'a')).not.toBe(textRoom('g2', 'a'))
    expect(voiceRoom('g1', 'vc')).not.toBe(voiceRoom('g2', 'vc'))
  })
})

describe('inMemoryRoomStore — isolation invariants', () => {
  it('does NOT share history between two text channels in one guild', () => {
    const store = new InMemoryRoomStore()
    const science = textRoom('g', 'science')
    const gaming = textRoom('g', 'gaming')

    store.appendTurn(science, turn('user', 'entropy question', 1))

    expect(store.get(science)?.recentTurns.map(t => t.text)).toEqual(['entropy question'])
    // #gaming must see nothing from #science.
    expect(store.get(gaming)?.recentTurns ?? []).toEqual([])
  })

  it('shares history between two users speaking in ONE voice room', () => {
    const store = new InMemoryRoomStore()
    const room = voiceRoom('g', 'vc')

    const userA: ConversationTurn = { turnId: 't1', role: 'user', speaker: 'Alice', text: 'hello from alice', timestamp: 1 }
    const userB: ConversationTurn = { turnId: 't2', role: 'user', speaker: 'Bob', text: 'hello from bob', timestamp: 2 }
    store.appendTurn(room, userA)
    store.appendTurn(room, userB)

    const recent = store.get(room)!.recentTurns
    expect(recent.map(t => t.speaker)).toEqual(['Alice', 'Bob'])
    expect(recent.map(t => t.text)).toEqual(['hello from alice', 'hello from bob'])
  })

  it('lazily creates rooms via getOrCreate with the given character id', () => {
    const store = new InMemoryRoomStore()
    const room = store.getOrCreate(voiceRoom('g', 'vc'), 'kurisu')
    expect(room.characterId).toBe('kurisu')
    expect(room.recentTurns).toEqual([])
    // Same id returns the same room object.
    expect(store.getOrCreate(voiceRoom('g', 'vc'), 'kurisu')).toBe(room)
  })

  it('appendTurn lazily creates the room if missing', () => {
    const store = new InMemoryRoomStore()
    const id = textRoom('g', 'c')
    store.appendTurn(id, turn('assistant', 'hi'))
    expect(store.get(id)?.recentTurns.length).toBe(1)
  })
})

describe('inMemoryRoomStore — turn bounding', () => {
  it('drops the oldest turns once recentTurns exceeds the bound', () => {
    const store = new InMemoryRoomStore({ maxTurns: 3 })
    const id = voiceRoom('g', 'vc')
    store.appendTurn(id, { turnId: 't1', role: 'user', text: 'one', timestamp: 1 })
    store.appendTurn(id, { turnId: 't2', role: 'assistant', text: 'two', timestamp: 2 })
    store.appendTurn(id, { turnId: 't3', role: 'user', text: 'three', timestamp: 3 })
    store.appendTurn(id, { turnId: 't4', role: 'assistant', text: 'four', timestamp: 4 })

    const recent = store.get(id)!.recentTurns
    // Bounded to 3; the oldest ('one') is dropped.
    expect(recent.map(t => t.text)).toEqual(['two', 'three', 'four'])
  })

  it('defaults the bound to config().brain.maxMessages', () => {
    // The default config has CONVERSATION_MAX_MESSAGES unset → 24.
    resetConfigCache()
    expect(config().brain.maxMessages).toBe(24)
    const store = new InMemoryRoomStore()
    const id = voiceRoom('g', 'vc')
    for (let i = 0; i < 30; i++)
      store.appendTurn(id, { turnId: `t${i}`, role: 'user', text: `${i}`, timestamp: i })
    expect(store.get(id)!.recentTurns.length).toBe(24)
    // Oldest 6 dropped; first kept turn is index 6.
    expect(store.get(id)!.recentTurns[0].text).toBe('6')
  })
})

describe('inMemoryRoomStore — summary / mode / clear', () => {
  it('stores and overwrites the running summary', () => {
    const store = new InMemoryRoomStore()
    const id = textRoom('g', 'c')
    store.setRunningSummary(id, 'sum1')
    expect(store.get(id)?.runningSummary).toBe('sum1')
    store.setRunningSummary(id, 'sum2')
    expect(store.get(id)?.runningSummary).toBe('sum2')
  })

  it('sets and clears the active mode (undefined = default)', () => {
    const store = new InMemoryRoomStore()
    const id = textRoom('g', 'c')
    store.setActiveMode(id, 'amadeus')
    expect(store.get(id)?.activeMode).toBe('amadeus')
    store.setActiveMode(id, undefined)
    expect(store.get(id)?.activeMode).toBeUndefined()
  })

  it('clear() empties turns + summary but keeps the room registered', () => {
    const store = new InMemoryRoomStore()
    const id = textRoom('g', 'c')
    store.appendTurn(id, turn('user', 'keep me? no'))
    store.setRunningSummary(id, 'sum')
    store.clear(id)

    const room = store.get(id)
    expect(room).toBeDefined()
    expect(room?.recentTurns).toEqual([])
    expect(room?.runningSummary).toBeUndefined()
  })

  it('clear() on a non-existent room is a no-op (does not throw, does not create)', () => {
    const store = new InMemoryRoomStore()
    const id = textRoom('g', 'missing')
    expect(() => store.clear(id)).not.toThrow()
    expect(store.get(id)).toBeUndefined()
  })

  it('bumps updatedAt on every mutation', () => {
    const store = new InMemoryRoomStore()
    const id = textRoom('g', 'c')
    const created = store.getOrCreate(id, 'kurisu')
    const createdAt = created.createdAt
    store.appendTurn(id, turn('user', 'x'))
    expect(store.get(id)!.updatedAt).toBeGreaterThanOrEqual(createdAt)
  })
})
