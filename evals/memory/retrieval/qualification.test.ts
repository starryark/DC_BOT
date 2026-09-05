import type { ScenarioResult } from '../contracts'
import type { RetrievalQualificationIdentity } from './qualification'
import type { BenchmarkRunArtifacts } from './qualification-fixtures'

import { describe, expect, it } from 'vitest'

import { multilingualV1Dataset } from '../dataset'
import { parseRetrievalPolicy } from './policy'
import {
  assertQualificationIdentityMatches,
  parseIndependentRetrievalDecision,
  QualificationEvidenceError,
  qualifyRetrieval,
  retrievalIsFormallyQualified,
  verifyRetrievalBenchmarkPacket,
} from './qualification'
import {
  ANALYZER_IDENTITY,
  approvedPolicyObject,
  artifactHashes,
  benchmarkIdentity,
  benchmarkPacket,
  benchmarkRunArtifacts,
  CANDIDATE_COMMIT,
  independentDecisionObject,
  passingRetrievalResults,
} from './qualification-fixtures'

/**
 * Retrieval qualification adversarial matrix (IMP-607, T004).
 *
 * Every case here is a substitution attempt: real-looking evidence pointed at
 * the wrong commit, the wrong dataset, the wrong policy, the wrong bytes, or
 * edited after the fact. The single acceptance test at the bottom is the only
 * path through the whole file that reaches `accepted`, and it only gets there
 * with two clean reproducible runs, a bound approved policy, and a bound
 * independent decision.
 *
 * Absence of governance evidence is deliberately *not* grouped with tampering:
 * `measured_not_evaluated` says the benchmark stands and nobody has approved
 * anything, which is the project's actual state until T005-T007 happen.
 */

const dataset = multilingualV1Dataset()

const runA = benchmarkRunArtifacts({ generatedAt: '2026-08-08T01:00:00Z' })
/** The same candidate, seed, and dataset, generated at a different wall-clock time. */
const runB = benchmarkRunArtifacts({ generatedAt: '2026-08-08T03:00:00Z' })

const verifiedRunA = verifyRetrievalBenchmarkPacket(benchmarkPacket(runA))
const NORMALIZED_DIGEST = verifiedRunA.identity.normalizedResultDigest
const measured = verifiedRunA.aggregate

const passingPolicy = parseRetrievalPolicy(approvedPolicyObject(), benchmarkIdentity())

function policyWith(limits: unknown) {
  return parseRetrievalPolicy(approvedPolicyObject({ limits }), benchmarkIdentity())
}

/** An approved policy whose floor sits just above what the run actually measured. */
const failingPolicy = policyWith([{ name: 'mean-precision-floor', metric: 'meanPrecisionAtCutoff', operation: '>=', value: measured.meanPrecisionAtCutoff + 0.01 }])

function decisionFor(overrides: Record<string, unknown> = {}, runs: { a?: BenchmarkRunArtifacts, b?: BenchmarkRunArtifacts } = {}, policyDigest = passingPolicy.policyDigest) {
  return parseIndependentRetrievalDecision(independentDecisionObject({
    policyDigest,
    normalizedResultDigest: NORMALIZED_DIGEST,
    runA: artifactHashes(runs.a ?? runA),
    runB: artifactHashes(runs.b ?? runB),
    overrides,
  }))
}

const acceptingDecision = decisionFor()

/** Rewrite a run's `summary.json` bytes, leaving the other two artifacts alone. */
function withSummary(artifacts: BenchmarkRunArtifacts, mutate: (summary: Record<string, unknown>) => void): BenchmarkRunArtifacts {
  const summary = JSON.parse(artifacts.summaryText) as Record<string, unknown>
  mutate(summary)
  return { ...artifacts, summaryText: `${JSON.stringify(summary, null, 2)}\n` }
}

/** Rewrite a run's `scenario-results.jsonl` rows. */
function withRows(artifacts: BenchmarkRunArtifacts, mutate: (rows: Record<string, unknown>[]) => Record<string, unknown>[]): BenchmarkRunArtifacts {
  const rows = artifacts.scenarioResultsText.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as Record<string, unknown>)
  return { ...artifacts, scenarioResultsText: `${mutate(rows).map(row => JSON.stringify(row)).join('\n')}\n` }
}

/** The retrieval block of one row, as a mutable copy. */
function retrievalOf(row: Record<string, unknown>): Record<string, unknown> {
  return { ...(row.retrieval as Record<string, unknown>) }
}

