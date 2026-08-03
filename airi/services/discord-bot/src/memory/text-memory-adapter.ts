import type { AuthorizationContext, CharacterId, DeliveryAttempt, GenerationAttempt, InboundEventEnvelope, RoomResolution } from '@proj-airi/memory-domain'

import type { DiscordMentionInputEvent } from '../orchestration/events'
import type { MemoryRuntime } from './runtime'
import type { DiscordTextContextProvider, DiscordTextMemoryObserver, TextIngressContext } from './text-observer'

import { asPersonId, asRequestId, asSegmentId, timestampFromEpochMs } from '@proj-airi/memory-domain'

interface TextTrace {
  authorization: AuthorizationContext
  event: InboundEventEnvelope
  room: RoomResolution
  generation?: GenerationAttempt
  deliveries: DeliveryAttempt[]
}

export interface TextMemoryAdapterOptions {
  readonly runtime: MemoryRuntime
  readonly characterId: CharacterId
  readonly modelRef: string
  readonly onFailure?: (error: unknown) => void
}

/** Creates the shared text shadow adapter; failures are observable but never reported as durable success. */
export function createTextMemoryAdapter(options: TextMemoryAdapterOptions): DiscordTextMemoryObserver & DiscordTextContextProvider {
  const traces = new Map<string, TextTrace>()
  const fail = (event: DiscordMentionInputEvent, error: unknown): void => {
    traces.delete(event.turnId)
    options.onFailure?.(error)
  }

  return {
    contextFor: async (event) => {
      const trace = traces.get(event.turnId)
      if (!trace || !options.runtime.context || !options.runtime.health.promptUseEnabled)
        return undefined
      const result = await boundedContext(options.runtime.context.assembleRecent({
        authorization: trace.authorization,
        logicalRoomId: trace.room.logicalRoomId,
        physicalRoomId: trace.room.physicalRoomId,
        characterId: options.characterId,
        maxItems: 24,
        maxCharacters: 8_000,
      }), 250)
      if (result.sentinel !== 'ok')
        throw new Error('Required durable recent context is unavailable')
      return result.text
    },
    admit: async (event, context) => {
      if (!options.runtime.ingress || !options.runtime.trace)
        return
      try {
        const location = locationOf(event, context)
        const ingressAuthorization: AuthorizationContext = {
          principal: {
            botUserId: 'discord-bot',
            operations: ['identity:observe', 'room:read'],
            scopes: [{ kind: context.isDirectMessage ? 'dm' : 'guild', id: context.isDirectMessage ? event.channelId : event.guildId }],
            operator: false,
          },
          characterId: options.characterId,
          ...(context.isDirectMessage ? { dmParticipants: [] } : {}),
        }
        // DM authorization needs a participant assertion; the durable identity
        // is resolved by this call and is used for every subsequent operation.
        if (context.isDirectMessage)
          ingressAuthorization.dmParticipants = [asPersonId('requester')]
        const resolved = await options.runtime.ingress.resolve({ authorization: ingressAuthorization, actorEvidence: event.actorEvidence, location, observationKey: `message:${event.messageId}` })
        const authorization: AuthorizationContext = {
          principal: { botUserId: 'discord-bot', operations: ['event:write', 'draft:write', 'delivery:write', 'context:read'], scopes: [{ kind: 'logical_room', id: resolved.room.logicalRoomId }], operator: false },
          characterId: options.characterId,
          logicalRoomId: resolved.room.logicalRoomId,
          ...(resolved.actor.kind === 'attributed' && context.isDirectMessage ? { dmParticipants: [resolved.actor.personId] } : {}),
        }
        const appended = await options.runtime.trace.appendEvent(authorization, {
          idempotencyKey: asRequestId(`message:${event.messageId}`),
          kind: 'user_text',
          actor: resolved.actor,
          physicalRoomId: resolved.room.physicalRoomId,
          logicalRoomId: resolved.room.logicalRoomId,
          occurredAt: timestampFromEpochMs(event.timestamp),
          payload: { content: event.text.trim() || '(empty mention)' },
          retentionClass: 'transcript',
        })
        traces.set(event.turnId, { authorization, event: appended.envelope, room: resolved.room, deliveries: [] })
      }
      catch (error) { fail(event, error) }
    },
    generated: async (event, chunks) => {
      const trace = traces.get(event.turnId)
      if (!trace || !options.runtime.trace)
        return
      try {
        const at = timestampFromEpochMs(Date.now())
        const begun = await options.runtime.trace.beginGeneration(trace.authorization, {
          idempotencyKey: asRequestId(`generation:${event.turnId}`),
          logicalRoomId: trace.room.logicalRoomId,
          characterId: options.characterId,
          causes: [{ inboundEventId: trace.event.eventId, role: 'trigger' }],
          evidence: { observedRoomVersion: 1, observedEventIds: [trace.event.eventId], contextManifestHash: 'shadow:no-prompt-read', observedBindingVersion: trace.room.bindingVersion, capturedAt: at },
          modelRef: options.modelRef,
          startedAt: at,
        })
        trace.generation = begun.generation
        const segments = await options.runtime.trace.appendSegments(trace.authorization, begun.generation, chunks.map((text, ordinal) => ({ segmentId: asSegmentId(`text:${event.messageId}:${ordinal}`), ordinal, modality: 'text', text })))
        for (const segment of segments) {
          const delivery = await options.runtime.trace.beginDelivery(trace.authorization, { segmentId: segment.segmentId, transport: 'discord_text', destinationId: event.channelId ?? event.messageId, idempotencyKey: asRequestId(`text-delivery:${event.messageId}:${segment.ordinal}`), startedAt: at })
          trace.deliveries.push(await options.runtime.trace.transitionDelivery(trace.authorization, { deliveryId: delivery.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at }))
        }
      }
      catch (error) { fail(event, error) }
    },
    delivered: async (event, messageIds) => {
      const trace = traces.get(event.turnId)
      if (!trace || !options.runtime.trace)
        return
      try {
        const at = timestampFromEpochMs(Date.now())
        for (const [index, delivery] of trace.deliveries.entries()) {
          const messageId = messageIds[index]
          await options.runtime.trace.transitionDelivery(trace.authorization, { deliveryId: delivery.deliveryId, from: 'delivering', to: messageId ? 'delivered' : 'failed', evidence: messageId ? { kind: 'platformMessageId', platformMessageId: messageId } : { kind: 'transportError', errorClass: 'missing-send-receipt' }, at })
        }
        traces.delete(event.turnId)
      }
      catch (error) { fail(event, error) }
    },
    failed: async (event, error) => {
      const trace = traces.get(event.turnId)
      if (trace && options.runtime.trace) {
        const at = timestampFromEpochMs(Date.now())
        for (const delivery of trace.deliveries) {
          try {
            await options.runtime.trace.transitionDelivery(trace.authorization, { deliveryId: delivery.deliveryId, from: 'delivering', to: 'failed', evidence: { kind: 'transportError', errorClass: 'discord-send-failed' }, at })
          }
          catch (transitionError) { options.onFailure?.(transitionError) }
        }
      }
      fail(event, error)
    },
  }
}

async function boundedContext<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Durable context deadline exceeded')), timeoutMs)
    })
    return await Promise.race([operation, deadline])
  }
  finally {
    if (timer)
      clearTimeout(timer)
  }
}

function locationOf(event: DiscordMentionInputEvent, context: TextIngressContext) {
  if (context.isDirectMessage)
    return { platform: 'discord' as const, channelId: event.channelId ?? event.userId, channelKind: 'dm' as const }
  return { platform: 'discord' as const, guildId: event.guildId!, channelId: event.channelId ?? event.messageId, channelKind: context.isThread ? 'thread' as const : 'guildText' as const }
}
