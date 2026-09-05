import type { DatabaseSync } from 'node:sqlite'

import type {
  AttributedActor,
  AuthorizationContext,
  CharacterId,
  DeliveryState,
  DeliveryTransport,
  EventActor,
  GenerationAttempt,
  InboundEventKind,
  LogicalRoomId,
  PhysicalLocation,
  PhysicalRoomId,
  RetentionClass,
  SearchMemoryInput,
  SearchMemoryOutput,
  SegmentId,
  SnapshotContextItem,
  Timestamp,
} from '@proj-airi/memory-domain'

import type { MemoryRuntime } from '../../src/memory/runtime'

import { Buffer } from 'node:buffer'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { asCharacterId, asRequestId, asSegmentId, asTimestamp } from '@proj-airi/memory-domain'
import { openReadOnlySqliteDatabase } from '@proj-airi/memory-sqlite'

import { ACTIVE_V1_VERSION } from './dataset'

/**
 * Isolated production-runtime adapter for the G8-1 evaluator (IMP-802, T002).
 *
 * This adapter is the only approved way the evaluator touches the memory
 * runtime. It wraps {@link createMemoryRuntime} and enforces the isolation
 * rules that make a deterministic, content-free run possible:
 *
 * - one temporary parent root per evaluator run, one child root per scenario;
 * - `configuredRoot` is always passed explicitly, never defaulted;
 * - the operational authority (`.local/memory`) is never opened;
 * - a scenario root may never live inside the repository checkout;
 * - resolved authority and backup paths must stay inside the scenario root;
 * - the runtime is closed in `finally` on every success and failure path;
 * - scenario roots are removed after capture unless the caller keeps them.
 *
 * The adapter exposes only typed scenario operations and returns
 * content-minimized observations. The one repository-read escape hatch
 * (`inspectRepository`) is separately named, labelled `implementation_specific`,
 * and is never the sole proof of public behaviour.
 */

/** A redactor for diagnostics; run-scoped, never published. */
export type DiagnosticRedactor = (kind: string, rawId: string) => string

/** Options for creating a per-run parent root. */
export interface AdapterRunOptions {
  /** Repository checkout root, used only to refuse roots inside it. */
  readonly repoRoot: string
  /**
   * Directory the caller has already chosen for private run output, outside the
   * checkout. The parent root is created as a sibling child of the OS temp dir
   * unless the caller passes {@link explicitParentRoot}.
   */
  readonly explicitParentRoot?: string
  /** When true, scenario roots are retained for debugging. */
  readonly keepRunRoot?: boolean
}

/** Owns the per-run parent root and a run-scoped redaction key. */
export interface EvaluationRuntimeRun {
  readonly parentRoot: string
  readonly repoRoot: string
  readonly keepRunRoot: boolean
  /** A redaction key generated for this run; never written to reports. */
  readonly redactionKey: string
  /** Create and open a fresh, isolated scenario runtime. */
  openScenario: (options: ScenarioOpenOptions) => Promise<ScenarioRuntime>
}

/** The synthetic binding a scenario installs in its isolated root. */
export interface ScenarioBindingSpec {
  readonly bindingId: string
  readonly characterId: CharacterId
  readonly locations: readonly (PhysicalLocation & { guildId: string })[]
}

/** Options for opening one scenario runtime. */
export interface ScenarioOpenOptions {
  /** A short, content-free scenario label used to name the child root. */
  readonly scenarioLabel: string
  /** The character the runtime owns. */
  readonly characterId: CharacterId
  /** Optional synthetic bindings to write before the runtime starts. */
  readonly bindings?: readonly ScenarioBindingSpec[]
  /**
   * When true, reopen an existing scenario root (restart) instead of creating a
   * new one. The caller supplies the previously resolved root.
   */
  readonly reopenRoot?: string
}

/** Content-minimized observation of an ingress resolution. */
export interface ResolvedActorObservation {
  readonly actorKind: 'attributed' | 'anonymous'
  readonly personId: string
  readonly roomKind: 'isolated' | 'bound'
  readonly logicalRoomId: LogicalRoomId
  readonly physicalRoomId: PhysicalRoomId
  readonly bindingVersion: number
  /** HMAC of the durable identity key, so person identity can be compared without exposure. */
  readonly identityDigest: string
}

