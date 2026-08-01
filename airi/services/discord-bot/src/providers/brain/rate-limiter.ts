import { useLogg } from '@guiiai/logg'

import { config } from '../../config'
import { BrainRequestAbortedError } from './errors'

/**
 * Process-local request limiter for the brain provider.
 *
 * The upstream account limit is enforced by Google *after* the request is
 * spent; a local limiter set below that ceiling means excess turns wait (or are
 * cancelled) instead of burning quota on a guaranteed 429. It also carries the
 * cooldown: once a 429 is seen, `blockUntil` stops every subsequent acquisition
 * until the retry time, which is what turns a quota failure into one pause
 * rather than a retry storm (Optimize.md §2.5, §9 Agent 1C).
 *
 * Scope is the process (one API key + model), not the guild — quota is billed
 * per key, so two guilds must contend for the same budget.
 */

/** Sliding window for the requests-per-minute budget. */
const RPM_WINDOW_MS = 60_000

export interface RateLimiterSnapshot {
  /** Requests currently being generated. */
  inFlight: number
  /** Requests started inside the current RPM window. */
  windowCount: number
  /** Epoch ms until which acquisition is blocked; 0 when not blocked. */
  blockedUntil: number
}

export interface BrainRateLimiter {
  /**
   * Wait until a request slot is free. Resolves once the caller owns a slot —
   * the caller MUST call {@link release} when generation settles.
   *
   * @throws BrainRequestAbortedError if `signal` fires while waiting.
   */
  acquire: (signal: AbortSignal) => Promise<void>
  /** Return a slot acquired by {@link acquire}. Safe to call once per acquire. */
  release: () => void
  /** Block all acquisition until `timestamp` (epoch ms). Never shortens an existing block. */
  blockUntil: (timestamp: number) => void
  snapshot: () => RateLimiterSnapshot
}

export interface LocalBrainRateLimiterOptions {
  requestsPerMinute?: number
  maxConcurrent?: number
  /** Injected clock; defaults to `Date.now`. Present for deterministic tests. */
  now?: () => number
}

export class LocalBrainRateLimiter implements BrainRateLimiter {
  private logger = useLogg('BrainRateLimiter').useGlobalConfig()
  private readonly requestsPerMinute: number
  private readonly maxConcurrent: number
  private readonly now: () => number

  private inFlight = 0
  /** Start timestamps of requests inside the sliding window, oldest first. */
  private history: number[] = []
  private blockedUntilTs = 0
  /** Resolvers woken when a slot is released. */
  private releaseWaiters: Array<() => void> = []

  constructor(options: LocalBrainRateLimiterOptions = {}) {
    const cfg = config().brain
    this.requestsPerMinute = options.requestsPerMinute ?? cfg.requestsPerMinute
    this.maxConcurrent = options.maxConcurrent ?? cfg.maxConcurrentRequests
    this.now = options.now ?? Date.now
  }

  async acquire(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted)
        throw new BrainRequestAbortedError()

      const now = this.now()
      this.prune(now)

      // Cooldown from a previous 429 outranks everything else.
      const cooldownWait = this.blockedUntilTs - now
      if (cooldownWait > 0) {
        this.logger.withFields({ waitMs: cooldownWait }).log('gemini_cooldown_active')
        await this.sleep(cooldownWait, signal)
        continue
      }

      // RPM budget: wait until the oldest request leaves the window.
      if (this.history.length >= this.requestsPerMinute) {
        const wait = this.history[0] + RPM_WINDOW_MS - now
        await this.sleep(Math.max(wait, 1), signal)
        continue
      }

      // Concurrency: no timer can help here, only a release.
      if (this.inFlight >= this.maxConcurrent) {
        await this.waitForRelease(signal)
        continue
      }

      this.inFlight++
      this.history.push(now)
      return
    }
  }

  release(): void {
    if (this.inFlight > 0)
      this.inFlight--
    const next = this.releaseWaiters.shift()
    next?.()
  }

  blockUntil(timestamp: number): void {
    if (timestamp > this.blockedUntilTs)
      this.blockedUntilTs = timestamp
  }

  snapshot(): RateLimiterSnapshot {
    const now = this.now()
    this.prune(now)
    return {
      inFlight: this.inFlight,
      windowCount: this.history.length,
      blockedUntil: this.blockedUntilTs > now ? this.blockedUntilTs : 0,
    }
  }

  /** Drop request timestamps that have aged out of the sliding window. */
  private prune(now: number): void {
    const cutoff = now - RPM_WINDOW_MS
    while (this.history.length > 0 && this.history[0] <= cutoff)
      this.history.shift()
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>
      const onAbort = () => {
        clearTimeout(timer)
        reject(new BrainRequestAbortedError())
      }
      timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }, ms)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private waitForRelease(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      // `waiter` and `onAbort` reference each other, so one must be declared
      // before it is assigned; neither body runs until the promise settles.
      let waiter: () => void
      const onAbort = () => {
        // Drop the waiter so a later release does not resolve a dead request.
        const idx = this.releaseWaiters.indexOf(waiter)
        if (idx >= 0)
          this.releaseWaiters.splice(idx, 1)
        reject(new BrainRequestAbortedError())
      }
      waiter = () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      }
      this.releaseWaiters.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }
}
