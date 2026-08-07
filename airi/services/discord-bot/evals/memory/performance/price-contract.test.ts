import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { calculateCost, COST_ABSENT_REASONS, type PriceDocument, parsePriceDocument, priceDocumentDigest, priceDocumentSchema, priceEffectiveFailure } from './price-contract'

/**
 * Price document and cost calculation tests for the IMP-803 benchmark.
 *
 * These assert the strict price schema rejects mismatches, that cost is only
 * calculated when the model/provider matches and the window is effective, and
 * that a missing price dimension or unavailable usage yields an absent result
 * with a reason rather than a silent zero.
 */

function validPriceDocument(overrides: Record<string, unknown> = {}): PriceDocument {
  return parsePriceDocument({
    format: 1,
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    billingUnit: 'token',
    currency: 'USD',
    dimensions: [
      { dimension: 'input', unit: 'token', pricePerUnit: 0.00001 },
      { dimension: 'output', unit: 'token', pricePerUnit: 0.00003 },
    ],
    effectiveStart: '2026-01-01T00:00:00Z',
    effectiveEnd: null,
    source: 'provider-rate-card',
    approver: 'operations-lead',
    approvedAt: '2026-01-01T00:00:00Z',
    provenance: 'rate-card-v1',
    ...overrides,
  })
}

describe('price document schema', () => {
  it('accepts a well-formed approved document', () => {
    expect(() => v.parse(priceDocumentSchema, validPriceDocument())).not.toThrow()
  })

  it('rejects a negative price per unit', () => {
    expect(() => parsePriceDocument({ ...validPriceDocument(), dimensions: [{ dimension: 'input', unit: 'token', pricePerUnit: -1 }] })).toThrow()
  })

  it('rejects an unsupported currency', () => {
    expect(() => parsePriceDocument({ ...validPriceDocument(), currency: ' dollars ' })).toThrow()
  })

  it('rejects a model mismatch silently carried as a string', () => {
    expect(() => parsePriceDocument({ ...validPriceDocument(), model: '' })).toThrow()
  })
})

describe('price effective window', () => {
  it('is effective inside its window', () => {
    expect(priceEffectiveFailure(validPriceDocument(), '2026-08-06T00:00:00Z')).toBeUndefined()
  })

  it('is not yet effective before its start', () => {
    expect(priceEffectiveFailure(validPriceDocument({ effectiveStart: '2027-01-01T00:00:00Z' }), '2026-08-06T00:00:00Z')).toBe('price-effective-window-not-reached')
  })

  it('is expired after its end', () => {
    expect(priceEffectiveFailure(validPriceDocument({ effectiveEnd: '2026-01-02T00:00:00Z' }), '2026-08-06T00:00:00Z')).toBe('price-expired')
  })
})

describe('cost calculation', () => {
  it('calculates a present cost when usage and a matching effective price are available', () => {
    const result = calculateCost({
      usage: { provider: 'gemini', model: 'gemini-2.5-flash', inputTokens: 100, outputTokens: 50, thinkingTokens: null },
      price: validPriceDocument(),
      at: '2026-08-06T00:00:00Z',
    })
    expect(result.status).toBe('present')
    if (result.status === 'present') {
      expect(result.currency).toBe('USD')
      expect(result.amount).toBeCloseTo(100 * 0.00001 + 50 * 0.00003, 10)
    }
  })

  it('is absent with model-mismatch when the model differs', () => {
    const result = calculateCost({
      usage: { provider: 'gemini', model: 'gemini-2.5-pro', inputTokens: 100, outputTokens: 50, thinkingTokens: null },
      price: validPriceDocument(),
      at: '2026-08-06T00:00:00Z',
    })
    expect(result).toMatchObject({ status: 'absent', reason: 'model-mismatch' })
  })

  it('is absent with usage-unavailable when no tokens were observed', () => {
    const result = calculateCost({
      usage: { provider: 'gemini', model: 'gemini-2.5-flash', inputTokens: null, outputTokens: null, thinkingTokens: null },
      price: validPriceDocument(),
      at: '2026-08-06T00:00:00Z',
    })
    expect(result).toMatchObject({ status: 'absent', reason: 'usage-unavailable' })
  })

  it('is absent with missing-price-dimension when thinking tokens have no price', () => {
    const result = calculateCost({
      usage: { provider: 'gemini', model: 'gemini-2.5-flash', inputTokens: 100, outputTokens: 50, thinkingTokens: 20 },
      price: validPriceDocument(),
      at: '2026-08-06T00:00:00Z',
    })
    expect(result).toMatchObject({ status: 'absent', reason: 'missing-price-dimension' })
  })

  it('is absent with price-expired when the window has closed', () => {
    const result = calculateCost({
      usage: { provider: 'gemini', model: 'gemini-2.5-flash', inputTokens: 100, outputTokens: 50, thinkingTokens: null },
      price: validPriceDocument({ effectiveEnd: '2026-01-02T00:00:00Z' }),
      at: '2026-08-06T00:00:00Z',
    })
    expect(result).toMatchObject({ status: 'absent', reason: 'price-expired' })
  })

  it('COST_ABSENT_REASONS lists the six documented reasons', () => {
    expect(COST_ABSENT_REASONS).toEqual(['usage-unavailable', 'model-mismatch', 'price-not-approved', 'price-expired', 'price-effective-window-not-reached', 'missing-price-dimension'])
  })

  it('produces a stable digest for the same document', () => {
    expect(priceDocumentDigest(validPriceDocument())).toMatch(/^[0-9a-f]{64}$/)
    expect(priceDocumentDigest(validPriceDocument())).toBe(priceDocumentDigest(validPriceDocument()))
  })
})
