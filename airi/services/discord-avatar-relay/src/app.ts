import type { Server } from 'node:http'

import type { ViewerClaims } from './auth'

import { serve } from '@hono/node-server'
import {
  MAX_FRAME_BYTES,
  parseOAuthExchangeRequest,
  parsePublisherInbound,
  parseViewerInbound,
  SCHEMA_VERSION,
} from '@proj-airi/discord-avatar-protocol'
import { Hono } from 'hono'
import { WebSocketServer } from 'ws'

import { secretMatches, signViewerToken, verifyViewerToken, VIEWER_TOKEN_TTL_MS } from './auth'
import { RoomRegistry } from './registry'

export interface RelayConfig {
  host: string
  port: number
  publicBaseUrl: string
  publishSecret: string
  discordClientId: string
  discordClientSecret: string
  sessionSigningSecret: string
}

const AUTH_TIMEOUT_MS = 5_000
const HEARTBEAT_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 35_000

function error(code: string, message: string) {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, type: 'error', code, message })
}

function rateAllowed(timestamps: number[], limit: number, now = Date.now()): boolean {
  while (timestamps[0] != null && timestamps[0] < now - 10_000)
    timestamps.shift()
  if (timestamps.length >= limit)
    return false
  timestamps.push(now)
  return true
}

export interface RelayDependencies {
  fetch: typeof globalThis.fetch
  now: () => number
}

