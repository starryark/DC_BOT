import type { AuthorizationContext, AuthorizationRequest } from './authorization'

import { describe, expect, it } from 'vitest'

import { assertAuthorized, authorize } from './authorization'
import { FIXTURE_BOB, FIXTURE_BOT_CONTEXT, FIXTURE_CHARACTER, FIXTURE_GUILD_ID, FIXTURE_VOICE_ROOM_ID } from './fixtures'
import { asPersonId } from './ids'

const GUILD_READ: AuthorizationRequest = {
  operation: 'context:read',
  targetScope: { kind: 'guild', id: FIXTURE_GUILD_ID },
}

function operatorContext(): AuthorizationContext {
  return {
    ...FIXTURE_BOT_CONTEXT,
    principal: {
      ...FIXTURE_BOT_CONTEXT.principal,
      operations: [...FIXTURE_BOT_CONTEXT.principal.operations, 'governance:write', 'binding:write'],
      operator: true,
    },
  }
}

describe('deny by default (REQ-RETRIEVAL-001)', () => {
  it('denies when no context was supplied at all', () => {
    const decision = authorize(undefined, GUILD_READ)
    expect(decision).toMatchObject({ allowed: false, code: 'noPrincipal' })
  })

  it('denies an operation the principal does not hold', () => {
    const decision = authorize(FIXTURE_BOT_CONTEXT, { ...GUILD_READ, operation: 'governance:write' })
    expect(decision).toMatchObject({ allowed: false, code: 'operationNotGranted' })
  })

  it('denies a scope kind the principal holds nothing for', () => {
    const decision = authorize(FIXTURE_BOT_CONTEXT, { operation: 'context:read', targetScope: { kind: 'dm', id: 'dm:1' } })
    expect(decision).toMatchObject({ allowed: false, code: 'scopeNotGranted' })
  })

  // TEST-SCOPE-001: guild A must never read guild B.
  it('denies a different instance of a granted scope kind', () => {
    const decision = authorize(FIXTURE_BOT_CONTEXT, { operation: 'context:read', targetScope: { kind: 'guild', id: '999' } })
    expect(decision).toMatchObject({ allowed: false, code: 'scopeInstanceMismatch' })
  })

  it('allows the exact granted instance', () => {
    expect(authorize(FIXTURE_BOT_CONTEXT, GUILD_READ)).toMatchObject({ allowed: true })
  })
})

describe('operator-only operations', () => {
  it('denies governance to the bot principal even when the grant is present', () => {
    const context: AuthorizationContext = {
      ...FIXTURE_BOT_CONTEXT,
      principal: { ...FIXTURE_BOT_CONTEXT.principal, operations: [...FIXTURE_BOT_CONTEXT.principal.operations, 'governance:write'] },
    }
    expect(authorize(context, { ...GUILD_READ, operation: 'governance:write' }))
      .toMatchObject({ allowed: false, code: 'operatorRequired' })
  })

  it('allows governance to an operator principal', () => {
    expect(authorize(operatorContext(), { ...GUILD_READ, operation: 'governance:write' })).toMatchObject({ allowed: true })
  })
})

describe('direct-message participation (TEST-SCOPE-001)', () => {
  const dmContext: AuthorizationContext = {
    ...FIXTURE_BOT_CONTEXT,
    principal: {
      ...FIXTURE_BOT_CONTEXT.principal,
      scopes: [...FIXTURE_BOT_CONTEXT.principal.scopes, { kind: 'dm', id: 'dm:900000000000000004' }],
    },
    dmParticipants: [FIXTURE_BOB.personId],
  }

  const dmRead: AuthorizationRequest = {
    operation: 'context:read',
    targetScope: { kind: 'dm', id: 'dm:900000000000000004' },
    subjectPersonId: FIXTURE_BOB.personId,
  }

  it('allows a participant', () => {
    expect(authorize(dmContext, dmRead)).toMatchObject({ allowed: true })
  })

  it('denies a non-participant subject', () => {
    expect(authorize(dmContext, { ...dmRead, subjectPersonId: asPersonId('person-stranger') }))
      .toMatchObject({ allowed: false, code: 'dmParticipantRequired' })
  })

  it('denies when the participant set is unknown, rather than assuming membership', () => {
    expect(authorize({ ...dmContext, dmParticipants: undefined }, dmRead))
      .toMatchObject({ allowed: false, code: 'dmParticipantRequired' })
  })
})

describe('unbound channel isolation (AC-013)', () => {
  const context: AuthorizationContext = {
    ...FIXTURE_BOT_CONTEXT,
    principal: {
      ...FIXTURE_BOT_CONTEXT.principal,
      scopes: [...FIXTURE_BOT_CONTEXT.principal.scopes, { kind: 'unbound_channel' }],
    },
    logicalRoomId: FIXTURE_VOICE_ROOM_ID,
  }

  it('allows reading the room the call is made from', () => {
    expect(authorize(context, { operation: 'context:read', targetScope: { kind: 'unbound_channel', id: FIXTURE_VOICE_ROOM_ID } }))
      .toMatchObject({ allowed: true })
  })

  it('denies reading a different unbound room', () => {
    expect(authorize(context, { operation: 'context:read', targetScope: { kind: 'unbound_channel', id: 'room:other' } }))
      .toMatchObject({ allowed: false, code: 'crossScopeRequest' })
  })
})

describe('assertAuthorized maps denials onto the operation error code', () => {
  it('raises UNAUTHORIZED_READ for a context read', () => {
    expect(() => assertAuthorized(undefined, GUILD_READ)).toThrowError(/deny by default/)
    try {
      assertAuthorized(undefined, GUILD_READ)
    }
    catch (error) {
      expect((error as { code: string }).code).toBe('UNAUTHORIZED_READ')
    }
  })

  it('raises UNAUTHORIZED_GOVERNANCE for a governance write', () => {
    try {
      assertAuthorized(FIXTURE_BOT_CONTEXT, { ...GUILD_READ, operation: 'governance:write' })
    }
    catch (error) {
      expect((error as { code: string }).code).toBe('UNAUTHORIZED_GOVERNANCE')
    }
  })

  it('does not throw when the request is allowed', () => {
    expect(() => assertAuthorized(FIXTURE_BOT_CONTEXT, GUILD_READ)).not.toThrow()
  })
})

describe('character scope', () => {
  it('is part of every context so two personas never share memory', () => {
    expect(FIXTURE_BOT_CONTEXT.characterId).toBe(FIXTURE_CHARACTER)
    expect(authorize(FIXTURE_BOT_CONTEXT, { operation: 'context:read', targetScope: { kind: 'character', id: 'another-character' } }))
      .toMatchObject({ allowed: false, code: 'scopeInstanceMismatch' })
  })
})
