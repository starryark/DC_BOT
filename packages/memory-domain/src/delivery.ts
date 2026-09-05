/**
 * Output segments, delivery attempts, and context eligibility
 * (IMP-107; ADR-007, REQ-DELIVERY-001…009).
 *
 * The confirmed defects this file is shaped against:
 *
 * - `mention-responder.ts:161-176` appends the assistant turn to history before
 *   anything is sent, so a failed send leaves a reply in context that nobody
 *   saw (FIND-012).
 * - The voice path commits the whole generated reply after local playback
 *   drains, even when a clause failed synthesis, so unheard text enters the
 *   next prompt (FIND-013).
 *
 * Both are the same mistake: treating "generated" as "delivered". Here they are
 * different records with different states, and only delivered segments are
 * context-eligible.
 */

import type { DeliveryId, GenerationId, RequestId, SegmentId, Timestamp } from './ids'

import { MemoryError } from './errors'

/** Where a segment is going. */
export type DeliveryTransport = 'discord_text' | 'discord_voice'

/**
 * Delivery states.
 *
 * NOTICE:
 * `unknownAfterCrash` is required by artifact 26 REQ-DELIVERY-004 but absent
 * from artifact 22 §10.4's enum. The stricter union is taken because artifact
 * 22 §10.15 lists the crash window as a mandatory failure-injection case, so
 * the two artifacts only agree if the state exists. Recorded as deviation
 * DEV-001 in `docs/memory/implementation-status.md`.
 * Removal condition: an ADR that unifies the two enums.
 */
export type DeliveryState
  = | 'pending'
    | 'delivering'
    | 'delivered'
    | 'partiallyDelivered'
    | 'failed'
    | 'interrupted'
    /** Playback finished locally but nothing proves the segment was heard. */
    | 'unheard'
    /** The process died mid-attempt; the outcome is genuinely unknown. */
    | 'unknownAfterCrash'
    /** Reconciliation established the real outcome after the fact. */
    | 'reconciled'
    /** Bounded retry policy gave up; requires operator review. */
    | 'abandoned'

export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = Object.freeze({
  pending: Object.freeze(['delivering', 'failed', 'unknownAfterCrash'] as const),
  delivering: Object.freeze(['delivered', 'partiallyDelivered', 'failed', 'interrupted', 'unheard', 'unknownAfterCrash'] as const),
  // Reconciliation may still discover a delivered segment was, say, deleted
  // by a moderator; the state machine allows the correction rather than
  // treating `delivered` as unquestionable.
  delivered: Object.freeze(['reconciled'] as const),
  partiallyDelivered: Object.freeze(['delivering', 'reconciled', 'abandoned'] as const),
  failed: Object.freeze(['delivering', 'reconciled'] as const),
  interrupted: Object.freeze(['reconciled', 'abandoned'] as const),
  unheard: Object.freeze(['reconciled', 'abandoned'] as const),
  unknownAfterCrash: Object.freeze(['delivered', 'failed', 'partiallyDelivered', 'abandoned'] as const),
  reconciled: Object.freeze([] as const),
  abandoned: Object.freeze([] as const),
})

/** States that require no further action. */
export const TERMINAL_DELIVERY_STATES: readonly DeliveryState[] = Object.freeze(['reconciled', 'abandoned'] as const)

/** States that mean "this needs the reconciliation worker to look at it". */
export const UNRESOLVED_DELIVERY_STATES: readonly DeliveryState[] = Object.freeze([
  'unknownAfterCrash',
  'partiallyDelivered',
  'interrupted',
  'unheard',
] as const)

/** True when `from -> to` is a legal delivery transition. */
export function canTransitionDelivery(from: DeliveryState, to: DeliveryState): boolean {
  return DELIVERY_TRANSITIONS[from].includes(to)
}

/**
 * Evidence backing a delivery outcome.
 *
 * The two variants are not equivalent, and the type keeps them from being
 * treated as if they were. A Discord message id proves the platform accepted
 * the message. Local playback completion proves only that the bot finished
 * pushing audio — the user may have been muted, disconnected, or absent
 * (REQ-DELIVERY-007).
 */
export type DeliveryEvidence
  = | { kind: 'platformMessageId', platformMessageId: string }
    | { kind: 'localPlaybackCompleted', deliveredRange: DeliveredRange }
    | { kind: 'transportError', errorClass: string }
    | { kind: 'none' }

/** How much of a segment actually went out. */
export interface DeliveredRange {
  /** Characters of the segment's text that were delivered, from the start. */
  characters?: number
  /** Milliseconds of audio played, from the start. */
  playedMs?: number
}

/**
 * Whether this evidence proves a human perceived the output.
 *
 * Always `false`. The function exists rather than a comment because
 * REQ-DELIVERY-007 is a claim the system must never make, and a call site
 * asking the question gets an unambiguous answer instead of inferring one from
 * `state === 'delivered'`.
 */
export function provesAudibility(_evidence: DeliveryEvidence): false {
  return false
}

/** One contiguous piece of generated output. */
export interface OutputSegment {
  segmentId: SegmentId
  generationId: GenerationId
  /** Position within the generation, from 0. Delivery order is segment order. */
  ordinal: number
  modality: 'text' | 'voice'
  /** The exact text of this segment; for voice, the clause that was synthesized. */
  text: string
}

