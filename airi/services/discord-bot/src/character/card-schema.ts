/**
 * Character Card V3 schema + DC_BOT extension (Runtime V2,
 * `02-public-contracts.md` §7).
 *
 * Defines TypeScript types for the CCv3 card (`spec` / `spec_version` /
 * `data`), the `extensions.dc_bot` block (voice / asr / avatar /
 * outputProtocol), and the validation + normalization helpers consumed by
 * {@link CharacterRegistry}.
 *
 * Preserve-and-ignore policy (§7): unknown CCv3 fields MUST survive parsing.
 * The card types below therefore only name the fields the runtime reads; the
 * parsed card object is typed as a loose record so anything we do not model
 * passes through unchanged.
 *
 * `creator_notes` is intentionally NOT a prompt field (D006): it is kept on
 * the card for authoring but is never auto-injected. The ACT protocol that
 * currently lives there is migrated to `extensions.dc_bot.outputProtocol`;
 * until the Integration Lead performs that migration, `normalizeDcBotExtension`
 * derives a default `outputProtocol` so the LIVE card still loads.
 */

import type {
  CharacterLorebook,
  LorebookEntry,
} from './types'

/**
 * The canonical ACT-v1 emotion vocabulary (`02 §7`, mirrored from the card's
 * `creator_notes`). Used as the fallback for
 * `outputProtocol.emotions` when the card has no `extensions.dc_bot`.
 */
export const CANONICAL_EMOTIONS = [
  'happy',
  'sad',
  'angry',
  'think',
  'surprised',
  'awkward',
  'question',
  'curious',
  'neutral',
] as const

/** A single CCv3 character_book entry (preserve-and-ignore). */
export interface CharacterBookEntry {
  keys?: unknown
  content?: unknown
  extensions?: unknown
  enabled?: unknown
  insertionOrder?: unknown
  comment?: unknown
  name?: unknown
  id?: unknown
  keywords?: unknown
  caseSensitive?: unknown
  matchWholeWords?: unknown
  selectLogic?: unknown
  priority?: unknown
  probability?: unknown
  position?: unknown
  role?: unknown
  depth?: unknown
  group?: unknown
  groupOverride?: unknown
  groupWeight?: unknown
  constant?: unknown
  vectorized?: unknown
  extensions$?: unknown
  [key: string]: unknown
}

/** Loose CCv3 `character_book` shape (only fields we read are named). */
export interface CharacterBook {
  entries?: unknown
  name?: unknown
  description?: unknown
  scanDepth?: unknown
  tokenBudget?: unknown
  recursiveScanning?: unknown
  extensions?: unknown
  [key: string]: unknown
}

/**
 * Loose CCv3 `data` object. Required fields (`name`, `system_prompt`) are
 * typed; every other field is `unknown` and survives parsing verbatim
 * (preserve-and-ignore, §7).
 */
export interface CharaCardV3Data {
  name?: unknown
  description?: unknown
  personality?: unknown
  scenario?: unknown
  first_mes?: unknown
  alternate_greetings?: unknown
  group_only_greetings?: unknown
  character_version?: unknown
  creator?: unknown
  creator_notes?: unknown
  system_prompt?: unknown
  post_history_instructions?: unknown
  mes_example?: unknown
  tags?: unknown
  character_book?: CharacterBook | unknown
  extensions?: unknown
  [key: string]: unknown
}

/** The top-level CCv3 card envelope. */
export interface CharaCardV3 {
  spec?: unknown
  spec_version?: unknown
  data?: CharaCardV3Data | unknown
  [key: string]: unknown
}

/**
 * `extensions.dc_bot` block (§7).
 *
 * MUST NOT store secrets/tokens/absolute paths/ports/device selection (those
 * stay deployment config). Every sub-block is optional; the registry fills
 * safe defaults for missing pieces.
 */
export interface DcBotExtensionVoice {
  provider?: string
  voiceId?: string
  referenceAudio?: string
  referenceTextFile?: string
  promptLanguage?: string
}

export interface DcBotExtensionAsr {
  hotwords?: unknown
}

export interface DcBotExtensionAvatar {
  renderer?: string
  displayModelId?: string
}

export interface DcBotExtensionOutputProtocol {
  type?: string
  emotions?: unknown
  allowDelay?: unknown
}

export interface DcBotExtension {
  outputProtocol?: DcBotExtensionOutputProtocol
  voice?: DcBotExtensionVoice
  asr?: DcBotExtensionAsr
  avatar?: DcBotExtensionAvatar
  [key: string]: unknown
}

/**
 * Concrete (post-normalization) shapes. The loose {@link DcBotExtension*}
 * types above model raw card input where every field is `unknown`; these
 * normalized types describe the validated values the runtime reads.
 */
export interface NormalizedDcBotVoice {
  provider: string
  voiceId: string
  referenceAudio: string
  referenceTextFile?: string
  promptLanguage: string
}

export interface NormalizedDcBotAsr {
  hotwords: string[]
}

