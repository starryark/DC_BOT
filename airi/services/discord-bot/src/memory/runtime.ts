import type { ContextMemoryAuthority } from './context-authority'
import type { IngressMemoryAuthority } from './ingress-authority'
import type { PrivacyMemoryAuthority } from './privacy-authority'
import type { MemoryMode } from './profile'
import type { MemoryRuntimePaths } from './runtime-paths'
import type { TraceMemoryAuthority } from './trace-authority'

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'

import { asCharacterId, asConfidence, asDeliveryId, asFactId, asGenerationId, asRequestId, assertAuthorized, asTimestamp, attributedActor, buildCausalEdges, projectPresentation } from '@proj-airi/memory-domain'
import { CausalEdgeRepository, CorrectionRepository, DeliveryRepository, EventRepository, GenerationRepository, IdentityRepository, MemoryRepository, openAuthoritativeSqliteDatabase, OutputRepository, PrivacyRepository, RoomRepository } from '@proj-airi/memory-sqlite'

import { memoryPosture } from './feature-flags'
import { serializePromptContext } from './prompt-context'
import { resolveMemoryRuntimePaths } from './runtime-paths'

export interface MemoryRuntimeHealth {
  mode: MemoryMode
  state: string
  durableWritesEnabled: boolean
  promptUseEnabled: boolean
  status: 'off' | 'healthy'
  authority?: string
  backups?: string
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

  const paths = resolveMemoryRuntimePaths(options.repoRoot, options.configuredRoot)
  createRuntimeDirectories(paths)
  const handle = openAuthoritativeSqliteDatabase(paths.authority)
  const identities = new IdentityRepository(handle.database)
  const rooms = new RoomRepository(handle.database)
  const events = new EventRepository(handle.database)
  const generations = new GenerationRepository(handle.database)
  const causalEdges = new CausalEdgeRepository(handle.database)
  const outputs = new OutputRepository(handle.database)
  const deliveries = new DeliveryRepository(handle.database)
  const memories = new MemoryRepository(handle.database)
  const corrections = new CorrectionRepository(handle.database)
  const privacyRepository = new PrivacyRepository(handle.database)
  return {
    health: {
      mode: options.mode,
      state: posture.state,
      durableWritesEnabled: posture.durableWritesEnabled,
      promptUseEnabled: posture.promptUseEnabled,
      status: 'healthy',
      authority: paths.authority,
      backups: paths.backups,
    },
    ingress: {
      resolve: async (input) => {
        const targetScope = input.location.channelKind === 'dm'
          ? { kind: 'dm' as const, id: input.location.channelId }
          : { kind: 'guild' as const, id: input.location.guildId }
        // Both decisions precede the first repository call. A caller cannot
        // probe whether either an identity or room exists without its grants.
        assertAuthorized(input.authorization, { operation: 'identity:observe', targetScope })
        assertAuthorized(input.authorization, { operation: 'room:read', targetScope })

        if (input.actorEvidence.kind === 'anonymous') {
          if (input.location.channelKind === 'dm')
            throw new Error('DM ingress requires an attributable participant')
          rooms.observe({ location: input.location, observedAt: input.actorEvidence.actor.observedAt, displayName: input.displayName, parentChannelId: input.parentChannelId })
          const room = rooms.resolve(input.location, input.authorization.characterId, input.actorEvidence.actor.observedAt)
          return { actor: input.actorEvidence.actor, room }
        }

        const snapshot = input.actorEvidence.snapshot
        const observed = identities.observe({
          observationKey: input.observationKey,
          snapshotId: randomUUID(),
          discordUserId: snapshot.platformUserId,
          observedAt: snapshot.observedAt,
          displayNameAtEvent: snapshot.displayNameAtEvent,
          sourceEventType: snapshot.source === 'restFetch' ? 'restFetch' : 'gateway',
          completeness: snapshot.guildId ? 'member_partial' : 'user_partial',
          username: snapshot.username,
          globalName: snapshot.globalName,
          guildId: snapshot.guildId,
          guildNickname: snapshot.guildNickname,
        })
        const actor = attributedActor(observed.personId, snapshot)
        rooms.observe({
          location: input.location,
          observedAt: snapshot.observedAt,
          displayName: input.displayName,
          parentChannelId: input.parentChannelId,
          ...(input.location.channelKind === 'dm' ? { participantPersonId: observed.personId } : {}),
        })
        const room = rooms.resolve(input.location, input.authorization.characterId, snapshot.observedAt)
        return {
          actor,
          presentation: projectPresentation(actor),
          room,
        }
      },
    },
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
        return { generation: created.attempt, edges, deduplicated: created.deduplicated }
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
        const inbound = events.list({ logicalRoomId: request.logicalRoomId, physicalRoomId: request.physicalRoomId })
          .flatMap(event => event.payload.redacted || !event.payload.content
            ? []
            : [{ personRef: event.actor.kind === 'attributed' ? `P:${event.actor.personId}` : undefined, text: event.payload.content, at: event.occurredAt }])
        const assistant = deliveries.eligible(
          { logicalRoomId: request.logicalRoomId, physicalRoomId: request.physicalRoomId, characterId: request.characterId },
          { allowPartialAssistantOutput: false, treatCompletedPlaybackAsEligible: true },
        )
          .map(output => ({ text: output.text, at: output.attempt.lastTransitionAt }))
        const ordered = [...inbound, ...assistant]
          .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
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
        return { sentinel: 'ok' as const, ...serializePromptContext(selected, request.maxCharacters) }
      },
    },
    privacy: {
      execute: async (input) => {
        const location = input.channelKind === 'dm'
          ? { platform: 'discord' as const, channelId: input.channelId, channelKind: 'dm' as const }
          : { platform: 'discord' as const, guildId: input.guildId!, channelId: input.channelId, channelKind: input.channelKind }
        const targetScope = input.channelKind === 'dm' ? { kind: 'dm' as const, id: input.channelId } : { kind: 'guild' as const, id: input.guildId! }
        const ingressAuth = { principal: { botUserId: 'discord-bot', operations: ['identity:observe' as const, 'room:read' as const], scopes: [targetScope], operator: false }, characterId: asCharacterIdForPrivacy(options) }
        const resolved = await (createIngressForPrivacy(identities, rooms)).resolve({ authorization: ingressAuth, actorEvidence: input.actorEvidence, location, observationKey: `privacy:${input.discordUserId}:${input.observedAt}` })
        if (resolved.actor.kind !== 'attributed')
          throw new Error('Privacy operations require an attributable requester')
        const personId = resolved.actor.personId
        const now = asTimestamp(new Date(input.observedAt).toISOString())
        if (input.operation.kind === 'status') {
          const counts = privacyRepository.counts(personId, resolved.room.logicalRoomId)
          return { message: `Memory is ${options.mode}. This room has ${counts.events} requester event(s) and ${counts.facts} active explicit fact(s).` }
        }
        if (input.operation.kind === 'show' || input.operation.kind === 'export') {
          const payload = privacyRepository.export(personId, resolved.room.logicalRoomId)
          if (input.operation.kind === 'export')
            return { message: 'Your current-room memory export is attached.', attachment: { name: `memory-export-${input.observedAt}.json`, data: JSON.stringify(payload, null, 2) } }
          return { message: payload.facts.length ? payload.facts.map(fact => `${fact.factId}: ${fact.predicate} = ${fact.value}`).join('\n').slice(0, 1900) : 'No active explicit facts are stored for you in this room.' }
        }
        if (input.operation.kind === 'remember') {
          const event = events.append({ idempotencyKey: asRequestId(`privacy-remember:${input.discordUserId}:${input.observedAt}`), kind: 'command', actor: resolved.actor, physicalRoomId: resolved.room.physicalRoomId, logicalRoomId: resolved.room.logicalRoomId, occurredAt: now, payload: { content: `/memory remember ${input.operation.predicate}` }, retentionClass: 'command' }).envelope
          const factId = asFactId(stableTraceId('fact', `${event.eventId}:${input.operation.predicate}`))
          memories.createFact({ layer: 'semantic', factId, personId, scopeKind: 'logical_room', scopeId: resolved.room.logicalRoomId, predicate: input.operation.predicate, value: input.operation.value, confidence: asConfidence(1), provenance: { source: 'userStated', method: 'explicitCommand', sourceEventIds: [event.eventId], statedAt: now }, validity: { validFrom: now, recordedAt: now } })
          return { message: `Remembered in this room as fact ${factId}.` }
        }
        if (input.operation.kind === 'correct') {
          const previous = memories.getFact(asFactId(input.operation.factId))
          if (!previous || previous.personId !== personId || previous.scopeKind !== 'logical_room' || previous.scopeId !== resolved.room.logicalRoomId || previous.tombstonedBy)
            throw new Error('Fact was not found in your current room')
          const replacementId = asFactId(stableTraceId('fact-correction', `${previous.factId}:${input.observedAt}`))
          corrections.correct(stableTraceId('correction', `${previous.factId}:${input.observedAt}`), { previousFactId: previous.factId, factId: replacementId, value: input.operation.value, effectiveAt: now, recordedAt: now, provenance: { source: 'userStated', method: 'explicitCommand', sourceEventIds: previous.provenance.sourceEventIds, statedAt: now } })
          return { message: `Corrected ${previous.factId}; the replacement is ${replacementId}.` }
        }
        const requestId = stableTraceId('forget', `${personId}:${resolved.room.logicalRoomId}:${input.observedAt}`)
        privacyRepository.forget(requestId, personId, resolved.room.logicalRoomId, now)
        return { message: 'Forget completed and verified for your data in this room. A minimal deletion obligation was retained for backup restore.' }
      },
    },
    close: async () => handle.close(),
  }
}

