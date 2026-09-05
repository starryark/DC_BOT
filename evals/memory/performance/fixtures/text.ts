import type { DiscordTextMemoryObserver, MemoryContextResult, PreparedModelMemory } from '../../../../src/memory/text-observer'
import type { DiscordMentionInputEvent } from '../../../../src/orchestration/events'
import type { BrainProvider, BrainRequest } from '../../../../src/providers/brain/types'
import type { BenchmarkSignal, CallTrace } from './barrier'

import { buildDiscordActorEvidence } from '../../../../src/memory/discord-actor-snapshot'
import { BenchmarkDeadlockError, createCallTrace, createSignal } from './barrier'

/**
 * Benchmark-owned deterministic fakes for the text-mention path.
 *
 * The brain fake can hold every `generate` call open until released, which is
 * what makes the queue and multi-room claims observable: with all calls blocked,
 * the number that reached the provider simultaneously distinguishes a shared
 * per-room queue from independent rooms. v1 asserted both properties from
 * "an event id came back".
 *
 * The inert memory observer mirrors the active adapter's lifecycle
 * (admit → prepareForModel → generated → delivering → deliveredSegment →
 * delivered) while resolving every context as `{ status: 'disabled' }`, so an
 * active-minus-inert delta isolates memory overhead from orchestration overhead.
 */

export interface BrainFake extends BrainProvider {
  readonly requests: readonly BrainRequest[]
  readonly signals: readonly AbortSignal[]
  readonly callCount: number
  /** Turn ids in the order `generate` was entered; the same-room queue must preserve request order. */
  readonly entryOrder: readonly string[]
  /** Highest number of `generate` calls in flight at once. */
  readonly maxConcurrent: number
  /** Release every blocked call so the turns can complete. */
  release: () => void
  /** Resolve once `count` calls have been entered; watchdog-bounded, never a sleep. */
  waitForEntries: (count: number, timeoutMs: number) => Promise<void>
}

/** A brain provider fake that replays a fixed chunk sequence, optionally blocking on entry. */
export function createBenchmarkBrainFake(options: {
  readonly chunks?: readonly string[]
  /** Hold every `generate` call open until {@link BrainFake.release}. */
  readonly blockUntilReleased?: boolean
  readonly failure?: Error
} = {}): BrainFake {
  const requests: BrainRequest[] = []
  const signals: AbortSignal[] = []
  const entryOrder: string[] = []
  const gate = createSignal()
  const waiters: Array<{ count: number, resolve: () => void }> = []
  let callCount = 0
  let inFlight = 0
  let maxConcurrent = 0

  const notifyWaiters = (): void => {
    for (let index = waiters.length - 1; index >= 0; index--) {
      if (entryOrder.length >= waiters[index]!.count) {
        waiters[index]!.resolve()
        waiters.splice(index, 1)
      }
    }
  }

  return {
    requests,
    signals,
    entryOrder,
    get callCount() { return callCount },
    get maxConcurrent() { return maxConcurrent },
    release: () => gate.fire(),
    async waitForEntries(count, timeoutMs) {
      if (entryOrder.length >= count)
        return
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            waiters.push({ count, resolve })
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new BenchmarkDeadlockError(`brain entries >= ${count}`, timeoutMs)), timeoutMs)
          }),
        ])
      }
      finally {
        if (timer)
          clearTimeout(timer)
      }
    },
    async* generate(request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
      callCount += 1
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      requests.push(request)
      signals.push(signal)
      entryOrder.push(request.turnId ?? `call-${callCount}`)
      notifyWaiters()
      try {
        if (options.failure)
          throw options.failure
        if (options.blockUntilReleased)
          await gate.promise
        for (const chunk of options.chunks ?? ['bench-reply-chunk']) {
          if (signal.aborted)
            return
          yield chunk
        }
      }
      finally {
        inFlight -= 1
      }
    },
  }
}

/** Which execution phase an identifier belongs to; warmup and measured never collide. */
export type FixturePhase = 'warmup' | 'measured'

/**
 * Build a content-free Discord mention event with a deterministic synthetic id.
 *
 * v1 appended `Math.random()` to the turn id so repeated samples would not
 * collide on the event idempotency key. That made the benchmark irreproducible
 * and meant an idempotency-collision defect could never surface. Identity is
 * derived from `(phase, ordinal, roomIndex)` instead, which is unique by
 * construction and identical across two runs of the same seed.
 *
 * The mention text carries its room index so a cross-room context leak is
 * visible in the compiled prompt the provider receives.
 */
