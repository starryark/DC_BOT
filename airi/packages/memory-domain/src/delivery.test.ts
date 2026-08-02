import type { DeliveryAttempt, DeliveryEvidence } from './delivery'

import { describe, expect, it } from 'vitest'

import {
  assertDeliveryTransition,
  canTransitionDelivery,
  eligibleSegmentText,
  isAssistantSegmentEligible,
  provesAudibility,
  STRICT_CONTEXT_ELIGIBILITY,
  UNRESOLVED_DELIVERY_STATES,
} from './delivery'
import { FIXTURE_VOICE_DELIVERIES, FIXTURE_VOICE_SEGMENTS } from './fixtures'
import { asDeliveryId, asTimestamp } from './ids'

const AT = asTimestamp('2026-08-02T10:00:05.000Z')
const MESSAGE_EVIDENCE: DeliveryEvidence = { kind: 'platformMessageId', platformMessageId: '950000000000000001' }
const PLAYBACK_EVIDENCE: DeliveryEvidence = { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 1400 } }

function attempt(overrides: Partial<DeliveryAttempt> = {}): DeliveryAttempt {
  return { ...FIXTURE_VOICE_DELIVERIES[0], ...overrides }
}

describe('delivery transitions', () => {
  it('permits the happy text path', () => {
    expect(canTransitionDelivery('pending', 'delivering')).toBe(true)
    expect(canTransitionDelivery('delivering', 'delivered')).toBe(true)
  })

  it('never jumps straight from pending to delivered', () => {
    expect(canTransitionDelivery('pending', 'delivered')).toBe(false)
  })

  it('treats reconciled and abandoned as terminal', () => {
    expect(canTransitionDelivery('reconciled', 'delivering')).toBe(false)
    expect(canTransitionDelivery('abandoned', 'delivered')).toBe(false)
  })

  it('routes every unknown-after-crash attempt to a definite outcome', () => {
    for (const target of ['delivered', 'failed', 'partiallyDelivered', 'abandoned'] as const)
      expect(canTransitionDelivery('unknownAfterCrash', target)).toBe(true)
  })

  it('flags the states the reconciliation worker owns', () => {
    expect([...UNRESOLVED_DELIVERY_STATES].sort()).toEqual(
      ['interrupted', 'partiallyDelivered', 'unheard', 'unknownAfterCrash'].sort(),
    )
  })
})

// REQ-DELIVERY-005 / SCN-008 / TEST-DELIVERY-TEXT-003.
describe('delivery evidence', () => {
  it('refuses to mark a text segment delivered without a Discord message id', () => {
    expect(() => assertDeliveryTransition(
      { deliveryId: asDeliveryId('d1'), from: 'delivering', to: 'delivered', evidence: { kind: 'none' }, at: AT },
      'discord_text',
    )).toThrowError(/message id/)
  })

  it('accepts a text delivery backed by a message id', () => {
    expect(() => assertDeliveryTransition(
      { deliveryId: asDeliveryId('d1'), from: 'delivering', to: 'delivered', evidence: MESSAGE_EVIDENCE, at: AT },
      'discord_text',
    )).not.toThrow()
  })

  // REQ-DELIVERY-007: local playback is not proof the user heard anything.
  it('refuses to mark a voice segment delivered at all', () => {
    expect(() => assertDeliveryTransition(
      { deliveryId: asDeliveryId('d1'), from: 'delivering', to: 'delivered', evidence: PLAYBACK_EVIDENCE, at: AT },
      'discord_voice',
    )).toThrowError(/no delivery receipt/)
  })

  it('never claims audibility, whatever the evidence', () => {
    expect(provesAudibility(MESSAGE_EVIDENCE)).toBe(false)
    expect(provesAudibility(PLAYBACK_EVIDENCE)).toBe(false)
  })

  it('rejects an illegal transition before it checks evidence', () => {
    expect(() => assertDeliveryTransition(
      { deliveryId: asDeliveryId('d1'), from: 'reconciled', to: 'delivered', evidence: MESSAGE_EVIDENCE, at: AT },
      'discord_text',
    )).toThrowError(/not permitted/)
  })
})

