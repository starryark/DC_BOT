import type { ScenarioResult, ThresholdDocument } from '../contracts'
import type { RunManifest } from '../performance/contracts'
import type { LiveArtifact } from '../performance/live-artifact'
import type { PriceDocument } from '../performance/price-contract'
import type { UsageRecord } from '../performance/provider-observability'
import type { RetrievalBenchmarkPacket } from '../retrieval/qualification'
import type { G8EvaluationRunFiles, G8PerformanceRunFiles, G8QualificationInput } from './qualification'

import { createHash } from 'node:crypto'

import { latestSchemaVersion } from '@proj-airi/memory-sqlite'

import { SOAK_SCENARIOS } from '../../../src/memory/active-soak'
import { EVALUATOR_SCHEMA_VERSION, parseThresholdDocument, sha256Canonical } from '../contracts'
import { ACTIVE_V1_VERSION, activeV1Dataset, activeV1Digest, MULTILINGUAL_V1_VERSION, multilingualV1Dataset, multilingualV1Digest } from '../dataset'
import { deriveCostEvidence } from '../performance/cost-evidence'
import { liveArtifactDigest, parseLiveArtifact } from '../performance/live-artifact'
import { parsePriceDocument, priceDocumentDigest } from '../performance/price-contract'
import { buildPerformanceReport } from '../performance/report'
import {
  applyPerformanceThresholds,
  parsePerformanceThresholdDocument,
  performanceThresholdDocumentDigest,
} from '../performance/threshold-contract'
import { WORKLOAD_CATALOG_DIGEST, workloadsForSuite } from '../performance/workloads'
import { buildReport } from '../report'
import {
  parseEvaluationSummaryArtifact,
  parseScenarioResultsJsonl,
  sha256Bytes,
  verifyRetrievalBenchmarkPacket,
} from '../retrieval/qualification'
import { passingRetrievalResults } from '../retrieval/qualification-fixtures'

/**
 * Synthetic all-green G8 evidence for the aggregate qualification tests.
 *
 * Every artifact is produced by the same builders the sanctioned tools use —
 * {@link buildReport} for evaluator runs, {@link buildPerformanceReport} for
 * performance runs over the real catalog plan, and the real threshold and price
 * document schemas — so a passing fixture is a genuine artifact set, not a
 * hand-written shape the tools never emit. Approvals here are obviously
 * synthetic test-only records; nothing in this file alters production policy.
 */

/** The immutable commit every green fixture is pinned to. */
export const G8_CANDIDATE_COMMIT = 'a'.repeat(40)
/** A different commit for stale-candidate and wrong-scope cases. */
export const OTHER_COMMIT = 'c'.repeat(40)

const datasetByName = {
  'active-v1': { dataset: activeV1Dataset, digest: activeV1Digest, version: ACTIVE_V1_VERSION },
  'multilingual-v1': { dataset: multilingualV1Dataset, digest: multilingualV1Digest, version: MULTILINGUAL_V1_VERSION },
} as const

export type FixtureDatasetName = keyof typeof datasetByName

export const TEST_MEASUREMENT_NAME = 'g8-fixture-metric'
export const TEST_MEASUREMENT_LIMIT = 10

/**
 * Every scenario passing, with one threshold-able measurement per scenario.
 *
 * Multilingual rows reuse the retrieval fixtures' proven per-query results —
 * their metrics are computed, not asserted, so the aggregate recomputation in
 * `aggregateRetrieval` accepts them. Adding a measurement to a row is the one
 * change; the retrieval evidence itself is untouched.
 */
function passingResults(name: FixtureDatasetName, seed: number): (ScenarioResult & { elapsedMs: number })[] {
  if (name === 'multilingual-v1') {
    return passingRetrievalResults(seed).map(result => ({
      ...result,
      measurements: [{ name: TEST_MEASUREMENT_NAME, value: 1, unit: 'count', evaluated: true }],
    }))
  }
  const dataset = datasetByName[name].dataset()
  return dataset.scenarios.map(scenario => ({
    scenarioId: scenario.scenarioId,
    datasetVersion: dataset.datasetVersion,
    seed,
    requirements: scenario.assertions.map(assertion => assertion.id),
    category: scenario.category,
    capabilityDisposition: scenario.expectation.capabilityDisposition,
    outcome: scenario.expectation.outcome,
    assertions: scenario.assertions.map(assertion => ({ assertionId: assertion.id, passed: true, diagnostic: 'redacted:kind:0000000000000000' })),
    operationCounts: {},
    measurements: [{ name: TEST_MEASUREMENT_NAME, value: 1, unit: 'count', evaluated: true }],
    limitations: [...(scenario.limitations ?? [])],
    cleanup: 'clean' as const,
    elapsedMs: 1,
  }))
}

