import { describe, expect, it } from 'vitest'

import {
  BrainRateLimitError,
  BrainRequestAbortedError,
  classifyBrainError,
  isTransientlyUnavailable,
  parseRetryDelay,
} from './errors'

const DEFAULT_COOLDOWN = 60_000

/**
 * The exact envelope shape observed in `bot_log_2 .txt` — the SDK reports the
 * server payload as JSON embedded in the error message, so the parser has to
 * mine the message rather than read a typed field.
 */
function geminiQuotaError(retryDelay: string): Error {
  return new Error(`got status: 429 Too Many Requests. ${JSON.stringify({
    error: {
      code: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
      status: 'RESOURCE_EXHAUSTED',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          'violations': [{
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': retryDelay },
      ],
    },
  })}`)
}

describe('parseRetryDelay', () => {
  it('converts protobuf duration seconds to milliseconds', () => {
    expect(parseRetryDelay('50s')).toBe(50_000)
    expect(parseRetryDelay('37s')).toBe(37_000)
    expect(parseRetryDelay('1.5s')).toBe(1500)
    expect(parseRetryDelay('0.250s')).toBe(250)
  })

  it('accepts a numeric seconds value', () => {
    expect(parseRetryDelay(12)).toBe(12_000)
  })

  it('returns undefined for shapes it cannot trust', () => {
    expect(parseRetryDelay('50')).toBeUndefined()
    expect(parseRetryDelay('50ms')).toBeUndefined()
    expect(parseRetryDelay('soon')).toBeUndefined()
    expect(parseRetryDelay(undefined)).toBeUndefined()
    expect(parseRetryDelay(null)).toBeUndefined()
    expect(parseRetryDelay(-5)).toBeUndefined()
  })
})

describe('classifyBrainError — rate limits', () => {
  it('converts a 429 envelope into BrainRateLimitError', () => {
    const out = classifyBrainError(geminiQuotaError('50s'), { model: 'gemini-3.6-flash', defaultCooldownMs: DEFAULT_COOLDOWN })
    expect(out).toBeInstanceOf(BrainRateLimitError)
  })

  it('parses retryDelay, quotaMetric, quotaId and model', () => {
    const out = classifyBrainError(geminiQuotaError('50s'), { model: 'gemini-3.6-flash', defaultCooldownMs: DEFAULT_COOLDOWN }) as BrainRateLimitError
    expect(out.retryAfterMs).toBe(50_000)
    expect(out.quotaMetric).toBe('generativelanguage.googleapis.com/generate_content_free_tier_requests')
    expect(out.quotaId).toBe('GenerateRequestsPerMinutePerProjectPerModel-FreeTier')
    expect(out.model).toBe('gemini-3.6-flash')
  })

  it('reads the second observed retry delay too', () => {
    const out = classifyBrainError(geminiQuotaError('37s'), { defaultCooldownMs: DEFAULT_COOLDOWN }) as BrainRateLimitError
    expect(out.retryAfterMs).toBe(37_000)
  })

  it('falls back to the configured cooldown when no retryDelay is present', () => {
    const err = new Error('got status: 429. {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"quota"}}')
    const out = classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN }) as BrainRateLimitError
    expect(out).toBeInstanceOf(BrainRateLimitError)
    expect(out.retryAfterMs).toBe(DEFAULT_COOLDOWN)
  })

  it('recognises a structured error object without a JSON message', () => {
    const err = Object.assign(new Error('quota'), { status: 429 })
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).toBeInstanceOf(BrainRateLimitError)
  })

  it('recognises RESOURCE_EXHAUSTED without a numeric status', () => {
    const err = new Error('RESOURCE_EXHAUSTED: out of quota')
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).toBeInstanceOf(BrainRateLimitError)
  })
})

describe('classifyBrainError — aborts and pass-through', () => {
  it('maps a fired signal to BrainRequestAbortedError', () => {
    const controller = new AbortController()
    controller.abort()
    const out = classifyBrainError(new Error('stream closed'), { signal: controller.signal, defaultCooldownMs: DEFAULT_COOLDOWN })
    expect(out).toBeInstanceOf(BrainRequestAbortedError)
  })

  it('maps a DOMException-style AbortError even without a signal', () => {
    const err = Object.assign(new Error('aborted'), { name: 'AbortError' })
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).toBeInstanceOf(BrainRequestAbortedError)
  })

  it('leaves unrelated errors untouched so they cannot trigger a bogus cooldown', () => {
    const err = new Error('500 Internal Server Error')
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).toBe(err)
  })

  it('does not treat a 400 as a rate limit', () => {
    const err = Object.assign(new Error('bad request'), { status: 400 })
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).toBe(err)
  })

  it('survives a malformed JSON-looking message', () => {
    const err = new Error('failed {not json at all')
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).toBe(err)
  })
})

describe('isTransientlyUnavailable', () => {
  /**
   * The exact shape observed in run `t002-08057db3-20260805a` when DEFECT-005
   * killed the bot: `@google/genai` sets a numeric `status` on the error and
   * embeds the server envelope as JSON in the message.
   */
  function geminiUnavailableError(): Error {
    return Object.assign(new Error(JSON.stringify({
      error: {
        code: 503,
        message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.',
        status: 'UNAVAILABLE',
      },
    })), { status: 503 })
  }

  it('recognises the 503 that took the bot down mid-soak', () => {
    expect(isTransientlyUnavailable(geminiUnavailableError())).toBe(true)
  })

  it('recognises an envelope carrying only UNAVAILABLE', () => {
    expect(isTransientlyUnavailable(new Error(JSON.stringify({ error: { status: 'UNAVAILABLE' } })))).toBe(true)
  })

  it('does not treat a rate limit as transiently unavailable', () => {
    expect(isTransientlyUnavailable(geminiQuotaError('37s'))).toBe(false)
  })

  it('does not treat an ordinary 500 as transiently unavailable', () => {
    expect(isTransientlyUnavailable(new Error('500 Internal Server Error'))).toBe(false)
  })

  // A 503 must not arm the quota cooldown: the account has plenty of quota, the
  // model is momentarily oversubscribed. Classifying it as a rate limit would
  // block every guild for GEMINI_DEFAULT_COOLDOWN_MS over a blip.
  it('is not classified as a rate limit', () => {
    const err = geminiUnavailableError()
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).toBe(err)
    expect(classifyBrainError(err, { defaultCooldownMs: DEFAULT_COOLDOWN })).not.toBeInstanceOf(BrainRateLimitError)
  })
})
