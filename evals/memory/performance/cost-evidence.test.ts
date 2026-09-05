import type { LiveArtifact } from './live-artifact'

import { describe, expect, it } from 'vitest'

import { AmbiguousBrainUsageError, deriveCostEvidence, parseCostEvidence, recomputeCostEvidence } from './cost-evidence'
import { liveArtifactDigest, parseLiveArtifact } from './live-artifact'
import { parsePriceDocument, priceDocumentDigest } from './price-contract'

/**
 * Cost derivation tests for the IMP-803 benchmark.
 *
 * These pin the property the whole cost seam exists for: `available` is a
 * consequence of one cost-eligible usage sample priced by an approved
 * document, and every other input state resolves to a content-free unavailable
 * reason instead of an assertion.
 */

function usage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    correlationId: 'usage-probe-brain-usage-001',
    inputTokens: 1000,
    outputTokens: 200,
    thinkingTokens: null,
    totalTokens: 1200,
    disposition: 'complete',
    retryCount: 0,
    observedAt: '2026-08-16T00:30:00Z',
    ...overrides,
  }
}

function brainArtifact(usageOverrides: Record<string, unknown> = {}, sampleId = 'brain-usage-001'): LiveArtifact {
  const record = usage(usageOverrides)
  return parseLiveArtifact({
    format: 1,
    kind: 'brain-usage-sample',
    sampleId,
    fileDigest: 'b'.repeat(64),
    fileSizeBytes: 512,
    hostProvenance: 'operator-host-a',
    configProvenance: 'brain-capture-v1',
    observedAt: record.observedAt,
    usage: record,
  })
}

function ttsArtifact(): LiveArtifact {
  return parseLiveArtifact({
    format: 1,
    kind: 'tts-sample',
    sampleId: 'tts-sample-001',
    fileDigest: 'c'.repeat(64),
    fileSizeBytes: 2048,
    hostProvenance: 'operator-host-a',
    configProvenance: 'tts-config-v1',
    observedAt: '2026-08-16T00:30:00Z',
  })
}

function price(overrides: Record<string, unknown> = {}) {
  const document = parsePriceDocument({
    format: 1,
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    billingUnit: 'token',
    currency: 'USD',
    dimensions: [
      { dimension: 'input', unit: 'token', pricePerUnit: 0.000001 },
      { dimension: 'output', unit: 'token', pricePerUnit: 0.000002 },
    ],
    effectiveStart: '2026-01-01T00:00:00Z',
    source: 'test-approval',
    approver: 'test-approver',
    approvedAt: '2026-08-01T00:00:00Z',
    provenance: 'test price document',
    ...overrides,
  })
  return { document, digest: priceDocumentDigest(document) }
}