export interface EvaluationRunOptions {
  readonly dataset: FixtureDatasetName
  readonly commitSha?: string
  readonly seed?: number
  readonly generatedAt?: string
  readonly dirtyWorktree?: boolean
  /** Supply the matching threshold document so the run publishes `measurementStatus: 'evaluated'`. */
  readonly withThresholds?: boolean
}

/** One built evaluation run: its published files plus the threshold document it was produced with, when one was. */
export interface BuiltEvaluationRun extends G8EvaluationRunFiles {
  readonly thresholds?: ThresholdDocument
}

/** The eval-side threshold document fixture, provenance-bound to the requested dataset and commit. */
export function evalThresholdObject(name: FixtureDatasetName, commitSha: string = G8_CANDIDATE_COMMIT): Record<string, unknown> {
  const entry = datasetByName[name]
  return {
    format: 1,
    approver: 'g8-fixture-governance-owner',
    approvedAt: '2026-08-16T00:00:00Z',
    source: 'synthetic-test-approval',
    repositoryCommit: commitSha,
    datasetVersion: entry.version,
    datasetDigest: entry.digest(),
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
    limits: [{ name: 'g8-fixture-limit', metric: TEST_MEASUREMENT_NAME, operation: '<=', value: TEST_MEASUREMENT_LIMIT }],
  }
}

export function evalThresholdDocument(name: FixtureDatasetName, commitSha: string = G8_CANDIDATE_COMMIT): ThresholdDocument {
  const raw = evalThresholdObject(name, commitSha)
  const entry = datasetByName[name]
  return parseThresholdDocument(raw, {
    datasetVersion: entry.version,
    datasetDigest: entry.digest(),
    evaluatorSchemaVersion: EVALUATOR_SCHEMA_VERSION,
  })
}

/** Digest used to bind a signoff's approval coverage to an eval threshold document. */
export function evalThresholdDigest(name: FixtureDatasetName, commitSha: string = G8_CANDIDATE_COMMIT): string {
  return sha256Canonical(evalThresholdDocument(name, commitSha))
}

/** Build one `memory:evaluate` run's three artifacts exactly as the evaluator CLI writes them. */
export function evaluationRunArtifacts(options: EvaluationRunOptions): BuiltEvaluationRun {
  const entry = datasetByName[options.dataset]
  const seed = options.seed ?? 20260802
  const thresholds = options.withThresholds ? evalThresholdDocument(options.dataset, options.commitSha) : undefined
  const report = buildReport({
    dataset: entry.dataset(),
    datasetDigest: entry.digest(),
    seed,
    commitSha: options.commitSha ?? G8_CANDIDATE_COMMIT,
    platform: 'linux',
    nodeVersion: 'v22.14.0',
    arch: 'x64',
    generatedAt: options.generatedAt ?? '2026-08-16T01:00:00Z',
    dirtyWorktree: options.dirtyWorktree ?? false,
    results: passingResults(options.dataset, seed),
    expectedScenarioTotal: entry.dataset().scenarios.length,
    thresholds,
  })
  return {
    summaryJson: `${JSON.stringify(report.summary, null, 2)}\n`,
    scenarioResultsJsonl: report.scenarioJsonl,
    reportText: report.markdown,
    ...(thresholds ? { thresholds } : {}),
  }
}

const TEST_ENVIRONMENT = Object.freeze({
  nodeVersion: 'v24.14.0',
  pnpmVersion: '10.33.0',
  platform: 'win32',
  architecture: 'x64',
  cpuModel: 'g8-fixture-cpu',
  cpuCount: 12,
  totalMemoryBytes: 51459162112,
  sqliteVersion: '3.51.2',
})

