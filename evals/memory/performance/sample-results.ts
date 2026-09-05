import type { WorkloadPlanEntry, WorkloadSpec } from './contracts'

import * as v from 'valibot'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION, VOICE_SAMPLE_DIAGNOSTIC_IDS } from './contracts'

/**
 * Measured-attempt evidence for the IMP-803 performance-v2 benchmark.
 *
 * One row per measured attempt is the authoritative correctness evidence. v1
 * carried only a per-measurement `correctnessClean` boolean that both runners
 * hardcoded to `true`, so nothing published could distinguish "64 attempts, all
 * passed" from "64 attempts, 40 silently dropped" — the latency denominator and
 * the attempt denominator were never reconcilable from artifacts.
 *
 * Rows describe measured attempts only. Warmups are never recorded: they are
 * discarded work, and including them would make `attempted` disagree with the
 * configured sample count.
 *
 * Rows are content-free by construction. The strict schemas reject unknown
 * fields, so a transcript, prompt, generated chunk, snowflake, turn id,
 * filesystem path, or error message cannot ride along in an attempt record.
 */

const workloadIdPattern = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{2,62}$/, 'workload id must be kebab-case lowercase'))
const postconditionIdPattern = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{2,119}$/, 'postcondition id must be kebab-case lowercase'))

const attemptIdentity = {
  schemaVersion: v.literal(PERFORMANCE_SCHEMA_VERSION),
  contractId: v.literal(PERFORMANCE_CONTRACT_ID),
  contractDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  workloadId: workloadIdPattern,
  /** Zero-based index within the measured section; warmups occupy no ordinal. */
  ordinal: v.pipe(v.number(), v.integer(), v.minValue(0)),
} as const

/**
 * One measured attempt.
 *
 * The union is discriminated on `outcome` so the two shapes cannot blur: a
 * passed attempt must carry a duration and a failed attempt must not. Because
 * both branches are strict objects, a failed row carrying `durationMs` fails to
 * parse rather than contributing a bogus latency observation.
 */
export const sampleAttemptRecordSchema = v.variant('outcome', [
  v.strictObject({
    ...attemptIdentity,
    outcome: v.literal('passed'),
    durationMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
  }),
  v.strictObject({
    ...attemptIdentity,
    outcome: v.literal('failed'),
    /** Unique, canonically sorted ids of the postconditions this attempt failed. */
    failedPostconditionIds: v.pipe(v.array(postconditionIdPattern), v.minLength(1)),
    /**
     * Unique, canonically sorted diagnostics naming *why* the attempt failed.
     *
     * Optional and additive: the failed postcondition ids remain the
     * authoritative statement of what was violated, and a row published before
     * this field existed still parses. The ids come from a closed vocabulary,
     * so a diagnostic cannot smuggle an exception message into an artifact.
     */
    diagnosticIds: v.optional(v.pipe(v.array(v.picklist(VOICE_SAMPLE_DIAGNOSTIC_IDS)), v.minLength(1))),
  }),
])

export type SampleAttemptRecord = v.InferOutput<typeof sampleAttemptRecordSchema>

/** Aggregate counts derived purely from a set of attempt rows. */
export interface SampleAttemptSummary {
  /** Number of measured attempt rows. */
  readonly attemptedAttempts: number
  readonly passedAttempts: number
  readonly failedAttempts: number
  /** Total failed postcondition ids across every failed attempt, not a per-attempt count. */
  readonly failedPostconditions: number
  readonly byWorkload: Readonly<Record<string, { readonly attempted: number, readonly passed: number, readonly failed: number }>>
}

/** Parse one serialized attempt row; throws on any schema violation. */
export function parseSampleAttempt(input: unknown): SampleAttemptRecord {
  return v.parse(sampleAttemptRecordSchema, input)
}

/** Parse a whole `attempts.jsonl` body, ignoring blank lines. */
export function parseSampleAttemptsJsonl(jsonl: string): SampleAttemptRecord[] {
  const attempts: SampleAttemptRecord[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0)
      continue
    attempts.push(parseSampleAttempt(JSON.parse(line)))
  }
  return attempts
}

/** Serialize attempt rows to the published JSONL body, one row per line. */
export function sampleAttemptsJsonl(attempts: readonly SampleAttemptRecord[]): string {
  return attempts.length === 0 ? '' : `${attempts.map(attempt => JSON.stringify(attempt)).join('\n')}\n`
}

/** Every attempt belonging to one workload, in the order recorded. */
export function attemptsForWorkload(attempts: readonly SampleAttemptRecord[], workloadId: string): readonly SampleAttemptRecord[] {
  return Object.freeze(attempts.filter(attempt => attempt.workloadId === workloadId))
}

/**
 * Validate an attempt set against the effective plan and the workload catalog.
 *
 * Returns content-free failure reasons; an empty list means the set is complete,
 * internally consistent, and reconcilable with the published plan. This is the
 * check that makes "attempted equals the configured sample count" verifiable
 * from artifacts rather than from CLI state that was never written down.
 */
