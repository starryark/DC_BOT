/**
 * Configuration for the G2 operational soak harness.
 *
 * Every value is resolved once, validated once, and printed once before any
 * database is opened, because the resolved configuration is part of the
 * evidence: an operator reviewing a soak report must be able to see exactly
 * what was run without re-deriving it from shell history.
 *
 * Nothing here is silently coerced. An out-of-range value is a startup error,
 * never a quietly lowered workload — a soak that secretly ran at half the
 * requested rate would be worse than no soak at all.
 */

import process from 'node:process'

import { tmpdir } from 'node:os'

import { MemoryError } from '@proj-airi/memory-domain'

import { recommendedBusyTimeoutMs } from '../connection-profile.js'
import { assertDirectoriesSeparate, isInsideDirectory, resolveOperatorDirectory } from './g2-path-safety.js'

/**
 * Seed used when the operator supplies none.
 *
 * The specific number is arbitrary; only its stability matters, because two
 * runs with the same seed must generate the same synthetic workload shape.
 */
export const defaultSeed = 20260802

/** Exact value `G2_SECOND_WRITER_PROBE` must carry to arm the second-writer probe. */
export const secondWriterProbeToken = 'enabled'

/** Fully resolved, validated soak settings. */
export interface G2Configuration {
  /** Absolute directory that will hold the run-scoped synthetic authority database. */
  readonly databaseDirectory: string
  /** Absolute directory that will hold evidence; always separate from the authority. */
  readonly outputDirectory: string
  readonly durationSeconds: number
  readonly seed: number
  readonly logicalRooms: number
  /** Synthetic text ingress appends per second, across all rooms. */
  readonly textWriteRate: number
  /** Synthetic voice ingress appends per second, across all rooms. */
  readonly voiceWriteRate: number
  /** Read-only connections opened alongside the single write-capable connection. */
  readonly readerConcurrency: number
  /** Logical queue claimers running inside the single process. */
  readonly queueClaimers: number
  readonly checkpointIntervalSeconds: number
  readonly backupIntervalSeconds: number
  /** Connection-reopen interval; may exceed the duration, in which case no reopen is exercised. */
  readonly restartIntervalSeconds: number
  /** Interval for the bounded in-process lock-contention probe; may exceed the duration. */
  readonly contentionProbeIntervalSeconds: number
  readonly busyTimeoutMs: number
  /** Operator-supplied threshold document; absent means results are reported unevaluated. */
  readonly thresholdsFile?: string
  /** Free-text operator attestation about storage locality; never inferred by the harness. */
  readonly storageAttestation?: string
  /** Whether the opt-in second-writer probe runs after the workload completes. */
  readonly secondWriterProbe: boolean
  /** Per-category latency samples retained before percentile estimation switches to a reservoir. */
  readonly latencySampleCapacity: number
}

/** One environment variable as requested and as effectively applied. */
export interface G2RequestedValue {
  readonly variable: string
  readonly requested: string | undefined
  readonly effective: string
  readonly source: 'environment' | 'default'
}

/** The configuration plus the provenance record printed into the evidence. */
export interface ResolvedG2Configuration {
  readonly configuration: G2Configuration
  readonly requested: readonly G2RequestedValue[]
}

function invalid(variable: string, requirement: string, raw: string | undefined): never {
  throw new MemoryError('INVALID_PAYLOAD', `${variable} ${requirement} (received ${raw == null ? 'nothing' : JSON.stringify(raw)})`)
}

function integerIn(variable: string, raw: string | undefined, bounds: { min: number, max: number, fallback: number }): number {
  if (raw == null || raw.trim().length === 0)
    return bounds.fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < bounds.min || value > bounds.max)
    invalid(variable, `must be an integer from ${bounds.min} through ${bounds.max}`, raw)
  return value
}

function rateIn(variable: string, raw: string | undefined, bounds: { min: number, max: number, fallback: number }): number {
  if (raw == null || raw.trim().length === 0)
    return bounds.fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < bounds.min || value > bounds.max)
    invalid(variable, `must be a finite rate from ${bounds.min} through ${bounds.max} writes per second`, raw)
  return value
}

function optionalText(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim()
  return trimmed.length === 0 ? undefined : trimmed
}

function requestedValue(variable: string, raw: string | undefined, effective: string | number | boolean): G2RequestedValue {
  const supplied = raw != null && raw.trim().length > 0
  return Object.freeze({ variable, requested: supplied ? raw : undefined, effective: String(effective), source: supplied ? 'environment' : 'default' })
}

