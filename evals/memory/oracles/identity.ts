import type { AssertionResult } from '../contracts'

/**
 * Identity-continuity oracle for the G8-1 evaluator (IMP-802, T003).
 *
 * Rule-based verdicts over adapter observations, never semantic text
 * similarity and never a model judge. The oracle compares durable identity
 * digests and room versions — the exact state transitions the runtime is
 * contracted to preserve — so identity merge, collision, and rename-discontinuity
 * are detected by set equality, not by reading names.
 */

/** Observation of two ingress resolutions the identity scenarios produce. */
export interface IdentityPairObservation {
  /** HMAC digest of the first speaker's durable identity key. */
  readonly firstIdentityDigest: string
  /** HMAC digest of the second speaker's durable identity key. */
  readonly secondIdentityDigest: string
  /** First speaker's resolved person id (content-free token). */
  readonly firstPersonId: string
  /** Second speaker's resolved person id (content-free token). */
  readonly secondPersonId: string
}

/** Observation of a rename sequence the continuity scenario produces. */
export interface RenameObservation {
  /** Identity digest before the rename. */
  readonly beforeDigest: string
  /** Identity digest after the rename. */
  readonly afterDigest: string
  /** Person id before the rename. */
  readonly beforePersonId: string
  /** Person id after the rename. */
  readonly afterPersonId: string
  /** Count of historical events still attributable to the person after rename. */
  readonly historicalEventCount: number
  /** Count of historical events expected to remain attributable. */
  readonly expectedHistoricalEventCount: number
}

/** Verdict for ID-001: two same-name speakers must stay distinct. */
export function identityCollisionVerdict(observation: IdentityPairObservation, redact: (kind: string, id: string) => string): AssertionResult {
  const distinct = observation.firstIdentityDigest !== '' && observation.secondIdentityDigest !== ''
    && observation.firstIdentityDigest !== observation.secondIdentityDigest
    && observation.firstPersonId !== observation.secondPersonId
  return {
    assertionId: 'ID-001-A',
    passed: distinct,
    diagnostic: distinct
      ? 'same-name speakers resolved to distinct persons'
      : `speakers collapsed: ${redact('person', observation.firstPersonId)} == ${redact('person', observation.secondPersonId)}`,
  }
}

/** Verdicts for ID-002: a rename must preserve continuity and history. */
export function renameContinuityVerdicts(observation: RenameObservation, redact: (kind: string, id: string) => string): readonly AssertionResult[] {
  const continuity = observation.beforePersonId === observation.afterPersonId
    && observation.beforeDigest === observation.afterDigest
  const historyPreserved = observation.historicalEventCount === observation.expectedHistoricalEventCount
  return [
    {
      assertionId: 'ID-002-A',
      passed: continuity,
      diagnostic: continuity
        ? 'rename preserved person continuity'
        : `rename broke continuity: ${redact('person', observation.beforePersonId)} -> ${redact('person', observation.afterPersonId)}`,
    },
    {
      assertionId: 'ID-002-B',
      passed: historyPreserved,
      diagnostic: historyPreserved
        ? 'historical events remain attributable'
        : `expected ${observation.expectedHistoricalEventCount} historical events, found ${observation.historicalEventCount}`,
    },
  ]
}