export interface PerformanceRunOptions {
  readonly commitSha?: string
  readonly seed?: number
  readonly runId?: string
  readonly completedAt?: string
  readonly durationBaseMs?: number
  readonly withThresholdBinding?: boolean
  readonly withPriceBinding?: boolean
  /** The price document this run binds and prices against; defaults to the fixture document. */
  readonly priceDocument?: PriceDocument
  /** Import the synthetic brain usage sample; `false` leaves the run with no cost-eligible usage. */
  readonly withBrainUsageSample?: boolean
  /** Fields to vary on the synthetic usage record (disposition, model, token counts). */
  readonly usage?: Partial<UsageRecord>
}

/** A performance threshold document covering every fixture metric with a generous bound. */
export function performanceThresholdObject(): Record<string, unknown> {
  return {
    format: 'performance-thresholds',
    schemaVersion: 2,
    contractId: 'performance-v2',
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    source: 'synthetic-test-approval',
    approver: 'g8-fixture-governance-owner',
    approvedAt: '2026-08-16T00:00:00Z',
    provenance: 'synthetic G8 fixture threshold document; test-only',
    thresholds: workloadsForSuite('performance-v2').map(workload => ({
      workloadId: workload.workloadId,
      metricId: `${workload.workloadId}.fixture-mean`,
      statistic: 'mean',
      unit: 'milliseconds',
      comparator: 'lte',
      bound: 1000,
    })),
  }
}

export function performanceThresholdDocument(): ReturnType<typeof parsePerformanceThresholdDocument> {
  return parsePerformanceThresholdDocument(performanceThresholdObject())
}

export function performanceThresholdFixtureDigest(): string {
  return performanceThresholdDocumentDigest(performanceThresholdDocument())
}

/** An open-ended approved price document fixture; `overrides` build near-miss variants. */
export function priceDocumentObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    provider: 'g8-fixture-provider',
    model: 'g8-fixture-model',
    billingUnit: 'token',
    currency: 'USD',
    dimensions: [
      { dimension: 'input', unit: 'token', pricePerUnit: 0.000001 },
      { dimension: 'output', unit: 'token', pricePerUnit: 0.000002 },
    ],
    effectiveStart: '2026-01-01T00:00:00Z',
    source: 'synthetic-test-approval',
    approver: 'g8-fixture-governance-owner',
    approvedAt: '2026-08-16T00:00:00Z',
    provenance: 'synthetic G8 fixture price document; test-only',
    ...overrides,
  }
}

export function priceDocumentFixture(overrides: Record<string, unknown> = {}): PriceDocument {
  return parsePriceDocument(priceDocumentObject(overrides))
}

export function priceDocumentFixtureDigest(overrides: Record<string, unknown> = {}): string {
  return priceDocumentDigest(priceDocumentFixture(overrides))
}

/**
 * A synthetic numeric usage record priced by {@link priceDocumentObject}.
 *
 * `thinkingTokens` is null because the fixture price document prices only the
 * input and output dimensions; a thinking count would make the calculation
 * absent for a missing dimension rather than green.
 */
export function brainUsageRecordFixture(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: 1,
    provider: 'g8-fixture-provider',
    model: 'g8-fixture-model',
    correlationId: 'usage-probe-g8-fixture-001',
    inputTokens: 1200,
    outputTokens: 340,
    thinkingTokens: null,
    totalTokens: 1540,
    disposition: 'complete',
    retryCount: 0,
    observedAt: '2026-08-16T00:30:00Z',
    ...overrides,
  }
}

/** The imported `brain-usage-sample` a green fixture run derives its cost from. */
export function brainUsageArtifactFixture(overrides: Partial<UsageRecord> = {}): LiveArtifact {
  const usage = brainUsageRecordFixture(overrides)
  return parseLiveArtifact({
    format: 1,
    kind: 'brain-usage-sample',
    sampleId: 'g8-fixture-brain-usage-001',
    fileDigest: 'b'.repeat(64),
    fileSizeBytes: 512,
    hostProvenance: 'g8-fixture-host',
    configProvenance: 'g8-fixture-brain-config',
    observedAt: usage.observedAt,
    usage,
  })
}

/**
 * Build one complete performance-v2 run directory's five loadable files.
 *
 * Rows are generated for the real 34-workload catalog at its default plan so
 * `loadRun`'s reconciliation and the suite-coverage check see a full run. Only
 * latency values differ between a pair's two runs, exactly as real same-seed
 * repetitions do.
 *
 * Cost is derived exactly as the sanctioned producer derives it — a synthetic
 * brain usage sample plus the fixture price document, through
 * {@link deriveCostEvidence}. There is deliberately no option that asserts
 * availability directly: a green fixture must be a state `memory:benchmark`
 * can actually reach.
 */
