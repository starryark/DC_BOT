import type { VoiceSampleDiagnosticId } from './contracts'

import * as v from 'valibot'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION, VOICE_SAMPLE_DIAGNOSTIC_IDS } from './contracts'

/**
 * Content-free run findings for the IMP-803 performance-v2 benchmark.
 *
 * A finding is how the run publishes something that went wrong *outside* the
 * measured attempt rows. Two kinds exist, and neither may ever become a
 * synthetic attempt: `attempts.jsonl` is the measured denominator, and a row
 * added there would make `attempted` disagree with the configured sample count.
 *
 * v1 let a cleanup failure force the whole run to `failed` inside
 * `buildPerformanceReport()`, but published nothing a verifier could read it
 * back from: `recomputeSummary()` had no artifact carrying cleanup state, so
 * "the disposition is recomputable from artifacts" was false whenever a cleanup
 * failed. This record closes that gap.
 *
 * Only a stable finding id is published, never the underlying exception text.
 * Raw diagnostics still go to local stderr for the operator; an artifact that
 * carried them could leak a filesystem path or a durable identifier.
 */

/** The closed set of cleanup failures a run may report. */
export const CLEANUP_FINDING_IDS = Object.freeze([
  /** A runtime-family workload's scenario runtime failed to close. */
  'runtime-close-failed',
  /** A controller-family workload's active memory runtime failed to close. */
  'active-runtime-close-failed',
  /** The shared evaluation run root failed to dispose. */
  'evaluation-run-dispose-failed',
] as const)
export type CleanupFindingId = typeof CLEANUP_FINDING_IDS[number]

const workloadIdPattern = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{2,62}$/, 'workload id must be kebab-case lowercase'))

const findingIdentity = {
  schemaVersion: v.literal(PERFORMANCE_SCHEMA_VERSION),
  contractId: v.literal(PERFORMANCE_CONTRACT_ID),
  contractDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
} as const

/**
 * One strict, content-free run finding.
 *
 * Discriminated on `kind` so the two shapes cannot blur: a cleanup failure may
 * be run-scoped and carries a cleanup id, while a warmup failure is always
 * attributed to the workload whose warmup it was and carries the ordinal of
 * that warmup instead.
 */
export const runFindingRecordSchema = v.variant('kind', [
  v.strictObject({
    ...findingIdentity,
    kind: v.literal('cleanup-failure'),
    /** The workload the failure is attributed to, or `null` when the failure is run-scoped. */
    workloadId: v.union([workloadIdPattern, v.null()]),
    findingId: v.picklist(CLEANUP_FINDING_IDS),
  }),
  v.strictObject({
    ...findingIdentity,
    kind: v.literal('warmup-failure'),
    /** Warmups always belong to a workload, so this side of the union is never run-scoped. */
    workloadId: workloadIdPattern,
    /** Zero-based index within the workload's warmup section; measured ordinals are a separate space. */
    warmupOrdinal: v.pipe(v.number(), v.integer(), v.minValue(0)),
    /**
     * Why the warmup failed, from the same closed vocabulary the measured
     * attempts use. Absent for runners that have no diagnostic vocabulary yet:
     * the finding itself is the evidence, and the classification is additive.
     */
    diagnosticIds: v.optional(v.pipe(v.array(v.picklist(VOICE_SAMPLE_DIAGNOSTIC_IDS)), v.minLength(1))),
  }),
])

export type RunFindingRecord = v.InferOutput<typeof runFindingRecordSchema>

/** Parse one serialized finding row; throws on any schema violation. */
export function parseRunFinding(input: unknown): RunFindingRecord {
  return v.parse(runFindingRecordSchema, input)
}

/** Parse a whole `run-findings.jsonl` body, ignoring blank lines. */
export function parseRunFindingsJsonl(jsonl: string): RunFindingRecord[] {
  const findings: RunFindingRecord[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0)
      continue
    findings.push(parseRunFinding(JSON.parse(line)))
  }
  return findings
}

/** Serialize findings to the published JSONL body; an empty set writes an empty file. */
export function runFindingsJsonl(findings: readonly RunFindingRecord[]): string {
  return findings.length === 0 ? '' : `${findings.map(finding => JSON.stringify(finding)).join('\n')}\n`
}

/** Build one cleanup finding against the current contract digest. */
export function cleanupFinding(contractDigest: string, workloadId: string | null, findingId: CleanupFindingId): RunFindingRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest,
    kind: 'cleanup-failure',
    workloadId,
    findingId,
  }
}

/**
 * Build one warmup execution finding against the current contract digest.
 *
 * A warmup that fails is discarded work, so it contributes no attempt row and
 * no latency observation. It is still a fact about the run: the previously
 * observed failure existed only on stdout, which meant a run could publish a
 * complete, clean-looking artifact set while its first turns had not worked.
 * The diagnostics are canonically sorted so the same failure serializes
 * identically across runs.
 */
export function warmupFinding(contractDigest: string, workloadId: string, warmupOrdinal: number, diagnosticIds: readonly VoiceSampleDiagnosticId[] = []): RunFindingRecord {
  const canonical = [...new Set(diagnosticIds)].sort()
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest,
    kind: 'warmup-failure',
    workloadId,
    warmupOrdinal,
    ...(canonical.length > 0 ? { diagnosticIds: canonical } : {}),
  }
}

/** Findings of any kind attributed to one workload; run-scoped findings are excluded. */
export function findingsForWorkload(findings: readonly RunFindingRecord[], workloadId: string): readonly RunFindingRecord[] {
  return Object.freeze(findings.filter(finding => finding.workloadId === workloadId))
}
