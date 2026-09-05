import type { AssertionResult } from '../contracts'

/**
 * Privacy and capability oracle (IMP-802, T003).
 *
 * Zero-tolerance verdicts for export/deletion/privacy leakage and the
 * disabled-capability refusal. Leakage is a set/count difference over the
 * adapter's content-minimized export observations; a disabled operation must
 * return the explicit `capability_disabled` code and perform no mutation.
 */

/** Observation of an export-scope check (PRIV-001). */
export interface PrivacyExportObservation {
  /** Fact count the requester's authorized-room export returned. */
  readonly exportFactCount: number
  /** Whether the export was confined to the requester's room (no foreign facts). */
  readonly confinedToRequesterRoom: boolean
}

/** Observation of a forget-then-reopen check (PRIV-002). */
export interface PrivacyDeletionObservation {
  /** Whether forgotten data is absent from context after reopen. */
  readonly forgottenAbsentFromContext: boolean
  /** Whether forgotten data is absent from export after reopen. */
  readonly forgottenAbsentFromExport: boolean
}

/** Observation of a disabled-capability refusal (CAP-001). */
export interface CapabilityRefusalObservation {
  /** Whether `remember` returned the capability_disabled code. */
  readonly rememberRefused: boolean
  /** Whether `correct` returned the capability_disabled code. */
  readonly correctRefused: boolean
  /** Count of semantic-memory writes performed by the refused operations. */
  readonly semanticWriteCount: number
}

/** Verdict for PRIV-001: export exposes only requester authorized-room data. */
export function privacyExportVerdict(observation: PrivacyExportObservation): AssertionResult {
  const passed = observation.confinedToRequesterRoom
  return {
    assertionId: 'PRIV-001-A',
    passed,
    diagnostic: passed
      ? `export confined to requester room (${observation.exportFactCount} fact(s))`
      : `export leaked data outside requester room (${observation.exportFactCount} fact(s))`,
  }
}

/** Verdicts for PRIV-002: forgotten data never reappears after reopen. */
export function privacyDeletionVerdicts(observation: PrivacyDeletionObservation): readonly AssertionResult[] {
  return [
    {
      assertionId: 'PRIV-002-A',
      passed: observation.forgottenAbsentFromContext,
      diagnostic: observation.forgottenAbsentFromContext
        ? 'forgotten data absent from context after reopen'
        : 'forgotten data reappeared in context after reopen',
    },
    {
      assertionId: 'PRIV-002-B',
      passed: observation.forgottenAbsentFromExport,
      diagnostic: observation.forgottenAbsentFromExport
        ? 'forgotten data absent from export after reopen'
        : 'forgotten data reappeared in export after reopen',
    },
  ]
}

/** Verdict for CAP-001: remember/correct refuse with no mutation. */
export function capabilityRefusalVerdict(observation: CapabilityRefusalObservation): AssertionResult {
  const passed = observation.rememberRefused && observation.correctRefused && observation.semanticWriteCount === 0
  return {
    assertionId: 'CAP-001-A',
    passed,
    diagnostic: passed
      ? 'remember and correct returned capability_disabled with zero writes'
      : `rememberRefused=${observation.rememberRefused} correctRefused=${observation.correctRefused} semanticWrites=${observation.semanticWriteCount}`,
  }
}