function fault(run: () => unknown): QualificationEvidenceError {
  try {
    run()
  }
  catch (error) {
    if (error instanceof QualificationEvidenceError)
      return error
    throw error
  }
  throw new Error('expected a qualification evidence fault, but the call returned')
}

function qualify(options: { a?: BenchmarkRunArtifacts, b?: BenchmarkRunArtifacts, policy?: typeof passingPolicy, decision?: typeof acceptingDecision } = {}) {
  return qualifyRetrieval({
    runA: benchmarkPacket(options.a ?? runA),
    runB: benchmarkPacket(options.b ?? runB),
    policy: options.policy,
    decision: options.decision,
  })
}

describe('benchmark artifact parsing', () => {
  it('parses a published run and recomputes its retrieval evidence', () => {
    const verified = verifyRetrievalBenchmarkPacket(benchmarkPacket(runA))
    expect(verified.identity.candidateCommit).toBe(CANDIDATE_COMMIT)
    expect(verified.identity.requestedModes).toEqual(['lexical'])
    expect(verified.identity.analyzerConfigIdentity).toBe(ANALYZER_IDENTITY)
    expect(verified.aggregate.queryCount).toBe(dataset.scenarios.length)
    expect(verified.aggregate.zeroToleranceViolations).toBe(0)
    expect(verified.validForGate).toBe(true)
    expect(verified.dirtyWorktree).toBe(false)
  })

  it('rejects a summary carrying an unknown field', () => {
    const tampered = withSummary(runA, summary => void (summary.qualified = true))
    expect(fault(() => benchmarkPacket(tampered))).toMatchObject({ fault: 'schema', reason: 'benchmark_summary_invalid' })
  })

  it('rejects a summary whose commit could not be resolved to a real sha', () => {
    const tampered = withSummary(runA, summary => void (summary.commitSha = 'unknown'))
    expect(fault(() => benchmarkPacket(tampered))).toMatchObject({ reason: 'benchmark_summary_invalid' })
  })

  it('rejects a scenario-results line that is not JSON', () => {
    const tampered = { ...runA, scenarioResultsText: `${runA.scenarioResultsText}not json\n` }
    expect(fault(() => benchmarkPacket(tampered))).toMatchObject({ fault: 'schema', reason: 'scenario_results_malformed_json' })
  })

  it('rejects a scenario-results record with an unknown field', () => {
    const tampered = withRows(runA, rows => rows.map((row, index) => index === 0 ? { ...row, waived: true } : row))
    expect(fault(() => benchmarkPacket(tampered))).toMatchObject({ fault: 'schema', reason: 'scenario_results_invalid' })
  })

  it('rejects a repeated scenario row', () => {
    const tampered = withRows(runA, rows => [...rows, rows[0]!])
    expect(fault(() => benchmarkPacket(tampered))).toMatchObject({ reason: 'scenario_results_duplicate_scenario' })
  })

  it('rejects two scenario rows reporting the same retrieval query', () => {
    const tampered = withRows(runA, rows => [...rows, { ...rows[0]!, scenarioId: 'RET-011' }])
    expect(fault(() => benchmarkPacket(tampered))).toMatchObject({ reason: 'scenario_results_duplicate_query' })
  })

  it('rejects an empty scenario-results file', () => {
    expect(fault(() => benchmarkPacket({ ...runA, scenarioResultsText: '\n' }))).toMatchObject({ reason: 'scenario_results_empty' })
  })

  it('rejects a summary naming a dataset version this build does not carry', () => {
    const tampered = withSummary(runA, summary => void (summary.datasetVersion = '9.9.9'))
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ fault: 'schema', reason: 'dataset_version_not_recognized' })
  })

  it('rejects a summary naming a dataset digest that is not the frozen dataset', () => {
    const tampered = withSummary(runA, summary => void (summary.datasetDigest = '0'.repeat(64)))
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ fault: 'integrity', reason: 'dataset_digest_mismatch' })
  })

  it('rejects a run whose summary counts more results than the rows carry', () => {
    const tampered = withRows(runA, rows => rows.slice(1))
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ reason: 'scenario_result_count_mismatch' })
  })

  it('rejects a row whose seed disagrees with the summary', () => {
    const tampered = withRows(runA, rows => rows.map((row, index) => index === 0 ? { ...row, seed: 1 } : row))
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ reason: 'scenario_result_seed_mismatch' })
  })
})

