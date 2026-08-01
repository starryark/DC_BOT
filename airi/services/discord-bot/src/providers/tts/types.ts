import type { Readable } from 'node:stream'

/**
 * TTS provider interface (plan.md §11). Discord classes know only this
 * interface — never "GPT-SoVITS" by name.
 *
 * `synthesize` returns a readable byte stream (WAV or PCM) ready to hand to
 * `VoiceManager.playAudioStream(guildId, stream)`.
 */
/** Languages the provider interface accepts as a definite target. */
export type TtsLanguage = 'zh' | 'en' | 'ja'

/**
 * `text_lang` values the checked-in GPT-SoVITS api_v2 accepts (verified in
 * `TTS.py` `v2_languages`). `auto` lets GPT-SoVITS' `LangSegmenter` detect the
 * language per segment — the correct fallback for mixed/ambiguous text. It is a
 * resolver *output*, so `TtsRequest.language` is widened to allow it.
 */
export type GptSoVitsLang = TtsLanguage | 'auto'

/** Complete acoustic conditioning resolved before crossing the provider boundary. */
export interface TtsConditioning {
  profileId: string
  catalogVersion: string
  referenceAudio: string
  referenceText: string
  promptLanguage: GptSoVitsLang
  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number
  speedFactor: number
  fragmentInterval: number
  textSplitMethod: string
  seed: number
  variationIndex: number
}

/** Correlation data for logs only; it must never affect synthesis or caching. */
export interface TtsTraceContext {
  guildId: string
  turnId: string
  responseEpoch: number
  chunkIndex: number
}

export interface TtsRequest {
  text: string
  /** Resolved target language; `auto` defers segmentation to GPT-SoVITS. */
  language: GptSoVitsLang
  /** Included in cache identity when speech normalization rules change. */
  pronunciationProfileVersion?: string
  conditioning?: TtsConditioning
  trace?: TtsTraceContext
}

export interface TtsProvider {
  synthesize: (request: TtsRequest, signal: AbortSignal) => Promise<Readable>
}
