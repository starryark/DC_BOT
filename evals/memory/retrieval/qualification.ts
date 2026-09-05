import type { Dataset, ScenarioResult } from '../contracts'
import type { EvaluationSummary } from '../report'
import type { RetrievalPolicyDocument } from './policy'
import type { RetrievalAggregate } from './report'

import { createHash } from 'node:crypto'

import * as v from 'valibot'

import { canonicalJson, CAPABILITY_DISPOSITIONS, OUTCOMES, SCENARIO_CATEGORIES } from '../contracts'
import { ACTIVE_V1_VERSION, activeV1Dataset, activeV1Digest, MULTILINGUAL_V1_VERSION, multilingualV1Dataset, multilingualV1Digest } from '../dataset'
import { computeNormalizedResultDigest, runIsValidForGate } from '../report'
import { evaluateRetrievalPolicy, governanceField, QUALIFIABLE_RETRIEVAL_MODES, sameModes } from './policy'
import { aggregateRetrieval } from './report'

/**
 * Retrieval qualification: deciding whether externally supplied evidence is
 * sufficient to call lexical retrieval formally accepted (IMP-607, T002/T003).
 *
 * This module verifies evidence; it never creates it. It cannot mint an
 * approved policy, cannot mint an independent evaluator decision, and has no
 * switch that asserts acceptance. Given two benchmark runs, an approved policy,
 * and an independent decision, it answers one question — do they all describe
 * the same thing, and does that thing pass? — and every other input shape
 * produces `measured_not_evaluated`, `rejected`, or a thrown evidence fault.
 *
 * Nothing here reads the working tree or starts a memory runtime. Every fact is
 * recomputed from the artifacts the caller supplies, using the same
 * implementations that produced them ({@link ../report.ts#computeNormalizedResultDigest},
 * {@link ./report.ts#aggregateRetrieval}), so a verifier and a generator cannot
 * silently drift apart.
 */

/**
 * Whether evidence failed to parse or failed to hold together.
 *
 * The distinction drives the CLI's exit code: `schema` means the caller handed
 * over something that is not a benchmark artifact, `integrity` means it is
 * shaped like one but its own contents contradict each other. Neither is a
 * qualification verdict — invalid evidence produces no verdict at all.
 */
export type QualificationEvidenceFault = 'schema' | 'integrity'

/**
 * Evidence that cannot be qualified either way.
 *
 * `reason` is a stable machine code safe to print; the message may carry
 * content-free detail for a human reading stderr.
 */
export class QualificationEvidenceError extends Error {
  readonly fault: QualificationEvidenceFault
  readonly reason: string

  constructor(fault: QualificationEvidenceFault, reason: string, message?: string, options?: { cause?: unknown }) {
    super(message ?? reason, options)
    this.name = 'QualificationEvidenceError'
    this.fault = fault
    this.reason = reason
  }
}

function schemaFault(reason: string, message?: string, cause?: unknown): QualificationEvidenceError {
  return new QualificationEvidenceError('schema', reason, message, { cause })
}

function integrityFault(reason: string, message?: string, cause?: unknown): QualificationEvidenceError {
  return new QualificationEvidenceError('integrity', reason, message, { cause })
}

/** SHA-256 over raw artifact bytes, distinct from the canonical-JSON digests. */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The published bytes of one benchmark run.
 *
 * Hashing the files rather than the parsed values is what lets an independent
 * evaluator commit to the exact artifacts it read: a re-serialized summary with
 * the same values is a different artifact, and a decision naming the old bytes
 * no longer applies to it.
 */
export interface RetrievalRunArtifactHashes {
  readonly summarySha256: string
  readonly scenarioResultsSha256: string
  readonly reportSha256: string
}

/** One benchmark run's parsed artifacts, plus the hashes of the bytes they came from. */
export interface RetrievalBenchmarkPacket {
  readonly summary: EvaluationSummary
  readonly scenarioResults: readonly ScenarioResult[]
  readonly rawArtifactHashes: RetrievalRunArtifactHashes
}

/**
 * Everything two runs, a policy, and a decision must agree on exactly.
 *
 * Deliberately stricter than {@link ./report.ts#assertCompatibleExperiments},
 * which compares two experiments and therefore allows their candidate commits
 * to differ. Formal qualification names one immutable commit, so equality of
 * `candidateCommit` is mandatory here and that comparator is left untouched.
 */
