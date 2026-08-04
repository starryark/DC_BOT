import { describe, expect, it } from 'vitest'

import { FIXTURE_SNAPSHOT_EVIDENCE } from './fixtures'
import {
  canTransitionGeneration,
  commitDecision,
  describeSnapshotDivergence,
  digestSnapshotContextManifest,
  serializeSnapshotContextManifest,
  TERMINAL_GENERATION_STATES,
  transitionGeneration,
} from './generation'
import { asDeliveryId, asEventId, asGenerationId, asSegmentId, asTimestamp } from './ids'

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

describe('canonical snapshot context manifest digest', () => {
  const empty = { formatVersion: 1, logicalRoomVersion: 0, bindingRevision: 0, maxItems: 0, maxCharacters: 0, candidateReadLimit: 0, truncated: false, items: [] } as const
  const mixed = {
    formatVersion: 1,
    logicalRoomVersion: 12,
    bindingRevision: 3,
    maxItems: 24,
    maxCharacters: 8_000,
    candidateReadLimit: 96,
    truncated: true,
    items: [
      { sourceType: 'inbound', eventId: asEventId('event-1') },
      { sourceType: 'assistant_output', segmentId: asSegmentId('segment-1'), deliveryId: asDeliveryId('delivery-1'), deliveryState: 'delivered', deliveryStateAt: asTimestamp('2026-08-02T10:00:05.000Z') },
    ],
  } as const

  // Frozen vectors: the digest is persisted evidence, so any change to field
  // order, key names, or item shape must break a test rather than silently
  // invalidate every previously stored generation.
  it('matches frozen digest vectors for an empty and a mixed manifest', () => {
    expect(serializeSnapshotContextManifest(empty)).toBe('{"formatVersion":1,"logicalRoomVersion":0,"bindingRevision":0,"maxItems":0,"maxCharacters":0,"candidateReadLimit":0,"truncated":false,"items":[]}')
    expect(digestSnapshotContextManifest(empty)).toBe('1a7205f60481fc7704804ab0aaede263d8234a8c1c69cecb4422a1b44ef6dd5b')
    expect(digestSnapshotContextManifest(mixed)).toBe('10832b3c52c958ef3e4fabd7a61aac04ec5b07391b89cb43642031ff6757f6ab')
  })

  // The domain package cannot import `node:crypto`, so it carries its own
  // SHA-256. This test is the only thing keeping that copy honest.
  it('agrees with the platform SHA-256 across message-length block boundaries', async () => {
    const { createHash } = await import('node:crypto')
    for (let items = 0; items < 80; items++) {
      const manifest = { ...empty, items: Array.from({ length: items }, (_unused, index) => ({ sourceType: 'inbound' as const, eventId: asEventId(`event-${index}`) })) }
      expect(digestSnapshotContextManifest(manifest)).toBe(createHash('sha256').update(serializeSnapshotContextManifest(manifest), 'utf8').digest('hex'))
    }
  })

  it('orders items exactly as selected rather than normalizing them', () => {
    const reversed = { ...mixed, items: [mixed.items[1], mixed.items[0]] } as const
    expect(digestSnapshotContextManifest(reversed)).not.toBe(digestSnapshotContextManifest(mixed))
  })

  it('rejects an unknown format version, an unknown source type, and an incomplete item', () => {
    expect(() => serializeSnapshotContextManifest({ ...empty, formatVersion: 2 } as never)).toThrow(/unknown snapshot context manifest format/)
    expect(() => serializeSnapshotContextManifest({ ...empty, items: [{ sourceType: 'summary', id: 'x' }] } as never)).toThrow(/unknown snapshot context source type/)
    expect(() => serializeSnapshotContextManifest({ ...empty, items: [{ sourceType: 'inbound' }] } as never)).toThrow(/requires eventId/)
    expect(() => serializeSnapshotContextManifest({ ...empty, items: [{ sourceType: 'assistant_output', segmentId: 'segment-1' }] } as never)).toThrow(/incomplete/)
  })

  it('rejects negative and non-integer header bounds', () => {
    expect(() => serializeSnapshotContextManifest({ ...empty, maxItems: -1 } as never)).toThrow(/maxItems/)
    expect(() => serializeSnapshotContextManifest({ ...empty, logicalRoomVersion: 1.5 } as never)).toThrow(/logicalRoomVersion/)
  })

  it('excludes content, so two manifests over different text share one digest', () => {
    expect(digestSnapshotContextManifest({ ...empty, items: [{ sourceType: 'inbound', eventId: asEventId('event-1') }] })).toBe(digestSnapshotContextManifest({ ...empty, items: [{ sourceType: 'inbound', eventId: asEventId('event-1') }] }))
  })
})
