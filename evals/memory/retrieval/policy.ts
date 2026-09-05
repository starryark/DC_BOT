import type { RetrievalAggregate } from './report'

import { MemoryError } from '@proj-airi/memory-domain'

import * as v from 'valibot'

import { sha256Canonical } from '../contracts'

/**
 * The approved retrieval-policy contract (IMP-607 governance, T001).
 *
 * A benchmark run measures retrieval quality; it does not decide whether that
 * quality is acceptable. Every number that turns a measurement into a verdict
 * arrives in one of these documents, approved outside this repository against a
 * named commit, dataset, evaluator, and analyzer. Nothing in this file supplies
 * a limit, a default, or a fallback: with no policy there is no verdict, only a
 * measurement.
 *
 * The document is bound to its own contents by {@link retrievalPolicyDigest},
 * so bytes cannot be edited after approval while keeping the approver's name
 * attached to them.
 */

/** Provenance field shapes the governance artifacts in this directory share. */
export const governanceField = {
  commitSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/, 'must be a full 40-character commit sha')),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, 'must be a sha-256 hex digest')),
  datasetVersion: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/, 'dataset version must be semver')),
  nonEmpty: v.pipe(v.string(), v.minLength(1), v.maxLength(280)),
}

/**
 * The retrieval quality metrics a policy may grade.
 *
 * Deliberately an allowlist of the three whole-run means the aggregate derives
 * from per-query evidence. Authorization, lifecycle, and temporal correctness
 * are absent on purpose: those are hard benchmark invariants, and a policy that
 * could name them could approve a run that leaked unauthorized results.
 */
export const RETRIEVAL_QUALITY_METRICS = Object.freeze([
  'meanPrecisionAtCutoff',
  'meanRecallAtCutoff',
  'meanReciprocalRank',
] as const)

export type RetrievalQualityMetric = typeof RETRIEVAL_QUALITY_METRICS[number]

/**
 * Retrieval modes this slice is able to qualify at all.
 *
 * Only lexical. Vector and graph retrieval are refused by the evaluator and
 * forbidden by capability advertisement — vector by ADR-011, graph by artifact
 * 22 EV-012 — so a policy naming either describes evidence that cannot exist.
 * Rejecting it here keeps the schema's ability to hold an arbitrary mode string
 * from becoming a way to qualify a gated one, and keeps this slice's evidence
 * from being read as coverage of a mode it never ran.
 */
export const QUALIFIABLE_RETRIEVAL_MODES: readonly string[] = Object.freeze(['lexical'])

const retrievalPolicyLimitSchema = v.strictObject({
  /** Stable, content-free label; travels into results so a miss can be named. */
  name: governanceField.nonEmpty,
  metric: v.picklist(RETRIEVAL_QUALITY_METRICS),
  /**
   * All three graded metrics are higher-is-better, so a floor is the only
   * meaningful direction. Admitting `<=` would let an approved document cap
   * retrieval quality and still read as an approval.
   */
  operation: v.literal('>='),
  /**
   * Supplied entirely by the approver. No range is imposed: an unreachable
   * floor is a policy that always fails, which is a verdict this repository is
   * allowed to report but not to second-guess.
   */
  value: v.pipe(v.number(), v.finite()),
})

export type RetrievalPolicyLimit = v.InferOutput<typeof retrievalPolicyLimitSchema>

const retrievalPolicySchema = v.strictObject({
  format: v.literal(1),

  approver: governanceField.nonEmpty,
  approvedAt: v.pipe(v.string(), v.isoTimestamp()),
  source: governanceField.nonEmpty,

  /** The commit the limits were approved against; matched exactly, never loosely. */
  repositoryCommit: governanceField.commitSha,

  datasetVersion: governanceField.datasetVersion,
  datasetDigest: governanceField.sha256,
  evaluatorSchemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),

  analyzerConfigIdentity: governanceField.nonEmpty,
  requestedModes: v.pipe(v.array(v.pipe(v.string(), v.minLength(1))), v.minLength(1)),

  limits: v.pipe(v.array(retrievalPolicyLimitSchema), v.minLength(1)),

  /** Digest of every field above; see {@link retrievalPolicyDigest}. */
  policyDigest: governanceField.sha256,
})

export type RetrievalPolicyDocument = v.InferOutput<typeof retrievalPolicySchema>

/** The benchmark provenance a policy must have been approved against. */
export interface RetrievalPolicyExpectedIdentity {
  readonly repositoryCommit: string
  readonly datasetVersion: string
  readonly datasetDigest: string
  readonly evaluatorSchemaVersion: number
  readonly analyzerConfigIdentity: string
  readonly requestedModes: readonly string[]
}

/**
 * The identity a policy document carries, taken over its canonical contents
 * with `policyDigest` itself excluded.
 *
 * Hashing the document including its own digest field would be self-referential
 * and unverifiable, so the digest covers approver, provenance, and limits only.
 * Canonical encoding means re-indenting or reordering keys does not change the
 * identity, while changing any approved value does.
 */
export function retrievalPolicyDigest(policy: Omit<RetrievalPolicyDocument, 'policyDigest'>): string {
  return sha256Canonical(policy)
}