export interface RetrievalQualificationIdentity {
  readonly candidateCommit: string
  readonly datasetVersion: string
  readonly datasetDigest: string
  readonly evaluatorSchemaVersion: number
  readonly analyzerConfigIdentity: string
  readonly requestedModes: readonly string[]
  readonly normalizedResultDigest: string
}

const IDENTITY_SCALAR_FIELDS = [
  'candidateCommit',
  'datasetVersion',
  'datasetDigest',
  'evaluatorSchemaVersion',
  'analyzerConfigIdentity',
  'normalizedResultDigest',
] as const

/**
 * Require equality on every identity field, reporting the first that differs.
 *
 * `reason` names the comparison being made (`run_identity_mismatch`,
 * `decision_identity_mismatch`) and the failing field is appended, so a caller
 * printing the reason says what did not line up without quoting either value.
 */
export function assertQualificationIdentityMatches(
  baseline: RetrievalQualificationIdentity,
  candidate: RetrievalQualificationIdentity,
  reason: string,
): void {
  for (const field of IDENTITY_SCALAR_FIELDS) {
    if (baseline[field] !== candidate[field])
      throw integrityFault(`${reason}:${field}`)
  }
  // Order-sensitive: ['lexical'] must not match ['lexical','vector'].
  if (!sameModes(baseline.requestedModes, candidate.requestedModes))
    throw integrityFault(`${reason}:requestedModes`)
}

const retrievalMetricsSchema = v.strictObject({
  relevantReturned: v.pipe(v.number(), v.finite()),
  irrelevantReturned: v.pipe(v.number(), v.finite()),
  relevantMissed: v.pipe(v.number(), v.finite()),
  precisionAtCutoff: v.pipe(v.number(), v.finite()),
  recallAtCutoff: v.pipe(v.number(), v.finite()),
  reciprocalRank: v.pipe(v.number(), v.finite()),
})

const retrievalQueryResultSchema = v.strictObject({
  queryId: v.pipe(v.string(), v.regex(/^RET-\d{3}-Q\d{2}$/)),
  cutoff: v.pipe(v.number(), v.integer(), v.minValue(1)),
  requestedModes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),
  appliedModes: v.array(v.pipe(v.string(), v.minLength(1))),
  rankedItems: v.array(v.strictObject({
    itemId: v.pipe(v.string(), v.minLength(1)),
    rank: v.pipe(v.number(), v.integer(), v.minValue(1)),
    relevance: v.picklist([0, 1]),
    mode: v.pipe(v.string(), v.minLength(1)),
    features: v.record(v.string(), v.pipe(v.number(), v.finite())),
  })),
  metrics: retrievalMetricsSchema,
  authorizationViolations: v.array(v.string()),
  lifecycleViolations: v.array(v.string()),
  temporalViolations: v.array(v.string()),
})

