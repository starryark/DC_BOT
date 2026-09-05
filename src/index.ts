import type { CharacterRuntime } from './character/types'

import process, { env } from 'node:process'

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Format, LogLevel, setGlobalFormat, setGlobalLogLevel, useLogg } from '@guiiai/logg'

import { DiscordAdapter } from './adapters/airi-adapter'
import { AvatarPublisher } from './avatar/publisher'
import { FileCharacterRegistry } from './character/character-registry'
import { DefaultPromptCompiler } from './character/prompt-compiler'
import { config } from './config'
import { createMemoryRuntime, memoryCharacterIdOf } from './memory/runtime'
import { createTextMemoryAdapter } from './memory/text-memory-adapter'
import { createVoiceMemoryAdapter } from './memory/voice-memory-adapter'
import { ConversationController } from './orchestration/conversation-controller'
import { MentionResponder } from './orchestration/mention-responder'
import { QwenHttpAsrProvider } from './providers/asr/qwen-http'
import { GeminiBrainProvider } from './providers/brain/gemini'
import { GptSoVitsTtsProvider } from './providers/tts/gpt-sovits'
import { CachedTtsProvider, fingerprint } from './providers/tts/tts-cache'
import { loadVoiceProfileCatalog } from './providers/tts/voice-profile-catalog'
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
  const voiceProfileCatalog = await loadVoiceProfileCatalog({
    filePath: cfg.tts.voiceProfilesFile,
    singleReference: {
      referenceAudio: cfg.tts.refAudioPath,
      referenceText: cfg.tts.promptText,
      promptLanguage: cfg.tts.promptLang as 'zh' | 'en' | 'ja' | 'auto',
      catalogVersion: cfg.tts.voiceModelVersion || undefined,
    },
    onWarning: warning => log.withFields(warning).warn(warning.kind === 'profile-disabled' ? 'voice_profile_disabled' : 'voice_profile_fallback'),
  })

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
    identity: (request) => {
      const conditioning = request.conditioning
      const referenceAudio = conditioning?.referenceAudio ?? cfg.tts.refAudioPath
      const referenceText = conditioning?.referenceText ?? cfg.tts.promptText
      if (!cfg.tts.voiceModelVersion || !referenceAudio)
        return null
      return {
        normalizedText: request.text.normalize('NFKC').trim().replace(/\s+/g, ' '),
        textLanguage: request.language,
        pronunciationProfileVersion: request.pronunciationProfileVersion,
        voiceModelVersion: cfg.tts.voiceModelVersion,
        catalogVersion: conditioning?.catalogVersion ?? voiceProfileCatalog.catalogVersion,
        profileId: conditioning?.profileId ?? voiceProfileCatalog.defaultProfileId,
        referenceAudioFingerprint: fingerprint(referenceAudio),
        promptTextFingerprint: fingerprint(referenceText),
        promptLanguage: conditioning?.promptLanguage ?? cfg.tts.promptLang,
        topK: conditioning?.topK ?? 15,
        topP: conditioning?.topP ?? 1,
        temperature: conditioning?.temperature ?? 1,
        repetitionPenalty: conditioning?.repetitionPenalty ?? 1.35,
        speedFactor: conditioning?.speedFactor ?? 1,
        fragmentInterval: conditioning?.fragmentInterval ?? 0.3,
        seed: conditioning?.seed ?? -1,
        variationIndex: conditioning?.variationIndex ?? 0,
        mediaType: 'wav',
        streamingMode: cfg.tts.streamingMode,
        textSplitMethod: conditioning?.textSplitMethod ?? 'cut0',
      }
    },
  })
  const brain = new GeminiBrainProvider()

  // The character card supplies the persona and, via the prompt compiler, the
  // whole system instruction. A missing or broken card is not fatal: the
  // controller falls back to the generic prompt so the bot still answers.
  const character = loadCharacter()
  const promptCompiler = character ? new DefaultPromptCompiler() : undefined
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  // One memory identity for the whole process, derived from the configured
  // character key rather than the loaded card, so the runtime, both adapters,
  // and the operator's `binding.characterId` cannot disagree.
  const memoryCharacterId = memoryCharacterIdOf(cfg.character.id)
  const memory = createMemoryRuntime({
    mode: cfg.memory.mode,
    flags: cfg.memory.flags,
    repoRoot: repositoryRoot,
    configuredRoot: cfg.memory.runtimeRoot,
    characterId: memoryCharacterId,
    bindingFile: cfg.memory.bindingFile,
  })
  log.withFields(memory.health).log('memory_status')
  adapter.setPrivacyMemory(memory.privacy)
  let textMemory: ReturnType<typeof createTextMemoryAdapter> | undefined
  let voiceMemory: ReturnType<typeof createVoiceMemoryAdapter> | undefined
  if (memory.health.durableWritesEnabled) {
    textMemory = createTextMemoryAdapter({
      runtime: memory,
      characterId: memoryCharacterId,
      modelRef: `gemini:${cfg.brain.model}`,
      onFailure: error => log.withError(error).error('memory_shadow_write_failed'),
    })
    adapter.setTextMemoryObserver(textMemory)
    voiceMemory = createVoiceMemoryAdapter({
      runtime: memory,
      characterId: memoryCharacterId,
      modelRef: `gemini:${cfg.brain.model}`,
      onFailure: error => log.withError(error).error('memory_voice_trace_failed'),
    })
  }

  if (cfg.backend === 'direct') {
    // The controller subscribes to voice utterances and barge-in events; it is
    // the only orchestrator in direct mode.

    if (cfg.tts.warmupEnabled)
      await warmVoiceProfiles(rawTts, voiceProfileCatalog)
    // eslint-disable-next-line no-new
    new ConversationController({ voice, asr, brain, tts, character, promptCompiler, voiceProfileCatalog, memory: voiceMemory })
    adapter.setMentionResponder(new MentionResponder({ brain, character, promptCompiler }))
    log.log('Direct backend active: Qwen ASR → Gemini → GPT-SoVITS, with Discord text replies.')
  }
  else {
    log.log('AIRI backend active: deferring to WebSocket server.')
  }

  // Publish the shared instances so /voice-test (and any future command) can
  // reach them without re-constructing providers.
  setServices({ voice, asr, brain, tts, avatar })

  try {
    await adapter.start()
  }
  catch (error) {
    avatar.stop()
    await memory.close()
    throw error
  }

  let shutdown: Promise<void> | undefined
  async function gracefulShutdown(signal: string): Promise<void> {
    if (shutdown)
      return shutdown
    log.log(`Received ${signal}, shutting down...`)
    shutdown = (async () => {
      await adapter.stop()
      avatar.stop()
      await memory.close()
      process.exitCode = 0
    })()
    return shutdown
  }

  process.on('SIGINT', async () => {
    await gracefulShutdown('SIGINT')
  })

  process.on('SIGTERM', async () => {
    await gracefulShutdown('SIGTERM')
  })
}

