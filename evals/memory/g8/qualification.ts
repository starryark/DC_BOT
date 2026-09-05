import type { Dataset, ScenarioResult, ThresholdDocument } from '../contracts'
import type { LoadedRun } from '../performance/baseline'
import type { CostEvidence } from '../performance/cost-evidence'
import type { PriceDocument } from '../performance/price-contract'
import type { PerformanceThresholdDocument } from '../performance/threshold-contract'
import type { EvaluationSummary } from '../report'
import type { RetrievalBenchmarkPacket } from '../retrieval/qualification'

import { latestSchemaVersion } from '@proj-airi/memory-sqlite'

import * as v from 'valibot'

import { verifySoakReport } from '../../../src/memory/active-soak'
import { canonicalJson, parseThresholdDocument, sha256Canonical } from '../contracts'
import { ACTIVE_V1_VERSION, MULTILINGUAL_V1_VERSION } from '../dataset'
import { compareAgainstBaseline, loadRun } from '../performance/baseline'
import { parseCostEvidence, recomputeCostEvidence } from '../performance/cost-evidence'
import { liveArtifactDigest } from '../performance/live-artifact'
import { parsePriceDocument, priceDocumentDigest, priceEffectiveFailure } from '../performance/price-contract'
import { deriveRunState } from '../performance/report'
import {
  parsePerformanceThresholdDocument,
  performanceThresholdDocumentDigest,
  validatePerformanceThresholdCompatibility,
} from '../performance/threshold-contract'
import { WORKLOAD_CATALOG_DIGEST, workloadsForSuite } from '../performance/workloads'
import { computeNormalizedResultDigest, runIsValidForGate } from '../report'
import { parseRetrievalPolicy } from '../retrieval/policy'
import {
  datasetForArtifact,
  parseEvaluationSummaryArtifact,
  parseIndependentRetrievalDecision,
  parseScenarioResultsJsonl,
  QualificationEvidenceError,
  qualifyRetrieval,
  sha256Bytes,
  verifyRetrievalBenchmarkPacket,
} from '../retrieval/qualification'
import { evaluateMeasurements } from '../thresholds'

/**
 * Aggregate G8 release qualification (artifact 21 §11.2).
 *
 * This module decides whether evidence *exists* for G8 at one exact candidate
 * commit. It never creates evidence and never recomputes a domain measurement:
 * every family delegates to the validator or qualifier that owns it —
 * {@link parseEvaluationSummaryArtifact} / {@link computeNormalizedResultDigest}
 * / {@link runIsValidForGate} for evaluator runs, {@link qualifyRetrieval} for
 * retrieval governance, {@link loadRun} / {@link deriveRunState} /
 * {@link compareAgainstBaseline} for performance-v2, and
 * {@link verifySoakReport} for the operations and rollback drills. Its own
 * contribution is binding all of that to one candidate and enumerating every
 * blocker, so a missing approval is never read as a pass.
 *
 * A threshold or price document does not satisfy an approval requirement by
 * parsing: the document's own provenance fields are free text (the one recorded
 * latency threshold declares itself provisional there), so an approval exists
 * for G8 only when a supplied signoff record explicitly covers the document's
 * digest. Schema validity of a signoff likewise does not establish that its
 * signer was authorized; no repository contract provides that rule, and this
 * module does not invent one.
 *
 * G8 qualification PASS authorizes nothing. It does not trigger IMP-807 staged
 * rollout, does not qualify a live transport, and is not a deployment decision.
 */

/** Artifact 21 §11.2 G8 condition 5, plus the security reviewer the G7 gate decision (IEV-G7-002) carries into it. */
const REQUIRED_SIGNOFF_ROLES = Object.freeze(['privacy-lead', 'lifecycle-lead', 'security-reviewer'] as const)
export type G8RequiredSignoffRole = typeof REQUIRED_SIGNOFF_ROLES[number]

/** Roles a signoff record may claim; a closed vocabulary so a typo cannot silently satisfy a required role. */
export const G8_SIGNOFF_ROLES = Object.freeze(['gate-owner', ...REQUIRED_SIGNOFF_ROLES] as const)

const hex40 = v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))
const hex64 = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))

/**
 * A content-free record of one external human decision about the candidate.
 *
 * It records that a decision exists and what it covers; it cannot manufacture
 * the decision. `covers` binds approval to specific threshold/price document
 * digests, so a provisional document that nobody has approved stays
 * unapproved no matter how well it parses. Whether the signer was authorized
 * for the role they claim is procedural and stays outside this schema.
 */
export const g8SignoffRecordSchema = v.strictObject({
  format: v.literal(1),
  role: v.picklist(G8_SIGNOFF_ROLES),
  decision: v.picklist(['approve', 'reject']),
  candidateCommit: hex40,
  decidedAt: v.pipe(v.string(), v.isoTimestamp()),
  /** Reference to the external decision record; content-free. */
  source: v.pipe(v.string(), v.minLength(1), v.maxLength(280)),
  covers: v.optional(v.strictObject({
    thresholdDocuments: v.pipe(v.array(hex64), v.maxLength(64)),
    priceDocuments: v.pipe(v.array(hex64), v.maxLength(64)),
  })),
  /** Assertion of artifact 21 §11.2 condition 4 by whoever asserts it. */
  gateReadiness: v.optional(v.strictObject({
    openQuestionsResolved: v.boolean(),
    highRisksOwned: v.boolean(),
  })),
})