const retrievalAggregateSchema = v.strictObject({
  queryCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  relevantReturned: v.pipe(v.number(), v.finite()),
  irrelevantReturned: v.pipe(v.number(), v.finite()),
  relevantMissed: v.pipe(v.number(), v.finite()),
  precisionAtCutoff: v.pipe(v.number(), v.finite()),
  recallAtCutoff: v.pipe(v.number(), v.finite()),
  reciprocalRank: v.pipe(v.number(), v.finite()),
  meanPrecisionAtCutoff: v.pipe(v.number(), v.finite()),
  meanRecallAtCutoff: v.pipe(v.number(), v.finite()),
  meanReciprocalRank: v.pipe(v.number(), v.finite()),
  zeroToleranceViolations: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

const nonNegativeInteger = v.pipe(v.number(), v.integer(), v.minValue(0))

/**
 * Runtime validation of a `summary.json` read back from disk.
 *
 * A summary arrives as an external file, so a TypeScript cast would assert
 * exactly the properties an attacker controls. Every field qualification
 * depends on is checked here instead, and the object is strict so an injected
 * field is a rejection rather than a silently ignored extra.
 */
const evaluationSummarySchema = v.strictObject({
  format: v.literal(1),
  evaluatorSchemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  datasetVersion: governanceField.datasetVersion,
  datasetDigest: governanceField.sha256,
  seed: nonNegativeInteger,
  activeProfile: v.literal('active'),
  /** A run whose commit could not be resolved cannot be a qualification candidate. */
  commitSha: governanceField.commitSha,
  platform: v.string(),
  generatedAt: v.pipe(v.string(), v.isoTimestamp()),
  dirtyWorktree: v.boolean(),
  backend: v.literal('sqlite'),
  analyzerConfigIdentity: governanceField.nonEmpty,
  environmentFingerprint: v.strictObject({ node: v.string(), platform: v.string(), arch: v.string() }),
  counts: v.strictObject({
    total: nonNegativeInteger,
    expectedTotal: nonNegativeInteger,
    byOutcome: v.record(v.string(), nonNegativeInteger),
    byCapabilityDisposition: v.record(v.string(), nonNegativeInteger),
  }),
  applicablePassed: nonNegativeInteger,
  applicableTotal: nonNegativeInteger,
  zeroToleranceFailures: v.array(v.string()),
  unsupportedCategories: v.array(v.string()),
  unverifiedCategories: v.array(v.string()),
  notApplicableCategories: v.array(v.string()),
  cleanupFailures: nonNegativeInteger,
  limitations: v.array(v.string()),
  thresholdProvenance: v.optional(v.strictObject({
    approver: v.string(),
    approvedAt: v.string(),
    repositoryCommit: governanceField.commitSha,
  })),
  approval: v.strictObject({ thresholdsApproved: v.boolean(), signedDecision: v.boolean() }),
  normalizedResultDigest: governanceField.sha256,
  measurementStatus: v.picklist(['measured_not_evaluated', 'evaluated']),
  measurementEvaluations: v.strictObject({
    total: nonNegativeInteger,
    passed: nonNegativeInteger,
    failed: nonNegativeInteger,
    measuredNotEvaluated: nonNegativeInteger,
    failedMetricIds: v.array(v.string()),
  }),
  retrieval: v.optional(v.strictObject({
    queries: v.array(retrievalQueryResultSchema),
    aggregate: retrievalAggregateSchema,
  })),
})

const scenarioResultLineSchema = v.strictObject({
  scenarioId: v.pipe(v.string(), v.regex(/^[A-Z]+-\d{3}$/)),
  datasetVersion: governanceField.datasetVersion,
  seed: nonNegativeInteger,
  requirements: v.array(v.pipe(v.string(), v.minLength(1))),
  category: v.picklist(SCENARIO_CATEGORIES),
  capabilityDisposition: v.picklist(CAPABILITY_DISPOSITIONS),
  outcome: v.picklist(OUTCOMES),
  assertions: v.array(v.strictObject({
    assertionId: v.pipe(v.string(), v.minLength(1)),
    passed: v.boolean(),
    diagnostic: v.string(),
  })),
  operationCounts: v.record(v.string(), v.pipe(v.number(), v.finite())),
  measurements: v.array(v.strictObject({
    name: v.pipe(v.string(), v.minLength(1)),
    value: v.pipe(v.number(), v.finite()),
    unit: v.string(),
    evaluated: v.boolean(),
  })),
  retrieval: v.optional(retrievalQueryResultSchema),
  limitations: v.array(v.string()),
  cleanup: v.picklist(['clean', 'failed']),
})

/** Parse a `summary.json` payload; throws a schema fault rather than casting. */
export function parseEvaluationSummaryArtifact(input: unknown): EvaluationSummary {
  try {
    return v.parse(evaluationSummarySchema, input)
  }
  catch (cause) {
    throw schemaFault('benchmark_summary_invalid', 'summary.json failed strict validation', cause)
  }
}

/**
 * Parse `scenario-results.jsonl` into the rows retrieval evidence is rebuilt
 * from.
 *
 * Blank lines are skipped because the published file ends with a newline. A
 * duplicated scenario row is refused here rather than deduplicated: two rows
 * for one scenario mean the file no longer says which result was produced.
 */
export function parseScenarioResultsJsonl(text: string): readonly ScenarioResult[] {
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0)
  if (lines.length === 0)
    throw schemaFault('scenario_results_empty', 'scenario-results.jsonl contains no records')

  const seenScenarios = new Set<string>()
  const seenQueries = new Set<string>()
  const results: ScenarioResult[] = []
  for (const line of lines) {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    }
    catch (cause) {
      throw schemaFault('scenario_results_malformed_json', 'scenario-results.jsonl contains a line that is not JSON', cause)
    }

    let parsed
    try {
      parsed = v.parse(scenarioResultLineSchema, raw)
    }
    catch (cause) {
      throw schemaFault('scenario_results_invalid', 'a scenario-results.jsonl record failed strict validation', cause)
    }

    if (seenScenarios.has(parsed.scenarioId))
      throw schemaFault('scenario_results_duplicate_scenario', 'scenario-results.jsonl repeats a scenario')
    seenScenarios.add(parsed.scenarioId)

    if (parsed.retrieval) {
      if (seenQueries.has(parsed.retrieval.queryId))
        throw schemaFault('scenario_results_duplicate_query', 'scenario-results.jsonl repeats a retrieval query')
      seenQueries.add(parsed.retrieval.queryId)
    }

    results.push(parsed)
  }
  return Object.freeze(results)
}

