import type { Dataset, RetrievalMetrics, RetrievalQueryResult, ScenarioResult } from '../contracts'

import { computeRetrievalMetrics } from './metrics'

export interface RetrievalAggregate extends RetrievalMetrics {
  readonly queryCount: number
  readonly meanPrecisionAtCutoff: number
  readonly meanRecallAtCutoff: number
  readonly meanReciprocalRank: number
  readonly zeroToleranceViolations: number
}

export interface RetrievalExperimentIdentity {
  readonly candidateCommit: string
  readonly datasetDigest: string
  readonly evaluatorSchemaVersion: number
  readonly analyzerConfigIdentity: string
  readonly requestedModes: readonly string[]
  readonly policyIdentity: string
}

/** Validate query completeness and derive the aggregate solely from per-query rows. */
export function aggregateRetrieval(dataset: Dataset, results: readonly ScenarioResult[]): { queries: readonly RetrievalQueryResult[], aggregate: RetrievalAggregate } {
  const specifications = new Map(dataset.scenarios.filter(scenario => scenario.retrieval).map(scenario => [scenario.retrieval!.queryId, scenario.retrieval!] as const))
  const expected = [...specifications.keys()]
  const queries = results.flatMap(result => result.retrieval ? [result.retrieval] : [])
  const seen = new Set<string>()
  for (const query of queries) {
    if (seen.has(query.queryId))
      throw new Error(`duplicate per-query record ${query.queryId}`)
    seen.add(query.queryId)
  }
  for (const queryId of expected) {
    if (!seen.has(queryId))
      throw new Error(`missing per-query record ${queryId}`)
  }
  if (queries.length !== expected.length)
    throw new Error('retrieval results contain an unexpected per-query record')

  const recomputed = queries.map((query) => {
    const specification = specifications.get(query.queryId)
    if (!specification)
      throw new Error(`unexpected per-query record ${query.queryId}`)
    if (query.cutoff !== specification.cutoff)
      throw new Error(`retrieval query ${query.queryId} cutoff does not match dataset`)
    if (JSON.stringify(query.requestedModes) !== JSON.stringify(specification.requestedModes))
      throw new Error(`retrieval query ${query.queryId} requested modes do not match dataset`)
    if (query.appliedModes.some(mode => !query.requestedModes.includes(mode)))
      throw new Error(`retrieval query ${query.queryId} applied an unrequested mode`)

    const corpus = new Map(specification.corpus.map(item => [item.itemId, item] as const))
    const judgments = new Map(specification.judgments.map(judgment => [judgment.itemId, judgment.relevance] as const))
    const rankedIds = new Set<string>()
    for (const [index, item] of query.rankedItems.entries()) {
      if (item.rank !== index + 1)
        throw new Error(`retrieval query ${query.queryId} has non-contiguous ranks`)
      if (rankedIds.has(item.itemId))
        throw new Error(`retrieval query ${query.queryId} has duplicate ranked item ${item.itemId}`)
      if (!corpus.has(item.itemId))
        throw new Error(`retrieval query ${query.queryId} has unrecognized ranked item ${item.itemId}`)
      if (item.relevance !== judgments.get(item.itemId))
        throw new Error(`retrieval query ${query.queryId} has a relevance label inconsistent with the dataset`)
      rankedIds.add(item.itemId)
    }

    const roles = (wanted: readonly string[]) => specification.corpus.filter(item => wanted.includes(item.role) && rankedIds.has(item.itemId)).map(item => item.itemId)
    const authorizationViolations = roles(['unauthorized_relevant'])
    const lifecycleViolations = roles(['lifecycle_invalid'])
    const temporalViolations = roles(['temporal_before', 'temporal_after'])
    const qualityIds = new Set(specification.corpus.filter(item => item.role === 'relevant' || item.role === 'irrelevant').map(item => item.itemId))
    const qualityRanked = query.rankedItems.filter(item => qualityIds.has(item.itemId))
    const qualityJudgments = specification.judgments.filter(item => qualityIds.has(item.itemId))
    const metrics = computeRetrievalMetrics(qualityRanked, qualityJudgments, query.cutoff)

    for (const [name, actual, claimed] of [
      ['metrics', metrics, query.metrics],
      ['authorization violations', authorizationViolations, query.authorizationViolations],
      ['lifecycle violations', lifecycleViolations, query.lifecycleViolations],
      ['temporal violations', temporalViolations, query.temporalViolations],
    ] as const) {
      if (JSON.stringify(actual) !== JSON.stringify(claimed))
        throw new Error(`retrieval query ${query.queryId} claimed ${name} do not match recomputation`)
    }
    return { ...query, metrics, authorizationViolations, lifecycleViolations, temporalViolations }
  })

  const sum = (field: keyof RetrievalMetrics): number => recomputed.reduce((total, query) => total + query.metrics[field], 0)
  const queryCount = recomputed.length
  const aggregate: RetrievalAggregate = Object.freeze({
    queryCount,
    relevantReturned: sum('relevantReturned'),
    irrelevantReturned: sum('irrelevantReturned'),
    relevantMissed: sum('relevantMissed'),
    precisionAtCutoff: queryCount === 0 ? 0 : sum('precisionAtCutoff') / queryCount,
    recallAtCutoff: queryCount === 0 ? 0 : sum('recallAtCutoff') / queryCount,
    reciprocalRank: queryCount === 0 ? 0 : sum('reciprocalRank') / queryCount,
    meanPrecisionAtCutoff: queryCount === 0 ? 0 : sum('precisionAtCutoff') / queryCount,
    meanRecallAtCutoff: queryCount === 0 ? 0 : sum('recallAtCutoff') / queryCount,
    meanReciprocalRank: queryCount === 0 ? 0 : sum('reciprocalRank') / queryCount,
    zeroToleranceViolations: recomputed.reduce((total, query) => total + query.authorizationViolations.length + query.lifecycleViolations.length + query.temporalViolations.length, 0),
  })
  return { queries: Object.freeze(recomputed), aggregate }
}

/** Reject comparisons between experiments with any incompatible identity. */
export function assertCompatibleExperiments(baseline: RetrievalExperimentIdentity, candidate: RetrievalExperimentIdentity): void {
  for (const field of ['datasetDigest', 'evaluatorSchemaVersion', 'analyzerConfigIdentity', 'policyIdentity'] as const) {
    if (baseline[field] !== candidate[field])
      throw new Error(`retrieval experiment identity mismatch: ${field}`)
  }
  if (JSON.stringify(baseline.requestedModes) !== JSON.stringify(candidate.requestedModes))
    throw new Error('retrieval experiment identity mismatch: requestedModes')
}