export function validateSampleAttempts(
  attempts: readonly SampleAttemptRecord[],
  plan: readonly WorkloadPlanEntry[],
  workloads: readonly WorkloadSpec[],
): readonly string[] {
  const failures: string[] = []
  const planByWorkload = new Map(plan.map(entry => [entry.workloadId, entry]))
  const declaredPostconditions = new Map(workloads.map(workload => [workload.workloadId, new Set(workload.postconditions)]))
  const seen = new Set<string>()

  for (const attempt of attempts) {
    const identity = `${attempt.workloadId}#${attempt.ordinal}`
    if (seen.has(identity))
      failures.push(`duplicate attempt ${identity}`)
    seen.add(identity)

    const planned = planByWorkload.get(attempt.workloadId)
    if (!planned) {
      failures.push(`attempt references unplanned workload ${attempt.workloadId}`)
      continue
    }
    if (attempt.ordinal >= planned.sampleCount)
      failures.push(`out-of-range attempt ordinal ${identity} for sample count ${planned.sampleCount}`)

    if (attempt.outcome !== 'failed')
      continue

    const declared = declaredPostconditions.get(attempt.workloadId)
    const unique = new Set(attempt.failedPostconditionIds)
    if (unique.size !== attempt.failedPostconditionIds.length)
      failures.push(`duplicate failed postcondition in attempt ${identity}`)

    const sorted = [...attempt.failedPostconditionIds].sort()
    if (sorted.join('\0') !== attempt.failedPostconditionIds.join('\0'))
      failures.push(`failed postconditions for attempt ${identity} are not in canonical sorted order`)

    for (const postcondition of attempt.failedPostconditionIds) {
      if (declared && !declared.has(postcondition))
        failures.push(`undeclared failed postcondition ${postcondition} in attempt ${identity}`)
    }

    // Diagnostics obey the same canonical-form rule as the postconditions they
    // accompany, so two runs that observed the same failure serialize the same
    // bytes and a diff between artifact sets means a difference in evidence.
    if (attempt.diagnosticIds) {
      if (new Set(attempt.diagnosticIds).size !== attempt.diagnosticIds.length)
        failures.push(`duplicate diagnostic in attempt ${identity}`)
      if ([...attempt.diagnosticIds].sort().join('\0') !== attempt.diagnosticIds.join('\0'))
        failures.push(`diagnostics for attempt ${identity} are not in canonical sorted order`)
    }
  }

  // A workload that ran fewer attempts than planned is incomplete even when
  // every recorded attempt passed; the gap is exactly what v1 could not see.
  for (const entry of plan) {
    const recorded = new Set(attempts.filter(attempt => attempt.workloadId === entry.workloadId).map(attempt => attempt.ordinal))
    for (let ordinal = 0; ordinal < entry.sampleCount; ordinal++) {
      if (!recorded.has(ordinal))
        failures.push(`missing attempt ordinal ${entry.workloadId}#${ordinal}`)
    }
  }

  return Object.freeze(failures)
}

/** Derive the aggregate counts; identical input always yields identical counts. */
export function summarizeSampleAttempts(attempts: readonly SampleAttemptRecord[]): SampleAttemptSummary {
  const byWorkload: Record<string, { attempted: number, passed: number, failed: number }> = {}
  let passedAttempts = 0
  let failedAttempts = 0
  let failedPostconditions = 0

  for (const attempt of attempts) {
    const bucket = byWorkload[attempt.workloadId] ?? (byWorkload[attempt.workloadId] = { attempted: 0, passed: 0, failed: 0 })
    bucket.attempted += 1
    if (attempt.outcome === 'passed') {
      bucket.passed += 1
      passedAttempts += 1
    }
    else {
      bucket.failed += 1
      failedAttempts += 1
      failedPostconditions += attempt.failedPostconditionIds.length
    }
  }

  return {
    attemptedAttempts: attempts.length,
    passedAttempts,
    failedAttempts,
    failedPostconditions,
    byWorkload,
  }
}

/**
 * Whether one workload's measured evidence is clean.
 *
 * Clean requires all three: the full configured denominator was attempted, no
 * attempt failed, and no run finding of any kind was recorded against the
 * workload. This replaces the hardcoded `correctnessClean: true` both v1
 * runners emitted.
 *
 * The finding count is deliberately kind-agnostic. A warmup that failed to
 * execute produced no measured attempt at all, so the attempt rows alone would
 * report the workload clean; counting every finding attributed to it is what
 * keeps discarded-but-broken work from being invisible here.
 */
export function workloadCorrectnessClean(
  attempts: readonly SampleAttemptRecord[],
  workloadId: string,
  configuredSampleCount: number,
  workloadFindingCount: number,
): boolean {
  const own = attemptsForWorkload(attempts, workloadId)
  const ordinals = new Set(own.map(attempt => attempt.ordinal))
  const complete = ordinals.size === configuredSampleCount
    && [...ordinals].every(ordinal => ordinal < configuredSampleCount)
  return complete && own.every(attempt => attempt.outcome === 'passed') && workloadFindingCount === 0
}
