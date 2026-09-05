import type { PlaybackResult } from '../../voice/playback'
import type { MemoryRuntime } from '../runtime'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'

import { buildDiscordActorEvidence } from '../discord-actor-snapshot'
import { memoryProfile } from '../profile'
import { createMemoryRuntime } from '../runtime'
import { createTextMemoryAdapter } from '../text-memory-adapter'
import { createVoiceMemoryAdapter } from '../voice-memory-adapter'

/**
 * Crash-side fixture for the G4 delivery fault-injection suite
 * (`delivery-fault-injection.test.ts`; artifact 18 §11.5 `TEST-FI-007`…`013`,
 * §11.6 `TEST-CON-011`).
 *
 * This process is meant to be killed. It drives the real adapters against a
 * real authoritative SQLite store in a temp root, reaches one named delivery
 * boundary, reports it over IPC, and then parks forever so the parent can
 * `SIGKILL` it deterministically — no sleeps, no timing races. Artifact 18 §10.3
 * is explicit that a function that throws does not substitute for hard-process
 * termination, so the boundary is reached and then abandoned mid-flight rather
 * than unwound.
 *
 * The two external side effects are faked, and both fakes write append-only JSON
 * lines into the same temp root as the database:
 *
 * - `fake-discord.jsonl` — every message the fake platform *accepted*. This is
 *   artifact 18's "visible-message set": it survives the kill and is what proves
 *   the recovered process did not send a second copy.
 * - `fake-player.jsonl` — the fake playback device's lifecycle log (queued,
 *   started, chunk writes, drained/cancelled, audible ms). It is what
 *   distinguishes "never started" from "was audible" after the durable store has
 *   already lost the in-flight knowledge.
 *
 * Neither fake ever writes a delivery state. Durable state is produced only by
 * the production adapters and the production reconciliation pass, so the test
 * cannot pass by a fake helpfully asserting its own expectation.
 *
 * Modes:
 * - `text-delivery-matrix` — three text turns in one process: one fully
 *   delivered with a durable receipt, one that fails before the platform accepts
 *   anything, and one the platform accepts but which never reaches a durable
 *   receipt. The process parks in the third. (`TEST-FI-007`, `TEST-FI-008`)
 * - `voice-delivery-matrix` — three voice turns: a played/interrupted/parked
 *   chunk sequence, a turn that never reaches playback, and a turn that is
 *   audibly playing when the process dies. (`TEST-FI-010`…`013`)
 */

const [mode, root] = process.argv.slice(2)
const characterId = asCharacterId('kurisu')

const GUILD_ID = '10000000000000001'
const TEXT_CHANNEL_ID = '30000000000000001'
const VOICE_CHANNEL_ID = '70000000000000001'
const USER_ID = '20000000000000001'
const OBSERVED_AT = 1_785_600_000_000

function report(message: Record<string, unknown>): void {
  process.send?.(message)
}

