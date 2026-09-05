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

const characterId = asCharacterId('kurisu')

function mention(messageId: string, text: string) {
  return {
    type: 'discord-mention' as const,
    eventId: `${messageId}:in`,
    turnId: messageId,
    guildId: '10000000000000001',
    channelId: '30000000000000001',
    userId: '20000000000000001',
    displayName: 'Alex',
    actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
    timestamp: 1_785_600_000_000,
    messageId,
    text,
  }
}

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
    await adapter.prepareForModel(event)
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

  it('persists a running generation with its manifest before returning context for the model', async () => {
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-order-'))
    roots.push(root)
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const event = mention('40000000000000010', 'first message')
    await adapter.admit(event, { isDirectMessage: false, isThread: false })

    const prepared = await adapter.prepareForModel(event)

    // The durable attempt exists and is already running by the time the caller
    // has anything it could send to a model.
    expect(prepared.generation).toBeDefined()
    expect(prepared.generation!.state).toBe('running')
    expect(prepared.generation!.evidence.contextManifestHash).toMatch(/^[0-9a-f]{64}$/)
    expect(prepared.context.status).toBe('available')
    await runtime.close()
  })

  it('describes the exact selected history in the persisted manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-manifest-'))
    roots.push(root)
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const first = mention('40000000000000011', 'remember the fold')
    await adapter.admit(first, { isDirectMessage: false, isThread: false })
    await adapter.prepareForModel(first)
    await adapter.generated(first, ['noted'])
    await adapter.delivering(first, 0)
    await adapter.deliveredSegment(first, 0, '50000000000000011')
    await adapter.delivered(first)

    const second = mention('40000000000000012', 'what did I say?')
    await adapter.admit(second, { isDirectMessage: false, isThread: false })
    const prepared = await adapter.prepareForModel(second)
    const manifest = prepared.generation!.evidence.contextManifest

    // The prior turn contributes one inbound event and one delivered assistant
    // segment; the current trigger is a cause but never historical context.
    expect(manifest.items.filter(item => item.sourceType === 'inbound')).toHaveLength(1)
    const assistant = manifest.items.filter(item => item.sourceType === 'assistant_output')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]).toMatchObject({ deliveryState: 'delivered' })
    expect(manifest.items.some(item => item.sourceType === 'inbound' && item.eventId === prepared.generation!.evidence.observedEventIds[0])).toBe(false)
    await runtime.close()
  })

  it('reads no durable prompt history in shadow mode but still records causality', async () => {
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-shadow-'))
    roots.push(root)
    const runtime = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: root, characterId })
    const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const event = mention('40000000000000013', 'shadow message')
    await adapter.admit(event, { isDirectMessage: false, isThread: false })
    const assembleRecent = vi.fn()
    if (runtime.context)
      runtime.context.assembleRecent = assembleRecent

    const prepared = await adapter.prepareForModel(event)

    expect(assembleRecent).not.toHaveBeenCalled()
    expect(prepared.context.status).toBe('disabled')
    expect(prepared.generation?.evidence.contextManifest.items).toEqual([])
    await runtime.close()
  })

  it('moves a running generation to failed rather than dropping it when the turn fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-failed-'))
    roots.push(root)
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const event = mention('40000000000000014', 'will fail')
    await adapter.admit(event, { isDirectMessage: false, isThread: false })
    await adapter.prepareForModel(event)
    const transitionGeneration = vi.spyOn(runtime.trace!, 'transitionGeneration')

    // ROOT CAUSE (DEFECT-005):
    //
    // This assertion used to read `.rejects.toThrow('model exploded')` — in
    // `durableActive`, `failed()` re-raised the very error it was handed.
    //
    // Its only caller is the `Events.MessageCreate` catch block in
    // airi-adapter.ts, which calls it to *record* an error it is already
    // handling. Re-raising there rejected the catch block itself, so the async
    // gateway listener rejected, discord.js re-emitted it as `'error'` on the
    // Client, and with no `'error'` listener Node killed the process. A
    // transient Gemini 503 took the whole bot down mid-soak.
    //
    // `failed` is the failure-*recording* path and now records without
    // re-raising. The fail-closed rethrow is kept on the durable *write* paths,
    // where a write that did not land must never look like success.
    await expect(adapter.failed(event, new Error('model exploded'))).resolves.toBeUndefined()

    // A cancelled or failed turn must still leave terminal durable evidence,
    // otherwise a running generation would outlive the request forever.
    expect(transitionGeneration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ state: 'running' }), 'running', 'failed', expect.any(String))
    await runtime.close()
  })

  it('still fails closed on a durable write path while recording without re-raising', async () => {
    // The two halves of the DEFECT-005 split, asserted together so neither can
    // drift: a *write* that did not land must still reach the caller, while the
    // failure-*recording* entry point must not re-raise what it is handed.
    const root = mkdtempSync(join(tmpdir(), 'airi-text-memory-split-'))
    roots.push(root)
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const event = mention('40000000000000015', 'write will fail')
    await adapter.admit(event, { isDirectMessage: false, isThread: false })
    await adapter.prepareForModel(event)

    vi.spyOn(runtime.trace!, 'appendSegments').mockRejectedValueOnce(new Error('authority went away'))
    await expect(adapter.generated(event, ['a reply'])).rejects.toThrow('authority went away')

    await runtime.close()
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
    await adapter.prepareForModel(event)
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
