import { describe, expect, it } from 'vitest'

import { parseActV1 } from './act-v1-parser'

/**
 * ACT-v1 parser tests (`02-public-contracts.md` §8, `04-decisions.md` D006).
 *
 * Covers the canonical examples from §8 and from the Kurisu card's
 * `creator_notes`, plus the robustness contract: malformed ACT/DELAY must
 * never throw, and the safe visible text must be preserved.
 */
describe('parseActV1 — canonical examples', () => {
  it('parses the §8 example into an action + clean text', () => {
    const input = '<|ACT:"emotion":{"name":"question","intensity":0.7},"motion":"眉をひそめる"|>\nそんなこと、本当に可能だと思ってるの？'
    const result = parseActV1(input)
    expect(result.actions).toEqual([
      { emotion: 'question', intensity: 0.7, motionHint: '眉をひそめる' },
    ])
    expect(result.pauses).toEqual([])
    expect(result.cleanText).toBe('そんなこと、本当に可能だと思ってるの？')
  })

  it('parses the neutral ACT from the card\'s creator_notes', () => {
    const input = '<|ACT:"emotion":{"name":"neutral","intensity":0.6},"motion":"画面から視線を上げる"|>何か用？'
    const result = parseActV1(input)
    expect(result.actions).toEqual([
      { emotion: 'neutral', intensity: 0.6, motionHint: '画面から視線を上げる' },
    ])
    expect(result.cleanText).toBe('何か用？')
  })

  it('parses the multi-token example from creator_notes (two ACTs + a DELAY)', () => {
    const input = '<|ACT:"emotion":{"name":"question","intensity":0.7},"motion":"眉をひそめる"|> 過去に情報を送れる装置？ そんなの普通に考えればあり得ないわ。<|ACT:"emotion":{"name":"curious","intensity":0.8},"motion":"データを見る"|><|DELAY:1|> ……でも、その結果が本物なら話は別ね。見せて。'
    const result = parseActV1(input)
    expect(result.actions).toEqual([
      { emotion: 'question', intensity: 0.7, motionHint: '眉をひそめる' },
      { emotion: 'curious', intensity: 0.8, motionHint: 'データを見る' },
    ])
    expect(result.pauses).toEqual([{ durationMs: 1000 }])
    expect(result.cleanText).toBe(
      '過去に情報を送れる装置？ そんなの普通に考えればあり得ないわ。 ……でも、その結果が本物なら話は別ね。見せて。',
    )
  })
})

describe('parseActV1 — DELAY tokens', () => {
  it('maps <|DELAY:3|> to a 3000 ms pause by default', () => {
    const result = parseActV1('one<|DELAY:3|>two')
    expect(result.pauses).toEqual([{ durationMs: 3000 }])
    expect(result.cleanText).toBe('one two')
  })

  it('honors a custom delayUnitMs', () => {
    const result = parseActV1('one<|DELAY:2|>two', { delayUnitMs: 500 })
    expect(result.pauses).toEqual([{ durationMs: 1000 }])
  })

  it('drops pauses (but still strips the token) when allowDelay is false', () => {
    const result = parseActV1('one<|DELAY:1|>two', { allowDelay: false })
    expect(result.pauses).toEqual([])
    expect(result.cleanText).toBe('one two')
  })
})

describe('parseActV1 — robustness (malformed input never throws)', () => {
  it('returns the text unchanged when there are no tokens', () => {
    const result = parseActV1('Hello there, no tokens at all.')
    expect(result.actions).toEqual([])
    expect(result.pauses).toEqual([])
    expect(result.cleanText).toBe('Hello there, no tokens at all.')
  })

  it('handles an empty string', () => {
    const result = parseActV1('')
    expect(result).toEqual({ actions: [], pauses: [], cleanText: '' })
  })

  it('handles a non-string input by treating it as empty', () => {
    // The parser is typed to accept string; simulate a coerced undefined.
    const result = parseActV1(undefined as unknown as string)
    expect(result.cleanText).toBe('')
  })

  it('strips an unterminated <| marker without throwing', () => {
    const result = parseActV1('visible text <|ACT:"emotion" still going')
    expect(result.actions).toEqual([])
    // The marker `<|` is dropped; the remaining text is preserved as visible.
    expect(result.cleanText).toContain('visible text')
    expect(result.cleanText).toContain('still going')
  })

  it('ignores a malformed ACT token (bad emotion object) but preserves text', () => {
    const result = parseActV1('<|ACT:"emotion":not-an-object|>safe text')
    expect(result.actions).toEqual([])
    expect(result.cleanText).toBe('safe text')
  })

  it('ignores an ACT token with a truncated motion string', () => {
    const result = parseActV1('<|ACT:"emotion":{"name":"happy","intensity":0.5},"motion":"oops|> hi')
    // The emotion parses; motion was unterminated inside the token but the
    // token still closes at `|>`, so the action is captured without motion.
    expect(result.actions).toEqual([{ emotion: 'happy', intensity: 0.5 }])
    expect(result.cleanText).toBe('hi')
  })

  it('clamps intensity outside 0..1 to the valid range', () => {
    const result = parseActV1('<|ACT:"emotion":{"name":"happy","intensity":5}|>hi')
    expect(result.actions).toEqual([{ emotion: 'happy', intensity: 1 }])
  })

  it('handles an ACT token with no motion field at all', () => {
    const result = parseActV1('<|ACT:"emotion":{"name":"curious","intensity":0.3}|>hi')
    expect(result.actions).toEqual([{ emotion: 'curious', intensity: 0.3 }])
    expect(result.cleanText).toBe('hi')
  })

  it('handles an ACT token with an empty emotion object', () => {
    const result = parseActV1('<|ACT:"emotion":{}|>hi')
    // Recognized token shape, empty emotion → an empty action (no fields).
    expect(result.actions).toEqual([{}])
    expect(result.cleanText).toBe('hi')
  })

  it('treats unknown control tokens as stripped metadata', () => {
    const result = parseActV1('a <|UNKNOWN:thing|> b')
    expect(result.actions).toEqual([])
    expect(result.pauses).toEqual([])
    expect(result.cleanText).toBe('a b')
  })

  it('does not execute or choke on a JSON-injection attempt', () => {
    // A malicious-ish payload that must never reach eval/JSON.parse blindly.
    const payload = '<|ACT:"emotion":{"name":"evil","intensity":0.1},"motion":"})};process.exit(1)//"|>text'
    const result = parseActV1(payload)
    expect(result.actions[0]?.emotion).toBe('evil')
    // The injected code is just part of the motion string, never executed.
    expect(result.cleanText).toBe('text')
  })

  it('preserves multiple lines of visible text', () => {
    const result = parseActV1('<|ACT:"emotion":{"name":"neutral","intensity":0.6}|>line one\nline two\nline three')
    expect(result.cleanText).toBe('line one\nline two\nline three')
  })
})