export function createRelay(
  config: RelayConfig,
  registry = new RoomRegistry(),
  dependencies: RelayDependencies = { fetch: globalThis.fetch, now: Date.now },
) {
  const app = new Hono()
  app.get('/livez', c => c.json({ status: 'ok' }))
  app.get('/readyz', c => config.publishSecret
    && config.sessionSigningSecret
    && config.discordClientId
    && config.discordClientSecret
    ? c.json({ status: 'ready' })
    : c.json({ status: 'not-ready' }, 503))

  app.post('/api/auth/discord', async (c) => {
    let body
    try {
      body = parseOAuthExchangeRequest(await c.req.json())
    }
    catch {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (!registry.has(body.guildId, body.channelId))
      return c.json({ error: 'room_unavailable' }, 403)

    try {
      const tokenResponse = await dependencies.fetch('https://discord.com/api/v10/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.discordClientId,
          client_secret: config.discordClientSecret,
          grant_type: 'authorization_code',
          code: body.code,
        }),
      })
      if (!tokenResponse.ok)
        return c.json({ error: 'oauth_exchange_failed' }, 401)
      const discordToken = await tokenResponse.json() as { access_token?: unknown }
      if (typeof discordToken.access_token !== 'string' || !discordToken.access_token)
        return c.json({ error: 'oauth_exchange_failed' }, 401)
      const headers = { authorization: `Bearer ${discordToken.access_token}` }
      const [userResponse, memberResponse] = await Promise.all([
        dependencies.fetch('https://discord.com/api/v10/users/@me', { headers }),
        dependencies.fetch(`https://discord.com/api/v10/users/@me/guilds/${body.guildId}/member`, { headers }),
      ])
      if (!userResponse.ok || !memberResponse.ok)
        return c.json({ error: 'guild_membership_required' }, 403)
      const user = await userResponse.json() as { id?: unknown }
      if (typeof user.id !== 'string' || !user.id || user.id.length > 128)
        return c.json({ error: 'identity_verification_failed' }, 401)
      // A publisher can leave while Discord OAuth is in flight.
      if (!registry.has(body.guildId, body.channelId))
        return c.json({ error: 'room_unavailable' }, 403)
      const issuedAt = dependencies.now()
      const claims: ViewerClaims = {
        schemaVersion: SCHEMA_VERSION,
        userId: user.id,
        guildId: body.guildId,
        channelId: body.channelId,
        iat: issuedAt,
        exp: issuedAt + VIEWER_TOKEN_TTL_MS,
      }
      return c.json({
        accessToken: discordToken.access_token,
        relayToken: signViewerToken(claims, config.sessionSigningSecret),
        expiresIn: VIEWER_TOKEN_TTL_MS / 1000,
      })
    }
    catch {
      return c.json({ error: 'discord_unavailable' }, 502)
    }
  })

  function attach(server: Server) {
    const publisherServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
    const viewerServer = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES })
    server.on('upgrade', (request, socket, head) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      const target = path === '/ws/publisher' ? publisherServer : path === '/ws/viewer' ? viewerServer : null
      if (!target) {
        socket.destroy()
        return
      }
      target.handleUpgrade(request, socket, head, ws => target.emit('connection', ws, request))
    })

    let activePublisher: import('ws').WebSocket | undefined
    publisherServer.on('connection', (ws) => {
      let authenticated = false
      let lastPong = Date.now()
      const rates: number[] = []
      const authTimer = setTimeout(() => ws.close(4401, 'Authentication timeout'), AUTH_TIMEOUT_MS)
      ws.on('message', (data, binary) => {
        const frameSize = Array.isArray(data)
          ? data.reduce((size, part) => size + part.length, 0)
          : data instanceof ArrayBuffer ? data.byteLength : data.length
        if (binary || frameSize > MAX_FRAME_BYTES) {
          ws.close(4400, 'Invalid frame')
          return
        }
        try {
          const message = parsePublisherInbound(data.toString())
          if (!authenticated) {
            if (message.type !== 'publisher.hello' || !secretMatches(message.token, config.publishSecret)) {
              ws.close(4401, 'Unauthorized')
              return
            }
            authenticated = true
            clearTimeout(authTimer)
            if (activePublisher && activePublisher !== ws)
              activePublisher.close(4409, 'Publisher superseded')
            activePublisher = ws
            return
          }
          if (!rateAllowed(rates, 100)) {
            ws.close(4429, 'Rate limited')
            return
          }
          if (message.type === 'pong') {
            lastPong = Date.now()
          }
          else if (message.type === 'avatar.behavior.set') {
            const result = registry.apply(message)
            ws.send(JSON.stringify({
              schemaVersion: SCHEMA_VERSION,
              type: 'state.result',
              guildId: message.guildId,
              channelId: message.channelId,
              sessionId: message.sessionId,
              sequence: message.sequence,
              status: result.status,
            }))
          }
        }
        catch {
          ws.send(error('invalid_message', 'Invalid protocol message'))
        }
      })
      const heartbeat = setInterval(() => {
        if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS)
          ws.close(4408, 'Heartbeat timeout')
        else
          ws.send(JSON.stringify({ schemaVersion: 1, type: 'heartbeat', timestamp: Date.now() }))
      }, HEARTBEAT_MS)
      ws.on('close', () => {
        if (activePublisher === ws)
          activePublisher = undefined
        clearTimeout(authTimer)
        clearInterval(heartbeat)
      })
    })

    viewerServer.on('connection', (ws) => {
      let claims: ViewerClaims | null = null
      let lastPong = Date.now()
      const rates: number[] = []
      const authTimer = setTimeout(() => ws.close(4401, 'Authentication timeout'), AUTH_TIMEOUT_MS)
      ws.on('message', (data, binary) => {
        const frameSize = Array.isArray(data)
          ? data.reduce((size, part) => size + part.length, 0)
          : data instanceof ArrayBuffer ? data.byteLength : data.length
        if (binary || frameSize > MAX_FRAME_BYTES) {
          ws.close(4400, 'Invalid frame')
          return
        }
        try {
          const message = parseViewerInbound(data.toString())
          if (!claims) {
            if (message.type !== 'viewer.hello'
              || !(claims = verifyViewerToken(message.token, config.sessionSigningSecret))) {
              ws.close(4401, 'Unauthorized')
              return
            }
            clearTimeout(authTimer)
            return
          }
          if (!rateAllowed(rates, 30)) {
            ws.close(4429, 'Rate limited')
            return
          }
          if (message.type === 'pong') {
            lastPong = Date.now()
            return
          }
          if (message.type === 'viewer.hello') {
            ws.close(4400, 'Already authenticated')
            return
          }
          if (message.guildId !== claims.guildId || message.channelId !== claims.channelId) {
            ws.close(4403, 'Scope mismatch')
            return
          }
          if (message.type === 'state.subscribe') {
            const snapshot = registry.subscribe(message.guildId, message.channelId, ws)
            if (snapshot)
              ws.send(JSON.stringify(snapshot))
          }
          else {
            registry.unsubscribe(message.guildId, message.channelId, ws)
          }
        }
        catch {
          ws.send(error('invalid_message', 'Invalid protocol message'))
        }
      })
      const heartbeat = setInterval(() => {
        if (Date.now() - lastPong > HEARTBEAT_TIMEOUT_MS)
          ws.close(4408, 'Heartbeat timeout')
        else
          ws.send(JSON.stringify({ schemaVersion: 1, type: 'heartbeat', timestamp: Date.now() }))
      }, HEARTBEAT_MS)
      ws.on('close', () => {
        clearTimeout(authTimer)
        clearInterval(heartbeat)
        registry.removeViewer(ws)
      })
    })
  }
  return { app, attach, registry }
}

export function startRelay(config: RelayConfig) {
  const relay = createRelay(config)
  const server = serve({ fetch: relay.app.fetch, hostname: config.host, port: config.port })
  relay.attach(server as Server)
  return server
}
