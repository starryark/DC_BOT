import type { TranscriptFilterContext } from './transcript-filter'

import { describe, expect, it } from 'vitest'

import { filterTranscript, normalizeTranscript } from './transcript-filter'

const NOW = 1_700_000_000_000

function ctx(overrides: Partial<TranscriptFilterContext> = {}): TranscriptFilterContext {
  return {
    awaitingConfirmation: false,
    duplicateWindowMs: 3000,
    now: NOW,
    ...overrides,
  }
}

describe('normalizeTranscript', () => {
  it('trims and collapses runs of whitespace', () => {
    expect(normalizeTranscript('  Hello    world  ')).toBe('Hello world')
    expect(normalizeTranscript('line\n\nbreak')).toBe('line break')
  })

  it('removes the space ASR leaves before punctuation but keeps the one after', () => {
    expect(normalizeTranscript('Hello , world !')).toBe('Hello, world!')
    expect(normalizeTranscript('你好 ， 世界 。')).toBe('你好，世界。')
  })

  // ROOT CAUSE:
  //
  // The first implementation normalized with NFKC, which folds full-width CJK
  // punctuation onto ASCII: "你好 ， 世界 。" became "你好, 世界。". That changes
  // the punctuation GPT-SoVITS segments and prosodizes on, i.e. normalization
  // would have silently altered how Chinese and Japanese are spoken. The text
  // path now uses NFC and only the throwaway filler/duplicate key uses NFKC.
  it('does not fold full-width CJK punctuation onto ASCII', () => {
    expect(normalizeTranscript('你好 ， 世界 。')).toBe('你好，世界。')
    expect(normalizeTranscript('本当 ？')).toBe('本当？')
  })

  it('leaves full-width latin intact in the text path', () => {
    expect(normalizeTranscript('ｈｅｌｌｏ')).toBe('ｈｅｌｌｏ')
  })

  it('preserves semantic casing', () => {
    expect(normalizeTranscript('NASA and Kurisu')).toBe('NASA and Kurisu')
  })

  it('strips zero-width marks', () => {
    expect(normalizeTranscript('こん​にちは')).toBe('こんにちは')
  })

  it('returns an empty string for non-string input', () => {
    expect(normalizeTranscript(undefined as unknown as string)).toBe('')
  })
})

describe('filterTranscript — empty and too short', () => {
  it('rejects blank text', () => {
    expect(filterTranscript('   ', ctx())).toMatchObject({ accept: false, reason: 'empty' })
  })

  it('rejects punctuation-only text', () => {
    expect(filterTranscript('...', ctx())).toMatchObject({ accept: false, reason: 'empty' })
    expect(filterTranscript('。', ctx())).toMatchObject({ accept: false, reason: 'empty' })
  })

  it('rejects a single stray latin character as noise', () => {
    expect(filterTranscript('a', ctx())).toMatchObject({ accept: false, reason: 'too_short' })
  })

  it('keeps a single CJK character, which can be a whole word', () => {
    expect(filterTranscript('是', ctx()).accept).toBe(true)
  })
})

describe('filterTranscript — fillers', () => {
  it('rejects standalone 嗯。 in ordinary context', () => {
    expect(filterTranscript('嗯。', ctx({ language: 'zh' }))).toMatchObject({ accept: false, reason: 'filler' })
  })

  it('rejects English fillers with or without punctuation', () => {
    expect(filterTranscript('um', ctx({ language: 'en' })).reason).toBe('filler')
    expect(filterTranscript('Um.', ctx({ language: 'en' })).reason).toBe('filler')
    expect(filterTranscript('uh...', ctx({ language: 'en' })).reason).toBe('filler')
    expect(filterTranscript('Hmm!', ctx({ language: 'en' })).reason).toBe('filler')
  })

  it('rejects Japanese fillers', () => {
    expect(filterTranscript('えっと', ctx({ language: 'ja' })).reason).toBe('filler')
    expect(filterTranscript('うん。', ctx({ language: 'ja' })).reason).toBe('filler')
  })

  it('applies every filler set when the language is undetermined', () => {
    expect(filterTranscript('嗯', ctx({ language: 'und' })).reason).toBe('filler')
    expect(filterTranscript('um', ctx({ language: undefined })).reason).toBe('filler')
  })

  it('matches fillers across width variants without touching the spoken text', () => {
    const result = filterTranscript('Ｕｍ．', ctx({ language: 'en' }))
    expect(result.reason).toBe('filler')
    expect(result.normalizedText).toBe('Ｕｍ．')
  })

  it('never treats filler words inside a sentence as filler', () => {
    expect(filterTranscript('um, what time is the meeting?', ctx({ language: 'en' })).accept).toBe(true)
    expect(filterTranscript('The band Hmm played', ctx({ language: 'en' })).accept).toBe(true)
  })

  it('accepts confirmations when the bot asked a question', () => {
    expect(filterTranscript('嗯。', ctx({ language: 'zh', awaitingConfirmation: true })).accept).toBe(true)
    expect(filterTranscript('うん', ctx({ language: 'ja', awaitingConfirmation: true })).accept).toBe(true)
    expect(filterTranscript('yes', ctx({ language: 'en', awaitingConfirmation: true })).accept).toBe(true)
    expect(filterTranscript('no', ctx({ language: 'en', awaitingConfirmation: true })).accept).toBe(true)
  })

  it('still accepts a short confirmation that would otherwise be too short', () => {
    expect(filterTranscript('no', ctx({ language: 'en', awaitingConfirmation: true })).accept).toBe(true)
  })
})

describe('filterTranscript — duplicates', () => {
  it('rejects the same normalized text from the same user inside the window', () => {
    const result = filterTranscript('Hello.', ctx({
      recentTranscript: { normalizedText: 'Hello.', at: NOW - 1000 },
    }))
    expect(result).toMatchObject({ accept: false, reason: 'duplicate' })
  })

  it('accepts the same text once the window has passed', () => {
    const result = filterTranscript('Hello.', ctx({
      recentTranscript: { normalizedText: 'Hello.', at: NOW - 3001 },
    }))
    expect(result.accept).toBe(true)
  })

  it('accepts different text from the same user', () => {
    const result = filterTranscript('Goodbye.', ctx({
      recentTranscript: { normalizedText: 'Hello.', at: NOW - 500 },
    }))
    expect(result.accept).toBe(true)
  })

  // Duplicate state is keyed per user by the caller; this asserts the contract
  // that the filter itself never receives another speaker's history.
  it('deduplicates only against the supplied per-user history', () => {
    const withoutHistory = filterTranscript('Hello.', ctx())
    expect(withoutHistory.accept).toBe(true)
  })

  it('compares normalized forms, so spacing differences still count as duplicates', () => {
    const result = filterTranscript('Hello ,  world !', ctx({
      recentTranscript: { normalizedText: 'Hello, world!', at: NOW - 100 },
    }))
    expect(result).toMatchObject({ accept: false, reason: 'duplicate' })
  })
})
