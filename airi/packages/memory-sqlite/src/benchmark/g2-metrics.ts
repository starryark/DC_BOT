/**
 * Measurement primitives for the G2 operational soak.
 *
 * Two properties matter more than convenience here. First, a soak may run for
 * days, so nothing may grow without bound: counts, minima, maxima, and means
 * are streamed, and only a bounded sample array backs the percentiles. Second,
 * the numbers must be reproducible, so the reservoir that replaces samples once
 * the bound is reached is driven by the run's seeded generator rather than
 * `Math.random`.
 */

/** Latency categories reported separately; mixing them would hide slow classes inside a global percentile. */
export const latencyCategories = Object.freeze([
  'append_text',
  'append_voice',
  'read',
  'queue_claim',
  'transaction',
  'identity_observe',
  'checkpoint',
  'backup',
  'restore',
] as const)

export type LatencyCategory = typeof latencyCategories[number]

/** How the reported percentiles were produced. */
export type PercentileMethod
  /** Every observation was retained; percentiles are exact nearest-rank values. */
  = | 'exact-nearest-rank'
  /** Observations exceeded the retention bound; percentiles are nearest-rank over a uniform reservoir. */
    | 'reservoir-nearest-rank'

/** Distribution summary for one operation category. All durations are milliseconds. */
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

/** Bounded-memory latency accumulator for one category. */
export class LatencySeries {
  private count = 0
  private sum = 0
  private minimum: number | null = null
  private maximum: number | null = null
  private readonly samples: number[] = []

  constructor(private readonly capacity: number, private readonly random: () => number) {}

  record(durationMs: number): void {
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

/** Counters that must be zero (or explained) for a run to be correctness-clean. */
export interface CorrectnessCounters {
  attemptedWrites: number
  acknowledgedWrites: number
  failedWrites: number
  acknowledgedWritesMissingAfterReopen: number
  duplicateEffects: number
  idempotentRetries: number
  partialTransactionDetections: number
  integrityFailures: number
  foreignKeyFailures: number
  migrationChecksumFailures: number
  unexpectedRecordCountDifferences: number
}

/** What the synthetic workload actually did. */
export interface WorkloadCounters {
  textWrites: number
  voiceWrites: number
  reads: number
  queueClaims: number
  identityObservations: number
  multiMutationTransactions: number
  rollbackProbes: number
  logicalRoomCount: number
  activeRoomCount: number
  burstCount: number
  runDurationSeconds: number
  operationsPerSecond: number
}

/** SQLite lock behaviour observed during the run. */
export interface ContentionCounters {
  busyOutcomes: number
  lockedOutcomes: number
  busyRetries: number
  busyRetryExhaustion: number
  totalBusyWaitMs: number
  maximumSingleBusyWaitMs: number
  /** Highest number of scheduled-but-unexecuted writes; the in-process writer backlog. */
  maximumWriterQueueDepth: number
}

/** WAL and on-disk size evidence. */
export interface StorageCounters {
  databaseBytes: number
  maximumWalBytes: number
  finalWalBytes: number
  backupBytes: number
  restoredDatabaseBytes: number
  checkpointCount: number
  checkpointFailures: number
}

/** Every counter family, owned by one collector for the lifetime of a run. */
export interface G2Counters {
  readonly correctness: CorrectnessCounters
  readonly workload: WorkloadCounters
  readonly contention: ContentionCounters
  readonly storage: StorageCounters
}

/** Snapshot of every latency category, keyed by category name. */
export type LatencySnapshot = Readonly<Record<LatencyCategory, LatencyStatistics>>

/**
 * Owns all mutable measurement state for a run.
 *
 * Counters are exposed as mutable records on purpose: the soak updates them
 * from many call sites, and wrapping each field in a method would add noise
 * without adding a decision.
 */
export class MetricsCollector {
  readonly counters: G2Counters
  private readonly series: Map<LatencyCategory, LatencySeries>

