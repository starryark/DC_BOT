import type { EventId, SnapshotContextManifest } from '@proj-airi/memory-domain'

import type { DiscordMentionInputEvent, VoiceInputEvent } from '../orchestration/events'
import type { MemoryRuntime } from './runtime'
import type { DiscordTextMemoryObserver, TextIngressContext } from './text-observer'
import type { VoiceMemoryAdapter } from './voice-memory-adapter'

import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'
import { createTextMemoryAdapter } from './text-memory-adapter'
import { createVoiceMemoryAdapter } from './voice-memory-adapter'

/**
 * G5 pass condition 3 — "cross-modal authorized continuity tests pass" (IMP-503).
 *
 * Controlling text: artifact 21 §11.2 G5 and the IMP-503 backlog entry, which
 * names three cases — a text fact recalled in an authorized voice scope, an
 * unrelated channel transcript excluded, and a private DM fact excluded from
 * guild voice — with the selected-context manifest and the authorization
 * decisions present in the evidence.
 *
 * The existing tests were not sufficient. `runtime.test.ts` already proves that
 * two configured members of one logical room share history, but it drives the
 * authority directly: it resolves ingress itself, appends its own event and
 * calls `assembleRecent` itself, so it would keep passing even if neither
 * adapter ever reached that room. `text-memory-adapter.test.ts` and
 * `voice-memory-adapter.test.ts` each exercise one adapter against an isolated
 * room, where cross-modal continuity cannot arise at all. This file
 * is the missing middle: one active runtime, one configured room, both real
 * adapters, and the durable generation manifests they persist.
 *
 * Every row asserts exact selected event ids and not only prompt text. A
 * substring assertion alone would accept a needle that arrived through some
 * other selection path, and the negative rows would be satisfied by an empty
 * context.
 */

const characterId = asCharacterId('kurisu')
const GUILD_ID = '10000000000000001'
const BOUND_TEXT_CHANNEL_ID = '30000000000000001'
const BOUND_VOICE_CHANNEL_ID = '70000000000000001'
const UNBOUND_TEXT_CHANNEL_ID = '30000000000000009'
const DM_CHANNEL_ID = '80000000000000001'
const USER_ID = '20000000000000001'

const GUILD_TEXT: TextIngressContext = { isDirectMessage: false, isThread: false }
const DIRECT_MESSAGE: TextIngressContext = { isDirectMessage: true, isThread: false }

const roots: string[] = []
const openRuntimes: MemoryRuntime[] = []

afterEach(async () => {
  // Closing here as well as in each test matters on Windows: a failed
  // assertion would otherwise leave the SQLite writer open, the temporary-root
  // removal below would fail with EPERM, and that secondary error would be
  // reported alongside the real one. `close()` is idempotent.
  for (const runtime of openRuntimes.splice(0))
    await runtime.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

/**
 * Observation times for fixtures, strictly increasing and always ahead of
 * runtime startup.
 *
 * Room resolution is as-of the observation time and a configured binding is
 * only valid from the moment startup reconciled it (`rooms.ts` resolve:
 * `valid_from <= at`). An event observed before that instant resolves to the
 * isolated room instead of the configured one, which would silently turn
 * every continuity row below into a test of two unrelated rooms.
 */
let observedAtCursor = 0
function nextObservedAt(): number {
  observedAtCursor = Math.max(observedAtCursor + 1, Date.now() + 1_000)
  return observedAtCursor
}

/**
 * One configured logical room whose members are a guild text channel and a
 * guild voice channel of the same guild.
 *
 * That is the only cross-modal membership milestone one accepts: the binding
 * parser rejects a DM member and rejects a binding that crosses guilds
 * (`room-bindings.ts`), so the DM row below has to use an isolated location
 * rather than a third member of this binding.
 */
function boundRoot(prefix: string): { root: string, bindingFile: string } {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  const bindingFile = join(root, 'bindings.json')
  writeFileSync(bindingFile, JSON.stringify({
    version: 1,
    bindings: [{
      id: 'lab',
      characterId,
      locations: [
        { kind: 'guildText', guildId: GUILD_ID, channelId: BOUND_TEXT_CHANNEL_ID },
        { kind: 'guildVoice', guildId: GUILD_ID, channelId: BOUND_VOICE_CHANNEL_ID },
      ],
    }],
  }))
  return { root, bindingFile }
}

function openBoundRuntime(root: string, bindingFile: string): MemoryRuntime {
  const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId, bindingFile })
  openRuntimes.push(runtime)
  return runtime
}

