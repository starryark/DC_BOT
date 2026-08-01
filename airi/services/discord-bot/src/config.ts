import { env } from 'node:process'

/**
 * Centralized, validated runtime configuration.
 *
 * All environment reads live here. Nothing in `src/` reads `process.env` for
 * runtime config directly — it goes through `config()`. This replaces the
 * scattered, unguarded `env.OPENAI_STT_*` reads that previously lived inline.
 *
 * Env is injected by the `tsx --env-file=.env` flag in the `start` script; no
 * `dotenv` import is used.
 */

/**
 * How the bot treats speech that arrives while it is already working on a turn
 * (`architecture-contract.md` §3).
 *
 * - `half_duplex` — the default. Speech during `thinking`/`speaking` is dropped
 *   before ASR and never backlogged.
 * - `latest_wins` — at most one waiting turn, replaced by the newest.
 * - `barge_in` — busy-state speech cancels the active response.
 */
export type InputPolicy = 'half_duplex' | 'latest_wins' | 'barge_in'

export interface VoiceEndpointConfig {
  /** Trailing silence after which a user's utterance is finalized. */
  endSilenceMs: number
  /** Utterances shorter than this are discarded as noise. */
  minUtteranceMs: number
  /** Hard cap on a single utterance; forces a finalize. */
  maxUtteranceMs: number
  /** Moving-average window (in 20ms PCM frames) for barge-in detection. */
  bargeInWindowFrames: number
  /** Average-amplitude threshold (0..1) that triggers barge-in. */
  bargeInThreshold: number
  /**
   * Gates the amplitude-triggered barge-in detector entirely. Default `false`
   * (D-V06): a single loud packet must not stop playback, and half-duplex
   * admission already drops busy-state speech.
   */
  bargeInEnabled: boolean
  /**
   * Window in which an identical normalized transcript from the SAME user is
   * rejected as a duplicate. Never applied across users.
   */
  duplicateWindowMs: number
  /** When true, dump each finalized utterance to a WAV under ./dumps/. */
  debugDumpAudio: boolean
}

export interface AsrClientConfig {
  baseUrl: string
  requestTimeoutMs: number
}

export interface BrainConfig {
  provider: 'gemini'
  apiKey: string
  model: string
  maxMessages: number
  /** Requests per minute allowed by the local limiter; kept below the account quota. */
  requestsPerMinute: number
  /** Maximum in-flight generations across the process. */
  maxConcurrentRequests: number
  /** Cooldown applied when a 429 carries no parseable retry delay. */
  defaultCooldownMs: number
  /** Minimum gap between spoken "temporarily unable to answer" prompts. */
  cooldownPromptIntervalMs: number
}

/**
 * Character card selection. The registry reads `card.json` from
 * `<root>/<id>/`, so `root` is the directory *containing* character folders —
 * not the card itself.
 */
export interface CharacterConfig {
  /**
   * Directory holding `<id>/card.json`. Relative paths resolve against the
   * bot's working directory (`airi/services/discord-bot`). Empty disables the
   * character runtime, and the brain falls back to a persona-less prompt.
   */
  root: string
  /** Character folder name under {@link root}. */
  id: string
}

export interface TtsClientConfig {
  baseUrl: string
  requestTimeoutMs: number
  refAudioPath: string
  promptText: string
  promptLang: string
  /**
   * Fallback `text_lang` when neither the ASR-detected language nor strong text
   * evidence is available. `auto` (default) defers to GPT-SoVITS' per-segment
   * LangSegmenter. This is a fallback only — it does not disable per-turn routing.
   */
  textLangFallback: 'zh' | 'en' | 'ja' | 'auto'
  streamingMode: number
  /** Operator-managed identity of the weights loaded by GPT-SoVITS. Empty disables caching. */
  voiceModelVersion: string
}

export interface TtsCacheConfig {
  enabled: boolean
  directory: string
  maxBytes: number
  maxItems: number
  ttlMs: number
  memoryItems: number
}

export interface TtsChunkingConfig {
  minLatinChars: number
  targetLatinChars: number
  maxLatinChars: number
  minCjkChars: number
  targetCjkChars: number
  maxCjkChars: number
  maxWaitMs: number
  /** Wave 3 currently supports exactly one bounded synthesized lookahead. */
  prefetchChunks: 1
}

export interface ConversationFloorConfig {
  groupWindowMs: number
  activeSpeakerLeaseMs: number
  maxGroupSpeakers: number
  maxGroupUtterances: number
}

export interface AppConfig {
  /** `direct` runs Qwen→Gemini→GPT-SoVITS in-process; `airi` defers to the WS server. */
  backend: 'direct' | 'airi'

  discordToken: string
  discordClientId: string

  /** Legacy / optional AIRI server connection. */
  airiToken: string
  airiUrl: string

