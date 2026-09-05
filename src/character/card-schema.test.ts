import { describe, expect, it } from 'vitest'

import {
  CANONICAL_EMOTIONS,
  normalizeDcBotExtension,
  normalizeLorebook,
  readAiriExtension,
  readDcBotExtension,
  validateCard,
} from './card-schema'

/** Build a minimal valid card JSON string with optional overrides. */
function makeCard(overrides: Record<string, unknown> = {}): string {
  const card = {
    spec: 'chara_card_v3',
    spec_version: 3.0,
    data: {
      name: 'Makise Kurisu',
      system_prompt: '牧瀬紅莉栖として自然に会話すること。',
      description: 'desc',
      ...overrides,
    },
  }
  return JSON.stringify(card)
}

describe('validateCard — required fields', () => {
  it('accepts a minimal valid CCv3 card', () => {
    const r = validateCard(makeCard())
    expect(r.ok).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.card).not.toBeNull()
  })

  it('rejects a card missing data.name', () => {
    const r = validateCard(makeCard({ name: undefined }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(m => m.includes('data.name'))).toBe(true)
  })

  it('rejects a card with an empty data.name', () => {
    const r = validateCard(makeCard({ name: '   ' }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(m => m.includes('data.name'))).toBe(true)
  })

  it('rejects a card missing data.system_prompt', () => {
    const r = validateCard(makeCard({ system_prompt: undefined }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(m => m.includes('data.system_prompt'))).toBe(true)
  })

  it('rejects the wrong spec', () => {
    const r = validateCard(JSON.stringify({
      spec: 'chara_card_v2',
      spec_version: 2.0,
      data: { name: 'X', system_prompt: 'Y' },
    }))
    expect(r.ok).toBe(false)
    expect(r.errors.some(m => m.includes('spec'))).toBe(true)
  })
})

describe('validateCard — preserve-and-ignore + warnings', () => {
  it('preserves unknown fields on the data object', () => {
    const r = validateCard(makeCard({ future_field: { nested: [1, 2, 3] } }))
    expect(r.ok).toBe(true)
    const data = r.card?.data as Record<string, unknown> | undefined
    expect(data?.future_field).toEqual({ nested: [1, 2, 3] })
  })

  it('warns (but accepts) on a spec_version major mismatch', () => {
    const withVersion = JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: 4.0,
      data: { name: 'X', system_prompt: 'Y' },
    })
    const r2 = validateCard(withVersion)
    expect(r2.ok).toBe(true)
    expect(r2.warnings.some(m => m.includes('spec_version'))).toBe(true)
  })

  it('accepts a minor spec_version (e.g. 3.1) with no warning', () => {
    const withVersion = JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: 3.1,
      data: { name: 'X', system_prompt: 'Y' },
    })
    const r2 = validateCard(withVersion)
    expect(r2.ok).toBe(true)
    expect(r2.warnings.some(m => m.includes('spec_version major'))).toBe(false)
  })

  it('warns when spec_version is missing', () => {
    const r = validateCard(JSON.stringify({
      spec: 'chara_card_v3',
      data: { name: 'X', system_prompt: 'Y' },
    }))
    expect(r.ok).toBe(true)
    expect(r.warnings.some(m => m.includes('spec_version'))).toBe(true)
  })

  it('does not throw on invalid JSON', () => {
    const r = validateCard('{not json')
    expect(r.ok).toBe(false)
    expect(r.card).toBeNull()
    expect(r.errors.some(m => m.includes('valid JSON'))).toBe(true)
  })

  it('does not throw when root is not an object', () => {
    const r = validateCard('[1,2,3]')
    expect(r.ok).toBe(false)
    expect(r.errors.some(m => m.includes('object'))).toBe(true)
  })
})

