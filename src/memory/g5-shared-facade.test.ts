import type { VoiceInputEvent } from '../orchestration/events'

import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId, asRequestId, asTimestamp, isolatedLogicalRoomId, physicalRoomIdOf } from '@proj-airi/memory-domain'
import { openReadOnlySqliteDatabase } from '@proj-airi/memory-sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'
import { createTextMemoryAdapter } from './text-memory-adapter'
import { createVoiceMemoryAdapter } from './voice-memory-adapter'

/**
 * G5 pass condition 1 — "both adapters use the same authorized facade".
 *
 * Controlling text: artifact 21 §11.2 G5, as amended on 2026-08-13. The original
 * condition also required both adapters to agree on a declared *contract
 * version*; the gate owner dropped that half for M1, because `MemoryPort` and
 * `MEMORY_PORT_CONTRACT_VERSION` are declared in `memory-domain` and implemented
 * by nothing — the Discord runtime composes its own authority surface instead.
 * What survives is the property the version was only ever a proxy for: there is
 * one authority, both modalities go through it, and it is authorized.
 *
 * Existing tests were not sufficient for this condition. `sqlite-boundary.test.ts`
 * proves only that one *module* may import the persistence package, which is an
 * import-graph fact; the per-adapter fail-closed tests each prove something about
 * one adapter in isolation. Neither asserts that text and voice share one facade,
 * which is the condition itself. A test that merely observed both adapters
 * writing successfully would not assert it either — they could each hold a
 * private authority and both still succeed.
 */

const characterId = asCharacterId('kurisu')
const GUILD_ID = '10000000000000001'
const TEXT_CHANNEL_ID = '30000000000000001'
const VOICE_CHANNEL_ID = '70000000000000001'
const USER_ID = '20000000000000001'
const OBSERVED_AT = 1_785_600_000_000

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function runtimeFor(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
}

const actorEvidence = () => buildDiscordActorEvidence({ userId: USER_ID, displayName: 'Alex', guildId: GUILD_ID, observedAtEpochMs: OBSERVED_AT, source: 'gateway' })

function mention(messageId: string, text: string) {
  return {
    type: 'discord-mention' as const,
    eventId: `${messageId}:in`,
    turnId: messageId,
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    userId: USER_ID,
    displayName: 'Alex',
    actorEvidence: actorEvidence(),
    timestamp: OBSERVED_AT,
    messageId,
    text,
  }
}

function utterance(eventId: string): VoiceInputEvent {
  return {
    type: 'voice',
    eventId: `${eventId}:voice`,
    turnId: eventId,
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    voiceChannelId: VOICE_CHANNEL_ID,
    userId: USER_ID,
    displayName: 'Alex',
    actorEvidence: actorEvidence(),
    timestamp: OBSERVED_AT,
    pcm: Buffer.alloc(0),
    sampleRate: 16000,
  }
}

describe('g5 condition 1 — text and voice share one authorized facade', () => {
  it('routes both modalities through one authority instance and one durable store', async () => {
    const runtime = runtimeFor('airi-g5-facade-')
    // One spy on ONE runtime object. Both adapters are constructed from that
    // object; if either held a private authority, its admission would not appear
    // here — and the assertion below names both idempotency keys, so a single
    // adapter satisfying it twice cannot pass.
    const appendEvent = vi.spyOn(runtime.trace!, 'appendEvent')
    const text = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const voice = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })

    const typed = mention('40000000000000201', 'typed question')
    await text.admit(typed, { isDirectMessage: false, isThread: false })
    const spoken = utterance('60000000000000201')
    await voice.admit(spoken, 'spoken question')

    const keys = appendEvent.mock.calls.map(call => call[1].idempotencyKey)
    expect(keys).toContain(`message:${typed.messageId}`)
    expect(keys).toContain(`voice:${spoken.eventId}`)

    // …and both landed in the one authority the runtime reports, not in two.
    const authority = runtime.health.authority!
    await runtime.close()
    const db = openReadOnlySqliteDatabase(authority)
    const kinds = (db.prepare('SELECT event_kind FROM inbound_event_records ORDER BY event_kind').all() as Array<{ event_kind: string }>).map(row => row.event_kind)
    db.close()
    expect(kinds).toEqual(['user_text', 'user_voice'])
  })

  it('fails both adapters closed when the shared facade goes away, so neither holds a private durable path', async () => {
    const runtime = runtimeFor('airi-g5-facade-closed-')
    const text = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const voice = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    await runtime.close()

    // One closure disables both. An adapter with its own store would still write.
    await expect(text.admit(mention('40000000000000202', 'typed'), { isDirectMessage: false, isThread: false })).rejects.toThrow()
    await expect(voice.admit(utterance('60000000000000202'), 'spoken')).rejects.toThrow()
  })

  it('refuses an unauthorized caller on the shared facade, so it is authorized and not merely shared', async () => {
    const runtime = runtimeFor('airi-g5-facade-auth-')
    const physicalRoomId = physicalRoomIdOf({ platform: 'discord', guildId: GUILD_ID, channelId: TEXT_CHANNEL_ID, channelKind: 'guildText' })
    const logicalRoomId = isolatedLogicalRoomId(physicalRoomId, characterId)
    // A principal holding `context:read` only — the shape a compromised or
    // mis-wired caller would present when reaching for a write.
    const readOnly = { principal: { botUserId: 'discord-bot', operations: ['context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: logicalRoomId }], operator: false }, characterId, logicalRoomId }

    await expect(runtime.trace!.appendEvent(readOnly, {
      idempotencyKey: asRequestId('message:unauthorized'),
      kind: 'user_text',
      actor: { kind: 'anonymous', displayNameAtEvent: 'Alex', observedAt: asTimestamp(new Date(OBSERVED_AT).toISOString()), reason: 'missingUserId' },
      physicalRoomId,
      logicalRoomId,
      occurredAt: asTimestamp(new Date(OBSERVED_AT).toISOString()),
      payload: { content: 'should never persist' },
      retentionClass: 'transcript',
    })).rejects.toMatchObject({
      // Pinned to the denial specifically: a bare `toThrow` would also be
      // satisfied by a validation or persistence error, which would prove
      // nothing about the facade being authorized.
      name: 'MemoryError',
      code: 'UNAUTHORIZED_WRITE',
      details: { operation: 'event:write' },
    })

    // Denial precedes persistence: nothing was written on the way to the refusal.
    const authority = runtime.health.authority!
    await runtime.close()
    const db = openReadOnlySqliteDatabase(authority)
    expect(db.prepare('SELECT COUNT(*) count FROM inbound_event_records').get()).toEqual({ count: 0 })
    db.close()
  })
})
