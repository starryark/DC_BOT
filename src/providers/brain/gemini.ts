import type { BrainUsageSink, UsageAccumulator } from '../../../evals/memory/performance/provider-observability'
import type { BrainRateLimiter } from './rate-limiter'
import type { BrainProvider, BrainRequest } from './types'

import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import { useLogg } from '@guiiai/logg'

import { createUsageAccumulator, safeEmitUsage } from '../../../evals/memory/performance/provider-observability'
import { config } from '../../config'
import { BrainRateLimitError, BrainRequestAbortedError, classifyBrainError, isTransientlyUnavailable } from './errors'
import { LocalBrainRateLimiter } from './rate-limiter'

/**
 * Backoff before re-attempting a turn that upstream refused with 503
 * UNAVAILABLE. Two retries, ~2 s of added latency in the worst case, which
 * stays inside the turn budget rather than leaving the room waiting.
 *
 * This is the *only* retry the provider performs, and it is not a general
 * retry policy: see {@link GeminiBrainProvider.generate} for why a retry is
 * only ever safe before the first token.
 */
const UNAVAILABLE_RETRY_DELAYS_MS = [500, 1500] as const

/** Resolves after `ms`, or rejects as soon as the turn is cancelled. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new BrainRequestAbortedError())
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Gemini brain provider (plan.md §20, §23). Streams text via
 * `generateContentStream` so latency is low from the first token.
 *
 * The provider is stateless with respect to conversation: it owns no history
 * and no prompt policy. The controller compiles the system instruction and
 * contents and passes a finished {@link BrainRequest}.
 *
 * What it *does* own is the upstream-quota boundary: every generation passes
 * through a local {@link BrainRateLimiter} first, and a 429 is converted into a
 * typed `BrainRateLimitError` that also arms the limiter's cooldown.
 *
 * The provider retries exactly one condition: a transient 503 UNAVAILABLE,
 * bounded by {@link UNAVAILABLE_RETRY_DELAYS_MS} and only before the first
 * token has been yielded. Everything else still fails on the first attempt,
 * because retrying an obsolete voice turn is worse than dropping it
 * (Optimize.md §9 Agent 1C) — a cancelled turn abandons the backoff too.
 */
export class GeminiBrainProvider implements BrainProvider {
  private logger = useLogg('GeminiBrain').useGlobalConfig()
  private client: GoogleGenAI
  private model: string
  private limiter: BrainRateLimiter
  /**
   * Optional observer for numeric usage metadata; absent in production.
   *
   * When supplied (IMP-803 benchmark only), the provider captures the final
   * streamed `usageMetadata` and emits at most one numeric, content-free
   * record per call. The sink never breaks generation — its errors are caught.
   */
  private readonly usageSink?: BrainUsageSink

  constructor(options: { limiter?: BrainRateLimiter, usageSink?: BrainUsageSink } = {}) {
    const cfg = config().brain
    if (!cfg.apiKey)
      this.logger.warn('GEMINI_API_KEY is not set — generation will fail until it is provided.')
    this.client = new GoogleGenAI({ apiKey: cfg.apiKey })
    this.model = cfg.model
    this.limiter = options.limiter ?? new LocalBrainRateLimiter()
    this.usageSink = options.usageSink
  }

