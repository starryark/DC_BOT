import { describe, expect, it } from 'vitest'

import { prepareSpeechText } from './pronunciation'

const entities = [{ id: 'makise', canonicalName: 'Makise Kurisu', kind: 'character-name' as const, aliases: ['Makise Kurisu', 'Makise'], pronunciations: { ja: { speechText: '牧瀬紅莉栖' } } }]

describe('prepareSpeechText', () => {
  it('changes only the speech copy', () => {
    const result = prepareSpeechText({ text: 'I am Makise Kurisu.', language: 'ja', entities })
    expect(result.displayText).toBe('I am Makise Kurisu.')
    expect(result.speechText).toBe('I am 牧瀬紅莉栖.')
    expect(result.substitutions).toHaveLength(1)
  })
  it('does not replace longer identifiers or protected content', () => {
    expect(prepareSpeechText({ text: 'superMakise `Makise` https://x.test/Makise', language: 'ja', entities }).speechText).toBe('superMakise `Makise` https://x.test/Makise')
  })
})
