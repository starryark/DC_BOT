import type { RetrievalPolicyExpectedIdentity } from './policy'
import type { RetrievalAggregate } from './report'

import { describe, expect, it } from 'vitest'

import { EVALUATOR_SCHEMA_VERSION, sha256Canonical } from '../contracts'
import { MULTILINGUAL_V1_VERSION, multilingualV1Digest } from '../dataset'
import { evaluateRetrievalPolicy, parseRetrievalPolicy, retrievalPolicyDigest } from './policy'

/**
 * Approved retrieval-policy contract tests (IMP-607 governance, T001).
 *
 * These are substitution tests, not happy-path tests: the interesting failure
 * is a real approval document pointed at evidence it was not approved for. Each
 * case alters exactly one provenance field, one limit, or one byte, and every
 * one of them must be a rejection rather than a quietly accepted grading.
 */

const CANDIDATE_COMMIT = 'a'.repeat(40)
const ANALYZER_IDENTITY = 'sqlite-fts5-latin-unicode61-cjk-trigram-schema-v9'

/** The identity a lexical multilingual-v1 benchmark run presents to a policy. */
const expected: RetrievalPolicyExpectedIdentity = {
  repositoryCommit: CANDIDATE_COMMIT,
  datasetVersion: MULTILINGUAL_V1_VERSION,
  datasetDigest: multilingualV1Digest(),
  evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
  analyzerConfigIdentity: ANALYZER_IDENTITY,
  requestedModes: ['lexical'],
}

function policyContent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    approver: 'retrieval-governance-owner',
    approvedAt: '2026-08-08T00:00:00Z',
    source: 'external-approval-record',
    repositoryCommit: CANDIDATE_COMMIT,
    datasetVersion: MULTILINGUAL_V1_VERSION,
    datasetDigest: multilingualV1Digest(),
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    analyzerConfigIdentity: ANALYZER_IDENTITY,
    requestedModes: ['lexical'],
    limits: [{ name: 'mean-recall-floor', metric: 'meanRecallAtCutoff', operation: '>=', value: 0.9 }],
    ...overrides,
  }
}

/**
 * Attach a digest computed by the documented canonical rule.
 *
 * Adversarial cases are signed too, so each one fails on the defect under test
 * rather than on a digest that happens to be stale.
 */
function sign(content: Record<string, unknown>): Record<string, unknown> {
  return { ...content, policyDigest: sha256Canonical(content) }
}

/** A whole-run aggregate with every graded mean at 0.9 and no violations. */
function aggregate(overrides: Partial<RetrievalAggregate> = {}): RetrievalAggregate {
  return {
    queryCount: 10,
    relevantReturned: 9,
    irrelevantReturned: 1,
    relevantMissed: 1,
    precisionAtCutoff: 0.9,
    recallAtCutoff: 0.9,
    reciprocalRank: 0.9,
    meanPrecisionAtCutoff: 0.9,
    meanRecallAtCutoff: 0.9,
    meanReciprocalRank: 0.9,
    zeroToleranceViolations: 0,
    ...overrides,
  }
}