// AC-023 / TEST-PARTIAL-001 / FIND-012 / FIND-013.
describe('context eligibility (ADR-007)', () => {
  it('admits a delivered text segment', () => {
    expect(isAssistantSegmentEligible(attempt({ transport: 'discord_text', state: 'delivered', evidence: MESSAGE_EVIDENCE }))).toBe(true)
  })

  it.each(['pending', 'delivering', 'failed', 'interrupted', 'unknownAfterCrash', 'abandoned'] as const)(
    'excludes a %s segment',
    (state) => {
      expect(isAssistantSegmentEligible(attempt({ state }))).toBe(false)
    },
  )

  it('excludes completed voice playback under the strict default', () => {
    expect(isAssistantSegmentEligible(attempt({ state: 'unheard', evidence: PLAYBACK_EVIDENCE }))).toBe(false)
  })

  it('admits completed voice playback only when policy explicitly opts in', () => {
    const policy = { ...STRICT_CONTEXT_ELIGIBILITY, treatCompletedPlaybackAsEligible: true }
    expect(isAssistantSegmentEligible(attempt({ state: 'unheard', evidence: PLAYBACK_EVIDENCE }), policy)).toBe(true)
    // Interruption is still excluded even under the permissive policy.
    expect(isAssistantSegmentEligible(attempt({ state: 'interrupted', evidence: PLAYBACK_EVIDENCE }), policy)).toBe(false)
  })

  it('excludes a reconciled attempt whose evidence is an error', () => {
    expect(isAssistantSegmentEligible(attempt({ state: 'reconciled', evidence: { kind: 'transportError', errorClass: 'http500' } }))).toBe(false)
  })

  it('admits a reconciled attempt backed by a platform receipt', () => {
    expect(isAssistantSegmentEligible(attempt({ state: 'reconciled', evidence: MESSAGE_EVIDENCE }))).toBe(true)
  })
})

// SCN-034 / TEST-DELIVERY-VOICE-001: the three-clause fixture with a failed clause 2.
describe('partial voice delivery', () => {
  const permissive = { ...STRICT_CONTEXT_ELIGIBILITY, treatCompletedPlaybackAsEligible: true }

  it('never lets the failed clause into context', () => {
    const [, second] = FIXTURE_VOICE_SEGMENTS
    const [, secondAttempt] = FIXTURE_VOICE_DELIVERIES
    expect(eligibleSegmentText(second, secondAttempt, permissive)).toBeUndefined()
  })

  it('never lets the never-attempted clause into context', () => {
    const [, , third] = FIXTURE_VOICE_SEGMENTS
    const [, , thirdAttempt] = FIXTURE_VOICE_DELIVERIES
    expect(eligibleSegmentText(third, thirdAttempt, permissive)).toBeUndefined()
  })

  it('admits only the clause that actually played', () => {
    const eligible = FIXTURE_VOICE_SEGMENTS
      .map((segment, index) => eligibleSegmentText(segment, FIXTURE_VOICE_DELIVERIES[index], permissive))
      .filter((text): text is string => text != null)
    expect(eligible).toEqual(['It was due today.'])
  })

  it('admits nothing at all under the strict default', () => {
    const eligible = FIXTURE_VOICE_SEGMENTS
      .map((segment, index) => eligibleSegmentText(segment, FIXTURE_VOICE_DELIVERIES[index]))
      .filter((text): text is string => text != null)
    expect(eligible).toEqual([])
  })

  // SCN-035: barge-in truncates the delivered prefix; the rest was never heard.
  it('contributes only the delivered prefix of a partially delivered segment', () => {
    const partial = attempt({
      state: 'partiallyDelivered',
      evidence: { kind: 'localPlaybackCompleted', deliveredRange: { characters: 10 } },
    })
    const policy = { ...STRICT_CONTEXT_ELIGIBILITY, allowPartialAssistantOutput: true }
    expect(eligibleSegmentText(FIXTURE_VOICE_SEGMENTS[0], partial, policy)).toBe('It was due')
  })

  it('contributes nothing when the delivered prefix is unknown', () => {
    const partial = attempt({
      state: 'partiallyDelivered',
      evidence: { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 400 } },
    })
    const policy = { ...STRICT_CONTEXT_ELIGIBILITY, allowPartialAssistantOutput: true }
    expect(eligibleSegmentText(FIXTURE_VOICE_SEGMENTS[0], partial, policy)).toBeUndefined()
  })
})
