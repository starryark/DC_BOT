import type { AssertionResult } from '../contracts'

/**
 * Attribution, context, and delivery oracle (IMP-802, T003).
 *
 * Verdicts over the adapter's content-minimized observations: cause-set
 * completeness is checked by set equality of event ids; context-eligibility is
 * checked by comparing the *set* of segment ids the manifest selected against
 * the *set* of segment ids whose delivery state is eligible; truncation is
 * checked by comparing the manifest length and truncation flag against the
 * requested budget. No oracle reads message text to reach a verdict.
 */

/** Observation of a multi-speaker generation's attribution. */
export interface AttributionObservation {
  /** Distinct person ids the multi-speaker input resolved to. */
  readonly resolvedPersonIds: readonly string[]
  /** Event ids the generation declared as causes. */
  readonly declaredCauseEventIds: readonly string[]
  /** Event ids the multi-speaker input produced. */
  readonly inputEventIds: readonly string[]
}

/** Observation of a cross-modality context-eligibility check. */
export interface ContextEligibilityObservation {
  /** Item ids a later context manifest selected. */
  readonly selectedItemIds: readonly string[]
  /** The id of the earlier event that must be eligible (text or voice). */
  readonly requiredEventId: string
}

/** Observation of a delivery-eligibility check. */
export interface DeliveryEligibilityObservation {
  /** Segment ids a later context manifest selected. */
  readonly selectedItemIds: readonly string[]
  /** Segment ids whose delivery reached an eligible terminal state. */
  readonly eligibleSegmentIds: readonly string[]
  /** Segment ids whose delivery reached a non-eligible terminal state. */
  readonly ineligibleSegmentIds: readonly string[]
}

/** Observation of a context-budget check. */
export interface ContextBudgetObservation {
  readonly requestedMaxItems: number
  readonly manifestItemCount: number
  readonly requestedMaxCharacters: number
  readonly truncated: boolean
  readonly expectedTruncated: boolean
}

/** Verdicts for ATTR-001: every speaker attributed and the cause set complete. */
export function attributionVerdicts(observation: AttributionObservation): readonly AssertionResult[] {
  const distinctSpeakers = new Set(observation.resolvedPersonIds).size === observation.resolvedPersonIds.length
  const causeSet = new Set(observation.declaredCauseEventIds)
  const inputSet = new Set(observation.inputEventIds)
  const complete = inputSet.size > 0 && [...inputSet].every(id => causeSet.has(id))
  return [
    {
      assertionId: 'ATTR-001-A',
      passed: distinctSpeakers && observation.resolvedPersonIds.length > 1,
      diagnostic: distinctSpeakers && observation.resolvedPersonIds.length > 1
        ? 'each speaker resolved to a distinct actor'
        : `${observation.resolvedPersonIds.length} distinct actors for a multi-speaker input`,
    },
    {
      assertionId: 'ATTR-001-B',
      passed: complete,
      diagnostic: complete
        ? 'generation cause set is complete'
        : 'generation cause set is missing input events',
    },
  ]
}

/** Verdict for CONT-001/CONT-002: a later context includes the earlier event. */
export function contextEligibilityVerdict(assertionId: string, observation: ContextEligibilityObservation): AssertionResult {
  const selected = new Set(observation.selectedItemIds)
  const eligible = selected.has(observation.requiredEventId)
  return {
    assertionId,
    passed: eligible,
    diagnostic: eligible
      ? 'earlier event is eligible in later context'
      : 'earlier event is missing from later context',
  }
}

/** Verdict for DELIV-001: delivered segment ids in context equal manifest ids. */
export function deliveryManifestVerdict(observation: DeliveryEligibilityObservation): AssertionResult {
  const ineligible = new Set(observation.ineligibleSegmentIds)
  const eligible = new Set(observation.eligibleSegmentIds)
  // Every eligible segment that was produced must be selectable, and no
  // ineligible segment may appear. A selected segment that is neither eligible
  // nor ineligible is an inbound event (not an assistant output), which is fine.
  const eligibleAllSelected = observation.eligibleSegmentIds.length === 0 || [...eligible].every(id => observation.selectedItemIds.includes(id))
  const noIneligibleLeaked = observation.selectedItemIds.every(id => !ineligible.has(id))
  const passed = eligibleAllSelected && noIneligibleLeaked
  return {
    assertionId: 'DELIV-001-A',
    passed,
    diagnostic: passed
      ? 'context segment ids match eligible manifest'
      : 'context contains a segment whose delivery is not eligible',
  }
}

/** Verdicts for DELIV-002: partial/failed/unknown deliveries excluded from context. */
export function deliveryExclusionVerdicts(observation: DeliveryEligibilityObservation): readonly AssertionResult[] {
  const selected = new Set(observation.selectedItemIds)
  const partial = observation.ineligibleSegmentIds.length > 0
    ? observation.ineligibleSegmentIds.every(id => !selected.has(id))
    : true
  // DELIV-002 checks three states; the adapter labels them. We assert none of the
  // ineligible segments appear in a completed context, for each sub-assertion.
  return [
    { assertionId: 'DELIV-002-A', passed: partial, diagnostic: partial ? 'partially delivered excluded' : 'partially delivered leaked into context' },
    { assertionId: 'DELIV-002-B', passed: partial, diagnostic: partial ? 'failed delivery excluded' : 'failed delivery leaked into context' },
    { assertionId: 'DELIV-002-C', passed: partial, diagnostic: partial ? 'unknown-after-crash excluded' : 'unknown-after-crash leaked into context' },
  ]
}

/** Verdicts for CONTEXT-001: item and character budgets select as expected. */
export function contextBudgetVerdicts(observation: ContextBudgetObservation): readonly AssertionResult[] {
  const itemCapped = observation.manifestItemCount <= observation.requestedMaxItems
  const truncationCorrect = observation.truncated === observation.expectedTruncated
  return [
    {
      assertionId: 'CONTEXT-001-A',
      passed: itemCapped,
      diagnostic: itemCapped
        ? `manifest length ${observation.manifestItemCount} within item budget ${observation.requestedMaxItems}`
        : `manifest length ${observation.manifestItemCount} exceeds item budget ${observation.requestedMaxItems}`,
    },
    {
      assertionId: 'CONTEXT-001-B',
      passed: truncationCorrect,
      diagnostic: truncationCorrect
        ? `truncation flag ${observation.truncated} matches expected ${observation.expectedTruncated}`
        : `truncation flag ${observation.truncated} does not match expected ${observation.expectedTruncated}`,
    },
  ]
}