/** Content-minimized observation of an appended event. */
export interface AppendedEventObservation {
  readonly eventId: string
  readonly deduplicated: boolean
  readonly logicalRoomId: LogicalRoomId
  readonly roomVersion: number | undefined
}

/** Content-minimized observation of a begun generation. */
export interface BegunGenerationObservation {
  readonly generationId: string
  readonly deduplicated: boolean
  readonly state: string
  readonly logicalRoomId: LogicalRoomId
  readonly causeEventIds: readonly string[]
}

/** Content-minimized observation of a begun delivery. */
export interface BegunDeliveryObservation {
  readonly deliveryId: string
  readonly segmentId: SegmentId
  readonly state: DeliveryState
}

/** Content-minimized observation of an assembled context manifest. */
export interface ContextManifestObservation {
  readonly sentinel: 'ok' | 'noDurableContext'
  readonly selected: readonly SnapshotContextItem[]
  readonly truncated: boolean
  readonly includedItems: number
  readonly logicalRoomVersion: number
  readonly bindingRevision: number
  readonly text: string
}

/** One isolated scenario runtime plus its typed operation surface. */
export interface ScenarioRuntime {
  readonly root: string
  readonly characterId: CharacterId
  /** Resolved authority path, asserted to stay inside the scenario root. */
  readonly authorityPath: string
  /** Authorization for ingress (identity:observe, room:read). */
  ingressAuthorizationFor: (scope: AuthorizationScope) => AuthorizationContext
  /** Authorization for durable trace writes within a logical room. */
  traceAuthorizationFor: (room: LogicalRoomId) => AuthorizationContext
  /** Authorization for context reads within a logical room. */
  contextAuthorizationFor: (room: LogicalRoomId) => AuthorizationContext
  /** Resolve an ingress actor and room. */
  resolveIngress: (input: ResolveIngressInput) => Promise<ResolvedActorObservation>
  /** Append one inbound event. */
  appendEvent: (input: AppendEventInput) => Promise<AppendedEventObservation>
  /** Begin a generation; returns deduplicated state and the cause set. */
  beginGeneration: (input: BeginGenerationInput) => Promise<BegunGenerationObservation>
  /** Transition a generation to a new state. */
  transitionGeneration: (authorization: AuthorizationContext, generation: GenerationRef, from: string, to: string, at: Timestamp) => Promise<{ state: string }>
  /** Append output segments to a generation. */
  appendSegments: (authorization: AuthorizationContext, generation: GenerationRef, segments: readonly SegmentSpec[]) => Promise<readonly SegmentId[]>
  /** Begin a delivery attempt for a segment. */
  beginDelivery: (input: BeginDeliveryInput) => Promise<BegunDeliveryObservation>
  /** Transition a delivery to a new state. */
  transitionDelivery: (authorization: AuthorizationContext, deliveryId: string, from: DeliveryState, to: DeliveryState, evidence: DeliveryEvidenceInput, at: Timestamp) => Promise<{ state: DeliveryState }>
  /** Assemble the bounded recent context for a room. */
  assembleRecent: (input: AssembleRecentInput) => Promise<ContextManifestObservation>
  /** Search through the production context authority. */
  searchMemory: (authorization: AuthorizationContext, input: SearchMemoryInput) => Promise<SearchMemoryOutput>
  /** Run a privacy operation (status/show/export/remember/correct/forget). */
  privacy: (input: PrivacyOperationInput) => Promise<PrivacyOperationObservation>
  /**
   * Read-only repository inspection, labelled implementation-specific.
   *
   * Used only for postconditions that cannot be observed through the public
   * authorities. Never the sole proof of public behaviour.
   */
  inspectRepository: <T>(read: (reader: RepositoryInspector) => T) => T
  /** Close the runtime. Safe to call once. */
  close: () => Promise<void>
}

/** The authorization scope an ingress resolution runs under. */
export interface AuthorizationScope {
  readonly kind: 'guild' | 'dm'
  readonly id: string
}

/** Input for {@link ScenarioRuntime.resolveIngress}. */
export interface ResolveIngressInput {
  readonly scope: AuthorizationScope
  readonly location: PhysicalLocation
  readonly platformUserId: string
  readonly displayNameAtEvent: string
  readonly observedAt: Timestamp
  readonly username?: string
  readonly globalName?: string
  readonly guildNickname?: string
  readonly guildId?: string
  readonly observationKey: string
}

