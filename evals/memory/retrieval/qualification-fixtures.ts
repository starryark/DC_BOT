import type { RetrievalQueryResult, RetrievalSpec, ScenarioResult } from '../contracts'
import type { RetrievalPolicyExpectedIdentity } from './policy'
import type { RetrievalBenchmarkPacket, RetrievalRunArtifactHashes } from './qualification'

import { EVALUATOR_SCHEMA_VERSION, sha256Canonical } from '../contracts'
import { MULTILINGUAL_V1_VERSION, multilingualV1Dataset, multilingualV1Digest } from '../dataset'
import { buildReport } from '../report'
import { computeRetrievalMetrics } from './metrics'
import { parseEvaluationSummaryArtifact, parseScenarioResultsJsonl, sha256Bytes } from './qualification'

/**
 * Synthetic benchmark, policy, and decision artifacts for the retrieval
 * qualification tests (IMP-607, T004).
 *
 * The qualification verifier only ever sees published bytes, so these fixtures
 * produce the real thing: a genuine {@link ../report.ts#buildReport} output
 * serialized exactly as `scripts/memory/evaluate.ts` writes it. Hand-written
 * summary objects would let a test pass against a shape the evaluator never
 * emits, which is the one failure mode a governance test cannot afford.
 *
 * Adversarial cases mutate these bytes rather than bypassing them, so each test
 * exercises the same parse-and-recompute path a real tampered artifact would.
 */

/** The immutable commit a qualification candidate is pinned to in tests. */
export const CANDIDATE_COMMIT = 'a'.repeat(40)

/** The analyzer identity {@link ../report.ts#buildReport} stamps into a summary. */
export const ANALYZER_IDENTITY = 'sqlite-fts5-latin-unicode61-cjk-trigram-schema-v9'

export const QUALIFICATION_SEED = 20260802

const dataset = multilingualV1Dataset()

/**
 * One query's result: the single relevant corpus item ranked first, nothing
 * else returned.
 *
 * Metrics come from {@link ./metrics.ts#computeRetrievalMetrics} rather than
 * from literals, so the fixture is self-consistent by construction and a test
 * that fails is reporting a defect rather than an arithmetic slip. Queries with
 * no relevant item (the lifecycle-invalid corpus) return nothing at all, which
 * is the correct behaviour, not an empty result standing in for one.
 */
function retrievalResultFor(specification: RetrievalSpec): RetrievalQueryResult {
  const relevant = specification.corpus.find(item => item.role === 'relevant')
  const rankedItems = relevant
    ? [{
        itemId: relevant.itemId,
        rank: 1,
        relevance: specification.judgments.find(judgment => judgment.itemId === relevant.itemId)!.relevance,
        mode: 'lexical',
        features: { bm25: 1 },
      }]
    : []

  // Quality metrics are scored over the relevant/irrelevant subset only; the
  // authorization, lifecycle, and temporal decoys are correctness evidence.
  const qualityIds = new Set(specification.corpus.filter(item => item.role === 'relevant' || item.role === 'irrelevant').map(item => item.itemId))

  return {
    queryId: specification.queryId,
    cutoff: specification.cutoff,
    requestedModes: specification.requestedModes,
    appliedModes: ['lexical'],
    rankedItems,
    metrics: computeRetrievalMetrics(
      rankedItems.filter(item => qualityIds.has(item.itemId)),
      specification.judgments.filter(judgment => qualityIds.has(judgment.itemId)),
      specification.cutoff,
    ),
    authorizationViolations: [],
    lifecycleViolations: [],
    temporalViolations: [],
  }
}

/** A complete, clean multilingual-v1 run: every scenario passing, nothing leaked. */
export function passingRetrievalResults(seed = QUALIFICATION_SEED): (ScenarioResult & { elapsedMs: number })[] {
  return dataset.scenarios.map(scenario => ({
    scenarioId: scenario.scenarioId,
    datasetVersion: dataset.datasetVersion,
    seed,
    requirements: scenario.assertions.map(assertion => assertion.id),
    category: scenario.category,
    capabilityDisposition: scenario.expectation.capabilityDisposition,
    outcome: scenario.expectation.outcome,
    assertions: scenario.assertions.map(assertion => ({ assertionId: assertion.id, passed: true, diagnostic: 'redacted:kind:0000000000000000' })),
    operationCounts: { searchMemory: 1 },
    measurements: [],
    retrieval: retrievalResultFor(scenario.retrieval!),
    limitations: [...(scenario.limitations ?? [])],
    cleanup: 'clean' as const,
    elapsedMs: 1,
  }))
}

