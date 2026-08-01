import type { AvatarAction } from '../../orchestration/output'

/**
 * ACT-v1 output-protocol parser (Runtime V2, `02-public-contracts.md` §8,
 * `04-decisions.md` D006).
 *
 * Parses one LLM-output encoding — the ACT-v1 control syntax — into structured
 * {@link AvatarAction}s, optional pauses, and the clean visible/spoken text.
 * ACT markup MUST NEVER reach TTS, Discord visible replies, memory, or
 * conversation history; this parser is where that guarantee is enforced for
 * ACT-v1. Wave 6 wires the full output-protocol module; this module is the
 * foundation that the character card's `outputProtocol` references.
 *
 * Grammar recognized (whitespace-sensitive only around the literal delimiters):
 *
 *   ACT token:   <|ACT:"emotion":{"name":STRING,"intensity":NUMBER},"motion":STRING|>
 *                 (motion is optional; the whole emotion object is optional in
 *                  practice — a bare <|ACT:"emotion":{}|> still yields an action
 *                  with no emotion)
 *   Delay token:  <|DELAY:NUMBER|>
 *
 * Robustness contract (`02 §8`):
 * - Malformed ACT/DELAY content MUST NOT break the turn. Unrecognized control
 *   tokens are treated as stripped/ignored metadata; the surrounding safe
 *   visible text is preserved.
 * - NEVER use `eval` and NEVER blind-`JSON.parse` arbitrary LLM output. The
 *   emotion object is parsed with a strict, bounded scanner that accepts only
 *   the two known keys and scalar values.
 */

/** Parser output: parsed actions, pauses, and the clean text. */
export interface ActV1ParseResult {
  /** Parsed avatar actions, in document order. */
  actions: AvatarAction[]
  /** Pauses (from `<|DELAY:n|>` when `allowDelay` is true), in order. */
  pauses: { durationMs: number }[]
  /**
   * The clean visible/spoken text with all ACT/DELAY tokens removed. Safe to
   * send to TTS / Discord / memory / history. Surrounding/inner whitespace
   * from removed tokens is collapsed, but the text itself is otherwise
   * unchanged.
   */
  cleanText: string
}

/** Options for {@link parseActV1}. */
export interface ParseActV1Options {
  /**
   * Whether `<|DELAY:n|>` tokens map to pauses. Defaults to `true`. When
   * `false`, delay tokens are still stripped from the clean text but no pause
   * is emitted (per `02 §8`: delay maps to pause *when allowDelay is true*).
   */
  allowDelay?: boolean
  /**
   * Delay unit in milliseconds for one `<|DELAY:n|>` count. The Kurisu
   * `creator_notes` use small integers (`1`, `3`); treat one count as this
   * many ms. Default 1000 (so `<|DELAY:1|>` = 1000 ms).
   */
  delayUnitMs?: number
}

const DEFAULT_DELAY_UNIT_MS = 1000

/**
 * Parse ACT-v1 control tokens out of LLM output.
 *
 * The result's `cleanText` is the only string that may reach TTS / visible
 * replies / history / memory. `actions` and `pauses` are consumed only by the
 * avatar sink / speech scheduler respectively.
 *
 * Malformed tokens never throw: they are stripped and ignored, preserving
 * safe visible content. See the test suite for the malformed-input cases.
 */
export function parseActV1(text: string, options: ParseActV1Options = {}): ActV1ParseResult {
  const source = typeof text === 'string' ? text : ''
  const allowDelay = options.allowDelay !== false
  const delayUnitMs = options.delayUnitMs ?? DEFAULT_DELAY_UNIT_MS

  const actions: AvatarAction[] = []
  const pauses: { durationMs: number }[] = []
  const cleanPieces: string[] = []

  /**
   * Set while the previous emission was a removed token, so `pushText` knows
   * whether it must re-introduce a separator. Declared before `pushText`
   * because the closure reads it.
   */
  let tokenJustRemoved = false

  /**
   * Append visible text, inserting a single space when a removed token would
   * otherwise mash two non-space characters together (e.g. `a<|DELAY:1|>b`).
   */
  const pushText = (text: string): void => {
    if (text === '')
      return
    const prev = cleanPieces.length > 0 ? cleanPieces[cleanPieces.length - 1] : ''
    const prevEnd = prev.length > 0 ? prev[prev.length - 1] : ''
    const nextStart = text[0] ?? ''
    if (
      tokenJustRemoved
      && prevEnd !== ''
      && !isSpace(prevEnd)
      && !isSpace(nextStart)
    ) {
      cleanPieces.push(' ')
    }
    tokenJustRemoved = false
    cleanPieces.push(text)
  }

  let i = 0
  const end = source.length
  while (i < end) {
    const tokenStart = source.indexOf('<|', i)
    if (tokenStart === -1) {
      pushText(source.slice(i))
      break
    }

    // Preserve any visible text before the token.
    if (tokenStart > i)
      pushText(source.slice(i, tokenStart))

    const closer = findTokenCloser(source, tokenStart)
    if (closer === -1) {
      // Unterminated `<|` — drop the marker, keep the rest as visible text.
      // (A stray `<|` mid-text is not a valid token; treat as metadata.)
      pushText(source.slice(tokenStart + 2))
      break
    }

    const body = source.slice(tokenStart + 2, closer)
    const consumed = parseTokenBody(body, { actions, pauses }, { allowDelay, delayUnitMs })
    // Whether or not the token was a recognized kind, it is control syntax:
    // nothing of the token body reaches the clean text. Mark that a token was
    // removed so the next visible piece can be separated if needed.
    tokenJustRemoved = true
    void consumed

    i = closer + 2 // skip past `|>`
  }

  return {
    actions,
    pauses,
    cleanText: collapseCleanText(cleanPieces.join('')),
  }
}