  /** Conversation admission policy for busy-state speech. */
  inputPolicy: InputPolicy

  voice: VoiceEndpointConfig
  asr: AsrClientConfig
  brain: BrainConfig
  character: CharacterConfig
  tts: TtsClientConfig
  ttsCache: TtsCacheConfig
  ttsChunking: TtsChunkingConfig
  conversationFloor: ConversationFloorConfig
  avatar: {
    enabled: boolean
    relayUrl: string
    publishToken: string
    debugCommandEnabled: boolean
  }
}

/**
 * Parse a numeric setting that must be strictly positive and within a sane
 * ceiling (Optimize.md §13 step 3). A negative, zero, non-finite, or
 * absurdly large value is a misconfiguration that would silently disable
 * endpointing or rate limiting, so it falls back to the documented default
 * rather than being honored.
 */
function parseBounded(raw: string | undefined, fallback: number, max: number): number {
  if (raw == null || raw === '')
    return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > max)
    return fallback
  return n
}

/** Parse an integer range that may include zero (for enum-like numeric settings). */
function parseBoundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw === '')
    return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max)
    return fallback
  return n
}

function parseInputPolicy(raw: string | undefined): InputPolicy {
  const v = (raw ?? '').trim().toLowerCase()
  if (v === 'latest_wins' || v === 'barge_in' || v === 'half_duplex')
    return v
  return 'half_duplex'
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '')
    return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

/** Constrain GPT_SOVITS_TEXT_LANG to the GPT-SoVITS-accepted target values. */
function parseTextLangFallback(raw: string | undefined): 'zh' | 'en' | 'ja' | 'auto' {
  const allowed = ['zh', 'en', 'ja', 'auto'] as const
  const v = (raw ?? '').trim().toLowerCase() as 'zh' | 'en' | 'ja' | 'auto'
  return (allowed as readonly string[]).includes(v) ? v : 'auto'
}

let cached: AppConfig | null = null

