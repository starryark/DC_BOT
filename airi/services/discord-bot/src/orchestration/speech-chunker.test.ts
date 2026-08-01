import { describe, expect, it } from 'vitest'

import { chunkStream, SpeechChunker, stripControlTokens } from './speech-chunker'

async function* fromDeltas(deltas: string[]): AsyncIterable<string> {
  for (const d of deltas)
    yield d
}

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = ''
  for await (const s of stream)
    out += s
  return out
}

describe('stripControlTokens', () => {
  it('passes ordinary text through unchanged', async () => {
    expect(await collect(stripControlTokens(fromDeltas(['そんなの', '普通に考えれば', 'あり得ないわ。'])))).toBe('そんなの普通に考えればあり得ないわ。')
  })

  it('removes a whole ACT token that arrives in one delta', async () => {
    const act = '<|ACT:"emotion":{"name":"question","intensity":0.7},"motion":"眉をひそめる"|>'
    expect(await collect(stripControlTokens(fromDeltas([`${act} 過去に情報を送れる装置？`])))).toBe(' 過去に情報を送れる装置？')
  })

  it('removes a token split across many deltas', async () => {
    // Streamed token boundaries land anywhere, including inside the decimal
    // intensity — the reason filtering happens before chunking.
    const deltas = ['<', '|ACT:"emotion":{"name":"curious","inten', 'sity":0', '.8},"motion":"データを見る"', '|>', 'えて。']
    expect(await collect(stripControlTokens(fromDeltas(deltas)))).toBe('えて。')
  })

  it('removes multiple tokens in one delta', async () => {
    const input = '<|ACT:"emotion":{"name":"think","intensity":0.5}|>まず<|DELAY:1|>証拠を見せて。'
    expect(await collect(stripControlTokens(fromDeltas([input])))).toBe('まず証拠を見せて。')
  })

  it('keeps a lone angle bracket that is not a token opener', async () => {
    expect(await collect(stripControlTokens(fromDeltas(['5 < 7 だから', 'ね。'])))).toBe('5 < 7 だからね。')
  })

  it('keeps a trailing angle bracket at end of stream', async () => {
    expect(await collect(stripControlTokens(fromDeltas(['答えは <'])))).toBe('答えは <')
  })

  it('releases an unterminated opener once it exceeds any plausible token length', async () => {
    const long = `<|${'あ'.repeat(600)}`
    expect(await collect(stripControlTokens(fromDeltas([long])))).toBe(long)
  })

  it('drops a token truncated by the end of the stream', async () => {
    expect(await collect(stripControlTokens(fromDeltas(['そうね。', '<|ACT:"emotion":{"name":"happy"'])))).toBe('そうね。')
  })
})

describe('stripControlTokens — token extraction', () => {
  it('hands each complete token to the handler with its delimiters', async () => {
    const seen: string[] = []
    const act = '<|ACT:"emotion":{"name":"happy","intensity":0.8},"motion":"笑う"|>'
    const clean = await collect(stripControlTokens(fromDeltas([act, 'そうね。', '<|DELAY:1|>', 'でも。']), t => seen.push(t)))

    expect(seen).toEqual([act, '<|DELAY:1|>'])
    expect(clean).toBe('そうね。でも。')
  })

  it('reassembles a token split across deltas before handing it over', async () => {
    const seen: string[] = []
    await collect(stripControlTokens(fromDeltas(['<', '|ACT:"emotion":{"name":"think","inten', 'sity":0', '.5}', '|>', 'ふむ。']), t => seen.push(t)))

    expect(seen).toEqual(['<|ACT:"emotion":{"name":"think","intensity":0.5}|>'])
  })

  it('does not invoke the handler for an unterminated token', async () => {
    const seen: string[] = []
    await collect(stripControlTokens(fromDeltas(['そう。', '<|ACT:"emotion":{"name":"sad"']), t => seen.push(t)))
    expect(seen).toEqual([])
  })
})

describe('chunkStream with control tokens', () => {
  it('never emits token text to TTS', async () => {
    const deltas = [
      '<|ACT:"emotion":{"name":"question","intensity":0.7},"motion":"眉をひそめる"|>',
      '過去に情報を送れる装置？ ',
      '<|DELAY:1|>',
      'そんなの普通に考えればあり得ないわ。',
    ]
    const chunks: string[] = []
    for await (const c of chunkStream(fromDeltas(deltas)))
      chunks.push(c)

    const joined = chunks.join('')
    expect(joined).not.toContain('ACT')
    expect(joined).not.toContain('DELAY')
    expect(joined).not.toContain('<|')
    expect(joined).toContain('過去に情報を送れる装置？')
    expect(joined).toContain('そんなの普通に考えればあり得ないわ。')
  })
})

describe('speechChunker — Wave 3 sizing', () => {
  it('does not emit a tiny English opening acknowledgement', () => {
    const chunker = new SpeechChunker()
    expect(chunker.push('OK.')).toEqual([])
    expect(chunker.push(' Let me examine the available evidence before drawing a conclusion.')).toEqual([
      'OK. Let me examine the available evidence before drawing a conclusion.',
    ])
  })

  it('does not emit a tiny CJK opening acknowledgement', () => {
    const chunker = new SpeechChunker()
    expect(chunker.push('そうね。')).toEqual([])
    expect(chunker.push('まず実験結果を確認してから結論を出しましょう。')).toEqual([
      'そうね。まず実験結果を確認してから結論を出しましょう。',
    ])
  })

  it('flushes a final short response', () => {
    const chunker = new SpeechChunker()
    expect(chunker.push('Understood.')).toEqual([])
    expect(chunker.flush()).toEqual(['Understood.'])
  })

  it('does not split decimal points or common abbreviations', () => {
    const chunker = new SpeechChunker({ minLatinChars: 10 })
    expect(chunker.push('Dr. Brown measured 3.14 volts before recording the final result.')).toEqual([
      'Dr. Brown measured 3.14 volts before recording the final result.',
    ])
  })

  it('never emits a two-character English chunk while more text is expected', () => {
    const chunker = new SpeechChunker()
    expect(chunker.push('I.')).toEqual([])
  })
})