describe('retrieval policy parsing', () => {
  it('accepts a lexical policy whose provenance matches the benchmark evidence', () => {
    const policy = parseRetrievalPolicy(sign(policyContent()), expected)
    expect(policy.approver).toBe('retrieval-governance-owner')
    expect(policy.requestedModes).toEqual(['lexical'])
    expect(policy.limits).toHaveLength(1)
  })

  it('binds the digest to the canonical contents excluding the digest field', () => {
    const content = policyContent()
    const policy = parseRetrievalPolicy(sign(content), expected)
    const { policyDigest, ...carried } = policy
    expect(retrievalPolicyDigest(carried)).toBe(policyDigest)
    expect(policyDigest).toBe(sha256Canonical(content))
  })

  it('accepts a re-indented document with reordered keys as the same policy', () => {
    const content = policyContent()
    const signed = sign(content)
    const reordered = Object.fromEntries(Object.keys(signed).sort().reverse().map(key => [key, signed[key]]))
    expect(parseRetrievalPolicy(reordered, expected).policyDigest).toBe(signed.policyDigest)
  })

  it('rejects an unknown field', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ waiver: 'approved anyway' })), expected)).toThrow(/strict validation/)
  })

  it('rejects a malformed dataset digest', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ datasetDigest: 'not-a-sha' })), expected)).toThrow(/strict validation/)
  })

  it('rejects a malformed repository commit', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ repositoryCommit: 'abc1234' })), expected)).toThrow(/strict validation/)
  })

  it('rejects a malformed policy digest', () => {
    expect(() => parseRetrievalPolicy({ ...policyContent(), policyDigest: 'short' }, expected)).toThrow(/strict validation/)
  })

  it('rejects a policy approved against another repository commit', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ repositoryCommit: 'b'.repeat(40) })), expected)).toThrow(/repositoryCommit/)
  })

  it('rejects a policy approved against another dataset version', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ datasetVersion: '9.9.9' })), expected)).toThrow(/datasetVersion/)
  })

  it('rejects a policy approved against another dataset digest', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ datasetDigest: '0'.repeat(64) })), expected)).toThrow(/datasetDigest/)
  })

  it('rejects a policy approved against another evaluator schema version', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION + 1 })), expected)).toThrow(/evaluatorSchemaVersion/)
  })

  it('rejects a policy approved against another analyzer configuration', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ analyzerConfigIdentity: 'sqlite-fts5-other' })), expected)).toThrow(/analyzerConfigIdentity/)
  })
})

// ADR-011: vector and graph retrieval are gated on evidence that does not
// exist. A policy naming them describes a benchmark the evaluator refuses to
// run, so it must never reach the provenance comparison as merely "different".
describe('retrieval policy mode gating', () => {
  it.each(['vector', 'graph'])('rejects a %s policy against lexical evidence', (mode) => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ requestedModes: [mode] })), expected)).toThrow(/gated and cannot be qualified/)
  })

  it('rejects a policy that widens lexical evidence with a gated mode', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ requestedModes: ['lexical', 'vector'] })), expected)).toThrow(/gated and cannot be qualified/)
  })

  it('rejects a duplicated mode', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ requestedModes: ['lexical', 'lexical'] })), expected)).toThrow(/more than once/)
  })

  it('rejects an empty mode list', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ requestedModes: [] })), expected)).toThrow(/strict validation/)
  })
})

describe('retrieval policy limits', () => {
  it('rejects a metric graded twice', () => {
    const limits = [
      { name: 'floor-a', metric: 'meanRecallAtCutoff', operation: '>=', value: 0.5 },
      { name: 'floor-b', metric: 'meanRecallAtCutoff', operation: '>=', value: 0.9 },
    ]
    expect(() => parseRetrievalPolicy(sign(policyContent({ limits })), expected)).toThrow(/grades meanRecallAtCutoff more than once/)
  })

  it('rejects two limits sharing one name', () => {
    const limits = [
      { name: 'floor', metric: 'meanRecallAtCutoff', operation: '>=', value: 0.5 },
      { name: 'floor', metric: 'meanPrecisionAtCutoff', operation: '>=', value: 0.5 },
    ]
    expect(() => parseRetrievalPolicy(sign(policyContent({ limits })), expected)).toThrow(/same name/)
  })

  it.each(['authorizationViolations', 'zeroToleranceViolations', 'queryCount', 'relevantReturned'])('rejects the unknown metric %s', (metric) => {
    const limits = [{ name: 'floor', metric, operation: '>=', value: 0 }]
    expect(() => parseRetrievalPolicy(sign(policyContent({ limits })), expected)).toThrow(/strict validation/)
  })

  it.each(['<=', '<', '>', '=='])('rejects the unsupported operation %s', (operation) => {
    const limits = [{ name: 'floor', metric: 'meanRecallAtCutoff', operation, value: 0.9 }]
    expect(() => parseRetrievalPolicy(sign(policyContent({ limits })), expected)).toThrow(/strict validation/)
  })

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])('rejects the non-finite limit value %s', (value) => {
    const limits = [{ name: 'floor', metric: 'meanRecallAtCutoff', operation: '>=', value }]
    expect(() => parseRetrievalPolicy(sign(policyContent({ limits })), expected)).toThrow(/strict validation/)
  })

  it('rejects an empty limit list', () => {
    expect(() => parseRetrievalPolicy(sign(policyContent({ limits: [] })), expected)).toThrow(/strict validation/)
  })
})

