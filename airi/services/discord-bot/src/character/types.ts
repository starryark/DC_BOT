/**
 * Character runtime types (Runtime V2, `02-public-contracts.md` §5.1).
 *
 * The immutable, normalized character loaded by {@link CharacterRegistry}. A
 * `CharacterRuntime` is what the rest of the runtime consumes — the brain
 * (via {@link PromptCompiler}), ASR (hotwords), TTS (voice profile), and the
 * avatar sink (display model + output protocol). It is pure data; it owns no
 * I/O and no provider references (`01-architecture.md` invariant #3).
 *
 * The frozen contract lives in `02-public-contracts.md` §5.1. The supporting
 * profiles (voice / asr / avatar / outputProtocol / lorebook) are sourced from
 * `extensions.dc_bot` when present (§7) and otherwise derived with safe
 * defaults so the LIVE card — which has not yet migrated `creator_notes` →
 * `extensions.dc_bot.outputProtocol` — still loads without error.
 */

/**
 * GPT-SoVITS / TTS voice profile (§5.1, §7).
 *
 * `referenceAudio` is resolved by the registry to a path **relative to the
 * card directory** (never absolute). `referenceText` is the resolved
 * transcript contents loaded from `referenceTextFile` if present — supplying
 * it fixes the GPT-SoVITS `naive_infer` fallback (`04-decisions.md` D008).
 */
export interface VoiceProfile {
  /** Provider id, e.g. `'gpt-sovits'`. */
  provider: string
  /** Voice id within the provider, e.g. `'kurisu'`. */
  voiceId: string
  /** Reference (conditioning) audio path, relative to the card directory. */
  referenceAudio: string
  /** Optional reference transcript file path, relative to the card directory. */
  referenceTextFile?: string
  /** Resolved transcript contents for the reference clip, if available. */
  referenceText?: string
  /** Conditioning prompt language, e.g. `'ja'`. */
  promptLanguage: string
}

/**
 * ASR character profile (§5.1, §7). Hotwords bias the ASR decoder toward
 * character/domain vocabulary (Wave 2B/5).
 */
export interface AsrCharacterProfile {
  /** Hotwords / biasing vocabulary, e.g. `['牧瀬紅莉栖', 'クリスティーナ']`. */
  hotwords: string[]
}

/**
 * Avatar profile (§5.1, §7). The display model id references the Live2D model
 * declared in the card's `manifest.json` (`00-current-state.md` §7).
 */
export interface AvatarProfile {
  /** Renderer id, e.g. `'live2d'`. */
  renderer: string
  /** Live2D display model id, if declared. */
  displayModelId?: string
}

/**
 * Output protocol profile (§5.1, §7, §8, `04-decisions.md` D006).
 *
 * Describes the LLM-output encoding the character is expected to emit. ACT-v1
 * is the only encoding today; `emotions` is the closed list the parser
 * validates against, `allowDelay` gates `<|DELAY:n|>` pauses.
 */
export interface OutputProtocolProfile {
  /** Encoding id, e.g. `'act-v1'`. */
  type: string
  /** Closed emotion vocabulary the parser accepts. */
  emotions: string[]
  /** Whether `<|DELAY:n|>` pauses are allowed by the parser. */
  allowDelay: boolean
}

/**
 * CCv3 character book entry surfaced as a lorebook entry (§5.1).
 *
 * The `extensions`/`enabled`/`insertionOrder` fields preserve the CCv3
 * `character_book` entry shape verbatim (preserve-and-ignore per §7); the
 * prompt compiler activates entries by `keys`.
 */
export interface LorebookEntry {
  /** Activation keywords. */
  keys: string[]
  /** Entry content injected on activation. */
  content: string
  /** Raw CCv3 entry extensions, preserved verbatim. */
  extensions?: Record<string, unknown>
  /** Whether the entry is active (defaults to true when absent). */
  enabled?: boolean
  /** Insertion precedence; lower inserts earlier. */
  insertionOrder?: number
}

/**
 * CCv3 character book surfaced as a character lorebook (§5.1). Entries are
 * activated by keyword/binding at prompt-compile time.
 */
export interface CharacterLorebook {
  entries: LorebookEntry[]
}

/**
 * The immutable, normalized character runtime (§5.1).
 *
 * Constructed by {@link CharacterRegistry.load}. Once returned, callers treat
 * it as frozen: no field is mutated by the runtime after load. `identity`
 * holds the semantic CCv3 card fields the prompt compiler consumes;
 * `voice`/`asr`/`avatar`/`outputProtocol`/`lorebook` hold the normalized
 * profile data derived from `extensions.dc_bot` (with safe defaults when
 * absent).
 */
export interface CharacterRuntime {
  /** Stable character id (the registry's lookup key). */
  id: string
  /** Display name, e.g. `'Makise Kurisu'`. */
  name: string

  /** Semantic CCv3 card fields used by the {@link PromptCompiler}. */
  identity: {
    description: string
    personality: string
    scenario: string
    /** CCv3 `data.system_prompt` — the persona. Primary persona source (D006). */
    systemPrompt: string
    /** CCv3 `data.post_history_instructions`. */
    postHistoryInstructions: string
  }

  voice: VoiceProfile
  asr: AsrCharacterProfile

  avatar?: AvatarProfile
  lorebook?: CharacterLorebook

  outputProtocol?: OutputProtocolProfile
}