export function config(): AppConfig {
  if (cached)
    return cached

  const backend = (env.BOT_BACKEND || 'direct') === 'airi' ? 'airi' : 'direct'

  const result: AppConfig = {
    backend,

    discordToken: env.DISCORD_TOKEN || '',
    discordClientId: env.DISCORD_BOT_CLIENT_ID || '',

    airiToken: env.AIRI_TOKEN || 'abcd',
    airiUrl: env.AIRI_URL || 'ws://localhost:6121/ws',

    inputPolicy: parseInputPolicy(env.BOT_INPUT_POLICY),

    voice: {
      // 900 ms (was 650) so a natural mid-sentence pause no longer finalizes a
      // fragment — baseline-findings.md §5 traced most filler turns to this.
      endSilenceMs: parseBounded(env.VOICE_END_SILENCE_MS, 900, 10_000),
      minUtteranceMs: parseBounded(env.VOICE_MIN_UTTERANCE_MS, 300, 10_000),
      maxUtteranceMs: parseBounded(env.VOICE_MAX_UTTERANCE_MS, 30_000, 300_000),
      bargeInWindowFrames: parseBounded(env.BARGE_IN_WINDOW_FRAMES, 30, 1000),
      bargeInThreshold: parseBounded(env.BARGE_IN_THRESHOLD, 0.05, 1),
      bargeInEnabled: parseBool(env.BARGE_IN_ENABLED, false),
      duplicateWindowMs: parseBounded(env.VOICE_DUPLICATE_WINDOW_MS, 3_000, 120_000),
      debugDumpAudio: parseBool(env.DEBUG_DUMP_AUDIO, false),
    },

    asr: {
      baseUrl: (env.ASR_BASE_URL || 'http://127.0.0.1:8765').replace(/\/$/, ''),
      requestTimeoutMs: parseBounded(env.ASR_REQUEST_TIMEOUT_MS, 15_000, 300_000),
    },

    brain: {
      provider: 'gemini',
      apiKey: env.GEMINI_API_KEY || '',
      model: env.GEMINI_MODEL || 'gemini-3.6-flash',
      maxMessages: parseBoundedInteger(env.CONVERSATION_MAX_MESSAGES, 24, 1, 1000),
      // Deliberately below the free-tier account limit so the local limiter,
      // not the API, is what shapes traffic (Optimize.md §9 Agent 1C).
      requestsPerMinute: parseBounded(env.GEMINI_REQUESTS_PER_MINUTE, 4, 1000),
      maxConcurrentRequests: parseBounded(env.GEMINI_MAX_CONCURRENT_REQUESTS, 1, 32),
      defaultCooldownMs: parseBounded(env.GEMINI_DEFAULT_COOLDOWN_MS, 60_000, 3_600_000),
      cooldownPromptIntervalMs: parseBounded(env.GEMINI_COOLDOWN_PROMPT_INTERVAL_MS, 60_000, 3_600_000),
    },

    character: {
      // The bundled card is <repo>/Makise Kurisu/card.json, and the registry
      // joins `<root>/<id>/card.json` — so the root is the repo dir, three
      // levels above the bot's working directory. `??` (not `||`) so
      // CHARACTER_PATH= can deliberately turn the character runtime off.
      root: env.CHARACTER_PATH ?? '../../..',
      id: env.CHARACTER_ID || 'Makise Kurisu',
    },

    tts: {
      baseUrl: (env.GPT_SOVITS_URL || 'http://127.0.0.1:9880').replace(/\/$/, ''),
      requestTimeoutMs: parseBounded(env.GPT_SOVITS_REQUEST_TIMEOUT_MS, 30_000, 600_000),
      refAudioPath: env.GPT_SOVITS_REF_AUDIO || '',
      promptText: env.GPT_SOVITS_PROMPT_TEXT || '',
      promptLang: env.GPT_SOVITS_PROMPT_LANG || 'ja',
      textLangFallback: parseTextLangFallback(env.GPT_SOVITS_TEXT_LANG),
      streamingMode: parseBoundedInteger(env.GPT_SOVITS_STREAMING_MODE, 0, 0, 3),
      voiceModelVersion: env.GPT_SOVITS_VOICE_MODEL_VERSION || '',
    },
    ttsCache: {
      enabled: parseBool(env.TTS_CACHE_ENABLED, true),
      directory: env.TTS_CACHE_DIR || '.cache/tts',
      maxBytes: parseBounded(env.TTS_CACHE_MAX_MB, 512, 102_400) * 1024 * 1024,
      maxItems: parseBounded(env.TTS_CACHE_MAX_ITEMS, 1000, 1_000_000),
      ttlMs: parseBounded(env.TTS_CACHE_TTL_HOURS, 168, 24 * 3650) * 60 * 60 * 1000,
      memoryItems: parseBounded(env.TTS_CACHE_MEMORY_ITEMS, 32, 10_000),
    },
    ttsChunking: {
      minLatinChars: parseBounded(env.TTS_CHUNK_MIN_LATIN_CHARS, 40, 1000),
      targetLatinChars: parseBounded(env.TTS_CHUNK_TARGET_LATIN_CHARS, 75, 1000),
      maxLatinChars: parseBounded(env.TTS_CHUNK_MAX_LATIN_CHARS, 120, 1000),
      minCjkChars: parseBounded(env.TTS_CHUNK_MIN_CJK_CHARS, 14, 500),
      targetCjkChars: parseBounded(env.TTS_CHUNK_TARGET_CJK_CHARS, 28, 500),
      maxCjkChars: parseBounded(env.TTS_CHUNK_MAX_CJK_CHARS, 50, 500),
      maxWaitMs: parseBounded(env.TTS_CHUNK_MAX_WAIT_MS, 900, 10_000),
      // A larger value would violate the frozen cancellation-waste bound.
      prefetchChunks: parseBounded(env.TTS_PREFETCH_CHUNKS, 1, 1) as 1,
    },
    conversationFloor: {
      groupWindowMs: parseBounded(env.VOICE_GROUP_WINDOW_MS, 800, 10_000),
      activeSpeakerLeaseMs: parseBounded(env.VOICE_ACTIVE_SPEAKER_LEASE_MS, 5_000, 60_000),
      maxGroupSpeakers: parseBounded(env.VOICE_MAX_GROUP_SPEAKERS, 2, 20),
      maxGroupUtterances: parseBounded(env.VOICE_MAX_GROUP_UTTERANCES, 4, 100),
    },
    avatar: {
      enabled: parseBool(env.AVATAR_ENABLED, false),
      relayUrl: env.AVATAR_RELAY_URL || 'ws://127.0.0.1:8080/ws/publisher',
      publishToken: env.AVATAR_RELAY_PUBLISH_TOKEN || '',
      debugCommandEnabled: parseBool(env.AVATAR_DEBUG_COMMAND_ENABLED, false),
    },
  }

  if (result.avatar.enabled) {
    const problems: string[] = []
    if (!result.avatar.publishToken)
      problems.push('publisher token is missing')
    try {
      const url = new URL(result.avatar.relayUrl)
      if (url.protocol !== 'ws:' && url.protocol !== 'wss:')
        problems.push('publisher URL must use ws or wss')
    }
    catch {
      problems.push('publisher URL is invalid')
    }
    if (problems.length)
      throw new Error(`Invalid avatar configuration: ${problems.join('; ')}`)
  }
  cached = result
  return result
}

/** Reset the cache. Only used in tests. */
export function resetConfigCache(): void {
  cached = null
}
