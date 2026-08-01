import type { BrainGenerationProfile, ResponseLengthClass } from '../providers/brain/types'
import type { BrainConfig } from '../config'

export interface ClassifiedTurn {
  intent: 'casual' | 'science' | 'emotional-support' | 'relationship' | 'canon' | 'identity' | 'command' | 'other'
  complexity: 'simple' | 'moderate' | 'complex'
  requiresCanonReconciliation: boolean
  requiresRelationshipMemory: boolean
  desiredLength: ResponseLengthClass
}

export function classifyTurn(text: string): ClassifiedTurn {
  const normalized = text.normalize('NFKC').toLowerCase()
  const science = /(科学|実験|理論|論文|神経|物理|脳|science|experiment|theory)/u.test(normalized)
  const relationship = /(好き|愛|恋|関係|デート|love|relationship)/u.test(normalized)
  const canon = /(世界線|タイムリープ|2010|記憶|過去|未来|worldline|timeline|memory)/u.test(normalized)
  const support = /(つらい|悲しい|不安|怖い|助けて|depressed|sad|anxious)/u.test(normalized)
  const greeting = /^(hi|hello|hey|おはよう|こんにちは|こんばんは|やあ)[!！。 ]*$/u.test(normalized)
  const complex = normalized.length > 180 || (science && canon) || (canon && /(詳しく|比較|矛盾|reconcile|explain in detail)/u.test(normalized))
  const intent = science ? 'science' : relationship ? 'relationship' : canon ? 'canon' : support ? 'emotional-support' : greeting ? 'casual' : 'other'
  return {
    intent,
    complexity: complex ? 'complex' : normalized.length > 80 ? 'moderate' : 'simple',
    requiresCanonReconciliation: canon,
    requiresRelationshipMemory: relationship,
    desiredLength: science || complex ? 'detailed' : greeting || support ? 'casual' : 'standard',
  }
}

export function resolveGenerationProfile(turn: ClassifiedTurn, cfg: BrainConfig): BrainGenerationProfile {
  const complex = turn.complexity === 'complex' || turn.requiresCanonReconciliation || turn.requiresRelationshipMemory
  return {
    thinkingLevel: complex ? cfg.thinkingLevelComplex : turn.desiredLength === 'casual' ? cfg.thinkingLevelCasual : cfg.thinkingLevelStandard,
    maxOutputTokens: turn.desiredLength === 'casual' ? cfg.maxOutputTokensCasual : turn.desiredLength === 'detailed' ? cfg.maxOutputTokensDetailed : cfg.maxOutputTokensStandard,
    responseLengthClass: turn.desiredLength,
  }
}
