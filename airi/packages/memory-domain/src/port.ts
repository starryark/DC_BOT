/**
 * The MemoryPort — the single durable memory authority (IMP-101; ADR-002).
 *
 * Thirteen operations, transport-neutral, expressed only in domain types.
 * `discord.js`, SQLite, HTTP, and model-provider types are adapter concerns and
 * must not appear in this file (AC-003, enforced by `boundaries.test.ts`).
 *
 * Contract shape follows `artifacts/09-memory-port-api-spec.md` §10.4/§11.1.
 * Where that artifact says "draft", this contract says "generation": the same
 * entity, named for what it is rather than what it is not yet.
 *
 * Call stack:
 *
 * Discord text/voice adapter
 *   -> {@link MemoryPort}
 *     -> in-process application service (IMP-2xx)
 *       -> MemoryRepository SPI (memory-sqlite)
 */

import type { AddressResolution, OpaquePersonTable } from './addressing'
import type { AliasRecord, CallingScope } from './aliases'
import type { AuthorizationContext, Scope } from './authorization'
import type { Capability, CapabilityAdvertisement, RetrievalMode } from './capabilities'
import type { CausalEdge, CauseDeclaration } from './causality'
import type { CorrectionResult, IntentDeclaration } from './corrections'
import type { DeliveryAttempt, DeliveryTransition, DeliveryTransport, OutputSegment } from './delivery'
import type { AppendEventInput, InboundEventEnvelope } from './events'
import type { GenerationAttempt, SnapshotEvidence } from './generation'
import type { ActorSnapshot, AttributedActor, CurrentPresentation } from './identity'
import type {
  CharacterId,
  DeliveryId,
  EventId,
  GenerationId,
  GovernanceId,
  LogicalRoomId,
  PersonId,
  RequestId,
  SegmentId,
  Timestamp,
} from './ids'
import type { MemoryLayer, MemoryRecord, SemanticFact } from './memory-records'
import type { PhysicalLocation, RoomBinding, RoomResolution } from './rooms'

/**
 * Whether a write reached durable storage.
 *
 * `spooled` exists so that "we will write this later" can never be reported as
 * "we wrote this". A caller receiving `spooled` must not tell the user anything
 * was remembered (ADR-016, `09-…` §10.6 F-1).
 */
export type WriteDurability = 'durable' | 'spooled'

/** Common envelope for every write result. */
export interface WriteResult<T> {
  value: T
  durability: WriteDurability
}

// --- OP-01 resolveRoom -------------------------------------------------------

export interface ResolveRoomCommand {
  location: PhysicalLocation
  characterId: CharacterId
}

// --- OP-02 observeActor ------------------------------------------------------

export interface ObserveActorInput {
  snapshot: ActorSnapshot
  /** Skip the projection write when nothing material changed (RISK-G). */
  throttleUnchanged: boolean
}

export interface ObserveActorOutput {
  actor: AttributedActor
  presentation: CurrentPresentation
  /** Empty when the observation matched the stored projection. */
  changedFields: readonly string[]
}

// --- OP-03 appendEvent -------------------------------------------------------

export interface AppendEventOutput {
  envelope: InboundEventEnvelope
  /** True when an earlier append with the same idempotency key already existed. */
  deduplicated: boolean
}

// --- OP-04 beginGeneration ---------------------------------------------------

export interface BeginGenerationInput {
  idempotencyKey: RequestId
  logicalRoomId: LogicalRoomId
  characterId: CharacterId
  /** At least one `trigger` required; this is the many-to-many edge set (ADR-014). */
  causes: readonly CauseDeclaration[]
  evidence: SnapshotEvidence
  modelRef: string
  startedAt: Timestamp
}

export interface BeginGenerationOutput {
  generation: GenerationAttempt
  edges: readonly CausalEdge[]
}

// --- OP-05 recordDelivery ----------------------------------------------------

export interface AppendSegmentsInput {
  generationId: GenerationId
  segments: readonly Omit<OutputSegment, 'generationId'>[]
}

export interface BeginDeliveryInput {
  segmentId: SegmentId
  transport: DeliveryTransport
  destinationId: string
  idempotencyKey: RequestId
  startedAt: Timestamp
}

// --- OP-06 assembleContext ---------------------------------------------------

