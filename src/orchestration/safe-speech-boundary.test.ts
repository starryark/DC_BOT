import { describe, expect, it } from 'vitest'
import { safeSpeechBoundary } from './safe-speech-boundary'
import { SpeechChunker } from './speech-chunker'

describe('speakable boundaries', () => {
  it('withholds unfinished decimal, code and citations', () => {
    for (const text of ['The value is 3.', 'Use `x = 1.', 'See [the paper.', 'See 【citation.', 'See [paper](https://example.'])
      expect(safeSpeechBoundary(text, text.length)).toBe(false)
    expect(safeSpeechBoundary('The value is 3.14.', 15)).toBe(false)
    const completed = 'Use `x = 1`. Done.'
    expect(safeSpeechBoundary(completed, completed.length, true)).toBe(true)
  })

  it('finds a later safe boundary after complete inline code', () => {
    const chunker = new SpeechChunker({ safeBoundaries: true, openingMinLatinChars: 4, openingMaxLatinChars: 24 })
    const text = 'Use `version 1.2` for this example. It works.'
    const chunks = [...chunker.push(text), ...chunker.flush()]
    expect(chunks.join(' ')).toContain('`version 1.2`')
    expect(chunks.every(chunk => (chunk.match(/`/gu)?.length ?? 0) % 2 === 0)).toBe(true)
  })

  it('fails closed at the bounded unfinished-code limit', () => {
    const chunker = new SpeechChunker({ safeBoundaries: true })
    expect(() => chunker.push('```' + 'x'.repeat(4096))).toThrow('buffer limit')
    const short = new SpeechChunker({ safeBoundaries: true })
    short.push('An unfinished `code')
    expect(() => short.flush()).toThrow('Unfinished')
  })
})
