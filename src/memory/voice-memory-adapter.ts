import type { AuthorizationContext, CharacterId, DeliveryAttempt, GenerationAttempt, InboundEventEnvelope, OutputSegment, RoomResolution } from '@proj-airi/memory-domain'

import type { VoiceInputEvent } from '../orchestration/events'
import type { PlaybackResult } from '../voice/playback'
import type { MemoryRuntime } from './runtime'
import type { PreparedModelMemory } from './text-observer'

import { asRequestId, asSegmentId, timestampFromEpochMs } from '@proj-airi/memory-domain'

import { recentManifestOfLayered } from './context-authority'

interface VoiceTrace {
  authorization: AuthorizationContext
  event: InboundEventEnvelope
  room: RoomResolution
  guildId: string
}

interface GenerationTrace {
  authorization: AuthorizationContext
  generation: GenerationAttempt
  room: RoomResolution
  deliveries: Map<number, DeliveryAttempt>
  /**
   * Every output segment declared for this generation so far, keyed by chunk
   * ordinal. Voice arrives one played chunk at a time but the durable output
   * set is declared as a whole, so each append needs the chunks before it.
   */
  segments: Map<number, Omit<OutputSegment, 'generationId'>>
  sourceEventIds: readonly string[]
}

export interface VoiceMemoryAdapter {
  admit: (event: VoiceInputEvent, transcript: string) => Promise<void>
  prepareGeneration: (turnId: string, events: readonly VoiceInputEvent[]) => Promise<PreparedModelMemory>
  recordPlayback: (turnId: string, channelId: string, chunkIndex: number, text: string, result: PlaybackResult) => Promise<void>
  completeGeneration: (turnId: string) => Promise<void>
  cancelGeneration: (turnId: string) => Promise<void>
  failGeneration: (turnId: string) => Promise<void>
  endSession: (guildId: string) => Promise<void>
}

