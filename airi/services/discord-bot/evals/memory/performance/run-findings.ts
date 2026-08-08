import * as v from 'valibot'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION } from './contracts'

/**
 * Content-free run findings for the IMP-803 performance-v2 benchmark.
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
export const RUN_FINDING_IDS = Object.freeze([
  /** A runtime-family workload's scenario runtime failed to close. */
  'runtime-close-failed',
  /** A controller-family workload's active memory runtime failed to close. */
  'active-runtime-close-failed',
  /** The shared evaluation run root failed to dispose. */
  'evaluation-run-dispose-failed',
] as const)
export type RunFindingId = typeof RUN_FINDING_IDS[number]

const workloadIdPattern = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{2,62}$/, 'workload id must be kebab-case lowercase'))

/** One strict, content-free cleanup finding. */
export const runFindingRecordSchema = v.strictObject({
  schemaVersion: v.literal(PERFORMANCE_SCHEMA_VERSION),
  contractId: v.literal(PERFORMANCE_CONTRACT_ID),
  contractDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  kind: v.literal('cleanup-failure'),
  /** The workload the failure is attributed to, or `null` when the failure is run-scoped. */
  workloadId: v.union([workloadIdPattern, v.null()]),
  findingId: v.picklist(RUN_FINDING_IDS),
})

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
export function cleanupFinding(contractDigest: string, workloadId: string | null, findingId: RunFindingId): RunFindingRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest,
    kind: 'cleanup-failure',
    workloadId,
    findingId,
  }
}

/** Cleanup findings attributed to one workload; run-scoped findings are excluded. */
export function findingsForWorkload(findings: readonly RunFindingRecord[], workloadId: string): readonly RunFindingRecord[] {
  return Object.freeze(findings.filter(finding => finding.workloadId === workloadId))
}
