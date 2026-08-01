/**
 * Multilingual speech chunker (plan.md §24, §25).
 *
 * Gemini streams tokens; we don't want to wait for the whole reply before
 * starting TTS, but we also don't want to TTS every token. The chunker
 * accumulates streamed text and emits at sentence/clause boundaries so TTS
 * can begin on chunk 1 while Gemini is still generating chunk 2.
 *
 * Boundary rules:
 *  - terminal punctuation `. ? ! 。 ？ ！` → emit (trailing punctuation included)
 *  - else, emit around `MAX_SOFT` chars once a word/phrase boundary is found
 *  - hard cap at `MAX_HARD` chars (forces an emit even mid-phrase)
 *
 * Handles English (.?!), Japanese (。？！), and Chinese (。？！).
 */
export interface SpeechChunkerOptions {
  minLatinChars: number
  targetLatinChars: number
  maxLatinChars: number
  minCjkChars: number
  targetCjkChars: number
  maxCjkChars: number
}

export const DEFAULT_SPEECH_CHUNKER_OPTIONS: SpeechChunkerOptions = {
  minLatinChars: 40,
  targetLatinChars: 75,
  maxLatinChars: 120,
  minCjkChars: 14,
  targetCjkChars: 28,
  maxCjkChars: 50,
}

export class SpeechChunker {
  private buffer = ''
  private readonly options: SpeechChunkerOptions

  constructor(options: Partial<SpeechChunkerOptions> = {}) {
    this.options = { ...DEFAULT_SPEECH_CHUNKER_OPTIONS, ...options }
  }

  /** Feed a text delta; returns zero or more complete chunks ready for TTS. */
  push(delta: string): string[] {
    return this.pushWithBoundaries(delta).map(chunk => chunk.text)
  }

  /** Feed a delta while retaining why each chunk was emitted. */
  pushWithBoundaries(delta: string): SpeechChunk[] {
    if (!delta)
      return []
    this.buffer += delta
    const out: SpeechChunk[] = []
    while (true) {
      const boundary = this.findBoundary()
      if (!boundary)
        break
      out.push({ text: this.buffer.slice(0, boundary.cut).trim(), boundary: boundary.boundary })
      this.buffer = this.buffer.slice(boundary.cut)
    }
    return out.filter(chunk => Boolean(chunk.text))
  }

  /** Flush whatever remains (e.g. when the stream ends). */
  flush(): string[] {
    return this.flushWithBoundary().map(chunk => chunk.text)
  }

  /** Flush remaining text as an explicit stream-end chunk. */
  flushWithBoundary(): SpeechChunk[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [{ text: rest, boundary: 'stream-end' }] : []
  }

  /** Flush buffered text at a semantic control-token boundary. */
  flushForControlToken(): SpeechChunk[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    return rest ? [{ text: rest, boundary: 'control-token' }] : []
  }

  /** Whether non-whitespace text remains buffered after the last emission. */
  hasPendingText(): boolean {
    return Boolean(this.buffer.trim())
  }

  /** Returns the index to cut at (inclusive of the boundary char), or 0. */
  private findBoundary(): { cut: number, boundary: SpeechChunkBoundary } | undefined {
    const cjk = isCjkDominant(this.buffer)
    const min = cjk ? this.options.minCjkChars : this.options.minLatinChars
    const target = cjk ? this.options.targetCjkChars : this.options.targetLatinChars
    const max = cjk ? this.options.maxCjkChars : this.options.maxLatinChars

    // Hold a short opening sentence until the next clause. Tiny acknowledgements
    // are especially expensive and sound unnatural when synthesized alone.
    const terminal = findTerminalBoundary(this.buffer, max, min)
    if (terminal > 0)
      return { cut: terminal, boundary: 'sentence' }

    // At the target, commas and line breaks are preferable to an arbitrary cut.
    if (this.buffer.length >= target) {
      const region = this.buffer.slice(0, Math.min(max, this.buffer.length))
      const clause = Math.max(region.lastIndexOf(','), region.lastIndexOf('，'), region.lastIndexOf(';'), region.lastIndexOf('；'), region.lastIndexOf('\n'))
      if (clause + 1 >= min)
        return { cut: clause + 1, boundary: 'clause' }
    }

    if (this.buffer.length >= max) {
      if (cjk)
        return { cut: max, boundary: 'hard-limit' }
      const region = this.buffer.slice(0, max)
      const word = Math.max(region.lastIndexOf(' '), region.lastIndexOf('\n'))
      return { cut: word >= min ? word + 1 : max, boundary: 'hard-limit' }
    }

    return undefined
  }
}

export type SpeechChunkBoundary = 'sentence' | 'clause' | 'hard-limit' | 'control-token' | 'stream-end'

export interface SpeechChunk {
  text: string
  boundary: SpeechChunkBoundary
}

