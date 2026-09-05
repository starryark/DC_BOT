/**
 * Correction, supersession, and tombstoning (IMP-108; ADR-009, ADR-012).
 *
 * Correcting a fact must not rewrite what was said. "The user lived in Osaka
 * and later said Tokyo" and "the user always said Tokyo" are different
 * histories, and only the first is true. So a correction appends a new fact,
 * closes the old one's validity window, and links them — it never mutates
 * (REQ-PRIV-010, TEST-MEM-002).
 */

import type { FactId, GovernanceId, Timestamp } from './ids'
import type { SemanticFact } from './memory-records'
import type { Provenance } from './provenance'

import { MemoryError } from './errors'
import { assertWritableFact } from './memory-records'
import { assertDurableProvenance } from './provenance'

export interface CorrectionInput {
  /** The fact being corrected. Returned unmutated, with its window closed. */
  previous: SemanticFact
  /** Id minted by the adapter for the replacement fact. */
  factId: FactId
  value: string
  provenance: Provenance
  /** When the new value became true. Also closes the previous window. */
  effectiveAt: Timestamp
  recordedAt: Timestamp
}

/** Both sides of a correction: the closed old fact and the new one. */
export interface CorrectionResult {
  superseded: SemanticFact
  replacement: SemanticFact
}

/**
 * Apply a correction.
 *
 * Returns new objects; the inputs are untouched, so a caller cannot
 * accidentally persist a half-applied correction. The old fact keeps its
 * provenance and its original `validFrom` — that is the evidence that it was
 * once believed.
 */
export function applyCorrection(input: CorrectionInput): CorrectionResult {
  if (input.previous.tombstonedBy != null) {
    throw new MemoryError('TARGET_NOT_FOUND', 'a tombstoned fact cannot be corrected; it no longer exists as an assertion', {
      retryable: false,
      details: { factId: input.previous.factId },
    })
  }
  if (input.previous.supersededBy != null) {
    throw new MemoryError('INVALID_INTENT', 'this fact was already superseded; correct the current fact instead', {
      retryable: false,
      details: { factId: input.previous.factId, supersededBy: input.previous.supersededBy },
    })
  }
  if (Date.parse(input.effectiveAt) < Date.parse(input.previous.validity.validFrom)) {
    throw new MemoryError('INVALID_INTENT', 'a correction cannot take effect before the fact it corrects began', {
      retryable: false,
      details: { effectiveAt: input.effectiveAt, previousValidFrom: input.previous.validity.validFrom },
    })
  }
  assertDurableProvenance(input.provenance)

  const replacement: SemanticFact = {
    ...input.previous,
    factId: input.factId,
    value: input.value,
    provenance: input.provenance,
    validity: {
      validFrom: input.effectiveAt,
      validUntil: undefined,
      recordedAt: input.recordedAt,
    },
    supersedes: input.previous.factId,
    supersededBy: undefined,
  }
  assertWritableFact(replacement)

  const superseded: SemanticFact = {
    ...input.previous,
    validity: { ...input.previous.validity, validUntil: input.effectiveAt },
    supersededBy: input.factId,
  }

  return { superseded, replacement }
}

/**
 * The current fact in a supersession chain.
 *
 * Follows `supersededBy` rather than picking the newest `recordedAt`: a late
 * import of an old correction must not become "current" just because it was
 * written last (TEST-RANK-001).
 */
export function currentFact(chain: readonly SemanticFact[]): SemanticFact | undefined {
  const live = chain.filter(fact => fact.tombstonedBy == null)
  return live.find(fact => fact.supersededBy == null)
}

/**
 * What was believed at a point in world time.
 *
 * Used for "why did you say Osaka last week" — the as-of query that keeps a
 * correction from erasing the record of the mistake.
 */
export function factAsOf(chain: readonly SemanticFact[], at: Timestamp): SemanticFact | undefined {
  const instant = Date.parse(at)
  return chain
    .filter(fact => fact.tombstonedBy == null)
    .find((fact) => {
      const from = Date.parse(fact.validity.validFrom)
      const until = fact.validity.validUntil == null ? Number.POSITIVE_INFINITY : Date.parse(fact.validity.validUntil)
      return from <= instant && instant < until
    })
}

/**
 * Tombstone a fact.
 *
 * Erasure keeps the row and drops the assertion: `value` is emptied and the
 * governance id recorded, so the supersession chain and the causal graph stay
 * traversable while the content is gone (ADR-012, FIND-018).
 */
export function tombstoneFact(fact: SemanticFact, governanceId: GovernanceId): SemanticFact {
  return { ...fact, value: '', tombstonedBy: governanceId }
}

/** Explicit user intents that mutate memory (`09-…` OP-08). */
export type MemoryIntent = 'remember' | 'correct' | 'forget'

export interface IntentDeclaration {
  intent: MemoryIntent
  /** Required for `remember` and `correct`. */
  value?: string
  /** Required for `correct` and for a targeted `forget`. */
  targetFactId?: FactId
  /** Required for a scope-wide `forget` when no specific fact is named. */
  targetScopeId?: string
  provenance: Provenance
}

/**
 * Validate an explicit memory command before it does anything.
 *
 * A `forget` with neither a target fact nor a scope would be unbounded, and an
 * unbounded delete is the over-deletion half of RISK-044.
 */
export function assertIntentComplete(declaration: IntentDeclaration): void {
  switch (declaration.intent) {
    case 'remember':
      if (!declaration.value?.trim())
        throw new MemoryError('MISSING_VALUE', 'remember requires a value', { retryable: false })
      assertDurableProvenance(declaration.provenance)
      return
    case 'correct':
      if (!declaration.targetFactId)
        throw new MemoryError('INVALID_INTENT', 'correct requires the fact being corrected', { retryable: false })
      if (!declaration.value?.trim())
        throw new MemoryError('MISSING_VALUE', 'correct requires a replacement value', { retryable: false })
      assertDurableProvenance(declaration.provenance)
      return
    case 'forget':
      if (!declaration.targetFactId && !declaration.targetScopeId)
        throw new MemoryError('INVALID_INTENT', 'forget requires a target fact or a target scope; an unbounded forget is refused', { retryable: false })
  }
}