export interface AssembleContextInput {
  logicalRoomId: LogicalRoomId
  /** The generation this context is for, when assembling for one. */
  forGenerationId?: GenerationId
  maxEvents: number
  maxCharacters: number
  includeLayers: readonly MemoryLayer[]
  callingScope: CallingScope
  /** Read the room as it was at this version, for reproducing a selection. */
  asOfRoomVersion?: number
}

/** One item chosen for a prompt, with the trace that justifies it. */
export interface SelectedContextItem {
  layer: MemoryLayer
  /** Opaque handle of the person this item is attributed to, if any. */
  personRef?: string
  /** The text as it will be serialized. Already normalized, never yet escaped. */
  text: string
  occurredAt: Timestamp
  /** Which authorization decision admitted this item. */
  admittedBy: Scope
  /** Why the selector kept it, for the reproducible manifest. */
  selectionReason: string
}

/**
 * The assembled context.
 *
 * `sentinel` is the honest empty case: when the durable authority is
 * unavailable the caller gets `noDurableContext`, not an empty item list that
 * looks like "nothing was ever said" (`09-…` §10.6).
 */
export interface ContextSelection {
  sentinel: 'ok' | 'noDurableContext'
  roomVersion: number
  items: readonly SelectedContextItem[]
  personTable: OpaquePersonTable
  /** Digest of the selection, recorded on the generation as evidence. */
  manifestHash: string
  /** Set when a requested layer was unavailable and was omitted rather than faked. */
  degraded: boolean
  omittedLayers: readonly MemoryLayer[]
}

// --- OP-07 searchMemory ------------------------------------------------------

export interface SearchMemoryInput {
  query: string
  scope: Scope
  layers: readonly MemoryLayer[]
  modes: readonly RetrievalMode[]
  since?: Timestamp
  until?: Timestamp
  limit: number
  cursor?: string
}

export interface MemoryHit {
  record: MemoryRecord
  /** Which mode produced this hit, for per-mode evaluation. */
  mode: RetrievalMode
  /** Deterministic rank features, exposed so ranking can be benchmarked (REQ-EVAL-002). */
  features: Readonly<Record<string, number>>
}

export interface SearchMemoryOutput {
  hits: readonly MemoryHit[]
  nextCursor?: string
  appliedModes: readonly RetrievalMode[]
  /**
   * Set when the pipeline declined to answer rather than guessing: no
   * authorized evidence, contradictory evidence, or evidence below the
   * confidence floor (REQ-RETRIEVAL-005, TEST-ABSTAIN-001).
   */
  abstained?: 'noAuthorizedEvidence' | 'contradictory' | 'belowConfidence' | 'stale'
}

// --- OP-11/12 export and governance -----------------------------------------

export interface ExportSelector {
  personId: PersonId
  includeLayers: readonly MemoryLayer[]
  since?: Timestamp
  until?: Timestamp
}

export interface ExportRecord {
  layer: MemoryLayer
  payload: Readonly<Record<string, unknown>>
}

export type DeletionAction = 'redact' | 'tombstone' | 'purge'

export interface DeletionSelector {
  targetKind: 'person' | 'event' | 'fact' | 'alias' | 'room'
  targetRef: string
  action: DeletionAction
  /** Required for `purge`; the operator authority and its legal basis. */
  governance?: { authority: string, legalBasis: string }
  reason: string
}

/**
 * What a deletion would touch, produced before anything is destroyed.
 *
 * Plan-then-execute exists because both failure directions are real: an
 * incomplete deletion leaves derived copies, and an over-broad one destroys a
 * third party's data (RISK-044). The plan is the reviewable artifact.
 */
export interface DeletionPlan {
  planId: GovernanceId
  selector: DeletionSelector
  eventIds: readonly EventId[]
  factIds: readonly string[]
  summaryIds: readonly string[]
  /** Storage classes that must be invalidated: caches, indexes, embeddings. */
  derivedStores: readonly string[]
  /** Generations whose derived data must be recomputed (SCN-037). */
  affectedGenerations: readonly GenerationId[]
}

export interface DeletionReport {
  planId: GovernanceId
  executedAt: Timestamp
  /** Per-storage-class counts, so completeness can be audited. */
  affected: Readonly<Record<string, number>>
  /** Non-empty means the deletion is not complete (`26-…` §11.6). */
  unresolvedObligations: readonly string[]
}