// The approver's signature covers the bytes. Editing a value after approval
// while keeping the digest is the substitution this binding exists to stop.
describe('retrieval policy tamper resistance', () => {
  it('rejects an altered limit value carrying the original digest', () => {
    const signed = sign(policyContent())
    const altered = { ...signed, limits: [{ name: 'mean-recall-floor', metric: 'meanRecallAtCutoff', operation: '>=', value: 0.1 }] }
    expect(() => parseRetrievalPolicy(altered, expected)).toThrow(/digest does not match/)
  })

  it('rejects an altered approver carrying the original digest', () => {
    const signed = sign(policyContent())
    expect(() => parseRetrievalPolicy({ ...signed, approver: 'someone-else' }, expected)).toThrow(/digest does not match/)
  })

  it('rejects a digest copied from a different approved policy', () => {
    const other = sign(policyContent({ approvedAt: '2026-01-01T00:00:00Z' }))
    expect(() => parseRetrievalPolicy({ ...policyContent(), policyDigest: other.policyDigest }, expected)).toThrow(/digest does not match/)
  })
})

describe('retrieval policy evaluation', () => {
  function policyWithFloor(value: number, metric = 'meanRecallAtCutoff') {
    return parseRetrievalPolicy(sign(policyContent({ limits: [{ name: 'floor', metric, operation: '>=', value }] })), expected)
  }

  it('passes when every approved limit is met', () => {
    const evaluation = evaluateRetrievalPolicy(aggregate(), policyWithFloor(0.85))
    expect(evaluation.status).toBe('passed')
    expect(evaluation.failedLimitNames).toEqual([])
    expect(evaluation.limits[0]?.status).toBe('passed')
  })

  it('fails and names the missed limit when an approved floor is not met', () => {
    const evaluation = evaluateRetrievalPolicy(aggregate(), policyWithFloor(0.95))
    expect(evaluation.status).toBe('failed')
    expect(evaluation.failedLimitNames).toEqual(['floor'])
    expect(evaluation.limits[0]?.status).toBe('failed')
  })

  it('reports failed limit names sorted so run order cannot change the output', () => {
    const limits = [
      { name: 'z-precision', metric: 'meanPrecisionAtCutoff', operation: '>=', value: 1 },
      { name: 'a-recall', metric: 'meanRecallAtCutoff', operation: '>=', value: 1 },
    ]
    const policy = parseRetrievalPolicy(sign(policyContent({ limits })), expected)
    expect(evaluateRetrievalPolicy(aggregate(), policy).failedLimitNames).toEqual(['a-recall', 'z-precision'])
  })

  // A quality policy grades quality. Authorization, lifecycle, and temporal
  // correctness are invariants, and no set of approved floors may buy them off.
  it('fails a run with zero-tolerance violations even when every limit passes', () => {
    const evaluation = evaluateRetrievalPolicy(aggregate({ zeroToleranceViolations: 1 }), policyWithFloor(0))
    expect(evaluation.status).toBe('failed')
    expect(evaluation.failedLimitNames).toEqual([])
    expect(evaluation.zeroToleranceViolations).toBe(1)
  })

  it('takes every numeric threshold from the document rather than from code', () => {
    // The measured mean is 0.9; the verdict flips exactly where the approved
    // document says it should, including at equality, and nowhere else.
    const sweep = [[0, 'passed'], [0.5, 'passed'], [0.9, 'passed'], [0.900001, 'failed'], [1, 'failed']] as const
    for (const [value, status] of sweep)
      expect(evaluateRetrievalPolicy(aggregate(), policyWithFloor(value)).status, `floor ${value}`).toBe(status)
  })

  it('grades each approved metric against its own measured mean', () => {
    expect(evaluateRetrievalPolicy(aggregate({ meanPrecisionAtCutoff: 0.2 }), policyWithFloor(0.5, 'meanPrecisionAtCutoff')).status).toBe('failed')
    expect(evaluateRetrievalPolicy(aggregate({ meanPrecisionAtCutoff: 0.2 }), policyWithFloor(0.5, 'meanReciprocalRank')).status).toBe('passed')
  })
})
