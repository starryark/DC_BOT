/**
 * Generation attempts and snapshot evidence (IMP-107; ADR-007, ADR-015).
 *
 * A generation is "the bot produced words". It is emphatically not "the user
 * received words" — that is `delivery.ts`. Keeping them apart is what stops an
 * undelivered reply entering the next prompt as a completed turn
 * (FIND-012, FIND-013).
 */

import type { DeliveryState } from './delivery'
import type { CharacterId, DeliveryId, EventId, GenerationId, LogicalRoomId, RequestId, SegmentId, Timestamp } from './ids'

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
  /** Every inbound event contributing to the complete prompt, including current inputs. */
  observedEventIds: readonly EventId[]
  /** Canonical digest of `contextManifest`, computed at the trusted persistence boundary. */
  contextManifestHash: string
  /** Content-free, durable-history selection used to build the memory block. */
  contextManifest: SnapshotContextManifest
  /** Which binding generation the room resolution reflected. */
  observedBindingVersion: number
  capturedAt: Timestamp
}

export const SNAPSHOT_CONTEXT_FORMAT_VERSION = 1 as const

/** One durable-history record selected for a model request. */
export type SnapshotContextItem
  = | { readonly sourceType: 'inbound', readonly eventId: EventId }
    | {
      readonly sourceType: 'assistant_output'
      readonly segmentId: SegmentId
      readonly deliveryId: DeliveryId
      readonly deliveryState: DeliveryState
      readonly deliveryStateAt: Timestamp
    }

/** Versioned, content-free description of the exact serialized memory block. */
export interface SnapshotContextManifest {
  readonly formatVersion: typeof SNAPSHOT_CONTEXT_FORMAT_VERSION
  readonly logicalRoomVersion: number
  readonly bindingRevision: number
  readonly maxItems: number
  readonly maxCharacters: number
  readonly candidateReadLimit: number
  readonly truncated: boolean
  readonly items: readonly SnapshotContextItem[]
}

function natural(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new MemoryError('POLICY_VIOLATION', `${field} must be a non-negative safe integer`)
  return value as number
}

/** Serializes snapshot evidence with fixed keys and item order; content is never included. */
export function serializeSnapshotContextManifest(manifest: SnapshotContextManifest): string {
  if (manifest.formatVersion !== SNAPSHOT_CONTEXT_FORMAT_VERSION)
    throw new MemoryError('POLICY_VIOLATION', 'unknown snapshot context manifest format')
  const items = manifest.items.map((item) => {
    if (item.sourceType === 'inbound') {
      if (!item.eventId)
        throw new MemoryError('POLICY_VIOLATION', 'inbound snapshot item requires eventId')
      return { sourceType: 'inbound', eventId: item.eventId }
    }
    if (item.sourceType === 'assistant_output') {
      if (!item.segmentId || !item.deliveryId || !item.deliveryState || !item.deliveryStateAt)
        throw new MemoryError('POLICY_VIOLATION', 'assistant snapshot item is incomplete')
      return { sourceType: 'assistant_output', segmentId: item.segmentId, deliveryId: item.deliveryId, deliveryState: item.deliveryState, deliveryStateAt: item.deliveryStateAt }
    }
    throw new MemoryError('POLICY_VIOLATION', 'unknown snapshot context source type')
  })
  return JSON.stringify({
    formatVersion: manifest.formatVersion,
    logicalRoomVersion: natural(manifest.logicalRoomVersion, 'logicalRoomVersion'),
    bindingRevision: natural(manifest.bindingRevision, 'bindingRevision'),
    maxItems: natural(manifest.maxItems, 'maxItems'),
    maxCharacters: natural(manifest.maxCharacters, 'maxCharacters'),
    candidateReadLimit: natural(manifest.candidateReadLimit, 'candidateReadLimit'),
    truncated: manifest.truncated,
    items,
  })
}

/** SHA-256 of the canonical snapshot-manifest bytes. */
export function digestSnapshotContextManifest(manifest: SnapshotContextManifest): string {
  const bytes = new TextEncoder().encode(serializeSnapshotContextManifest(manifest))
  const bitLength = bytes.length * 8
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64
  const padded = new Uint8Array(paddedLength)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  new DataView(padded.buffer).setUint32(paddedLength - 4, bitLength, false)
  const state = new Uint32Array([0x6A09E667, 0xBB67AE85, 0x3C6EF372, 0xA54FF53A, 0x510E527F, 0x9B05688C, 0x1F83D9AB, 0x5BE0CD19])
  const constants = new Uint32Array([0x428A2F98, 0x71374491, 0xB5C0FBCF, 0xE9B5DBA5, 0x3956C25B, 0x59F111F1, 0x923F82A4, 0xAB1C5ED5, 0xD807AA98, 0x12835B01, 0x243185BE, 0x550C7DC3, 0x72BE5D74, 0x80DEB1FE, 0x9BDC06A7, 0xC19BF174, 0xE49B69C1, 0xEFBE4786, 0x0FC19DC6, 0x240CA1CC, 0x2DE92C6F, 0x4A7484AA, 0x5CB0A9DC, 0x76F988DA, 0x983E5152, 0xA831C66D, 0xB00327C8, 0xBF597FC7, 0xC6E00BF3, 0xD5A79147, 0x06CA6351, 0x14292967, 0x27B70A85, 0x2E1B2138, 0x4D2C6DFC, 0x53380D13, 0x650A7354, 0x766A0ABB, 0x81C2C92E, 0x92722C85, 0xA2BFE8A1, 0xA81A664B, 0xC24B8B70, 0xC76C51A3, 0xD192E819, 0xD6990624, 0xF40E3585, 0x106AA070, 0x19A4C116, 0x1E376C08, 0x2748774C, 0x34B0BCB5, 0x391C0CB3, 0x4ED8AA4A, 0x5B9CCA4F, 0x682E6FF3, 0x748F82EE, 0x78A5636F, 0x84C87814, 0x8CC70208, 0x90BEFFFA, 0xA4506CEB, 0xBEF9A3F7, 0xC67178F2])
  const rotate = (value: number, amount: number): number => (value >>> amount) | (value << (32 - amount))
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(64)
    const view = new DataView(padded.buffer, offset, 64)
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4, false)
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15]!
      const b = words[index - 2]!
      words[index] = (words[index - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[index - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = state
    for (let index = 0; index < 64; index++) {
      const t1 = (h! + (rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + constants[index]! + words[index]!) >>> 0
      const t2 = ((rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0
      // One SHA-256 round shifts every working variable at once (FIPS 180-4
      // §6.2.2 step 4). Splitting it across lines would obscure that these are
      // simultaneous assignments, not a sequence.
      // eslint-disable-next-line style/max-statements-per-line
      h = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) state[index] = (state[index]! + value!) >>> 0
  }
  return [...state].map(value => value.toString(16).padStart(8, '0')).join('')
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
