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

export interface TtsRequest {
  text: string
  /** Resolved target language; `auto` defers segmentation to GPT-SoVITS. */
  language: GptSoVitsLang
}

export interface TtsProvider {
  synthesize: (request: TtsRequest, signal: AbortSignal) => Promise<Readable>
}
