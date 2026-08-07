import { canonicalJson, sha256Canonical } from '../contracts'

import * as v from 'valibot'

/**
 * Strict, versioned performance contracts for the IMP-803 deterministic
 * benchmark.
 *
 * These contracts describe volatile performance evidence (latency, throughput,
 * token usage, cost) that must never contaminate the IMP-802 functional
 * result digest. Every schema here is strict: unknown fields are rejected so a
 * drifted workload catalog or measurement record fails loudly rather than
 * producing a quietly-wrong report.
 *
 * The contracts are content-free by construction. No prompt text, transcript,
 * generated text, audio, Discord snowflake, operational memory path, or secret
 * may appear in a workload spec, measurement record, run manifest, or imported
 * artifact. Synthetic identifiers are minted deterministically from the seed.
 */

/** Bumped when a performance contract, workload spec, or report field changes in a way that invalidates earlier artifacts. */
export const PERFORMANCE_SCHEMA_VERSION = 1 as const

/** The contract family this benchmark emits; names the workload catalog and digest namespace. */
export const PERFORMANCE_CONTRACT_ID = 'performance-v1' as const

/** Default seed for deterministic workload selection and reservoir sampling. */
export const PERFORMANCE_DEFAULT_SEED = 20260802

/** Runner families that execute workloads; each owns its own driver. */
export const RUNNER_FAMILIES = Object.freeze(['runtime', 'text-controller', 'voice-controller'] as const)
export type RunnerFamily = typeof RUNNER_FAMILIES[number]

/**
 * The role a workload plays in an active/control comparison.
 *
 * `active` exercises real memory; `inert-control` runs the same workload shape
 * against a no-op memory observer so the active-minus-control delta isolates
 * memory overhead. `timer-control` measures raw clock overhead so it can be
 * reported as a diagnostic without subtracting it from every sample.
 */
export const WORKLOAD_ROLES = Object.freeze(['active', 'inert-control', 'timer-control'] as const)
export type WorkloadRole = typeof WORKLOAD_ROLES[number]

/** Suites a workload may belong to; smoke is fast and credential-free. */
export const PERFORMANCE_SUITES = Object.freeze(['smoke', 'performance-v1'] as const)
export type PerformanceSuite = typeof PERFORMANCE_SUITES[number]

/**
 * Synthetic payload-size classes.
 *
 * A class names the shape of generated content (turn count, segment count,
 * chunk count) without carrying the content itself. The benchmark owns
 * deterministic generators that expand a class into fixture data at runtime.
 */
export const PAYLOAD_SIZE_CLASSES = Object.freeze(['empty', 'small', 'medium', 'large'] as const)
export type PayloadSizeClass = typeof PAYLOAD_SIZE_CLASSES[number]

/**
 * Measurement units a record may carry.
 *
 * Currency codes are validated separately and may only appear in cost results,
 * never in a latency or usage record. Unknown units are rejected.
 */
export const MEASUREMENT_UNITS = Object.freeze([
  'milliseconds',
  'operations_per_second',
  'count',
  'bytes',
  'input_tokens',
  'output_tokens',
  'thinking_tokens',
  'total_tokens',
] as const)
export type MeasurementUnit = typeof MEASUREMENT_UNITS[number]

/** Statistics a measurement record may report. */
export const MEASUREMENT_STATISTICS = Object.freeze(['count', 'min', 'max', 'mean', 'p50', 'p95', 'p99'] as const)
export type MeasurementStatistic = typeof MEASUREMENT_STATISTICS[number]

/** Disposition of a measurement value when it could not be observed. */
export const MEASUREMENT_DISPOSITIONS = Object.freeze(['observed', 'unavailable'] as const)
export type MeasurementDisposition = typeof MEASUREMENT_DISPOSITIONS[number]