describe('readDcBotExtension / readAiriExtension', () => {
  it('reads extensions.dc_bot when present', () => {
    const r = validateCard(makeCard({
      extensions: {
        dc_bot: { outputProtocol: { type: 'act-v1', emotions: ['happy'], allowDelay: false } },
      },
    }))
    const dcBot = readDcBotExtension(r.card!)
    expect(dcBot?.outputProtocol?.type).toBe('act-v1')
  })

  it('returns null when extensions.dc_bot is absent', () => {
    const r = validateCard(makeCard({
      extensions: { airi: { modules: {} } },
    }))
    expect(readDcBotExtension(r.card!)).toBeNull()
  })

  it('preserves extensions.airi verbatim', () => {
    const airi = { modules: { consciousness: { provider: 'google-generative-ai', model: 'models/gemini-3.6-flash' } } }
    const r = validateCard(makeCard({ extensions: { airi } }))
    expect(readAiriExtension(r.card!)).toEqual(airi)
  })
})

describe('normalizeDcBotExtension — safe defaults', () => {
  it('returns all defaults when the block is null', () => {
    const n = normalizeDcBotExtension(null)
    expect(n.outputProtocol.type).toBe('act-v1')
    expect(n.outputProtocol.emotions).toEqual([...CANONICAL_EMOTIONS])
    expect(n.outputProtocol.allowDelay).toBe(true)
    // provider/voiceId are empty (not-specified markers) so the registry can
    // fall back to the AIRI extension; promptLanguage defaults to 'ja'.
    expect(n.voice.provider).toBe('')
    expect(n.voice.voiceId).toBe('')
    expect(n.voice.promptLanguage).toBe('ja')
    expect(n.asr.hotwords).toEqual([])
    expect(n.avatar.renderer).toBe('live2d')
  })

  it('preserves provided outputProtocol values', () => {
    const n = normalizeDcBotExtension({
      outputProtocol: { type: 'act-v1', emotions: ['curious', 'neutral'], allowDelay: false },
    })
    expect(n.outputProtocol?.emotions).toEqual(['curious', 'neutral'])
    expect(n.outputProtocol?.allowDelay).toBe(false)
  })

  it('falls back to canonical emotions when emotions is empty/invalid', () => {
    const n = normalizeDcBotExtension({ outputProtocol: { emotions: 'not-an-array' } })
    expect(n.outputProtocol?.emotions).toEqual([...CANONICAL_EMOTIONS])
  })

  it('dedupes and trims emotion values', () => {
    const n = normalizeDcBotExtension({ outputProtocol: { emotions: ['happy', ' happy ', 'sad'] } })
    expect(n.outputProtocol?.emotions).toEqual(['happy', 'sad'])
  })

  it('normalizes a non-array hotwords value to []', () => {
    const n = normalizeDcBotExtension({ asr: { hotwords: 'not-an-array' } })
    expect(n.asr?.hotwords).toEqual([])
  })
})

describe('normalizeLorebook', () => {
  it('returns undefined for a missing character_book', () => {
    expect(normalizeLorebook(undefined)).toBeUndefined()
    expect(normalizeLorebook('nope')).toBeUndefined()
  })

  it('returns undefined when entries is not an array', () => {
    expect(normalizeLorebook({ entries: {} })).toBeUndefined()
  })

  it('keeps only entries with non-empty content', () => {
    const lb = normalizeLorebook({
      entries: [
        { keys: ['a'], content: 'first' },
        { keys: ['b'], content: '' },
        { keys: ['c'], content: '   ' },
        { keys: ['d'], content: 'fourth' },
      ],
    })
    expect(lb?.entries.map(e => e.content)).toEqual(['first', 'fourth'])
  })

  it('preserves enabled/insertionOrder/extensions verbatim', () => {
    const lb = normalizeLorebook({
      entries: [
        { keys: ['x'], content: 'c', enabled: false, insertionOrder: 2, extensions: { foo: 1 } },
      ],
    })
    expect(lb?.entries[0]).toMatchObject({
      keys: ['x'],
      content: 'c',
      enabled: false,
      insertionOrder: 2,
      extensions: { foo: 1 },
    })
  })

  it('returns undefined when no entries survive', () => {
    const lb = normalizeLorebook({ entries: [{ keys: ['a'], content: '' }] })
    expect(lb).toBeUndefined()
  })
})