export function performanceRunFiles(options: PerformanceRunOptions = {}): G8PerformanceRunFiles {
  const workloads = workloadsForSuite('performance-v2')
  const thresholdDocument = options.withThresholdBinding === false ? undefined : performanceThresholdDocument()
  const baseDuration = options.durationBaseMs ?? 5
  const brainArtifact = options.withBrainUsageSample === false ? undefined : brainUsageArtifactFixture(options.usage ?? {})
  const importedLiveArtifactDigests = brainArtifact ? [liveArtifactDigest(brainArtifact)] : []
  const priceDocument = options.priceDocument ?? priceDocumentFixture()
  const price = options.withPriceBinding ? { document: priceDocument, digest: priceDocumentDigest(priceDocument) } : undefined
  const cost = deriveCostEvidence({
    liveArtifacts: brainArtifact ? [brainArtifact] : [],
    ...(price ? { price } : {}),
  })

  const attempts = workloads.flatMap(workload =>
    Array.from({ length: workload.sampleCount }, (_, ordinal) => ({
      schemaVersion: 2 as const,
      contractId: 'performance-v2' as const,
      contractDigest: WORKLOAD_CATALOG_DIGEST,
      workloadId: workload.workloadId,
      ordinal,
      outcome: 'passed' as const,
      durationMs: baseDuration + ordinal * 0.001,
    })))

  const rawMeasurements = workloads.map(workload => ({
    schemaVersion: 2 as const,
    contractId: 'performance-v2' as const,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: workload.workloadId,
    metricId: `${workload.workloadId}.fixture-mean`,
    role: workload.role,
    unit: 'milliseconds' as const,
    statistic: 'mean' as const,
    outcome: { disposition: 'observed' as const, value: baseDuration },
    observationCount: workload.sampleCount,
    retainedSamples: Math.min(workload.sampleCount, workload.sampleCapacity),
    sampleCapacity: workload.sampleCapacity,
    percentileMethod: 'exact-nearest-rank' as const,
    correctnessClean: true,
    thresholdEvaluation: 'not_evaluated' as const,
  }))
  const measurements = applyPerformanceThresholds(rawMeasurements, thresholdDocument)

  const manifest: RunManifest = {
    schemaVersion: 2,
    contractId: 'performance-v2',
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    commitSha: options.commitSha ?? G8_CANDIDATE_COMMIT,
    dirtyWorktree: false,
    suite: 'performance-v2',
    seed: options.seed ?? 20260802,
    environment: TEST_ENVIRONMENT,
    configuration: [{ key: 'suite', value: 'performance-v2' }],
    timerSource: 'performance.now',
    startedAt: '2026-08-16T01:00:00Z',
    completedAt: options.completedAt ?? '2026-08-16T01:30:00Z',
    workloadPlan: workloads.map(workload => ({
      workloadId: workload.workloadId,
      warmupCount: workload.warmupCount,
      sampleCount: workload.sampleCount,
      sampleCapacity: workload.sampleCapacity,
    })),
    workloadsCompleted: workloads.map(workload => workload.workloadId),
    importedLiveArtifactDigests,
    ...(thresholdDocument ? { thresholdDocumentDigest: performanceThresholdDocumentDigest(thresholdDocument) } : {}),
    ...(price ? { priceDocumentDigest: price.digest } : {}),
    limitations: [],
  }

  const report = buildPerformanceReport({
    runId: options.runId ?? 'g8-fixture-run',
    manifest,
    attempts,
    runFindings: [],
    measurements,
    voiceSampleDiagnostics: [],
    skippedWorkloadIds: [],
    activeControlDeltas: {},
    importedLiveArtifactDigests,
    cost,
    limitations: [],
  })

  return {
    runManifestJson: `${JSON.stringify(manifest, null, 2)}\n`,
    attemptsJsonl: report.attemptsJsonl,
    runFindingsJsonl: report.runFindingsJsonl,
    measurementsJsonl: report.measurementsJsonl,
    summaryJson: `${JSON.stringify(report.summary, null, 2)}\n`,
  }
}

