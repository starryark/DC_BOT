import type { BrainUsageLiveArtifact, LiveArtifact } from './live-artifact'
import type { PriceDocument } from './price-contract'

import * as v from 'valibot'

import { brainUsageLiveArtifactSchema, isBrainUsageLiveArtifact, liveArtifactDigest, parseLiveArtifact } from './live-artifact'
import { calculateCost, COST_ABSENT_REASONS, currencyCodeSchema } from './price-contract'

/**
 * Cost evidence for the IMP-803 deterministic performance benchmark.
 *
 * `costAvailability: "available"` used to be an input the report builder was
 * handed and published unchallenged, so a summary could assert a calculated
 * cost that nothing in the artifact set could contradict — and the sanctioned
 * producer could not create that state at all, which left the synthetic G8
 * fixture asserting something the real CLI never emits.
 *
 * This module is the single derivation: it selects the one cost-eligible brain
 * usage sample from the imported live artifacts, calls the pricing authority in
 * {@link calculateCost}, and returns a discriminated result in which
 * availability cannot be expressed without the evidence that justifies it. The
 * published {@link CostEvidence} names its source artifact, that artifact's
 * canonical digest, the price document digest, and the per-dimension
 * arithmetic, so an independent consumer holding the approved price document
 * recomputes the amount rather than trusting it.
 *
 * Calculated cost is an estimate derived from one observed usage sample and an
 * approved price document. It is not verified billing truth.
 */

const hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))

/** Reasons cost is absent before the pricing arithmetic can run at all. */
export const COST_PRE_CALCULATION_ABSENCE_REASONS = Object.freeze([
  'no-price-document-supplied',
  'no-brain-usage-sample',
  'brain-usage-not-complete',
] as const)

/** Every content-free reason a run may publish for an unavailable cost. */
export const COST_ABSENCE_REASONS = Object.freeze([...COST_PRE_CALCULATION_ABSENCE_REASONS, ...COST_ABSENT_REASONS] as const)
export type CostAbsenceReason = typeof COST_ABSENCE_REASONS[number]

/**
 * The sanitized cost evidence a performance summary publishes.
 *
 * It embeds the imported brain live artifact itself — which is already
 * content-free by {@link parseLiveArtifact}'s scan — rather than a bare amount,
 * because a verifier needs the token counts to recompute the subtotal it is
 * being asked to believe.
 */
export const costEvidenceSchema = v.strictObject({
  format: v.literal(1),
  /** Canonical digest of {@link liveArtifact}; must appear in the run's imported digests. */
  liveArtifactDigest: hex64,
  liveArtifact: brainUsageLiveArtifactSchema,
  priceDocumentDigest: hex64,
  currency: currencyCodeSchema,
  amount: v.pipe(v.number(), v.finite(), v.minValue(0)),
  dimensions: v.pipe(v.array(v.strictObject({
    dimension: v.picklist(['input', 'output', 'thinking']),
    tokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    pricePerUnit: v.pipe(v.number(), v.finite(), v.minValue(0)),
    subtotal: v.pipe(v.number(), v.finite(), v.minValue(0)),
  })), v.minLength(1)),
})

export type CostEvidence = v.InferOutput<typeof costEvidenceSchema>

/** A derived cost outcome; `available` is unreachable without valid evidence. */
export type CostDerivation
  = | { readonly status: 'available', readonly evidence: CostEvidence }
    | { readonly status: 'unavailable', readonly reason: CostAbsenceReason }

/** More than one cost-eligible brain sample was supplied for one report. */
export class AmbiguousBrainUsageError extends Error {
  /** Stable, content-free reason code. */
  readonly reason = 'ambiguous-brain-usage-samples'
  constructor(count: number) {
    super(`${count} cost-eligible brain usage samples supplied; exactly one is required`)
    this.name = 'AmbiguousBrainUsageError'
  }
}

/**
 * Whether one usage record may found a cost calculation.
 *
 * Only a completed observation qualifies. A `failed`, `aborted`, or
 * `unavailable` call may still carry token fields — the accumulator emits
 * whatever the stream produced before it stopped — and those counts describe a
 * call that did not finish, so they must never become a priced amount.
 */
export function isCostEligibleBrainArtifact(artifact: LiveArtifact): artifact is BrainUsageLiveArtifact {
  return isBrainUsageLiveArtifact(artifact) && artifact.usage.disposition === 'complete'
}

/**
 * Select the single cost-eligible brain usage sample from imported artifacts.
 *
 * Two eligible samples are ambiguous, not a choice: there is no repository rule
 * that says which one a report's cost describes, and picking the first would
 * make the published amount depend on argv order. It fails closed instead.
 */
export function selectCostEligibleBrainArtifact(artifacts: readonly LiveArtifact[]): {
  readonly eligible?: BrainUsageLiveArtifact
  readonly brainSampleCount: number
} {
  const brain = artifacts.filter(isBrainUsageLiveArtifact)
  const eligible = brain.filter(isCostEligibleBrainArtifact)
  if (eligible.length > 1)
    throw new AmbiguousBrainUsageError(eligible.length)
  return { ...(eligible[0] ? { eligible: eligible[0] } : {}), brainSampleCount: brain.length }
}

/** Parse published cost evidence, rescanning the embedded artifact on import terms. */
export function parseCostEvidence(input: unknown): CostEvidence {
  const parsed = v.parse(costEvidenceSchema, input)
  // The embedded artifact is republished evidence, so it is revalidated exactly
  // as an imported one: strict schema, timestamp consistency, content scan.
  parseLiveArtifact(parsed.liveArtifact)
  return parsed
}

/**
 * Derive cost from the imported live artifacts and the approved price document.
 *
 * The price window is evaluated at the usage record's observation time, which
 * {@link parseLiveArtifact} has already forced to equal the artifact's own
 * `observedAt`, so there is exactly one instant a window question can be asked
 * about. ASR and TTS samples are unrelated to cost and are ignored here.
 *
 * Throws {@link AmbiguousBrainUsageError} when more than one cost-eligible
 * brain sample is supplied; the caller turns that into an invalid-input exit.
 */
export function deriveCostEvidence(params: {
  readonly liveArtifacts: readonly LiveArtifact[]
  readonly price?: { readonly document: PriceDocument, readonly digest: string }
}): CostDerivation {
  const { eligible, brainSampleCount } = selectCostEligibleBrainArtifact(params.liveArtifacts)
  if (!params.price)
    return { status: 'unavailable', reason: 'no-price-document-supplied' }
  if (!eligible)
    return { status: 'unavailable', reason: brainSampleCount === 0 ? 'no-brain-usage-sample' : 'brain-usage-not-complete' }

  const result = calculateCost({ usage: eligible.usage, price: params.price.document, at: eligible.usage.observedAt })
  if (result.status === 'absent')
    return { status: 'unavailable', reason: result.reason }

  return {
    status: 'available',
    evidence: parseCostEvidence({
      format: 1,
      liveArtifactDigest: liveArtifactDigest(eligible),
      liveArtifact: eligible,
      priceDocumentDigest: params.price.digest,
      currency: result.currency,
      amount: result.amount,
      dimensions: result.dimensions.map(entry => ({ ...entry })),
    }),
  }
}

/** Recompute one published evidence's amount from a supplied price document. */
export function recomputeCostEvidence(evidence: CostEvidence, price: PriceDocument): ReturnType<typeof calculateCost> {
  return calculateCost({ usage: evidence.liveArtifact.usage, price, at: evidence.liveArtifact.usage.observedAt })
}
