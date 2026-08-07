import type { DiscordTextMemoryObserver, MemoryContextResult, PreparedModelMemory } from '../../../../src/memory/text-observer'
import type { DiscordMentionInputEvent } from '../../../../src/orchestration/events'
import type { BrainProvider, BrainRequest } from '../../../../src/providers/brain/types'

import { buildDiscordActorEvidence } from '../../../../src/memory/discord-actor-snapshot'

/**
 * Benchmark-owned deterministic fakes for the text-mention path.
 *
 * Each fake accepts a scripted delay/failure sequence, timestamps method entry,
 * exposes numeric counters, and stores no content. The inert memory observer
 * mirrors the active adapter's lifecycle (admit → prepareForModel → generated
 * → delivering → deliveredSegment → delivered) while resolving every context
 * as `{ status: 'disabled' }`, so an active-minus-inert delta isolates memory
 * overhead from orchestration overhead.
 */

/** A brain provider fake that replays a fixed chunk sequence with a scripted delay. */
export function createBenchmarkBrainFake(options: {
  readonly chunks?: readonly string[]
  readonly chunkDelayMs?: number
  readonly failure?: Error
}): BrainFake {
  const requests: BrainRequest[] = []
  const signals: AbortSignal[] = []
  const startTimes: number[] = []
  let callCount = 0
  return {
    requests,
    signals,
    startTimes,
    get callCount() { return callCount },
    async* generate(request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
      callCount += 1
      requests.push(request)
      signals.push(signal)
      startTimes.push(Date.now())
      if (options.failure)
        throw options.failure
      for (const chunk of options.chunks ?? ['bench-reply-chunk']) {
        if (options.chunkDelayMs)
          await new Promise(resolve => setTimeout(resolve, options.chunkDelayMs))
        if (signal.aborted)
          return
        yield chunk
      }
    },
  }
}

export interface BrainFake extends BrainProvider {
  readonly requests: readonly BrainRequest[]
  readonly signals: readonly AbortSignal[]
  readonly startTimes: readonly number[]
  readonly callCount: number
}

/** Build a content-free Discord mention event with a deterministic synthetic id. */
export function createBenchmarkMentionEvent(workloadId: string, seed: number, ordinal: number): DiscordMentionInputEvent {
  const now = Date.now()
  // Include a per-call random suffix so repeated samples against the same
  // active runtime do not collide on the event idempotency key.
  const nonce = Math.random().toString(36).slice(2, 10)
  const turnId = `bench-turn-${ordinal}-${nonce}`
  return {
    type: 'discord-mention',
    eventId: `${turnId}:in`,
    turnId,
    guildId: syntheticSnowflake(seed, workloadId, 'guild'),
    channelId: syntheticSnowflake(seed, workloadId, 'channel'),
    userId: syntheticSnowflake(seed, workloadId, 'user'),
    displayName: 'synthetic-actor',
    actorEvidence: buildDiscordActorEvidence({
      userId: syntheticSnowflake(seed, workloadId, 'user'),
      displayName: 'synthetic-actor',
      observedAtEpochMs: now,
      source: 'gateway',
    }),
    timestamp: now,
    messageId: syntheticSnowflake(seed, workloadId, `msg-${ordinal}`),
    text: `bench-mention-${ordinal}`,
  }
}

/**
 * An inert text memory observer: every lifecycle method no-ops, and
 * `prepareForModel` resolves `{ status: 'disabled' }`.
 *
 * Used as the control half of an active/inert pair so the delta isolates real
 * memory overhead from orchestration overhead. The active half is the real
 * {@link createTextMemoryAdapter} wired to a {@link ScenarioRuntime}.
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