/**
 * The frozen dataset an artifact was produced against.
 *
 * Resolved from the artifact's own declared version and then digest-checked, so
 * a summary cannot select a lenient dataset by naming one: the version must be
 * known to this build *and* hash to the digest the artifact claims.
 */
export function datasetForArtifact(summary: EvaluationSummary): Dataset {
  const frozen = [
    { version: MULTILINGUAL_V1_VERSION, digest: multilingualV1Digest, load: multilingualV1Dataset },
    { version: ACTIVE_V1_VERSION, digest: activeV1Digest, load: activeV1Dataset },
  ]
  const match = frozen.find(candidate => candidate.version === summary.datasetVersion)
  if (!match)
    throw schemaFault('dataset_version_not_recognized', 'summary names a dataset version this build does not carry')
  if (match.digest() !== summary.datasetDigest)
    throw integrityFault('dataset_digest_mismatch', 'summary names a dataset digest that is not the frozen dataset it claims')
  return match.load()
}

/** One benchmark run after every claim in it has been recomputed. */
export interface VerifiedRetrievalRun {
  readonly identity: RetrievalQualificationIdentity
  readonly seed: number
  readonly aggregate: RetrievalAggregate
  readonly artifactHashes: RetrievalRunArtifactHashes
  readonly dirtyWorktree: boolean
  /** {@link ../report.ts#runIsValidForGate} over the summary; benchmark validity, not approval. */
  readonly validForGate: boolean
}

/**
 * Recompute every qualification-critical fact a benchmark packet asserts.
 *
 * Nothing the summary claims is taken on trust: retrieval metrics and violation
 * lists are re-derived from the per-query rows against the frozen dataset, and
 * the normalized result digest is recomputed with the report generator's own
 * implementation. A summary edited to look healthy fails here, because the
 * numbers it carries stop matching the rows they were supposedly derived from.
 *
 * Throws {@link QualificationEvidenceError}; benchmark *failure* is not thrown,
 * it is reported through `validForGate` for the caller to weigh.
 */
export function verifyRetrievalBenchmarkPacket(packet: RetrievalBenchmarkPacket): VerifiedRetrievalRun {
  const { summary, scenarioResults } = packet
  const dataset = datasetForArtifact(summary)

  if (!summary.retrieval)
    throw schemaFault('retrieval_evidence_missing', 'summary carries no retrieval evidence to qualify')
  if (scenarioResults.length !== summary.counts.total)
    throw integrityFault('scenario_result_count_mismatch', 'summary counts a different number of results than the JSONL carries')
  for (const result of scenarioResults) {
    if (result.datasetVersion !== summary.datasetVersion)
      throw integrityFault('scenario_result_dataset_mismatch', 'a scenario row names a different dataset version than the summary')
    if (result.seed !== summary.seed)
      throw integrityFault('scenario_result_seed_mismatch', 'a scenario row names a different seed than the summary')
  }

  // Recompute retrieval evidence from the per-query rows. aggregateRetrieval
  // raises on any inconsistency it finds — tampered metrics, invented
  // violations, reordered ranks, relabelled relevance, missing queries — all of
  // which mean the artifact contradicts itself.
  let recomputed: ReturnType<typeof aggregateRetrieval>
  try {
    recomputed = aggregateRetrieval(dataset, scenarioResults)
  }
  catch (cause) {
    // The specific inconsistency travels on the cause chain rather than in the
    // reason: callers print reason codes, and aggregateRetrieval's message
    // names dataset identifiers that do not belong in machine-readable output.
    throw integrityFault('retrieval_evidence_recomputation_failed', 'retrieval evidence could not be recomputed from the per-query rows', cause)
  }

  if (canonicalJson(recomputed) !== canonicalJson(summary.retrieval))
    throw integrityFault('retrieval_aggregate_mismatch', 'summary retrieval evidence does not match recomputation from the per-query rows')

  const recomputedDigest = computeNormalizedResultDigest(dataset, scenarioResults, { datasetDigest: summary.datasetDigest, seed: summary.seed })
  if (recomputedDigest !== summary.normalizedResultDigest)
    throw integrityFault('normalized_result_digest_mismatch', 'summary claims a normalized result digest its own rows do not produce')

  const requestedModes = declaredRequestedModes(recomputed.queries)

  return Object.freeze({
    identity: Object.freeze({
      candidateCommit: summary.commitSha,
      datasetVersion: summary.datasetVersion,
      datasetDigest: summary.datasetDigest,
      evaluatorSchemaVersion: summary.evaluatorSchemaVersion,
      analyzerConfigIdentity: summary.analyzerConfigIdentity,
      requestedModes,
      normalizedResultDigest: summary.normalizedResultDigest,
    }),
    seed: summary.seed,
    aggregate: recomputed.aggregate,
    artifactHashes: packet.rawArtifactHashes,
    dirtyWorktree: summary.dirtyWorktree,
    validForGate: runIsValidForGate(summary),
  })
}

