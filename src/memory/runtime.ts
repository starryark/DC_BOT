import type { CharacterId } from '@proj-airi/memory-domain'

import type { ContextMemoryAuthority } from './context-authority'
import type { DeliveryReconciliationSummary } from './delivery-reconciliation'
import type { IngressMemoryAuthority, ResolvedIngress, ResolveIngressInput } from './ingress-authority'
import type { MemoryIntelligenceModels, MemoryIntelligenceWorkerResult } from './intelligence-worker'
import type { PrivacyMemoryAuthority } from './privacy-authority'
import type { MemoryMode } from './profile'
import type { MemoryRuntimePaths } from './runtime-paths'
import type { SpoolReplaySummary } from './spool-reconciliation'
import type { TraceMemoryAuthority } from './trace-authority'
import type { DeferredInboundEvent, DeferredMemoryAuthority, DeferredWriteSpool } from './write-spool'

import process from 'node:process'

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { asCharacterId, asDeliveryId, asFactId, asGenerationId, asPersonId, asRequestId, assertAuthorized, asTimestamp, attributedActor, buildCausalEdges, isValidId, MemoryError, projectPresentation } from '@proj-airi/memory-domain'
import { BindingRepository, CausalEdgeRepository, CorrectionRepository, DeliveryRepository, EventRepository, GenerationRepository, IdentityRepository, MemoryIntelligenceQueue, MemoryRepository, openAuthoritativeSqliteDatabase, OutputRepository, PolicyDataRepository, PrivacyOperationRepository, PrivacyRepository, ReconciliationQueue, RoomRepository, SearchRepository, SummaryRepository } from '@proj-airi/memory-sqlite'

import { ContextAssembler } from './context-assembler'
import { DELIVERY_RECONCILIATION_POLICY, reconcileDeliveries } from './delivery-reconciliation'
import { memoryPosture } from './feature-flags'
import { runMemoryIntelligenceWorkerOnce } from './intelligence-worker'
import { loadRoomBindingFile, persistedConfiguredBindingMembers } from './room-bindings'
import { resolveMemoryRuntimePaths } from './runtime-paths'
import { replayDeferredWrites } from './spool-reconciliation'
import { openDeferredWriteSpool } from './write-spool'

export interface MemoryRuntimeHealth {
  mode: MemoryMode
  state: string
  durableWritesEnabled: boolean
  promptUseEnabled: boolean
  /** True when G6 derived layers may influence prompts for this runtime. */
  layeredContextEnabled: boolean
  /**
   * `degraded` is the operator- and log-visible form of "the durable authority
   * is unusable": memory reads are halted and writes are deferred to the spool
   * rather than silently falling back to unrelated ephemeral history (ADR-016).
   */
  status: 'off' | 'healthy' | 'degraded'
  authority?: string
  backups?: string
  /**
   * Present whenever a deferred-write spool is part of this posture.
   * `pendingDepth` is a startup snapshot; the live depth is read from the spool
   * itself, which is what `/memory status` reports.
   */
  spool?: { directory: string, pendingDepth: number }
  /** Result of the startup pass that replays deferred writes into the authority. */
  spoolReconciliation?: SpoolReplaySummary
  /**
   * How many replayed spool records had their raw bytes erased by this startup.
   * Zero means there was nothing left to erase, not that erasure was skipped.
   */
  spoolCompaction?: number
  bindingReconciliation?: { created: number, unchanged: number, updated: number, retired: number }
  /**
   * IMP-406 startup delivery reconciliation, content-free. `operatorReviewTotal` is
   * the durable count of `abandoned` deliveries and the real "needs attention"
   * signal: it survives restarts, while the pass counts describe this startup only.
   */
  deliveryReconciliation?: DeliveryReconciliationSummary & { operatorReviewTotal: number }
}

export interface MemoryRuntime {
  health: MemoryRuntimeHealth
  ingress?: IngressMemoryAuthority
  trace?: TraceMemoryAuthority
  context?: ContextMemoryAuthority
  privacy?: PrivacyMemoryAuthority
  /** Present only in the degraded posture, where it is the sole write path. */
  deferred?: DeferredMemoryAuthority
  /** Present only when a disabled-by-default summary/extraction model boundary is supplied. */
  intelligence?: { runOnce: () => Promise<MemoryIntelligenceWorkerResult | undefined> }
  close: () => Promise<void>
}