export type G8SignoffRecord = v.InferOutput<typeof g8SignoffRecordSchema>

/** Parse one signoff record; structural validity only, per the schema contract above. */
export function parseG8SignoffRecord(input: unknown): G8SignoffRecord {
  return v.parse(g8SignoffRecordSchema, input)
}

/** The three published files of one `memory:evaluate` run, as text, exactly as read from disk. */
export interface G8EvaluationRunFiles {
  readonly summaryJson: string
  readonly scenarioResultsJsonl: string
  readonly reportText: string
}

/** The five loadable files of one performance-v2 run directory, as text. */
export interface G8PerformanceRunFiles {
  readonly runManifestJson: string
  readonly attemptsJsonl: string
  readonly runFindingsJsonl: string
  readonly measurementsJsonl: string
  readonly summaryJson: string
}

export interface G8EvaluationFamilyInput {
  readonly runA?: G8EvaluationRunFiles
  readonly runB?: G8EvaluationRunFiles
  /** The eval-side threshold document the runs were produced with, when they were. */
  readonly thresholds?: unknown
}

export interface G8MultilingualFamilyInput extends G8EvaluationFamilyInput {
  readonly policy?: unknown
  readonly decision?: unknown
}

export interface G8PerformanceFamilyInput {
  readonly runA?: G8PerformanceRunFiles
  readonly runB?: G8PerformanceRunFiles
  readonly thresholds?: unknown
}

export interface G8QualificationInput {
  /** The exact candidate commit every commit-bound input must name. */
  readonly candidateCommit: string
  readonly functional?: G8EvaluationFamilyInput
  readonly multilingual?: G8MultilingualFamilyInput
  readonly performance?: G8PerformanceFamilyInput
  readonly priceDocument?: unknown
  readonly soakReport?: unknown
  readonly signoffs?: readonly unknown[]
}

export type G8ConditionId
  = | 'functional'
    | 'multilingual'
    | 'performance'
    | 'cost'
    | 'drills'
    | 'signoffs'
    | 'gate-readiness'

export interface G8ConditionResult {
  readonly id: G8ConditionId
  readonly status: 'pass' | 'blocked'
  /** Stable, content-free blocker codes; sorted and deduplicated. */
  readonly blockers: readonly string[]
  /** Deterministic, content-free supporting facts (counts, digests, identities). */
  readonly details?: Readonly<Record<string, unknown>>
}

export interface G8QualificationResult {
  readonly format: 1
  readonly gate: 'g8'
  /** `pass` means every artifact 21 §11.2 condition has qualifying evidence; it authorizes nothing. */
  readonly status: 'pass' | 'blocked'
  readonly candidateCommit: string
  readonly conditions: readonly G8ConditionResult[]
  /** Union of every condition's blockers, sorted and deduplicated. */
  readonly blockers: readonly string[]
  readonly evidence: Readonly<Record<string, unknown>>
}

interface ConditionDraft {
  readonly id: G8ConditionId
  blockers: string[]
  details: Record<string, unknown>
}

/** Code-point string order; machine output must not depend on the host's collation locale. */
function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/** Total order over one published signoff entry, so equal keys mean interchangeable entries. */
function signoffSortKey(entry: { readonly role: string, readonly decision: string, readonly source: string }): string {
  return `${entry.role} ${entry.decision} ${entry.source}`
}

function finish(draft: ConditionDraft): G8ConditionResult {
  const blockers = [...new Set(draft.blockers)].sort()
  draft.details = Object.fromEntries(Object.entries(draft.details).sort(([left], [right]) => compareStrings(left, right)))
  return blockers.length === 0
    ? { id: draft.id, status: 'pass', blockers: [], details: draft.details }
    : { id: draft.id, status: 'blocked', blockers }
}

function faultReason(error: unknown): string {
  if (error instanceof QualificationEvidenceError)
    return error.reason
  if (error instanceof Error && error.name === 'ValiError')
    return 'schema_validation_failed'
  return 'unreadable_evidence'
}

/** SHA-256 of the exact text supplied for one artifact, so evidence output names the bytes consumed. */
function digestOf(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text))
}

/** Parsed approvals the family checkers bind threshold and price documents to. */
interface Approvals {
  readonly candidateCommit: string
  readonly records: readonly G8SignoffRecord[]
  readonly invalidCount: number
  readonly coveredThresholds: ReadonlySet<string>
  readonly coveredPrices: ReadonlySet<string>
}

function parseApprovals(signoffs: readonly unknown[], candidateCommit: string): Approvals {
  const records: G8SignoffRecord[] = []
  let invalidCount = 0
  for (const entry of signoffs) {
    try {
      records.push(parseG8SignoffRecord(entry))
    }
    catch {
      invalidCount += 1
    }
  }
  const atCandidate = records.filter(record => record.candidateCommit === candidateCommit && record.decision === 'approve')
  const coveredThresholds = new Set(atCandidate.flatMap(record => record.covers?.thresholdDocuments ?? []))
  const coveredPrices = new Set(atCandidate.flatMap(record => record.covers?.priceDocuments ?? []))
  return { candidateCommit, records, invalidCount, coveredThresholds, coveredPrices }
}