/**
 * Parse an approved retrieval policy and bind it to one specific benchmark.
 *
 * Unlike {@link ../contracts.ts#parseThresholdDocument}, which compares dataset
 * and evaluator only, this requires the candidate commit to match as well:
 * formal qualification names one immutable commit, and a policy approved
 * against a different tree grades code nobody approved.
 *
 * Throws `INVALID_PAYLOAD` for a document that is structurally invalid, whose
 * digest does not cover its bytes, or whose provenance names other evidence.
 * Absence of a policy is not this function's concern — that is a caller-side
 * `measured_not_evaluated`, not a failure.
 */
export function parseRetrievalPolicy(input: unknown, expected: RetrievalPolicyExpectedIdentity): RetrievalPolicyDocument {
  let parsed: RetrievalPolicyDocument
  try {
    parsed = v.parse(retrievalPolicySchema, input)
  }
  catch (cause) {
    throw new MemoryError('INVALID_PAYLOAD', 'retrieval policy failed strict validation', { retryable: false, cause })
  }

  // Invariants the schema cannot express. A metric graded twice has no single
  // verdict, and a duplicate limit name makes a reported miss ambiguous.
  const gradedMetrics = new Set<string>()
  const limitNames = new Set<string>()
  for (const limit of parsed.limits) {
    if (gradedMetrics.has(limit.metric))
      throw invalidPolicy(`retrieval policy grades ${limit.metric} more than once`)
    gradedMetrics.add(limit.metric)
    if (limitNames.has(limit.name))
      throw invalidPolicy('retrieval policy declares two limits with the same name')
    limitNames.add(limit.name)
  }

  const seenModes = new Set<string>()
  for (const mode of parsed.requestedModes) {
    if (seenModes.has(mode))
      throw invalidPolicy(`retrieval policy requests ${mode} more than once`)
    seenModes.add(mode)
    if (!QUALIFIABLE_RETRIEVAL_MODES.includes(mode))
      throw invalidPolicy(`retrieval policy requests ${mode}, which is gated and cannot be qualified`)
  }

  // Digest before provenance: an altered document is not evidence at all, so
  // there is nothing to compare its provenance against.
  const { policyDigest, ...content } = parsed
  if (policyDigest !== retrievalPolicyDigest(content))
    throw invalidPolicy('retrieval policy digest does not match its canonical contents')

  for (const field of ['repositoryCommit', 'datasetVersion', 'datasetDigest', 'evaluatorSchemaVersion', 'analyzerConfigIdentity'] as const) {
    if (parsed[field] !== expected[field])
      throw invalidPolicy(`retrieval policy provenance does not match the benchmark evidence: ${field}`)
  }
  if (!sameModes(parsed.requestedModes, expected.requestedModes))
    throw invalidPolicy('retrieval policy provenance does not match the benchmark evidence: requestedModes')

  return parsed
}

/** One graded limit's verdict; carries no measured value, only the outcome. */
export interface RetrievalPolicyLimitResult {
  readonly name: string
  readonly metric: RetrievalQualityMetric
  readonly operation: '>='
  readonly status: 'passed' | 'failed'
}

export interface RetrievalPolicyEvaluation {
  readonly status: 'passed' | 'failed'
  readonly limits: readonly RetrievalPolicyLimitResult[]
  /** Sorted names of limits the aggregate missed; stable across run order. */
  readonly failedLimitNames: readonly string[]
  /**
   * Authorization, lifecycle, and temporal violations counted from recomputed
   * per-query evidence. Reported here so it is visible at the point a policy is
   * applied, and folded into `status` so no set of approved quality limits can
   * grade a leaking run as passed.
   */
  readonly zeroToleranceViolations: number
}

/**
 * Grade a recomputed retrieval aggregate against an approved policy.
 *
 * Every comparison uses a value the policy supplied; there is no default limit
 * to fall back on and no metric that passes by absence. A zero-tolerance
 * violation fails the evaluation regardless of the limits, because those
 * invariants are not gradeable quality — they are conditions the benchmark
 * either met or did not.
 */
export function evaluateRetrievalPolicy(aggregate: RetrievalAggregate, policy: RetrievalPolicyDocument): RetrievalPolicyEvaluation {
  const limits: RetrievalPolicyLimitResult[] = policy.limits.map((limit) => {
    const measured = aggregate[limit.metric]
    // `operation` is the literal '>=', so the floor comparison is direct; an
    // unmeasurable metric fails rather than passing by absence.
    const met = Number.isFinite(measured) && measured >= limit.value
    return { name: limit.name, metric: limit.metric, operation: limit.operation, status: met ? 'passed' : 'failed' }
  })

  const failedLimitNames = limits.filter(limit => limit.status === 'failed').map(limit => limit.name).sort()
  const passed = failedLimitNames.length === 0 && aggregate.zeroToleranceViolations === 0

  return Object.freeze({
    status: passed ? 'passed' : 'failed',
    limits: Object.freeze(limits),
    failedLimitNames: Object.freeze(failedLimitNames),
    zeroToleranceViolations: aggregate.zeroToleranceViolations,
  })
}

/** Order-sensitive mode comparison; `['lexical']` never matches `['lexical','vector']`. */
export function sameModes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((mode, index) => mode === right[index])
}

function invalidPolicy(message: string): MemoryError {
  return new MemoryError('INVALID_PAYLOAD', message, { retryable: false })
}