export interface CreateMemoryRuntimeOptions {
  mode: MemoryMode
  flags: import('./feature-flags').MemoryFeatureFlags
  repoRoot: string
  configuredRoot?: string
  characterId: CharacterId
  bindingFile?: string
  intelligenceModels?: MemoryIntelligenceModels
}

/**
 * Derives the memory {@link CharacterId} from the configured character key
 * (`CHARACTER_ID`), which is the identity an operator must also write into
 * `binding.characterId`.
 *
 * Memory identity is taken from the configured key and never from a loaded
 * card's `id`. The card is optional and may fail to load, so keying memory off
 * it would move durable identity between `Makise Kurisu` and `Makise-Kurisu`
 * depending on whether a JSON file happened to parse, orphaning every row
 * written under the other spelling. The card keeps its own folder and display
 * identity; only this value crosses into the memory domain.
 *
 * Character folders are named for humans, but domain ids reject whitespace so a
 * display name can never become a durable author (ADR-006). Spaces are the one
 * difference that is bridged; every other invalid character still throws,
 * because an id quietly coerced into something else would not match the
 * operator's binding file and would silently isolate the run.
 *
 * Before:
 * - "Makise Kurisu"
 *
 * After:
 * - "Makise-Kurisu"
 */
export function memoryCharacterIdOf(configuredCharacterKey: string): CharacterId {
  // Trim first: a trailing space in `CHARACTER_ID=` would otherwise become a
  // trailing hyphen and produce an id that no binding file would ever match.
  const token = configuredCharacterKey.trim().replaceAll(' ', '-')
  if (!isValidId(token)) {
    throw new MemoryError('INVALID_ID', `CHARACTER_ID '${configuredCharacterKey}' cannot be used as a memory character id: '${token}' is not a token of [A-Za-z0-9_:.-] up to 128 characters`, {
      retryable: false,
      details: { kind: 'CharacterId' },
    })
  }
  return asCharacterId(token)
}

