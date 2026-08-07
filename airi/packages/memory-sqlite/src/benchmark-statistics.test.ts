import { describe, expect, it } from 'vitest'

import { createSeededRandom, LatencySeries, percentileOf } from './benchmark-statistics.js'

/**
 * Unit and regression tests for the shared deterministic statistics primitive.
 *
 * These re-assert the invariants the G2 soak relies on (exact nearest-rank
 * while every sample fits, bounded reservoir once capacity is exceeded,
 * deterministic seeding, and non-finite/negative rejection) at the primitive
 * boundary so the extraction into `benchmark-statistics.ts` introduced no
 * semantic drift.
 */

describe('percentileOf', () => {
  it('returns null for an empty array', () => {
    expect(percentileOf([], 0.5)).toBeNull()
  })

  it('returns the sole observation for any percentile when there is one', () => {
    expect(percentileOf([42], 0.5)).toBe(42)
    expect(percentileOf([42], 0.99)).toBe(42)
  })

  it('computes exact nearest-rank p50/p95/p99 over a small ascending set', () => {
    const ascending = Array.from({ length: 10 }, (_, index) => index + 1)
    expect(percentileOf(ascending, 0.5)).toBe(5)
    expect(percentileOf(ascending, 0.95)).toBe(10)
    expect(percentileOf(ascending, 0.99)).toBe(10)
  })
})

describe('LatencySeries', () => {
  it('reports an empty snapshot before any observation is recorded', () => {
    const series = new LatencySeries(1000, createSeededRandom(1))
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(0)
    expect(snapshot.min).toBeNull()
    expect(snapshot.max).toBeNull()
    expect(snapshot.mean).toBeNull()
    expect(snapshot.p50).toBeNull()
    expect(snapshot.p95).toBeNull()
    expect(snapshot.p99).toBeNull()
    expect(snapshot.method).toBe('exact-nearest-rank')
    expect(snapshot.retainedSamples).toBe(0)
    expect(snapshot.sampleCapacity).toBe(1000)
  })

  it('reports a single observation exactly', () => {
    const series = new LatencySeries(1000, createSeededRandom(1))
    series.record(7)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(1)
    expect(snapshot.min).toBe(7)
    expect(snapshot.max).toBe(7)
    expect(snapshot.mean).toBe(7)
    expect(snapshot.p50).toBe(7)
    expect(snapshot.method).toBe('exact-nearest-rank')
    expect(snapshot.retainedSamples).toBe(1)
  })

  it('keeps every observation when capacity is one', () => {
    // Capacity one still streams count/min/max/mean exactly; only the
    // percentile reservoir is a single slot.
    const series = new LatencySeries(1, createSeededRandom(1))
    series.record(3)
    series.record(1)
    series.record(2)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(3)
    expect(snapshot.min).toBe(1)
    expect(snapshot.max).toBe(3)
    expect(snapshot.mean).toBe(2)
    expect(snapshot.retainedSamples).toBe(1)
    expect(snapshot.method).toBe('reservoir-nearest-rank')
  })

  it('reports exact statistics while every sample is retained', () => {
    const series = new LatencySeries(1000, () => 0.5)
    for (let value = 1; value <= 100; value++)
      series.record(value)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(100)
    expect(snapshot.min).toBe(1)
    expect(snapshot.max).toBe(100)
    expect(snapshot.mean).toBe(50.5)
    expect(snapshot.p50).toBe(50)
    expect(snapshot.p95).toBe(95)
    expect(snapshot.p99).toBe(99)
    expect(snapshot.method).toBe('exact-nearest-rank')
    expect(snapshot.retainedSamples).toBe(100)
  })

  it('switches to a bounded reservoir past capacity while keeping exact count, min, max, and mean', () => {
    const series = new LatencySeries(10, () => 0.5)
    for (let value = 1; value <= 100; value++)
      series.record(value)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(100)
    expect(snapshot.min).toBe(1)
    expect(snapshot.max).toBe(100)
    expect(snapshot.mean).toBe(50.5)
    expect(snapshot.retainedSamples).toBe(10)
    expect(snapshot.method).toBe('reservoir-nearest-rank')
    expect(snapshot.p95).not.toBeNull()
  })

  it('produces identical retained statistics for an identical seed and input sequence', () => {
    const record = (seed: number): number => {
      const series = new LatencySeries(8, createSeededRandom(seed))
      for (let value = 1; value <= 1000; value++)
        series.record(value)
      return series.snapshot().p95 ?? -1
    }
    expect(record(20260802)).toBe(record(20260802))
  })

  it('may produce a different reservoir result for a different seed', () => {
    // A different seed drives Algorithm R's replacement decisions, so over a
    // large input the retained p95 need not coincide. This asserts the seed
    // actually participates in sampling rather than that any two seeds differ
    // (a stronger, brittle claim).
    const p95 = (seed: number): number => {
      const series = new LatencySeries(8, createSeededRandom(seed))
      for (let value = 1; value <= 1000; value++)
        series.record(value)
      return series.snapshot().p95 ?? -1
    }
    const observed = new Set([p95(1), p95(2), p95(3), p95(4), p95(5), p95(6), p95(7), p95(8)])
    expect(observed.size).toBeGreaterThan(1)
  })

  it('ignores negative, NaN, and infinity observations without altering counts', () => {
    const series = new LatencySeries(1000, createSeededRandom(1))
    series.record(Number.NaN)
    series.record(Number.POSITIVE_INFINITY)
    series.record(-1)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(0)
    expect(snapshot.min).toBeNull()
    expect(snapshot.mean).toBeNull()
    expect(snapshot.retainedSamples).toBe(0)
  })

  it('keeps retainedSamples within sampleCapacity for a large observation count', () => {
    const series = new LatencySeries(32, createSeededRandom(99))
    for (let value = 0; value < 100_000; value++)
      series.record(value)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(100_000)
    expect(snapshot.retainedSamples).toBeLessThanOrEqual(32)
    expect(snapshot.sampleCapacity).toBe(32)
  })
})