// The summary's retrieval block is re-derived from the per-query rows against
// the frozen dataset. Editing either side alone makes them contradict.
describe('benchmark retrieval recomputation', () => {
  function tamperFirstQuery(mutate: (retrieval: Record<string, unknown>) => Record<string, unknown>): BenchmarkRunArtifacts {
    return withRows(runA, rows => rows.map((row, index) => index === 0 ? { ...row, retrieval: mutate(retrievalOf(row)) } : row))
  }

  it('rejects altered per-query metrics', () => {
    // Precision, not recall: the first query already recalls everything, so
    // overwriting recall with 1 would be a no-op the test could not detect.
    const tampered = tamperFirstQuery(retrieval => ({ ...retrieval, metrics: { ...(retrieval.metrics as Record<string, unknown>), precisionAtCutoff: 1 } }))
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ fault: 'integrity', reason: 'retrieval_evidence_recomputation_failed' })
  })

  it('rejects an altered relevance label', () => {
    const tampered = tamperFirstQuery((retrieval) => {
      const ranked = (retrieval.rankedItems as Record<string, unknown>[]).map(item => ({ ...item, relevance: 0 }))
      return { ...retrieval, rankedItems: ranked }
    })
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ reason: 'retrieval_evidence_recomputation_failed' })
  })

  it('rejects an altered ranking', () => {
    const tampered = tamperFirstQuery((retrieval) => {
      const ranked = (retrieval.rankedItems as Record<string, unknown>[]).map(item => ({ ...item, rank: 2 }))
      return { ...retrieval, rankedItems: ranked }
    })
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ reason: 'retrieval_evidence_recomputation_failed' })
  })

  it.each(['authorizationViolations', 'lifecycleViolations', 'temporalViolations'])('rejects invented %s', (field) => {
    const tampered = tamperFirstQuery(retrieval => ({ ...retrieval, [field]: ['fabricated-item'] }))
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ reason: 'retrieval_evidence_recomputation_failed' })
  })

  it('rejects a run whose queries were not all executed', () => {
    const tampered = withSummary(withRows(runA, rows => rows.slice(1)), (summary) => {
      const counts = summary.counts as Record<string, unknown>
      counts.total = dataset.scenarios.length - 1
    })
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ reason: 'retrieval_evidence_recomputation_failed' })
  })

  it('rejects an altered aggregate in the summary', () => {
    const tampered = withSummary(runA, (summary) => {
      const retrieval = summary.retrieval as Record<string, unknown>
      const aggregate = retrieval.aggregate as Record<string, unknown>
      aggregate.meanPrecisionAtCutoff = 1
    })
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ fault: 'integrity', reason: 'retrieval_aggregate_mismatch' })
  })

  it('rejects an altered normalized result digest', () => {
    const tampered = withSummary(runA, summary => void (summary.normalizedResultDigest = 'f'.repeat(64)))
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ fault: 'integrity', reason: 'normalized_result_digest_mismatch' })
  })

  it('rejects retrieval evidence naming a gated mode', () => {
    const tampered = withRows(runA, rows => rows.map(row => ({ ...row, retrieval: { ...retrievalOf(row), requestedModes: ['vector'] } })))
    // aggregateRetrieval refuses this first: the frozen dataset says lexical.
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ reason: 'retrieval_evidence_recomputation_failed' })
  })

  it('rejects a summary with no retrieval evidence at all', () => {
    const tampered = withSummary(runA, summary => void delete summary.retrieval)
    expect(fault(() => verifyRetrievalBenchmarkPacket(benchmarkPacket(tampered)))).toMatchObject({ fault: 'schema', reason: 'retrieval_evidence_missing' })
  })
})