/** Owns the only approved Discord runtime import of the SQLite implementation. */
export function createMemoryRuntime(options: CreateMemoryRuntimeOptions): MemoryRuntime {
  const posture = memoryPosture(options.flags)
  if (posture.violations.length > 0)
    throw new Error(`Memory startup refused: ${posture.violations.map(item => item.detail).join('; ')}`)
  if ((options.flags.summaries || options.flags.autoExtraction) && !options.intelligenceModels)
    throw new Error('Memory startup refused: summary/extraction flags require an explicit intelligence model boundary')

  if (options.mode === 'off') {
    return {
      health: {
        mode: 'off',
        state: posture.state,
        durableWritesEnabled: false,
        promptUseEnabled: false,
        layeredContextEnabled: false,
        status: 'off',
      },
      close: async () => {},
    }
  }
  if (options.mode === 'degraded') {
    // The authority is what the operator has declared unusable, so none is
    // opened. Composing one would either succeed — contradicting the
    // declaration and resuming durable reads — or fail and take the bot down,
    // which is the outage this posture exists to survive.
    const degradedPaths = resolveMemoryRuntimePaths(options.repoRoot, options.configuredRoot)
    createRuntimeDirectories(degradedPaths)
    const spool = openDeferredWriteSpool(degradedPaths.spool)
    return {
      health: {
        mode: 'degraded',
        state: posture.state,
        durableWritesEnabled: posture.durableWritesEnabled,
        promptUseEnabled: posture.promptUseEnabled,
        layeredContextEnabled: false,
        status: 'degraded',
        spool: { directory: spool.directory, pendingDepth: spool.pendingDepth() },
      },
      deferred: { spoolInboundEvent: async intent => spool.accept(intent) },
      privacy: createDegradedPrivacyAuthority(spool),
      close: async () => spool.close(),
    }
  }
  if (options.mode !== 'shadow' && options.mode !== 'active')
    throw new Error(`MEMORY_MODE=${options.mode} is not activatable until its implementation increment is complete`)

  const configuredBindings = options.bindingFile ? loadRoomBindingFile(options.bindingFile) : []
  const configuredMembers = persistedConfiguredBindingMembers(configuredBindings, options.characterId)
  const paths = resolveMemoryRuntimePaths(options.repoRoot, options.configuredRoot)
  createRuntimeDirectories(paths)
  const handle = openAuthoritativeSqliteDatabase(paths.authority)
  const identities = new IdentityRepository(handle.database)
  const rooms = new RoomRepository(handle.database)
  const bindings = new BindingRepository(handle.database)
  const events = new EventRepository(handle.database)
  const generations = new GenerationRepository(handle.database)
  const causalEdges = new CausalEdgeRepository(handle.database)
  const outputs = new OutputRepository(handle.database)
  const deliveries = new DeliveryRepository(handle.database)
  const reconciliationQueue = new ReconciliationQueue(handle.database)
  const privacyRepository = new PrivacyRepository(handle.database)
  const privacyOperations = new PrivacyOperationRepository(handle.database)
  const memories = new MemoryRepository(handle.database)
  const corrections = new CorrectionRepository(handle.database)
  const policyData = new PolicyDataRepository(handle.database)
  const search = new SearchRepository(handle.database)
  const summaries = new SummaryRepository(handle.database)
  const intelligenceQueue = new MemoryIntelligenceQueue(handle.database)
  const intelligenceModels = options.intelligenceModels
  const contextAssembler = new ContextAssembler({ events, deliveries, memories, policyData, search, summaries, currentRoomVersion: logicalRoomId => rooms.currentVersion(logicalRoomId) }, options.flags)
  let bindingManifest
  try {
    bindingManifest = bindings.reconcileConfigured({ owner: 'config:discord-bot', members: configuredMembers, at: asTimestamp(new Date().toISOString()) })
  }
  catch (error) {
    handle.close()
    throw error
  }
  // IMP-406: classify stale prior-process deliveries and reconcile crash-ambiguous
  // attempts before normal operation can treat them as current-process work. Runs at
  // the sole-writer moment, alongside binding reconciliation, and is idempotent.
  let deliveryReconciliation
  try {
    deliveryReconciliation = {
      ...reconcileDeliveries(
        {
          deliveries,
          queue: reconciliationQueue,
          now: () => new Date().toISOString(),
          id: randomUUID,
          workerId: `discord-bot:start:${process.pid}`,
          random: Math.random,
        },
        DELIVERY_RECONCILIATION_POLICY,
      ),
      operatorReviewTotal: deliveries.countByState('abandoned'),
    }
  }
  catch (error) {
    handle.close()
    throw error
  }
  // Deferred writes taken while the authority was unusable are replayed before
  // normal operation, at the same sole-writer moment as the reconciliation
  // above. Every append reuses the idempotency key the live path would have
  // used, so a pass interrupted after a commit repeats it harmlessly.
  let spoolReconciliation
  let spoolCompaction
  try {
    const spool = openDeferredWriteSpool(paths.spool)
    try {
      spoolReconciliation = replayDeferredWrites({
        spool,
        apply: intent => applyDeferredInboundEvent({ identities, rooms, events, characterId: options.characterId }, intent),
      })
      // Everything the pass disposed of is now durable in the authority, which
      // owns its deletion and retention. Leaving the spool copy would leave raw
      // user content on the filesystem that no privacy pass can reach, so the
      // bytes go here. Records the pass did not dispose of are untouched.
      spoolCompaction = spool.compact()
    }
    finally {
      spool.close()
    }
  }
  catch (error) {
    handle.close()
    throw error
  }
  const ingress = createIngressAuthority(identities, rooms)
  return {
    health: {
      mode: options.mode,
      state: posture.state,
      durableWritesEnabled: posture.durableWritesEnabled,
      promptUseEnabled: posture.promptUseEnabled,
      layeredContextEnabled: options.flags.summaries || options.flags.explicitSemanticMemory || options.flags.autoExtraction || options.flags.onDemandRecall,
      status: 'healthy',
      authority: paths.authority,
      backups: paths.backups,
      spoolReconciliation,
      spoolCompaction,
      bindingReconciliation: {
        created: bindingManifest.created.length,
        unchanged: bindingManifest.unchanged.length,
        updated: bindingManifest.updated.length,
        retired: bindingManifest.retired.length,
      },
      deliveryReconciliation,
    },
    ingress,
    trace: {
      appendEvent: async (authorization, input) => {
        assertAuthorized(authorization, { operation: 'event:write', targetScope: { kind: 'logical_room', id: input.logicalRoomId } })
        const appended = events.append(input)
        // This request path persists only content-free work. Model execution is
        // owned by `intelligence.runOnce` and is never awaited here.
        if (options.flags.summaries) {
          intelligenceQueue.enqueueSummary({ jobId: stableTraceId('summary-job', appended.envelope.eventId), dedupeKey: `summary:${appended.envelope.eventId}`, logicalRoomId: appended.envelope.logicalRoomId, characterId: options.characterId, sourceEventIds: [appended.envelope.eventId], modelRef: 'memory-summary-v1', policyVersion: 'summary-policy-v1', availableAt: appended.envelope.recordedAt, createdAt: appended.envelope.recordedAt, maxAttempts: 3 })
        }
        if (options.flags.autoExtraction && appended.envelope.kind !== 'system') {
          intelligenceQueue.enqueueExtraction({ jobId: stableTraceId('extraction-job', appended.envelope.eventId), dedupeKey: `extract:${appended.envelope.eventId}`, logicalRoomId: appended.envelope.logicalRoomId, characterId: options.characterId, sourceEventId: appended.envelope.eventId, modelRef: 'memory-extraction-v1', policyVersion: 'extraction-policy-v1', availableAt: appended.envelope.recordedAt, createdAt: appended.envelope.recordedAt, maxAttempts: 3 })
        }
        return appended
      },
      beginGeneration: async (authorization, input) => {
        assertAuthorized(authorization, { operation: 'draft:write', targetScope: { kind: 'logical_room', id: input.logicalRoomId } })
        const generationId = asGenerationId(stableTraceId('generation', input.idempotencyKey))
        // Validate the complete cause set before allocating durable generation state.
        buildCausalEdges(generationId, input.causes)
        const created = generations.create({
          generationId,
          idempotencyKey: input.idempotencyKey,
          logicalRoomId: input.logicalRoomId,
          characterId: input.characterId,
          state: 'prepared',
          evidence: input.evidence,
          modelRef: input.modelRef,
          startedAt: input.startedAt,
        })
        const edges = causalEdges.appendSet(created.attempt.generationId, input.causes)
        const generation = created.attempt.state === 'prepared'
          ? generations.transition(created.attempt.generationId, 'prepared', 'running', input.startedAt)
          : created.attempt
        return { generation, edges, deduplicated: created.deduplicated }
      },
      transitionGeneration: async (authorization, generation, from, to, at) => {
        assertAuthorized(authorization, { operation: 'draft:write', targetScope: { kind: 'logical_room', id: generation.logicalRoomId } })
        return generations.transition(generation.generationId, from, to, at)
      },
      appendSegments: async (authorization, generation, segments) => {
        assertAuthorized(authorization, { operation: 'draft:write', targetScope: { kind: 'logical_room', id: generation.logicalRoomId } })
        return outputs.appendSet(generation.generationId, segments.map(segment => ({ ...segment, generationId: generation.generationId }))).segments
      },
      beginDelivery: async (authorization, input) => {
        assertAuthorized(authorization, { operation: 'delivery:write', targetScope: { kind: 'logical_room', id: authorization.logicalRoomId } })
        return deliveries.create({
          deliveryId: asDeliveryId(stableTraceId('delivery', input.idempotencyKey)),
          segmentId: input.segmentId,
          transport: input.transport,
          destinationId: input.destinationId,
          idempotencyKey: input.idempotencyKey,
          attemptNumber: 1,
          state: 'pending',
          evidence: { kind: 'none' },
          startedAt: input.startedAt,
          lastTransitionAt: input.startedAt,
        }).attempt
      },
      transitionDelivery: async (authorization, transition) => {
        assertAuthorized(authorization, { operation: 'delivery:write', targetScope: { kind: 'logical_room', id: authorization.logicalRoomId } })
        return deliveries.transition(transition)
      },
    },
    context: {
      assembleRecent: async request => contextAssembler.assembleRecent(request),
      assembleLayered: async request => contextAssembler.assembleLayered(request),
      searchMemory: async (auth, input) => {
        assertAuthorized(auth, { operation: 'context:read', targetScope: input.scope })
        if (!options.flags.fulltextRetrieval)
          return { hits: [], appliedModes: [], abstained: 'noAuthorizedEvidence' }
        return search.searchMemory(input)
      },
    },
    privacy: {
      execute: async (input) => {
        const location = input.channelKind === 'dm'
          ? { platform: 'discord' as const, channelId: input.channelId, channelKind: 'dm' as const }
          : { platform: 'discord' as const, guildId: input.guildId!, channelId: input.channelId, channelKind: input.channelKind }
        const targetScope = input.channelKind === 'dm' ? { kind: 'dm' as const, id: input.channelId } : { kind: 'guild' as const, id: input.guildId! }
        const ingressAuth = { principal: { botUserId: 'discord-bot', operations: ['identity:observe' as const, 'room:read' as const], scopes: [targetScope], operator: false }, characterId: options.characterId }
        const resolved = await ingress.resolve({ authorization: ingressAuth, actorEvidence: input.actorEvidence, location, observationKey: `privacy:${input.discordUserId}:${input.observedAt}` })
        if (resolved.actor.kind !== 'attributed')
          throw new Error('Privacy operations require an attributable requester')
        const personId = resolved.actor.personId
        const now = asTimestamp(new Date(input.observedAt).toISOString())
        const begun = privacyOperations.begin({ requestId: input.requestId, operationKind: input.operation.kind, personId, logicalRoomId: resolved.room.logicalRoomId, inputHash: createHash('sha256').update(JSON.stringify(input.operation)).digest('hex'), requestedAt: now })
        if (input.operation.kind === 'correct' && begun.record.outcomeCode === 'succeeded')
          return { operationId: begun.record.operationId, message: 'Correction completed for your active fact in this room.' }
        if (input.operation.kind === 'correct' && begun.record.outcomeCode === 'capability_disabled')
          return { operationId: begun.record.operationId, code: 'capability_disabled', message: 'Explicit semantic memory correction is disabled; nothing was changed.' }
        if (input.operation.kind === 'correct' && begun.record.outcomeCode === 'failed')
          throw new MemoryError('INVALID_INTENT', 'the correction request previously failed')
        if (input.operation.kind === 'remember' && begun.record.outcomeCode === 'succeeded')
          return { operationId: begun.record.operationId, message: 'Remembered this fact for you in the current room.' }
        if (input.operation.kind === 'remember' && begun.record.outcomeCode === 'capability_disabled')
          return { operationId: begun.record.operationId, code: 'capability_disabled', message: 'Explicit semantic memory is disabled; nothing was stored.' }
        if (input.operation.kind === 'remember' && begun.record.outcomeCode === 'failed')
          throw new MemoryError('INVALID_INTENT', 'the remember request previously failed')
        try {
          if (input.operation.kind === 'status') {
            const counts = privacyRepository.counts(personId, resolved.room.logicalRoomId)
            privacyOperations.complete(begun.record.operationId, { completedAt: now, outcomeCode: 'succeeded' })
            return { operationId: begun.record.operationId, message: `Memory is ${options.mode}. Explicit semantic memory is disabled. This room has ${counts.events} requester event(s) and ${counts.facts} existing explicit fact(s).` }
          }
          if (input.operation.kind === 'show' || input.operation.kind === 'export') {
            const payload = privacyRepository.export(personId, resolved.room.logicalRoomId)
            privacyOperations.complete(begun.record.operationId, { completedAt: now, outcomeCode: 'succeeded' })
            if (input.operation.kind === 'export')
              return { operationId: begun.record.operationId, message: 'Your current-room memory export is attached.', attachment: { name: `memory-export-${input.observedAt}.json`, data: JSON.stringify(payload, null, 2) } }
            return { operationId: begun.record.operationId, message: payload.facts.length ? payload.facts.map(fact => `${fact.factId}: ${fact.predicate} = ${fact.value}`).join('\n').slice(0, 1900) : 'No active explicit facts are stored for you in this room.' }
          }
          if ((input.operation.kind === 'remember' || input.operation.kind === 'correct') && !options.flags.explicitSemanticMemory) {
            privacyOperations.complete(begun.record.operationId, { completedAt: now, outcomeCode: 'capability_disabled' })
            return { operationId: begun.record.operationId, code: 'capability_disabled', message: input.operation.kind === 'remember' ? 'Explicit semantic memory is disabled; nothing was stored.' : 'Explicit semantic memory correction is disabled; nothing was changed.' }
          }
          if (input.operation.kind === 'remember') {
            const authorization = {
              principal: { botUserId: 'discord-bot', operations: ['event:write' as const, 'intent:write' as const], scopes: [{ kind: 'logical_room' as const, id: resolved.room.logicalRoomId }], operator: false },
              characterId: options.characterId,
              logicalRoomId: resolved.room.logicalRoomId,
              ...(input.channelKind === 'dm' ? { dmParticipants: [personId] } : {}),
            }
            const factScope = { kind: 'logical_room' as const, id: resolved.room.logicalRoomId }
            assertAuthorized(authorization, { operation: 'intent:write', targetScope: factScope, subjectPersonId: personId })
            assertAuthorized(authorization, { operation: 'event:write', targetScope: factScope, subjectPersonId: personId })
            const predicate = input.operation.predicate.trim()
            const value = input.operation.value.trim()
            const current = memories.currentFacts({ scopeKind: 'logical_room', scopeId: resolved.room.logicalRoomId, predicate })
              .filter(fact => fact.personId === personId)
            if (current.some(fact => fact.value !== value))
              throw new MemoryError('INVALID_INTENT', 'a different active value already exists; use the correction command')
            if (!current.some(fact => fact.value === value)) {
              const command = events.append({
                idempotencyKey: asRequestId(stableTraceId('remember-command', begun.record.operationId)),
                kind: 'command',
                actor: resolved.actor,
                physicalRoomId: resolved.room.physicalRoomId,
                logicalRoomId: resolved.room.logicalRoomId,
                occurredAt: now,
                payload: { content: `Remember ${predicate}: ${value}` },
                retentionClass: 'command',
              })
              memories.createFact({
                layer: 'semantic',
                factId: asFactId(stableTraceId('fact', begun.record.operationId)),
                personId,
                scopeKind: 'logical_room',
                scopeId: resolved.room.logicalRoomId,
                predicate,
                value,
                confidence: 1,
                provenance: { source: 'userStated', method: 'explicitCommand', sourceEventIds: [command.envelope.eventId], statedAt: now },
                validity: { validFrom: now, recordedAt: now },
              })
            }
            privacyOperations.complete(begun.record.operationId, { completedAt: now, outcomeCode: 'succeeded' })
            return { operationId: begun.record.operationId, message: 'Remembered this fact for you in the current room.' }
          }
          if (input.operation.kind === 'correct') {
            const authorization = {
              principal: { botUserId: 'discord-bot', operations: ['event:write' as const, 'intent:write' as const], scopes: [{ kind: 'logical_room' as const, id: resolved.room.logicalRoomId }], operator: false },
              characterId: options.characterId,
              logicalRoomId: resolved.room.logicalRoomId,
              ...(input.channelKind === 'dm' ? { dmParticipants: [personId] } : {}),
            }
            const factScope = { kind: 'logical_room' as const, id: resolved.room.logicalRoomId }
            // Authorization is deliberately established before the caller-supplied
            // fact id reaches a repository; ids are identifiers, never capabilities.
            assertAuthorized(authorization, { operation: 'intent:write', targetScope: factScope, subjectPersonId: personId })
            assertAuthorized(authorization, { operation: 'event:write', targetScope: factScope, subjectPersonId: personId })
            const targetFactId = asFactId(input.operation.factId)
            const target = memories.getFact(targetFactId)
            if (!target || target.tombstonedBy != null)
              throw new MemoryError('TARGET_NOT_FOUND', 'active fact to correct does not exist in this room')
            if (target.supersededBy != null)
              throw new MemoryError('INVALID_INTENT', 'this fact was already superseded; correct the current fact instead')
            if (target.personId !== personId || target.scopeKind !== 'logical_room' || target.scopeId !== resolved.room.logicalRoomId)
              throw new MemoryError('TARGET_NOT_FOUND', 'active fact to correct does not exist in this room')

            const command = events.append({
              idempotencyKey: asRequestId(stableTraceId('correction-command', begun.record.operationId)),
              kind: 'command',
              actor: resolved.actor,
              physicalRoomId: resolved.room.physicalRoomId,
              logicalRoomId: resolved.room.logicalRoomId,
              occurredAt: now,
              payload: { content: `Correct ${targetFactId}: ${input.operation.value}` },
              retentionClass: 'command',
            })
            corrections.correct(stableTraceId('correction', begun.record.operationId), {
              previousFactId: targetFactId,
              factId: asFactId(stableTraceId('fact', begun.record.operationId)),
              value: input.operation.value,
              provenance: { source: 'userStated', method: 'explicitCommand', sourceEventIds: [command.envelope.eventId], statedAt: now },
              effectiveAt: now,
              recordedAt: now,
            })
            privacyOperations.complete(begun.record.operationId, { completedAt: now, outcomeCode: 'succeeded' })
            return { operationId: begun.record.operationId, message: 'Correction completed for your active fact in this room.' }
          }
          const forgetRequestId = stableTraceId('forget', begun.record.operationId)
          const forgotten = privacyRepository.forget(forgetRequestId, personId, resolved.room.logicalRoomId, now)
          privacyOperations.complete(begun.record.operationId, { completedAt: now, outcomeCode: 'succeeded', forgetRequestId: forgotten.forgetRequestId })
          return { operationId: begun.record.operationId, message: 'Forget completed and verified for your data in this room. A minimal deletion obligation was retained for backup restore.' }
        }
        catch (error) {
          privacyOperations.complete(begun.record.operationId, { completedAt: now, outcomeCode: 'failed' })
          throw error
        }
      },
    },
    ...(intelligenceModels
      ? {
          intelligence: {
            runOnce: () => runMemoryIntelligenceWorkerOnce(
              { queue: intelligenceQueue, events, memories, summaries, models: intelligenceModels },
              { workerId: `discord-bot:intelligence:${process.pid}`, leaseMs: 30_000, retryBaseMs: 1_000, retryMaximumMs: 60_000, extractionConfidenceFloor: 0.8, now: () => asTimestamp(new Date().toISOString()), random: Math.random },
            ),
          },
        }
      : {}),
    close: async () => handle.close(),
  }
}