async function warmVoiceProfiles(rawTts: GptSoVitsTtsProvider, catalog: import('./providers/tts/speech-style-types').VoiceProfileCatalog): Promise<void> {
  const profiles = [...catalog.profiles.values()]
    .filter(profile => profile.id === catalog.defaultProfileId || profile.warmup)
    .slice(0, 3)
  for (const profile of profiles) {
    const seed = profile.variationSeeds[0]
    if (seed === undefined)
      continue
    try {
      const stream = await rawTts.synthesize({
        text: '準備はできているわ。',
        language: 'ja',
        conditioning: {
          profileId: profile.id,
          catalogVersion: catalog.catalogVersion,
          referenceAudio: profile.referenceAudio,
          referenceText: profile.referenceText,
          promptLanguage: profile.promptLanguage,
          topK: profile.sampling.topK,
          topP: profile.sampling.topP,
          temperature: profile.sampling.temperature,
          repetitionPenalty: profile.sampling.repetitionPenalty,
          speedFactor: profile.timing.speedFactor,
          fragmentInterval: profile.timing.fragmentInterval,
          textSplitMethod: profile.timing.textSplitMethod,
          seed,
          variationIndex: 0,
        },
      }, new AbortController().signal)
      for await (const _chunk of stream) {
        // Draining forces the underlying model path; a returned stream alone is not warm-up.
      }
      log.withFields({ profileId: profile.id }).log('voice_profile_warmed')
    }
    catch (error) {
      log.withError(error).withFields({ profileId: profile.id }).warn('voice_profile_warmup_failed')
    }
  }
}

main().catch(err => log.withError(err).error('An error occurred'))
