import type { RetrievalExperimentIdentity } from './report'

import { describe, expect, it } from 'vitest'

import { multilingualV1Dataset } from '../dataset'
import { aggregateRetrieval, assertCompatibleExperiments } from './report'

function result(queryId: string) {
  const specification = multilingualV1Dataset().scenarios.find(scenario => scenario.retrieval?.queryId === queryId)!.retrieval!
  const relevant = specification.corpus.find(item => item.role === 'relevant')
  const rankedItems = relevant ? [{ itemId: relevant.itemId, rank: 1, relevance: 1, mode: 'lexical', features: {} }] : []
  const relevantTotal = specification.corpus.filter(item => item.role === 'relevant').length
  return { scenarioId: queryId.replace('-Q01', ''), retrieval: { queryId, cutoff: specification.cutoff, requestedModes: specification.requestedModes, appliedModes: ['lexical'], rankedItems, metrics: { relevantReturned: rankedItems.length, irrelevantReturned: 0, relevantMissed: relevantTotal - rankedItems.length, precisionAtCutoff: rankedItems.length / specification.cutoff, recallAtCutoff: relevantTotal === 0 ? 1 : rankedItems.length / relevantTotal, reciprocalRank: rankedItems.length ? 1 : 0 }, authorizationViolations: [], lifecycleViolations: [], temporalViolations: [] } } as never
}

describe('retrieval artifact recomputation', () => {
  it('recomputes aggregate metrics from complete per-query records', () => {
    const dataset = multilingualV1Dataset()
    const records = dataset.scenarios.map(scenario => result(scenario.retrieval!.queryId))
    expect(aggregateRetrieval(dataset, records).aggregate).toMatchObject({ queryCount: 10, relevantReturned: 9, meanReciprocalRank: 0.9, zeroToleranceViolations: 0 })
  })

  it('rejects tampered metrics, violations, ranks, and relevance labels', () => {
    const dataset = multilingualV1Dataset()
    const records = dataset.scenarios.map(scenario => result(scenario.retrieval!.queryId))
    const first = records[0] as any
    expect(() => aggregateRetrieval(dataset, [{ ...first, retrieval: { ...first.retrieval, metrics: { ...first.retrieval.metrics, recallAtCutoff: 0 } } }, ...records.slice(1)])).toThrow(/metrics do not match/)
    expect(() => aggregateRetrieval(dataset, [{ ...first, retrieval: { ...first.retrieval, authorizationViolations: ['invented'] } }, ...records.slice(1)])).toThrow(/authorization violations do not match/)
    expect(() => aggregateRetrieval(dataset, [{ ...first, retrieval: { ...first.retrieval, rankedItems: [{ ...first.retrieval.rankedItems[0], rank: 2 }] } }, ...records.slice(1)])).toThrow(/non-contiguous ranks/)
    expect(() => aggregateRetrieval(dataset, [{ ...first, retrieval: { ...first.retrieval, rankedItems: [{ ...first.retrieval.rankedItems[0], relevance: 0 }] } }, ...records.slice(1)])).toThrow(/relevance label inconsistent/)
  })

  it('rejects missing and duplicate per-query records', () => {
    const dataset = multilingualV1Dataset()
    const records = dataset.scenarios.map(scenario => result(scenario.retrieval!.queryId))
    expect(() => aggregateRetrieval(dataset, records.slice(1))).toThrow(/missing per-query record/)
    expect(() => aggregateRetrieval(dataset, [...records, records[0]!])).toThrow(/duplicate per-query record/)
  })
})

describe('retrieval comparison identity', () => {
  const identity: RetrievalExperimentIdentity = { candidateCommit: 'a'.repeat(40), datasetDigest: 'b'.repeat(64), evaluatorSchemaVersion: 2, analyzerConfigIdentity: 'sqlite-fts5-v9', requestedModes: ['lexical'], policyIdentity: 'none' }

  it('accepts compatible experiment identities', () => {
    expect(() => assertCompatibleExperiments(identity, { ...identity, candidateCommit: 'c'.repeat(40) })).not.toThrow()
  })

  it.each(['datasetDigest', 'evaluatorSchemaVersion', 'analyzerConfigIdentity', 'policyIdentity'] as const)('rejects a %s mismatch', (field) => {
    expect(() => assertCompatibleExperiments(identity, { ...identity, [field]: field === 'evaluatorSchemaVersion' ? 3 : 'different' })).toThrow(new RegExp(field))
  })

  it('rejects requested-mode mismatches', () => {
    expect(() => assertCompatibleExperiments(identity, { ...identity, requestedModes: ['vector'] })).toThrow(/requestedModes/)
  })
})
