import { describe, expect, it } from 'vitest'

import {
  parseBehavior,
  parseOAuthExchangeRequest,
  parsePublisherInbound,
  parsePublisherOutbound,
  parseViewerClaims,
  parseViewerInbound,
  parseViewerOutbound,
  ProtocolError,
} from './index'

const state = {
  schemaVersion: 1,
  type: 'avatar.behavior.set',
  guildId: 'guild',
  channelId: 'channel',
  sessionId: 'session',
  sequence: 1,
  timestamp: 1,
  connected: true,
  behavior: 'idle',
  speaking: false,
  mouthOpen: 0,
}

describe('avatar protocol', () => {
  it.each(['idle', 'listening', 'thinking', 'speaking'])('accepts %s', (behavior) => {
    expect(parsePublisherInbound(JSON.stringify({ ...state, behavior }))).toMatchObject({ behavior })
  })

  it('rejects unknown fields and wrong directions', () => {
    expect(() => parsePublisherInbound(JSON.stringify({ ...state, extra: true }))).toThrow(ProtocolError)
    expect(() => parseViewerInbound(JSON.stringify(state))).toThrow(ProtocolError)
  })

  it('rejects malformed JSON without echoing secrets', () => {
    const secret = 'do-not-leak'
    try {
      parsePublisherInbound(`{"token":"${secret}"`)
    }
    catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })

  it('strictly parses every direction and state result acknowledgement', () => {
    expect(parsePublisherInbound(JSON.stringify({ schemaVersion: 1, type: 'pong', timestamp: 1 })).type).toBe('pong')
    expect(parseViewerInbound(JSON.stringify({ schemaVersion: 1, type: 'state.subscribe', guildId: 'g', channelId: 'c' })).type).toBe('state.subscribe')
    expect(parsePublisherOutbound(JSON.stringify({
      schemaVersion: 1,
      type: 'state.result',
      guildId: 'g',
      channelId: 'c',
      sessionId: 's',
      sequence: 2,
      status: 'duplicate',
    })).type).toBe('state.result')
    expect(parseViewerOutbound(JSON.stringify({ ...state, type: 'avatar.state.snapshot' })).type).toBe('avatar.state.snapshot')
  })

  it('rejects invalid versions, bounds, fields, and behavior values', () => {
    expect(() => parsePublisherInbound(JSON.stringify({ ...state, schemaVersion: 2 }))).toThrow(ProtocolError)
    expect(() => parsePublisherInbound(JSON.stringify({ ...state, sequence: -1 }))).toThrow(ProtocolError)
    expect(() => parsePublisherInbound(JSON.stringify({ ...state, guildId: 'x'.repeat(129) }))).toThrow(ProtocolError)
    expect(() => parseBehavior('excited')).toThrow()
  })

  it('strictly validates OAuth bodies and signed claim shapes', () => {
    expect(parseOAuthExchangeRequest({ code: 'code', guildId: 'g', channelId: 'c' })).toEqual({
      code: 'code',
      guildId: 'g',
      channelId: 'c',
    })
    expect(() => parseOAuthExchangeRequest({ code: 'code', guildId: 'g', channelId: 'c', extra: true })).toThrow()
    expect(parseViewerClaims({
      schemaVersion: 1,
      userId: 'u',
      guildId: 'g',
      channelId: 'c',
      iat: 100,
      exp: 200,
    }).userId).toBe('u')
  })
})
