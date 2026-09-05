/**
 * Deterministic rendezvous primitives for benchmark drivers.
 *
 * A benchmark sample must advance because a named event happened, never because
 * an arbitrary sleep elapsed. v1's voice driver emitted an utterance, slept
 * 60ms, fired a barge-in, slept 40ms, and then asserted cancellation — so the
 * scenario it actually exercised depended on machine speed, and the four
 * "distinct" barge-in stages were the same race under four names.
 *
 * The timeout on {@link BenchmarkSignal.wait} is a deadlock watchdog: it exists
 * so a driver that will never be signalled fails loudly instead of hanging the
 * suite. It is never the mechanism by which a passing sample passes.
 */

import { performance } from 'node:perf_hooks'

/** Raised when a signal is not fired within its watchdog window. */
export class BenchmarkDeadlockError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`benchmark signal '${label}' was not fired within ${timeoutMs}ms`)
    this.name = 'BenchmarkDeadlockError'
  }
}

/**
 * A one-shot event two coroutines rendezvous on.
 *
 * The producer side awaits {@link promise} to block; the driver side calls
 * {@link fire} to release it. The driver side awaits {@link wait} to observe
 * that a stage was reached.
 */
export interface BenchmarkSignal {
  /** Whether the signal has already fired; safe to read at any time. */
  readonly fired: boolean
  /**
   * Monotonic `performance.now()` at which the signal *first* fired;
   * `undefined` until then.
   *
   * A later {@link fire} never replaces it: the stage was reached once, and a
   * repeated call is the same stage being re-entered, not a correction.
   */
  readonly firedAtMs: number | undefined
  /** Fire the signal. Idempotent: a second call is a no-op, not an error. */
  fire: () => void
  /** Resolves once fired. Blocking producers await this directly. */
  readonly promise: Promise<void>
  /** Await the signal with a deadlock watchdog; rejects with {@link BenchmarkDeadlockError}. */
  wait: (timeoutMs: number, label: string) => Promise<void>
}

export function createSignal(): BenchmarkSignal {
  let fired = false
  let firedAtMs: number | undefined
  let resolveFn: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve
  })

  return {
    get fired() {
      return fired
    },
    get firedAtMs() {
      return firedAtMs
    },
    promise,
    fire() {
      if (fired)
        return
      fired = true
      firedAtMs = performance.now()
      resolveFn()
    },
    async wait(timeoutMs, label) {
      if (fired)
        return
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new BenchmarkDeadlockError(label, timeoutMs)), timeoutMs)
          }),
        ])
      }
      finally {
        if (timer)
          clearTimeout(timer)
      }
    },
  }
}

/**
 * Yield once past the microtask queue.
 *
 * This is an ordering barrier, not a delay. `ConversationController.cancel()`
 * performs its final work — the log line and the transition back to `idle` —
 * in the synchronous continuation after `await memory.cancelGeneration(...)`.
 * A driver that resumes on that same await therefore sees a session that has
 * not yet returned to idle, and the follow-up turn it emits would be rejected
 * as arriving during a busy phase.
 *
 * `setImmediate` runs only after every pending microtask has drained, so one
 * yield deterministically places the driver after that continuation regardless
 * of machine speed. No duration is being waited out.
 */
export function drainPendingContinuations(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve))
}

/**
 * An ordered record of observed events, used to assert "X never happened after Y".
 *
 * Cancellation postconditions are about ordering, not just occurrence: a
 * `recordPlayback` before the barge-in is expected, the same call after it is a
 * stale delivery. A bare counter cannot tell those apart.
 */
export interface CallTrace<TEntry> {
  readonly entries: readonly TEntry[]
  record: (entry: TEntry) => void
  /** Mark the current position and return its index; entries at or after it happened later. */
  mark: () => number
  /** Entries recorded at or after `index`. */
  since: (index: number) => readonly TEntry[]
}

export function createCallTrace<TEntry>(): CallTrace<TEntry> {
  const entries: TEntry[] = []
  return {
    entries,
    record(entry) {
      entries.push(entry)
    },
    mark() {
      return entries.length
    },
    since(index) {
      return entries.slice(index)
    },
  }
}