/**
 * Resolve and validate the soak configuration from an environment mapping.
 *
 * Pure and synchronous so tests can exercise every rejection path without
 * touching a filesystem. Checks that need the filesystem (directory contents,
 * checkout location) live in `g2-path-safety.ts` and run at startup.
 *
 * @param env Environment mapping to read; defaults to the current process env.
 */
export function resolveG2Configuration(env: NodeJS.ProcessEnv = process.env): ResolvedG2Configuration {
  const databaseDirectory = resolveOperatorDirectory('G2_DATABASE_DIRECTORY', env.G2_DATABASE_DIRECTORY)
  const outputDirectory = resolveOperatorDirectory('G2_OUTPUT_DIRECTORY', env.G2_OUTPUT_DIRECTORY)

  // The soak must measure the storage the deployment will actually use. A
  // temporary directory is frequently a different volume (and on some hosts a
  // RAM-backed one), so its numbers would not be evidence about anything.
  const temporaryRoot = tmpdir()
  for (const [variable, directory] of [['G2_DATABASE_DIRECTORY', databaseDirectory], ['G2_OUTPUT_DIRECTORY', outputDirectory]] as const) {
    if (isInsideDirectory(temporaryRoot, directory))
      throw new MemoryError('POLICY_VIOLATION', `${variable} must not be inside the operating-system temporary directory (${temporaryRoot}); the soak must run on the intended deployment volume`)
  }
  assertDirectoriesSeparate(databaseDirectory, outputDirectory)

  const durationSeconds = integerIn('G2_DURATION_SECONDS', env.G2_DURATION_SECONDS, { min: 5, max: 2_592_000, fallback: 300 })
  const seed = integerIn('G2_SEED', env.G2_SEED, { min: 0, max: Number.MAX_SAFE_INTEGER, fallback: defaultSeed })
  const logicalRooms = integerIn('G2_LOGICAL_ROOMS', env.G2_LOGICAL_ROOMS, { min: 1, max: 4096, fallback: 24 })
  const textWriteRate = rateIn('G2_TEXT_WRITE_RATE', env.G2_TEXT_WRITE_RATE, { min: 0, max: 10_000, fallback: 4 })
  const voiceWriteRate = rateIn('G2_VOICE_WRITE_RATE', env.G2_VOICE_WRITE_RATE, { min: 0, max: 10_000, fallback: 2 })
  const readerConcurrency = integerIn('G2_READER_CONCURRENCY', env.G2_READER_CONCURRENCY, { min: 0, max: 64, fallback: 3 })
  const queueClaimers = integerIn('G2_QUEUE_CLAIMERS', env.G2_QUEUE_CLAIMERS, { min: 0, max: 64, fallback: 2 })
  const checkpointIntervalSeconds = integerIn('G2_CHECKPOINT_INTERVAL_SECONDS', env.G2_CHECKPOINT_INTERVAL_SECONDS, { min: 1, max: 604_800, fallback: 60 })
  const backupIntervalSeconds = integerIn('G2_BACKUP_INTERVAL_SECONDS', env.G2_BACKUP_INTERVAL_SECONDS, { min: 1, max: 604_800, fallback: 120 })
  const restartIntervalSeconds = integerIn('G2_RESTART_INTERVAL_SECONDS', env.G2_RESTART_INTERVAL_SECONDS, { min: 1, max: 604_800, fallback: 600 })
  const contentionProbeIntervalSeconds = integerIn('G2_CONTENTION_PROBE_INTERVAL_SECONDS', env.G2_CONTENTION_PROBE_INTERVAL_SECONDS, { min: 1, max: 604_800, fallback: 120 })
  const busyTimeoutMs = integerIn('G2_BUSY_TIMEOUT_MS', env.G2_BUSY_TIMEOUT_MS, { min: 1, max: 60_000, fallback: recommendedBusyTimeoutMs })
  const latencySampleCapacity = integerIn('G2_LATENCY_SAMPLE_CAPACITY', env.G2_LATENCY_SAMPLE_CAPACITY, { min: 1_000, max: 2_000_000, fallback: 200_000 })

  if (textWriteRate === 0 && voiceWriteRate === 0)
    throw new MemoryError('INVALID_PAYLOAD', 'at least one of G2_TEXT_WRITE_RATE or G2_VOICE_WRITE_RATE must be greater than zero')

  // Checkpoint and backup evidence must be collected *during* load, so a run
  // whose interval can never fire is a configuration error rather than a run
  // that quietly produces no checkpoint or backup samples under load.
  if (checkpointIntervalSeconds > durationSeconds)
    throw new MemoryError('INVALID_PAYLOAD', `G2_CHECKPOINT_INTERVAL_SECONDS (${checkpointIntervalSeconds}) must not exceed G2_DURATION_SECONDS (${durationSeconds}); checkpoints must be exercised during load`)
  if (backupIntervalSeconds > durationSeconds)
    throw new MemoryError('INVALID_PAYLOAD', `G2_BACKUP_INTERVAL_SECONDS (${backupIntervalSeconds}) must not exceed G2_DURATION_SECONDS (${durationSeconds}); at least one online backup must be taken during load`)

  const probeToken = optionalText(env.G2_SECOND_WRITER_PROBE)
  if (probeToken != null && probeToken !== secondWriterProbeToken)
    invalid('G2_SECOND_WRITER_PROBE', `must be unset or exactly "${secondWriterProbeToken}"`, env.G2_SECOND_WRITER_PROBE)

  const thresholdsFile = optionalText(env.G2_THRESHOLDS_FILE)
  const storageAttestation = optionalText(env.G2_STORAGE_ATTESTATION)

  const configuration: G2Configuration = Object.freeze({
    databaseDirectory,
    outputDirectory,
    durationSeconds,
    seed,
    logicalRooms,
    textWriteRate,
    voiceWriteRate,
    readerConcurrency,
    queueClaimers,
    checkpointIntervalSeconds,
    backupIntervalSeconds,
    restartIntervalSeconds,
    contentionProbeIntervalSeconds,
    busyTimeoutMs,
    ...(thresholdsFile == null ? {} : { thresholdsFile }),
    ...(storageAttestation == null ? {} : { storageAttestation }),
    secondWriterProbe: probeToken === secondWriterProbeToken,
    latencySampleCapacity,
  })

  const requested: readonly G2RequestedValue[] = Object.freeze([
    requestedValue('G2_DATABASE_DIRECTORY', env.G2_DATABASE_DIRECTORY, databaseDirectory),
    requestedValue('G2_OUTPUT_DIRECTORY', env.G2_OUTPUT_DIRECTORY, outputDirectory),
    requestedValue('G2_DURATION_SECONDS', env.G2_DURATION_SECONDS, durationSeconds),
    requestedValue('G2_SEED', env.G2_SEED, seed),
    requestedValue('G2_LOGICAL_ROOMS', env.G2_LOGICAL_ROOMS, logicalRooms),
    requestedValue('G2_TEXT_WRITE_RATE', env.G2_TEXT_WRITE_RATE, textWriteRate),
    requestedValue('G2_VOICE_WRITE_RATE', env.G2_VOICE_WRITE_RATE, voiceWriteRate),
    requestedValue('G2_READER_CONCURRENCY', env.G2_READER_CONCURRENCY, readerConcurrency),
    requestedValue('G2_QUEUE_CLAIMERS', env.G2_QUEUE_CLAIMERS, queueClaimers),
    requestedValue('G2_CHECKPOINT_INTERVAL_SECONDS', env.G2_CHECKPOINT_INTERVAL_SECONDS, checkpointIntervalSeconds),
    requestedValue('G2_BACKUP_INTERVAL_SECONDS', env.G2_BACKUP_INTERVAL_SECONDS, backupIntervalSeconds),
    requestedValue('G2_RESTART_INTERVAL_SECONDS', env.G2_RESTART_INTERVAL_SECONDS, restartIntervalSeconds),
    requestedValue('G2_CONTENTION_PROBE_INTERVAL_SECONDS', env.G2_CONTENTION_PROBE_INTERVAL_SECONDS, contentionProbeIntervalSeconds),
    requestedValue('G2_BUSY_TIMEOUT_MS', env.G2_BUSY_TIMEOUT_MS, busyTimeoutMs),
    requestedValue('G2_LATENCY_SAMPLE_CAPACITY', env.G2_LATENCY_SAMPLE_CAPACITY, latencySampleCapacity),
    requestedValue('G2_THRESHOLDS_FILE', env.G2_THRESHOLDS_FILE, thresholdsFile ?? '(none; results reported as measured-not-evaluated)'),
    requestedValue('G2_STORAGE_ATTESTATION', env.G2_STORAGE_ATTESTATION, storageAttestation ?? '(none; storage locality reported as unknown)'),
    requestedValue('G2_SECOND_WRITER_PROBE', env.G2_SECOND_WRITER_PROBE, probeToken === secondWriterProbeToken),
  ])

  return { configuration, requested }
}

/** Render the resolved configuration for the pre-run console banner and the evidence file. */
export function formatResolvedConfiguration(resolved: ResolvedG2Configuration): string {
  const width = Math.max(...resolved.requested.map(entry => entry.variable.length))
  return resolved.requested
    .map(entry => `  ${entry.variable.padEnd(width)}  ${entry.effective}${entry.source === 'default' ? '  (default)' : ''}`)
    .join('\n')
}