/**
 * A soak report that passes `verifySoakReport` at the fixture candidate.
 *
 * Scenario windows are sequential one-minute slots, so every scenario is
 * attested exactly once with no overlap; generation-expecting scenarios carry
 * one generation and the rollback window carries none.
 */
export function soakReportObject(commitSha: string = G8_CANDIDATE_COMMIT): Record<string, unknown> {
  const expectsGeneration = (id: string): boolean =>
    id !== 'active-to-off-rollback' && id !== 'startup-binding-reconciliation' && id !== 'disabled-remember-correct'
  const base = Date.parse('2026-08-16T02:00:00Z')
  return {
    format: 1,
    runId: 'g8-fixture-soak',
    commitSha,
    schemaVersion: latestSchemaVersion,
    memoryMode: 'active',
    bindingFileDigest: '0'.repeat(64),
    preSoakBackupDigest: '1'.repeat(64),
    generatedAt: '2026-08-16T04:00:00Z',
    window: { from: '2026-08-16T02:00:00Z', to: '2026-08-16T03:00:00Z' },
    counts: {},
    assertions: [],
    scenarios: SOAK_SCENARIOS.map((scenario, index) => {
      const from = base + index * 120000
      return {
        id: scenario.id,
        observed: 'pass' as const,
        window: { from: new Date(from).toISOString(), to: new Date(from + 60000).toISOString() },
        generations: expectsGeneration(scenario.id) ? 1 : 0,
        deliveries: expectsGeneration(scenario.id) ? 1 : 0,
      }
    }),
    unresolvedDeliveries: [],
    deletion: { forgetRequests: 1, tombstones: 1, verified: true },
    restore: { oldBackupRestoreVerified: true },
    rollback: { drillPassed: true },
  }
}

export interface SignoffOptions {
  readonly role?: 'gate-owner' | 'privacy-lead' | 'lifecycle-lead' | 'security-reviewer'
  readonly decision?: 'approve' | 'reject'
  readonly candidateCommit?: string
  readonly covers?: { readonly thresholdDocuments?: string[], readonly priceDocuments?: string[] }
  readonly gateReadiness?: { readonly openQuestionsResolved: boolean, readonly highRisksOwned: boolean }
  readonly overrides?: Record<string, unknown>
}

/** One external signoff record; the source string always marks it as test-only. */
export function signoffObject(options: SignoffOptions = {}): Record<string, unknown> {
  return {
    format: 1,
    role: options.role ?? 'gate-owner',
    decision: options.decision ?? 'approve',
    candidateCommit: options.candidateCommit ?? G8_CANDIDATE_COMMIT,
    decidedAt: '2026-08-16T05:00:00Z',
    source: 'synthetic-test-signoff',
    ...(options.covers ? { covers: options.covers } : {}),
    ...(options.gateReadiness ? { gateReadiness: options.gateReadiness } : {}),
    ...options.overrides,
  }
}

/** The three required-role signoffs plus a gate-owner record covering the fixture documents. */
export function greenSignoffs(): Record<string, unknown>[] {
  return [
    signoffObject({ role: 'privacy-lead' }),
    signoffObject({ role: 'lifecycle-lead' }),
    signoffObject({ role: 'security-reviewer' }),
    signoffObject({
      role: 'gate-owner',
      gateReadiness: { openQuestionsResolved: true, highRisksOwned: true },
      covers: {
        thresholdDocuments: [
          performanceThresholdFixtureDigest(),
          evalThresholdDigest('active-v1'),
          evalThresholdDigest('multilingual-v1'),
        ],
        priceDocuments: [priceDocumentFixtureDigest()],
      },
    }),
  ]
}

export interface GreenBundle {
  readonly input: G8QualificationInput
  /** Retrieval decision bound to the multilingual fixture pair, for callers that mutate the bundle. */
  readonly retrievalDecision: Record<string, unknown>
  readonly retrievalPolicy: Record<string, unknown>
}

/** Parse one fixture evaluation run back into the packet shape the retrieval verifier consumes. */
function retrievalPacket(files: G8EvaluationRunFiles): RetrievalBenchmarkPacket {
  const encoder = new TextEncoder()
  return {
    summary: parseEvaluationSummaryArtifact(JSON.parse(files.summaryJson)),
    scenarioResults: parseScenarioResultsJsonl(files.scenarioResultsJsonl),
    rawArtifactHashes: {
      summarySha256: sha256Bytes(encoder.encode(files.summaryJson)),
      scenarioResultsSha256: sha256Bytes(encoder.encode(files.scenarioResultsJsonl)),
      reportSha256: sha256Bytes(encoder.encode(files.reportText)),
    },
  }
}

