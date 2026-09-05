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

describe('speechChunker — opening sizing', () => {
  // Time-to-first-audio is the opening chunk's synthesis time and nothing else:
  // every later chunk is synthesized while its predecessor is playing. A CJK
  // character is ~200 ms of speech and GPT-SoVITS runs near RTF 0.5 for this
  // voice, so each character held back from the opening chunk costs ~100 ms of
  // silence before the character starts speaking.
  it('opens at the first clause of a long CJK sentence and returns to steady state behind it', () => {
    const chunker = new SpeechChunker()
    // A 34-character sentence whose only terminal punctuation is past the
    // 32-character opening cap. The opening cuts at the comma; the remainder is
    // sized by the steady-state rules, which reach the sentence end.
    expect(chunker.push('这根本说不通吧，因为实验数据完全不支持这个结论而且时间线也对不上啊。')).toEqual([
      '这根本说不通吧，',
      '因为实验数据完全不支持这个结论而且时间线也对不上啊。',
    ])
  })

  it('treats the Japanese clause comma as a boundary', () => {
    const chunker = new SpeechChunker()
    // `、` was missing from the clause characters, so a Japanese reply had no
    // clause boundary at all and always ran to the hard limit.
    expect(chunker.push('それは無理な話ね、まだ証拠が足りないし時間も足りないから待ってて。')).toEqual([
      'それは無理な話ね、',
      'まだ証拠が足りないし時間も足りないから待ってて。',
    ])
  })

  it('holds a short clause once the turn has started speaking', () => {
    const chunker = new SpeechChunker()
    chunker.push('这根本说不通吧，因为实验数据完全不支持这个结论而且时间线也对不上啊。')
    // Steady-state sizing is in force: this clause is below the 28-character
    // target, so it waits for its sentence rather than being spoken alone.
    expect(chunker.push('可是，')).toEqual([])
  })

  it('bounds an opening CJK sentence that never offers a boundary', () => {
    const chunker = new SpeechChunker()
    const [opening] = chunker.push('あ'.repeat(60))
    // Without an opening cap this waits for the steady-state 50-character hard
    // limit — roughly five seconds of synthesis before the first sound.
    expect(opening).toHaveLength(32)
  })

  it('does not speak a bare CJK acknowledgement alone', () => {
    const chunker = new SpeechChunker()
    // The opening minimum still outranks the terminal boundary, so a four
    // character reflex stays attached to the clause that follows it.
    expect(chunker.push('そうね。')).toEqual([])
  })

  it('emits the opening English sentence whole and keeps the next one steady-state', () => {
    const chunker = new SpeechChunker()
    expect(chunker.push('Let me examine the evidence first.')).toEqual(['Let me examine the evidence first.'])
    expect(chunker.push('Then I will answer.')).toEqual([])
  })
})
