import { describe, expect, it } from 'vitest'

import { tokenizeSpeechStream } from './speech-events'

async function* deltas(values: string[]): AsyncIterable<string> {
  for (const value of values)
    yield value
}

async function collect(values: string[]) {
  return Array.fromAsync(tokenizeSpeechStream(deltas(values)))
}

describe('tokenizeSpeechStream', () => {
  it('reassembles split tokens and preserves document order', async () => {
    const events = await collect([
      'first',
      '<',
      '|ACT:"emotion":{"name":"think","inten',
      'sity":0.5}|>',
      'second<|DELAY:',
      '3|>third',
    ])

    expect(events).toEqual([
      { kind: 'text', delta: 'first' },
      { kind: 'action', action: { emotion: 'think', intensity: 0.5 } },
      { kind: 'text', delta: 'second' },
      { kind: 'delay', requestedMs: 3000 },
      { kind: 'text', delta: 'third' },
    ])
  })

  it('strips malformed metadata without throwing or speaking it', async () => {
    expect(await collect(['before<|ACT:"emotion":nope|>after'])).toEqual([
      { kind: 'text', delta: 'before' },
      { kind: 'text', delta: 'after' },
    ])
  })

  it('retains the scanner safety cap for an implausibly long opener', async () => {
    const long = `<|${'x'.repeat(600)}`
    expect(await collect([long])).toEqual([{ kind: 'text', delta: long }])
  })

  it('drops a control token truncated at stream end', async () => {
    expect(await collect(['safe', '<|DELAY:'])).toEqual([{ kind: 'text', delta: 'safe' }])
  })
})
