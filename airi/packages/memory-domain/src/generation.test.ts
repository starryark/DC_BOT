import { describe, expect, it } from 'vitest'

import { FIXTURE_SNAPSHOT_EVIDENCE } from './fixtures'
import {
  canTransitionGeneration,
  commitDecision,
  describeSnapshotDivergence,
  TERMINAL_GENERATION_STATES,
  transitionGeneration,
} from './generation'
import { asGenerationId } from './ids'

const GENERATION = asGenerationId('generation-group-1')

describe('generation lifecycle', () => {
  it('permits prepared -> running -> generated -> persisted', () => {
    expect(canTransitionGeneration('prepared', 'running')).toBe(true)
    expect(canTransitionGeneration('running', 'generated')).toBe(true)
    expect(canTransitionGeneration('generated', 'persisted')).toBe(true)
  })

  it('rejects skipping straight to persisted', () => {
    expect(() => transitionGeneration(GENERATION, 'prepared', 'persisted')).toThrowError(/not permitted/)
  })

  it('treats every terminal state as terminal', () => {
    for (const state of TERMINAL_GENERATION_STATES)
      expect(canTransitionGeneration(state, 'running')).toBe(false)
  })

  it('allows supersession from any pre-terminal state', () => {
    expect(canTransitionGeneration('prepared', 'superseded')).toBe(true)
    expect(canTransitionGeneration('running', 'superseded')).toBe(true)
    expect(canTransitionGeneration('generated', 'superseded')).toBe(true)
  })
})

// SCN-006 / TEST-CONCURRENCY-001 / TEST-DELIVERY-003.
describe('snapshot version is evidence, not a lock (ADR-015)', () => {
  it('reports divergence when the room advanced during generation', () => {
    const divergence = describeSnapshotDivergence(FIXTURE_SNAPSHOT_EVIDENCE, 11)
    expect(divergence.diverged).toBe(true)
    expect(divergence.note).toMatch(/commit remains valid/)
  })

  it('reports no divergence when nothing arrived', () => {
    expect(describeSnapshotDivergence(FIXTURE_SNAPSHOT_EVIDENCE, 10).diverged).toBe(false)
  })

  it('commits anyway when the room advanced — the whole point of ADR-015', () => {
    const divergence = describeSnapshotDivergence(FIXTURE_SNAPSHOT_EVIDENCE, 11)
    expect(commitDecision(divergence).commit).toBe(true)
  })

  it('records exactly which events the prompt was built from', () => {
    expect(FIXTURE_SNAPSHOT_EVIDENCE.observedEventIds).toEqual(['event-alex-one', 'event-alex-two', 'event-bob'])
  })

  it.each(['authorizationRevoked', 'bindingInvalidated', 'supersededByNewerGeneration'] as const)(
    'rejects the commit for %s',
    (rejection) => {
      const decision = commitDecision(describeSnapshotDivergence(FIXTURE_SNAPSHOT_EVIDENCE, 10), rejection)
      expect(decision).toEqual({ commit: false, reason: rejection })
    },
  )
})