function createIngressAuthority(identities: IdentityRepository, rooms: RoomRepository): IngressMemoryAuthority {
  return { resolve: async input => resolveIngress(identities, rooms, input) }
}

/**
 * The authorized identity and room boundary, as a plain call.
 *
 * Split out of {@link createIngressAuthority} so spool recovery — which runs
 * synchronously at the sole-writer moment, before any authority surface is
 * published — resolves a replayed turn through exactly the boundary the live
 * path uses, rather than through a second copy of these rules.
 */
function resolveIngress(identities: IdentityRepository, rooms: RoomRepository, input: ResolveIngressInput): ResolvedIngress {
  const targetScope = input.location.channelKind === 'dm' ? { kind: 'dm' as const, id: input.location.channelId } : { kind: 'guild' as const, id: input.location.guildId }
  // Authorization precedes every identity or room lookup, so denied callers cannot probe durable state.
  assertAuthorized(input.authorization, { operation: 'identity:observe', targetScope })
  assertAuthorized(input.authorization, { operation: 'room:read', targetScope })
  if (input.actorEvidence.kind === 'anonymous') {
    if (input.location.channelKind === 'dm')
      throw new Error('DM ingress requires an attributable participant')
    rooms.observe({ location: input.location, observedAt: input.actorEvidence.actor.observedAt, displayName: input.displayName, parentChannelId: input.parentChannelId })
    return { actor: input.actorEvidence.actor, room: rooms.resolve(input.location, input.authorization.characterId, input.actorEvidence.actor.observedAt) }
  }
  const snapshot = input.actorEvidence.snapshot
  const observed = identities.observe({ observationKey: input.observationKey, snapshotId: randomUUID(), discordUserId: snapshot.platformUserId, observedAt: snapshot.observedAt, displayNameAtEvent: snapshot.displayNameAtEvent, sourceEventType: snapshot.source === 'restFetch' ? 'restFetch' : 'gateway', completeness: snapshot.guildId ? 'member_partial' : 'user_partial', username: snapshot.username, globalName: snapshot.globalName, guildId: snapshot.guildId, guildNickname: snapshot.guildNickname })
  const actor = attributedActor(observed.personId, snapshot)
  rooms.observe({ location: input.location, observedAt: snapshot.observedAt, displayName: input.displayName, parentChannelId: input.parentChannelId, ...(input.location.channelKind === 'dm' ? { participantPersonId: observed.personId } : {}) })
  return { actor, presentation: projectPresentation(actor), room: rooms.resolve(input.location, input.authorization.characterId, snapshot.observedAt) }
}