/** Threshold evaluation outcome attached to an observed measurement, if a threshold covers it. */
export const THRESHOLD_EVALUATIONS = Object.freeze(['passed', 'failed', 'not_evaluated'] as const)
export type ThresholdEvaluation = typeof THRESHOLD_EVALUATIONS[number]

const workloadIdPattern = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{2,62}$/, 'workload id must be kebab-case lowercase'))
// Metric ids reuse the camelCase convention the G2 soak already uses (append.p95Ms,
// throughput.operationsPerSecond), so both cases are allowed alongside dots and hyphens.
const metricIdPattern = v.pipe(v.string(), v.regex(/^[a-zA-Z][a-zA-Z0-9._-]{2,127}$/, 'metric id must be dotted/kebab-case alphanumeric'))

/** One strict workload specification from the frozen catalog. */
export const workloadSpecSchema = v.strictObject({
  workloadId: workloadIdPattern,
  runner: v.picklist(RUNNER_FAMILIES),
  operation: v.pipe(v.string(), v.minLength(1), v.maxLength(120)),
  role: v.picklist(WORKLOAD_ROLES),
  suites: v.pipe(v.array(v.picklist(PERFORMANCE_SUITES)), v.minLength(1)),
  warmupCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sampleCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  sampleCapacity: v.pipe(v.number(), v.integer(), v.minValue(1)),
  roomCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  payloadSizeClass: v.picklist(PAYLOAD_SIZE_CLASSES),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
  /** Stable, content-free postcondition names the runner asserts after every sample. */
  postconditions: v.pipe(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(120))), v.minLength(1)),
})

export type WorkloadSpec = v.InferOutput<typeof workloadSpecSchema>

/** A value-or-unavailable measurement outcome. */
export const measurementValueSchema = v.union([
  v.strictObject({
    disposition: v.literal('observed'),
    value: v.pipe(v.number(), v.finite(), v.minValue(0)),
  }),
  v.strictObject({
    disposition: v.literal('unavailable'),
    /** Content-free reason the value could not be observed; never a secret or path. */
    reason: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  }),
])

/** One strict performance measurement record. */
export const measurementRecordSchema = v.strictObject({
  schemaVersion: v.literal(PERFORMANCE_SCHEMA_VERSION),
  contractId: v.literal(PERFORMANCE_CONTRACT_ID),
  contractDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  workloadId: workloadIdPattern,
  metricId: metricIdPattern,
  role: v.picklist(WORKLOAD_ROLES),
  unit: v.picklist(MEASUREMENT_UNITS),
  statistic: v.picklist(MEASUREMENT_STATISTICS),
  outcome: measurementValueSchema,
  observationCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  retainedSamples: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sampleCapacity: v.pipe(v.number(), v.integer(), v.minValue(0)),
  percentileMethod: v.union([v.literal('exact-nearest-rank'), v.literal('reservoir-nearest-rank')]),
  correctnessClean: v.boolean(),
  thresholdEvaluation: v.picklist(THRESHOLD_EVALUATIONS),
})

export type MeasurementRecord = v.InferOutput<typeof measurementRecordSchema>

/** Environment fingerprint recorded in the run manifest; no secrets or absolute paths. */
export const environmentFingerprintSchema = v.strictObject({
  nodeVersion: v.pipe(v.string(), v.minLength(1)),
  pnpmVersion: v.pipe(v.string(), v.minLength(1)),
  platform: v.pipe(v.string(), v.minLength(1)),
  architecture: v.pipe(v.string(), v.minLength(1)),
  cpuModel: v.pipe(v.string(), v.minLength(1)),
  cpuCount: v.pipe(v.number(), v.integer(), v.minValue(1)),
  totalMemoryBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  sqliteVersion: v.pipe(v.string(), v.minLength(1)),
  /** Optional GPU description; non-secret. */
  gpu: v.optional(v.union([v.pipe(v.string(), v.minLength(1), v.maxLength(200)), v.null()])),
})

export type EnvironmentFingerprint = v.InferOutput<typeof environmentFingerprintSchema>