/** Input for {@link ScenarioRuntime.appendEvent}. */
export interface AppendEventInput {
  readonly authorization: AuthorizationContext
  readonly actor: EventActor
  readonly idempotencyKey: string
  readonly kind: InboundEventKind
  readonly logicalRoomId: LogicalRoomId
  readonly physicalRoomId: PhysicalRoomId
  readonly occurredAt: Timestamp
  readonly content: string
  readonly retentionClass: RetentionClass
}

/** Input for {@link ScenarioRuntime.beginGeneration}. */
export interface BeginGenerationInput {
  readonly authorization: AuthorizationContext
  readonly idempotencyKey: string
  readonly logicalRoomId: LogicalRoomId
  readonly causes: readonly { inboundEventId: string, role: 'trigger' | 'context' | 'correction' | 'operator' }[]
  readonly observedEventIds: readonly string[]
  readonly roomVersion: number
  readonly bindingRevision: number
  readonly startedAt: Timestamp
}

/** A minimal reference to a generation the runtime already knows. */
export interface GenerationRef {
  readonly generationId: string
  readonly logicalRoomId: LogicalRoomId
  readonly characterId: CharacterId
  readonly state: string
}

/** One output segment to append. */
export interface SegmentSpec {
  readonly segmentId: string
  readonly ordinal: number
  readonly modality: 'text' | 'voice'
  readonly text: string
}

/** Input for {@link ScenarioRuntime.beginDelivery}. */
export interface BeginDeliveryInput {
  readonly authorization: AuthorizationContext
  readonly segmentId: SegmentId
  readonly transport: DeliveryTransport
  readonly destinationId: string
  readonly idempotencyKey: string
  readonly startedAt: Timestamp
}

/** Evidence for a delivery transition. */
export type DeliveryEvidenceInput
  = | { kind: 'platformMessageId', platformMessageId: string }
    | { kind: 'localPlaybackCompleted', deliveredRange?: { characters?: number, playedMs?: number } }
    | { kind: 'transportError', errorClass: string }
    | { kind: 'none' }

/** Input for {@link ScenarioRuntime.assembleRecent}. */
export interface AssembleRecentInput {
  readonly authorization: AuthorizationContext
  readonly logicalRoomId: LogicalRoomId
  readonly physicalRoomId: PhysicalRoomId
  readonly maxItems: number
  readonly maxCharacters: number
}

/** Input for {@link ScenarioRuntime.privacy}. */
export interface PrivacyOperationInput {
  readonly requestId: string
  readonly operation:
    | { kind: 'status' }
    | { kind: 'show' }
    | { kind: 'export' }
    | { kind: 'remember', predicate: string, value: string }
    | { kind: 'correct', factId: string, value: string }
    | { kind: 'forget' }
  readonly scope: AuthorizationScope
  readonly location: PhysicalLocation
  readonly platformUserId: string
  readonly discordUserId: string
  readonly guildId?: string
  readonly channelId: string
  readonly channelKind: 'dm' | 'guildText' | 'thread'
  readonly displayNameAtEvent: string
  readonly observedAt: number
}

/** Content-minimized privacy-operation observation. */
export interface PrivacyOperationObservation {
  readonly operationId: string
  readonly code?: 'capability_disabled'
  /** Fact count exposed by status; content-free. */
  readonly events?: number
  readonly facts?: number
  /** Export facts count and whether the attachment was produced. */
  readonly exportFactCount?: number
  readonly hasAttachment?: boolean
}

/**
 * Read-only access to the scenario's authority for implementation-specific
 * postconditions. The database is opened read-only and never mutated.
 */
export interface RepositoryInspector {
  readonly database: DatabaseSync
  readonly authorityPath: string
}