/** Find the matching `|>` for a `<|` opened at `openIdx`, or -1. */
function findTokenCloser(source: string, openIdx: number): number {
  return source.indexOf('|>', openIdx + 2)
}

/**
 * Parse one token body (the text between `<|` and `|>`). Mutates the provided
 * `out` collections. Returns true if the body matched a known token shape.
 */
function parseTokenBody(
  body: string,
  out: { actions: AvatarAction[], pauses: { durationMs: number }[] },
  opts: { allowDelay: boolean, delayUnitMs: number },
): boolean {
  const trimmed = body.trim()

  // DELAY token:  DELAY:<number>
  const delayMatch = matchDelay(trimmed)
  if (delayMatch !== null) {
    if (opts.allowDelay) {
      const ms = clampNonNegativeInt(delayMatch) * opts.delayUnitMs
      out.pauses.push({ durationMs: ms })
    }
    return true
  }

  // ACT token: "emotion":{...},"motion":"..."   (motion optional)
  const act = matchAct(trimmed)
  if (act !== null) {
    out.actions.push(act)
    return true
  }

  return false
}

/** Match `<^DELAY:(\d+)$/>`, returning the integer count or null. */
function matchDelay(body: string): number | null {
  const m = /^DELAY:\s*(\d+)\s*$/.exec(body)
  if (!m)
    return null
  const n = Number.parseInt(m[1]!, 10)
  return Number.isFinite(n) ? n : null
}

/**
 * Match the ACT token body. Expected shape (after trim):
 *   ACT:"emotion":{"name":"happy","intensity":0.6},"motion":"..."
 *
 * The leading `ACT:` prefix is the token-kind tag; everything after it is the
 * payload beginning with the `"emotion"` key literal. The emotion object is
 * parsed with a strict bounded scanner (no eval, no blind JSON.parse).
 * `motion` is optional and may be absent or empty.
 *
 * Returns the parsed {@link AvatarAction} or null when the body is not an
 * ACT token. A well-formed token (recognized `ACT:` prefix + `"emotion"` key
 * + valid `{...}` object, even if empty) always yields an action. A token
 * whose emotion payload is malformed AND has no motion yields nothing — that
 * is "stripped/ignored metadata" per `02 §8`. It never throws.
 */
function matchAct(body: string): AvatarAction | null {
  // Strip the leading `ACT:` kind tag (optional whitespace around the colon).
  const actPrefix = /^ACT\s*:\s*/.exec(body)
  if (!actPrefix)
    return null
  const payload = body.slice(actPrefix[0].length)

  // Payload must start with the "emotion" key literal.
  const key = '"emotion"'
  if (!payload.startsWith(key))
    return null

  // Everything after the leading key; split on the ,"motion": marker.
  const afterKey = payload.slice(key.length)
  const motionSplit = splitMotion(afterKey)
  const emotionPart = motionSplit.emotionPart
  const motionPart = motionSplit.motionPart

  const emotionParse = parseEmotionObjectChecked(emotionPart)
  const motionHint = parseMotionString(motionPart)

  // Malformed emotion object with no motion → ignore the token entirely.
  if (!emotionParse.wellFormed && motionHint === undefined)
    return null

  const action: AvatarAction = {}
  if (emotionParse.name !== undefined)
    action.emotion = emotionParse.name
  if (emotionParse.intensity !== undefined)
    action.intensity = emotionParse.intensity
  if (motionHint !== undefined)
    action.motionHint = motionHint
  return action
}

/**
 * Split the post-key payload at the `,"motion":` boundary. Returns the
 * emotion-object substring and the raw motion substring (which may be empty).
 */
function splitMotion(afterKey: string): { emotionPart: string, motionPart: string } {
  const marker = ',"motion"'
  const idx = afterKey.indexOf(marker)
  if (idx === -1) {
    return { emotionPart: afterKey.trim(), motionPart: '' }
  }
  return {
    emotionPart: afterKey.slice(0, idx).trim(),
    motionPart: afterKey.slice(idx + marker.length).trim(),
  }
}

/**
 * Parse `:{...}` strictly into { name?, intensity?, wellFormed }. `wellFormed`
 * is true when the value was a recognized `{...}` object (even `{}`); false
 * when the `:"..."` payload was missing or malformed (e.g. `:not-an-object`).
 * Never throws.
 */