// --- OP-13 health ------------------------------------------------------------

export interface MemoryHealth {
  status: 'healthy' | 'degraded' | 'readOnly' | 'unavailable'
  advertisement: CapabilityAdvertisement
  /** Writes waiting to be applied. Non-zero means writes are not yet durable. */
  pendingSpoolDepth: number
  pendingReconciliation: number
}

/**
 * The only durable memory authority for Discord text and voice.
 *
 * Every method takes an {@link AuthorizationContext}. There is no unauthorized
 * overload and no "internal" variant: an operation with no context denies
 * (REQ-RETRIEVAL-001, FIND-011).
 */
export interface MemoryPort {
  /** Contract version. A breaking change increments the major component. */
  readonly contractVersion: string

  // -- Rooms and identity
  resolveRoom: (auth: AuthorizationContext, input: ResolveRoomCommand) => Promise<RoomResolution>
  bindRooms: (auth: AuthorizationContext, binding: RoomBinding) => Promise<WriteResult<RoomBinding>>
  unbindRooms: (auth: AuthorizationContext, bindingId: string, reason: string) => Promise<WriteResult<void>>
  observeActor: (auth: AuthorizationContext, input: ObserveActorInput) => Promise<WriteResult<ObserveActorOutput>>
  resolvePreferredAddress: (auth: AuthorizationContext, personId: PersonId, callingScope: CallingScope) => Promise<AddressResolution>

  // -- Events and causality
  appendEvent: (auth: AuthorizationContext, input: AppendEventInput) => Promise<WriteResult<AppendEventOutput>>

  // -- Generation and delivery
  beginGeneration: (auth: AuthorizationContext, input: BeginGenerationInput) => Promise<WriteResult<BeginGenerationOutput>>
  appendOutputSegments: (auth: AuthorizationContext, input: AppendSegmentsInput) => Promise<WriteResult<readonly OutputSegment[]>>
  beginDelivery: (auth: AuthorizationContext, input: BeginDeliveryInput) => Promise<WriteResult<DeliveryAttempt>>
  transitionDelivery: (auth: AuthorizationContext, transition: DeliveryTransition) => Promise<WriteResult<DeliveryAttempt>>

  // -- Context and retrieval
  assembleContext: (auth: AuthorizationContext, input: AssembleContextInput) => Promise<ContextSelection>
  searchMemory: (auth: AuthorizationContext, input: SearchMemoryInput) => Promise<SearchMemoryOutput>

  // -- Memory intents and lifecycle
  recordIntent: (auth: AuthorizationContext, declaration: IntentDeclaration) => Promise<WriteResult<SemanticFact>>
  correctFact: (auth: AuthorizationContext, factId: string, value: string, at: Timestamp) => Promise<WriteResult<CorrectionResult>>
  planDeletion: (auth: AuthorizationContext, selector: DeletionSelector) => Promise<DeletionPlan>
  executeDeletion: (auth: AuthorizationContext, planId: GovernanceId) => Promise<DeletionReport>
  exportPerson: (auth: AuthorizationContext, selector: ExportSelector) => AsyncIterable<ExportRecord>

  // -- Operational
  getHealth: () => Promise<MemoryHealth>
}

/** The contract version this package publishes. */
export const MEMORY_PORT_CONTRACT_VERSION = '1.0.0'

/**
 * Operations, in the order the retrieval pipeline is allowed to run them
 * (ADR-011, REQ-RETRIEVAL-002).
 *
 * Exported so the pipeline's own tests can assert the order rather than
 * restating it, and so a reviewer can see that vector retrieval is last and
 * gated rather than woven in.
 */
export const RETRIEVAL_STAGE_ORDER: readonly RetrievalMode[] = Object.freeze([
  'structured',
  'lexical',
  'vector',
  'graph',
])

/** Capabilities every conforming milestone-1 backend must advertise. */
export const REQUIRED_M1_CAPABILITIES: readonly Capability[] = Object.freeze([
  'durable_events',
  'alias_support',
  'export',
  'deletion',
])

/** Aliases returned by an adapter, re-exported for repository conformance suites. */
export type AliasView = readonly AliasRecord[]
/** Delivery ids used by the reconciliation worker. */
export type ReconciliationTarget = DeliveryId
