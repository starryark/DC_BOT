import type { CharacterRuntime } from './character/types'

import process, { env } from 'node:process'

import { Format, LogLevel, setGlobalFormat, setGlobalLogLevel, useLogg } from '@guiiai/logg'

import { DiscordAdapter } from './adapters/airi-adapter'
import { AvatarPublisher } from './avatar/publisher'
import { FileCharacterRegistry } from './character/character-registry'
import { DefaultPromptCompiler } from './character/prompt-compiler'
import { config } from './config'
import { ConversationController } from './orchestration/conversation-controller'
import { MentionResponder } from './orchestration/mention-responder'
import { QwenHttpAsrProvider } from './providers/asr/qwen-http'
import { GeminiBrainProvider } from './providers/brain/gemini'
import { GptSoVitsTtsProvider } from './providers/tts/gpt-sovits'
import { CachedTtsProvider, fingerprint } from './providers/tts/tts-cache'
import { setServices } from './services'

setGlobalFormat(Format.Pretty)
setGlobalLogLevel(LogLevel.Log)
const log = useLogg('Bot').useGlobalConfig()

/**
 * Load the configured character card, or `undefined` when none is configured
 * or the card is unusable.
 *
 * A card problem must not stop the bot from booting — it degrades to the
 * generic prompt — but it is logged with the resolved id so a silently
 * persona-less bot is never a mystery.
 */
function loadCharacter(): CharacterRuntime | undefined {
  const { root, id } = config().character
  if (root.trim() === '') {
    log.warn('CHARACTER_PATH is empty — running without a character persona.')
    return undefined
  }

  try {
    const character = new FileCharacterRegistry().load(id)
    log.withFields({ characterId: character.id, name: character.name }).log('Character loaded')
    return character
  }
  catch (err) {
    log.withError(err).withFields({ characterId: id, root }).error('Character card could not be loaded — falling back to the generic prompt')
    return undefined
  }
}

async function main() {
  const cfg = config()

  // The VoiceManager is the shared voice transport. The DiscordAdapter owns
  // the discord.js client + AIRI server wiring; we reach into it for the
  // voice manager so the controller can subscribe to utterance events and
  // drive playback.
  const adapter = new DiscordAdapter({
    discordToken: env.DISCORD_TOKEN || '',
    airiToken: cfg.airiToken,
    airiUrl: cfg.airiUrl,
  })
  const voice = adapter.voiceManager
  const avatar = new AvatarPublisher({
    enabled: cfg.avatar.enabled,
    url: cfg.avatar.relayUrl,
    token: cfg.avatar.publishToken,
  })
  avatar.bindVoice(voice)
  avatar.start()

  const asr = new QwenHttpAsrProvider()
  const rawTts = new GptSoVitsTtsProvider()
  const tts = new CachedTtsProvider(rawTts, {
    ...cfg.ttsCache,
    identity: request => cfg.tts.voiceModelVersion && cfg.tts.refAudioPath
      ? {
          normalizedText: request.text.normalize('NFKC').trim().replace(/\s+/g, ' '),
          textLanguage: request.language,
          voiceModelVersion: cfg.tts.voiceModelVersion,
          referenceAudioFingerprint: fingerprint(cfg.tts.refAudioPath),
          promptTextFingerprint: fingerprint(cfg.tts.promptText),
          promptLanguage: cfg.tts.promptLang,
          speedFactor: 1,
          mediaType: 'wav',
          streamingMode: cfg.tts.streamingMode,
          textSplitMethod: 'cut5',
          relevantSynthesisParameters: { pronunciationProfileVersion: request.pronunciationProfileVersion ?? 'default-v1' },
        }
      : null,
  })
  const brain = new GeminiBrainProvider()

  // The character card supplies the persona and, via the prompt compiler, the
  // whole system instruction. A missing or broken card is not fatal: the
  // controller falls back to the generic prompt so the bot still answers.
  const character = loadCharacter()
  const promptCompiler = character ? new DefaultPromptCompiler() : undefined

  if (cfg.backend === 'direct') {
    // The controller subscribes to voice utterances and barge-in events; it is
    // the only orchestrator in direct mode.
    // eslint-disable-next-line no-new
    new ConversationController({ voice, asr, brain, tts, character, promptCompiler })
    adapter.setMentionResponder(new MentionResponder({ brain, character, promptCompiler }))
    log.log('Direct backend active: Qwen ASR → Gemini → GPT-SoVITS, with Discord text replies.')
  }
  else {
    log.log('AIRI backend active: deferring to WebSocket server.')
  }

  // Publish the shared instances so /voice-test (and any future command) can
  // reach them without re-constructing providers.
  setServices({ voice, asr, brain, tts, avatar })

  await adapter.start()

  async function gracefulShutdown(signal: string) {
    log.log(`Received ${signal}, shutting down...`)
    await adapter.stop()
    avatar.stop()
    process.exit(0)
  }

  process.on('SIGINT', async () => {
    await gracefulShutdown('SIGINT')
  })

  process.on('SIGTERM', async () => {
    await gracefulShutdown('SIGTERM')
  })
}

main().catch(err => log.withError(err).error('An error occurred'))
