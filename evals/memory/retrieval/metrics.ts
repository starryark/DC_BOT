import type { RetrievalMetrics } from '../contracts'

export interface RankedJudgment {
  readonly itemId: string
  readonly relevance: 0 | 1
}

/** Compute mode-neutral binary relevance metrics from rank and judgments only. */
export function computeRetrievalMetrics(ranked: readonly RankedJudgment[], allJudgments: readonly RankedJudgment[], cutoff: number): RetrievalMetrics {
  if (!Number.isInteger(cutoff) || cutoff < 1)
    throw new Error('retrieval cutoff must be a positive integer')
  const judgmentIds = new Set<string>()
  for (const judgment of allJudgments) {
    if (judgmentIds.has(judgment.itemId))
      throw new Error(`duplicate relevance judgment ${judgment.itemId}`)
    judgmentIds.add(judgment.itemId)
  }
  const rankedIds = new Set<string>()
  for (const item of ranked) {
    if (rankedIds.has(item.itemId))
      throw new Error(`duplicate ranked item ${item.itemId}`)
    if (!judgmentIds.has(item.itemId))
      throw new Error(`ranked item ${item.itemId} has no relevance judgment`)
    rankedIds.add(item.itemId)
  }
  const evaluated = ranked.slice(0, cutoff)
  const relevantReturned = evaluated.filter(item => item.relevance === 1).length
  const irrelevantReturned = evaluated.length - relevantReturned
  const relevantTotal = allJudgments.filter(item => item.relevance === 1).length
  const relevantMissed = Math.max(0, relevantTotal - relevantReturned)
  const firstRelevant = evaluated.findIndex(item => item.relevance === 1)
  return Object.freeze({
    relevantReturned,
    irrelevantReturned,
    relevantMissed,
    precisionAtCutoff: relevantReturned / cutoff,
    recallAtCutoff: relevantTotal === 0 ? 1 : relevantReturned / relevantTotal,
    reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
  })
}