/** Both adapters from one runtime object, which is the shared-facade property G5 condition 1 pins down. */
function adaptersOf(runtime: MemoryRuntime): { text: DiscordTextMemoryObserver, voice: VoiceMemoryAdapter } {
  return {
    text: createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' }),
    voice: createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model' }),
  }
}

/** One Discord person across every modality below; continuity here is person-level, not channel-level. */
const actorEvidence = (observedAtEpochMs: number) => buildDiscordActorEvidence({ userId: USER_ID, displayName: 'Alex', guildId: GUILD_ID, observedAtEpochMs, source: 'gateway' })

function mention(messageId: string, text: string, channelId: string, guildId: string | undefined = GUILD_ID): DiscordMentionInputEvent {
  const observedAt = nextObservedAt()
  return {
    type: 'discord-mention',
    eventId: `${messageId}:in`,
    turnId: messageId,
    guildId,
    channelId,
    userId: USER_ID,
    displayName: 'Alex',
    actorEvidence: actorEvidence(observedAt),
    timestamp: observedAt,
    messageId,
    text,
  }
}

function utterance(eventId: string): VoiceInputEvent {
  const observedAt = nextObservedAt()
  return {
    type: 'voice',
    eventId: `${eventId}:voice`,
    turnId: eventId,
    guildId: GUILD_ID,
    channelId: BOUND_VOICE_CHANNEL_ID,
    voiceChannelId: BOUND_VOICE_CHANNEL_ID,
    userId: USER_ID,
    displayName: 'Alex',
    actorEvidence: actorEvidence(observedAt),
    timestamp: observedAt,
    pcm: Buffer.alloc(0),
    sampleRate: 16000,
  }
}

/**
 * Drives one text turn through the adapter's whole lifecycle and returns the
 * durable id of the inbound event it admitted.
 *
 * The delivery half matters: assistant output becomes eligible history only
 * once a real Discord send is recorded, so a turn that stopped at `generated`
 * would contribute the user's message but never the reply.
 */
async function deliveredTextTurn(adapter: DiscordTextMemoryObserver, event: DiscordMentionInputEvent, context: TextIngressContext, reply: string, platformMessageId: string): Promise<EventId> {
  await adapter.admit(event, context)
  const prepared = await adapter.prepareForModel(event)
  await adapter.generated(event, [reply])
  await adapter.delivering(event, 0)
  await adapter.deliveredSegment(event, 0, platformMessageId)
  await adapter.delivered(event)
  // `observedEventIds[0]` is the trigger this turn admitted; any further
  // entries are the historical events it selected.
  return prepared.generation!.evidence.observedEventIds[0]!
}

/** Drives one voice turn to completed local playback, which is what makes spoken output eligible history. */
async function completedVoiceTurn(adapter: VoiceMemoryAdapter, event: VoiceInputEvent, transcript: string, spoken: string): Promise<EventId> {
  await adapter.admit(event, transcript)
  const prepared = await adapter.prepareGeneration(event.turnId, [event])
  await adapter.recordPlayback(event.turnId, event.voiceChannelId, 0, spoken, { status: 'played', durationMs: 900 })
  await adapter.completeGeneration(event.turnId)
  return prepared.generation!.evidence.observedEventIds[0]!
}

function selectedInboundIds(manifest: SnapshotContextManifest): EventId[] {
  return manifest.items.flatMap(item => item.sourceType === 'inbound' ? [item.eventId] : [])
}

function selectedAssistantStates(manifest: SnapshotContextManifest): string[] {
  return manifest.items.flatMap(item => item.sourceType === 'assistant_output' ? [item.deliveryState] : [])
}

function promptTextOf(prepared: { context: { status: string, text?: string } }): string {
  return prepared.context.status === 'available' ? prepared.context.text ?? '' : ''
}

