import type { ViewerClaims } from '@proj-airi/discord-avatar-protocol'

import { Buffer } from 'node:buffer'
import { createHmac, timingSafeEqual } from 'node:crypto'

import { parseViewerClaims, SCHEMA_VERSION } from '@proj-airi/discord-avatar-protocol'

export type { ViewerClaims } from '@proj-airi/discord-avatar-protocol'

export const VIEWER_TOKEN_TTL_MS = 5 * 60_000

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

export function signViewerToken(claims: ViewerClaims, secret: string): string {
  const payload = base64url(JSON.stringify(claims))
  const signature = createHmac('sha256', secret).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

export function verifyViewerToken(token: string, secret: string, now = Date.now()): ViewerClaims | null {
  const [payload, signature, extra] = token.split('.')
  if (!payload || !signature || extra)
    return null
  const expected = createHmac('sha256', secret).update(payload).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(signature, 'base64url')
  }
  catch {
    return null
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null
  try {
    const claims = parseViewerClaims(JSON.parse(Buffer.from(payload, 'base64url').toString()))
    if (claims.schemaVersion !== SCHEMA_VERSION
      || claims.iat > now
      || claims.exp <= now
      || claims.exp - claims.iat !== VIEWER_TOKEN_TTL_MS) {
      return null
    }
    return claims
  }
  catch {
    return null
  }
}

export function secretMatches(candidate: string, expected: string): boolean {
  const a = createHmac('sha256', 'publisher-credential').update(candidate).digest()
  const b = createHmac('sha256', 'publisher-credential').update(expected).digest()
  return timingSafeEqual(a, b)
}