/**
 * The single mode set a run exercised.
 *
 * Queries that disagree leave no one answer to compare a policy against, so a
 * mixed run is refused rather than summarised into a union. A gated mode is
 * refused outright: the evaluator will not produce vector or graph evidence, so
 * an artifact claiming it did was not produced by the sanctioned toolchain.
 */
function declaredRequestedModes(queries: readonly { readonly requestedModes: readonly string[] }[]): readonly string[] {
  const first = queries[0]?.requestedModes
  if (!first)
    throw schemaFault('retrieval_evidence_missing', 'no retrieval queries to qualify')
  for (const query of queries) {
    if (!sameModes(query.requestedModes, first))
      throw integrityFault('retrieval_modes_inconsistent', 'retrieval queries do not agree on the requested modes')
  }
  for (const mode of first) {
    if (!QUALIFIABLE_RETRIEVAL_MODES.includes(mode))
      throw integrityFault('retrieval_mode_not_qualifiable', 'retrieval evidence names a gated mode this slice cannot qualify')
  }
  return Object.freeze([...first])
}

const runArtifactHashesSchema = v.strictObject({
  summarySha256: governanceField.sha256,
  scenarioResultsSha256: governanceField.sha256,
  reportSha256: governanceField.sha256,
})

/**
 * An external evaluator's decision about one specific benchmark pair.
 *
 * There is deliberately no `independent: true` field. Software cannot establish
 * that whoever produced this artifact is organizationally separate from
 * whoever produced the benchmark; that remains a procedural requirement carried
 * out by people. What the artifact *can* do — and what is checked — is commit
 * to exactly which commit, dataset, evaluator, analyzer, modes, policy, result,
 * and artifact bytes the decision was made about, so a verdict cannot be moved
 * onto evidence it was not given.
 */
const independentDecisionSchema = v.strictObject({
  format: v.literal(1),

  evaluator: governanceField.nonEmpty,
  decidedAt: v.pipe(v.string(), v.isoTimestamp()),
  source: governanceField.nonEmpty,

  decision: v.picklist(['accepted', 'rejected']),

  candidateCommit: governanceField.commitSha,

  datasetVersion: governanceField.datasetVersion,
  datasetDigest: governanceField.sha256,
  evaluatorSchemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  analyzerConfigIdentity: governanceField.nonEmpty,
  requestedModes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),

  policyDigest: governanceField.sha256,

  normalizedResultDigest: governanceField.sha256,

  runA: runArtifactHashesSchema,
  runB: runArtifactHashesSchema,
})

export type IndependentRetrievalDecision = v.InferOutput<typeof independentDecisionSchema>

/**
 * Parse an independent evaluator decision.
 *
 * Structural validity only — whether the decision describes *this* benchmark
 * and *this* policy is settled in {@link qualifyRetrieval}, against the evidence
 * actually supplied, so a decision can never be validated against itself.
 */
export function parseIndependentRetrievalDecision(input: unknown): IndependentRetrievalDecision {
  let parsed: IndependentRetrievalDecision
  try {
    parsed = v.parse(independentDecisionSchema, input)
  }
  catch (cause) {
    throw schemaFault('independent_decision_invalid', 'independent decision failed strict validation', cause)
  }

  const seenModes = new Set<string>()
  for (const mode of parsed.requestedModes) {
    if (seenModes.has(mode))
      throw schemaFault('independent_decision_duplicate_mode', 'independent decision repeats a requested mode')
    seenModes.add(mode)
    if (!QUALIFIABLE_RETRIEVAL_MODES.includes(mode))
      throw schemaFault('independent_decision_mode_not_qualifiable', 'independent decision names a gated retrieval mode')
  }

  return parsed
}