/** One evaluator run after every qualification-critical fact has been recomputed from its own rows. */
interface VerifiedEvaluationRun {
  readonly side: 'a' | 'b'
  readonly summary: EvaluationSummary
  readonly scenarioResults: readonly ScenarioResult[]
  readonly artifactDigests: { readonly summary: string, readonly scenarioResults: string, readonly report: string }
}

/**
 * Verify one `memory:evaluate` run the way the retrieval verifier verifies a
 * retrieval run: parse through the published schema, resolve the frozen dataset
 * by version and digest, then recompute the normalized result digest from the
 * per-scenario rows so a summary edited to look healthy fails on its own bytes.
 */
function verifyEvaluationRun(files: G8EvaluationRunFiles, side: 'a' | 'b'): VerifiedEvaluationRun | { readonly fault: string } {
  let summary: EvaluationSummary
  try {
    summary = parseEvaluationSummaryArtifact(JSON.parse(files.summaryJson))
  }
  catch (error) {
    return { fault: error instanceof SyntaxError ? 'summary_not_json' : `summary_invalid:${faultReason(error)}` }
  }

  let dataset: Dataset
  try {
    dataset = datasetForArtifact(summary)
  }
  catch (error) {
    return { fault: `dataset_invalid:${faultReason(error)}` }
  }

  let rows: readonly ScenarioResult[]
  try {
    rows = parseScenarioResultsJsonl(files.scenarioResultsJsonl)
  }
  catch (error) {
    return { fault: `scenario_results_invalid:${faultReason(error)}` }
  }

  if (rows.length !== summary.counts.total)
    return { fault: 'scenario_result_count_mismatch' }
  for (const row of rows) {
    if (row.datasetVersion !== summary.datasetVersion)
      return { fault: 'scenario_result_dataset_mismatch' }
    if (row.seed !== summary.seed)
      return { fault: 'scenario_result_seed_mismatch' }
  }

  const recomputed = computeNormalizedResultDigest(dataset, rows, { datasetDigest: summary.datasetDigest, seed: summary.seed })
  if (recomputed !== summary.normalizedResultDigest)
    return { fault: 'normalized_result_digest_mismatch' }

  return {
    side,
    summary,
    scenarioResults: rows,
    artifactDigests: {
      summary: digestOf(files.summaryJson),
      scenarioResults: digestOf(files.scenarioResultsJsonl),
      report: digestOf(files.reportText),
    },
  }
}

/** Recompute the threshold summary and row-level evaluated flags from published measurements. */
function recomputeEvaluationState(run: VerifiedEvaluationRun, thresholds: ThresholdDocument): {
  readonly summary: EvaluationSummary['measurementEvaluations']
  readonly measurementStatus: EvaluationSummary['measurementStatus']
  readonly rowFlagsMatch: boolean
} {
  const measurements = run.scenarioResults.flatMap(result => result.measurements)
  const evaluations = evaluateMeasurements(measurements, thresholds)
  let passed = 0
  let failed = 0
  let measuredNotEvaluated = 0
  const failedMetricIds: string[] = []
  let rowFlagsMatch = true

  for (const [index, evaluation] of evaluations.entries()) {
    if (evaluation.status === 'passed') {
      passed += 1
    }
    else if (evaluation.status === 'failed') {
      failed += 1
      failedMetricIds.push(evaluation.name)
    }
    else {
      measuredNotEvaluated += 1
    }
    if (measurements[index]!.evaluated !== (evaluation.status !== 'measured_not_evaluated'))
      rowFlagsMatch = false
  }

  failedMetricIds.sort()
  const fullyEvaluated = evaluations.length > 0 && measuredNotEvaluated === 0
  return {
    summary: { total: evaluations.length, passed, failed, measuredNotEvaluated, failedMetricIds },
    measurementStatus: fullyEvaluated ? 'evaluated' : 'measured_not_evaluated',
    rowFlagsMatch,
  }
}

/** Eval-side threshold approval: provenance must bind to the runs and a signoff must cover the document digest. */
function checkEvalThresholdBinding(
  draft: ConditionDraft,
  prefix: string,
  thresholds: unknown | undefined,
  runs: readonly VerifiedEvaluationRun[],
  candidateCommit: string,
  approvals: Approvals,
): void {
  if (thresholds === undefined)
    return
  let document: ThresholdDocument
  try {
    const first = runs[0]?.summary
    if (!first)
      return
    document = parseThresholdDocument(thresholds, {
      datasetVersion: first.datasetVersion,
      datasetDigest: first.datasetDigest,
      evaluatorSchemaVersion: first.evaluatorSchemaVersion,
    })
  }
  catch (error) {
    draft.blockers.push(`${prefix}_threshold_document_invalid:${faultReason(error)}`)
    return
  }

  if (document.repositoryCommit !== candidateCommit)
    draft.blockers.push(`${prefix}_threshold_stale`)

  // The runs publish the provenance they were produced with; a document that
  // does not match it graded some other run, not this one.
  const expected = { approver: document.approver, approvedAt: document.approvedAt, repositoryCommit: document.repositoryCommit }
  for (const run of runs) {
    if (run.summary.thresholdProvenance == null || canonicalJson(run.summary.thresholdProvenance) !== canonicalJson(expected)) {
      draft.blockers.push(`${prefix}_threshold_run_unbound`)
      break
    }
  }

  // Recompute the complete threshold result from each run's published rows.
  // Summary-only checks could otherwise be bypassed by claiming `evaluated`,
  // and one matched metric could conceal uncovered measurements.
  for (const run of runs) {
    const recomputed = recomputeEvaluationState(run, document)
    if (!recomputed.rowFlagsMatch
      || canonicalJson(recomputed.summary) !== canonicalJson(run.summary.measurementEvaluations)
      || recomputed.measurementStatus !== run.summary.measurementStatus
      || run.summary.approval.thresholdsApproved !== (recomputed.measurementStatus === 'evaluated')) {
      draft.blockers.push(`${prefix}_run_${run.side}_invalid:measurement_evaluation_mismatch`)
    }
    if (recomputed.measurementStatus !== 'evaluated')
      draft.blockers.push(`${prefix}_thresholds_not_evaluated`)
    if (recomputed.summary.failed > 0)
      draft.blockers.push(`${prefix}_threshold_measurement_failed`)
  }

  if (!approvals.coveredThresholds.has(sha256Canonical(document)))
    draft.blockers.push(`${prefix}_threshold_not_approved`)
}