/** One attempt to put one segment onto one transport. */
export interface DeliveryAttempt {
  deliveryId: DeliveryId
  segmentId: SegmentId
  transport: DeliveryTransport
  /** Channel id or voice channel id. */
  destinationId: string
  /** De-duplication key, so a retry cannot double-send (TEST-DELIVERY-TEXT-003). */
  idempotencyKey: RequestId
  attemptNumber: number
  state: DeliveryState
  evidence: DeliveryEvidence
  startedAt: Timestamp
  lastTransitionAt: Timestamp
}

/** A requested delivery state change. */
export interface DeliveryTransition {
  deliveryId: DeliveryId
  from: DeliveryState
  to: DeliveryState
  evidence: DeliveryEvidence
  at: Timestamp
}

/**
 * Validate a delivery transition and its evidence.
 *
 * The evidence rule is what makes `delivered` mean something: a text segment
 * cannot reach `delivered` without a platform message id, because without one
 * there is nothing to reconcile against after a crash and nothing to prove the
 * send happened (REQ-DELIVERY-005, SCN-008).
 */
export function assertDeliveryTransition(transition: DeliveryTransition, transport: DeliveryTransport): void {
  if (!canTransitionDelivery(transition.from, transition.to)) {
    throw new MemoryError('ILLEGAL_STATE_TRANSITION', `delivery ${transition.from} -> ${transition.to} is not permitted`, {
      retryable: false,
      details: { deliveryId: transition.deliveryId, from: transition.from, to: transition.to },
    })
  }

  if (transition.to === 'delivered' && transport === 'discord_text' && transition.evidence.kind !== 'platformMessageId') {
    throw new MemoryError('MISSING_MESSAGE_ID', 'a text segment may not be marked delivered without a Discord message id', {
      retryable: false,
      details: { deliveryId: transition.deliveryId, evidenceKind: transition.evidence.kind },
    })
  }

  // Voice has no platform receipt at all, so `delivered` would be a claim the
  // transport cannot support. The honest terminal state for completed playback
  // is `unheard` plus local-playback evidence.
  if (transition.to === 'delivered' && transport === 'discord_voice') {
    throw new MemoryError('INVALID_OUTCOME', 'discord_voice has no delivery receipt; completed playback is recorded as unheard with localPlaybackCompleted evidence', {
      retryable: false,
      details: { deliveryId: transition.deliveryId },
    })
  }
}

/** Policy knob for whether partial output may re-enter context. */
export interface ContextEligibilityPolicy {
  /**
   * Allow the delivered prefix of a partially delivered segment into context.
   * Defaults to `false` everywhere: including half a sentence invites the model
   * to continue a thought the user never heard (BQ-006 owns the decision).
   */
  allowPartialAssistantOutput: boolean
  /**
   * Allow completed voice playback into context. Voice never reaches
   * `delivered`, so without this the voice path would have no history at all;
   * with it, "the bot finished speaking" counts, and interruption does not.
   */
  treatCompletedPlaybackAsEligible: boolean
}

/** The conservative default: only proven-delivered text is context-eligible. */
export const STRICT_CONTEXT_ELIGIBILITY: Readonly<ContextEligibilityPolicy> = Object.freeze({
  allowPartialAssistantOutput: false,
  treatCompletedPlaybackAsEligible: false,
})

/**
 * Whether an assistant segment may appear in a later prompt (`26-…` §11.4).
 *
 * Everything not explicitly eligible is excluded. Generated-only, failed,
 * cancelled, interrupted, and unknown-after-crash output never counts as a
 * completed conversational turn (AC-023).
 */
export function isAssistantSegmentEligible(
  attempt: Pick<DeliveryAttempt, 'state' | 'transport' | 'evidence'>,
  policy: ContextEligibilityPolicy = STRICT_CONTEXT_ELIGIBILITY,
): boolean {
  switch (attempt.state) {
    case 'delivered':
      return true
    case 'unheard':
      return policy.treatCompletedPlaybackAsEligible
        && attempt.transport === 'discord_voice'
        && attempt.evidence.kind === 'localPlaybackCompleted'
    case 'partiallyDelivered':
      return policy.allowPartialAssistantOutput
    case 'reconciled':
      // Reconciliation records the true outcome in the evidence; a reconciled
      // attempt is eligible only when that evidence is a platform receipt.
      return attempt.evidence.kind === 'platformMessageId'
    case 'pending':
    case 'delivering':
    case 'failed':
    case 'interrupted':
    case 'unknownAfterCrash':
    case 'abandoned':
      return false
  }
}

/**
 * The text of a segment as it may enter context.
 *
 * A partially delivered segment contributes only its delivered prefix — never
 * the full generated text. Returning the whole string here would reintroduce
 * FIND-013 one layer up.
 */
export function eligibleSegmentText(
  segment: OutputSegment,
  attempt: Pick<DeliveryAttempt, 'state' | 'transport' | 'evidence'>,
  policy: ContextEligibilityPolicy = STRICT_CONTEXT_ELIGIBILITY,
): string | undefined {
  if (!isAssistantSegmentEligible(attempt, policy))
    return undefined

  if (attempt.state === 'partiallyDelivered' && attempt.evidence.kind === 'localPlaybackCompleted') {
    const characters = attempt.evidence.deliveredRange.characters
    return characters == null ? undefined : segment.text.slice(0, characters)
  }
  return segment.text
}