  constructor(sampleCapacity: number, seed: number) {
    const random = createSeededRandom(seed)
    this.series = new Map(latencyCategories.map(category => [category, new LatencySeries(sampleCapacity, random)]))
    this.counters = {
      correctness: { attemptedWrites: 0, acknowledgedWrites: 0, failedWrites: 0, acknowledgedWritesMissingAfterReopen: 0, duplicateEffects: 0, idempotentRetries: 0, partialTransactionDetections: 0, integrityFailures: 0, foreignKeyFailures: 0, migrationChecksumFailures: 0, unexpectedRecordCountDifferences: 0 },
      workload: { textWrites: 0, voiceWrites: 0, reads: 0, queueClaims: 0, identityObservations: 0, multiMutationTransactions: 0, rollbackProbes: 0, logicalRoomCount: 0, activeRoomCount: 0, burstCount: 0, runDurationSeconds: 0, operationsPerSecond: 0 },
      contention: { busyOutcomes: 0, lockedOutcomes: 0, busyRetries: 0, busyRetryExhaustion: 0, totalBusyWaitMs: 0, maximumSingleBusyWaitMs: 0, maximumWriterQueueDepth: 0 },
      storage: { databaseBytes: 0, maximumWalBytes: 0, finalWalBytes: 0, backupBytes: 0, restoredDatabaseBytes: 0, checkpointCount: 0, checkpointFailures: 0 },
    }
  }

  record(category: LatencyCategory, durationMs: number): void {
    this.series.get(category)?.record(durationMs)
  }

  latency(): LatencySnapshot {
    const entries = latencyCategories.map(category => [category, this.series.get(category)!.snapshot()] as const)
    return Object.freeze(Object.fromEntries(entries)) as LatencySnapshot
  }
}

/**
 * Flat metric keys an operator threshold document may reference.
 *
 * The namespace is flat and explicit so a threshold file can be reviewed
 * without reading the harness: an unknown key is reported as unavailable
 * rather than silently ignored.
 */
export function observedMetricValues(latency: LatencySnapshot, counters: G2Counters, recovery: { achievedRpoMs: number | null, achievedRtoMs: number | null }): ReadonlyMap<string, number> {
  const values = new Map<string, number>()
  const put = (key: string, value: number | null): void => {
    if (value != null && Number.isFinite(value))
      values.set(key, value)
  }
  put('append.p50Ms', latency.append_text.p50)
  put('append.p95Ms', latency.append_text.p95)
  put('append.p99Ms', latency.append_text.p99)
  put('appendVoice.p95Ms', latency.append_voice.p95)
  put('appendVoice.p99Ms', latency.append_voice.p99)
  put('read.p95Ms', latency.read.p95)
  put('queueClaim.p95Ms', latency.queue_claim.p95)
  put('checkpoint.p95Ms', latency.checkpoint.p95)
  put('checkpoint.p99Ms', latency.checkpoint.p99)
  put('backup.p95Ms', latency.backup.p95)
  put('restore.maxMs', latency.restore.max)
  put('throughput.operationsPerSecond', counters.workload.operationsPerSecond)
  put('contention.busyRetryExhaustion', counters.contention.busyRetryExhaustion)
  put('contention.maximumWriterQueueDepth', counters.contention.maximumWriterQueueDepth)
  put('wal.maximumBytes', counters.storage.maximumWalBytes)
  put('wal.finalBytes', counters.storage.finalWalBytes)
  put('storage.databaseBytes', counters.storage.databaseBytes)
  put('correctness.failedWrites', counters.correctness.failedWrites)
  put('correctness.acknowledgedWritesMissingAfterReopen', counters.correctness.acknowledgedWritesMissingAfterReopen)
  put('correctness.duplicateEffects', counters.correctness.duplicateEffects)
  put('recovery.achievedRpoMs', recovery.achievedRpoMs)
  put('recovery.achievedRtoMs', recovery.achievedRtoMs)
  return values
}