/** True when `target` is `repoRoot` or lives inside it (cross-drive safe). */
export function isInsideRepository(repoRoot: string, target: string): boolean {
  const step = relative(resolve(repoRoot), resolve(target))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

/** True when `target` is `parent` or lives inside it. */
function isInsidePath(parent: string, target: string): boolean {
  const rel = relative(resolve(parent), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Arms a per-run parent root outside the checkout.
 *
 * The parent root holds one child root per scenario. It is created under the OS
 * temp directory by default so it is isolated from both the checkout and the
 * operational `.local/memory` authority, and removed on run completion unless
 * {@link AdapterRunOptions.keepRunRoot} is set.
 */
export function startEvaluationRun(options: AdapterRunOptions): EvaluationRuntimeRun {
  const repoRoot = resolve(options.repoRoot)
  const parentRoot = options.explicitParentRoot
    ? resolve(options.explicitParentRoot)
    : mkdtempSync(join(tmpdir(), `g8-eval-${ACTIVE_V1_VERSION}-`))
  if (isInsideRepository(repoRoot, parentRoot))
    throw new Error(`Refusing to start evaluation run: parent root ${parentRoot} is inside the repository checkout`)
  if (!existsSync(parentRoot))
    throw new Error(`Refusing to start evaluation run: parent root ${parentRoot} does not exist`)

  return {
    parentRoot,
    repoRoot,
    keepRunRoot: options.keepRunRoot ?? false,
    redactionKey: randomBytes(32).toString('hex'),
    openScenario: scenarioOptions => openScenarioRuntime({ ...scenarioOptions, run: { parentRoot, repoRoot, keepRunRoot: options.keepRunRoot ?? false } }),
  }
}

/**
 * Remove the parent root and every scenario root it holds.
 *
 * On Windows the OS may still hold a just-closed SQLite WAL/SHM file briefly
 * after `close()` returns, so a recursive `rmSync` can race with the handle
 * release and throw EPERM. Removal is retried with a short backoff; a residual
 * temp directory is not a correctness issue (the operational authority is never
 * touched), so a persistent failure is swallowed rather than failing the run.
 */
export function disposeEvaluationRun(run: EvaluationRuntimeRun): void {
  if (run.keepRunRoot)
    return
  removeWithRetry(run.parentRoot)
}

/** Retry a recursive removal to tolerate transient Windows file-handle locks. */
function removeWithRetry(target: string): void {
  if (!existsSync(target))
    return
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      rmSync(target, { recursive: true, force: true })
      return
    }
    catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: string }).code : undefined
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY')
        throw error
      // Back off before the next attempt; the final attempt also sleeps so the
      // OS has a chance to release the handle before we give up.
      const delay = 30 * 2 ** attempt
      const start = Date.now()
      while (Date.now() - start < delay) {
        // synchronous backoff; the delays are tens of milliseconds
      }
    }
  }
  // Best effort: if it still exists, leave it. The parent root lives in the OS
  // temp directory and never touches the operational authority or the checkout.
}

/** Tolerant removal for callers that need to clean up a run root directly. */
export function removeRunRoot(target: string): void {
  removeWithRetry(target)
}

interface OpenScenarioArgs extends ScenarioOpenOptions {
  readonly run: { readonly parentRoot: string, readonly repoRoot: string, readonly keepRunRoot: boolean }
}

/**
 * Create, open, and guard one isolated scenario runtime.
 *
 * The scenario root is a fresh child of the parent root (or the supplied
 * `reopenRoot` for restart scenarios). A synthetic binding file is written
 * inside the root before the runtime starts, so the production binding
 * reconciliation path is exercised without touching the operational authority.
 */
export async function openScenarioRuntime(args: OpenScenarioArgs): Promise<ScenarioRuntime> {
  const repoRoot = resolve(args.run.repoRoot)
  const characterId = args.characterId
  const root = args.reopenRoot
    ? resolve(args.reopenRoot)
    : mkdtempSync(join(args.run.parentRoot, `${args.scenarioLabel}-`))

  if (isInsideRepository(repoRoot, root))
    throw new Error(`Refusing to open scenario root inside the repository checkout: ${root}`)
  if (root === repoRoot)
    throw new Error('Refusing to open a scenario root equal to the repository checkout')

  // The binding file must live inside the scenario root, never the operational one.
  const bindingFile = join(root, 'room-bindings.json')
  if (!args.reopenRoot)
    writeBindingFile(bindingFile, args.characterId, args.bindings ?? [])

  // Defer the import so the adapter module stays statically free of the runtime
  // graph until a scenario actually opens. `createMemoryRuntime` is the approved
  // production entry point (T002 implementation boundary).
  const { createMemoryRuntime } = await import('../../src/memory/runtime')
  const { memoryCharacterIdOf } = await import('../../src/memory/runtime')
  const { MEMORY_FLAGS_ALL_OFF } = await import('../../src/memory/feature-flags')
  void memoryCharacterIdOf

  const activeFlags = {
    ...MEMORY_FLAGS_ALL_OFF,
    durableEvents: true,
    actorSnapshots: true,
    roomBindings: true,
    sharedRecentContext: true,
    deliveryLifecycle: true,
    fulltextRetrieval: true,
  }

  const runtime: MemoryRuntime = createMemoryRuntime({
    mode: 'active',
    flags: activeFlags,
    repoRoot,
    configuredRoot: root,
    characterId,
    bindingFile: args.bindings && args.bindings.length > 0 ? bindingFile : undefined,
  })

  if (runtime.health.mode !== 'active' || runtime.health.status !== 'healthy')
    throw new Error(`Scenario runtime did not open healthy in active mode: ${runtime.health.mode}/${runtime.health.status}`)

  const authorityPath = runtime.health.authority!
  if (!isInsidePath(root, authorityPath))
    throw new Error(`Resolved authority ${authorityPath} escapes the scenario root ${root}`)
  if (runtime.health.backups && !isInsidePath(root, runtime.health.backups))
    throw new Error(`Resolved backups path escapes the scenario root ${root}`)

  return buildScenarioSurface(runtime, root, characterId, authorityPath)
}

