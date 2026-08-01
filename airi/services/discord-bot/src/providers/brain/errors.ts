/**
 * Typed brain-provider failures.
 *
 * The controller must distinguish "the account is out of quota" from "the user
 * interrupted" from "something else broke", because each has a different
 * recovery: cooldown, silent discard, or log-and-continue. Making that a type
 * rather than a string match on the SDK's message is the whole point of this
 * module (Optimize.md §9 Agent 1C).
 */

/** Raised when the upstream model refuses the request for quota reasons (HTTP 429). */
export class BrainRateLimitError extends Error {
  /** Milliseconds to wait before the next request may be attempted. */
  readonly retryAfterMs: number
  /** e.g. `generativelanguage.googleapis.com/generate_content_free_tier_requests`. */
  readonly quotaMetric?: string
  readonly quotaId?: string
  readonly model?: string

  constructor(message: string, details: { retryAfterMs: number, quotaMetric?: string, quotaId?: string, model?: string }) {
    super(message)
    this.name = 'BrainRateLimitError'
    this.retryAfterMs = details.retryAfterMs
    this.quotaMetric = details.quotaMetric
    this.quotaId = details.quotaId
    this.model = details.model
  }
}

/** Raised when generation was cancelled (barge-in, disconnect, new turn). */
export class BrainRequestAbortedError extends Error {
  constructor(message = 'Brain request aborted') {
    super(message)
    this.name = 'BrainRequestAbortedError'
  }
}

/**
 * Parse a `google.protobuf.Duration` string as used by `RetryInfo.retryDelay`.
 *
 * Before:
 * - `"50s"`, `"1.5s"`, `"0.250s"`
 *
 * After:
 * - `50000`, `1500`, `250`
 *
 * Returns `undefined` for anything that is not a plain seconds value, so the
 * caller falls back to its configured default rather than trusting a guess.
 */
export function parseRetryDelay(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0)
    return Math.round(raw * 1000)
  if (typeof raw !== 'string')
    return undefined
  const m = /^(\d+(?:\.\d+)?)s$/.exec(raw.trim())
  if (!m)
    return undefined
  return Math.round(Number(m[1]) * 1000)
}

interface QuotaDetails {
  retryAfterMs?: number
  quotaMetric?: string
  quotaId?: string
}

/**
 * Pull the Google API error envelope out of an SDK error.
 *
 * The `@google/genai` SDK surfaces the server payload as JSON embedded in the
 * error *message*, so structured fields are read first and the message is only
 * mined as a fallback. The extraction is bounded to the outermost `{...}` span
 * and wrapped in try/catch — a malformed payload degrades to "no details",
 * never to a throw inside error handling.
 */
function readErrorEnvelope(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== 'object' || err === null)
    return undefined

  const record = err as Record<string, unknown>
  if (isRecord(record.error))
    return record.error

  const message = typeof record.message === 'string' ? record.message : ''
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start < 0 || end <= start)
    return undefined

  try {
    const parsed: unknown = JSON.parse(message.slice(start, end + 1))
    if (isRecord(parsed) && isRecord(parsed.error))
      return parsed.error
    if (isRecord(parsed))
      return parsed
  }
  catch {
    // A message that merely mentions a brace is not an envelope; ignore it.
  }
  return undefined
}

/** Read `QuotaFailure.violations[0]` and `RetryInfo.retryDelay` from `error.details`. */
function readQuotaDetails(envelope: Record<string, unknown> | undefined): QuotaDetails {
  const out: QuotaDetails = {}
  if (!envelope || !Array.isArray(envelope.details))
    return out

  for (const detail of envelope.details) {
    if (!isRecord(detail))
      continue
    const type = typeof detail['@type'] === 'string' ? detail['@type'] : ''

    if (type.endsWith('QuotaFailure') && Array.isArray(detail.violations)) {
      const violation = detail.violations.find(isRecord)
      if (violation) {
        if (typeof violation.quotaMetric === 'string')
          out.quotaMetric = violation.quotaMetric
        if (typeof violation.quotaId === 'string')
          out.quotaId = violation.quotaId
      }
    }

    if (type.endsWith('RetryInfo')) {
      const delay = parseRetryDelay(detail.retryDelay)
      if (delay != null)
        out.retryAfterMs = delay
    }
  }
  return out
}

/** HTTP status from any of the shapes the SDK and REST envelope use. */
function readStatusCode(err: unknown, envelope: Record<string, unknown> | undefined): number | undefined {
  const record = isRecord(err) ? err : undefined
  for (const candidate of [record?.status, record?.code, envelope?.code]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate))
      return candidate
  }
  return undefined
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Classify a raw provider/SDK error.
 *
 * Returns a {@link BrainRateLimitError} for quota exhaustion, a
 * {@link BrainRequestAbortedError} when the signal fired, and otherwise the
 * original error untouched — unknown failures must not be disguised as
 * rate limits, because that would trigger a bogus cooldown.
 *
 * `context.defaultCooldownMs` is used when the 429 carries no parseable
 * `retryDelay`.
 */
export function classifyBrainError(
  err: unknown,
  context: { model?: string, signal?: AbortSignal, defaultCooldownMs: number },
): unknown {
  if (context.signal?.aborted || isAbortError(err))
    return new BrainRequestAbortedError()

  const envelope = readErrorEnvelope(err)
  const status = readStatusCode(err, envelope)
  const statusText = typeof envelope?.status === 'string' ? envelope.status : ''
  const message = isRecord(err) && typeof err.message === 'string' ? err.message : String(err)

  const isRateLimit = status === 429
    || statusText === 'RESOURCE_EXHAUSTED'
    || /\b429\b|RESOURCE_EXHAUSTED/.test(message)
  if (!isRateLimit)
    return err

  const quota = readQuotaDetails(envelope)
  return new BrainRateLimitError(
    typeof envelope?.message === 'string' && envelope.message !== '' ? envelope.message : 'Gemini quota exhausted',
    {
      retryAfterMs: quota.retryAfterMs ?? context.defaultCooldownMs,
      quotaMetric: quota.quotaMetric,
      quotaId: quota.quotaId,
      model: context.model,
    },
  )
}

function isAbortError(err: unknown): boolean {
  if (!isRecord(err))
    return false
  return err.name === 'AbortError' || err instanceof BrainRequestAbortedError
}
