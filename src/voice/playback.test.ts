import type { PlaybackItem, PlaybackPlayer, PlaybackPlayerHandlers, PlaybackResult } from './playback'

import { describe, expect, it } from 'vitest'

import { GuildPlaybackScheduler } from './playback'

/**
 * Fake `AudioPlayer` mirroring the real state machine: `play()` moves to
 * playing, `stop()` and `finish()` move back to idle. It counts *replacements*
 * — a `play()` issued while already playing — which is precisely the
 * `@discordjs/voice` behaviour that used to cut responses off
 * (`baseline-findings.md` §2).
 */
class FakePlayer implements PlaybackPlayer {
  readonly played: string[] = []
  replacements = 0
  observeCount = 0
  private status: 'idle' | 'playing' = 'idle'
  private handlers?: PlaybackPlayerHandlers

  play(resource: unknown): void {
    if (this.status === 'playing')
      this.replacements++
    this.played.push(String(resource))
    this.status = 'playing'
  }

  stop(): boolean {
    this.status = 'idle'
    return true
  }

  observe(handlers: PlaybackPlayerHandlers): () => void {
    this.observeCount++
    this.handlers = handlers
    return () => {
      this.handlers = undefined
    }
  }

  /** Simulate the resource reaching the end of its stream. */
  finish(): void {
    this.status = 'idle'
    this.handlers?.onIdle()
  }

  fail(error: Error): void {
    this.status = 'idle'
    this.handlers?.onError(error)
  }

  get isPlaying(): boolean {
    return this.status === 'playing'
  }
}

function makeItem(overrides: Partial<PlaybackItem> & { id: string }): PlaybackItem {
  return {
    guildId: 'g1',
    turnId: 't1',
    responseEpoch: 1,
    chunkIndex: 0,
    audio: overrides.id,
    ...overrides,
  }
}

function newScheduler(player: FakePlayer): GuildPlaybackScheduler {
  return new GuildPlaybackScheduler({
    guildId: 'g1',
    player,
    createResource: item => item.id,
  })
}

describe('guildPlaybackScheduler — ordering and serialization', () => {
  it('plays three concurrently enqueued chunks in submission order', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const results = Promise.all([
      scheduler.enqueue(makeItem({ id: 'a', chunkIndex: 0 })),
      scheduler.enqueue(makeItem({ id: 'b', chunkIndex: 1 })),
      scheduler.enqueue(makeItem({ id: 'c', chunkIndex: 2 })),
    ])

    expect(player.played).toEqual(['a'])
    player.finish()
    expect(player.played).toEqual(['a', 'b'])
    player.finish()
    expect(player.played).toEqual(['a', 'b', 'c'])
    player.finish()

    const settled = await results
    expect(settled.map(r => r.status)).toEqual(['played', 'played', 'played'])
  })

  // ROOT CAUSE:
  //
  // voice-manager.playAudioStream() called cleanupAudioPlayer() then built a new
  // AudioPlayer and called play() for every chunk, so chunk N+1 destroyed the
  // resource of chunk N while it was still audible. The scheduler must never
  // issue play() while a resource is active.
  it('never calls play() twice without an intervening idle', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const pending = Promise.all([
      scheduler.enqueue(makeItem({ id: 'a' })),
      scheduler.enqueue(makeItem({ id: 'b' })),
      scheduler.enqueue(makeItem({ id: 'c' })),
    ])
    player.finish()
    player.finish()
    player.finish()
    await pending

    expect(player.replacements).toBe(0)
    expect(player.played).toHaveLength(3)
  })

  it('resolves after playback completes, not at play start', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    let settled: PlaybackResult | undefined
    const pending = scheduler.enqueue(makeItem({ id: 'a' })).then((r) => {
      settled = r
    })

    await Promise.resolve()
    expect(player.isPlaying).toBe(true)
    expect(settled).toBeUndefined()

    player.finish()
    await pending
    expect(settled?.status).toBe('played')
  })

  it('keeps exactly one set of player observers across many playbacks', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    for (let i = 0; i < 5; i++) {
      const pending = scheduler.enqueue(makeItem({ id: `chunk-${i}` }))
      player.finish()
      await pending
    }

    expect(player.observeCount).toBe(1)
    expect(player.played).toHaveLength(5)
  })
})

describe('guildPlaybackScheduler — failure handling', () => {
  it('marks the active item failed and continues with the queue', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const first = scheduler.enqueue(makeItem({ id: 'a' }))
    const second = scheduler.enqueue(makeItem({ id: 'b' }))

    player.fail(new Error('resource exploded'))
    const firstResult = await first
    expect(firstResult.status).toBe('failed')
    expect(firstResult.error?.message).toBe('resource exploded')

    expect(player.played).toEqual(['a', 'b'])
    player.finish()
    expect((await second).status).toBe('played')
  })

  it('marks an item failed when its resource cannot be built', async () => {
    const player = new FakePlayer()
    const scheduler = new GuildPlaybackScheduler({
      guildId: 'g1',
      player,
      createResource: (item) => {
        if (item.id === 'bad')
          throw new Error('bad stream')
        return item.id
      },
    })

    const bad = scheduler.enqueue(makeItem({ id: 'bad' }))
    const good = scheduler.enqueue(makeItem({ id: 'good' }))

    expect((await bad).status).toBe('failed')
    player.finish()
    expect((await good).status).toBe('played')
    expect(player.played).toEqual(['good'])
  })
})

