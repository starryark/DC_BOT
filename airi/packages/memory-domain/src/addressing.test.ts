import type { CallingScope } from './aliases'

import { describe, expect, it } from 'vitest'

import {
  assertNoOpaqueRefLeak,
  buildOpaquePersonTable,
  resolvePersonByName,
  resolvePreferredAddress,
} from './addressing'
import { assertAliasRenderable, isAliasVisibleFrom, normalizeAlias } from './aliases'
import {
  FIXTURE_ALEX_ONE,
  FIXTURE_ALEX_TWO,
  FIXTURE_ALIASES,
  FIXTURE_BOB,
  FIXTURE_DM_CHANNEL_ID,
  FIXTURE_GUILD_ID,
} from './fixtures'
import { asTimestamp } from './ids'

const NOW = asTimestamp('2026-08-02T12:00:00.000Z')

const GUILD_SCOPE: CallingScope = { kind: 'guild', scopeId: FIXTURE_GUILD_ID }
const OTHER_GUILD_SCOPE: CallingScope = { kind: 'guild', scopeId: '999999999999999999' }
const DM_SCOPE: CallingScope = { kind: 'private', scopeId: `dm:${FIXTURE_DM_CHANNEL_ID}` }
const OTHER_DM_SCOPE: CallingScope = { kind: 'private', scopeId: 'dm:111111111111111111' }

describe('alias normalization (TEST-UNICODE-001)', () => {
  it('folds full-width and case differences onto one value', () => {
    expect(normalizeAlias('Ａｌｅｘ')).toBe('alex')
    expect(normalizeAlias('ALEX')).toBe('alex')
  })

  it('strips zero-width and bidi controls so two aliases cannot look identical while comparing unequal', () => {
    expect(normalizeAlias('A​lex')).toBe('alex')
    expect(normalizeAlias('‮Alex﻿')).toBe('alex')
  })
})