/** Both artifact 21 §11.2 report-family conditions for evaluator runs share this shape. */
function checkEvaluationFamily(params: {
  readonly id: 'functional' | 'multilingual'
  readonly prefix: string
  readonly input: G8EvaluationFamilyInput | undefined
  readonly expectedDatasetVersion: string
  readonly candidateCommit: string
  readonly approvals: Approvals
  readonly retrieval?: { readonly policy?: unknown, readonly decision?: unknown }
}): G8ConditionResult {
  const { id, prefix, input, expectedDatasetVersion, candidateCommit, approvals } = params
  const draft: ConditionDraft = { id, blockers: [], details: {} }

  if (!input?.runA || !input.runB) {
    draft.blockers.push(`${prefix}_missing`)
    return finish(draft)
  }

  // Two artifact sets with the same bytes are one run offered twice, and a run
  // compared against itself is reproducible by construction. Distinct runs
  // always differ in at least their generation timestamp, so this refuses a
  // duplicated directory without asserting anything about what else may differ.
  if (canonicalJson(input.runA) === canonicalJson(input.runB))
    draft.blockers.push(`${prefix}_pair_duplicate_run`)

  const verifiedRuns: VerifiedEvaluationRun[] = []
  for (const [side, files] of [['a', input.runA], ['b', input.runB]] as const) {
    const verified = verifyEvaluationRun(files, side)
    if ('fault' in verified) {
      draft.blockers.push(`${prefix}_run_${side}_invalid:${verified.fault}`)
      continue
    }
    if (verified.summary.datasetVersion !== expectedDatasetVersion)
      draft.blockers.push(`${prefix}_run_${side}_wrong_dataset`)
    if (verified.summary.commitSha !== candidateCommit)
      draft.blockers.push(`${prefix}_run_${side}_stale_candidate`)
    if (verified.summary.dirtyWorktree)
      draft.blockers.push(`${prefix}_run_${side}_dirty_worktree`)
    if (!runIsValidForGate(verified.summary))
      draft.blockers.push(`${prefix}_run_${side}_not_valid_for_gate`)
    verifiedRuns.push(verified)
    draft.details[`run${side.toUpperCase()}`] = {
      artifactSha256: verified.artifactDigests,
      datasetVersion: verified.summary.datasetVersion,
      datasetDigest: verified.summary.datasetDigest,
      seed: verified.summary.seed,
      evaluatorSchemaVersion: verified.summary.evaluatorSchemaVersion,
      normalizedResultDigest: verified.summary.normalizedResultDigest,
      measurementStatus: verified.summary.measurementStatus,
    }
  }

  if (verifiedRuns.length === 2) {
    const [a, b] = verifiedRuns
    for (const field of ['datasetVersion', 'datasetDigest', 'seed', 'evaluatorSchemaVersion', 'normalizedResultDigest'] as const) {
      if (a.summary[field] !== b.summary[field])
        draft.blockers.push(`${prefix}_not_reproducible:${field}`)
    }
  }

  // Phase C: measured_not_evaluated stays non-qualifying. The evaluator itself
  // decides this field; only runs produced against an approved threshold
  // document can carry 'evaluated', and zero measurements also stay unevaluated.
  if (verifiedRuns.length > 0 && verifiedRuns.some(run => run.summary.measurementStatus !== 'evaluated' || run.summary.measurementEvaluations.measuredNotEvaluated > 0))
    draft.blockers.push(`${prefix}_thresholds_not_evaluated`)
  if (verifiedRuns.some(run => run.summary.measurementEvaluations.failed > 0))
    draft.blockers.push(`${prefix}_threshold_measurement_failed`)

  if (verifiedRuns.length > 0 && verifiedRuns.every(run => run.summary.measurementStatus === 'evaluated') && input.thresholds === undefined)
    draft.blockers.push(`${prefix}_threshold_document_missing`)
  checkEvalThresholdBinding(draft, prefix, input.thresholds, verifiedRuns, candidateCommit, approvals)

  if (params.retrieval) {
    checkRetrievalGovernance(draft, prefix, input, params.retrieval)
  }

  return finish(draft)
}

/**
 * Retrieval governance for the multilingual family, delegated whole to the
 * existing qualifier. Its `accepted` verdict is the only qualifying outcome;
 * `measured_not_evaluated` and `rejected` both block G8, and its evidence
 * faults become blockers rather than aborting the aggregate.
 */
