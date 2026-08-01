import type { WebSocket } from 'ws'

import { describe, expect, it, vi } from 'vitest'

import { RoomRegistry } from './registry'

function update(sequence: number, sessionId = 'session') {
  return {
    schemaVersion: 1 as const,
    type: 'avatar.behavior.set' as const,
    guildId: 'g',
    channelId: 'c',
    sessionId,
    sequence,
    timestamp: sequence,
    connected: true,
    behavior: 'idle' as const,
    speaking: false as const,
    mouthOpen: 0 as const,
  }
}

describe('room registry', () => {
  it('rejects stale session sequences', () => {
    const registry = new RoomRegistry()
    expect(registry.apply(update(2)).status).toBe('accepted')
    expect(registry.apply(update(2)).status).toBe('duplicate')
    expect(registry.apply(update(1)).status).toBe('stale')
    expect(registry.apply({ ...update(2), behavior: 'thinking' }).status).toBe('conflict')
  })

  it('fans out and supplies late join snapshots', () => {
    const registry = new RoomRegistry()
    registry.establish('g', 'c')
    const viewer = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as WebSocket
    registry.subscribe('g', 'c', viewer)
    const snapshot = registry.apply(update(1)).snapshot
    expect(viewer.send).toHaveBeenCalledWith(JSON.stringify(snapshot))
    const late = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as WebSocket
    expect(registry.subscribe('g', 'c', late)).toEqual(snapshot)
  })

  it('keeps subscribers and the disconnected snapshot across re-establishment', () => {
    const registry = new RoomRegistry()
    const viewer = { OPEN: 1, readyState: 1, send: vi.fn() } as unknown as WebSocket
    registry.subscribe('g', 'c', viewer)
    registry.apply(update(1))
    registry.apply({ ...update(2), connected: false })
    expect(registry.has('g', 'c')).toBe(false)
    expect(registry.subscribe('g', 'c', viewer)?.connected).toBe(false)
    registry.apply(update(0, 'new-session'))
    expect(registry.has('g', 'c')).toBe(true)
    expect(viewer.send).toHaveBeenCalledTimes(3)
    expect(registry.apply(update(3)).status).toBe('stale')
  })
})