  async* generate(request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
    const cfg = config().brain
    if (!cfg.apiKey)
      throw new Error('GEMINI_API_KEY is not set')
    if (request.contents.length === 0 || request.contents.at(-1)?.role !== 'user')
      throw new Error('Gemini requests must end with a user turn')

    // Throws BrainRequestAbortedError if the turn is cancelled while queued,
    // so a barge-in during a rate-limit wait costs nothing upstream.
    await this.limiter.acquire(signal)

    // Created only when a benchmark observer is installed; absent in production.
    const usageAccumulator: UsageAccumulator | undefined = this.usageSink ? createUsageAccumulator() : undefined

    const requestStartedAt = Date.now()
    let firstTokenSeen = false
    this.logger.withFields({
      guildId: request.guildId,
      userId: request.userId,
      turnId: request.turnId,
      responseEpoch: request.responseEpoch,
      model: this.model,
      turns: request.contents.length,
      systemInstructionChars: request.systemInstruction.length,
      thinkingLevel: request.generationProfile.thinkingLevel,
      maxOutputTokens: request.generationProfile.maxOutputTokens,
      responseLengthClass: request.generationProfile.responseLengthClass,
    }).log('gemini_request_started')

    try {
      for (let attempt = 0; ; attempt++) {
        try {
          const stream = await this.client.models.generateContentStream({
            model: this.model,
            contents: request.contents,
            config: {
              systemInstruction: request.systemInstruction,
              abortSignal: signal,
              thinkingConfig: { thinkingLevel: mapThinkingLevel(request.generationProfile.thinkingLevel) },
              maxOutputTokens: request.generationProfile.maxOutputTokens,
            },
          })

          let finishReason: string | undefined

          for await (const chunk of stream) {
            if (chunk.candidates?.[0]?.finishReason) {
              finishReason = chunk.candidates[0].finishReason
            }
            // The SDK accumulates usage metadata across chunks; the final chunk
            // carries the complete counts. Observe each non-empty metadata so
            // the accumulator keeps the latest; emitted at most once per call.
            usageAccumulator?.observe(chunk.usageMetadata)
            const text = chunk.text
            if (text) {
              if (!firstTokenSeen) {
                firstTokenSeen = true
                this.logger.withFields({
                  guildId: request.guildId,
                  userId: request.userId,
                  turnId: request.turnId,
                  responseEpoch: request.responseEpoch,
                  durationMs: Date.now() - requestStartedAt,
                  geminiFirstTokenMs: Date.now() - requestStartedAt,
                }).log('gemini_first_token')
              }
              yield text
            }
          }

          if (finishReason === 'MAX_TOKENS') {
            this.logger.withFields({
              guildId: request.guildId,
              turnId: request.turnId,
            }).warn('gemini_truncated_max_tokens')
          }
          // Emit the accumulated usage record for this completed call, at most once.
          if (usageAccumulator)
            safeEmitUsage(this.usageSink, usageAccumulator.finalize({ provider: 'gemini', model: this.model, correlationId: request.turnId ?? `${request.guildId}:${request.userId}`, disposition: 'complete', retryCount: attempt, observedAt: new Date().toISOString() }), (error) => { this.logger.withFields({ error: String(error) }).error('gemini_usage_sink_error') })
          break
        }
        catch (err) {
          // A retry is only ever safe before the first token: once text has
          // reached the caller it has already been chunked, synthesized and in
          // the voice path spoken aloud, so a second attempt would duplicate
          // the reply rather than replace it.
          //
          // The turn is also abandoned the moment it is cancelled — retrying an
          // obsolete turn is worse than dropping it.
          const canRetry = attempt < UNAVAILABLE_RETRY_DELAYS_MS.length
            && !firstTokenSeen
            && !signal.aborted
            && isTransientlyUnavailable(err)
          if (!canRetry)
            throw err

          const backoffMs = UNAVAILABLE_RETRY_DELAYS_MS[attempt]
          this.logger.withFields({
            guildId: request.guildId,
            turnId: request.turnId,
            responseEpoch: request.responseEpoch,
            model: this.model,
            attempt: attempt + 1,
            backoffMs,
          }).warn('gemini_unavailable_retry')
          await delay(backoffMs, signal)
        }
      }
    }
    catch (err) {
      const classified = classifyBrainError(err, {
        model: this.model,
        signal,
        defaultCooldownMs: cfg.defaultCooldownMs,
      })

      // Emit usage for a failed or aborted call so the benchmark can
      // distinguish a complete call from one that did not finish; at most once.
      if (usageAccumulator)
        safeEmitUsage(this.usageSink, usageAccumulator.finalize({ provider: 'gemini', model: this.model, correlationId: request.turnId ?? `${request.guildId}:${request.userId}`, disposition: classified instanceof BrainRequestAbortedError ? 'aborted' : 'failed', retryCount: 0, observedAt: new Date().toISOString() }), (error) => { this.logger.withFields({ error: String(error) }).error('gemini_usage_sink_error') })

      // Arm the cooldown at the provider boundary so *every* caller is blocked,
      // not just the guild that happened to hit the limit.
      if (classified instanceof BrainRateLimitError) {
        this.limiter.blockUntil(Date.now() + classified.retryAfterMs)
        this.logger.withFields({
          retryAfterMs: classified.retryAfterMs,
          quotaMetric: classified.quotaMetric,
          quotaId: classified.quotaId,
          model: classified.model,
        }).warn('gemini_rate_limited')
      }

      throw classified
    }
    finally {
      this.limiter.release()
    }
  }
}

function mapThinkingLevel(level: import('./types').GeminiThinkingLevel): ThinkingLevel {
  return {
    minimal: ThinkingLevel.MINIMAL,
    low: ThinkingLevel.LOW,
    medium: ThinkingLevel.MEDIUM,
    high: ThinkingLevel.HIGH,
  }[level]
}
