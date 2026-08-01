import type { CharacterInteractionProfile, SupportedLanguage } from '../character/types'
import { describe, expect, it } from 'vitest'
import { normalizeSupportedLanguage, resolveInputUnderstanding } from './input-understanding'

const profile: CharacterInteractionProfile = {
  defaultResponseLanguage: 'ja',
  pronunciationProfileVersion: 'kurisu-v1',
  entities: [
    { id: 'makise-kurisu', canonicalName: 'Makise Kurisu', kind: 'character-name', aliases: ['Makise Kurisu', 'Makise', '牧瀬紅莉栖', 'まきせくりす'] },
    { id: 'christina-nickname', canonicalName: 'Christina', nativeName: 'クリスティーナ', kind: 'nickname', aliases: ['Christina', 'クリスティーナ', '克里斯蒂娜'] },
  ],
}

function resolve(text: string, previousStableLanguage?: SupportedLanguage, asrLanguage: unknown = 'en') {
  return resolveInputUnderstanding({ text, previousStableLanguage, asrLanguage, characterInteractionProfile: profile })
}

describe('input understanding', () => {
  it.each([
    ['christina', undefined, 'en', 'ja', 'christina-nickname'],
    ['christina', 'zh', 'en', 'zh', 'christina-nickname'],
    ['Can you explain Christina?', 'ja', 'en', 'en', 'christina-nickname'],
    ['你是makise是吗', undefined, 'zh', 'zh', 'makise-kurisu'],
    ['makiseって誰？', undefined, 'en', 'ja', 'makise-kurisu'],
    ['Are you Makise?', 'ja', 'en', 'en', 'makise-kurisu'],
    ['makise', undefined, 'po', 'ja', 'makise-kurisu'],
    ['OK', 'zh', 'en', 'zh', undefined],
  ] as const)('%s', (text, previous, asr, language, entity) => {
    const result = resolve(text, previous, asr)
    expect(result.responseLanguage).toBe(language)
    expect(result.entities[0]?.entityId).toBe(entity)
  })

  it('matches full-width and mixed-script aliases but not larger identifiers', () => {
    expect(resolve('ＭＡＫＩＳＥ').entities[0]?.entityId).toBe('makise-kurisu')
    expect(resolve('你是Ｍａｋｉｓｅ是吗').responseLanguage).toBe('zh')
    expect(resolve('supermakise').entities).toEqual([])
    expect(resolve('makise123').entities).toEqual([])
  })

  it.each([['Japanese', 'ja'], ['日本語', 'ja'], ['Mandarin', 'zh'], ['English', 'en'], ['po', undefined], ['Portuguese', undefined]])('normalizes %s', (raw, expected) => expect(normalizeSupportedLanguage(raw)).toBe(expected))
})