describe('g5 condition 3 — scoped cross-modal continuity through both adapters', () => {
  it('carries a delivered bound text turn into the next bound voice generation', async () => {
    const { root, bindingFile } = boundRoot('airi-g5-cross-text-to-voice-')
    const runtime = openBoundRuntime(root, bindingFile)
    const assembleRecent = vi.spyOn(runtime.context!, 'assembleRecent')
    const { text, voice } = adaptersOf(runtime)

    const typedEventId = await deliveredTextTurn(text, mention('40000000000000301', 'the fold coordinate is seven', BOUND_TEXT_CHANNEL_ID), GUILD_TEXT, 'noted, coordinate seven', '50000000000000301')
    const spoken = utterance('60000000000000301')
    await voice.admit(spoken, 'what was the coordinate?')
    const prepared = await voice.prepareGeneration(spoken.turnId, [spoken])

    expect(prepared.context.status).toBe('available')
    expect(promptTextOf(prepared)).toContain('the fold coordinate is seven')
    expect(promptTextOf(prepared)).toContain('noted, coordinate seven')

    const manifest = prepared.generation!.evidence.contextManifest
    expect(selectedInboundIds(manifest)).toContain(typedEventId)
    expect(selectedAssistantStates(manifest)).toEqual(['delivered'])
    // A configured binding is what joined the two channels; an isolated room
    // would report revision zero and the continuity above could not exist.
    expect(manifest.bindingRevision).toBeGreaterThan(0)

    // Both modalities asked one room for context, under an authorization
    // scoped to exactly that room and to this runtime's character.
    const contextRequests = assembleRecent.mock.calls.map(([request]) => request)
    expect(contextRequests).toHaveLength(2)
    expect(contextRequests[1]!.logicalRoomId).toBe(contextRequests[0]!.logicalRoomId)
    for (const request of contextRequests) {
      expect(request.characterId).toBe(characterId)
      expect(request.authorization.characterId).toBe(characterId)
      expect(request.authorization.logicalRoomId).toBe(request.logicalRoomId)
      expect(request.authorization.principal.scopes).toEqual([{ kind: 'logical_room', id: request.logicalRoomId }])
    }
    await runtime.close()
  })

  it('carries a completed bound voice turn into the next bound text generation', async () => {
    // Artifact 21 names text-to-voice as the minimum case. The reverse is kept
    // as a symmetry regression: the two adapters record output through
    // different lifecycles — one whole-set append after a Discord send, one
    // re-declared set per played chunk — so continuity in one direction does
    // not imply it in the other.
    const { root, bindingFile } = boundRoot('airi-g5-cross-voice-to-text-')
    const runtime = openBoundRuntime(root, bindingFile)
    const { text, voice } = adaptersOf(runtime)

    const spokenEventId = await completedVoiceTurn(voice, utterance('60000000000000302'), 'the reactor timing is eleven', 'understood, eleven')
    const typed = mention('40000000000000302', 'what was the timing?', BOUND_TEXT_CHANNEL_ID)
    await text.admit(typed, GUILD_TEXT)
    const prepared = await text.prepareForModel(typed)

    expect(prepared.context.status).toBe('available')
    expect(promptTextOf(prepared)).toContain('the reactor timing is eleven')
    expect(promptTextOf(prepared)).toContain('understood, eleven')

    const manifest = prepared.generation!.evidence.contextManifest
    expect(selectedInboundIds(manifest)).toContain(spokenEventId)
    // Completed local playback is `unheard`, not `delivered`: a voice channel
    // returns no receipt, so eligibility comes from the playback evidence
    // rather than a platform acknowledgement.
    expect(selectedAssistantStates(manifest)).toEqual(['unheard'])
    expect(manifest.bindingRevision).toBeGreaterThan(0)
    await runtime.close()
  })

  it('excludes an unrelated guild channel from bound voice context', async () => {
    const { root, bindingFile } = boundRoot('airi-g5-cross-unrelated-')
    const runtime = openBoundRuntime(root, bindingFile)
    const assembleRecent = vi.spyOn(runtime.context!, 'assembleRecent')
    const { text, voice } = adaptersOf(runtime)

    const boundEventId = await deliveredTextTurn(text, mention('40000000000000303', 'bound channel needle', BOUND_TEXT_CHANNEL_ID), GUILD_TEXT, 'bound channel reply', '50000000000000303')
    const unrelatedEventId = await deliveredTextTurn(text, mention('40000000000000304', 'unrelated channel needle', UNBOUND_TEXT_CHANNEL_ID), GUILD_TEXT, 'unrelated channel reply', '50000000000000304')
    const spoken = utterance('60000000000000303')
    await voice.admit(spoken, 'anything to report?')
    const prepared = await voice.prepareGeneration(spoken.turnId, [spoken])

    // The positive half keeps the exclusion honest: an empty context would
    // satisfy the two negative assertions on its own.
    expect(promptTextOf(prepared)).toContain('bound channel needle')
    expect(promptTextOf(prepared)).not.toContain('unrelated channel needle')
    expect(promptTextOf(prepared)).not.toContain('unrelated channel reply')

    const manifest = prepared.generation!.evidence.contextManifest
    expect(selectedInboundIds(manifest)).toContain(boundEventId)
    expect(selectedInboundIds(manifest)).not.toContain(unrelatedEventId)
    expect(selectedAssistantStates(manifest)).toEqual(['delivered'])

    // Exclusion is a scope boundary rather than content filtering: the
    // unrelated channel resolved to a different logical room entirely.
    const rooms = assembleRecent.mock.calls.map(([request]) => request.logicalRoomId)
    expect(rooms[1]).not.toBe(rooms[0])
    expect(rooms[2]).toBe(rooms[0])
    await runtime.close()
  })

  it('excludes a private DM turn from bound guild voice context', async () => {
    // Memory-boundary scope only. This says nothing about whether an inbound
    // DM reaches the gateway at all; that transport question is separate and
    // unresolved, and nothing here qualifies it.
    const { root, bindingFile } = boundRoot('airi-g5-cross-dm-')
    const runtime = openBoundRuntime(root, bindingFile)
    const assembleRecent = vi.spyOn(runtime.context!, 'assembleRecent')
    const { text, voice } = adaptersOf(runtime)

    const dmEventId = await deliveredTextTurn(text, mention('40000000000000305', 'private dm needle', DM_CHANNEL_ID, undefined), DIRECT_MESSAGE, 'private dm reply', '50000000000000305')
    const boundEventId = await deliveredTextTurn(text, mention('40000000000000306', 'bound guild needle', BOUND_TEXT_CHANNEL_ID), GUILD_TEXT, 'bound guild reply', '50000000000000306')
    const spoken = utterance('60000000000000304')
    await voice.admit(spoken, 'anything private to share?')
    const prepared = await voice.prepareGeneration(spoken.turnId, [spoken])

    expect(promptTextOf(prepared)).toContain('bound guild needle')
    expect(promptTextOf(prepared)).not.toContain('private dm needle')
    expect(promptTextOf(prepared)).not.toContain('private dm reply')

    const manifest = prepared.generation!.evidence.contextManifest
    expect(selectedInboundIds(manifest)).toContain(boundEventId)
    expect(selectedInboundIds(manifest)).not.toContain(dmEventId)

    // The same Discord user in a DM lands in a different logical room, so the
    // guild voice request never had authority over that data to begin with.
    const rooms = assembleRecent.mock.calls.map(([request]) => request.logicalRoomId)
    expect(rooms[0]).not.toBe(rooms[1])
    expect(rooms[2]).toBe(rooms[1])
    await runtime.close()
  })

  it('recovers cross-modal continuity from the authority after a restart with new adapters', async () => {
    // IMP-504 restart continuity. Every in-process map the adapters keep —
    // text traces, voice events, voice generations — is discarded here, so a
    // pass can only come from the durable authority.
    const { root, bindingFile } = boundRoot('airi-g5-cross-restart-')
    const before = openBoundRuntime(root, bindingFile)
    const typedEventId = await deliveredTextTurn(adaptersOf(before).text, mention('40000000000000307', 'pre-restart needle', BOUND_TEXT_CHANNEL_ID), GUILD_TEXT, 'pre-restart reply', '50000000000000307')
    await before.close()

    const after = openBoundRuntime(root, bindingFile)
    // The configured room came back as the same binding rather than a new one,
    // which is what makes the pre-restart room the same room.
    expect(after.health.bindingReconciliation).toMatchObject({ created: 0, unchanged: 2, retired: 0 })
    const { voice } = adaptersOf(after)
    const spoken = utterance('60000000000000305')
    await voice.admit(spoken, 'do you still have it?')
    const prepared = await voice.prepareGeneration(spoken.turnId, [spoken])

    expect(prepared.context.status).toBe('available')
    expect(promptTextOf(prepared)).toContain('pre-restart needle')
    expect(promptTextOf(prepared)).toContain('pre-restart reply')
    expect(selectedInboundIds(prepared.generation!.evidence.contextManifest)).toContain(typedEventId)
    await after.close()
  })
})