export function createBenchmarkMentionEvent(input: {
  readonly workloadId: string
  readonly seed: number
  readonly phase: FixturePhase
  readonly ordinal: number
  readonly roomIndex?: number
}): DiscordMentionInputEvent {
  const roomIndex = input.roomIndex ?? 0
  const now = Date.now()
  const turnId = `bench-turn-${input.phase}-${input.ordinal}-r${roomIndex}`
  const userId = syntheticSnowflake(input.seed, input.workloadId, `user-${roomIndex}`)
  return {
    type: 'discord-mention',
    eventId: `${turnId}:in`,
    turnId,
    guildId: syntheticSnowflake(input.seed, input.workloadId, 'guild'),
    // A distinct channel per room index is what gives MentionResponder distinct
    // room queues, which is the property the multi-room workload measures.
    channelId: syntheticSnowflake(input.seed, input.workloadId, `channel-${roomIndex}`),
    userId,
    displayName: 'synthetic-actor',
    actorEvidence: buildDiscordActorEvidence({
      userId,
      displayName: 'synthetic-actor',
      observedAtEpochMs: now,
      source: 'gateway',
    }),
    timestamp: now,
    messageId: syntheticSnowflake(input.seed, input.workloadId, `msg-${input.phase}-${input.ordinal}-${roomIndex}`),
    text: `bench-mention-r${roomIndex}-${input.ordinal}`,
  }
}

/** One observed text memory lifecycle call. */
export interface TextMemoryCall {
  readonly method: 'admit' | 'prepareForModel' | 'generated' | 'delivering' | 'deliveredSegment' | 'delivered' | 'failed'
  readonly turnId: string
  /** Context status `prepareForModel` resolved; distinguishes the active and inert arms. */
  readonly contextStatus?: MemoryContextResult['status']
}

export interface TracedTextMemoryObserver extends DiscordTextMemoryObserver {
  readonly trace: CallTrace<TextMemoryCall>
}

/**
 * Wrap a text memory observer so its lifecycle order becomes observable.
 *
 * Both arms of the active/control pair are wrapped identically, so the delta
 * compares two runs of the same call sequence. v1 constructed an observer, threw
 * it away, and passed `{ status: 'disabled' }` to the responder in both arms —
 * the "active memory" workload never touched the active adapter at all.
 */
export function traceTextMemory(delegate: DiscordTextMemoryObserver): TracedTextMemoryObserver {
  const trace = createCallTrace<TextMemoryCall>()
  return {
    trace,
    admit: async (event, context) => {
      trace.record({ method: 'admit', turnId: event.turnId })
      await delegate.admit(event, context)
    },
    prepareForModel: async (event) => {
      const prepared = await delegate.prepareForModel(event)
      trace.record({ method: 'prepareForModel', turnId: event.turnId, contextStatus: prepared.context.status })
      return prepared
    },
    generated: async (event, chunks) => {
      trace.record({ method: 'generated', turnId: event.turnId })
      await delegate.generated(event, chunks)
    },
    delivering: async (event, segmentIndex) => {
      trace.record({ method: 'delivering', turnId: event.turnId })
      await delegate.delivering(event, segmentIndex)
    },
    deliveredSegment: async (event, segmentIndex, discordMessageId) => {
      trace.record({ method: 'deliveredSegment', turnId: event.turnId })
      await delegate.deliveredSegment(event, segmentIndex, discordMessageId)
    },
    delivered: async (event) => {
      trace.record({ method: 'delivered', turnId: event.turnId })
      await delegate.delivered(event)
    },
    failed: async (event, error) => {
      trace.record({ method: 'failed', turnId: event.turnId })
      await delegate.failed(event, error)
    },
  }
}

/** The lifecycle order both arms must execute, in order. */
export const TEXT_LIFECYCLE_SEQUENCE: readonly TextMemoryCall['method'][] = Object.freeze([
  'admit',
  'prepareForModel',
  'generated',
  'delivering',
  'deliveredSegment',
  'delivered',
])

/**
 * An inert text memory observer: every lifecycle method no-ops, and
 * `prepareForModel` resolves `{ status: 'disabled' }`.
 *
 * Used as the control half of an active/inert pair so the delta isolates real
 * memory overhead from orchestration overhead. The active half is the real
 * {@link createTextMemoryAdapter} wired to an isolated MemoryRuntime.
 */
export function createInertTextMemoryObserver(): DiscordTextMemoryObserver & { readonly callCount: number } {
  let callCount = 0
  const bump = (): void => {
    callCount += 1
  }
  return {
    get callCount() { return callCount },
    async admit() { bump() },
    async prepareForModel() {
      bump()
      return { context: { status: 'disabled' } satisfies MemoryContextResult } satisfies PreparedModelMemory
    },
    async generated() { bump() },
    async delivering() { bump() },
    async deliveredSegment() { bump() },
    async delivered() { bump() },
    async failed() { bump() },
  }
}

/** Deterministic synthetic snowflake; never a real Discord entity and never published. */
export function syntheticSnowflake(seed: number, workloadId: string, role: string): string {
  let h = (seed >>> 0) ^ 0x5BD1E995
  const input = `${workloadId}:${role}`
  for (let i = 0; i < input.length; i++)
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193)
  const value = 2_000_000_000_000_000_000n + BigInt(h >>> 0)
  return value.toString()
}

export type { BenchmarkSignal }
