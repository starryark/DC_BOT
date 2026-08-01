import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import { availableBehaviorMotion, useAvatarStore } from './avatar'

function snapshot(sessionId: string, sequence: number, connected = true) {
  return {
    schemaVersion: 1 as const,
    type: 'avatar.state.snapshot' as const,
    guildId: 'g',
    channelId: 'c',
    sessionId,
    sequence,
    timestamp: sequence,
    connected,
    behavior: 'idle' as const,
    speaking: false as const,
    mouthOpen: 0 as const,
  }
}

describe('avatar state ordering', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('rejects stale sequences, identity mismatches, and retired sessions', () => {
    const store = useAvatarStore()
    expect(store.replace(snapshot('old', 2), 'g', 'c')).toBe(true)
    expect(store.apply(snapshot('old', 1), 'g', 'c')).toBe(false)
    expect(store.apply(snapshot('new', 0), 'g', 'c')).toBe(true)
    expect(store.apply(snapshot('old', 3), 'g', 'c')).toBe(false)
    expect(store.apply(snapshot('other', 1), 'wrong', 'c')).toBe(false)
  })

  it('returns actual case-sensitive motion groups and preserves defaults without Idle', () => {
    expect(availableBehaviorMotion('listening', ['IDLE', 'cUrIoUs'])).toBe('cUrIoUs')
    expect(availableBehaviorMotion('thinking', ['Rest', 'iDle'])).toBe('iDle')
    expect(availableBehaviorMotion('thinking', ['Rest'])).toBeUndefined()
  })
})
