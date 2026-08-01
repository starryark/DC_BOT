import { describe, expect, it, vi } from 'vitest'

import { createRelay } from './app'
import { RoomRegistry } from './registry'

const config = {
  host: '127.0.0.1',
  port: 8080,
  publicBaseUrl: '',
  publishSecret: 'publisher',
  discordClientId: 'client',
  discordClientSecret: 'oauth-secret',
  sessionSigningSecret: 'signing',
}

function activeUpdate(connected = true, sequence = 0) {
  return {
    schemaVersion: 1 as const,
    type: 'avatar.behavior.set' as const,
    guildId: 'g',
    channelId: 'c',
    sessionId: 's',
    sequence,
    timestamp: sequence,
    connected,
    behavior: 'idle' as const,
    speaking: false as const,
    mouthOpen: 0 as const,
  }
}

describe('discord OAuth exchange', () => {
  it('strictly validates bodies and returns bounded relay credentials', async () => {
    const registry = new RoomRegistry()
    registry.apply(activeUpdate())
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'discord-token' }))
      .mockResolvedValueOnce(Response.json({ id: 'user' }))
      .mockResolvedValueOnce(Response.json({ roles: [] }))
    const relay = createRelay(config, registry, { fetch, now: () => 10_000 })

    const invalid = await relay.app.request('/api/auth/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'code', guildId: 'g', channelId: 'c', extra: true }),
    })
    expect(invalid.status).toBe(400)

    const response = await relay.app.request('/api/auth/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'code', guildId: 'g', channelId: 'c' }),
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ accessToken: 'discord-token', expiresIn: 300 })
  })

  it('rechecks room availability after Discord requests complete', async () => {
    const registry = new RoomRegistry()
    registry.apply(activeUpdate())
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ access_token: 'discord-token' }))
      .mockImplementationOnce(async () => {
        registry.apply(activeUpdate(false, 1))
        return Response.json({ id: 'user' })
      })
      .mockResolvedValueOnce(Response.json({ roles: [] }))
    const relay = createRelay(config, registry, { fetch, now: () => 10_000 })
    const response = await relay.app.request('/api/auth/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'code', guildId: 'g', channelId: 'c' }),
    })
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({ error: 'room_unavailable' })
  })

  it('converts Discord network failures into controlled responses', async () => {
    const registry = new RoomRegistry()
    registry.apply(activeUpdate())
    const relay = createRelay(config, registry, {
      fetch: vi.fn().mockRejectedValue(new Error('secret transport detail')),
      now: () => 10_000,
    })
    const response = await relay.app.request('/api/auth/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'do-not-echo', guildId: 'g', channelId: 'c' }),
    })
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain('do-not-echo')
  })
})