describe('qualification identity comparison', () => {
  const identity: RetrievalQualificationIdentity = {
    candidateCommit: CANDIDATE_COMMIT,
    datasetVersion: '2.0.0',
    datasetDigest: 'b'.repeat(64),
    evaluatorSchemaVersion: 2,
    analyzerConfigIdentity: ANALYZER_IDENTITY,
    requestedModes: ['lexical'],
    normalizedResultDigest: 'c'.repeat(64),
  }

  it('accepts identical identities', () => {
    expect(() => assertQualificationIdentityMatches(identity, { ...identity }, 'run_identity_mismatch')).not.toThrow()
  })

  // Unlike assertCompatibleExperiments, which compares two experiments and
  // tolerates differing commits, qualification names one immutable commit.
  it('requires the candidate commit to match', () => {
    expect(fault(() => assertQualificationIdentityMatches(identity, { ...identity, candidateCommit: 'd'.repeat(40) }, 'run_identity_mismatch')))
      .toMatchObject({ reason: 'run_identity_mismatch:candidateCommit' })
  })

  it.each(['datasetVersion', 'datasetDigest', 'analyzerConfigIdentity', 'normalizedResultDigest'] as const)('requires %s to match', (field) => {
    expect(fault(() => assertQualificationIdentityMatches(identity, { ...identity, [field]: 'different' }, 'run_identity_mismatch')))
      .toMatchObject({ reason: `run_identity_mismatch:${field}` })
  })

  it('requires the evaluator schema version to match', () => {
    expect(fault(() => assertQualificationIdentityMatches(identity, { ...identity, evaluatorSchemaVersion: 3 }, 'run_identity_mismatch')))
      .toMatchObject({ reason: 'run_identity_mismatch:evaluatorSchemaVersion' })
  })

  it.each([[['vector']], [['lexical', 'vector']], [[]]])('rejects the requested mode set %j', (modes) => {
    expect(fault(() => assertQualificationIdentityMatches(identity, { ...identity, requestedModes: modes }, 'run_identity_mismatch')))
      .toMatchObject({ reason: 'run_identity_mismatch:requestedModes' })
  })
})

describe('two-run reproducibility', () => {
  it('rejects a pair produced from different commits', () => {
    const other = benchmarkRunArtifacts({ commitSha: 'b'.repeat(40) })
    expect(fault(() => qualify({ b: other }))).toMatchObject({ reason: 'run_identity_mismatch:candidateCommit' })
  })

  it('rejects a pair whose analyzer configurations differ', () => {
    const other = withSummary(runB, summary => void (summary.analyzerConfigIdentity = 'sqlite-fts5-other-schema'))
    expect(fault(() => qualify({ b: other }))).toMatchObject({ reason: 'run_identity_mismatch:analyzerConfigIdentity' })
  })

  it('rejects a pair whose normalized results differ', () => {
    const other = benchmarkRunArtifacts({ seed: 20260803 })
    expect(fault(() => qualify({ b: other }))).toMatchObject({ reason: 'run_identity_mismatch:normalizedResultDigest' })
  })

  it('rejects a single run presented twice as a pair', () => {
    // Every recomputed value agrees — it is the same run — but the decision
    // committed to two distinct sets of artifact bytes and only one is here.
    expect(fault(() => qualify({ a: runA, b: runA, policy: passingPolicy, decision: acceptingDecision })))
      .toMatchObject({ reason: 'decision_run_b_artifact_hash_mismatch:summarySha256' })
  })
})

describe('benchmark validity blocks qualification before governance', () => {
  it('rejects a dirty run A', () => {
    const dirty = benchmarkRunArtifacts({ dirtyWorktree: true, generatedAt: '2026-08-08T01:00:00Z' })
    const result = qualify({ a: dirty, policy: passingPolicy, decision: acceptingDecision })
    expect(result.status).toBe('rejected')
    expect(result.reasons).toEqual(['run_a_dirty_worktree'])
  })

  it('rejects a dirty run B', () => {
    const dirty = benchmarkRunArtifacts({ dirtyWorktree: true, generatedAt: '2026-08-08T03:00:00Z' })
    const result = qualify({ b: dirty, policy: passingPolicy, decision: acceptingDecision })
    expect(result.status).toBe('rejected')
    expect(result.reasons).toEqual(['run_b_dirty_worktree'])
  })

  it('rejects a run with a failed assertion', () => {
    const results = passingRetrievalResults()
    results[0] = {
      ...results[0]!,
      outcome: 'failed',
      assertions: results[0]!.assertions.map(assertion => ({ ...assertion, passed: false })),
    }
    const failed = benchmarkRunArtifacts({ results })
    const result = qualify({ a: failed, b: failed, policy: passingPolicy, decision: acceptingDecision })
    expect(result.status).toBe('rejected')
    expect(result.reasons).toContain('run_a_not_valid_for_gate')
  })

  it('rejects a run whose cleanup failed', () => {
    const results = passingRetrievalResults()
    results[0] = { ...results[0]!, cleanup: 'failed' }
    const unclean = benchmarkRunArtifacts({ results })
    const result = qualify({ a: unclean, b: unclean, policy: passingPolicy, decision: acceptingDecision })
    expect(result.status).toBe('rejected')
    expect(result.reasons).toContain('run_a_not_valid_for_gate')
  })

  // A retrieval leak is a hard invariant, not gradeable quality: no approved
  // floor, however generous, may buy one off.
  it('rejects a run that returned an unauthorized item', () => {
    const leaking = benchmarkRunArtifacts({ results: leakingResults() })
    const result = qualify({ a: leaking, b: leaking, policy: policyWith([{ name: 'floor', metric: 'meanRecallAtCutoff', operation: '>=', value: 0 }]), decision: acceptingDecision })
    expect(result.status).toBe('rejected')
    expect(result.reasons).toContain('retrieval_zero_tolerance_violation')
  })
})