/** The strict run manifest written to `run-manifest.json`. */
export const runManifestSchema = v.strictObject({
  schemaVersion: v.literal(PERFORMANCE_SCHEMA_VERSION),
  contractId: v.literal(PERFORMANCE_CONTRACT_ID),
  contractDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  commitSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
  dirtyWorktree: v.boolean(),
  suite: v.picklist(PERFORMANCE_SUITES),
  seed: v.pipe(v.number(), v.integer(), v.minValue(0)),
  environment: environmentFingerprintSchema,
  /** Selected, non-secret configuration values; content-free. */
  configuration: v.pipe(v.array(v.strictObject({ key: v.pipe(v.string(), v.minLength(1), v.maxLength(120)), value: v.pipe(v.string(), v.minLength(1), v.maxLength(200)) })), v.maxLength(64)),
  timerSource: v.pipe(v.string(), v.minLength(1)),
  startedAt: v.pipe(v.string(), v.minLength(1)),
  completedAt: v.pipe(v.string(), v.minLength(1)),
  workloadsCompleted: v.pipe(v.array(workloadIdPattern), v.maxLength(512)),
  /** Digests of imported live artifacts; the values are never merged into the deterministic contract digest. */
  importedLiveArtifactDigests: v.pipe(v.array(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))), v.maxLength(64)),
  thresholdDocumentDigest: v.optional(v.union([v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), v.null()])),
  priceDocumentDigest: v.optional(v.union([v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), v.null()])),
  limitations: v.pipe(v.array(v.pipe(v.string(), v.maxLength(280))), v.maxLength(64)),
})

export type RunManifest = v.InferOutput<typeof runManifestSchema>

/**
 * Compute the canonical digest of a workload catalog.
 *
 * The digest is taken over the canonical encoding of the catalog so the same
 * frozen set of workloads always hashes identically, regardless of file
 * layout. Matched benchmark runs must report an identical contract digest;
 * timings are allowed to differ.
 */
export function workloadCatalogDigest(workloads: readonly WorkloadSpec[]): string {
  return sha256Canonical({ contractId: PERFORMANCE_CONTRACT_ID, schemaVersion: PERFORMANCE_SCHEMA_VERSION, workloads })
}

/**
 * Validate the cross-record invariants a schema alone cannot express.
 *
 * Returns a list of content-free failure reasons; an empty list means the
 * catalog is internally consistent. Workload id uniqueness and metric id
 * uniqueness within a run are checked here because they are multi-record
 * constraints, not single-record shape constraints.
 */
export function validateWorkloadCatalog(workloads: readonly WorkloadSpec[]): readonly string[] {
  const failures: string[] = []
  const workloadIds = new Set<string>()
  for (const workload of workloads) {
    if (workloadIds.has(workload.workloadId))
      failures.push(`duplicate workload id ${workload.workloadId}`)
    workloadIds.add(workload.workloadId)
  }
  return Object.freeze(failures)
}

/**
 * Validate cross-record invariants over a set of measurement records.
 *
 * Metric id uniqueness within a run is enforced here. A workload result must
 * reference a declared workload; the caller passes the catalog so this can be
 * checked without a second parse.
 */
export function validateMeasurementRecords(records: readonly MeasurementRecord[], workloads: readonly WorkloadSpec[]): readonly string[] {
  const failures: string[] = []
  const workloadIds = new Set(workloads.map(workload => workload.workloadId))
  const metricIds = new Set<string>()
  for (const record of records) {
    if (!workloadIds.has(record.workloadId))
      failures.push(`measurement ${record.metricId} references undeclared workload ${record.workloadId}`)
    if (metricIds.has(record.metricId))
      failures.push(`duplicate metric id ${record.metricId}`)
    metricIds.add(record.metricId)
  }
  return Object.freeze(failures)
}

export { canonicalJson, sha256Canonical }