describe('guildPlaybackScheduler — epochs', () => {
  it('cancelEpoch removes pending items of that epoch only', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const a = scheduler.enqueue(makeItem({ id: 'a', responseEpoch: 2 }))
    const b = scheduler.enqueue(makeItem({ id: 'b', responseEpoch: 2 }))
    const c = scheduler.enqueue(makeItem({ id: 'c', responseEpoch: 2 }))

    scheduler.cancelEpoch(2)

    expect((await a).status).toBe('cancelled')
    expect((await b).status).toBe('cancelled')
    expect((await c).status).toBe('cancelled')
    expect(scheduler.getSnapshot().queueDepth).toBe(0)
  })

  it('a stale-epoch item never reaches play()', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const current = scheduler.enqueue(makeItem({ id: 'new', responseEpoch: 5 }))
    const stale = await scheduler.enqueue(makeItem({ id: 'old', responseEpoch: 4 }))

    expect(stale.status).toBe('cancelled')
    expect(player.played).toEqual(['new'])

    player.finish()
    await current
  })

  it('drops queued items that go stale while waiting', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const head = scheduler.enqueue(makeItem({ id: 'head', responseEpoch: 1 }))
    const doomed = scheduler.enqueue(makeItem({ id: 'doomed', responseEpoch: 1 }))
    scheduler.cancelEpoch(1)

    expect((await doomed).status).toBe('cancelled')
    expect((await head).status).toBe('cancelled')
    expect(player.played).toEqual(['head'])
  })

  it('awaitDrained resolves only after the last item of the epoch finishes', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const a = scheduler.enqueue(makeItem({ id: 'a', responseEpoch: 7 }))
    const b = scheduler.enqueue(makeItem({ id: 'b', responseEpoch: 7 }))

    let drained = false
    const drain = scheduler.awaitDrained(7).then(() => {
      drained = true
    })

    player.finish()
    await a
    expect(drained).toBe(false)

    player.finish()
    await b
    await drain
    expect(drained).toBe(true)
  })

  it('awaitDrained resolves immediately when the epoch has no work', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)
    await expect(scheduler.awaitDrained(99)).resolves.toBeUndefined()
  })
})

describe('guildPlaybackScheduler — teardown', () => {
  it('stopAll empties the queue and settles every pending promise', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const a = scheduler.enqueue(makeItem({ id: 'a' }))
    const b = scheduler.enqueue(makeItem({ id: 'b' }))
    const c = scheduler.enqueue(makeItem({ id: 'c' }))

    await scheduler.stopAll('disconnect')

    expect((await a).status).toBe('cancelled')
    expect((await b).status).toBe('cancelled')
    expect((await c).status).toBe('cancelled')
    expect(scheduler.getSnapshot().queueDepth).toBe(0)
    expect(scheduler.getSnapshot().playing).toBe(false)
  })

  it('rejects further work after dispose and detaches observers', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    scheduler.dispose()
    const result = await scheduler.enqueue(makeItem({ id: 'late' }))

    expect(result.status).toBe('cancelled')
    expect(player.played).toEqual([])
  })

  it('a late idle event after cancellation cannot settle a new item', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const first = scheduler.enqueue(makeItem({ id: 'a', responseEpoch: 1 }))
    scheduler.cancelEpoch(1)
    expect((await first).status).toBe('cancelled')

    const second = scheduler.enqueue(makeItem({ id: 'b', responseEpoch: 2 }))
    // The stopped resource's idle arrives late. It releases the stop barrier,
    // starts 'b', and must not also settle it.
    player.finish()
    expect(player.played).toEqual(['a', 'b'])
    expect(scheduler.getSnapshot().playing).toBe(true)

    player.finish()
    expect((await second).status).toBe('played')
  })

  it('drops items beyond the bounded queue depth instead of growing', async () => {
    const player = new FakePlayer()
    const scheduler = newScheduler(player)

    const accepted: Array<Promise<PlaybackResult>> = []
    // One becomes active, 32 fill the queue, the 34th must be dropped.
    for (let i = 0; i < 33; i++)
      accepted.push(scheduler.enqueue(makeItem({ id: `item-${i}` })))

    const overflow = await scheduler.enqueue(makeItem({ id: 'overflow' }))
    expect(overflow.status).toBe('dropped')

    await scheduler.stopAll('shutdown')
    await Promise.all(accepted)
  })
})