// TEST-ALIAS-001 / SCN-015: a private DM alias must not surface in a guild.
describe('private alias containment (ADR-005)', () => {
  const privateAlias = FIXTURE_ALIASES.find(alias => alias.visibility === 'private')!

  it('is visible from the DM that created it', () => {
    expect(isAliasVisibleFrom(privateAlias, DM_SCOPE)).toBe(true)
  })

  it('is invisible from a guild', () => {
    expect(isAliasVisibleFrom(privateAlias, GUILD_SCOPE)).toBe(false)
  })

  it('is invisible from a different private conversation', () => {
    expect(isAliasVisibleFrom(privateAlias, OTHER_DM_SCOPE)).toBe(false)
  })

  it('throws rather than rendering when asked to emit it in a guild', () => {
    expect(() => assertAliasRenderable(privateAlias, GUILD_SCOPE)).toThrowError(/private/i)
  })

  it('abstains instead of falling back to a less-scoped name', () => {
    const resolution = resolvePreferredAddress({
      personId: FIXTURE_BOB.personId,
      aliases: FIXTURE_ALIASES,
      callingScope: GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution).toEqual({ outcome: 'abstain', personId: FIXTURE_BOB.personId, reason: 'noAuthorizedAlias' })
  })

  it('uses it inside the DM', () => {
    const resolution = resolvePreferredAddress({
      personId: FIXTURE_BOB.personId,
      aliases: FIXTURE_ALIASES,
      callingScope: DM_SCOPE,
      at: NOW,
    })
    expect(resolution).toEqual({
      outcome: 'resolved',
      personId: FIXTURE_BOB.personId,
      displayValue: 'Bobby Bear',
      scope: 'private',
    })
  })
})

describe('scope isolation across guilds (TEST-SCOPE-001)', () => {
  it('does not consider a guild alias from another guild', () => {
    const resolution = resolvePreferredAddress({
      personId: FIXTURE_ALEX_TWO.personId,
      aliases: FIXTURE_ALIASES,
      callingScope: OTHER_GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution.outcome).toBe('abstain')
  })

  it('still resolves a platform-scoped alias anywhere', () => {
    const resolution = resolvePreferredAddress({
      personId: FIXTURE_ALEX_ONE.personId,
      aliases: FIXTURE_ALIASES,
      callingScope: OTHER_GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution).toMatchObject({ outcome: 'resolved', displayValue: 'Alex', scope: 'platform' })
  })
})

describe('alias precedence', () => {
  it('prefers the more specific scope', () => {
    const aliases = [
      ...FIXTURE_ALIASES,
      {
        ...FIXTURE_ALIASES[0],
        aliasId: FIXTURE_ALIASES[0].aliasId,
        scope: 'guild' as const,
        scopeId: FIXTURE_GUILD_ID,
        displayValue: 'Alex the First',
        normalizedValue: 'alex the first',
      },
    ]
    const resolution = resolvePreferredAddress({
      personId: FIXTURE_ALEX_ONE.personId,
      aliases,
      callingScope: GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution).toMatchObject({ outcome: 'resolved', displayValue: 'Alex the First', scope: 'guild' })
  })

  it('ignores an alias whose validity window has closed', () => {
    const expired = FIXTURE_ALIASES.map(alias => ({ ...alias, validUntil: asTimestamp('2026-08-01T00:00:00.000Z') }))
    const resolution = resolvePreferredAddress({
      personId: FIXTURE_ALEX_ONE.personId,
      aliases: expired,
      callingScope: GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution.outcome).toBe('abstain')
  })
})

// TEST-ALIAS-002 / TEST-ID-001: duplicate aliases never merge identities.
describe('alias collision (ADR-003)', () => {
  it('reports ambiguity instead of picking one of two people called Alex', () => {
    const resolution = resolvePersonByName({
      normalizedValue: 'alex',
      aliases: FIXTURE_ALIASES,
      callingScope: GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution.outcome).toBe('ambiguous')
    if (resolution.outcome === 'ambiguous') {
      expect([...resolution.candidates].sort()).toEqual([FIXTURE_ALEX_ONE.personId, FIXTURE_ALEX_TWO.personId].sort())
    }
  })

  it('resolves cleanly when only one of them is visible from the calling scope', () => {
    const resolution = resolvePersonByName({
      normalizedValue: 'alex',
      aliases: FIXTURE_ALIASES,
      callingScope: OTHER_GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution).toMatchObject({ outcome: 'resolved', personId: FIXTURE_ALEX_ONE.personId })
  })

  it('reports unknown rather than ambiguous when nobody matches', () => {
    const resolution = resolvePersonByName({
      normalizedValue: 'nobody',
      aliases: FIXTURE_ALIASES,
      callingScope: GUILD_SCOPE,
      at: NOW,
    })
    expect(resolution).toEqual({ outcome: 'unknown', normalizedValue: 'nobody' })
  })
})

// TEST-SEC-004 / TEST-IDLEAK-001.
describe('opaque person references (ADR-010)', () => {
  it('gives distinct handles to distinct persons regardless of shared names', () => {
    const table = buildOpaquePersonTable([FIXTURE_ALEX_ONE.personId, FIXTURE_ALEX_TWO.personId, FIXTURE_BOB.personId])
    expect(table.refFor.get(FIXTURE_ALEX_ONE.personId)).toBe('p_1')
    expect(table.refFor.get(FIXTURE_ALEX_TWO.personId)).toBe('p_2')
    expect(table.refFor.get(FIXTURE_BOB.personId)).toBe('p_3')
    expect(new Set(table.refFor.values()).size).toBe(3)
  })

  it('is deterministic and collapses duplicates', () => {
    const ids = [FIXTURE_ALEX_ONE.personId, FIXTURE_ALEX_ONE.personId, FIXTURE_BOB.personId]
    expect(buildOpaquePersonTable(ids).refFor.size).toBe(2)
    expect(buildOpaquePersonTable(ids)).toEqual(buildOpaquePersonTable(ids))
  })

  it('maps handles back to persons for the serializer', () => {
    const table = buildOpaquePersonTable([FIXTURE_BOB.personId])
    expect(table.personFor.get('p_1')).toBe(FIXTURE_BOB.personId)
  })

  it('rejects output that leaked a handle', () => {
    expect(() => assertNoOpaqueRefLeak('Sure thing, p_2!')).toThrowError(/prompt-local person handle/)
  })

  it('allows output that merely resembles one', () => {
    expect(() => assertNoOpaqueRefLeak('The p_value variable is fine.')).not.toThrow()
    expect(() => assertNoOpaqueRefLeak('Sure thing, Alex!')).not.toThrow()
  })
})
