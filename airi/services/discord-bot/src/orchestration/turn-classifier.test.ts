import { describe, expect, it } from 'vitest'
import { config } from '../config'
import { classifyTurn, resolveGenerationProfile } from './turn-classifier'

describe('turn classifier', () => {
  it('routes greetings to a bounded low-latency profile', () => {
    const profile = resolveGenerationProfile(classifyTurn('こんにちは'), config().brain)
    expect(profile).toMatchObject({ thinkingLevel: 'low', maxOutputTokens: 256, responseLengthClass: 'casual' })
  })

  it('routes canon-sensitive timeline questions to medium reasoning', () => {
    const profile = resolveGenerationProfile(classifyTurn('2010年の世界線とタイムリープの記憶を詳しく説明して'), config().brain)
    expect(profile.thinkingLevel).toBe('medium')
    expect(profile.maxOutputTokens).toBe(768)
  })
})
