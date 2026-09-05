/**
 * Measurement primitives for the G2 operational soak.
 *
 * The generic statistics primitive (seeded randomness, nearest-rank percentile,
 * bounded-memory latency series) now lives in
 * {@link ../benchmark-statistics.ts} and is re-exported here so existing G2
 * importers keep compiling against the supported new package-root path. New
 * benchmark harnesses should import the primitive from
 * `@proj-airi/memory-sqlite` directly rather than reaching into `src/benchmark`.
 *
 * Two properties matter more than convenience here. First, a soak may run for
 * days, so nothing may grow without bound: counts, minima, maxima, and means
 * are streamed, and only a bounded sample array backs the percentiles. Second,
 * the numbers must be reproducible, so the reservoir that replaces samples once
 * the bound is reached is driven by the run's seeded generator rather than
 * `Math.random`.
 */

import type { LatencyStatistics } from '../benchmark-statistics.js'

import { createSeededRandom, LatencySeries } from '../benchmark-statistics.js'

export type { LatencyStatistics, PercentileMethod } from '../benchmark-statistics.js'
export { createSeededRandom, LatencySeries, percentileOf } from '../benchmark-statistics.js'

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
