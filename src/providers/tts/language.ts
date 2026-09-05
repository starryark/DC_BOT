import type { GptSoVitsLang, TtsLanguage } from './types'

/**
 * The single authoritative language layer for TTS (Language_Fix_Proposal §8–§13).
 *
 * Two concerns are kept strictly separate:
 *
 *   prompt_lang  — language of the Kurisu reference clip (config, always `ja`).
 *                  Never touched here; the provider reads it from config.
 *
 *   text_lang    — language of the text *currently being synthesized*. That is
 *                  a property of the speech, not of the voice. This module owns
 *                  its resolution.
 *
 * Resolution precedence (§10):
 *   1. Strong script evidence in the generated text (kana ⇒ ja, Latin-dominant
 *      ⇒ en, Han-with-kana-context ⇒ ja).
 *   2. The current turn's ASR language, as a *hint* (normalized).
 *   3. `auto` — defer to GPT-SoVITS' per-segment LangSegmenter.
 *
 * Short / punctuation-only fragments are deliberately not classified from
 * script alone (§11, §28): `嗯？`, `OK.`, or a lone `今日` are ambiguous, so the
 * ASR hint (then `auto`) is used instead of forcing a guess.
 */

const SUPPORTED: readonly TtsLanguage[] = ['zh', 'en', 'ja']

/**
 * Normalize any language code the system can produce into a GPT-SoVITS
 * `text_lang`. ASR already emits `zh|en|ja|und` (see qwen3-asr `normalize_language`),
 * but callers may pass BCP-47 tags or `und`; only aliases that can actually
 * occur are mapped (§8).
 */
export function normalizeLanguage(raw: string | undefined | null): GptSoVitsLang {
  if (raw == null)
    return 'auto'
  const code = raw.trim().toLowerCase()
  if (!code || code === 'und')
    return 'auto'

  // BCP-47-ish: take the primary subtag (`zh`, `en-US` → `en`).
  const primary = code.split('-')[0]
  switch (primary) {
    case 'zh':
    case 'cmn': // ISO 639-3 for Mandarin
    case 'yue': // GPT-SoVITS treats Cantonese separately; map to zh for our 3-lang world
      return 'zh'
    case 'ja':
    case 'jp': // common typo / shorthand
      return 'ja'
    case 'en':
      return 'en'
    default:
      // Unknown 2-letter code from an unmapped ASR fallback → let GPT-SoVITS decide.
      return 'auto'
  }
}

/** Minimum non-punctuation length before script detection is trusted. */
const MIN_DETECT_CHARS = 4

/**
 * Script-based heuristic for text long enough to trust (the length gate lives in
 * {@link resolveTtsLanguage}). Returns `null` only when the script mix gives no
 * usable signal.
 *
 * Design notes (Language_Fix_Proposal §11):
 *   - Kana (hiragana/katakana) is strong Japanese evidence even alongside kanji.
 *   - Han with NO kana is treated as Chinese. A real Chinese sentence is pure
 *     Han; a Japanese conversational reply almost always carries kana particles.
 *     The genuinely-ambiguous case (`今日`, a lone shared kanji token) is handled
 *     by the length threshold — it never reaches this function.
 *   - Latin with no CJK ⇒ English.
 *   - Mixed CJK+Latin with no kana defaults to Chinese (a Chinese sentence with
 *     an English name/term), unless Latin dominates heavily.
 */
function detectFromScript(text: string): TtsLanguage | null {
  const cjk = (text.match(/[\u4E00-\u9FFF]/g) ?? []).length
  const kana = (text.match(/[\u3040-\u30FF]/g) ?? []).length
  const latin = (text.match(/[A-Z]/gi) ?? []).length

  // Kana (hiragana/katakana) ⇒ Japanese even if kanji are present.
  if (kana > 0 && kana >= cjk * 0.1)
    return 'ja'

  // Han present with no kana ⇒ Chinese (the shared-kanji ambiguity is handled
  // by the length gate for short tokens).
  if (cjk > 0)
    return latin > cjk * 3 ? 'en' : 'zh'

  if (latin > 0)
    return 'en'

  return null
}

function meaningfulChars(text: string): number {
  return (text.match(/[\p{L}\p{N}]/gu) ?? []).length
}

export interface ResolveTtsLanguageOptions {
  text: string
  /** ASR-detected language for the enclosing turn (`zh|en|ja|und|…`). */
  inputLanguageHint?: string
  /**
   * Configured `text_lang` fallback (Language_Fix_Proposal §14), already a
   * GPT-SoVITS code (`zh|en|ja|auto`). Defaults to `auto`.
   */
  textLangFallback?: GptSoVitsLang
}

/** Why the resolver settled on its answer — surfaced in logs (§33). */
export type LanguageResolutionSource = 'text-detection' | 'asr-hint' | 'auto'

export interface ResolvedTtsLanguage {
  language: GptSoVitsLang
  source: LanguageResolutionSource
}

/**
 * Resolve the GPT-SoVITS `text_lang` for one speech chunk. This is the one
 * function orchestration should call; it never forces a guess on tiny or
 * ambiguous fragments (§28).
 */
export function resolveTtsLanguage(opts: ResolveTtsLanguageOptions): ResolvedTtsLanguage {
  const { text, inputLanguageHint, textLangFallback = 'auto' } = opts

  // 1. Strong script evidence — but only when there is enough text to trust it.
  if (meaningfulChars(text) >= MIN_DETECT_CHARS) {
    const detected = detectFromScript(text)
    if (detected)
      return { language: detected, source: 'text-detection' }
  }

  // 2. ASR turn hint.
  if (inputLanguageHint) {
    const normalized = normalizeLanguage(inputLanguageHint)
    if (normalized !== 'auto')
      return { language: normalized, source: 'asr-hint' }
  }

  // 3. Configured fallback (default `auto`).
  return { language: textLangFallback, source: 'auto' }
}

/**
 * Backwards-compatible detector for callers that have only text (e.g.
 * `/voice-test` with no language given). Prefer {@link resolveTtsLanguage} in
 * the streaming path so the ASR hint is honored.
 */
export function detectTextLanguageForTts(text: string): GptSoVitsLang {
  return resolveTtsLanguage({ text }).language
}

/**
 * GPT-SoVITS `text_lang` values accepted by `check_params` are exactly the
 * `v2_languages` list, which includes our four outputs (`zh`/`en`/`ja`/`auto`).
 * Our internal codes already match, so this is a passthrough kept as a seam in
 * case a provider build needs different codes.
 */
export function toGptSoVitsLang(lang: GptSoVitsLang): GptSoVitsLang {
  return lang
}

/** Type guard for the constrained TTS language set (excludes `auto`). */
export function isTtsLanguage(lang: string): lang is TtsLanguage {
  return (SUPPORTED as readonly string[]).includes(lang)
}