/** Shared voice trace adapter. Only completed local playback can become voice context. */
export function createVoiceMemoryAdapter(options: { runtime: MemoryRuntime, characterId: CharacterId, modelRef: string, onFailure?: (error: unknown) => void }): VoiceMemoryAdapter {
  const events = new Map<string, VoiceTrace>()
  const generations = new Map<string, GenerationTrace>()
  const eventExpiry = new Map<string, NodeJS.Timeout>()
  const generationExpiry = new Map<string, NodeJS.Timeout>()
  const safe = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work()
    }
    catch (error) {
      options.onFailure?.(error)
      if (options.runtime.health.state === 'durableActive')
        throw error
    }
  }
  return {
    admit: async (event, transcript) => safe(async () => {
      // Degraded posture: the same deferred write path the text adapter uses,
      // through the same shared runtime. Voice has no separate spool and no
      // separate authority, so a degraded voice turn and a degraded text turn
      // land in one ordered stream and recover together.
      const deferred = options.runtime.deferred
      if (deferred) {
        await deferred.spoolInboundEvent({
          idempotencyKey: `voice:${event.eventId}`,
          observationKey: `voice:${event.eventId}`,
          kind: 'user_voice',
          actorEvidence: event.actorEvidence,
          location: { platform: 'discord', guildId: event.guildId!, channelId: event.voiceChannelId, channelKind: 'guildVoice' },
          occurredAt: timestampFromEpochMs(event.timestamp),
          content: transcript,
          retentionClass: 'transcript',
        })
        return
      }
      if (!options.runtime.ingress || !options.runtime.trace) {
        if (options.runtime.health.state === 'durableActive')
          throw new Error('Required durable voice admission authority is unavailable')
        return
      }
      const target = { kind: 'guild' as const, id: event.guildId! }
      const ingress = await options.runtime.ingress.resolve({
        authorization: { principal: { botUserId: 'discord-bot', operations: ['identity:observe', 'room:read'], scopes: [target], operator: false }, characterId: options.characterId },
        actorEvidence: event.actorEvidence,
        location: { platform: 'discord', guildId: event.guildId!, channelId: event.voiceChannelId, channelKind: 'guildVoice' },
        observationKey: `voice:${event.eventId}`,
      })
      const authorization: AuthorizationContext = {
        principal: { botUserId: 'discord-bot', operations: ['event:write', 'draft:write', 'delivery:write', 'context:read'], scopes: [{ kind: 'logical_room', id: ingress.room.logicalRoomId }], operator: false },
        characterId: options.characterId,
        logicalRoomId: ingress.room.logicalRoomId,
      }
      const appended = await options.runtime.trace.appendEvent(authorization, {
        idempotencyKey: asRequestId(`voice:${event.eventId}`),
        kind: 'user_voice',
        actor: ingress.actor,
        physicalRoomId: ingress.room.physicalRoomId,
        logicalRoomId: ingress.room.logicalRoomId,
        occurredAt: timestampFromEpochMs(event.timestamp),
        payload: { content: transcript },
        retentionClass: 'transcript',
      })
      events.set(event.eventId, { authorization, event: appended.envelope, room: ingress.room, guildId: event.guildId! })
      const expiry = setTimeout(() => {
        events.delete(event.eventId)
        eventExpiry.delete(event.eventId)
      }, 5 * 60_000)
      expiry.unref()
      eventExpiry.set(event.eventId, expiry)
    }),
    prepareGeneration: async (turnId, sourceEvents) => {
      let prepared: PreparedModelMemory = { context: { status: 'disabled' } }
      await safe(async () => {
        if (!options.runtime.trace) {
          if (options.runtime.health.state === 'durableActive')
            throw new Error('Required durable voice generation authority is unavailable')
          return
        }
        const traces = sourceEvents.map(event => events.get(event.eventId))
        if (traces.some(trace => trace == null))
          throw new Error('Every grouped voice source must have a durable trace')
        const resolved = traces as VoiceTrace[]
        const first = resolved[0]
        if (!first) {
          if (options.runtime.health.state === 'durableActive')
            throw new Error('Required durable voice generation causality is unavailable')
          return
        }
        if (resolved.some(trace => trace.room.logicalRoomId !== first.room.logicalRoomId))
          throw new Error('Grouped voice sources resolved to mixed logical rooms')
        const layered = options.runtime.health.promptUseEnabled && options.runtime.health.layeredContextEnabled && options.runtime.context
          ? await boundedVoiceContext(options.runtime.context.assembleLayered({ authorization: first.authorization, logicalRoomId: first.room.logicalRoomId, physicalRoomId: first.room.physicalRoomId, characterId: options.characterId, query: resolved.flatMap(trace => trace.event.payload.content ? [trace.event.payload.content] : []).join('\n'), exactPredicates: [], includeLayers: ['recent', 'summary', 'semantic', 'episodic'], maxItems: 24, maxCharacters: 8_000, excludeEventIds: resolved.map(trace => trace.event.eventId) }), 250)
          : undefined
        const recent = options.runtime.health.promptUseEnabled && !layered && options.runtime.context
          ? await boundedVoiceContext(options.runtime.context.assembleRecent({ authorization: first.authorization, logicalRoomId: first.room.logicalRoomId, physicalRoomId: first.room.physicalRoomId, characterId: options.characterId, maxItems: 24, maxCharacters: 8_000, excludeEventIds: resolved.map(trace => trace.event.eventId) }), 250)
          : undefined
        const selected = layered ?? recent
        if (options.runtime.health.promptUseEnabled && (!selected || selected.sentinel !== 'ok'))
          throw new Error('Required durable voice context is unavailable')
        const at = timestampFromEpochMs(Date.now())
        const manifest = layered ? recentManifestOfLayered(layered.manifest) : recent ? { formatVersion: recent.manifest.formatVersion, logicalRoomVersion: recent.manifest.logicalRoomVersion, bindingRevision: recent.manifest.bindingRevision, maxItems: recent.manifest.maxItems, maxCharacters: recent.manifest.maxCharacters, candidateReadLimit: recent.manifest.candidateReadLimit, truncated: recent.manifest.truncated, items: recent.manifest.selected } : { formatVersion: 1 as const, logicalRoomVersion: Math.max(...resolved.map(trace => trace.event.roomVersion ?? 0)), bindingRevision: first.room.bindingVersion, maxItems: 0, maxCharacters: 0, candidateReadLimit: 0, truncated: false, items: [] }
        const begun = await options.runtime.trace.beginGeneration(first.authorization, {
          idempotencyKey: asRequestId(`voice-generation:${turnId}`),
          logicalRoomId: first.room.logicalRoomId,
          characterId: options.characterId,
          causes: resolved.map((trace, index) => ({ inboundEventId: trace.event.eventId, role: index === 0 ? 'trigger' as const : 'context' as const })),
          evidence: { observedRoomVersion: manifest.logicalRoomVersion, observedEventIds: [...resolved.map(trace => trace.event.eventId), ...manifest.items.flatMap(item => item.sourceType === 'inbound' ? [item.eventId] : [])], contextManifestHash: '', contextManifest: manifest, ...(layered ? { layeredContextManifest: layered.manifest, layeredContextManifestHash: '' } : {}), observedBindingVersion: manifest.bindingRevision, capturedAt: at },
          modelRef: options.modelRef,
          startedAt: at,
        })
        generations.set(turnId, { authorization: first.authorization, generation: begun.generation, room: first.room, deliveries: new Map(), segments: new Map(), sourceEventIds: sourceEvents.map(event => event.eventId) })
        const expiry = setTimeout(() => void terminalGeneration(turnId, 'failed'), 5 * 60_000)
        expiry.unref()
        generationExpiry.set(turnId, expiry)
        prepared = { context: selected ? { status: 'available', text: selected.text } : { status: 'disabled' }, generation: begun.generation }
      })
      return prepared
    },
    recordPlayback: async (turnId, channelId, chunkIndex, text, result) => safe(async () => {
      const trace = generations.get(turnId)
      if (!trace || !options.runtime.trace)
        return
      const at = timestampFromEpochMs(Date.now())

      // The authority stores an output set, not an append log: every call must
      // declare the generation's complete segment set, and one that omits an
      // already-stored segment is refused as a mismatched retry. Voice can only
      // declare a chunk once it has actually been heard, so the set grows one
      // ordinal per playback and is re-declared in full each time.
      trace.segments.set(chunkIndex, { segmentId: asSegmentId(`voice:${turnId}:${chunkIndex}`), ordinal: chunkIndex, modality: 'voice', text })
      const declared = [...trace.segments.values()].sort((left, right) => left.ordinal - right.ordinal)
      const stored = await options.runtime.trace.appendSegments(trace.authorization, trace.generation, declared)
      const segment = stored.find(candidate => candidate.ordinal === chunkIndex)
      if (!segment)
        throw new Error('Durable voice output segment is missing from the generation set it was just appended to')

      let delivery = trace.deliveries.get(chunkIndex)
      if (!delivery) {
        delivery = await options.runtime.trace.beginDelivery(trace.authorization, { segmentId: segment.segmentId, transport: 'discord_voice', destinationId: channelId, idempotencyKey: asRequestId(`voice-delivery:${turnId}:${chunkIndex}`), startedAt: at })
        delivery = await options.runtime.trace.transitionDelivery(trace.authorization, { deliveryId: delivery.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at })
        trace.deliveries.set(chunkIndex, delivery)
      }
      const to = result.status === 'played' ? 'unheard' : result.status === 'failed' ? 'failed' : 'interrupted'
      const evidence = result.status === 'played' ? { kind: 'localPlaybackCompleted' as const, deliveredRange: { characters: text.length, playedMs: result.durationMs } } : { kind: 'transportError' as const, errorClass: `playback-${result.status}` }
      await options.runtime.trace.transitionDelivery(trace.authorization, { deliveryId: delivery.deliveryId, from: 'delivering', to, evidence, at })
    }),
    completeGeneration: async turnId => terminalGeneration(turnId, 'persisted'),
    cancelGeneration: async turnId => terminalGeneration(turnId, 'cancelled'),
    failGeneration: async turnId => terminalGeneration(turnId, 'failed'),
    endSession: async (guildId) => {
      for (const [turnId, trace] of generations) {
        if (trace.sourceEventIds.some(eventId => events.get(eventId)?.guildId === guildId))
          await terminalGeneration(turnId, 'cancelled')
      }
      for (const [eventId, trace] of events) {
        if (trace.guildId === guildId) {
          events.delete(eventId)
          clearTimeout(eventExpiry.get(eventId))
          eventExpiry.delete(eventId)
        }
      }
    },
  }

  async function terminalGeneration(turnId: string, terminal: 'persisted' | 'cancelled' | 'failed'): Promise<void> {
    await safe(async () => {
      const trace = generations.get(turnId)
      if (!trace || !options.runtime.trace)
        return
      const at = timestampFromEpochMs(Date.now())
      if (terminal === 'persisted') {
        const generated = await options.runtime.trace.transitionGeneration(trace.authorization, trace.generation, 'running', 'generated', at)
        await options.runtime.trace.transitionGeneration(trace.authorization, generated, 'generated', 'persisted', at)
      }
      else {
        await options.runtime.trace.transitionGeneration(trace.authorization, trace.generation, 'running', terminal, at)
      }
      for (const eventId of trace.sourceEventIds)
        events.delete(eventId)
      for (const eventId of trace.sourceEventIds) {
        clearTimeout(eventExpiry.get(eventId))
        eventExpiry.delete(eventId)
      }
      generations.delete(turnId)
      clearTimeout(generationExpiry.get(turnId))
      generationExpiry.delete(turnId)
    })
  }
}

async function boundedVoiceContext<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Durable voice context deadline exceeded')), timeoutMs)
    })
    return await Promise.race([operation, deadline])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}
