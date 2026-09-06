import { describe, expect, it } from 'vitest'

import { runBoundedTtsPipeline } from './tts-pipeline'

async function* chunks(values: string[]): AsyncIterable<string> {
  for (const value of values)
    yield value
}

describe('runBoundedTtsPipeline', () => {
  it('retains the original structured chunk through playback', async () => {
    const input = { text: 'hello', pauseBeforeMs: 120 }
    const played: typeof input[] = []

    await runBoundedTtsPipeline(chunksOf([input]), {
      async synthesize(chunk) {
        return chunk.text
      },
      async play(prepared) {
        played.push(prepared.chunk)
      },
      isCancelled: () => false,
    })

    expect(played).toEqual([input])
  })

  it('keeps deterministic synthesis and playback order', async () => {
    const synthesized: string[] = []
    const played: string[] = []
    await runBoundedTtsPipeline(chunks(['c1', 'c2', 'c3']), {
      async synthesize(text) {
        synthesized.push(text)
        return text
      },
      async play(item) {
        played.push(item.audio)
      },
      isCancelled: () => false,
    })

    expect(synthesized).toEqual(['c1', 'c2', 'c3'])
    expect(played).toEqual(['c1', 'c2', 'c3'])
  })

  it('allows only one synthesized-unplayed lookahead chunk', async () => {
    let releaseFirst!: () => void
    const firstPlayback = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let synthesized = 0
    let played = 0
    let maxOutstanding = 0

    const running = runBoundedTtsPipeline(chunks(['c1', 'c2', 'c3']), {
      async synthesize(text) {
        synthesized++
        maxOutstanding = Math.max(maxOutstanding, synthesized - played - 1)
        return text
      },
      async play(item) {
        if (item.chunkIndex === 0)
          await firstPlayback
        played++
      },
      isCancelled: () => false,
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(synthesized).toBe(2)
    expect(maxOutstanding).toBeLessThanOrEqual(1)
    releaseFirst()
    await running
    expect(synthesized).toBe(3)
  })

  it('does not synthesize future chunks after cancellation', async () => {
    let cancelled = false
    const synthesized: string[] = []
    await runBoundedTtsPipeline(chunks(['c1', 'c2', 'c3']), {
      async synthesize(text) {
        synthesized.push(text)
        return text
      },
      async play() {
        cancelled = true
      },
      isCancelled: () => cancelled,
    })

    expect(synthesized).toEqual(['c1'])
  })
})

async function* chunksOf<T>(values: T[]): AsyncIterable<T> {
  for (const value of values)
    yield value
}

describe('bounded producer cleanup', () => {
  it('does not read an unbounded tail while playback is held', async () => {
    let release!: () => void
    let preparedTwo!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const two = new Promise<void>(resolve => { preparedTwo = resolve })
    let reads = 0
    async function* source() {
      for (let i = 0; i < 100; i++) { reads++; yield String(i) }
    }
    const run = runBoundedTtsPipeline(source(), {
      async synthesize(text) { if (text === '1') preparedTwo(); return text },
      async play(item) { if (item.chunkIndex === 0) await held },
      isCancelled: () => false,
    })
    await two
    expect(reads).toBe(2)
    release()
    await run
  })

  it('cancels a blocked source pull without waiting for another token', async () => {
    const abort = new AbortController()
    let entered!: () => void
    let release!: (value: IteratorResult<string>) => void
    let closed = false
    const pulling = new Promise<void>(resolve => { entered = resolve })
    const source = { [Symbol.asyncIterator]() {
      return {
        next() { entered(); return new Promise<IteratorResult<string>>(resolve => { release = resolve }) },
        async return() { closed = true; return { done: true as const, value: undefined } },
      }
    } }
    const run = runBoundedTtsPipeline(source, {
      async synthesize(text) { return text }, async play() {},
      isCancelled: () => abort.signal.aborted, signal: abort.signal,
    })
    const rejected = expect(run).rejects.toThrow('cancelled')
    await pulling
    abort.abort()
    await rejected
    expect(closed).toBe(true)
    release({ done: true, value: undefined })
  })
})
