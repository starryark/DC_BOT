import * as v from 'valibot'

import { sha256Canonical } from '../contracts'

/**
 * Provider usage observability for the IMP-803 deterministic benchmark.
 *
 * The installed `@google/genai@2.14.0` SDK exposes trustworthy final numeric
 * usage metadata on streamed responses: each `GenerateContentResponse` chunk
 * carries an optional `usageMetadata` with `promptTokenCount`,
 * `candidatesTokenCount`, `thoughtsTokenCount`, and `totalTokenCount`. This
 * module captures that metadata at most once per provider call, without
 * changing the `BrainProvider` streaming return type.
 *
 * A usage record is numeric-only and content-free: no request contents,
 * system instructions, generated text, guild/user ids, or API response
 * payloads. The sink never breaks generation — a sink error is caught and
 * logged without content.
 */

/** Completion disposition of one observed provider call. */
export const USAGE_DISPOSITIONS = Object.freeze(['complete', 'aborted', 'failed', 'unavailable'] as const)
export type UsageDisposition = typeof USAGE_DISPOSITIONS[number]

/** One numeric-only provider usage record. */
export const usageRecordSchema = v.strictObject({
  schemaVersion: v.literal(1),
  provider: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
  model: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  /** Content-free correlation id; never a guild/user id or turn content. */
  correlationId: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  inputTokens: v.union([v.pipe(v.number(), v.integer(), v.minValue(0)), v.null()]),
  outputTokens: v.union([v.pipe(v.number(), v.integer(), v.minValue(0)), v.null()]),
  thinkingTokens: v.union([v.pipe(v.number(), v.integer(), v.minValue(0)), v.null()]),
  totalTokens: v.union([v.pipe(v.number(), v.integer(), v.minValue(0)), v.null()]),
  disposition: v.picklist(USAGE_DISPOSITIONS),
  retryCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  observedAt: v.pipe(v.string(), v.minLength(1)),
})

export type UsageRecord = v.InferOutput<typeof usageRecordSchema>

/**
 * The observer a provider constructor accepts.
 *
 * No sink means current production behavior. When supplied, the provider emits
 * at most one {@link UsageRecord} per call: the final numeric metadata from
 * the last streamed chunk, or an explicit `unavailable` disposition when the
 * SDK does not expose trustworthy final usage.
 */
export type BrainUsageSink = (record: UsageRecord) => void

/**
 * Capture the final numeric usage metadata from a streamed response.
 *
 * The Gemini SDK accumulates usage metadata across chunks; the final chunk
 * carries the complete counts. This keeps the latest non-empty metadata seen
 * during the stream and never emits more than once per call.
 */
export interface UsageAccumulator {
  /** Feed each chunk's optional usageMetadata; the last non-empty one wins. */
  observe: (metadata: UsageMetadataInput | undefined) => void
  /** Emit the accumulated record, or unavailable if no metadata was seen. */
  finalize: (params: { provider: string, model: string, correlationId: string, disposition: UsageDisposition, retryCount: number, observedAt: string }) => UsageRecord
}

/** The numeric fields the SDK's usage metadata exposes; mirrored content-free. */
export interface UsageMetadataInput {
  readonly promptTokenCount?: number
  readonly candidatesTokenCount?: number
  readonly thoughtsTokenCount?: number
  readonly totalTokenCount?: number
}

/** Create an accumulator that keeps the last non-empty usage metadata. */
export function createUsageAccumulator(): UsageAccumulator {
  let latest: UsageMetadataInput | undefined
  return {
    observe: (metadata) => {
      if (metadata && (metadata.promptTokenCount != null || metadata.candidatesTokenCount != null || metadata.totalTokenCount != null))
        latest = metadata
    },
    finalize: ({ provider, model, correlationId, disposition, retryCount, observedAt }) => {
      const record: UsageRecord = {
        schemaVersion: 1,
        provider,
        model,
        correlationId,
        inputTokens: latest?.promptTokenCount ?? null,
        outputTokens: latest?.candidatesTokenCount ?? null,
        thinkingTokens: latest?.thoughtsTokenCount ?? null,
        totalTokens: latest?.totalTokenCount ?? null,
        disposition,
        retryCount,
        observedAt,
      }
      return record
    },
  }
}

/**
 * Safe sink invocation: never lets a sink error break generation.
 *
 * The sink is observer-only; if it throws, the error is swallowed (the
 * benchmark must never crash a live generation over a reporting fault).
 */
export function safeEmitUsage(sink: BrainUsageSink | undefined, record: UsageRecord, onError?: (error: unknown) => void): void {
  if (!sink)
    return
  try {
    sink(record)
  }
  catch (error) {
    onError?.(error)
  }
}

/** Canonical digest of a usage record for provenance tracking. */
export function usageRecordDigest(record: UsageRecord): string {
  return sha256Canonical(record)
}

export { sha256Canonical }
