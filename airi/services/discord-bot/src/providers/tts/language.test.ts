import { describe, expect, it } from 'vitest'

import {
  detectTextLanguageForTts,
  isTtsLanguage,
  normalizeLanguage,
  resolveTtsLanguage,
} from './language'

describe('normalizeLanguage', () => {
  it('maps BCP-47 and ASR codes to GPT-SoVITS text_lang values', () => {
    expect(normalizeLanguage('en')).toBe('en')
    expect(normalizeLanguage('en-US')).toBe('en')
    expect(normalizeLanguage('en-GB')).toBe('en')
    expect(normalizeLanguage('zh')).toBe('zh')
    expect(normalizeLanguage('zh-CN')).toBe('zh')
    expect(normalizeLanguage('zh-TW')).toBe('zh')
    expect(normalizeLanguage('cmn')).toBe('zh')
    expect(normalizeLanguage('ja')).toBe('ja')
    expect(normalizeLanguage('ja-JP')).toBe('ja')
    expect(normalizeLanguage('jp')).toBe('ja')
  })

  it('normalizes case-insensitively', () => {
    expect(normalizeLanguage('ZH')).toBe('zh')
    expect(normalizeLanguage('JA-JP')).toBe('ja')
  })

  it('falls back to auto for unknown / undetermined languages', () => {
    expect(normalizeLanguage('und')).toBe('auto')
    expect(normalizeLanguage(undefined)).toBe('auto')
    expect(normalizeLanguage(null)).toBe('auto')
    expect(normalizeLanguage('')).toBe('auto')
    expect(normalizeLanguage('  ')).toBe('auto')
    expect(normalizeLanguage('fr')).toBe('auto')
    expect(normalizeLanguage('klingon')).toBe('auto')
  })
})

describe('resolveTtsLanguage — precedence', () => {
  it('uses strong script evidence when there is enough text', () => {
    expect(resolveTtsLanguage({ text: 'How can I help you today?' }).language).toBe('en')
    expect(resolveTtsLanguage({ text: '今天想聊些什么？', inputLanguageHint: 'ja' }).language).toBe('zh')
    expect(resolveTtsLanguage({ text: '今日は何を話しましょうか？', inputLanguageHint: 'zh' }).language).toBe('ja')
  })

  it('strong text evidence beats the ASR hint', () => {
    // Chinese turn, but the model replied in English — must not blindly use zh.
    const r = resolveTtsLanguage({ text: 'Hello, nice to meet you today.', inputLanguageHint: 'zh' })
    expect(r.language).toBe('en')
    expect(r.source).toBe('text-detection')
  })

  it('falls back to the ASR hint for ambiguous/short text', () => {
    // Han-only fragment is ambiguous between zh/ja — the ASR hint decides.
    expect(resolveTtsLanguage({ text: '今日', inputLanguageHint: 'ja' }).language).toBe('ja')
    expect(resolveTtsLanguage({ text: '今日', inputLanguageHint: 'zh' }).language).toBe('zh')
    expect(resolveTtsLanguage({ text: '你好', inputLanguageHint: 'zh' }).language).toBe('zh')
  })

  it('falls back to auto when neither text nor hint is conclusive', () => {
    expect(resolveTtsLanguage({ text: '嗯？' }).language).toBe('auto')
    expect(resolveTtsLanguage({ text: '嗯？', inputLanguageHint: 'und' }).language).toBe('auto')
    expect(resolveTtsLanguage({ text: 'OK.' }).language).toBe('auto')
    expect(resolveTtsLanguage({ text: '' }).language).toBe('auto')
  })

  it('honors a configured text_lang fallback', () => {
    expect(resolveTtsLanguage({ text: '嗯？', textLangFallback: 'ja' }).language).toBe('ja')
    expect(resolveTtsLanguage({ text: '嗯？', textLangFallback: 'auto' }).language).toBe('auto')
  })

  it('keeps resolution stable across small streamed fragments', () => {
    // A Chinese turn chunked into tiny pieces: each inherits the zh hint rather
    // than being force-classified from 2-3 characters.
    const hint = 'zh'
    for (const chunk of ['你好，', '今天想', '聊什么？']) {
      expect(resolveTtsLanguage({ text: chunk, inputLanguageHint: hint }).language).toBe('zh')
    }
  })

  it('handles mixed-language text without throwing', () => {
    expect(() => resolveTtsLanguage({ text: '你好 Patrick, welcome back.' })).not.toThrow()
    expect(() => resolveTtsLanguage({ text: 'Gemini API は使えるわよ。' })).not.toThrow()
  })

  it('treats kana-bearing text as Japanese even with embedded English', () => {
    // Kana is strong JP evidence; this is a realistic Kurisu response.
    expect(resolveTtsLanguage({ text: 'これは GPT-SoVITS のテストです。' }).language).toBe('ja')
  })
})

describe('detectTextLanguageForTts (text-only convenience)', () => {
  it('routes English, Chinese, and Japanese speech independently', () => {
    expect(detectTextLanguageForTts('How can I help you today?')).toBe('en')
    expect(detectTextLanguageForTts('今天想聊些什么？')).toBe('zh')
    expect(detectTextLanguageForTts('今日は何を話しましょうか？')).toBe('ja')
  })

  it('returns auto for ambiguous short fragments rather than guessing', () => {
    expect(detectTextLanguageForTts('嗯？')).toBe('auto')
    expect(detectTextLanguageForTts('今日')).toBe('auto')
  })
})

describe('isTtsLanguage', () => {
  it('accepts the concrete language codes and rejects auto/unknown', () => {
    expect(isTtsLanguage('zh')).toBe(true)
    expect(isTtsLanguage('en')).toBe(true)
    expect(isTtsLanguage('ja')).toBe(true)
    expect(isTtsLanguage('auto')).toBe(false)
    expect(isTtsLanguage('fr')).toBe(false)
  })
})