/**
 * Applies one spooled turn to the recovered authority.
 *
 * The spool holds intent, not durable state, so this is where canonical
 * identity finally comes from: the authority allocates the person, the rooms,
 * and the event id, and the spooled idempotency key is what makes a repeated
 * offer collapse into the append that already happened.
 */
function applyDeferredInboundEvent(
  authority: { identities: IdentityRepository, rooms: RoomRepository, events: EventRepository, characterId: CharacterId },
  intent: DeferredInboundEvent,
): { deduplicated: boolean } {
  const directMessage = intent.location.channelKind === 'dm'
  const targetScope = directMessage ? { kind: 'dm' as const, id: intent.location.channelId } : { kind: 'guild' as const, id: intent.location.guildId! }
  const resolved = resolveIngress(authority.identities, authority.rooms, {
    authorization: {
      principal: { botUserId: 'discord-bot', operations: ['identity:observe', 'room:read'], scopes: [targetScope], operator: false },
      characterId: authority.characterId,
      // The live DM path asserts a participant before the durable person exists;
      // recovery replays that same assertion rather than widening the scope.
      ...(directMessage ? { dmParticipants: [asPersonId('requester')] } : {}),
    },
    actorEvidence: intent.actorEvidence,
    location: intent.location,
    observationKey: intent.observationKey,
  })
  const authorization = {
    principal: { botUserId: 'discord-bot', operations: ['event:write' as const], scopes: [{ kind: 'logical_room' as const, id: resolved.room.logicalRoomId }], operator: false },
    characterId: authority.characterId,
    logicalRoomId: resolved.room.logicalRoomId,
    ...(directMessage && resolved.actor.kind === 'attributed' ? { dmParticipants: [resolved.actor.personId] } : {}),
  }
  assertAuthorized(authorization, { operation: 'event:write', targetScope: { kind: 'logical_room', id: resolved.room.logicalRoomId } })
  const appended = authority.events.append({
    idempotencyKey: asRequestId(intent.idempotencyKey),
    kind: intent.kind,
    actor: resolved.actor,
    physicalRoomId: resolved.room.physicalRoomId,
    logicalRoomId: resolved.room.logicalRoomId,
    occurredAt: asTimestamp(intent.occurredAt),
    payload: { content: intent.content },
    retentionClass: intent.retentionClass,
  })
  return { deduplicated: appended.deduplicated }
}

