import type { DeliveryAttempt, DeliveryEvidence } from './delivery'

import { describe, expect, it } from 'vitest'

import {
  assertDeliveryTransition,
  canTransitionDelivery,
  DELIVERY_TRANSITIONS,
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

// IMP-406 (G4): the M1 delivery/context posture a reconciliation worker must not
// disturb. The runtime admits completed local voice playback under
// treatCompletedPlaybackAsEligible (runtime.ts assembleRecent) as evidence the bot
// finished speaking — never as proof a human heard it. The hazard pinned here: every
// legal transition out of a healthy `unheard` segment removes it from context, so the
// worker must leave completed playback alone rather than "resolve" it ineligible.
describe('IMP-406 M1 delivery/context reconciliation posture', () => {
  // The runtime policy bundle (runtime.ts assembleRecent passes exactly these two).
  const runtimePolicy = { ...STRICT_CONTEXT_ELIGIBILITY, treatCompletedPlaybackAsEligible: true }

  it('admits completed local voice playback only as evidence playback completed, never as proof a human heard it', () => {
    const completedVoice = attempt({ state: 'unheard', transport: 'discord_voice', evidence: PLAYBACK_EVIDENCE })
    expect(isAssistantSegmentEligible(completedVoice, runtimePolicy)).toBe(true)
    // REQ-DELIVERY-007: no evidence kind is audibility evidence.
    expect(provesAudibility(PLAYBACK_EVIDENCE)).toBe(false)
    expect(provesAudibility(MESSAGE_EVIDENCE)).toBe(false)
  })

  // A worker that "resolves" a healthy completed-playback segment only makes things
  // worse: `reconciled` needs a platform receipt voice cannot produce, and
  // `abandoned` is the operator-review exclusion. Both carry the honest
  // localPlaybackCompleted evidence voice actually has, and both drop out of context.
  it.each([...DELIVERY_TRANSITIONS.unheard])('drops completed voice playback from context when it is moved to %s', (target) => {
    const resolved = attempt({ state: target, transport: 'discord_voice', evidence: PLAYBACK_EVIDENCE })
    expect(isAssistantSegmentEligible(resolved, runtimePolicy)).toBe(false)
  })

  it.each(['pending', 'delivering', 'unknownAfterCrash', 'partiallyDelivered', 'interrupted', 'failed', 'abandoned'] as const)(
    'excludes %s output from context under the runtime policy regardless of transport',
    (state) => {
      expect(isAssistantSegmentEligible(attempt({ state, transport: 'discord_voice', evidence: PLAYBACK_EVIDENCE }), runtimePolicy)).toBe(false)
      expect(isAssistantSegmentEligible(attempt({ state, transport: 'discord_text', evidence: MESSAGE_EVIDENCE }), runtimePolicy)).toBe(false)
    },
  )

  it('admits only receipt-backed text into context, never receipt-less or error-reconciled text', () => {
    expect(isAssistantSegmentEligible(attempt({ state: 'delivered', transport: 'discord_text', evidence: MESSAGE_EVIDENCE }), runtimePolicy)).toBe(true)
    expect(isAssistantSegmentEligible(attempt({ state: 'reconciled', transport: 'discord_text', evidence: MESSAGE_EVIDENCE }), runtimePolicy)).toBe(true)
    // A text attempt whose reconciliation produced only an error — no durable receipt
    // — cannot enter context: without a platform message id there is nothing to prove
    // the send landed, and IMP-406 forbids fabricating one or resending blindly.
    expect(isAssistantSegmentEligible(attempt({ state: 'reconciled', transport: 'discord_text', evidence: { kind: 'transportError', errorClass: 'crash' } }), runtimePolicy)).toBe(false)
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