export type RetrievalQualificationStatus = 'accepted' | 'rejected' | 'measured_not_evaluated'

/**
 * The qualification verdict, carrying only identifiers and stable reason codes.
 *
 * `measured_not_evaluated` is not a failure: it is the honest state of a valid
 * benchmark whose governance evidence has not been supplied. It is reported
 * separately from `rejected` precisely so a missing approval is never read as a
 * benchmark that went badly.
 */
export interface RetrievalQualificationResult {
  readonly status: RetrievalQualificationStatus

  readonly candidateCommit: string
  readonly datasetVersion: string
  readonly datasetDigest: string
  readonly evaluatorSchemaVersion: number
  readonly analyzerConfigIdentity: string
  readonly requestedModes: readonly string[]
  readonly normalizedResultDigest: string

  /** Present only when an approved policy was supplied and bound to this evidence. */
  readonly policyDigest?: string
  /** The independent evaluator's verdict, when one was supplied and bound. */
  readonly decision?: 'accepted' | 'rejected'

  readonly reasons: readonly string[]
}

export interface RetrievalQualificationInput {
  readonly runA: RetrievalBenchmarkPacket
  readonly runB: RetrievalBenchmarkPacket
  /** Absent means `measured_not_evaluated`; this module cannot supply one. */
  readonly policy?: RetrievalPolicyDocument
  /** Absent means `measured_not_evaluated`; this module cannot supply one. */
  readonly decision?: IndependentRetrievalDecision
}

/**
 * Decide whether the supplied evidence formally qualifies lexical retrieval.
 *
 * The order below is the argument itself, and each stage guards the next:
 *
 *   1. both runs are recomputed from their own rows;
 *   2. the two runs are required to be the same experiment on the same commit;
 *   3. benchmark-level blockers (dirty tree, failed run, zero-tolerance
 *      violation) reject before governance is consulted, because approving a
 *      run that failed is not a thing an approver should be asked to do;
 *   4. absent policy or decision yields `measured_not_evaluated`;
 *   5. the policy and the decision are bound to this exact evidence — a
 *      mismatch throws rather than rejecting, since evidence about something
 *      else is not a verdict about this;
 *   6. only then are the approved limits and the evaluator's verdict read.
 *
 * `accepted` is reachable only by passing every one of those.
 */
