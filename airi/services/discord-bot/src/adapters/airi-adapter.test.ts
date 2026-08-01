import { describe, expect, it } from 'vitest'

import { chunkDiscordText } from './airi-adapter'

describe('chunkDiscordText', () => {
  it('keeps every chunk within the requested maximum and preserves content', () => {
    const text = `${'paragraph one '.repeat(20)}\n\n${'paragraph two '.repeat(20)}`
    const chunks = chunkDiscordText(text, 80)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(chunk => chunk.length <= 80)).toBe(true)
    expect(chunks.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim())
  })

  it('makes progress through an unbroken string', () => {
    const chunks = chunkDiscordText('x'.repeat(4_001), 1_900)

    expect(chunks.map(chunk => chunk.length)).toEqual([1_900, 1_900, 201])
    expect(chunks.join('')).toBe('x'.repeat(4_001))
  })

  it('rejects limits outside Discord’s supported range', () => {
    expect(() => chunkDiscordText('hello', 0)).toThrow(RangeError)
    expect(() => chunkDiscordText('hello', 2_001)).toThrow(RangeError)
  })
})