function checkRetrievalGovernance(
  draft: ConditionDraft,
  prefix: string,
  input: G8EvaluationFamilyInput,
  retrieval: { readonly policy?: unknown, readonly decision?: unknown },
): void {
  const encoder = new TextEncoder()
  const packetOf = (files: G8EvaluationRunFiles): RetrievalBenchmarkPacket => ({
    summary: parseEvaluationSummaryArtifact(JSON.parse(files.summaryJson)),
    scenarioResults: parseScenarioResultsJsonl(files.scenarioResultsJsonl),
    rawArtifactHashes: {
      summarySha256: sha256Bytes(encoder.encode(files.summaryJson)),
      scenarioResultsSha256: sha256Bytes(encoder.encode(files.scenarioResultsJsonl)),
      reportSha256: sha256Bytes(encoder.encode(files.reportText)),
    },
  })

  let runA: ReturnType<typeof verifyRetrievalBenchmarkPacket>
  try {
    runA = verifyRetrievalBenchmarkPacket(packetOf(input.runA!))
  }
  catch (error) {
    draft.blockers.push(`retrieval_evidence_invalid:${faultReason(error)}`)
    return
  }

  let policy: ReturnType<typeof parseRetrievalPolicy> | undefined
  if (retrieval.policy !== undefined) {
    try {
      policy = parseRetrievalPolicy(retrieval.policy, {
        repositoryCommit: runA.identity.candidateCommit,
        datasetVersion: runA.identity.datasetVersion,
        datasetDigest: runA.identity.datasetDigest,
        evaluatorSchemaVersion: runA.identity.evaluatorSchemaVersion,
        analyzerConfigIdentity: runA.identity.analyzerConfigIdentity,
        requestedModes: runA.identity.requestedModes,
      })
      draft.details.retrievalPolicyDigest = policy.policyDigest
    }
    catch (error) {
      draft.blockers.push(`retrieval_policy_invalid:${faultReason(error)}`)
    }
  }

  let decision: ReturnType<typeof parseIndependentRetrievalDecision> | undefined
  if (retrieval.decision !== undefined) {
    try {
      decision = parseIndependentRetrievalDecision(retrieval.decision)
    }
    catch (error) {
      draft.blockers.push(`retrieval_decision_invalid:${faultReason(error)}`)
    }
  }

  try {
    const verdict = qualifyRetrieval({ runA: packetOf(input.runA!), runB: packetOf(input.runB!), policy, decision })
    draft.details.retrievalStatus = verdict.status
    draft.details.retrievalReasons = [...verdict.reasons].sort()
    if (verdict.status !== 'accepted') {
      draft.blockers.push(verdict.status === 'rejected' ? 'retrieval_rejected' : 'retrieval_measured_not_evaluated')
    }
  }
  catch (error) {
    draft.blockers.push(`retrieval_evidence_invalid:${faultReason(error)}`)
  }
}

function loadPerformanceRun(files: G8PerformanceRunFiles): LoadedRun {
  const directory = 'g8-run'
  // Keys are the joined paths loadRun probes for, so the in-memory run is
  // indistinguishable from a directory on disk to the unmodified loader.
  const entries = new Map<string, string>([
    [`${directory}/run-manifest.json`, files.runManifestJson],
    [`${directory}/attempts.jsonl`, files.attemptsJsonl],
    [`${directory}/run-findings.jsonl`, files.runFindingsJsonl],
    [`${directory}/measurements.jsonl`, files.measurementsJsonl],
    [`${directory}/summary.json`, files.summaryJson],
  ])
  return loadRun(
    directory,
    path => entries.get(path) as string,
    // loadRun also probes the directory itself before its artifacts.
    path => path === directory || entries.has(path),
    (dir, name) => `${dir}/${name}`,
  )
}

/**
 * The runbook's same-seed reproducibility definition, applied to a pair:
 * contract digest, effective plan, environment, attempt ordinals and outcomes,
 * failed postconditions, sample completeness, and disposition must be identical.
 * Latency values are deliberately absent — they are environment-bound.
 */
function correctnessProjection(run: LoadedRun): string {
  const rows = [...run.attempts]
    .map(attempt => ({ workloadId: attempt.workloadId, ordinal: attempt.ordinal, outcome: attempt.outcome, ...(attempt.outcome === 'failed' ? { failedPostconditionIds: attempt.failedPostconditionIds } : {}) }))
    .sort((left, right) => `${left.workloadId}#${left.ordinal}`.localeCompare(`${right.workloadId}#${right.ordinal}`))
  return canonicalJson(rows)
}