describe('governance evidence absence', () => {
  it('reports measured_not_evaluated with neither policy nor decision', () => {
    const result = qualify()
    expect(result.status).toBe('measured_not_evaluated')
    expect(result.reasons).toEqual(['approved_policy_missing', 'independent_decision_missing'])
    expect(retrievalIsFormallyQualified(result)).toBe(false)
  })

  it('reports measured_not_evaluated with a policy but no decision', () => {
    const result = qualify({ policy: passingPolicy })
    expect(result.status).toBe('measured_not_evaluated')
    expect(result.reasons).toEqual(['independent_decision_missing'])
  })

  it('reports measured_not_evaluated with a decision but no policy', () => {
    const result = qualify({ decision: acceptingDecision })
    expect(result.status).toBe('measured_not_evaluated')
    expect(result.reasons).toEqual(['approved_policy_missing'])
  })

  it('still names the benchmark identity when nothing was approved', () => {
    const result = qualify()
    expect(result.candidateCommit).toBe(CANDIDATE_COMMIT)
    expect(result.normalizedResultDigest).toBe(NORMALIZED_DIGEST)
    expect(result.policyDigest).toBeUndefined()
    expect(result.decision).toBeUndefined()
  })
})

// A policy parsed against one benchmark must not grade another. The parser is
// given the expectation by its caller, so qualifyRetrieval re-checks rather
// than trusting the caller to have asked the right question.
describe('policy binding to benchmark evidence', () => {
  it('rejects a policy approved against another commit', () => {
    const policy = parseRetrievalPolicy(approvedPolicyObject({ repositoryCommit: 'e'.repeat(40) }), benchmarkIdentity({ repositoryCommit: 'e'.repeat(40) }))
    expect(fault(() => qualify({ policy, decision: acceptingDecision }))).toMatchObject({ reason: 'policy_identity_mismatch:candidateCommit' })
  })

  it('rejects a policy approved against another analyzer configuration', () => {
    const policy = parseRetrievalPolicy(approvedPolicyObject({ analyzerConfigIdentity: 'sqlite-fts5-other' }), benchmarkIdentity({ analyzerConfigIdentity: 'sqlite-fts5-other' }))
    expect(fault(() => qualify({ policy, decision: acceptingDecision }))).toMatchObject({ reason: 'policy_identity_mismatch:analyzerConfigIdentity' })
  })

  it('rejects a policy approved against another evaluator schema version', () => {
    const policy = parseRetrievalPolicy(approvedPolicyObject({ evaluatorSchemaVersion: 99 }), benchmarkIdentity({ evaluatorSchemaVersion: 99 }))
    expect(fault(() => qualify({ policy, decision: acceptingDecision }))).toMatchObject({ reason: 'policy_identity_mismatch:evaluatorSchemaVersion' })
  })

  it('rejects a policy approved against another dataset', () => {
    const policy = parseRetrievalPolicy(approvedPolicyObject({ datasetDigest: '1'.repeat(64) }), benchmarkIdentity({ datasetDigest: '1'.repeat(64) }))
    expect(fault(() => qualify({ policy, decision: acceptingDecision }))).toMatchObject({ reason: 'policy_identity_mismatch:datasetDigest' })
  })
})

