/**
 * Generation attempts and snapshot evidence (IMP-107; ADR-007, ADR-015).
 *
 * A generation is "the bot produced words". It is emphatically not "the user
 * received words" — that is `delivery.ts`. Keeping them apart is what stops an
 * undelivered reply entering the next prompt as a completed turn
 * (FIND-012, FIND-013).
 */

import type { CharacterId, EventId, GenerationId, LogicalRoomId, RequestId, Timestamp } from './ids'

import { MemoryError } from './errors'

/** Lifecycle of one attempt to produce assistant content (`21-…` §13.3). */
export type GenerationState
  = | 'prepared'
    | 'running'
    | 'generated'
    | 'persisted'
    | 'failed'
    | 'cancelled'
    | 'superseded'

export const GENERATION_TRANSITIONS: Readonly<Record<GenerationState, readonly GenerationState[]>> = Object.freeze({
  prepared: Object.freeze(['running', 'cancelled', 'superseded'] as const),
  running: Object.freeze(['generated', 'failed', 'cancelled', 'superseded'] as const),
  generated: Object.freeze(['persisted', 'superseded'] as const),
  persisted: Object.freeze([] as const),
  failed: Object.freeze([] as const),
  cancelled: Object.freeze([] as const),
  superseded: Object.freeze([] as const),
})

/** States from which no further transition is possible. */
export const TERMINAL_GENERATION_STATES: readonly GenerationState[] = Object.freeze([
  'persisted',
  'failed',
  'cancelled',
  'superseded',
] as const)

/** True when `from -> to` is a legal generation transition. */
export function canTransitionGeneration(from: GenerationState, to: GenerationState): boolean {
  return GENERATION_TRANSITIONS[from].includes(to)
}

/** Move a generation's state, rejecting illegal moves. */
export function transitionGeneration(generationId: GenerationId, from: GenerationState, to: GenerationState): GenerationState {
  if (!canTransitionGeneration(from, to)) {
    throw new MemoryError('ILLEGAL_STATE_TRANSITION', `generation ${from} -> ${to} is not permitted`, {
      retryable: false,
      details: { generationId, from, to },
    })
  }
  return to
}

/**
 * What a generation actually saw when its context was assembled.
 *
 * This is *evidence*, not a lock. The names are chosen to make misuse read
 * badly: `observedRoomVersion` invites "what did it see", where an
 * `expectedRoomVersion` would invite "reject if it changed". ADR-015 exists
 * because the second reading loses valid responses whenever a second person
 * speaks mid-generation (SCN-006).
 */
export interface SnapshotEvidence {
  observedRoomVersion: number
  /** Exactly the events the prompt was built from, in prompt order. */
  observedEventIds: readonly EventId[]
  /** Digest of the assembled context, so a selection can be reproduced. */
  contextManifestHash: string
  /** Which binding generation the room resolution reflected. */
  observedBindingVersion: number
  capturedAt: Timestamp
}

/** Report of how far the room moved on while a generation was running. */
export interface SnapshotDivergence {
  diverged: boolean
  observedRoomVersion: number
  currentRoomVersion: number
  /** Operator-facing note recorded alongside the generation. */
  note: string
}

/**
 * Describe divergence between what a generation saw and the room now.
 *
 * Deliberately returns a report and never throws. Divergence is the normal
 * state of a busy voice channel; it is annotated, recorded, and then ignored
 * for commit purposes (ADR-015, TEST-DELIVERY-003).
 */
export function describeSnapshotDivergence(evidence: SnapshotEvidence, currentRoomVersion: number): SnapshotDivergence {
  const diverged = currentRoomVersion > evidence.observedRoomVersion
  return {
    diverged,
    observedRoomVersion: evidence.observedRoomVersion,
    currentRoomVersion,
    note: diverged
      ? `room advanced from ${evidence.observedRoomVersion} to ${currentRoomVersion} during generation; commit remains valid`
      : 'no concurrent append during generation',
  }
}

/**
 * Reasons a generation *may* be rejected at commit.
 *
 * The exhaustive list, per artifact 21 ADR-006: authorization or binding
 * changed underneath it, or a newer generation explicitly superseded it. A
 * plain concurrent append is not on this list and never will be.
 */
export type GenerationRejection = 'authorizationRevoked' | 'bindingInvalidated' | 'supersededByNewerGeneration'

/**
 * Decide whether a generated response may be committed.
 *
 * Takes the divergence report but does not consult `diverged` — that is the
 * point. The parameter is present so a reader can see it was considered and
 * deliberately not used as a rejection input.
 */
export function commitDecision(
  divergence: SnapshotDivergence,
  rejection?: GenerationRejection,
): { commit: boolean, reason: string } {
  if (rejection)
    return { commit: false, reason: rejection }
  return { commit: true, reason: divergence.note }
}

/** One attempt to produce assistant content. */
export interface GenerationAttempt {
  generationId: GenerationId
  idempotencyKey: RequestId
  logicalRoomId: LogicalRoomId
  characterId: CharacterId
  state: GenerationState
  evidence: SnapshotEvidence
  /** Provider + model + prompt version, so a reply can be attributed to a configuration. */
  modelRef: string
  startedAt: Timestamp
  completedAt?: Timestamp
}
