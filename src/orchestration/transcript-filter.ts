/**
 * Transcript normalization and pre-model filtering (Optimize.md §9 Agent 1B).
 *
 * Short utterances dominate this bot's traffic: 19 of 24 recorded syntheses came
 * from fragments of ≤16 characters, and standalone `嗯。` / `我。` / `Hello.`
 * each cost a full Gemini request (`baseline-findings.md` §1, §5). Everything
 * here runs *before* the model, is pure, and reports a machine-readable reason
 * so drops are measurable rather than invisible.
 */

/**
 * Standalone fillers, by language. Only ever matched against a whole
 * transcript — `um` inside a sentence is speech, not filler, so these are never
 * applied as substring rules.
 */
const FILLERS: Record<'en' | 'zh' | 'ja', readonly string[]> = {
  en: ['uh', 'um', 'hmm', 'mhm'],
  zh: ['嗯', '呃', '啊'],
  ja: ['えー', 'えっと', 'うん'],
}

/**
 * Words that are filler in idle chat but carry the whole meaning when the bot
 * asked a yes/no question. Kept separate from {@link FILLERS} because the
 * exemption is contextual, not linguistic.
 */
const CONFIRMATION_WORDS = new Set(['yes', 'no', 'yeah', 'yep', 'nope', '嗯', '对', '不', 'うん', 'はい', 'いいえ'])

/** Latin transcripts shorter than this are ASR noise rather than speech. */
const MIN_LATIN_CHARS = 2

/** A user's last accepted transcript, used for duplicate suppression. */
export interface RecentTranscript {
  normalizedText: string
  /** Epoch ms when it was accepted. */
  at: number
}

export interface TranscriptFilterContext {
  /** ASR-detected language, used to pick a filler set; all sets apply when absent. */
  language?: string
  /** True when the bot's previous turn asked something a bare "yes"/"嗯" answers. */
  awaitingConfirmation: boolean
  /** The same speaker's last accepted transcript, if any. Never another user's. */
  recentTranscript?: RecentTranscript
  /** Duplicate-suppression window in ms. */
  duplicateWindowMs: number
  now: number
}

export type TranscriptRejectionReason = 'empty' | 'too_short' | 'filler' | 'duplicate'

export interface TranscriptFilterResult {
  accept: boolean
  normalizedText: string
  reason?: TranscriptRejectionReason
}

/**
 * Normalize an ASR transcript for prompting and storage.
 *
 * Before:
 * - `"  Hello ,   world !  "`
 * - `"你好 ， 世界 。"`
 *
 * After:
 * - `"Hello, world!"`
 * - `"你好，世界。"`
 *
 * Deliberately uses **NFC, not NFKC**. NFKC would fold full-width CJK
 * punctuation onto ASCII (`，` → `,`), changing the typography that GPT-SoVITS
 * segments and prosodizes on — a normalization step must not silently rewrite
 * how Chinese and Japanese are spoken. Width folding is applied only to the
 * throwaway comparison key in {@link fillerKey}, where it cannot reach TTS.
 *
 * Casing is preserved because it is semantic (proper nouns, acronyms). No
 * translation or rewriting happens here — the model must see what was said.
 */
export function normalizeTranscript(text: string, _language?: string): string {
  if (typeof text !== 'string')
    return ''

  return text
    .normalize('NFC')
    // Strip zero-width joiners/marks that ASR occasionally emits around CJK.
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    // Drop the space ASR leaves *before* punctuation.
    .replace(/\s+([,.!?;:，。！？；：、])/g, '$1')
    // CJK full-width punctuation carries its own trailing whitespace, so a
    // space after it is an ASR artifact. ASCII punctuation keeps its space,
    // which English needs.
    .replace(/([，。！？；：、])\s+/g, '$1')
    .trim()
}

/** True when the string contains no letter, digit, or CJK glyph. */
function isPunctuationOnly(text: string): boolean {
  return !/[\p{L}\p{N}]/u.test(text)
}

/**
 * Reduce to a comparable core: width-folded, punctuation-free, lowercased.
 *
 * NFKC is safe here precisely because this string is never spoken or stored —
 * it exists only to decide whether `Ｕｍ．` and `um` are the same filler.
 */
function fillerKey(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .toLowerCase()
}

/**
 * True when the text contains kana or Han characters.
 *
 * Script properties rather than codepoint ranges: a single Han glyph is a whole
 * word, so it must never be rejected as "too short", and spelling that intent
 * as `\p{Script=Han}` keeps it readable and complete (the old BMP ranges missed
 * the Han extension planes entirely).
 */
function hasCjk(text: string): boolean {
  return /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(text)
}

/**
 * Decide whether a transcript is worth a model call.
 *
 * Order matters and is fixed by `architecture-contract.md` §8: empty →
 * too-short → filler → duplicate. Each check is cheaper and more certain than
 * the next, and the reported reason is the first one that matched.
 */
export function filterTranscript(raw: string, context: TranscriptFilterContext): TranscriptFilterResult {
  const normalizedText = normalizeTranscript(raw, context.language)

  if (normalizedText === '' || isPunctuationOnly(normalizedText))
    return { accept: false, normalizedText, reason: 'empty' }

  const key = fillerKey(normalizedText)
  if (key === '')
    return { accept: false, normalizedText, reason: 'empty' }

  // A confirmation answer is the entire content of its turn; it must survive
  // both the filler and length rules when the bot actually asked something.
  const isConfirmation = context.awaitingConfirmation && CONFIRMATION_WORDS.has(key)

  if (!isConfirmation && !hasCjk(normalizedText) && key.length < MIN_LATIN_CHARS)
    return { accept: false, normalizedText, reason: 'too_short' }

  if (!isConfirmation && isFiller(key, context.language))
    return { accept: false, normalizedText, reason: 'filler' }

  const recent = context.recentTranscript
  if (recent
    && recent.normalizedText === normalizedText
    && context.now - recent.at < context.duplicateWindowMs) {
    return { accept: false, normalizedText, reason: 'duplicate' }
  }

  return { accept: true, normalizedText }
}

/**
 * Match against the language's filler set, falling back to every set when the
 * ASR language is unknown or unsupported — a mislabelled `und` turn should
 * still not spend a model call on "um".
 */
function isFiller(key: string, language?: string): boolean {
  const lang = (language ?? '').slice(0, 2).toLowerCase()
  const sets = lang === 'en' || lang === 'zh' || lang === 'ja'
    ? [FILLERS[lang]]
    : [FILLERS.en, FILLERS.zh, FILLERS.ja]
  return sets.some(set => set.includes(key))
}