describe('independent decision parsing', () => {
  it('rejects an unknown field', () => {
    expect(fault(() => decisionFor({ independent: true }))).toMatchObject({ fault: 'schema', reason: 'independent_decision_invalid' })
  })

  it.each(['approved', 'pending', '', true])('rejects the unsupported decision value %j', (decision) => {
    expect(fault(() => decisionFor({ decision }))).toMatchObject({ reason: 'independent_decision_invalid' })
  })

  it('rejects an empty evaluator', () => {
    expect(fault(() => decisionFor({ evaluator: '' }))).toMatchObject({ reason: 'independent_decision_invalid' })
  })

  it('rejects an empty source', () => {
    expect(fault(() => decisionFor({ source: '' }))).toMatchObject({ reason: 'independent_decision_invalid' })
  })

  it('rejects an invalid decision date', () => {
    expect(fault(() => decisionFor({ decidedAt: 'yesterday' }))).toMatchObject({ reason: 'independent_decision_invalid' })
  })

  it('rejects a malformed candidate commit', () => {
    expect(fault(() => decisionFor({ candidateCommit: 'abc' }))).toMatchObject({ reason: 'independent_decision_invalid' })
  })

  it('rejects a malformed artifact hash', () => {
    expect(fault(() => decisionFor({ runA: { ...artifactHashes(runA), reportSha256: 'nope' } }))).toMatchObject({ reason: 'independent_decision_invalid' })
  })

  it('rejects a duplicated mode', () => {
    expect(fault(() => decisionFor({ requestedModes: ['lexical', 'lexical'] }))).toMatchObject({ reason: 'independent_decision_duplicate_mode' })
  })

  it.each(['vector', 'graph'])('rejects a decision naming the gated mode %s', (mode) => {
    expect(fault(() => decisionFor({ requestedModes: [mode] }))).toMatchObject({ reason: 'independent_decision_mode_not_qualifiable' })
  })
})

describe('decision binding to supplied evidence', () => {
  it('rejects a decision made about another candidate commit', () => {
    const decision = decisionFor({ candidateCommit: 'b'.repeat(40) })
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: 'decision_identity_mismatch:candidateCommit' })
  })

  it('rejects a decision made about another dataset', () => {
    const decision = decisionFor({ datasetDigest: '2'.repeat(64) })
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: 'decision_identity_mismatch:datasetDigest' })
  })

  it('rejects a decision made about another evaluator schema version', () => {
    const decision = decisionFor({ evaluatorSchemaVersion: 99 })
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: 'decision_identity_mismatch:evaluatorSchemaVersion' })
  })

  it('rejects a decision made about another analyzer configuration', () => {
    const decision = decisionFor({ analyzerConfigIdentity: 'sqlite-fts5-other' })
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: 'decision_identity_mismatch:analyzerConfigIdentity' })
  })

  it('rejects a decision made about another benchmark result', () => {
    const decision = decisionFor({ normalizedResultDigest: '3'.repeat(64) })
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: 'decision_identity_mismatch:normalizedResultDigest' })
  })

  it('rejects a decision made about another policy document', () => {
    const decision = decisionFor({}, {}, '4'.repeat(64))
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: 'decision_policy_digest_mismatch' })
  })

  // The approver's bytes changed after the decision was written; the decision
  // still names the digest it actually reviewed.
  it('rejects an accepted decision paired with a re-approved policy', () => {
    const rewritten = policyWith([{ name: 'mean-recall-floor', metric: 'meanRecallAtCutoff', operation: '>=', value: 0.1 }])
    expect(fault(() => qualify({ policy: rewritten, decision: acceptingDecision }))).toMatchObject({ reason: 'decision_policy_digest_mismatch' })
  })

  it.each(['summarySha256', 'scenarioResultsSha256', 'reportSha256'] as const)('rejects a decision naming a different run-A %s', (field) => {
    const decision = decisionFor({ runA: { ...artifactHashes(runA), [field]: '5'.repeat(64) } })
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: `decision_run_a_artifact_hash_mismatch:${field}` })
  })

  it.each(['summarySha256', 'scenarioResultsSha256', 'reportSha256'] as const)('rejects a decision naming a different run-B %s', (field) => {
    const decision = decisionFor({ runB: { ...artifactHashes(runB), [field]: '6'.repeat(64) } })
    expect(fault(() => qualify({ policy: passingPolicy, decision }))).toMatchObject({ reason: `decision_run_b_artifact_hash_mismatch:${field}` })
  })

  // Same values, different bytes: the report was regenerated after review.
  it('rejects an accepted decision paired with republished benchmark bytes', () => {
    const republished = benchmarkRunArtifacts({ generatedAt: '2026-08-09T09:00:00Z' })
    expect(fault(() => qualify({ a: republished, policy: passingPolicy, decision: acceptingDecision })))
      .toMatchObject({ reason: 'decision_run_a_artifact_hash_mismatch:summarySha256' })
  })
})