describe('cost derivation', () => {
  it('prices one cost-eligible brain sample through the pricing authority', () => {
    const artifact = brainArtifact()
    const result = deriveCostEvidence({ liveArtifacts: [artifact], price: price() })
    expect(result.status).toBe('available')
    if (result.status !== 'available')
      return
    expect(result.evidence.currency).toBe('USD')
    expect(result.evidence.amount).toBeCloseTo(1000 * 0.000001 + 200 * 0.000002, 12)
    expect(result.evidence.dimensions.map(entry => entry.dimension)).toEqual(['input', 'output'])
    // The evidence names its source by canonical digest so a verifier can bind
    // it to the run's imported set.
    expect(result.evidence.liveArtifactDigest).toBe(liveArtifactDigest(artifact))
    expect(result.evidence.priceDocumentDigest).toBe(price().digest)
  })

  it('publishes no calculated cost without a price document', () => {
    expect(deriveCostEvidence({ liveArtifacts: [brainArtifact()] })).toEqual({ status: 'unavailable', reason: 'no-price-document-supplied' })
  })

  it('publishes no calculated cost without a brain sample', () => {
    expect(deriveCostEvidence({ liveArtifacts: [], price: price() })).toEqual({ status: 'unavailable', reason: 'no-brain-usage-sample' })
  })

  it('treats ASR and TTS samples as unrelated to cost', () => {
    expect(deriveCostEvidence({ liveArtifacts: [ttsArtifact()], price: price() })).toEqual({ status: 'unavailable', reason: 'no-brain-usage-sample' })
  })

  it('refuses a usage observation that did not complete', () => {
    for (const disposition of ['failed', 'aborted', 'unavailable']) {
      expect(deriveCostEvidence({ liveArtifacts: [brainArtifact({ disposition })], price: price() }))
        .toEqual({ status: 'unavailable', reason: 'brain-usage-not-complete' })
    }
  })

  it('fails closed when two cost-eligible brain samples are supplied', () => {
    // ROOT CAUSE:
    //
    // Selecting the first eligible sample would make the published amount
    // depend on the order of repeated `--import-live` flags, and no repository
    // rule says which sample a run's cost describes.
    const artifacts = [brainArtifact({}, 'brain-usage-001'), brainArtifact({ inputTokens: 5 }, 'brain-usage-002')]
    expect(() => deriveCostEvidence({ liveArtifacts: artifacts, price: price() })).toThrow(AmbiguousBrainUsageError)
  })

  it('uses the one cost-eligible sample when the others did not complete', () => {
    const artifacts = [brainArtifact({ disposition: 'failed' }, 'brain-usage-001'), brainArtifact({}, 'brain-usage-002')]
    const result = deriveCostEvidence({ liveArtifacts: artifacts, price: price() })
    expect(result.status).toBe('available')
  })

  it('reports the pricing authority reason when the price cannot apply', () => {
    expect(deriveCostEvidence({ liveArtifacts: [brainArtifact()], price: price({ model: 'other-model' }) }))
      .toEqual({ status: 'unavailable', reason: 'model-mismatch' })
    expect(deriveCostEvidence({ liveArtifacts: [brainArtifact()], price: price({ effectiveEnd: '2026-08-15T00:00:00Z' }) }))
      .toEqual({ status: 'unavailable', reason: 'price-expired' })
    expect(deriveCostEvidence({ liveArtifacts: [brainArtifact()], price: price({ effectiveStart: '2027-01-01T00:00:00Z' }) }))
      .toEqual({ status: 'unavailable', reason: 'price-effective-window-not-reached' })
    expect(deriveCostEvidence({ liveArtifacts: [brainArtifact({ thinkingTokens: 40 })], price: price() }))
      .toEqual({ status: 'unavailable', reason: 'missing-price-dimension' })
  })

  it('evaluates the price window at the usage observation time', () => {
    // The artifact's own `observedAt` is forced equal to the usage record's, so
    // the window question has exactly one instant to be asked about.
    const artifact = brainArtifact({ observedAt: '2026-02-01T00:00:00Z' })
    expect(deriveCostEvidence({ liveArtifacts: [artifact], price: price({ effectiveStart: '2026-03-01T00:00:00Z' }) }))
      .toEqual({ status: 'unavailable', reason: 'price-effective-window-not-reached' })
  })
})

describe('cost evidence parsing and recomputation', () => {
  function evidenceOf() {
    const result = deriveCostEvidence({ liveArtifacts: [brainArtifact()], price: price() })
    if (result.status !== 'available')
      throw new Error('fixture must derive available cost')
    return result.evidence
  }

  it('rejects an unknown field', () => {
    expect(() => parseCostEvidence({ ...evidenceOf(), note: 'extra' })).toThrow()
  })

  it('rejects evidence whose embedded artifact is not a brain sample', () => {
    expect(() => parseCostEvidence({ ...evidenceOf(), liveArtifact: ttsArtifact() })).toThrow()
  })

  it('rejects evidence whose embedded artifact carries prohibited content', () => {
    const evidence = evidenceOf()
    const tampered = { ...evidence, liveArtifact: { ...evidence.liveArtifact, hostProvenance: '/private/operator' } }
    expect(() => parseCostEvidence(tampered)).toThrow(/prohibited content/)
  })

  it('recomputes the same amount from the same price document', () => {
    const evidence = evidenceOf()
    const recomputed = recomputeCostEvidence(evidence, price().document)
    expect(recomputed.status).toBe('present')
    if (recomputed.status !== 'present')
      return
    expect(recomputed.amount).toBe(evidence.amount)
    expect(recomputed.dimensions).toEqual(evidence.dimensions)
  })

  it('recomputes absent when a different price document is supplied', () => {
    expect(recomputeCostEvidence(evidenceOf(), price({ model: 'other-model' }).document))
      .toEqual({ status: 'absent', reason: 'model-mismatch' })
  })
})
