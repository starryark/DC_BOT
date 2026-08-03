import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId, isolatedLogicalRoomId, physicalRoomIdOf } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'
import { createTextMemoryAdapter } from './text-memory-adapter'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

describe('shared text memory adapter', () => {
  it('records actual Discord delivery and keeps shadow failures out of the response path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-'))
    roots.push(root)
    const runtime = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: root, characterId: asCharacterId('kurisu') })
    const characterId = asCharacterId('kurisu')
    const failure = vi.fn()
    const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure: failure })
    const event = {
      type: 'discord-mention' as const,
      eventId: '40000000000000001:in',
      turnId: '40000000000000001',
      guildId: '10000000000000001',
      channelId: '30000000000000001',
      userId: '20000000000000001',
      displayName: 'Alex',
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
      timestamp: 1_785_600_000_000,
      messageId: '40000000000000001',
      text: 'hello',
    }
    await adapter.admit(event, { isDirectMessage: false, isThread: false })
    await adapter.beginGeneration(event)
    await adapter.generated(event, ['reply'])
    await adapter.delivering(event, 0)
    await adapter.deliveredSegment(event, 0, '50000000000000001')
    await adapter.delivered(event)
    expect(failure).not.toHaveBeenCalled()

    const location = { platform: 'discord' as const, guildId: event.guildId, channelId: event.channelId, channelKind: 'guildText' as const }
    const physicalRoomId = physicalRoomIdOf(location)
    const logicalRoomId = isolatedLogicalRoomId(physicalRoomId, characterId)
    const authorization = { principal: { botUserId: 'discord-bot', operations: ['context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: logicalRoomId }], operator: false }, characterId, logicalRoomId }
    const context = await runtime.context!.assembleRecent({ authorization, logicalRoomId, physicalRoomId, characterId, maxItems: 10, maxCharacters: 500 })
    expect(context.text).toContain('hello')
    expect(context.text).toContain('reply')
    await runtime.close()
  })

  it('fails closed when active admission cannot reach the durable authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-active-'))
    roots.push(root)
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId: asCharacterId('kurisu') })
    const adapter = createTextMemoryAdapter({ runtime, characterId: asCharacterId('kurisu'), modelRef: 'test/model' })
    await runtime.close()
    const event = {
      type: 'discord-mention' as const,
      eventId: '40000000000000002:in',
      turnId: '40000000000000002',
      guildId: '10000000000000001',
      channelId: '30000000000000001',
      userId: '20000000000000001',
      displayName: 'Alex',
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
      timestamp: 1_785_600_000_000,
      messageId: '40000000000000002',
      text: 'hello',
    }

    await expect(adapter.admit(event, { isDirectMessage: false, isThread: false })).rejects.toThrow()
  })

  it('preserves a delivered first segment when the second Discord send fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-partial-'))
    roots.push(root)
    const characterId = asCharacterId('kurisu')
    const runtime = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: root, characterId })
    const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const event = {
      type: 'discord-mention' as const,
      eventId: '40000000000000003:in',
      turnId: '40000000000000003',
      guildId: '10000000000000001',
      channelId: '30000000000000001',
      userId: '20000000000000001',
      displayName: 'Alex',
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: Date.now(), source: 'gateway' }),
      timestamp: Date.now(),
      messageId: '40000000000000003',
      text: 'hello',
    }
    await adapter.admit(event, { isDirectMessage: false, isThread: false })
    await adapter.beginGeneration(event)
    await adapter.generated(event, ['delivered first', 'failed second'])
    await adapter.delivering(event, 0)
    await adapter.deliveredSegment(event, 0, '50000000000000003')
    await adapter.delivering(event, 1)
    await adapter.failed(event, new Error('second send failed'))

    const location = { platform: 'discord' as const, guildId: event.guildId, channelId: event.channelId, channelKind: 'guildText' as const }
    const physicalRoomId = physicalRoomIdOf(location)
    const logicalRoomId = isolatedLogicalRoomId(physicalRoomId, characterId)
    const authorization = { principal: { botUserId: 'discord-bot', operations: ['context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: logicalRoomId }], operator: false }, characterId, logicalRoomId }
    const context = await runtime.context!.assembleRecent({ authorization, logicalRoomId, physicalRoomId, characterId, maxItems: 10, maxCharacters: 500 })
    expect(context.text).toContain('delivered first')
    expect(context.text).not.toContain('failed second')
    await runtime.close()
  })
})
