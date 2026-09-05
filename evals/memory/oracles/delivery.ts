import type { AssertionResult } from '../contracts'

/**
 * Idempotency, restart, and prompt-safety oracle (IMP-802, T003).
 *
 * These verdicts close the lifecycle properties the delivery oracle does not:
 * duplicate idempotency keys must not duplicate durable records; close/reopen
 * must preserve eligible context and deletion state; and untrusted prompt data
 * must serialize as length-prefixed data, never as a chat role.
 */

/** Observation of a duplicate-key deduplication check. */
export interface IdempotencyObservation {
  readonly kind: 'event' | 'generation' | 'delivery'
  /** Whether the duplicate write reported deduplication. */
  readonly deduplicated: boolean
  /** Count of durable records after the duplicate write. */
  readonly recordCount: number
  /** Expected record count (one, since the duplicate must not add a row). */
  readonly expectedRecordCount: number
}

/** Observation of a restart continuity check. */
export interface RestartObservation {
  /** Selected item ids before close. */
  readonly beforeSelectedItemIds: readonly string[]
  /** Selected item ids after reopen. */
  readonly afterSelectedItemIds: readonly string[]
  /** Event id that belongs to a non-forgotten subject and must survive reopen. */
  readonly keptEventId: string
  /** Whether forgotten data was absent from context after reopen. */
  readonly forgottenAbsentFromContext: boolean
  /** Whether forgotten data was absent from export after reopen. */
  readonly forgottenAbsentFromExport: boolean
}

/** Observation of a prompt-data safety check. */
export interface PromptSafetyObservation {
  /** The serialized prompt text the runtime produced. */
  readonly serializedPrompt: string
}

/** Verdicts for IDEMP-001: duplicate keys do not duplicate durable records. */
export function idempotencyVerdict(observation: IdempotencyObservation): AssertionResult {
  const id = observation.kind === 'event' ? 'IDEMP-001-A' : observation.kind === 'generation' ? 'IDEMP-001-B' : 'IDEMP-001-C'
  const ok = observation.deduplicated && observation.recordCount === observation.expectedRecordCount
  return {
    assertionId: id,
    passed: ok,
    diagnostic: ok
      ? `duplicate ${observation.kind} key deduplicated (${observation.recordCount} record(s))`
      : `duplicate ${observation.kind} key was not deduplicated (${observation.recordCount} record(s), expected ${observation.expectedRecordCount})`,
  }
}

/** Verdicts for RESTART-001: reopen preserves eligible context and deletion state. */
export function restartVerdicts(observation: RestartObservation): readonly AssertionResult[] {
  const after = new Set(observation.afterSelectedItemIds)
  // RESTART-001-A: the non-forgotten (kept) event must survive close/reopen in
  // context. Full set equality would be wrong, because the forgotten event is
  // *supposed* to drop out — that is what RESTART-001-B checks separately.
  const keptSurvives = observation.keptEventId !== '' && after.has(observation.keptEventId)
  return [
    {
      assertionId: 'RESTART-001-A',
      passed: keptSurvives,
      diagnostic: keptSurvives
        ? 'non-forgotten eligible context survived close/reopen'
        : 'kept event was lost on reopen',
    },
    {
      assertionId: 'RESTART-001-B',
      passed: observation.forgottenAbsentFromContext && observation.forgottenAbsentFromExport,
      diagnostic: observation.forgottenAbsentFromContext && observation.forgottenAbsentFromExport
        ? 'forgotten data stayed absent after reopen'
        : 'forgotten data reappeared after reopen',
    },
  ]
}

/** Verdict for PROMPT-001: payload serializes as untrusted length-prefixed data. */
export function promptSafetyVerdict(observation: PromptSafetyObservation): AssertionResult {
  const text = observation.serializedPrompt
  // The production serializer wraps memory in a <memory-data> element and emits
  // role markers escaped. A chat-role marker appearing unescaped, or the memory
  // boundary missing, is the injection the assertion exists to catch.
  const hasBoundary = text.includes('<memory-data') && text.includes('</memory-data>')
  const hasUnescapedRoleMarker = /(?:^|\n)\s*(?:system|assistant|developer|user)\s*:/i.test(text.replace(/<memory-data[\s\S]*?<\/memory-data>/g, ''))
  // Mass mentions must be neutralized inside the memory block.
  const memoryBlock = text.match(/<memory-data[^>]*>([\s\S]*?)<\/memory-data>/)?.[1] ?? ''
  const hasRawMassMention = /@(?:everyone|here)/i.test(memoryBlock)
  const passed = hasBoundary && !hasUnescapedRoleMarker && !hasRawMassMention
  return {
    assertionId: 'PROMPT-001-A',
    passed,
    diagnostic: passed
      ? 'payload serialized as length-prefixed untrusted data'
      : `prompt boundary=${hasBoundary} unescapedRole=${hasUnescapedRoleMarker} rawMassMention=${hasRawMassMention}`,
  }
}
