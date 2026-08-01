import { SCHEMA_VERSION } from '@proj-airi/discord-avatar-protocol'
import { describe, expect, it } from 'vitest'

import { secretMatches, signViewerToken, verifyViewerToken, VIEWER_TOKEN_TTL_MS } from './auth'

const now = 1_000_000
const claims = {
  schemaVersion: SCHEMA_VERSION,
  userId: 'u',
  guildId: 'g',
  channelId: 'c',
  iat: now,
  exp: now + VIEWER_TOKEN_TTL_MS,
}

describe('relay authentication', () => {
  it('accepts strict five-minute claims and rejects expiry or tampering', () => {
    const token = signViewerToken(claims, 'secret')
    expect(verifyViewerToken(token, 'secret', now)).toEqual(claims)
    expect(verifyViewerToken(token, 'secret', claims.exp)).toBeNull()
    expect(verifyViewerToken(`${token}x`, 'secret', now)).toBeNull()
    expect(verifyViewerToken(signViewerToken({ ...claims, exp: claims.exp + 1 }, 'secret'), 'secret', now)).toBeNull()
  })

  it('compares publisher credentials through fixed-length digests', () => {
    expect(secretMatches('same', 'same')).toBe(true)
    expect(secretMatches('short', 'a-different-length-secret')).toBe(false)
  })
})