export interface NormalizedDcBotAvatar {
  renderer: string
  displayModelId?: string
}

export interface NormalizedDcBotOutputProtocol {
  type: string
  emotions: string[]
  allowDelay: boolean
}

export interface NormalizedDcBotExtension {
  outputProtocol: NormalizedDcBotOutputProtocol
  voice: NormalizedDcBotVoice
  asr: NormalizedDcBotAsr
  avatar: NormalizedDcBotAvatar
}

/**
 * Validation result: either the parsed card (sufficient to normalize) or a
 * list of clear, user-facing error messages. `validateCard` never throws for
 * ordinary malformed input — it returns `errors` so callers can surface them.
 */
export interface CardValidation {
  ok: boolean
  /** The loosely-typed card envelope when parsing produced JSON, else null. */
  card: CharaCardV3 | null
  /** Empty when valid; human-readable reasons otherwise. */
  errors: string[]
  /** Non-fatal warnings (e.g. unknown spec_version minor). */
  warnings: string[]
}

export const CCV3_SPEC = 'chara_card_v3'
export const CCV3_SPEC_VERSION_MAJOR = 3

/**
 * Validate a CCv3 card envelope (`02 §7` validation rules).
 *
 * - `spec === 'chara_card_v3'` (required).
 * - `spec_version` major is `3`; warn-but-accept on a minor mismatch.
 * - `data.name` and `data.system_prompt` are required non-empty strings.
 *
 * Unknown fields are intentionally not checked here — preserve-and-ignore.
 * This function does not throw for malformed card content; it returns errors.
 * It throws only if `raw` is not a JSON-parseable string or not an object.
 */
export function validateCard(raw: string): CardValidation {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    return {
      ok: false,
      card: null,
      errors: [`card is not valid JSON: ${(err as Error).message}`],
      warnings: [],
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      card: null,
      errors: ['card root must be a JSON object'],
      warnings: [],
    }
  }

  const card = parsed as CharaCardV3
  const errors: string[] = []
  const warnings: string[] = []

  if (card.spec !== CCV3_SPEC) {
    errors.push(
      `spec must be '${CCV3_SPEC}' (got ${JSON.stringify(card.spec)}); `
      + `set "spec": "${CCV3_SPEC}" at the card root.`,
    )
  }

  if (card.spec_version !== undefined) {
    const major = parseSpecVersionMajor(card.spec_version)
    if (major === null) {
      warnings.push(
        `spec_version is not a recognized number (got ${JSON.stringify(card.spec_version)}); accepting.`,
      )
    }
    else if (major !== CCV3_SPEC_VERSION_MAJOR) {
      warnings.push(
        `spec_version major is ${major}, expected ${CCV3_SPEC_VERSION_MAJOR}; accepting as a minor mismatch.`,
      )
    }
  }
  else {
    warnings.push('spec_version is missing; accepting as a minor mismatch.')
  }

  const data = card.data
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    errors.push('data must be a JSON object with character fields.')
    return { ok: errors.length === 0, card, errors, warnings }
  }

  const dataObj = data as CharaCardV3Data
  if (typeof dataObj.name !== 'string' || dataObj.name.trim() === '') {
    errors.push('data.name is required and must be a non-empty string.')
  }
  if (typeof dataObj.system_prompt !== 'string' || dataObj.system_prompt.trim() === '') {
    errors.push('data.system_prompt is required and must be a non-empty string (this is the persona).')
  }

  return { ok: errors.length === 0, card, errors, warnings }
}

/**
 * Best-effort extraction of the major version from a CCv3 `spec_version`
 * value (commonly the number `3.0`). Returns null when not recognized.
 */
function parseSpecVersionMajor(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v))
    return Math.trunc(v)
  if (typeof v === 'string') {
    const trimmed = v.trim()
    if (/^\d+(?:\.\d+)*$/.test(trimmed))
      return Number.parseInt(trimmed, 10)
  }
  return null
}

/**
 * Pull the `extensions.dc_bot` block from a validated card, or null when
 * absent. Does not validate; {@link normalizeDcBotExtension} fills defaults.
 */
export function readDcBotExtension(card: CharaCardV3): DcBotExtension | null {
  const data = card.data
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return null
  const dataObj = data as CharaCardV3Data
  const ext = dataObj.extensions
  if (typeof ext !== 'object' || ext === null || Array.isArray(ext))
    return null
  const dcBot = (ext as Record<string, unknown>).dc_bot
  if (typeof dcBot !== 'object' || dcBot === null || Array.isArray(dcBot))
    return null
  return dcBot as DcBotExtension
}

/**
 * Pull the `extensions.airi` block verbatim (preserve-and-ignore, §7). Returns
 * the raw value when present (any shape), else undefined.
 */
export function readAiriExtension(card: CharaCardV3): unknown {
  const data = card.data
  if (typeof data !== 'object' || data === null || Array.isArray(data))
    return undefined
  const dataObj = data as CharaCardV3Data
  const ext = dataObj.extensions
  if (typeof ext !== 'object' || ext === null || Array.isArray(ext))
    return undefined
  return (ext as Record<string, unknown>).airi
}

