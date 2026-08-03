import type { CharacterId } from '@proj-airi/memory-domain'

import type { ContextMemoryAuthority } from './context-authority'
import type { IngressMemoryAuthority } from './ingress-authority'
import type { PrivacyMemoryAuthority } from './privacy-authority'
import type { MemoryMode } from './profile'
import type { MemoryRuntimePaths } from './runtime-paths'
import type { TraceMemoryAuthority } from './trace-authority'

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { asDeliveryId, asGenerationId, assertAuthorized, asTimestamp, attributedActor, buildCausalEdges, projectPresentation } from '@proj-airi/memory-domain'
import { BindingRepository, CausalEdgeRepository, DeliveryRepository, EventRepository, GenerationRepository, IdentityRepository, openAuthoritativeSqliteDatabase, OutputRepository, PolicyDataRepository, PrivacyRepository, RoomRepository } from '@proj-airi/memory-sqlite'

import { memoryPosture } from './feature-flags'
import { serializePromptContext } from './prompt-context'
import { loadRoomBindingFile, persistedConfiguredBindingMembers } from './room-bindings'
import { resolveMemoryRuntimePaths } from './runtime-paths'

export interface MemoryRuntimeHealth {
  mode: MemoryMode
  state: string
  durableWritesEnabled: boolean
  promptUseEnabled: boolean
  status: 'off' | 'healthy'
  authority?: string
  backups?: string
  bindingReconciliation?: { created: number, unchanged: number, updated: number, retired: number }
}

export interface MemoryRuntime {
  health: MemoryRuntimeHealth
  ingress?: IngressMemoryAuthority
  trace?: TraceMemoryAuthority
  context?: ContextMemoryAuthority
  privacy?: PrivacyMemoryAuthority
  close: () => Promise<void>
}

export interface CreateMemoryRuntimeOptions {
  mode: MemoryMode
  flags: import('./feature-flags').MemoryFeatureFlags
  repoRoot: string
  configuredRoot?: string
  characterId: CharacterId
  bindingFile?: string
}

