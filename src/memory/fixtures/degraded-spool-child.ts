import type { VoiceInputEvent } from '../../orchestration/events'

import process from 'node:process'

import { Buffer } from 'node:buffer'

import { asCharacterId } from '@proj-airi/memory-domain'

import { buildDiscordActorEvidence } from '../discord-actor-snapshot'
import { memoryProfile } from '../profile'
import { createMemoryRuntime } from '../runtime'
import { createTextMemoryAdapter } from '../text-memory-adapter'
import { createVoiceMemoryAdapter } from '../voice-memory-adapter'

/**
 * Crash-side fixture for the degraded-posture suite (`degraded-mode.test.ts`;
 * G5 pass condition 4; artifact 16 TEST-OPS-006).
 *
 * This process is meant to be killed. It composes the real degraded runtime in
 * a temp root, drives one text turn and one voice turn through the real
 * adapters, reports that both writes were acknowledged as `spooled`, and then
 * parks forever so the parent can `SIGKILL` it with no graceful close, no
 * flush, and no `close()` call.
 *
 * That is the point: the acknowledgement the parent receives must already be
 * backed by an fsynced spool record, because nothing after this message ever
 * runs. If acceptance were buffered, the parent would find an empty spool after
 * the kill and the "spooled means durably accepted" claim would be false.
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

const actorEvidence = () => buildDiscordActorEvidence({ userId: USER_ID, displayName: 'Alex', guildId: GUILD_ID, observedAtEpochMs: OBSERVED_AT, source: 'gateway' })

function mention(messageId: string, text: string) {
  return { type: 'discord-mention' as const, eventId: `${messageId}:in`, turnId: messageId, guildId: GUILD_ID, channelId: TEXT_CHANNEL_ID, userId: USER_ID, displayName: 'Alex', actorEvidence: actorEvidence(), timestamp: OBSERVED_AT, messageId, text }
}

function utterance(eventId: string): VoiceInputEvent {
  return { type: 'voice', eventId, turnId: eventId, guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID, voiceChannelId: VOICE_CHANNEL_ID, userId: USER_ID, displayName: 'Alex', actorEvidence: actorEvidence(), timestamp: OBSERVED_AT + 1_000, pcm: Buffer.alloc(0), sampleRate: 16000 }
}

/** Never resolves; the parent terminates this process while it is parked here. */
function park(boundary: string): Promise<never> {
  report({ type: 'parked', boundary })
  return new Promise<never>(() => {})
}

async function runSpoolAndPark(): Promise<void> {
  const runtime = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root!, characterId })
  const failures: string[] = []
  const onFailure = (error: unknown) => failures.push(String(error))
  const text = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure })
  const voice = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure })

  const turn = mention('40000000000000001', 'spooled while degraded')
  await text.admit(turn, { isDirectMessage: false, isThread: false })
  const prepared = await text.prepareForModel(turn)

  const spoken = utterance('60000000000000001')
  await voice.admit(spoken, 'spoken while degraded')

  report({
    type: 'spooled',
    status: runtime.health.status,
    promptUseEnabled: runtime.health.promptUseEnabled,
    contextStatus: prepared.context.status,
    failures,
  })
  await park('degraded.after_spool_acknowledged')
}

async function main(): Promise<void> {
  if (mode !== 'spool-and-park')
    throw new Error(`unknown degraded fixture mode: ${mode}`)
  await runSpoolAndPark()
}

main().catch((error: unknown) => {
  report({ type: 'fixture-error', message: String(error) })
  process.exit(1)
})
