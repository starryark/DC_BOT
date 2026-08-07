import * as v from 'valibot'

import { sha256Canonical } from '../contracts'

/**
 * Strict price document contract for the IMP-803 deterministic benchmark.
 *
 * Currency cost may be calculated only from a separately approved, matching
 * price document. This module defines that document's schema, validates its
 * provenance and effective window, and converts observed token usage into cost
 * only when every required dimension has a matching approved price.
 *
 * Cost is kept distinct from usage: observed token usage is software evidence;
 * calculated cost from approved price input is derived; billed invoice cost
 * remains unverified and is never claimed by this benchmark.
 */

/** Billing units a price may be expressed in per token. */
export const PRICE_BILLING_UNITS = Object.freeze(['token', 'character', 'second', 'image'] as const)
export type PriceBillingUnit = typeof PRICE_BILLING_UNITS[number]

/** A validated ISO-4217 currency code; enforced as 3 uppercase letters. */
const currencyCode = v.pipe(v.string(), v.regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code'))

/** One approved price dimension for a token type. */
const priceDimensionSchema = v.strictObject({
  /** The usage dimension this price applies to. */
  dimension: v.picklist(['input', 'output', 'thinking', 'total']),
  unit: v.picklist(PRICE_BILLING_UNITS),
  /** Price per unit in the document's currency, as a minor-unit fraction. */
  pricePerUnit: v.pipe(v.number(), v.finite(), v.minValue(0)),
})

/** A strict, approved price document. */
export const priceDocumentSchema = v.strictObject({
  format: v.literal(1),
  provider: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
  /** Exact model id the prices apply to; a model mismatch rejects the document. */
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  billingUnit: v.picklist(PRICE_BILLING_UNITS),
  currency: currencyCode,
  dimensions: v.pipe(v.array(priceDimensionSchema), v.minLength(1)),
  /** ISO-8601 timestamp the prices take effect. */
  effectiveStart: v.pipe(v.string(), v.minLength(1)),
  /** Optional ISO-8601 timestamp the prices expire; absent means open-ended. */
  effectiveEnd: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  /** Human-readable source reference; content-free. */
  source: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  approver: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  approvedAt: v.pipe(v.string(), v.minLength(1)),
  /** Repository/contract provenance; content-free. */
  provenance: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
})

export type PriceDocument = v.InferOutput<typeof priceDocumentSchema>

/** Reasons a cost calculation may be absent. */
export const COST_ABSENT_REASONS = Object.freeze([
  'usage-unavailable',
  'model-mismatch',
  'price-not-approved',
  'price-expired',
  'price-effective-window-not-reached',
  'missing-price-dimension',
] as const)
export type CostAbsentReason = typeof COST_ABSENT_REASONS[number]

/** A calculated cost result; present only when every rule is satisfied. */
export type CostResult
  = | { readonly status: 'present', readonly currency: string, readonly amount: number, readonly dimensions: ReadonlyArray<{ readonly dimension: string, readonly tokens: number, readonly pricePerUnit: number, readonly subtotal: number }> }
    | { readonly status: 'absent', readonly reason: CostAbsentReason }

/**
 * Parse a price document, rejecting any whose structure or provenance is invalid.
 *
 * A negative price, unknown unit, unsupported currency, or missing approval
 * fails loudly rather than producing a silently-zero cost.
 */
export function parsePriceDocument(input: unknown): PriceDocument {
  return v.parse(priceDocumentSchema, input)
}

/**
 * Validate a price document against an effective window.
 *
 * Returns the failure reason if the document is expired or not yet effective,
 * or `undefined` if it is currently effective.
 */
export function priceEffectiveFailure(document: PriceDocument, at: string): CostAbsentReason | undefined {
  if (document.effectiveStart > at)
    return 'price-effective-window-not-reached'
  if (document.effectiveEnd != null && document.effectiveEnd < at)
    return 'price-expired'
  return undefined
}

/**
 * Convert observed usage into currency cost.
 *
 * Cost is present only when: observed usage is available, the model/provider
 * matches, the price document is approved and effective, and every required
 * usage dimension has a price. Otherwise the result is absent with a reason;
 * zero is never emitted as a cost.
 */
export function calculateCost(params: {
  readonly usage: { readonly provider: string, readonly model: string, readonly inputTokens: number | null, readonly outputTokens: number | null, readonly thinkingTokens: number | null }
  readonly price: PriceDocument
  readonly at: string
}): CostResult {
  const { usage, price, at } = params
  if (usage.provider !== price.provider || usage.model !== price.model)
    return { status: 'absent', reason: 'model-mismatch' }
  const effectiveFailure = priceEffectiveFailure(price, at)
  if (effectiveFailure)
    return { status: 'absent', reason: effectiveFailure }

  const dimensionPrice = (dimension: 'input' | 'output' | 'thinking'): number | undefined =>
    price.dimensions.find(entry => entry.dimension === dimension)?.pricePerUnit

  const dimensions: Array<{ dimension: string, tokens: number, pricePerUnit: number, subtotal: number }> = []
  let amount = 0

  const inputTokens = usage.inputTokens
  if (inputTokens != null) {
    const unitPrice = dimensionPrice('input')
    if (unitPrice == null)
      return { status: 'absent', reason: 'missing-price-dimension' }
    const subtotal = inputTokens * unitPrice
    amount += subtotal
    dimensions.push({ dimension: 'input', tokens: inputTokens, pricePerUnit: unitPrice, subtotal })
  }
  const outputTokens = usage.outputTokens
  if (outputTokens != null) {
    const unitPrice = dimensionPrice('output')
    if (unitPrice == null)
      return { status: 'absent', reason: 'missing-price-dimension' }
    const subtotal = outputTokens * unitPrice
    amount += subtotal
    dimensions.push({ dimension: 'output', tokens: outputTokens, pricePerUnit: unitPrice, subtotal })
  }
  const thinkingTokens = usage.thinkingTokens
  if (thinkingTokens != null) {
    const unitPrice = dimensionPrice('thinking')
    if (unitPrice == null)
      return { status: 'absent', reason: 'missing-price-dimension' }
    const subtotal = thinkingTokens * unitPrice
    amount += subtotal
    dimensions.push({ dimension: 'thinking', tokens: thinkingTokens, pricePerUnit: unitPrice, subtotal })
  }

  // If no tokens were observed at all, usage is unavailable rather than free.
  if (dimensions.length === 0)
    return { status: 'absent', reason: 'usage-unavailable' }

  return { status: 'present', currency: price.currency, amount, dimensions }
}

/** Canonical digest of a price document for provenance tracking. */
export function priceDocumentDigest(document: PriceDocument): string {
  return sha256Canonical(document)
}

export { sha256Canonical }
