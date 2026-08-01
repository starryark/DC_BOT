import { describe, expect, it } from 'vitest'

import { runBoundedTtsPipeline } from './tts-pipeline'

async function* chunks(values: string[]): AsyncIterable<string> {
  for (const value of values)
    yield value
}

describe('runBoundedTtsPipeline', () => {
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
