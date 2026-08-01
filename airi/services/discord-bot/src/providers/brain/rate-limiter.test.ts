import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrainRequestAbortedError } from './errors'
import { LocalBrainRateLimiter } from './rate-limiter'

/** Lets a pending microtask chain settle without advancing fake time. */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('localBrainRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('admits requests up to the per-minute budget immediately', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 3, maxConcurrent: 3 })
    const signal = new AbortController().signal

    await limiter.acquire(signal)
    await limiter.acquire(signal)
    await limiter.acquire(signal)

    expect(limiter.snapshot().windowCount).toBe(3)
    expect(limiter.snapshot().inFlight).toBe(3)
  })

  it('delays a request beyond the budget until the window slides', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 2, maxConcurrent: 5 })
    const signal = new AbortController().signal

    await limiter.acquire(signal)
    await limiter.acquire(signal)
    limiter.release()
    limiter.release()

    let admitted = false
    const pending = limiter.acquire(signal).then(() => {
      admitted = true
    })

    await vi.advanceTimersByTimeAsync(59_000)
    expect(admitted).toBe(false)

    await vi.advanceTimersByTimeAsync(1_500)
    await pending
    expect(admitted).toBe(true)
  })

  it('serializes acquisitions at max concurrency of one', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 100, maxConcurrent: 1 })
    const signal = new AbortController().signal

    await limiter.acquire(signal)

    let second = false
    const pending = limiter.acquire(signal).then(() => {
      second = true
    })

    await flush()
    expect(second).toBe(false)
    expect(limiter.snapshot().inFlight).toBe(1)

    limiter.release()
    await pending
    expect(second).toBe(true)
  })

  it('blockUntil suppresses acquisition for the whole cooldown', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 100, maxConcurrent: 5 })
    const signal = new AbortController().signal

    limiter.blockUntil(Date.now() + 50_000)
    expect(limiter.snapshot().blockedUntil).toBeGreaterThan(0)

    let admitted = false
    const pending = limiter.acquire(signal).then(() => {
      admitted = true
    })

    await vi.advanceTimersByTimeAsync(49_000)
    expect(admitted).toBe(false)

    await vi.advanceTimersByTimeAsync(2_000)
    await pending
    expect(admitted).toBe(true)
  })

  it('never shortens an existing block', () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 100, maxConcurrent: 5 })
    const far = Date.now() + 60_000
    limiter.blockUntil(far)
    limiter.blockUntil(Date.now() + 1_000)
    expect(limiter.snapshot().blockedUntil).toBe(far)
  })

  it('rejects with BrainRequestAbortedError when the signal fires while waiting on cooldown', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 100, maxConcurrent: 5 })
    const controller = new AbortController()
    limiter.blockUntil(Date.now() + 60_000)

    const pending = limiter.acquire(controller.signal)
    const assertion = expect(pending).rejects.toBeInstanceOf(BrainRequestAbortedError)

    await flush()
    controller.abort()
    await assertion
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 100, maxConcurrent: 5 })
    const controller = new AbortController()
    controller.abort()
    await expect(limiter.acquire(controller.signal)).rejects.toBeInstanceOf(BrainRequestAbortedError)
  })

  it('rejects a waiter blocked on concurrency when its turn is cancelled', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 100, maxConcurrent: 1 })
    const controller = new AbortController()

    await limiter.acquire(new AbortController().signal)
    const pending = limiter.acquire(controller.signal)
    const assertion = expect(pending).rejects.toBeInstanceOf(BrainRequestAbortedError)

    await flush()
    controller.abort()
    await assertion

    // ROOT CAUSE guard: an aborted waiter that stayed in the queue would consume
    // the next release and strand a live request forever.
    limiter.release()
    await expect(limiter.acquire(new AbortController().signal)).resolves.toBeUndefined()
  })

  it('release is safe to call when nothing is in flight', () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 100, maxConcurrent: 1 })
    limiter.release()
    expect(limiter.snapshot().inFlight).toBe(0)
  })

  it('prunes the window so an idle period restores full budget', async () => {
    const limiter = new LocalBrainRateLimiter({ requestsPerMinute: 2, maxConcurrent: 5 })
    const signal = new AbortController().signal

    await limiter.acquire(signal)
    await limiter.acquire(signal)
    limiter.release()
    limiter.release()
    expect(limiter.snapshot().windowCount).toBe(2)

    await vi.advanceTimersByTimeAsync(61_000)
    expect(limiter.snapshot().windowCount).toBe(0)
    await expect(limiter.acquire(signal)).resolves.toBeUndefined()
  })
})