/**
 * Normalize the `extensions.dc_bot` block into the shape the runtime reads,
 * filling safe defaults for every missing piece (`02 §7`).
 *
 * When the block is entirely absent (the LIVE card's state today), this
 * returns all-defaults derived from the canonical emotion list and an empty
 * ASR hotword set. It never throws.
 */
export function normalizeDcBotExtension(raw: DcBotExtension | null): NormalizedDcBotExtension {
  const src = raw ?? {}

  const outputProtocolRaw = isPlainObject(src.outputProtocol) ? src.outputProtocol : {}
  const emotions = normalizeStringArray(outputProtocolRaw.emotions, [...CANONICAL_EMOTIONS])

  return {
    outputProtocol: {
      type: typeof outputProtocolRaw.type === 'string' && outputProtocolRaw.type.trim() !== ''
        ? outputProtocolRaw.type.trim()
        : 'act-v1',
      emotions,
      allowDelay: typeof outputProtocolRaw.allowDelay === 'boolean'
        ? outputProtocolRaw.allowDelay
        : true,
    },
    voice: normalizeVoiceBlock(src.voice),
    asr: {
      hotwords: isPlainObject(src.asr) ? normalizeStringArray(src.asr.hotwords, []) : [],
    },
    avatar: normalizeAvatarBlock(src.avatar),
  }
}

function normalizeVoiceBlock(raw: unknown): NormalizedDcBotVoice {
  const v = isPlainObject(raw) ? raw : {}
  // `voiceId`/`provider` are left as empty strings when the card does not
  // specify them, so the registry can fall back to the AIRI extension's
  // speech module before resorting to the hard default. Empty string is the
  // "not specified" marker (not a usable voice id).
  return {
    provider: typeof v.provider === 'string' && v.provider.trim() !== '' ? v.provider.trim() : '',
    voiceId: typeof v.voiceId === 'string' && v.voiceId.trim() !== '' ? v.voiceId.trim() : '',
    referenceAudio: typeof v.referenceAudio === 'string' ? v.referenceAudio : '',
    referenceTextFile: typeof v.referenceTextFile === 'string' && v.referenceTextFile.trim() !== ''
      ? v.referenceTextFile.trim()
      : undefined,
    promptLanguage: typeof v.promptLanguage === 'string' && v.promptLanguage.trim() !== ''
      ? v.promptLanguage.trim()
      : 'ja',
  }
}

function normalizeAvatarBlock(raw: unknown): NormalizedDcBotAvatar {
  const v = isPlainObject(raw) ? raw : {}
  return {
    renderer: typeof v.renderer === 'string' && v.renderer.trim() !== '' ? v.renderer.trim() : 'live2d',
    displayModelId: typeof v.displayModelId === 'string' && v.displayModelId.trim() !== ''
      ? v.displayModelId.trim()
      : undefined,
  }
}

/**
 * Normalize a CCv3 `character_book` into a {@link CharacterLorebook}, or
 * undefined when the card has none / a malformed one. Only well-formed
 * entries with a non-empty `content` survive; everything else is ignored.
 */
export function normalizeLorebook(raw: unknown): CharacterLorebook | undefined {
  if (!isPlainObject(raw))
    return undefined
  const book = raw as CharacterBook
  const rawEntries = book.entries
  if (!Array.isArray(rawEntries))
    return undefined

  const entries: LorebookEntry[] = []
  for (const candidate of rawEntries) {
    if (!isPlainObject(candidate))
      continue
    const e = candidate as CharacterBookEntry
    const content = typeof e.content === 'string' ? e.content : undefined
    if (content === undefined || content.trim() === '')
      continue
    const keys = normalizeStringArray(e.keys, normalizeStringArray(e.keywords, []))
    entries.push({
      keys,
      content,
      // Preserve the raw CCv3 `extensions` object verbatim when it is a plain
      // object; drop it otherwise (preserve-and-ignore, §7).
      extensions: isPlainObject(e.extensions) ? e.extensions : undefined,
      enabled: typeof e.enabled === 'boolean' ? e.enabled : undefined,
      insertionOrder: typeof e.insertionOrder === 'number' && Number.isFinite(e.insertionOrder)
        ? e.insertionOrder
        : undefined,
    })
  }

  return entries.length > 0 ? { entries } : undefined
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Coerce an unknown value into a trimmed, de-duplicated string array,
 * falling back to `fallback` when it is not a non-empty string array.
 * Non-string elements are dropped.
 */
function normalizeStringArray(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v) || v.length === 0)
    return fallback
  const out: string[] = []
  for (const el of v) {
    if (typeof el !== 'string')
      continue
    const trimmed = el.trim()
    if (trimmed !== '' && !out.includes(trimmed))
      out.push(trimmed)
  }
  return out.length > 0 ? out : fallback
}