function checkPerformanceFamily(
  input: G8PerformanceFamilyInput | undefined,
  candidateCommit: string,
  approvals: Approvals,
): G8ConditionResult {
  const draft: ConditionDraft = { id: 'performance', blockers: [], details: {} }

  if (input === undefined) {
    draft.blockers.push('performance_missing', 'performance_threshold_missing')
    return finish(draft)
  }

  const runsSupplied = input.runA !== undefined && input.runB !== undefined
  if (!runsSupplied)
    draft.blockers.push('performance_missing')
  // As for the evaluator families: identical bytes are one run, and its
  // timings, `startedAt`, and `completedAt` all differ between real repetitions.
  else if (canonicalJson(input.runA) === canonicalJson(input.runB))
    draft.blockers.push('performance_pair_duplicate_run')

  const loadedRuns: LoadedRun[] = []
  if (runsSupplied) {
    for (const [side, files] of [['a', input.runA], ['b', input.runB]] as const) {
      let run: LoadedRun
      try {
        run = loadPerformanceRun(files!)
      }
      catch {
        // loadRun rejects a directory whose published summary disagrees with its
        // own rows; a fixed code keeps machine output stable across valibot's
        // issue strings.
        draft.blockers.push(`performance_run_${side}_invalid:run_not_recomputable`)
        continue
      }
      if (run.manifest.commitSha !== candidateCommit)
        draft.blockers.push(`performance_run_${side}_stale_candidate`)
      if (run.manifest.dirtyWorktree)
        draft.blockers.push(`performance_run_${side}_dirty_worktree`)
      if (run.manifest.suite !== 'performance-v2')
        draft.blockers.push(`performance_run_${side}_suite_mismatch`)

      const derived = deriveRunState(run.manifest, run.attempts, run.runFindings, run.measurements, [])
      if (derived.disposition === 'failed')
        draft.blockers.push(`performance_run_${side}_failed_disposition`)

      const expected = new Set(workloadsForSuite('performance-v2').map(workload => workload.workloadId))
      const completed = new Set(run.manifest.workloadsCompleted)
      if (expected.size !== completed.size || [...expected].some(id => !completed.has(id)))
        draft.blockers.push(`performance_run_${side}_suite_incomplete`)

      loadedRuns.push(run)
      draft.details[`run${side.toUpperCase()}`] = {
        contractDigest: run.manifest.contractDigest,
        seed: run.manifest.seed,
        suite: run.manifest.suite,
        environment: run.manifest.environment,
        artifactSha256: {
          manifest: digestOf(files!.runManifestJson),
          attempts: digestOf(files!.attemptsJsonl),
          measurements: digestOf(files!.measurementsJsonl),
        },
        disposition: derived.disposition,
        measuredNotEvaluated: run.measurements.filter(record => record.thresholdEvaluation === 'not_evaluated').length,
      }
    }
  }

  if (loadedRuns.length === 2) {
    const [a, b] = loadedRuns
    // Whether two runs are comparable at all is the benchmark's own question,
    // answered by its own comparator: contract identity, effective plan and
    // sample capacity, environment, and — the part a hand-written pair check
    // silently omitted — measurement coverage in both directions. A metric
    // present in only one run is an incompatibility, never a skipped
    // comparison, so a run that dropped a workload's latency row cannot pair
    // with a complete one.
    for (const reason of compareAgainstBaseline(a, b).reasons ?? []) {
      // Its per-run eligibility reasons are side-labelled `baseline-`/
      // `candidate-` by argument position, so emitting them would make the
      // blocker set depend on which run was supplied first. Every condition
      // they name already blocks as `performance_run_<side>_failed_disposition`.
      if (reason.startsWith('baseline-') || reason.startsWith('candidate-'))
        continue
      draft.blockers.push(`performance_pair_incompatible:${reason}`)
    }
    // Same-seed reproducibility asks more than comparability. A baseline
    // comparison spans commits, so it deliberately neither requires an
    // identical seed nor compares attempt patterns; the runbook's repetition
    // rule requires both.
    if (a.manifest.seed !== b.manifest.seed)
      draft.blockers.push('performance_not_reproducible:seed')
    if (correctnessProjection(a) !== correctnessProjection(b))
      draft.blockers.push('performance_not_reproducible:correctness-pattern')
  }

  // Threshold approval: the document must parse, be compatible with the current
  // contract, be the document the runs actually applied, and be covered by a
  // signoff. The one recorded latency threshold fails only the last of those.
  let thresholdDocument: PerformanceThresholdDocument | undefined
  if (input.thresholds === undefined) {
    draft.blockers.push('performance_threshold_missing')
  }
  else {
    try {
      thresholdDocument = parsePerformanceThresholdDocument(input.thresholds)
    }
    catch {
      draft.blockers.push('performance_threshold_document_invalid')
    }
    if (thresholdDocument) {
      const compatibility = validatePerformanceThresholdCompatibility(thresholdDocument, WORKLOAD_CATALOG_DIGEST, workloadsForSuite('performance-v2'))
      if (compatibility.length > 0)
        draft.blockers.push('performance_threshold_incompatible')
      const digest = performanceThresholdDocumentDigest(thresholdDocument)
      draft.details.thresholdDocumentDigest = digest
      for (const run of loadedRuns) {
        if (run.manifest.thresholdDocumentDigest !== digest) {
          draft.blockers.push('performance_threshold_unbound')
          break
        }
      }
      if (!approvals.coveredThresholds.has(digest))
        draft.blockers.push('performance_threshold_not_approved')
    }
  }

  // Phase C: metrics the run left `not_evaluated` stay non-qualifying for G8.
  for (const run of loadedRuns) {
    if (run.measurements.some(record => record.thresholdEvaluation === 'not_evaluated')) {
      draft.blockers.push('performance_metric_measured_not_evaluated')
      break
    }
  }

  return finish(draft)
}

