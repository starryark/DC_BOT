import type { BrainRateLimiter } from './rate-limiter'
import type { BrainProvider, BrainRequest } from './types'

import { GoogleGenAI, ThinkingLevel } from '@google/genai'
import { useLogg } from '@guiiai/logg'

import { config } from '../../config'
import { BrainRateLimitError, classifyBrainError } from './errors'
import { LocalBrainRateLimiter } from './rate-limiter'

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
 * typed `BrainRateLimitError` that also arms the limiter's cooldown. The
 * provider never retries — retrying an obsolete voice turn is worse than
 * dropping it (Optimize.md §9 Agent 1C).
 */
export class GeminiBrainProvider implements BrainProvider {
  private logger = useLogg('GeminiBrain').useGlobalConfig()
  private client: GoogleGenAI
  private model: string
  private limiter: BrainRateLimiter

  constructor(options: { limiter?: BrainRateLimiter } = {}) {
    const cfg = config().brain
    if (!cfg.apiKey)
      this.logger.warn('GEMINI_API_KEY is not set — generation will fail until it is provided.')
    this.client = new GoogleGenAI({ apiKey: cfg.apiKey })
    this.model = cfg.model
    this.limiter = options.limiter ?? new LocalBrainRateLimiter()
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
    }
    catch (err) {
      const classified = classifyBrainError(err, {
        model: this.model,
        signal,
        defaultCooldownMs: cfg.defaultCooldownMs,
      })

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
