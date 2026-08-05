import type { VoiceInputEvent } from '../orchestration/events'

import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'
import { createVoiceMemoryAdapter } from './voice-memory-adapter'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

const characterId = asCharacterId('kurisu')

function runtimeFor(mode: 'shadow' | 'active', prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return createMemoryRuntime({ ...memoryProfile(mode, {}), repoRoot: root, characterId })
}

function voiceEvent(index: number, overrides: Partial<VoiceInputEvent> = {}): VoiceInputEvent {
  const userId = `2000000000000000${index}`
  return {
    type: 'voice',
    eventId: `6000000000000000${index}:voice`,
    turnId: `6000000000000000${index}`,
    guildId: '10000000000000001',
    channelId: '70000000000000001',
    voiceChannelId: '70000000000000001',
    userId,
    displayName: `Speaker ${index}`,
    actorEvidence: buildDiscordActorEvidence({ userId, displayName: `Speaker ${index}`, guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000 + index, source: 'gateway' }),
    timestamp: 1_785_600_000_000 + index,
    pcm: Buffer.alloc(0),
    sampleRate: 16000,
    ...overrides,
  }
}

describe('voice memory adapter generation preparation', () => {
  it('excludes every grouped current event from the historical context it returns', async () => {
    const runtime = runtimeFor('active', 'airi-voice-group-')
    const adapter = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const earlier = voiceEvent(1)
    const groupedA = voiceEvent(2)
    const groupedB = voiceEvent(3)

    // One earlier utterance becomes durable history; the two grouped events are
    // the current prompt and must not also appear as history.
    await adapter.admit(earlier, 'earlier utterance')
    await adapter.prepareGeneration(earlier.turnId, [earlier])
    await adapter.completeGeneration(earlier.turnId)
    await adapter.admit(groupedA, 'grouped one')
    await adapter.admit(groupedB, 'grouped two')

    const prepared = await adapter.prepareGeneration('grouped-turn', [groupedA, groupedB])

    expect(prepared.generation).toBeDefined()
    expect(prepared.context.status).toBe('available')
    const text = prepared.context.status === 'available' ? prepared.context.text : ''
    expect(text).toContain('earlier utterance')
    expect(text).not.toContain('grouped one')
    expect(text).not.toContain('grouped two')
    await runtime.close()
  })

  it('records every grouped source as a cause and never puts a current event in the manifest', async () => {
    const runtime = runtimeFor('active', 'airi-voice-causes-')
    const adapter = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const groupedA = voiceEvent(4)
    const groupedB = voiceEvent(5)
    await adapter.admit(groupedA, 'first')
    await adapter.admit(groupedB, 'second')

    const prepared = await adapter.prepareGeneration('grouped-causes', [groupedA, groupedB])
    const manifest = prepared.generation!.evidence.contextManifest

    // Both current events are observed causes, but the manifest describes only
    // durable history, which is empty on the first grouped turn.
    expect(prepared.generation!.evidence.observedEventIds).toHaveLength(2)
    expect(manifest.items).toEqual([])
    expect(manifest.formatVersion).toBe(1)
    await runtime.close()
  })

  it('rejects a grouped turn whose sources resolve to different logical rooms', async () => {
    const runtime = runtimeFor('active', 'airi-voice-mixed-')
    const failure = vi.fn()
    const adapter = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure: failure })
    const here = voiceEvent(6)
    const elsewhere = voiceEvent(7, { voiceChannelId: '70000000000000002', channelId: '70000000000000002' })
    await adapter.admit(here, 'here')
    await adapter.admit(elsewhere, 'elsewhere')

    await expect(adapter.prepareGeneration('mixed-turn', [here, elsewhere])).rejects.toThrow(/mixed logical rooms/)
    await runtime.close()
  })

  it('rejects a grouped turn whose source has no durable trace instead of silently narrowing it', async () => {
    const runtime = runtimeFor('active', 'airi-voice-missing-')
    const adapter = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const admitted = voiceEvent(8)
    await adapter.admit(admitted, 'admitted')

    await expect(adapter.prepareGeneration('missing-turn', [admitted, voiceEvent(9)])).rejects.toThrow(/durable trace/)
    await runtime.close()
  })

  it('reads no durable prompt history in shadow mode but still records causality', async () => {
    const runtime = runtimeFor('shadow', 'airi-voice-shadow-')
    const assembleRecent = vi.fn()
    const adapter = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const event = voiceEvent(1)
    await adapter.admit(event, 'shadow utterance')
    if (runtime.context)
      runtime.context.assembleRecent = assembleRecent

    const prepared = await adapter.prepareGeneration(event.turnId, [event])

    expect(assembleRecent).not.toHaveBeenCalled()
    expect(prepared.context.status).toBe('disabled')
    expect(prepared.generation).toBeDefined()
    expect(prepared.generation!.evidence.contextManifest.items).toEqual([])
    await runtime.close()
  })

  it('records every chunk of a multi-chunk reply', async () => {
    // ROOT CAUSE:
    //
    // `appendSegments` forwards to `OutputRepository.appendSet`, which is a
    // whole-set declaration: after inserting it re-lists the generation and
    // rejects the call unless the stored set matches the declared set exactly.
    //
    // `recordPlayback` declared only the chunk that had just played, so the
    // second chunk of a reply declared one segment against two stored ones:
    //
    //   POLICY_VIOLATION: output retry does not exactly match the durable
    //   generation segment set
    //
    // Because the runtime is `durableActive`, `safe` rethrows, so the error
    // escaped `playChunk` and aborted the whole TTS pipeline — every chunk
    // already synthesized behind the current one was discarded, cutting the
    // reply off mid-sentence, and the generation recorded `failed`.
    //
    // Fixed by accumulating the segment set on the trace and re-declaring the
    // whole set on every chunk, which is what the authority's contract asks
    // for. The text path never hit this: it appends all of its segments in one
    // call (`text-memory-adapter.ts`).
    const runtime = runtimeFor('active', 'airi-voice-chunks-')
    const failure = vi.fn()
    const adapter = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure: failure })
    const event = voiceEvent(10)
    await adapter.admit(event, 'explain it properly')
    await adapter.prepareGeneration(event.turnId, [event])

    await adapter.recordPlayback(event.turnId, event.voiceChannelId, 0, 'first sentence', { status: 'played', durationMs: 1200 })
    await adapter.recordPlayback(event.turnId, event.voiceChannelId, 1, 'second sentence', { status: 'played', durationMs: 1500 })
    await adapter.recordPlayback(event.turnId, event.voiceChannelId, 2, 'third sentence', { status: 'played', durationMs: 900 })
    await adapter.completeGeneration(event.turnId)

    expect(failure).not.toHaveBeenCalled()

    // Every spoken chunk must be durable and recallable, not just the first.
    const next = voiceEvent(11)
    await adapter.admit(next, 'and then?')
    const prepared = await adapter.prepareGeneration(next.turnId, [next])
    const text = prepared.context.status === 'available' ? prepared.context.text : ''
    expect(text).toContain('first sentence')
    expect(text).toContain('second sentence')
    expect(text).toContain('third sentence')
    await runtime.close()
  })

  it('fails closed in active mode when the durable authority is gone', async () => {
    const runtime = runtimeFor('active', 'airi-voice-closed-')
    const adapter = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    const event = voiceEvent(1)
    await adapter.admit(event, 'utterance')
    await runtime.close()

    await expect(adapter.prepareGeneration(event.turnId, [event])).rejects.toThrow()
  })
})