/** Writes a synthetic binding file inside the scenario root. */
function writeBindingFile(path: string, characterId: CharacterId, bindings: readonly ScenarioBindingSpec[]): void {
  const file = {
    version: 1 as const,
    bindings: bindings.map(binding => ({
      id: binding.bindingId,
      characterId: binding.characterId.toString(),
      locations: binding.locations.map((location) => {
        const base = { kind: location.channelKind, guildId: location.guildId, channelId: location.channelId }
        return base
      }),
    })),
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  void characterId
}

function buildScenarioSurface(runtime: MemoryRuntime, root: string, characterId: CharacterId, authorityPath: string): ScenarioRuntime {
  const assertTrace = (): NonNullable<MemoryRuntime['trace']> => {
    if (!runtime.trace)
      throw new Error('Scenario runtime has no trace authority')
    return runtime.trace
  }
  const assertIngress = (): NonNullable<MemoryRuntime['ingress']> => {
    if (!runtime.ingress)
      throw new Error('Scenario runtime has no ingress authority')
    return runtime.ingress
  }
  const assertContext = (): NonNullable<MemoryRuntime['context']> => {
    if (!runtime.context)
      throw new Error('Scenario runtime has no context authority')
    return runtime.context
  }
  const assertPrivacy = (): NonNullable<MemoryRuntime['privacy']> => {
    if (!runtime.privacy)
      throw new Error('Scenario runtime has no privacy authority')
    return runtime.privacy
  }

  return {
    root,
    characterId,
    authorityPath,
    ingressAuthorizationFor: scope => ingressAuthorization(scope, characterId),
    traceAuthorizationFor: room => roomAuthorization(room, characterId),
    contextAuthorizationFor: room => roomAuthorization(room, characterId),
    resolveIngress: async (input) => {
      const actorEvidence = {
        kind: 'attributed' as const,
        snapshot: {
          platform: 'discord' as const,
          platformUserId: input.platformUserId,
          username: input.username,
          globalName: input.globalName,
          guildNickname: input.guildNickname,
          displayNameAtEvent: input.displayNameAtEvent,
          guildId: input.guildId,
          observedAt: input.observedAt,
          source: 'gateway' as const,
        },
      }
      const authorization = ingressAuthorization(input.scope, characterId)
      const resolved = await assertIngress().resolve({ authorization, actorEvidence, location: input.location, observationKey: input.observationKey })
      const personId = resolved.actor.kind === 'attributed' ? resolved.actor.personId : ''
      return {
        actorKind: resolved.actor.kind,
        personId,
        roomKind: resolved.room.roomKind,
        logicalRoomId: resolved.room.logicalRoomId,
        physicalRoomId: resolved.room.physicalRoomId,
        bindingVersion: resolved.room.bindingVersion,
        identityDigest: resolved.actor.kind === 'attributed' ? identityDigest(resolved.actor) : '',
      }
    },
    appendEvent: async (input) => {
      const appended = await assertTrace().appendEvent(input.authorization, {
        idempotencyKey: asRequestId(input.idempotencyKey),
        kind: input.kind,
        actor: input.actor,
        physicalRoomId: input.physicalRoomId,
        logicalRoomId: input.logicalRoomId,
        occurredAt: input.occurredAt,
        payload: { content: input.content },
        retentionClass: input.retentionClass,
      })
      return {
        eventId: appended.envelope.eventId,
        deduplicated: appended.deduplicated,
        logicalRoomId: appended.envelope.logicalRoomId,
        roomVersion: appended.envelope.roomVersion,
      }
    },
    beginGeneration: async (input) => {
      const startedAt = input.startedAt
      const begun = await assertTrace().beginGeneration(input.authorization, {
        idempotencyKey: asRequestId(input.idempotencyKey),
        logicalRoomId: input.logicalRoomId,
        characterId,
        causes: input.causes.map(cause => ({ inboundEventId: cause.inboundEventId as never, role: cause.role })),
        evidence: {
          observedRoomVersion: input.roomVersion,
          observedEventIds: input.observedEventIds as never[],
          contextManifestHash: '',
          contextManifest: {
            formatVersion: 1 as const,
            logicalRoomVersion: input.roomVersion,
            bindingRevision: input.bindingRevision,
            maxItems: 0,
            maxCharacters: 0,
            candidateReadLimit: 0,
            truncated: false,
            items: [],
          },
          observedBindingVersion: input.bindingRevision,
          capturedAt: startedAt,
        },
        modelRef: 'eval/provider/model/prompt-v1',
        startedAt,
      })
      return {
        generationId: begun.generation.generationId,
        deduplicated: begun.deduplicated,
        state: begun.generation.state,
        logicalRoomId: begun.generation.logicalRoomId,
        causeEventIds: begun.edges.map(edge => edge.inboundEventId),
      }
    },
    transitionGeneration: async (authorization, generation, from, to, at) => {
      const stub: GenerationAttempt = {
        generationId: generation.generationId as never,
        idempotencyKey: asRequestId('eval-transition'),
        logicalRoomId: generation.logicalRoomId,
        characterId: generation.characterId,
        state: from as never,
        evidence: undefined as never,
        modelRef: 'eval/model',
        startedAt: at,
      }
      const result = await assertTrace().transitionGeneration(authorization, stub, from as never, to as never, at)
      return { state: result.state }
    },
    appendSegments: async (authorization, generation, segments) => {
      const stub: GenerationAttempt = {
        generationId: generation.generationId as never,
        idempotencyKey: asRequestId('eval-segments'),
        logicalRoomId: generation.logicalRoomId,
        characterId: generation.characterId,
        state: 'generated' as never,
        evidence: undefined as never,
        modelRef: 'eval/model',
        startedAt: asTimestamp('2026-08-02T00:00:00Z'),
      }
      const appended = await assertTrace().appendSegments(authorization, stub, segments.map(segment => ({ segmentId: asSegmentId(segment.segmentId), ordinal: segment.ordinal, modality: segment.modality, text: segment.text })))
      return appended.map(segment => segment.segmentId)
    },
    beginDelivery: async (input) => {
      const attempt = await assertTrace().beginDelivery(input.authorization, { segmentId: input.segmentId, transport: input.transport, destinationId: input.destinationId, idempotencyKey: asRequestId(input.idempotencyKey), startedAt: input.startedAt })
      return { deliveryId: attempt.deliveryId, segmentId: attempt.segmentId, state: attempt.state }
    },
    transitionDelivery: async (authorization, deliveryId, from, to, evidence, at) => {
      const attempt = await assertTrace().transitionDelivery(authorization, { deliveryId: deliveryId as never, from, to, evidence: evidence as never, at })
      return { state: attempt.state }
    },
    assembleRecent: async (input) => {
      const result = await assertContext().assembleRecent({
        authorization: input.authorization,
        logicalRoomId: input.logicalRoomId,
        physicalRoomId: input.physicalRoomId,
        characterId,
        maxItems: input.maxItems,
        maxCharacters: input.maxCharacters,
      })
      return {
        sentinel: result.sentinel,
        selected: result.manifest.selected,
        truncated: result.manifest.truncated,
        includedItems: result.includedItems,
        logicalRoomVersion: result.manifest.logicalRoomVersion,
        bindingRevision: result.manifest.bindingRevision,
        text: result.text,
      }
    },
    searchMemory: async (authorization, input) => assertContext().searchMemory(authorization, input),
    privacy: async (input) => {
      const actorEvidence = {
        kind: 'attributed' as const,
        snapshot: {
          platform: 'discord' as const,
          platformUserId: input.platformUserId,
          displayNameAtEvent: input.displayNameAtEvent,
          guildId: input.guildId,
          observedAt: asTimestamp(new Date(input.observedAt).toISOString()),
          source: 'gateway' as const,
        },
      }
      const result = await assertPrivacy().execute({
        requestId: input.requestId,
        operation: input.operation as never,
        actorEvidence,
        discordUserId: input.discordUserId,
        guildId: input.guildId,
        channelId: input.channelId,
        channelKind: input.channelKind,
        observedAt: input.observedAt,
      })
      // The scenario runtime is asserted to be active and healthy above, so a
      // privacy answer must carry a durable operation id and can only refuse for
      // a disabled capability. Anything else means the runtime is in a posture
      // this harness does not evaluate, and silently recording it would make the
      // evidence describe a different configuration than the one it names.
      if (!result.operationId)
        throw new Error('Privacy operation returned no durable operation id; the scenario runtime is not in the active posture')
      const outcomeCode = result.code
      const observation: { operationId: string, code?: 'capability_disabled', events?: number, facts?: number, exportFactCount?: number, hasAttachment?: boolean } = { operationId: result.operationId }
      if (outcomeCode === 'capability_disabled')
        observation.code = outcomeCode
      else if (outcomeCode)
        throw new Error(`Privacy operation returned outcome code '${outcomeCode}', which is outside the active posture this harness evaluates`)
      // Status/show/export messages carry fact counts; parse them content-free.
      if (input.operation.kind === 'status') {
        const eventsMatch = /(\d+) requester event/.exec(result.message)
        const factsMatch = /(\d+) existing explicit fact/.exec(result.message)
        if (eventsMatch)
          observation.events = Number(eventsMatch[1])
        if (factsMatch)
          observation.facts = Number(factsMatch[1])
      }
      if (input.operation.kind === 'export') {
        if (result.attachment) {
          try {
            const payload = JSON.parse(result.attachment.data) as { facts?: unknown[] }
            observation.exportFactCount = Array.isArray(payload.facts) ? payload.facts.length : 0
          }
          catch {
            observation.exportFactCount = 0
          }
          observation.hasAttachment = true
        }
        else {
          observation.exportFactCount = 0
          observation.hasAttachment = false
        }
      }
      return observation
    },
    inspectRepository: <T>(read: (reader: RepositoryInspector) => T): T => {
      const database = openReadOnlySqliteDatabase(authorityPath)
      try {
        return read({ database, authorityPath })
      }
      finally {
        database.close()
      }
    },
    close: async () => runtime.close(),
  }
}

function ingressAuthorization(scope: AuthorizationScope, characterId: CharacterId): AuthorizationContext {
  return {
    principal: { botUserId: 'discord-bot', operations: ['identity:observe', 'room:read'], scopes: [{ kind: scope.kind, id: scope.id }], operator: false },
    characterId,
    ...(scope.kind === 'dm' ? { dmParticipants: [asCharacterId('requester') as unknown as never] } : {}),
  }
}

function roomAuthorization(room: LogicalRoomId, characterId: CharacterId): AuthorizationContext {
  return {
    principal: { botUserId: 'discord-bot', operations: ['event:write', 'draft:write', 'delivery:write', 'context:read'], scopes: [{ kind: 'logical_room', id: room }], operator: false },
    characterId,
    logicalRoomId: room,
  }
}

/** Stable, non-secret digest of an attributed actor's identity key. */
function identityDigest(actor: AttributedActor): string {
  return createHmac('sha256', Buffer.from('eval-identity', 'utf8')).update(actor.identityKey).digest('hex').slice(0, 16)
}

/** Convenience: open and run one scenario, closing in finally, returning its observation. */
export async function withScenarioRuntime<T>(
  run: EvaluationRuntimeRun,
  options: ScenarioOpenOptions,
  work: (scenario: ScenarioRuntime) => Promise<T>,
): Promise<T> {
  const scenario = await run.openScenario(options)
  const cleanupRoot = scenario.root
  try {
    return await work(scenario)
  }
  finally {
    await scenario.close()
    if (!run.keepRunRoot && existsSync(cleanupRoot) && cleanupRoot !== run.parentRoot)
      removeWithRetry(cleanupRoot)
    void cleanupRoot
  }
}

/** Re-exported for tests that need to build a restart pair against the same root. */
export function scenarioRootFor(run: EvaluationRuntimeRun, label: string): string {
  return join(run.parentRoot, `${label}${sep}`)
}