describe('qualification verdicts', () => {
  it('rejects when an approved quality limit is missed', () => {
    const decision = decisionFor({}, {}, failingPolicy.policyDigest)
    const result = qualify({ policy: failingPolicy, decision })
    expect(result.status).toBe('rejected')
    expect(result.reasons).toEqual(['policy_limit_failed'])
    expect(result.decision).toBe('accepted')
    expect(retrievalIsFormallyQualified(result)).toBe(false)
  })

  it('rejects when the independent evaluator rejected', () => {
    const result = qualify({ policy: passingPolicy, decision: decisionFor({ decision: 'rejected' }) })
    expect(result.status).toBe('rejected')
    expect(result.reasons).toEqual(['independent_decision_rejected'])
    expect(result.decision).toBe('rejected')
  })

  it('reports both a missed limit and an independent rejection', () => {
    const decision = decisionFor({ decision: 'rejected' }, {}, failingPolicy.policyDigest)
    const result = qualify({ policy: failingPolicy, decision })
    expect(result.reasons).toEqual(['policy_limit_failed', 'independent_decision_rejected'])
  })

  it('accepts only the complete, fully matching case', () => {
    const result = qualify({ policy: passingPolicy, decision: acceptingDecision })
    expect(result.status).toBe('accepted')
    expect(result.reasons).toEqual([])
    expect(result.candidateCommit).toBe(CANDIDATE_COMMIT)
    expect(result.requestedModes).toEqual(['lexical'])
    expect(result.normalizedResultDigest).toBe(NORMALIZED_DIGEST)
    expect(result.policyDigest).toBe(passingPolicy.policyDigest)
    expect(result.decision).toBe('accepted')
    expect(retrievalIsFormallyQualified(result)).toBe(true)
  })

  it('carries only identifiers and reason codes, never query text or corpus content', () => {
    const result = qualify({ policy: passingPolicy, decision: acceptingDecision })
    expect(Object.keys(result).sort()).toEqual([
      'analyzerConfigIdentity',
      'candidateCommit',
      'datasetDigest',
      'datasetVersion',
      'decision',
      'evaluatorSchemaVersion',
      'normalizedResultDigest',
      'policyDigest',
      'reasons',
      'requestedModes',
      'status',
    ])

    const serialized = JSON.stringify(result)
    for (const scenario of dataset.scenarios) {
      expect(serialized).not.toContain(scenario.retrieval!.query)
      for (const item of scenario.retrieval!.corpus)
        expect(serialized).not.toContain(item.content)
    }
    // No measured value reaches the verdict; a reader cannot recover the
    // metrics from a result, only whether they satisfied an approved floor.
    expect(serialized).not.toContain(String(measured.meanPrecisionAtCutoff))
  })
})

/**
 * A run identical to the clean one except that RET-009 also returned the
 * unauthorized decoy from its corpus.
 *
 * Quality metrics are untouched: the unauthorized item is not part of the
 * relevant/irrelevant subset the metrics score, which is exactly why a leak
 * cannot be detected by watching precision and recall.
 */
function leakingResults(): (ScenarioResult & { elapsedMs: number })[] {
  const results = passingRetrievalResults()
  const index = results.findIndex(result => result.scenarioId === 'RET-009')
  const specification = dataset.scenarios.find(scenario => scenario.scenarioId === 'RET-009')!.retrieval!
  const unauthorized = specification.corpus.find(item => item.role === 'unauthorized_relevant')!
  const previous = results[index]!.retrieval!
  results[index] = {
    ...results[index]!,
    retrieval: {
      ...previous,
      rankedItems: [
        ...previous.rankedItems,
        {
          itemId: unauthorized.itemId,
          rank: previous.rankedItems.length + 1,
          relevance: specification.judgments.find(judgment => judgment.itemId === unauthorized.itemId)!.relevance,
          mode: 'lexical',
          features: { bm25: 0.5 },
        },
      ],
      authorizationViolations: [unauthorized.itemId],
    },
  }
  return results
}
