import type { MemoryFeatureFlags } from './feature-flags'

import { describe, expect, it } from 'vitest'

import {
  MEMORY_FLAGS_ALL_OFF,
  memoryPosture,
  rolloutStateOf,
  validateMemoryFlags,
  validateRollback,
} from './feature-flags'

function flags(overrides: Partial<MemoryFeatureFlags> = {}): MemoryFeatureFlags {
  return { ...MEMORY_FLAGS_ALL_OFF, ...overrides }
}

/** Stage 1-3 shadow configuration: durable writes, legacy reads. */
const shadow = flags({
  durableEvents: true,
  actorSnapshots: true,
  roomBindings: true,
})

/** Stage 6 configuration: durable store is the source of truth. */
const active = flags({
  durableEvents: true,
  actorSnapshots: true,
  roomBindings: true,
  deliveryLifecycle: true,
  sharedRecentContext: true,
})

describe('rollout state classification', () => {
  it('treats the all-off default as the ephemeral state', () => {
    expect(rolloutStateOf(MEMORY_FLAGS_ALL_OFF)).toBe('ephemeral')
  })

  it('classifies durable writes without shared context as shadow', () => {
    expect(rolloutStateOf(shadow)).toBe('durableShadow')
  })

  it('classifies durable writes with shared context as active', () => {
    expect(rolloutStateOf(active)).toBe('durableActive')
  })

  it('lets degraded mode override every other read tier', () => {
    expect(rolloutStateOf({ ...active, degradedStatelessMode: true })).toBe('degradedStateless')
  })
})

describe('flag combination validation', () => {
  it('accepts the all-off default', () => {
    expect(validateMemoryFlags(MEMORY_FLAGS_ALL_OFF)).toEqual([])
  })

  it('accepts the shadow and active stage configurations', () => {
    expect(validateMemoryFlags(shadow)).toEqual([])
    expect(validateMemoryFlags(active)).toEqual([])
  })

  it('rejects a tier enabled without its prerequisite', () => {
    const violations = validateMemoryFlags(flags({ sharedRecentContext: true }))
    expect(violations.map(v => v.code)).toContain('missingPrerequisite')
    expect(violations.map(v => v.flag)).toContain('sharedRecentContext')
  })

  it('reports every missing prerequisite, not just the first', () => {
    const violations = validateMemoryFlags(flags({ sharedRecentContext: true }))
    // sharedRecentContext needs both durableEvents and roomBindings.
    expect(violations.filter(v => v.code === 'missingPrerequisite')).toHaveLength(2)
  })

  it('rejects vector retrieval because its benchmark gate is unmet (ADR-011)', () => {
    const violations = validateMemoryFlags(flags({ durableEvents: true, fulltextRetrieval: true, vectorRetrieval: true }))
    expect(violations).toEqual([
      expect.objectContaining({ code: 'gateNotMet', flag: 'vectorRetrieval' }),
    ])
  })

  it('rejects graph relationship hypotheses because its benchmark gate is unmet (EV-012)', () => {
    const violations = validateMemoryFlags(flags({
      durableEvents: true,
      fulltextRetrieval: true,
      vectorRetrieval: true,
      relationshipHypotheses: true,
    }))
    expect(violations.map(v => v.flag)).toEqual(['vectorRetrieval', 'relationshipHypotheses'])
  })

  // The lexical benchmark that exists (IMP-607) must not read as the unlock for
  // either gate. Enabling fulltextRetrieval — the flag that benchmark actually
  // covers — leaves both refusals in place, and each states its own missing
  // evidence rather than pointing at the completed lexical task.
  it('keeps vector and graph gated on distinct evidence that lexical retrieval does not supply', () => {
    const enabled = flags({ durableEvents: true, fulltextRetrieval: true, vectorRetrieval: true, relationshipHypotheses: true })
    const details = validateMemoryFlags(enabled).map(v => v.detail)

    expect(details).toHaveLength(2)
    expect(details[0]).toMatch(/vector retrieval benchmark/)
    expect(details[0]).toMatch(/IMP-607 lexical benchmark does not evaluate it/)
    expect(details[1]).toMatch(/EV-012/)
    expect(details[1]).not.toMatch(/IMP-607/)
  })

  it('rejects the remote transport because milestone 1 is in-process only (ADR-001)', () => {
    const violations = validateMemoryFlags(flags({ remoteTransport: true }))
    expect(violations).toEqual([
      expect.objectContaining({ code: 'gateNotMet', flag: 'remoteTransport' }),
    ])
  })

  it('rejects degraded mode that has nowhere to defer its writes', () => {
    const violations = validateMemoryFlags({ ...shadow, degradedStatelessMode: true })
    expect(violations).toEqual([
      expect.objectContaining({ code: 'unspooledDegradedMode', flag: 'durableWriteSpool' }),
    ])
  })

  it('accepts degraded mode once a write spool exists', () => {
    expect(validateMemoryFlags({ ...shadow, degradedStatelessMode: true, durableWriteSpool: true })).toEqual([])
  })
})

