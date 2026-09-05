import { describe, expect, it } from 'vitest'

import { computeRetrievalMetrics } from './metrics'

describe('mode-neutral retrieval metrics', () => {
  const judgments = [{ itemId: 'a', relevance: 1 as const }, { itemId: 'b', relevance: 0 as const }, { itemId: 'c', relevance: 1 as const }]

  it('matches a hand-computable ranking', () => {
    expect(computeRetrievalMetrics([judgments[1]!, judgments[0]!], judgments, 2)).toEqual({ relevantReturned: 1, irrelevantReturned: 1, relevantMissed: 1, precisionAtCutoff: 0.5, recallAtCutoff: 0.5, reciprocalRank: 0.5 })
  })

  it('defines empty and no-relevant cases without NaN', () => {
    expect(computeRetrievalMetrics([], [{ itemId: 'x', relevance: 0 }], 1)).toEqual({ relevantReturned: 0, irrelevantReturned: 0, relevantMissed: 0, precisionAtCutoff: 0, recallAtCutoff: 1, reciprocalRank: 0 })
  })

  it('rejects duplicate and unjudged ranked items', () => {
    expect(() => computeRetrievalMetrics([judgments[0]!, judgments[0]!], judgments, 2)).toThrow(/duplicate ranked item/)
    expect(() => computeRetrievalMetrics([{ itemId: 'missing', relevance: 1 }], judgments, 1)).toThrow(/no relevance judgment/)
  })

  it('is independent of native feature values when rank is unchanged', () => {
    const ranked = [judgments[0]!, judgments[1]!]
    const before = computeRetrievalMetrics(ranked.map(item => ({ ...item, bm25: -1 })), judgments, 2)
    const after = computeRetrievalMetrics(ranked.map(item => ({ ...item, bm25: 999 })), judgments, 2)
    expect(after).toEqual(before)
  })
})