export function qualifyRetrieval(input: RetrievalQualificationInput): RetrievalQualificationResult {
  const runA = verifyRetrievalBenchmarkPacket(input.runA)
  const runB = verifyRetrievalBenchmarkPacket(input.runB)

  assertQualificationIdentityMatches(runA.identity, runB.identity, 'run_identity_mismatch')
  if (runA.seed !== runB.seed)
    throw integrityFault('run_identity_mismatch:seed', 'the two runs were produced with different seeds')
  // Equal normalized digests already imply equal per-query metrics, so a
  // divergent aggregate here would mean one of the two derivations is wrong.
  if (canonicalJson(runA.aggregate) !== canonicalJson(runB.aggregate))
    throw integrityFault('run_aggregate_mismatch', 'the two runs recompute to different retrieval aggregates')

  const identity = runA.identity
  const verdict = (status: RetrievalQualificationStatus, reasons: readonly string[], extra?: { policyDigest?: string, decision?: 'accepted' | 'rejected' }): RetrievalQualificationResult => Object.freeze({
    status,
    candidateCommit: identity.candidateCommit,
    datasetVersion: identity.datasetVersion,
    datasetDigest: identity.datasetDigest,
    evaluatorSchemaVersion: identity.evaluatorSchemaVersion,
    analyzerConfigIdentity: identity.analyzerConfigIdentity,
    requestedModes: identity.requestedModes,
    normalizedResultDigest: identity.normalizedResultDigest,
    ...(extra?.policyDigest ? { policyDigest: extra.policyDigest } : {}),
    ...(extra?.decision ? { decision: extra.decision } : {}),
    reasons: Object.freeze([...reasons]),
  })

  // A qualification candidate is one immutable clean commit. A dirty worktree
  // means the artifacts describe a tree nobody can check out again.
  const blocking: string[] = []
  if (runA.dirtyWorktree)
    blocking.push('run_a_dirty_worktree')
  if (runB.dirtyWorktree)
    blocking.push('run_b_dirty_worktree')
  if (!runA.validForGate)
    blocking.push('run_a_not_valid_for_gate')
  if (!runB.validForGate)
    blocking.push('run_b_not_valid_for_gate')
  if (runA.aggregate.zeroToleranceViolations > 0)
    blocking.push('retrieval_zero_tolerance_violation')
  if (blocking.length > 0)
    return verdict('rejected', blocking)

  const { policy, decision } = input
  const missing: string[] = []
  if (!policy)
    missing.push('approved_policy_missing')
  if (!decision)
    missing.push('independent_decision_missing')
  if (!policy || !decision)
    return verdict('measured_not_evaluated', missing)

  // Re-check the policy against the benchmark identity even though the parser
  // was given the same expectation: qualifyRetrieval must not depend on its
  // caller having asked the right question.
  assertPolicyBinding(policy, identity)
  const evaluation = evaluateRetrievalPolicy(runA.aggregate, policy)

  assertQualificationIdentityMatches(identity, decisionIdentity(decision), 'decision_identity_mismatch')
  if (decision.policyDigest !== policy.policyDigest)
    throw integrityFault('decision_policy_digest_mismatch', 'the decision was made about a different policy document')
  assertArtifactHashesMatch(decision.runA, runA.artifactHashes, 'decision_run_a_artifact_hash_mismatch')
  assertArtifactHashesMatch(decision.runB, runB.artifactHashes, 'decision_run_b_artifact_hash_mismatch')

  const reasons: string[] = []
  if (evaluation.status === 'failed') {
    // Zero-tolerance violations were already blocked above, so a failed
    // evaluation at this point can only be a missed quality limit.
    reasons.push(evaluation.failedLimitNames.length > 0 ? 'policy_limit_failed' : 'retrieval_zero_tolerance_violation')
  }
  if (decision.decision === 'rejected')
    reasons.push('independent_decision_rejected')

  const bound = { policyDigest: policy.policyDigest, decision: decision.decision }
  return reasons.length > 0 ? verdict('rejected', reasons, bound) : verdict('accepted', [], bound)
}

/** True only for a complete, fully matching acceptance. */
export function retrievalIsFormallyQualified(result: RetrievalQualificationResult): boolean {
  return result.status === 'accepted'
}

function assertPolicyBinding(policy: RetrievalPolicyDocument, identity: RetrievalQualificationIdentity): void {
  if (policy.repositoryCommit !== identity.candidateCommit)
    throw integrityFault('policy_identity_mismatch:candidateCommit')
  if (policy.datasetVersion !== identity.datasetVersion)
    throw integrityFault('policy_identity_mismatch:datasetVersion')
  if (policy.datasetDigest !== identity.datasetDigest)
    throw integrityFault('policy_identity_mismatch:datasetDigest')
  if (policy.evaluatorSchemaVersion !== identity.evaluatorSchemaVersion)
    throw integrityFault('policy_identity_mismatch:evaluatorSchemaVersion')
  if (policy.analyzerConfigIdentity !== identity.analyzerConfigIdentity)
    throw integrityFault('policy_identity_mismatch:analyzerConfigIdentity')
  if (!sameModes(policy.requestedModes, identity.requestedModes))
    throw integrityFault('policy_identity_mismatch:requestedModes')
}

function decisionIdentity(decision: IndependentRetrievalDecision): RetrievalQualificationIdentity {
  return {
    candidateCommit: decision.candidateCommit,
    datasetVersion: decision.datasetVersion,
    datasetDigest: decision.datasetDigest,
    evaluatorSchemaVersion: decision.evaluatorSchemaVersion,
    analyzerConfigIdentity: decision.analyzerConfigIdentity,
    requestedModes: decision.requestedModes,
    normalizedResultDigest: decision.normalizedResultDigest,
  }
}

function assertArtifactHashesMatch(claimed: RetrievalRunArtifactHashes, actual: RetrievalRunArtifactHashes, reason: string): void {
  for (const field of ['summarySha256', 'scenarioResultsSha256', 'reportSha256'] as const) {
    if (claimed[field] !== actual[field])
      throw integrityFault(`${reason}:${field}`)
  }
}