function asCharacterIdForPrivacy(options: CreateMemoryRuntimeOptions) {
  return asCharacterId(`discord-memory-${options.mode}`)
}

function createIngressForPrivacy(identities: IdentityRepository, rooms: RoomRepository): IngressMemoryAuthority {
  return {
    resolve: async (input) => {
      assertAuthorized(input.authorization, { operation: 'identity:observe', targetScope: input.location.channelKind === 'dm' ? { kind: 'dm', id: input.location.channelId } : { kind: 'guild', id: input.location.guildId } })
      assertAuthorized(input.authorization, { operation: 'room:read', targetScope: input.location.channelKind === 'dm' ? { kind: 'dm', id: input.location.channelId } : { kind: 'guild', id: input.location.guildId } })
      if (input.actorEvidence.kind === 'anonymous')
        throw new Error('Privacy operations require identity')
      const snapshot = input.actorEvidence.snapshot
      const observed = identities.observe({ observationKey: input.observationKey, snapshotId: randomUUID(), discordUserId: snapshot.platformUserId, observedAt: snapshot.observedAt, displayNameAtEvent: snapshot.displayNameAtEvent, sourceEventType: 'gateway', completeness: snapshot.guildId ? 'member_partial' : 'user_partial', username: snapshot.username, globalName: snapshot.globalName, guildId: snapshot.guildId, guildNickname: snapshot.guildNickname })
      const actor = attributedActor(observed.personId, snapshot)
      rooms.observe({ location: input.location, observedAt: snapshot.observedAt, ...(input.location.channelKind === 'dm' ? { participantPersonId: observed.personId } : {}) })
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
