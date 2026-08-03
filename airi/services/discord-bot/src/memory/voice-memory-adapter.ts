import type { AuthorizationContext, CharacterId, DeliveryAttempt, GenerationAttempt, InboundEventEnvelope, RoomResolution } from '@proj-airi/memory-domain'

import type { VoiceInputEvent } from '../orchestration/events'
import type { PlaybackResult } from '../voice/playback'
import type { MemoryRuntime } from './runtime'

import { asRequestId, asSegmentId, timestampFromEpochMs } from '@proj-airi/memory-domain'

interface VoiceTrace {
  authorization: AuthorizationContext
  event: InboundEventEnvelope
  room: RoomResolution
}

interface GenerationTrace {
  authorization: AuthorizationContext
  generation: GenerationAttempt
  room: RoomResolution
  deliveries: Map<number, DeliveryAttempt>
}

export interface VoiceMemoryAdapter {
  admit: (event: VoiceInputEvent, transcript: string) => Promise<void>
  beginGeneration: (turnId: string, events: readonly VoiceInputEvent[]) => Promise<void>
  contextFor: (event: VoiceInputEvent) => Promise<string | undefined>
  recordPlayback: (turnId: string, channelId: string, chunkIndex: number, text: string, result: PlaybackResult) => Promise<void>
  failGeneration: (turnId: string) => Promise<void>
}

/** Shared voice trace adapter. Only completed local playback can become voice context. */
export function createVoiceMemoryAdapter(options: { runtime: MemoryRuntime, characterId: CharacterId, modelRef: string, onFailure?: (error: unknown) => void }): VoiceMemoryAdapter {
  const events = new Map<string, VoiceTrace>()
  const generations = new Map<string, GenerationTrace>()
  const safe = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work()
    }
    catch (error) {
      options.onFailure?.(error)
    }
  }
  return {
    admit: async (event, transcript) => safe(async () => {
      if (!options.runtime.ingress || !options.runtime.trace)
        return
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
      events.set(event.eventId, { authorization, event: appended.envelope, room: ingress.room })
    }),
    beginGeneration: async (turnId, sourceEvents) => safe(async () => {
      if (!options.runtime.trace)
        return
      const traces = sourceEvents.map(event => events.get(event.eventId)).filter((trace): trace is VoiceTrace => trace != null)
      const first = traces[0]
      if (!first)
        return
      const at = timestampFromEpochMs(Date.now())
      const begun = await options.runtime.trace.beginGeneration(first.authorization, {
        idempotencyKey: asRequestId(`voice-generation:${turnId}`),
        logicalRoomId: first.room.logicalRoomId,
        characterId: options.characterId,
        causes: traces.map((trace, index) => ({ inboundEventId: trace.event.eventId, role: index === 0 ? 'trigger' as const : 'context' as const })),
        evidence: { observedRoomVersion: 1, observedEventIds: traces.map(trace => trace.event.eventId), contextManifestHash: 'voice:authorized-recent', observedBindingVersion: first.room.bindingVersion, capturedAt: at },
        modelRef: options.modelRef,
        startedAt: at,
      })
      generations.set(turnId, { authorization: first.authorization, generation: begun.generation, room: first.room, deliveries: new Map() })
    }),
    contextFor: async (event) => {
      const trace = events.get(event.eventId)
      if (!trace || !options.runtime.context || !options.runtime.health.promptUseEnabled)
        return undefined
      const selected = await boundedVoiceContext(options.runtime.context.assembleRecent({ authorization: trace.authorization, logicalRoomId: trace.room.logicalRoomId, physicalRoomId: trace.room.physicalRoomId, characterId: options.characterId, maxItems: 24, maxCharacters: 8_000 }), 250)
      if (selected.sentinel !== 'ok')
        throw new Error('Required durable voice context is unavailable')
      return selected.text
    },
    recordPlayback: async (turnId, channelId, chunkIndex, text, result) => safe(async () => {
      const trace = generations.get(turnId)
      if (!trace || !options.runtime.trace)
        return
      const at = timestampFromEpochMs(Date.now())
      const [segment] = await options.runtime.trace.appendSegments(trace.authorization, trace.generation, [{ segmentId: asSegmentId(`voice:${turnId}:${chunkIndex}`), ordinal: chunkIndex, modality: 'voice', text }])
      let delivery = trace.deliveries.get(chunkIndex)
      if (!delivery) {
        delivery = await options.runtime.trace.beginDelivery(trace.authorization, { segmentId: segment!.segmentId, transport: 'discord_voice', destinationId: channelId, idempotencyKey: asRequestId(`voice-delivery:${turnId}:${chunkIndex}`), startedAt: at })
        delivery = await options.runtime.trace.transitionDelivery(trace.authorization, { deliveryId: delivery.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at })
        trace.deliveries.set(chunkIndex, delivery)
      }
      const to = result.status === 'played' ? 'unheard' : result.status === 'failed' ? 'failed' : 'interrupted'
      const evidence = result.status === 'played' ? { kind: 'localPlaybackCompleted' as const, deliveredRange: { characters: text.length, playedMs: result.durationMs } } : { kind: 'transportError' as const, errorClass: `playback-${result.status}` }
      await options.runtime.trace.transitionDelivery(trace.authorization, { deliveryId: delivery.deliveryId, from: 'delivering', to, evidence, at })
    }),
    failGeneration: async (turnId) => { generations.delete(turnId) },
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
