import type { ActorSnapshot, AnonymousActor } from './identity'

import { describe, expect, it } from 'vitest'

import { FIXTURE_ALEX_ONE, FIXTURE_ALEX_TWO } from './fixtures'
import {
  assertNotSyntheticAuthor,
  attributedActor,
  discordUserIdFrom,
  hasMaterialChange,
  identityKeyFor,
  isPersonScoped,
  isSnowflake,
  projectPresentation,
  snapshotFingerprint,
} from './identity'
import { asPersonId, asTimestamp } from './ids'

const AT = asTimestamp('2026-08-02T10:00:00.000Z')

function snapshotOf(overrides: Partial<ActorSnapshot> = {}): ActorSnapshot {
  return {
    platform: 'discord',
    platformUserId: '100000000000000001',
    username: 'alex',
    globalName: 'Alex',
    displayNameAtEvent: 'Alex',
    observedAt: AT,
    source: 'gateway',
    ...overrides,
  }
}

describe('durable identity key (ADR-003)', () => {
  it('accepts a Discord snowflake', () => {
    expect(isSnowflake('100000000000000001')).toBe(true)
    expect(identityKeyFor('100000000000000001')).toBe('discord:user:100000000000000001')
  })

  // TEST-IDENTITY-002 / SCN-012: a display name must never become an identity key.
  it('refuses to build an identity key from presentation text', () => {
    expect(() => identityKeyFor('Alex')).toThrowError(/snowflake/)
    expect(() => identityKeyFor('')).toThrowError(/snowflake/)
    expect(() => identityKeyFor('12345')).toThrowError(/snowflake/)
  })

  it('round-trips a key back to its user id and rejects a malformed one', () => {
    expect(discordUserIdFrom('discord:user:100000000000000001')).toBe('100000000000000001')
    expect(discordUserIdFrom('discord:user:Alex')).toBeUndefined()
    expect(discordUserIdFrom('telegram:user:100000000000000001')).toBeUndefined()
  })
})

// TEST-IDENTITY-001 / TEST-ID-001 / SCN-011.
describe('same-name isolation', () => {
  it('keeps two people who both display as "Alex" completely separate', () => {
    expect(FIXTURE_ALEX_ONE.snapshot.displayNameAtEvent).toBe('Alex')
    expect(FIXTURE_ALEX_TWO.snapshot.displayNameAtEvent).toBe('Alex')
    expect(FIXTURE_ALEX_ONE.identityKey).not.toBe(FIXTURE_ALEX_TWO.identityKey)
    expect(FIXTURE_ALEX_ONE.personId).not.toBe(FIXTURE_ALEX_TWO.personId)
  })
})

// FIND-006: `conversation-controller.ts:274` passes 'Discord group' as a display
// name today; the domain must refuse to let that reach an author position.
describe('synthetic author rejection (ADR-006)', () => {
  it.each(['Discord group', 'discord group', 'System', 'everyone'])('rejects %s as a person id', (label) => {
    expect(() => assertNotSyntheticAuthor(label)).toThrowError(/opaque person id/)
  })

  it('rejects any person id containing whitespace', () => {
    expect(() => assertNotSyntheticAuthor('some person')).toThrowError(/opaque person id/)
  })

  it('accepts an opaque surrogate', () => {
    expect(() => assertNotSyntheticAuthor('person-alex-one')).not.toThrow()
  })

  it('refuses to build an attributed actor for a synthetic author', () => {
    expect(() => attributedActor(asPersonId('everyone'), snapshotOf())).toThrowError(/opaque person id/)
  })

  it('requires the event-time display name that was actually shown', () => {
    expect(() => attributedActor(asPersonId('person-x'), snapshotOf({ displayNameAtEvent: '' })))
      .toThrowError(/displayNameAtEvent/)
  })
})

describe('anonymous actors (REQ-ID-003)', () => {
  const anonymous: AnonymousActor = {
    kind: 'anonymous',
    displayNameAtEvent: 'unknown member',
    observedAt: AT,
    reason: 'cacheMiss',
  }

  it('is not person-scoped', () => {
    expect(isPersonScoped(anonymous)).toBe(false)
    expect(isPersonScoped(FIXTURE_ALEX_ONE)).toBe(true)
  })
})

// TEST-ALIAS-003 / SCN-016: a rename storm must not cause unbounded projection writes.
describe('write-amplification control (RISK-G)', () => {
  it('produces a stable fingerprint for identical watched fields', () => {
    expect(snapshotFingerprint(snapshotOf())).toBe(snapshotFingerprint(snapshotOf()))
  })

  it('ignores fields that change on every event', () => {
    const later = snapshotOf({ observedAt: asTimestamp('2026-08-02T23:59:59.000Z'), source: 'voiceState' })
    expect(snapshotFingerprint(later)).toBe(snapshotFingerprint(snapshotOf()))
  })

  it('changes when a watched presentation field changes', () => {
    expect(snapshotFingerprint(snapshotOf({ guildNickname: 'Al' }))).not.toBe(snapshotFingerprint(snapshotOf()))
  })

  it('changes when a value moves between fields', () => {
    const asUsername = snapshotOf({ username: 'kris', globalName: undefined })
    const asGlobalName = snapshotOf({ username: undefined, globalName: 'kris' })
    expect(snapshotFingerprint(asUsername)).not.toBe(snapshotFingerprint(asGlobalName))
  })

  it('writes on first observation and skips an unchanged repeat', () => {
    const actor = attributedActor(asPersonId('person-alex-one'), snapshotOf())
    expect(hasMaterialChange(undefined, actor.snapshot)).toBe(true)

    const projection = projectPresentation(actor)
    expect(hasMaterialChange(projection, snapshotOf())).toBe(false)

    // 10,000 identical observations produce zero further writes.
    const repeats = Array.from({ length: 10_000 }, () => snapshotOf())
    expect(repeats.filter(snapshot => hasMaterialChange(projection, snapshot))).toHaveLength(0)
  })

  it('writes again once a nickname actually changes', () => {
    const projection = projectPresentation(attributedActor(asPersonId('person-alex-one'), snapshotOf()))
    expect(hasMaterialChange(projection, snapshotOf({ guildNickname: 'Al' }))).toBe(true)
  })
})

// TEST-DISCORD-003: a member update changes the projection but never the history.
describe('historical presentation vs current addressing (ADR-004)', () => {
  it('keeps the old snapshot intact when a new one is projected', () => {
    const before = snapshotOf({ guildNickname: 'Al' })
    const actor = attributedActor(asPersonId('person-alex-one'), before)
    const projection = projectPresentation(actor)

    const after = snapshotOf({ guildNickname: 'Alexandra', observedAt: asTimestamp('2026-08-03T10:00:00.000Z') })
    const updated = projectPresentation(attributedActor(asPersonId('person-alex-one'), after))

    expect(actor.snapshot.guildNickname).toBe('Al')
    expect(projection.guildNickname).toBe('Al')
    expect(updated.guildNickname).toBe('Alexandra')
    expect(updated.personId).toBe(projection.personId)
  })
})
