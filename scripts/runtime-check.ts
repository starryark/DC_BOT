import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { Readable } from 'node:stream'

import { createAudioResource, StreamType } from '@discordjs/voice'
import { Client, Events } from 'discord.js'

import { FileCharacterRegistry } from '../src/character/character-registry'
import { config } from '../src/config'
import { DISCORD_M1_GATEWAY_INTENTS } from '../src/memory/discord-member-state-posture'
import { classifyTurn, resolveGenerationProfile } from '../src/orchestration/turn-classifier'
import { QwenHttpAsrProvider } from '../src/providers/asr/qwen-http'
import { GeminiBrainProvider } from '../src/providers/brain/gemini'
import { GptSoVitsTtsProvider } from '../src/providers/tts/gpt-sovits'
import { convertOpusToWav } from '../src/utils/audio'
import { OpusDecoder } from '../src/utils/opus'

/**
 * Checks the configured providers without installing commands or sending Discord
 * messages. The live check makes one small Gemini request and synthesizes a
 * short Japanese sentence for a TTS -> ASR -> Discord Opus encoding round trip.
 * `--settings` emits only the non-secret settings needed by the Windows launcher.
 */
async function main(): Promise<void> {
  const cfg = config()
  if (!cfg.discordToken.trim() || !cfg.brain.apiKey.trim())
    throw new Error('DISCORD_TOKEN and GEMINI_API_KEY must be configured in .env')

  if (process.argv.includes('--settings')) {
    console.log(JSON.stringify({
      backend: cfg.backend,
      asrUrl: cfg.asr.baseUrl,
      ttsUrl: cfg.tts.baseUrl,
      asrProject: process.env.ASR_PROJECT_DIR || '',
      ttsProject: process.env.GPT_SOVITS_PROJECT_DIR || '',
      asrPython: process.env.ASR_PYTHON || '',
      ttsPython: process.env.GPT_SOVITS_PYTHON || '',
    }))
    return
  }

  if (cfg.backend !== 'direct')
    throw new Error('This provider check requires BOT_BACKEND=direct')
  if (!cfg.character.root.trim() || !existsSync(resolve(cfg.character.root, cfg.character.id, 'card.json')))
    throw new Error('The configured character card is missing')
  new FileCharacterRegistry().load(cfg.character.id)
  console.log('Character card: loaded')

  // Authenticate with the exact production intent set, with no application
  // handlers: no slash-command registration, replies, or voice-channel joins.
  const client = new Client({ intents: [...DISCORD_M1_GATEWAY_INTENTS] })
  try {
    const ready = once(client, Events.ClientReady, { signal: AbortSignal.timeout(30_000) })
    await Promise.all([ready, client.login(cfg.discordToken)])
    console.log(`Discord gateway: authenticated; ${client.guilds.cache.size} guild(s) visible`)
  }
  finally {
    await client.destroy()
  }

  let generated = ''
  for await (const delta of new GeminiBrainProvider().generate({
    guildId: 'runtime-check', userId: 'runtime-check',
    systemInstruction: 'This is a connection test. Reply only with OK.',
    contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
    generationProfile: resolveGenerationProfile(classifyTurn('hello'), cfg.brain),
  }, AbortSignal.timeout(45_000))) {
    generated += delta
  }
  if (!generated.trim())
    throw new Error('Gemini returned no text')
  console.log(`Gemini: streamed a response using ${cfg.brain.model}`)

  const health = await fetch(`${cfg.asr.baseUrl}/health`, { signal: AbortSignal.timeout(5_000) })
  if (!health.ok || !(await health.json() as { ready?: boolean }).ready)
    throw new Error('ASR health check is not ready')

  const audio = await new GptSoVitsTtsProvider().synthesize({
    text: 'こんにちは。動作確認です。', language: 'ja',
  }, AbortSignal.timeout(45_000))
  const chunks: Buffer[] = []
  for await (const chunk of audio)
    chunks.push(Buffer.from(chunk))
  const wav = Buffer.concat(chunks)
  if (wav.length <= 44 || wav.toString('ascii', 0, 4) !== 'RIFF')
    throw new Error('TTS did not return a nonempty WAV stream')
  console.log(`TTS: synthesized ${wav.length} WAV bytes`)

  // Exercise the same WAV -> FFmpeg -> Opus conversion used by VoiceManager,
  // then its 16 kHz receive decoder. This gives ASR its canonical input format.
  const resource = createAudioResource(Readable.from([wav]), { inputType: StreamType.Arbitrary })
  const decoder = new OpusDecoder(16000, 1)
  const pcm: Buffer[] = []
  const timeout = setTimeout(() => resource.playStream.destroy(new Error('Discord encoding timed out')), 15_000)
  try {
    let packets = 0
    resource.playStream.on('data', () => { packets++ })
    resource.playStream.on('error', error => decoder.destroy(error))
    resource.playStream.pipe(decoder)
    for await (const chunk of decoder)
      pcm.push(Buffer.from(chunk))
    if (!packets)
      throw new Error('Discord audio conversion produced no Opus packets')
    console.log(`Discord audio: encoded ${packets} Opus packets locally`)
  }
  finally {
    clearTimeout(timeout)
    decoder.destroy()
    resource.playStream.destroy()
  }
  const transcript = await new QwenHttpAsrProvider().transcribe({
    wav: convertOpusToWav(Buffer.concat(pcm)), sampleRate: 16000, languageHint: 'ja',
  })
  if (!transcript.text.trim())
    throw new Error('ASR returned no text for the synthesized test sentence')
  console.log(`ASR: transcribed the generated speech (${transcript.language})`)
  console.log('Runtime check passed. No Discord messages or audio were sent.')
}

main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'Runtime check failed'
  for (const secret of [config().discordToken, config().brain.apiKey]) {
    if (secret)
      message = message.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]')
  }
  console.error(message)
  process.exitCode = 1
})
