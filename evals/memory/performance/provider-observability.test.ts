import type { BrainUsageSink, UsageMetadataInput } from './provider-observability'

import { describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { createUsageAccumulator, safeEmitUsage, USAGE_DISPOSITIONS, usageRecordDigest, usageRecordSchema } from './provider-observability'

/**
 * Provider usage observability tests for the IMP-803 benchmark.
 *
 * These assert the numeric-only usage record schema, the at-most-once
 * accumulator semantics, and that a sink error never breaks generation.
 */

describe('usage record schema', () => {
  function validRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: 1,
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      correlationId: 'bench-turn-1',
      inputTokens: 120,
      outputTokens: 45,
      thinkingTokens: null,
      totalTokens: 165,
      disposition: 'complete',
      retryCount: 0,
      observedAt: '2026-08-06T00:00:00Z',
      ...overrides,
    }
  }

  it('accepts a well-formed numeric-only record', () => {
    expect(() => v.parse(usageRecordSchema, validRecord())).not.toThrow()
  })

  it('accepts null token counts when the SDK exposes no usage', () => {
    expect(() => v.parse(usageRecordSchema, validRecord({ inputTokens: null, outputTokens: null, totalTokens: null, disposition: 'unavailable' }))).not.toThrow()
  })

  it('rejects a negative token count', () => {
    expect(() => v.parse(usageRecordSchema, validRecord({ inputTokens: -5 }))).toThrow()
  })

  it('rejects an unknown disposition', () => {
    expect(() => v.parse(usageRecordSchema, validRecord({ disposition: 'partial' }))).toThrow()
  })

  it('rejects an extra content-bearing field', () => {
    expect(() => v.parse(usageRecordSchema, validRecord({ promptText: 'leak' }))).toThrow()
  })

  it('uSAGE_DISPOSITIONS lists the four documented dispositions', () => {
    expect(USAGE_DISPOSITIONS).toEqual(['complete', 'aborted', 'failed', 'unavailable'])
  })
})

describe('usage accumulator', () => {
  it('keeps the last non-empty metadata and finalizes one record', () => {
    const accumulator = createUsageAccumulator()
    const chunks: UsageMetadataInput[] = [
      { promptTokenCount: 100 },
      { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
    ]
    for (const chunk of chunks)
      accumulator.observe(chunk)
    const record = accumulator.finalize({ provider: 'gemini', model: 'm', correlationId: 'c1', disposition: 'complete', retryCount: 0, observedAt: '2026-08-06T00:00:00Z' })
    expect(record.inputTokens).toBe(100)
    expect(record.outputTokens).toBe(50)
    expect(record.totalTokens).toBe(150)
    expect(record.disposition).toBe('complete')
  })

  it('finalizes as unavailable when no metadata was observed', () => {
    const accumulator = createUsageAccumulator()
    accumulator.observe(undefined)
    const record = accumulator.finalize({ provider: 'gemini', model: 'm', correlationId: 'c1', disposition: 'unavailable', retryCount: 0, observedAt: '2026-08-06T00:00:00Z' })
    expect(record.inputTokens).toBeNull()
    expect(record.totalTokens).toBeNull()
    expect(record.disposition).toBe('unavailable')
  })

  it('produces a stable digest for the same record', () => {
    const accumulator = createUsageAccumulator()
    accumulator.observe({ promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 })
    const record = accumulator.finalize({ provider: 'gemini', model: 'm', correlationId: 'c1', disposition: 'complete', retryCount: 0, observedAt: '2026-08-06T00:00:00Z' })
    expect(usageRecordDigest(record)).toMatch(/^[0-9a-f]{64}$/)
    expect(usageRecordDigest(record)).toBe(usageRecordDigest(record))
  })
})

describe('safeEmitUsage', () => {
  it('invokes the sink when present', () => {
    const received: number[] = []
    const sink: BrainUsageSink = (record) => {
      received.push(record.totalTokens ?? -1)
    }
    const accumulator = createUsageAccumulator()
    accumulator.observe({ totalTokenCount: 42 })
    safeEmitUsage(sink, accumulator.finalize({ provider: 'gemini', model: 'm', correlationId: 'c1', disposition: 'complete', retryCount: 0, observedAt: '2026-08-06T00:00:00Z' }))
    expect(received).toEqual([42])
  })

  it('swallows a sink error so generation is never broken', () => {
    const throwingSink: BrainUsageSink = () => {
      throw new Error('sink fault')
    }
    const accumulator = createUsageAccumulator()
    accumulator.observe({ totalTokenCount: 1 })
    let onErrorCalled = false
    const onError = (): void => {
      onErrorCalled = true
    }
    expect(() => safeEmitUsage(throwingSink, accumulator.finalize({ provider: 'gemini', model: 'm', correlationId: 'c1', disposition: 'complete', retryCount: 0, observedAt: '2026-08-06T00:00:00Z' }), onError)).not.toThrow()
    expect(onErrorCalled).toBe(true)
  })

  it('is a no-op when no sink is supplied', () => {
    const accumulator = createUsageAccumulator()
    accumulator.observe({ totalTokenCount: 1 })
    expect(() => safeEmitUsage(undefined, accumulator.finalize({ provider: 'gemini', model: 'm', correlationId: 'c1', disposition: 'complete', retryCount: 0, observedAt: '2026-08-06T00:00:00Z' }))).not.toThrow()
  })
})