function parseEmotionObjectChecked(part: string): {
  name?: string
  intensity?: number
  wellFormed: boolean
} {
  if (!part.startsWith(':'))
    return { wellFormed: false }
  const afterColon = part.slice(1).trim()
  if (!afterColon.startsWith('{') || !afterColon.endsWith('}'))
    return { wellFormed: false }
  const inner = afterColon.slice(1, -1).trim()
  // `{}` is well-formed (just empty) — yields an action with no emotion fields.
  if (inner === '')
    return { wellFormed: true }

  const result: { name?: string, intensity?: number, wellFormed: boolean } = { wellFormed: true }
  for (const [key, value] of scanObjectMembers(inner)) {
    if (key === 'name' && typeof value === 'string') {
      result.name = value
    }
    else if (key === 'intensity' && typeof value === 'number') {
      result.intensity = clamp01(value)
    }
    // Unknown keys are ignored (bounded parser).
  }
  return result
}

/** Parse `:"..."` strictly into a string, or undefined when malformed. */
function parseMotionString(part: string): string | undefined {
  if (!part.startsWith(':'))
    return undefined
  const afterColon = part.slice(1).trim()
  const parsed = parseJsonString(afterColon)
  if (parsed === undefined)
    return undefined
  return parsed.trim() === '' ? undefined : parsed.trim()
}

/**
 * Strict, bounded scanner for the two known emotion-object members. Accepts
 * only `"name":<string>` and `"intensity":<number>`. Returns the recognized
 * pairs; anything malformed is skipped. Never throws — it returns what it
 * could parse and stops at the first unrecoverable character.
 */
function scanObjectMembers(inner: string): Array<[string, string | number]> {
  const members: Array<[string, string | number]> = []
  let i = 0
  const s = inner
  while (i < s.length) {
    // Skip leading commas/whitespace.
    while (i < s.length && (s[i] === ',' || isSpace(s[i]!)))
      i++
    if (i >= s.length)
      break

    // Expect a quoted key.
    const keyRes = readJsonString(s, i)
    if (keyRes === null)
      break
    const key = keyRes.value
    i = keyRes.next

    // Skip whitespace, expect ':'.
    while (i < s.length && isSpace(s[i]!))
      i++
    if (s[i] !== ':')
      break
    i++
    while (i < s.length && isSpace(s[i]!))
      i++

    // Read a value: string or number.
    if (s[i] === '"') {
      const valRes = readJsonString(s, i)
      if (valRes === null)
        break
      members.push([key, valRes.value])
      i = valRes.next
    }
    else {
      const valRes = readJsonNumber(s, i)
      if (valRes === null)
        break
      members.push([key, valRes.value])
      i = valRes.next
    }
  }
  return members
}

/** Read a JSON-style double-quoted string starting at `s[start]`. */
function readJsonString(s: string, start: number): { value: string, next: number } | null {
  if (s[start] !== '"')
    return null
  let i = start + 1
  let out = ''
  while (i < s.length) {
    const ch = s[i]!
    if (ch === '"') {
      return { value: out, next: i + 1 }
    }
    if (ch === '\\') {
      const next = s[i + 1]
      if (next === undefined)
        return null
      out += decodeEscape(next)
      i += 2
      continue
    }
    out += ch
    i++
  }
  return null // unterminated
}

/** Read a JSON-style number (int or float, optional leading `-`). */
function readJsonNumber(s: string, start: number): { value: number, next: number } | null {
  let i = start
  if (s[i] === '-')
    i++
  let digits = ''
  while (i < s.length && /[0-9.e+\-]/i.test(s[i]!)) {
    digits += s[i]
    i++
  }
  if (digits === '')
    return null
  const n = Number(digits)
  if (!Number.isFinite(n))
    return null
  return { value: n, next: i }
}

function parseJsonString(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"') || trimmed.length < 2)
    return undefined
  const res = readJsonString(trimmed, 0)
  return res ? res.value : undefined
}

function decodeEscape(ch: string): string {
  switch (ch) {
    case 'n': return '\n'
    case 't': return '\t'
    case 'r': return '\r'
    case '"': return '"'
    case '\\': return '\\'
    case '/': return '/'
    default: return ch
  }
}

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'
}

function clamp01(n: number): number {
  if (!Number.isFinite(n))
    return 0
  if (n < 0)
    return 0
  if (n > 1)
    return 1
  return n
}

function clampNonNegativeInt(n: number): number {
  if (!Number.isFinite(n) || n < 0)
    return 0
  return Math.trunc(n)
}

/**
 * Collapse runs of whitespace created by removing ACT/DELAY tokens, while
 * preserving the author's intended line breaks and spacing. Specifically:
 * - trim the outer ends;
 * - collapse 3+ newlines to 2;
 * - collapse spaces/tabs that surround a removed token into a single space;
 * - otherwise leave the text byte-for-byte intact.
 */
function collapseCleanText(text: string): string {
  if (text === '')
    return ''
  // Collapse runs of spaces/tabs to a single space (do not touch newlines here).
  let out = text.replace(/[ \t]+/g, ' ')
  // Collapse 3+ newlines (with optional spaces) to exactly two.
  out = out.replace(/\n{3,}/g, '\n\n')
  return out.trim()
}