/**
 * The user-facing half of the degraded posture.
 *
 * Every answer here has to be true while the durable authority is gone, which
 * rules out all six normal outcomes: nothing can be read, nothing can be
 * stored, and nothing can be confirmed deleted. Saying so plainly is the
 * requirement (artifact 09 F-1, ADR-016) — a reassuring message would be the
 * false success the whole posture exists to prevent. There is no operation id
 * because no durable privacy operation was recorded.
 */
function createDegradedPrivacyAuthority(spool: DeferredWriteSpool): PrivacyMemoryAuthority {
  const preamble = (): string => {
    const pending = spool.pendingDepth()
    return `Memory is degraded: the durable store is unavailable, so nothing is being read from memory and ${pending} write${pending === 1 ? ' is' : 's are'} waiting to be replayed.`
  }
  return {
    execute: async (input) => {
      if (input.operation.kind === 'remember')
        return { code: 'memory_degraded', message: `${preamble()} Nothing was stored, and nothing has been durably remembered.` }
      if (input.operation.kind === 'correct')
        return { code: 'memory_degraded', message: `${preamble()} No fact could be read or changed.` }
      if (input.operation.kind === 'forget')
        return { code: 'memory_degraded', message: `${preamble()} Nothing could be deleted and no deletion has been verified; retry once memory is healthy.` }
      if (input.operation.kind === 'show' || input.operation.kind === 'export')
        return { code: 'memory_degraded', message: `${preamble()} Your stored memory cannot be read right now, so none is shown.` }
      return { code: 'memory_degraded', message: `${preamble()} Nothing has been durably remembered while this lasts.` }
    },
  }
}

function stableTraceId(kind: string, key: string): string {
  return `${kind}:${createHash('sha256').update(key).digest('hex')}`
}

function createRuntimeDirectories(paths: MemoryRuntimePaths): void {
  for (const path of [paths.authorityDirectory, paths.backups, paths.spool, paths.reports, paths.exports, paths.logs])
    mkdirSync(path, { recursive: true })
}
