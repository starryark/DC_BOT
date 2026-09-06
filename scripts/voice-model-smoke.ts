/** Synthetic local integration only: no Discord login, provider API or model download. */
import { Buffer } from 'node:buffer'
import { setTimeout } from 'node:timers/promises'

import type { FloorDecision } from '../src/voice/model-bridge'
import type { VoiceUtterance } from '../src/voice/types'
import { VoiceModelBridge } from '../src/voice/model-bridge'

const bridge = new VoiceModelBridge({ port: Number(process.argv[2] || 18766),
  token: process.env.VOICE_AGENT_BRIDGE_TOKEN || '', mode: 'active' })
const timeout = globalThis.setTimeout(() => { bridge.close(); throw new Error('Bridge smoke timed out') }, 15000)

async function turn(userId: string): Promise<FloorDecision> {
  const decision = new Promise<FloorDecision>((resolve) => {
    const receive = (value: FloorDecision) => {
      if (value.decision === 'TAKE_TURN') { bridge.off('decision', receive); resolve(value) }
    }
    bridge.on('decision', receive)
  })
  const pcm = Buffer.alloc(640)
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(2000, i)
  for (let i = 0; i < 20; i++) {
    bridge.capture({ guildId: 'fixture-guild', channelId: 'fixture-channel', userId, pcm })
    await setTimeout(20)
  }
  bridge.end('fixture-guild', userId, { guildId: 'fixture-guild', channelId: 'fixture-channel',
    userId, displayName: userId, pcm: Buffer.concat(Array(20).fill(pcm)), sampleRate: 16000,
    channels: 1, startedAt: 0, endedAt: 400, actorEvidence: {} } as VoiceUtterance)
  return decision
}

try {
  await bridge.start()
  const first = await turn('first')
  const abort = new AbortController()
  const audio = await bridge.synthesize(first, 'First synthetic phrase.', 'en', abort.signal)
  let firstBytes = 0
  await new Promise<void>((resolve, reject) => {
    audio.once('data', (bytes) => { firstBytes += bytes.length; abort.abort(); resolve() })
    audio.once('error', reject)
  })
  const second = await turn('second')
  let staleRejected = false
  try { await bridge.synthesize(first, 'Stale phrase.', 'en', new AbortController().signal) }
  catch { staleRejected = true }
  if (!staleRejected) throw new Error('Stale room revision was admitted')
  const replacement = await bridge.synthesize(second, 'Replacement synthetic phrase.', 'en', new AbortController().signal)
  let replacementBytes = 0
  for await (const bytes of replacement) replacementBytes += bytes.length
  if (firstBytes <= 0 || replacementBytes !== 76800) throw new Error('PCM replay geometry mismatch')
  console.log(JSON.stringify({ status: 'PASS', kind: 'SYNTHETIC_CROSS_PROCESS_REPLAY',
    turns: 2, staleRejected, firstBytes, replacementBytes, sampleRate: 48000, channels: 2,
    physicalGpuCancellation: 'NOT_RUN', discordGateway: 'NOT_RUN' }))
}
finally { clearTimeout(timeout); bridge.close() }