/** The three published files of one benchmark run, as text. */
export interface BenchmarkRunArtifacts {
  readonly summaryText: string
  readonly scenarioResultsText: string
  readonly reportText: string
}

export interface BenchmarkRunOptions {
  readonly seed?: number
  readonly commitSha?: string
  /** Differs between two runs of the same candidate; excluded from the digest. */
  readonly generatedAt?: string
  readonly dirtyWorktree?: boolean
  readonly results?: readonly (ScenarioResult & { elapsedMs: number })[]
}

/**
 * Build one run's artifacts exactly as the evaluator CLI writes them, including
 * its trailing newline on `summary.json` — the bytes are what gets hashed.
 */
export function benchmarkRunArtifacts(options: BenchmarkRunOptions = {}): BenchmarkRunArtifacts {
  const seed = options.seed ?? QUALIFICATION_SEED
  const report = buildReport({
    dataset,
    datasetDigest: multilingualV1Digest(),
    seed,
    commitSha: options.commitSha ?? CANDIDATE_COMMIT,
    platform: 'linux',
    nodeVersion: 'v22.14.0',
    arch: 'x64',
    generatedAt: options.generatedAt ?? '2026-08-08T01:00:00Z',
    dirtyWorktree: options.dirtyWorktree ?? false,
    results: options.results ?? passingRetrievalResults(seed),
    expectedScenarioTotal: dataset.scenarios.length,
  })
  return {
    summaryText: `${JSON.stringify(report.summary, null, 2)}\n`,
    scenarioResultsText: report.scenarioJsonl,
    reportText: report.markdown,
  }
}

/** SHA-256 of each published artifact's UTF-8 bytes. */
export function artifactHashes(artifacts: BenchmarkRunArtifacts): RetrievalRunArtifactHashes {
  const encoder = new TextEncoder()
  return {
    summarySha256: sha256Bytes(encoder.encode(artifacts.summaryText)),
    scenarioResultsSha256: sha256Bytes(encoder.encode(artifacts.scenarioResultsText)),
    reportSha256: sha256Bytes(encoder.encode(artifacts.reportText)),
  }
}

/** Parse published artifacts back into a packet, through the real parsers. */
export function benchmarkPacket(artifacts: BenchmarkRunArtifacts): RetrievalBenchmarkPacket {
  return {
    summary: parseEvaluationSummaryArtifact(JSON.parse(artifacts.summaryText)),
    scenarioResults: parseScenarioResultsJsonl(artifacts.scenarioResultsText),
    rawArtifactHashes: artifactHashes(artifacts),
  }
}

/** The identity a clean lexical multilingual-v1 run presents to a policy. */
export function benchmarkIdentity(overrides: Partial<RetrievalPolicyExpectedIdentity> = {}): RetrievalPolicyExpectedIdentity {
  return {
    repositoryCommit: CANDIDATE_COMMIT,
    datasetVersion: MULTILINGUAL_V1_VERSION,
    datasetDigest: multilingualV1Digest(),
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    analyzerConfigIdentity: ANALYZER_IDENTITY,
    requestedModes: ['lexical'],
    ...overrides,
  }
}

/**
 * An approved policy document with a digest covering its own bytes.
 *
 * Adversarial variants are signed too, so a case fails on the defect under test
 * rather than on an incidentally stale digest; tamper tests re-edit the signed
 * object afterwards to break the binding deliberately.
 */
export function approvedPolicyObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const content = {
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
    limits: [{ name: 'mean-recall-floor', metric: 'meanRecallAtCutoff', operation: '>=', value: 0.5 }],
    ...overrides,
  }
  return { ...content, policyDigest: sha256Canonical(content) }
}

export interface DecisionOptions {
  readonly policyDigest: string
  readonly normalizedResultDigest: string
  readonly runA: RetrievalRunArtifactHashes
  readonly runB: RetrievalRunArtifactHashes
  readonly overrides?: Record<string, unknown>
}

/** An independent evaluator decision naming one specific benchmark pair. */
export function independentDecisionObject(options: DecisionOptions): Record<string, unknown> {
  return {
    format: 1,
    evaluator: 'independent-retrieval-reviewer',
    decidedAt: '2026-08-08T02:00:00Z',
    source: 'external-review-record',
    decision: 'accepted',
    candidateCommit: CANDIDATE_COMMIT,
    datasetVersion: MULTILINGUAL_V1_VERSION,
    datasetDigest: multilingualV1Digest(),
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    analyzerConfigIdentity: ANALYZER_IDENTITY,
    requestedModes: ['lexical'],
    policyDigest: options.policyDigest,
    normalizedResultDigest: options.normalizedResultDigest,
    runA: options.runA,
    runB: options.runB,
    ...options.overrides,
  }
}