function checkCostCondition(
  priceDocumentInput: unknown | undefined,
  performance: G8PerformanceFamilyInput | undefined,
  approvals: Approvals,
): G8ConditionResult {
  const draft: ConditionDraft = { id: 'cost', blockers: [], details: {} }

  if (priceDocumentInput === undefined) {
    draft.blockers.push('cost_document_missing')
    return finish(draft)
  }

  let document: PriceDocument
  try {
    document = parsePriceDocument(priceDocumentInput)
  }
  catch {
    draft.blockers.push('cost_document_invalid')
    return finish(draft)
  }

  const digest = priceDocumentDigest(document)
  draft.details.priceDocumentDigest = digest
  if (!approvals.coveredPrices.has(digest))
    draft.blockers.push('cost_not_approved')

  if (!performance?.runA || !performance.runB) {
    draft.blockers.push('cost_evidence_missing')
    return finish(draft)
  }

  for (const [side, files] of [['a', performance.runA], ['b', performance.runB]] as const) {
    let manifest: { readonly completedAt?: unknown, readonly priceDocumentDigest?: unknown, readonly importedLiveArtifactDigests?: unknown }
    let summary: { readonly costAvailability?: unknown, readonly costEvidence?: unknown }
    try {
      manifest = JSON.parse(files.runManifestJson)
      summary = JSON.parse(files.summaryJson)
    }
    catch {
      draft.blockers.push('cost_run_unbound')
      continue
    }
    // The price must have been effective when the run completed, and the run
    // must have bound this exact document, so prices for another window or
    // another document cannot stand in.
    const effectiveFailure = typeof manifest.completedAt === 'string' ? priceEffectiveFailure(document, manifest.completedAt) : undefined
    if (effectiveFailure)
      draft.blockers.push('cost_not_effective')
    if (manifest.priceDocumentDigest !== digest)
      draft.blockers.push(`cost_run_${side}_unbound`)

    // `costAvailability` is the run's own assertion, so it is treated as a
    // consistency indicator only: it must agree with whether evidence was
    // published, and the amount is decided below by recomputation.
    const available = summary.costAvailability === 'available'
    if (!available)
      draft.blockers.push('cost_not_calculated')
    if (summary.costEvidence === undefined) {
      if (available)
        draft.blockers.push(`cost_run_${side}_evidence_missing`)
      continue
    }
    if (!available)
      draft.blockers.push(`cost_run_${side}_availability_inconsistent`)

    let evidence: CostEvidence
    try {
      evidence = parseCostEvidence(summary.costEvidence)
    }
    catch {
      draft.blockers.push(`cost_run_${side}_evidence_invalid`)
      continue
    }

    // The embedded artifact must be the one this run imported: its canonical
    // digest is recomputed here rather than read, and it must appear in the
    // manifest's imported set, so evidence cannot name a sample the run never
    // consumed.
    const artifactDigest = liveArtifactDigest(evidence.liveArtifact)
    if (artifactDigest !== evidence.liveArtifactDigest)
      draft.blockers.push(`cost_run_${side}_artifact_digest_mismatch`)
    const importedDigests = Array.isArray(manifest.importedLiveArtifactDigests) ? manifest.importedLiveArtifactDigests : []
    if (!importedDigests.includes(artifactDigest))
      draft.blockers.push(`cost_run_${side}_artifact_unimported`)
    if (evidence.priceDocumentDigest !== digest)
      draft.blockers.push(`cost_run_${side}_price_binding_mismatch`)
    if (evidence.liveArtifact.usage.disposition !== 'complete')
      draft.blockers.push(`cost_run_${side}_usage_not_complete`)

    // The amount is recomputed from the supplied approved document through the
    // pricing authority, then compared with what the run published. A tampered
    // total, dimension, or unit price fails here regardless of the flag.
    const recomputed = recomputeCostEvidence(evidence, document)
    if (recomputed.status === 'absent') {
      draft.blockers.push(`cost_run_${side}_not_recomputable:${recomputed.reason}`)
      continue
    }
    if (recomputed.currency !== evidence.currency)
      draft.blockers.push(`cost_run_${side}_currency_mismatch`)
    if (recomputed.amount !== evidence.amount)
      draft.blockers.push(`cost_run_${side}_amount_mismatch`)
    if (canonicalJson(recomputed.dimensions) !== canonicalJson(evidence.dimensions))
      draft.blockers.push(`cost_run_${side}_dimensions_mismatch`)

    draft.details[`run${side.toUpperCase()}Cost`] = {
      liveArtifactDigest: artifactDigest,
      currency: recomputed.currency,
      amount: recomputed.amount,
      dimensions: recomputed.dimensions.map(entry => ({ dimension: entry.dimension, tokens: entry.tokens, pricePerUnit: entry.pricePerUnit, subtotal: entry.subtotal })),
    }
  }

  return finish(draft)
}