describe('rollback state machine', () => {
  // TEST-OPS-001 (19-rollout-feature-flags-rollback.md §13): disabling
  // FF-SHARED-RECENT-CONTEXT while FF-DURABLE-EVENTS is active must force
  // degraded stateless mode rather than ephemeral fallback.
  it('refuses to drop from active back to shadow while durable writes continue', () => {
    const violations = validateRollback(active, { ...active, sharedRecentContext: false })
    expect(violations.map(v => v.code)).toContain('splitBrain')
  })

  it('accepts the degraded-mode rollback out of the active state', () => {
    const next = { ...active, degradedStatelessMode: true, durableWriteSpool: true }
    expect(validateRollback(active, next)).toEqual([])
  })

  it('accepts the full revert out of the active state', () => {
    const violations = validateRollback(active, MEMORY_FLAGS_ALL_OFF)
    expect(violations).toEqual([])
  })

  it('accepts recovery from degraded mode back to active', () => {
    const degraded = { ...active, degradedStatelessMode: true, durableWriteSpool: true }
    expect(validateRollback(degraded, active)).toEqual([])
  })

  it('accepts the stage-1 ramp from ephemeral into shadow', () => {
    expect(validateRollback(MEMORY_FLAGS_ALL_OFF, shadow)).toEqual([])
  })

  it('accepts the stage-1 rollback from shadow back to ephemeral', () => {
    expect(validateRollback(shadow, MEMORY_FLAGS_ALL_OFF)).toEqual([])
  })

  it('refuses to promote shared context to source of truth without delivery lifecycle', () => {
    const next = { ...shadow, sharedRecentContext: true }
    const violations = validateRollback(shadow, next)
    expect(violations).toEqual([
      expect.objectContaining({ code: 'missingPrerequisite', flag: 'deliveryLifecycle' }),
    ])
  })
})

describe('memory posture', () => {
  it('reports no durable writes and no prompt use by default', () => {
    const posture = memoryPosture(MEMORY_FLAGS_ALL_OFF)
    expect(posture.state).toBe('ephemeral')
    expect(posture.durableWritesEnabled).toBe(false)
    expect(posture.promptUseEnabled).toBe(false)
    expect(posture.violations).toEqual([])
  })

  it('withholds prompt use during shadow writes', () => {
    const posture = memoryPosture(shadow)
    expect(posture.durableWritesEnabled).toBe(true)
    expect(posture.promptUseEnabled).toBe(false)
  })

  it('enables prompt use only in the active state', () => {
    expect(memoryPosture(active).promptUseEnabled).toBe(true)
  })

  it('fails closed: an invalid configuration never enables writes or prompt use', () => {
    const posture = memoryPosture({ ...active, remoteTransport: true })
    expect(posture.violations).not.toEqual([])
    expect(posture.durableWritesEnabled).toBe(false)
    expect(posture.promptUseEnabled).toBe(false)
  })

  it('halts prompt use in degraded mode and requires spooling', () => {
    const posture = memoryPosture({ ...active, degradedStatelessMode: true, durableWriteSpool: true })
    expect(posture.state).toBe('degradedStateless')
    expect(posture.promptUseEnabled).toBe(false)
    expect(posture.spoolRequired).toBe(true)
  })
})