/**
 * The complete, explicitly green evidence bundle: every family present, at the
 * fixture candidate, with synthetic approvals covering every threshold and
 * price document. The retrieval policy/decision are the multilingual pair's
 * own governance inputs, exactly as `memory:qualify-retrieval` consumes them.
 */
export function greenBundle(): GreenBundle {
  const functionalRunA = evaluationRunArtifacts({ dataset: 'active-v1', generatedAt: '2026-08-16T01:00:00Z', withThresholds: true })
  const functionalRunB = evaluationRunArtifacts({ dataset: 'active-v1', generatedAt: '2026-08-16T03:00:00Z', withThresholds: true })
  const multilingualRunA = evaluationRunArtifacts({ dataset: 'multilingual-v1', generatedAt: '2026-08-16T01:00:00Z', withThresholds: true })
  const multilingualRunB = evaluationRunArtifacts({ dataset: 'multilingual-v1', generatedAt: '2026-08-16T03:00:00Z', withThresholds: true })

  const verified = verifyRetrievalBenchmarkPacket(retrievalPacket(multilingualRunA))

  const policy = {
    format: 1,
    approver: 'g8-fixture-governance-owner',
    approvedAt: '2026-08-16T00:00:00Z',
    source: 'synthetic-test-approval',
    repositoryCommit: G8_CANDIDATE_COMMIT,
    datasetVersion: verified.identity.datasetVersion,
    datasetDigest: verified.identity.datasetDigest,
    evaluatorSchemaVersion: verified.identity.evaluatorSchemaVersion,
    analyzerConfigIdentity: verified.identity.analyzerConfigIdentity,
    requestedModes: ['lexical'],
    limits: [{ name: 'g8-fixture-recall-floor', metric: 'meanRecallAtCutoff', operation: '>=', value: 0 }],
  }
  const policyWithDigest = { ...policy, policyDigest: sha256Canonical(policy) }
  const decision = {
    format: 1,
    evaluator: 'g8-fixture-independent-reviewer',
    decidedAt: '2026-08-16T04:00:00Z',
    source: 'synthetic-test-decision',
    decision: 'accepted',
    candidateCommit: G8_CANDIDATE_COMMIT,
    datasetVersion: verified.identity.datasetVersion,
    datasetDigest: verified.identity.datasetDigest,
    evaluatorSchemaVersion: verified.identity.evaluatorSchemaVersion,
    analyzerConfigIdentity: verified.identity.analyzerConfigIdentity,
    requestedModes: ['lexical'],
    policyDigest: policyWithDigest.policyDigest,
    normalizedResultDigest: verified.identity.normalizedResultDigest,
    runA: retrievalPacket(multilingualRunA).rawArtifactHashes,
    runB: retrievalPacket(multilingualRunB).rawArtifactHashes,
  }

  const input: G8QualificationInput = {
    candidateCommit: G8_CANDIDATE_COMMIT,
    functional: {
      runA: functionalRunA,
      runB: functionalRunB,
      thresholds: functionalRunA.thresholds,
    },
    multilingual: {
      runA: multilingualRunA,
      runB: multilingualRunB,
      thresholds: multilingualRunA.thresholds,
      policy: policyWithDigest,
      decision,
    },
    performance: {
      runA: performanceRunFiles({ runId: 'g8-fixture-perf-a', withPriceBinding: true }),
      runB: performanceRunFiles({ runId: 'g8-fixture-perf-b', durationBaseMs: 7, completedAt: '2026-08-16T02:00:00Z', withPriceBinding: true }),
      thresholds: performanceThresholdObject(),
    },
    priceDocument: priceDocumentObject(),
    soakReport: soakReportObject(),
    signoffs: greenSignoffs(),
  }
  return { input, retrievalDecision: decision, retrievalPolicy: policyWithDigest }
}

/** SHA-256 over a fixture artifact's UTF-8 bytes; matches how published bytes are hashed. */
export function fixtureTextDigest(text: string): string {
  return createHash('sha256').update(new TextEncoder().encode(text)).digest('hex')
}