/** Append-only, synchronous: the record must be on disk before the kill lands. */
function append(file: string, entry: Record<string, unknown>): void {
  appendFileSync(join(root!, file), `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * The fake Discord text transport.
 *
 * `reject: true` models artifact 18's "reject before accept" variant: it throws
 * without recording anything, so the visible-message set stays empty and the
 * caller sees a transport error. Otherwise the message is accepted and recorded
 * before the id is returned, which is exactly the window
 * `discord.send.after_response_before_record` sits in.
 */
function fakeDiscordSend(input: { turnId: string, segmentIndex: number, content: string, messageId: string, reject?: boolean }): string {
  if (input.reject)
    throw new Error('fake discord rejected the request before accepting it')
  append('fake-discord.jsonl', { event: 'accepted', channelId: TEXT_CHANNEL_ID, turnId: input.turnId, segmentIndex: input.segmentIndex, messageId: input.messageId, content: input.content })
  return input.messageId
}

/** The fake playback device. `drain` is a local observation and proves nothing about audibility. */
function fakePlayback(input: { turnId: string, chunkIndex: number, outcome: 'played' | 'cancelled', durationMs: number }): PlaybackResult {
  append('fake-player.jsonl', { event: 'queued', turnId: input.turnId, chunkIndex: input.chunkIndex })
  append('fake-player.jsonl', { event: 'started', turnId: input.turnId, chunkIndex: input.chunkIndex })
  append('fake-player.jsonl', { event: input.outcome === 'played' ? 'drained' : 'cancelled', turnId: input.turnId, chunkIndex: input.chunkIndex, audibleMs: input.durationMs })
  return { status: input.outcome, durationMs: input.durationMs }
}

function mention(messageId: string, text: string) {
  return {
    type: 'discord-mention' as const,
    eventId: `${messageId}:in`,
    turnId: messageId,
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    userId: USER_ID,
    displayName: 'Alex',
    actorEvidence: buildDiscordActorEvidence({ userId: USER_ID, displayName: 'Alex', guildId: GUILD_ID, observedAtEpochMs: OBSERVED_AT, source: 'gateway' as const }),
    timestamp: OBSERVED_AT,
    messageId,
    text,
  }
}

function utterance(eventId: string) {
  return {
    type: 'voice' as const,
    eventId: `${eventId}:voice`,
    turnId: eventId,
    guildId: GUILD_ID,
    channelId: VOICE_CHANNEL_ID,
    voiceChannelId: VOICE_CHANNEL_ID,
    userId: USER_ID,
    displayName: 'Alex',
    actorEvidence: buildDiscordActorEvidence({ userId: USER_ID, displayName: 'Alex', guildId: GUILD_ID, observedAtEpochMs: OBSERVED_AT, source: 'gateway' as const }),
    timestamp: OBSERVED_AT,
    pcm: Buffer.alloc(0),
    sampleRate: 16000 as const,
  }
}

/** Reached the injected failure point. Report it, then never make progress again. */
function park(boundary: string): Promise<never> {
  report({ type: 'parked', boundary })
  return new Promise<never>(() => {})
}

/**
 * The named failpoint controller (artifact 18 §10.2), implemented on the test
 * side rather than as a production seam.
 *
 * It wraps the real runtime's `transitionDelivery` and parks *before* delegating
 * when the armed boundary is hit. Every write that already happened went through
 * the real authority and is durably committed; nothing is faked and no state is
 * written by the wrapper. The voice path needs this because `recordPlayback`
 * commits `pending -> delivering` and the final lifecycle state inside one
 * function, so `playback.after_drain_before_finalize` is an intra-function commit
 * boundary that cannot be reached from the call site.
 */
function withFinalCommitFailpoint(runtime: MemoryRuntime, armed: () => string | undefined): MemoryRuntime {
  const trace = runtime.trace
  if (!trace)
    return runtime
  return {
    ...runtime,
    trace: {
      ...trace,
      transitionDelivery: async (authorization, transition) => {
        const boundary = armed()
        if (boundary && transition.from === 'delivering')
          return park(boundary)
        return trace.transitionDelivery(authorization, transition)
      },
    },
  }
}

async function runTextDeliveryMatrix(): Promise<void> {
  const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root!, characterId })
  const adapter = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })

  // Turn A — the healthy path: the platform accepts and the receipt commits.
  // This is the `durable platform receipt -> delivered` branch, established by a
  // real process that then died, not by seeding a row.
  const turnA = mention('40000000000000101', 'first question')
  await adapter.admit(turnA, { isDirectMessage: false, isThread: false })
  await adapter.prepareForModel(turnA)
  await adapter.generated(turnA, ['reply-alpha-delivered'])
  await adapter.delivering(turnA, 0)
  const acceptedA = fakeDiscordSend({ turnId: turnA.turnId, segmentIndex: 0, content: 'reply-alpha-delivered', messageId: '95000000000000101' })
  await adapter.deliveredSegment(turnA, 0, acceptedA)
  await adapter.delivered(turnA)

  // Turn B — the platform refuses before accepting anything, so the transport
  // error is durable and provably means "no external send happened".
  // (`TEST-FI-007`, reject-before-accept variant.)
  const turnB = mention('40000000000000102', 'second question')
  await adapter.admit(turnB, { isDirectMessage: false, isThread: false })
  await adapter.prepareForModel(turnB)
  await adapter.generated(turnB, ['reply-beta-failed'])
  await adapter.delivering(turnB, 0)
  try {
    fakeDiscordSend({ turnId: turnB.turnId, segmentIndex: 0, content: 'reply-beta-failed', messageId: '95000000000000102', reject: true })
  }
  catch (error) {
    await adapter.failed(turnB, error)
  }

  // Turn C — the injected failure point. The platform has accepted the message
  // and the id is in hand, but the durable receipt is never written: this is
  // `discord.send.after_response_before_record` (`TEST-FI-008`).
  const turnC = mention('40000000000000103', 'third question')
  await adapter.admit(turnC, { isDirectMessage: false, isThread: false })
  await adapter.prepareForModel(turnC)
  await adapter.generated(turnC, ['reply-gamma-ambiguous'])
  await adapter.delivering(turnC, 0)
  const acceptedC = fakeDiscordSend({ turnId: turnC.turnId, segmentIndex: 0, content: 'reply-gamma-ambiguous', messageId: '95000000000000103' })
  report({ type: 'accepted', messageId: acceptedC, turnId: turnC.turnId })
  await park('discord.send.after_response_before_record')
}

async function runVoiceDeliveryMatrix(): Promise<void> {
  const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root!, characterId })
  let boundary: string | undefined
  const adapter = createVoiceMemoryAdapter({ runtime: withFinalCommitFailpoint(runtime, () => boundary), characterId, modelRef: 'test/model' })

  // Turn V1 carries the three chunk-level outcomes.
  const v1 = utterance('60000000000000101')
  await adapter.admit(v1, 'first utterance')
  await adapter.prepareGeneration(v1.turnId, [v1])

  // Turn V2 — `TEST-FI-010`, failure before playback: the generation exists but
  // the player is never invoked, so no delivery is ever created.
  const v2 = utterance('60000000000000102')
  await adapter.admit(v2, 'second utterance')
  await adapter.prepareGeneration(v2.turnId, [v2])

  // Turn V3 — `TEST-FI-011`, failure during playback: audio is provably audible
  // in the fake device's log, and the process dies before the playback call ever
  // returns, so nothing durable was recorded for it.
  const v3 = utterance('60000000000000103')
  await adapter.admit(v3, 'third utterance')
  await adapter.prepareGeneration(v3.turnId, [v3])
  append('fake-player.jsonl', { event: 'queued', turnId: v3.turnId, chunkIndex: 0 })
  append('fake-player.jsonl', { event: 'started', turnId: v3.turnId, chunkIndex: 0 })
  append('fake-player.jsonl', { event: 'chunk', turnId: v3.turnId, chunkIndex: 0, audibleMs: 55 })

  // V1 chunk 0 — drained *and* finalized before the crash: the durable drain
  // checkpoint branch of `TEST-FI-013`.
  await adapter.recordPlayback(v1.turnId, VOICE_CHANNEL_ID, 0, 'voice-chunk-zero-heard', fakePlayback({ turnId: v1.turnId, chunkIndex: 0, outcome: 'played', durationMs: 120 }))
  // V1 chunk 1 — interrupted and finalized before the crash: `TEST-FI-012`'s
  // durable partial-progress checkpoint.
  await adapter.recordPlayback(v1.turnId, VOICE_CHANNEL_ID, 1, 'voice-chunk-one-cut', fakePlayback({ turnId: v1.turnId, chunkIndex: 1, outcome: 'cancelled', durationMs: 40 }))

  // V1 chunk 2 — the injected failure point: the fake player drained, the
  // delivery row is durably `delivering`, and the final lifecycle commit never
  // happens (`playback.after_drain_before_finalize`, `TEST-FI-013`).
  const drained = fakePlayback({ turnId: v1.turnId, chunkIndex: 2, outcome: 'played', durationMs: 130 })
  boundary = 'playback.after_drain_before_finalize'
  report({ type: 'accepted', turnId: v1.turnId, chunkIndex: 2 })
  await adapter.recordPlayback(v1.turnId, VOICE_CHANNEL_ID, 2, 'voice-chunk-two-ambiguous', drained)
  throw new Error('the voice failpoint did not park')
}

async function main(): Promise<void> {
  if (mode === 'text-delivery-matrix')
    return runTextDeliveryMatrix()
  if (mode === 'voice-delivery-matrix')
    return runVoiceDeliveryMatrix()
  throw new Error(`unknown delivery crash fixture mode: ${mode}`)
}

main().catch((error: unknown) => {
  report({ type: 'fixture-error', message: String(error) })
  process.exit(3)
})