/** Owns the only approved Discord runtime import of the SQLite implementation. */
export function createMemoryRuntime(options: CreateMemoryRuntimeOptions): MemoryRuntime {
  const posture = memoryPosture(options.flags)
  if (posture.violations.length > 0)
    throw new Error(`Memory startup refused: ${posture.violations.map(item => item.detail).join('; ')}`)

  if (options.mode === 'off') {
    return {
      health: {
        mode: 'off',
        state: posture.state,
        durableWritesEnabled: false,
        promptUseEnabled: false,
        status: 'off',
      },
      close: async () => {},
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
  const privacyRepository = new PrivacyRepository(handle.database)
  const policyData = new PolicyDataRepository(handle.database)
  let bindingManifest
  try {
    bindingManifest = bindings.reconcileConfigured({ owner: 'config:discord-bot', members: configuredMembers, at: asTimestamp(new Date().toISOString()) })
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
      status: 'healthy',
      authority: paths.authority,
      backups: paths.backups,
      bindingReconciliation: {
        created: bindingManifest.created.length,
        unchanged: bindingManifest.unchanged.length,
        updated: bindingManifest.updated.length,
        retired: bindingManifest.retired.length,
      },
    },
    ingress,
    trace: {
      appendEvent: async (authorization, input) => {
        assertAuthorized(authorization, { operation: 'event:write', targetScope: { kind: 'logical_room', id: input.logicalRoomId } })
        return events.append(input)
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
      assembleRecent: async (request) => {
        assertAuthorized(request.authorization, { operation: 'context:read', targetScope: { kind: 'logical_room', id: request.logicalRoomId } })
        if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1 || request.maxItems > 250)
          throw new RangeError('recent context maxItems must be between 1 and 250')
        const scope = policyData.findExact({ physicalRoomId: request.physicalRoomId, logicalRoomId: request.logicalRoomId, characterId: request.characterId, at: asTimestamp(new Date().toISOString()) })
        if (!scope)
          return { sentinel: 'noDurableContext' as const, text: '', includedItems: 0, truncated: false, manifest: { selected: [], truncated: false, bindingRevision: 0, candidateReadLimit: 0 } }
        // Each source reads at most four candidates per requested item. The
        // combined repository read bound is therefore 8 * maxItems.
        const candidateReadLimit = request.maxItems * 4
        const inbound = events.recentForLogical({ logicalRoomId: request.logicalRoomId, characterId: request.characterId, limit: candidateReadLimit, excludeEventIds: request.excludeEventIds })
          .flatMap(event => event.payload.redacted || !event.payload.content
            ? []
            : [{ id: event.eventId, sourceType: 'inbound' as const, personRef: event.actor.kind === 'attributed' ? `P:${event.actor.personId}` : undefined, text: event.payload.content, at: event.occurredAt }])
        const assistant = deliveries.eligibleForLogical(
          { logicalRoomId: request.logicalRoomId, characterId: request.characterId, limit: candidateReadLimit, excludeEventIds: request.excludeEventIds },
          { allowPartialAssistantOutput: false, treatCompletedPlaybackAsEligible: true },
        )
          .map(output => ({ id: output.segment.segmentId, sourceType: 'assistant_output' as const, deliveryStatus: output.attempt.state, text: output.text, at: output.attempt.lastTransitionAt }))
        const ordered = [...inbound, ...assistant]
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id))
          .slice(-request.maxItems)
        const localPeople = new Map<string, string>()
        const selected = ordered.map((item) => {
          if (!('personRef' in item) || typeof item.personRef !== 'string' || !item.personRef)
            return { text: item.text }
          let local = localPeople.get(item.personRef)
          if (!local) {
            local = `P${localPeople.size + 1}`
            localPeople.set(item.personRef, local)
          }
          return { text: item.text, personRef: local }
        })
        const serialized = serializePromptContext(selected, request.maxCharacters)
        const truncated = serialized.truncated || inbound.length + assistant.length > ordered.length || inbound.length === candidateReadLimit || assistant.length === candidateReadLimit
        return { sentinel: 'ok' as const, ...serialized, manifest: { selected: ordered.slice(0, serialized.includedItems).map(item => ({ id: item.id, sourceType: item.sourceType, ...('deliveryStatus' in item ? { deliveryStatus: item.deliveryStatus } : {}) })), truncated, bindingRevision: scope.bindingRevision, candidateReadLimit } }
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
        if (input.operation.kind === 'status') {
          const counts = privacyRepository.counts(personId, resolved.room.logicalRoomId)
          return { message: `Memory is ${options.mode}. Explicit semantic memory is disabled. This room has ${counts.events} requester event(s) and ${counts.facts} existing explicit fact(s).` }
        }
        if (input.operation.kind === 'show' || input.operation.kind === 'export') {
          const payload = privacyRepository.export(personId, resolved.room.logicalRoomId)
          if (input.operation.kind === 'export')
            return { message: 'Your current-room memory export is attached.', attachment: { name: `memory-export-${input.observedAt}.json`, data: JSON.stringify(payload, null, 2) } }
          return { message: payload.facts.length ? payload.facts.map(fact => `${fact.factId}: ${fact.predicate} = ${fact.value}`).join('\n').slice(0, 1900) : 'No active explicit facts are stored for you in this room.' }
        }
        if (input.operation.kind === 'remember') {
          return { code: 'capability_disabled', message: 'Explicit semantic memory is disabled; nothing was stored.' }
        }
        if (input.operation.kind === 'correct') {
          return { code: 'capability_disabled', message: 'Explicit semantic memory correction is disabled; nothing was changed.' }
        }
        const requestId = stableTraceId('forget', `${personId}:${resolved.room.logicalRoomId}:${input.observedAt}`)
        privacyRepository.forget(requestId, personId, resolved.room.logicalRoomId, now)
        return { message: 'Forget completed and verified for your data in this room. A minimal deletion obligation was retained for backup restore.' }
      },
    },
    close: async () => handle.close(),
  }
}

function createIngressAuthority(identities: IdentityRepository, rooms: RoomRepository): IngressMemoryAuthority {
  return {
    resolve: async (input) => {
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
