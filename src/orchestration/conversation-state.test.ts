import type { GuildPhase } from './conversation-state'

import { describe, expect, it } from 'vitest'

import {
  admitUtterance,
  createGuildConversationSession,
  isAdmissionRejected,
  isInCooldown,
  resetForNewSession,
  shouldAnnounceCooldown,
  transitionGuildPhase,
} from './conversation-state'

const NOW = 1_700_000_000_000

function sessionAt(phase: GuildPhase, policy: 'half_duplex' | 'latest_wins' | 'barge_in' = 'half_duplex') {
  const session = createGuildConversationSession('g1', policy)
  session.phase = phase
  return session
}

describe('transitionGuildPhase', () => {
  it('allows the normal turn cycle', () => {
    const session = sessionAt('idle')
    expect(transitionGuildPhase(session, 'collecting', 'test')).toBe(true)
    expect(transitionGuildPhase(session, 'thinking', 'test')).toBe(true)
    expect(transitionGuildPhase(session, 'speaking', 'test')).toBe(true)
    expect(transitionGuildPhase(session, 'idle', 'test')).toBe(true)
    expect(session.phase).toBe('idle')
  })

  it('allows every active phase to abort back to idle', () => {
    for (const phase of ['collecting', 'thinking', 'speaking'] as const) {
      const session = sessionAt(phase)
      expect(transitionGuildPhase(session, 'idle', 'cancelled')).toBe(true)
      expect(session.phase).toBe('idle')
    }
  })

  it('allows any active phase to enter disconnecting', () => {
    for (const phase of ['idle', 'collecting', 'thinking', 'speaking'] as const) {
      const session = sessionAt(phase)
      expect(transitionGuildPhase(session, 'disconnecting', 'leave')).toBe(true)
    }
  })

  it('rejects transitions that would skip or reverse the cycle', () => {
    const speaking = sessionAt('speaking')
    // A stale continuation trying to re-enter thinking would make the bot
    // believe it is free while audio is still playing.
    expect(transitionGuildPhase(speaking, 'thinking', 'stale')).toBe(false)
    expect(speaking.phase).toBe('speaking')

    const idle = sessionAt('idle')
    expect(transitionGuildPhase(idle, 'speaking', 'bogus')).toBe(false)
    expect(idle.phase).toBe('idle')

    const collecting = sessionAt('collecting')
    expect(transitionGuildPhase(collecting, 'speaking', 'bogus')).toBe(false)
  })

  it('keeps disconnecting terminal until a new session resets it', () => {
    const session = sessionAt('disconnecting')
    expect(transitionGuildPhase(session, 'collecting', 'late utterance')).toBe(false)
    expect(transitionGuildPhase(session, 'thinking', 'late result')).toBe(false)
    expect(session.phase).toBe('disconnecting')

    resetForNewSession(session)
    expect(session.phase).toBe('idle')
  })

  it('treats a same-phase transition as a no-op success', () => {
    const session = sessionAt('thinking')
    expect(transitionGuildPhase(session, 'thinking', 'repeat')).toBe(true)
  })
})

describe('admitUtterance — half duplex', () => {
  it('accepts speech while idle', () => {
    expect(admitUtterance(sessionAt('idle')).accept).toBe(true)
  })

  it('admits speech while collecting and rejects it while thinking or speaking', () => {
    expect(admitUtterance(sessionAt('collecting')).accept).toBe(true)
    const cases = [
      ['thinking', 'bot_thinking'],
      ['speaking', 'bot_speaking'],
    ] as const

    for (const [phase, reason] of cases) {
      const decision = admitUtterance(sessionAt(phase))
      expect(isAdmissionRejected(decision)).toBe(true)
      if (isAdmissionRejected(decision))
        expect(decision.reason).toBe(reason)
    }
  })

  it('rejects speech while disconnecting under every policy', () => {
    for (const policy of ['half_duplex', 'latest_wins', 'barge_in'] as const) {
      const decision = admitUtterance(sessionAt('disconnecting', policy))
      expect(isAdmissionRejected(decision)).toBe(true)
      if (isAdmissionRejected(decision))
        expect(decision.reason).toBe('disconnecting')
    }
  })
})

describe('admitUtterance — interrupting policies', () => {
  it('admits busy-state speech under latest_wins and barge_in', () => {
    for (const policy of ['latest_wins', 'barge_in'] as const) {
      expect(admitUtterance(sessionAt('thinking', policy)).accept).toBe(true)
      expect(admitUtterance(sessionAt('speaking', policy)).accept).toBe(true)
    }
  })

  it('admits additional speech into the current collection', () => {
    const decision = admitUtterance(sessionAt('collecting', 'latest_wins'))
    expect(decision.accept).toBe(true)
  })
})

describe('cooldown helpers', () => {
  it('reports a cooldown only while it is still in the future', () => {
    const session = sessionAt('idle')
    session.geminiCooldownUntil = NOW + 1000
    expect(isInCooldown(session, NOW)).toBe(true)
    expect(isInCooldown(session, NOW + 1001)).toBe(false)
  })

  it('announces the first time and then debounces', () => {
    const session = sessionAt('idle')
    expect(shouldAnnounceCooldown(session, NOW, 60_000)).toBe(true)

    session.lastCooldownPromptAt = NOW
    expect(shouldAnnounceCooldown(session, NOW + 59_999, 60_000)).toBe(false)
    expect(shouldAnnounceCooldown(session, NOW + 60_000, 60_000)).toBe(true)
  })
})

describe('resetForNewSession', () => {
  it('clears per-session state but keeps committed history', () => {
    const session = sessionAt('speaking')
    session.currentTurnId = 't1'
    session.generationAbort = new AbortController()
    session.recentTranscripts.set('u1', { normalizedText: 'hi', at: NOW })
    session.awaitingConfirmation = true
    session.history.commitExchange({ speaker: 'Tester', text: 'hello' }, 'hi there')

    resetForNewSession(session)

    expect(session.phase).toBe('idle')
    expect(session.currentTurnId).toBeUndefined()
    expect(session.generationAbort).toBeUndefined()
    expect(session.recentTranscripts.size).toBe(0)
    expect(session.awaitingConfirmation).toBe(false)
    expect(session.history.turnCount).toBe(2)
  })
})