function checkDrillsCondition(soakReport: unknown | undefined, candidateCommit: string): G8ConditionResult {
  const draft: ConditionDraft = { id: 'drills', blockers: [], details: {} }

  if (soakReport === undefined) {
    draft.blockers.push('drill_evidence_missing')
    return finish(draft)
  }

  const reportedCommit = typeof soakReport === 'object' && soakReport !== null && 'commitSha' in soakReport && typeof (soakReport as { commitSha: unknown }).commitSha === 'string'
    ? (soakReport as { commitSha: string }).commitSha
    : undefined
  if (reportedCommit === undefined) {
    draft.blockers.push('drill_report_invalid')
    return finish(draft)
  }
  if (reportedCommit !== candidateCommit) {
    // Historical soak evidence names its own commit; a qualification at a new
    // candidate cannot extend it, exactly as the runbook requires.
    draft.blockers.push('drill_stale_candidate')
    draft.details.reportedCommit = reportedCommit
    return finish(draft)
  }

  const verdict = verifySoakReport({ report: soakReport, expectedCommitSha: candidateCommit, expectedSchemaVersion: latestSchemaVersion })
  if (verdict.ok)
    return finish(draft)

  if (verdict.failures.includes('report does not match the expected schema')) {
    draft.blockers.push('drill_report_invalid')
  }
  else {
    draft.blockers.push('drill_failed')
    draft.details.failures = [...verdict.failures].sort()
  }
  return finish(draft)
}

function checkSignoffsCondition(approvals: Approvals): G8ConditionResult {
  const draft: ConditionDraft = { id: 'signoffs', blockers: [], details: {} }

  if (approvals.invalidCount > 0)
    draft.blockers.push('signoff_records_invalid')
  draft.details.invalidRecordCount = approvals.invalidCount

  const byRole = new Map<string, G8SignoffRecord[]>()
  for (const record of approvals.records) {
    const existing = byRole.get(record.role) ?? []
    existing.push(record)
    byRole.set(record.role, existing)
  }
  draft.details.roles = [...byRole.keys()].sort()

  for (const role of REQUIRED_SIGNOFF_ROLES) {
    const records = byRole.get(role) ?? []
    if (records.length === 0) {
      draft.blockers.push(`signoff_missing:${role}`)
      continue
    }
    if (records.some(record => record.decision === 'reject' && record.candidateCommit === approvals.candidateCommit))
      draft.blockers.push(`signoff_rejected:${role}`)
    if (!records.some(record => record.decision === 'approve' && record.candidateCommit === approvals.candidateCommit))
      draft.blockers.push(`signoff_wrong_scope:${role}`)
  }

  return finish(draft)
}

function checkGateReadinessCondition(approvals: Approvals): G8ConditionResult {
  const draft: ConditionDraft = { id: 'gate-readiness', blockers: [], details: {} }

  const assertions = approvals.records
    .filter(record => record.candidateCommit === approvals.candidateCommit && record.decision === 'approve' && record.gateReadiness !== undefined)
    .map(record => record.gateReadiness!)
  if (assertions.length === 0) {
    draft.blockers.push('gate_readiness_unasserted')
    return finish(draft)
  }
  if (assertions.some(assertion => !assertion.openQuestionsResolved))
    draft.blockers.push('gate_open_questions_unresolved')
  if (assertions.some(assertion => !assertion.highRisksOwned))
    draft.blockers.push('gate_unowned_high_risks')

  return finish(draft)
}

/**
 * Decide whether the supplied evidence qualifies G8 at the exact candidate.
 *
 * Never throws on evidence problems: every fault — missing, stale, malformed,
 * unevaluated, unapproved — becomes a stable blocker code on its condition, so
 * one bad input cannot hide another. `pass` requires every artifact 21 §11.2
 * condition to hold simultaneously and remains a statement about evidence, not
 * a deployment decision.
 */
export function qualifyG8(input: G8QualificationInput): G8QualificationResult {
  if (!/^[0-9a-f]{40}$/.test(input.candidateCommit))
    throw new Error('candidateCommit must be a full 40-character commit SHA')

  const approvals = parseApprovals(input.signoffs ?? [], input.candidateCommit)
  const conditions: G8ConditionResult[] = [
    checkEvaluationFamily({
      id: 'functional',
      prefix: 'functional',
      input: input.functional,
      expectedDatasetVersion: ACTIVE_V1_VERSION,
      candidateCommit: input.candidateCommit,
      approvals,
    }),
    checkEvaluationFamily({
      id: 'multilingual',
      prefix: 'multilingual',
      input: input.multilingual,
      expectedDatasetVersion: MULTILINGUAL_V1_VERSION,
      candidateCommit: input.candidateCommit,
      approvals,
      retrieval: { policy: input.multilingual?.policy, decision: input.multilingual?.decision },
    }),
    checkPerformanceFamily(input.performance, input.candidateCommit, approvals),
    checkCostCondition(input.priceDocument, input.performance, approvals),
    checkDrillsCondition(input.soakReport, input.candidateCommit),
    checkSignoffsCondition(approvals),
    checkGateReadinessCondition(approvals),
  ]

  const blockers = [...new Set(conditions.flatMap(condition => condition.blockers))].sort()
  return Object.freeze({
    format: 1,
    gate: 'g8',
    status: blockers.length === 0 ? 'pass' : 'blocked',
    candidateCommit: input.candidateCommit,
    conditions: Object.freeze(conditions),
    blockers: Object.freeze(blockers),
    evidence: Object.freeze({
      signoffs: approvals.records
        .map(record => ({ role: record.role, decision: record.decision, source: record.source }))
        // Ordered over the whole projected tuple, by code point. A key that
        // omitted `decision` left an approval and a rejection from one role and
        // source interchangeable, so their published order followed input order.
        .sort((left, right) => compareStrings(signoffSortKey(left), signoffSortKey(right))),
    }),
  })
}
