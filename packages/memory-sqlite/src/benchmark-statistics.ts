/**
 * Deterministic, bounded-memory statistics primitives shared by every
 * benchmark harness in this package (G2 operational soak today, and the
 * discord-bot performance benchmark introduced under IMP-803).
 *
 * Two properties matter more than convenience here. First, a soak may run for
 * days, so nothing may grow without bound: counts, minima, maxima, and means
 * are streamed, and only a bounded sample array backs the percentiles. Second,
 * the numbers must be reproducible, so the reservoir that replaces samples once
 * the bound is reached is driven by the run's seeded generator rather than
 * `Math.random`.
 *
 * This module is intentionally free of any G2-specific concept (latency
 * category names, correctness/workload counters, collectors). Those stay in
 * {@link ./benchmark/g2-metrics.ts}; only the generic statistical primitive
 * lives here.
 */

/** How the reported percentiles were produced. */
export type PercentileMethod
  /** Every observation was retained; percentiles are exact nearest-rank values. */
  = | 'exact-nearest-rank'
  /** Observations exceeded the retention bound; percentiles are nearest-rank over a uniform reservoir. */
    | 'reservoir-nearest-rank'

/** Distribution summary for one measured series. */
export interface LatencyStatistics {
  readonly count: number
  readonly min: number | null
  readonly max: number | null
  readonly mean: number | null
  readonly p50: number | null
  readonly p95: number | null
  readonly p99: number | null
  readonly method: PercentileMethod
  readonly retainedSamples: number
  readonly sampleCapacity: number
}

/**
 * Deterministic 32-bit generator (mulberry32).
 *
 * Chosen because it is a few lines, has no dependency, and reproduces exactly
 * across platforms — the harness needs repeatability, not cryptographic
 * quality. Never use this for anything security-relevant.
 */
export function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Nearest-rank percentile over an ascending array.
 *
 * Nearest rank (rather than an interpolating definition) is used because every
 * reported percentile is then an observation that actually happened, which is
 * what an operator approving a latency envelope needs to reason about.
 *
 * @param ascending Values sorted ascending; not copied or mutated.
 * @param p Percentile in (0,1].
 */
export function percentileOf(ascending: readonly number[], p: number): number | null {
  if (ascending.length === 0)
    return null
  const rank = Math.ceil(p * ascending.length)
  return ascending[Math.min(ascending.length - 1, Math.max(0, rank - 1))] ?? null
}

/**
 * Bounded-memory series accumulator.
 *
 * Records stream count/min/max/mean continuously and keep a bounded reservoir
 * of the actual observations so a percentile can be computed without retaining
 * every sample. The unit is whatever the caller records; for the G2 soak and
 * the IMP-803 runtime/controller benchmarks this is milliseconds.
 */
export class LatencySeries {
  private count = 0
  private sum = 0
  private minimum: number | null = null
  private maximum: number | null = null
  private readonly samples: number[] = []

  constructor(private readonly capacity: number, private readonly random: () => number) {}

  record(durationMs: number): void {
    // Non-finite or negative observations are ignored rather than corrupting
    // the streamed aggregates — a benchmark sample that did not produce a real
    // duration must not look like a zero-latency success.
    if (!Number.isFinite(durationMs) || durationMs < 0)
      return
    this.count += 1
    this.sum += durationMs
    if (this.minimum == null || durationMs < this.minimum)
      this.minimum = durationMs
    if (this.maximum == null || durationMs > this.maximum)
      this.maximum = durationMs
    if (this.samples.length < this.capacity) {
      this.samples.push(durationMs)
      return
    }
    // Algorithm R: every observation keeps an equal probability of being
    // retained, so the reservoir stays a uniform sample of the whole run
    // rather than of its first `capacity` operations.
    const index = Math.floor(this.random() * this.count)
    if (index < this.capacity)
      this.samples[index] = durationMs
  }

  snapshot(): LatencyStatistics {
    const ascending = this.samples.slice().sort((a, b) => a - b)
    return Object.freeze({
      count: this.count,
      min: this.minimum,
      max: this.maximum,
      mean: this.count === 0 ? null : this.sum / this.count,
      p50: percentileOf(ascending, 0.5),
      p95: percentileOf(ascending, 0.95),
      p99: percentileOf(ascending, 0.99),
      method: this.count > this.capacity ? 'reservoir-nearest-rank' : 'exact-nearest-rank',
      retainedSamples: ascending.length,
      sampleCapacity: this.capacity,
    })
  }
}