function isCjkDominant(text: string): boolean {
  const kana = (text.match(/[\u3040-\u30FF]/g) ?? []).length
  if (kana > 0)
    return true
  const han = (text.match(/[\u3400-\u9FFF]/g) ?? []).length
  const latin = (text.match(/[a-z]/gi) ?? []).length
  return han > latin
}

function findTerminalBoundary(text: string, limit: number, minimum: number): number {
  const end = Math.min(text.length, limit)
  for (let i = 0; i < end; i++) {
    const char = text[i]
    if (!/[.。?？!！]/.test(char))
      continue
    if (char === '.' && isProtectedLatinPeriod(text, i))
      continue
    let cut = i + 1
    while (cut < end && /[.。?？!！]/.test(text[cut]))
      cut++
    if (text.slice(0, cut).trim().length >= minimum)
      return cut
    i = cut - 1
  }
  return 0
}

function isProtectedLatinPeriod(text: string, index: number): boolean {
  const before = text[index - 1] ?? ''
  const after = text[index + 1] ?? ''
  if (/\d/.test(before) && /\d/.test(after))
    return true

  const prefix = text.slice(0, index + 1)
  return /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc)|\b[A-Z]|(?:\b[a-z]\.){2,})\.$/i.test(prefix)
}

const TOKEN_OPEN = '<|'
const TOKEN_CLOSE = '|>'
/**
 * Longest run we will hold back waiting for a closing `|>`. Past this, the text
 * is far longer than any stage token and is released as ordinary speech rather
 * than swallowed.
 */
const MAX_HELD_CHARS = 512

export type ScannedSpeechPart
  = | { kind: 'text', text: string }
    | { kind: 'token', token: string }

/** Scan arbitrary deltas without losing the document order of text and tokens. */
export async function* scanSpeechStream(deltas: AsyncIterable<string>): AsyncIterable<ScannedSpeechPart> {
  let held = ''

  for await (const delta of deltas) {
    held += delta
    while (held) {
      const open = held.indexOf(TOKEN_OPEN)
      if (open < 0) {
        const pending = held.endsWith('<') ? 1 : 0
        const text = held.slice(0, held.length - pending)
        held = held.slice(held.length - pending)
        if (text)
          yield { kind: 'text', text }
        break
      }

      if (open > 0) {
        yield { kind: 'text', text: held.slice(0, open) }
        held = held.slice(open)
      }

      const close = held.indexOf(TOKEN_CLOSE, TOKEN_OPEN.length)
      if (close < 0) {
        if (held.length > MAX_HELD_CHARS) {
          yield { kind: 'text', text: held }
          held = ''
        }
        break
      }
      yield { kind: 'token', token: held.slice(0, close + TOKEN_CLOSE.length) }
      held = held.slice(close + TOKEN_CLOSE.length)
    }
  }

  if (held && !held.startsWith(TOKEN_OPEN))
    yield { kind: 'text', text: held }
}

/** Receives each complete `<|...|>` span, including its delimiters. */
export type ControlTokenHandler = (token: string) => unknown | Promise<unknown>

/**
 * Separates `<|...|>` control tokens from spoken text in a delta stream.
 *
 * The character's output protocol is ACT-v1: the prompt compiler asks the model
 * to prefix replies with `<|ACT:"emotion":{...}|>` and optional `<|DELAY:n|>`
 * beats. That markup is an *encoding*, not speech — only the clean text may
 * reach TTS, Discord, history or memory (runtime-v2 D006). Tokens are handed to
 * `onToken` so the caller can parse them into avatar actions; when no handler
 * is supplied they are simply dropped, which keeps this a safety net even if
 * the model emits markup nobody asked for.
 *
 * Separation must happen *before* chunking, not after: an ACT token embeds a
 * decimal intensity (`"intensity":0.6`), and the chunker treats `.` as a
 * sentence boundary — it would cut the token in half and defeat any per-chunk
 * regex.
 */
export async function* stripControlTokens(deltas: AsyncIterable<string>, onToken?: ControlTokenHandler): AsyncIterable<string> {
  for await (const part of scanSpeechStream(deltas)) {
    if (part.kind === 'text')
      yield part.text
    else
      await onToken?.(part.token)
  }
}

/**
 * Drive the chunker over an async-iterable of deltas. Yields complete chunks
 * as they form, then a final flush. The caller can pass each chunk straight to
 * TTS (plan.md §24).
 */
export async function* chunkStream(
  deltas: AsyncIterable<string>,
  onToken?: ControlTokenHandler,
  options?: Partial<SpeechChunkerOptions>,
): AsyncIterable<string> {
  const chunker = new SpeechChunker(options)
  for await (const delta of stripControlTokens(deltas, onToken)) {
    for (const c of chunker.push(delta))
      yield c
  }
  for (const c of chunker.flush())
    yield c
}
