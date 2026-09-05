import type { Readable } from 'node:stream'

import type { MemoryContextResult, PreparedModelMemory } from '../../../../src/memory/text-observer'
import type { TraceMemoryAuthority } from '../../../../src/memory/trace-authority'
import type { VoiceMemoryAdapter } from '../../../../src/memory/voice-memory-adapter'
import type { AsrInput, AsrProvider, AsrResult } from '../../../../src/providers/asr/types'
import type { BrainProvider, BrainRequest } from '../../../../src/providers/brain/types'
import type { TtsProvider, TtsRequest } from '../../../../src/providers/tts/types'
import type { PlaybackResult } from '../../../../src/voice/playback'
import type { VoiceUtterance } from '../../../../src/voice/types'
import type { VoiceSampleDiagnosticId } from '../contracts'
import type { VoiceDurableStatement, VoiceMemoryTransition, VoiceTimedAuthorityOperation, VoiceTimedMemoryMethod } from '../voice-sample-diagnostics'
import type { BenchmarkSignal, CallTrace } from './barrier'

import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

import { buildDiscordActorEvidence } from '../../../../src/memory/discord-actor-snapshot'
import { createCallTrace, createSignal } from './barrier'
import { syntheticSnowflake } from './text'

/**
 * Benchmark-owned deterministic fakes for the voice-orchestration path.
 *
 * The VoiceManager fake is the single playback + event-bus seam the
 * ConversationController drives: the benchmark emits `utterance` on it to start
 * a turn and asserts cancellation by observing `stopPlayback`,
 * `cancelPlaybackEpoch`, and the brain's abort signal.
 *
 * Every fake exposes the stage it is currently at as a {@link BenchmarkSignal},
 * and can be told to block at that stage until explicitly released. That is what
 * makes the four barge-in trigger stages genuinely distinct: the driver waits
 * for the named stage to be entered rather than sleeping and hoping.
 *
 * Injected behaviour applies to the first call only. Each cancellation sample
 * runs a follow-up turn on the same controller to prove it still accepts work,
 * and that follow-up must take the nominal path.
 */

/** A played-item record kept for cancellation postcondition checks. */
export interface PlayedItem {
  readonly guildId: string
  readonly turnId?: string
  readonly responseEpoch?: number
  readonly chunkIndex?: number
}

/** A VoiceManager fake that holds playback promises open until released. */
export interface VoiceManagerFake {
  readonly played: readonly PlayedItem[]
  readonly cancelledEpochs: readonly number[]
  readonly stops: readonly string[]
  /** Fires when `playAudioStream` is first entered. */
  readonly playbackEnqueued: BenchmarkSignal
  on: (event: string, listener: (payload: unknown) => void) => void
  emit: (event: string, payload: unknown) => void
  playAudioStream: (guildId: string, stream: Readable, item?: Partial<PlayedItem>) => Promise<PlaybackResult>
  awaitPlaybackDrained: (guildId: string, epoch: number) => Promise<void>
  cancelPlaybackEpoch: (guildId: string, epoch: number) => void
  stopPlayback: (guildId: string, reason?: string) => void
  /** Settle every still-held playback promise as played, so a draining turn can complete. */
  finishPlayback: () => void
}

/** One held playback awaiting release. */
interface HeldPlayback {
  readonly responseEpoch: number | undefined
  readonly settle: (result: PlaybackResult) => void
}

export function createBenchmarkVoiceManagerFake(options: { manualPlayback?: boolean } = {}): VoiceManagerFake {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const played: PlayedItem[] = []
  const cancelledEpochs: number[] = []
  const stops: string[] = []
  const playbackEnqueued = createSignal()
  let held: HeldPlayback[] = []

  /** Settle held playbacks matching `predicate` with the given status. */
  const settleHeld = (predicate: (item: HeldPlayback) => boolean, status: PlaybackResult['status']): void => {
    const matching = held.filter(predicate)
    held = held.filter(item => !predicate(item))
    for (const item of matching)
      item.settle({ status, durationMs: status === 'played' ? 1 : 0 })
  }

  return {
    played,
    cancelledEpochs,
    stops,
    playbackEnqueued,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? [])
        listener(payload)
    },
    async playAudioStream(guildId: string, _stream: Readable, item?: Partial<PlayedItem>): Promise<PlaybackResult> {
      played.push({ guildId, ...item })
      playbackEnqueued.fire()
      if (!options.manualPlayback)
        return { status: 'played', durationMs: 1 }
      return new Promise<PlaybackResult>((resolve) => {
        held.push({ responseEpoch: item?.responseEpoch, settle: resolve })
      })
    },
    async awaitPlaybackDrained() {},
    cancelPlaybackEpoch(_guildId: string, epoch: number) {
      cancelledEpochs.push(epoch)
      // A real scheduler drops the epoch's queued audio and settles its promise
      // as cancelled. Resolving it as `played` instead would let the benchmark
      // observe a completed delivery for audio that was actually killed, which
      // is exactly the stale-delivery case the postconditions must catch.
      settleHeld(item => item.responseEpoch === epoch, 'cancelled')
    },
    stopPlayback(_guildId: string, reason?: string) {
      stops.push(reason ?? 'cancelled')
      settleHeld(() => true, 'cancelled')
    },
    finishPlayback() {
      settleHeld(() => true, 'played')
    },
  }
}

/**
 * Build a content-free voice utterance fixture.
 *
 * The synthetic speaker identity is derived from the measured ordinal, not just
 * the workload. v1 ignored the ordinal, so every sample in a workload spoke as
 * the same user with the same transcript — and the controller's duplicate
 * transcript filter silently discarded every sample after the first. The room
 * (guild/channel) stays stable so the workload keeps one conversational room.
 */
export function createBenchmarkUtterance(workloadId: string, seed: number, ordinal: number, role = 'speaker'): VoiceUtterance {
  const endedAt = Date.now()
  const guildId = syntheticSnowflake(seed, workloadId, 'guild')
  const userId = syntheticSnowflake(seed, workloadId, `${role}-${ordinal}`)
  return {
    guildId,
    channelId: syntheticSnowflake(seed, workloadId, 'channel'),
    userId,
    displayName: 'synthetic-actor',
    actorEvidence: buildDiscordActorEvidence({ userId, displayName: 'synthetic-actor', observedAtEpochMs: endedAt - 1000, source: 'gateway' }),
    pcm: Buffer.alloc(320),
    sampleRate: 16000,
    channels: 1,
    startedAt: endedAt - 1000,
    endedAt,
  }
}

/** An ASR fake that returns a scripted sequence of transcripts. */
export function createBenchmarkAsrFake(options: {
  readonly transcript?: string
  readonly language?: string
  readonly failures?: number
}): AsrProvider & { readonly callCount: number } {
  let callCount = 0
  return {
    get callCount() { return callCount },
    async transcribe(_input: AsrInput): Promise<AsrResult> {
      callCount += 1
      if (callCount <= (options.failures ?? 0))
        throw new DOMException('ASR timed out', 'AbortError')
      // A distinct transcript per call keeps the controller's duplicate filter
      // from discarding the follow-up turn a cancellation sample depends on.
      return {
        text: `${options.transcript ?? 'bench-transcript'} ${callCount}.`,
        language: options.language ?? 'en',
        inferenceMs: 1,
      }
    },
    async health() {
      return { ready: true }
    },
  }
}

/** How a TTS fake behaves on its first call. */
export interface TtsFakeOptions {
  /** Hold `synthesize` open until {@link BenchmarkTtsFake.release}; first call only. */
  readonly blockFirstCall?: boolean
  /** Number of leading calls that throw, so failure recovery can be observed. */
  readonly failures?: number
}

export interface BenchmarkTtsFake extends TtsProvider {
  readonly callCount: number
  readonly requests: readonly TtsRequest[]
  /** Fires when `synthesize` is first entered. */
  readonly entered: BenchmarkSignal
  /** Fires when a `synthesize` call first returns a stream. */
  readonly completed: BenchmarkSignal
  /** True once a scripted failure was actually thrown. */
  readonly failureInjected: boolean
  /** Release a blocked first call so the turn can unwind. */
  release: () => void
}

export function createBenchmarkTtsFake(options: TtsFakeOptions = {}): BenchmarkTtsFake {
  const requests: TtsRequest[] = []
  const entered = createSignal()
  const completed = createSignal()
  const gate = createSignal()
  let callCount = 0
  let failureInjected = false

  return {
    get callCount() { return callCount },
    get failureInjected() { return failureInjected },
    requests,
    entered,
    completed,
    release: () => gate.fire(),
    async synthesize(request: TtsRequest, _signal: AbortSignal): Promise<Readable> {
      callCount += 1
      requests.push(request)
      const isFirstCall = callCount === 1
      entered.fire()

      if (callCount <= (options.failures ?? 0)) {
        failureInjected = true
        throw new Error('TTS unavailable')
      }
      if (isFirstCall && options.blockFirstCall)
        await gate.promise

      const { Readable } = await import('node:stream')
      completed.fire()
      return Readable.from([])
    },
  }
}

/** Where a brain fake pauses or fails on its first call. */
export type VoiceBrainMode
  /** Yield every chunk and complete. */
  = | 'normal'
  /** Enter `generate`, then block before yielding anything. */
    | 'block-before-first-chunk'
  /** Yield one chunk, then block before the next. */
    | 'block-after-first-chunk'
  /** Throw a timeout-shaped provider error on entry. */
    | 'fail-on-entry'

export interface VoiceBrainFake extends BrainProvider {
  readonly requests: readonly BrainRequest[]
  readonly signals: readonly AbortSignal[]
  readonly callCount: number
  /** Fires when `generate` is first entered. */
  readonly entered: BenchmarkSignal
  /** Fires when the first chunk has been yielded downstream. */
  readonly firstChunkYielded: BenchmarkSignal
  /** True once a scripted provider failure was actually thrown. */
  readonly failureInjected: boolean
  /** Release a blocked first call so the turn can unwind. */
  release: () => void
  /** Fires when a second `generate` call is entered; proves the controller took another turn. */
  readonly followUpEntered: BenchmarkSignal
}

export function createBenchmarkVoiceBrainFake(options: {
  readonly chunks?: readonly string[]
  readonly mode?: VoiceBrainMode
} = {}): VoiceBrainFake {
  const requests: BrainRequest[] = []
  const signals: AbortSignal[] = []
  const entered = createSignal()
  const firstChunkYielded = createSignal()
  const followUpEntered = createSignal()
  const gate = createSignal()
  let callCount = 0
  let failureInjected = false

  return {
    requests,
    signals,
    entered,
    firstChunkYielded,
    followUpEntered,
    get callCount() { return callCount },
    get failureInjected() { return failureInjected },
    release: () => gate.fire(),
    async* generate(request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
      callCount += 1
      requests.push(request)
      signals.push(signal)
      // Injected behaviour is first-call only: the follow-up turn every
      // cancellation sample runs must take the nominal path, otherwise
      // `controller-accepts-next-turn` would be testing the injection instead.
      const mode = callCount === 1 ? options.mode ?? 'normal' : 'normal'
      if (callCount === 1)
        entered.fire()
      else
        followUpEntered.fire()

      if (mode === 'fail-on-entry') {
        failureInjected = true
        // A real provider timeout surfaces to the controller as an abort-shaped
        // error. Injecting that error is what the recovery path actually sees;
        // waiting out a real timeout would only add nondeterministic latency.
        throw new DOMException('provider timed out', 'AbortError')
      }
      if (mode === 'block-before-first-chunk')
        await gate.promise

      // A sentence terminator makes the downstream chunker flush this text to
      // TTS rather than buffering it for a continuation that never comes.
      for (const [index, chunk] of (options.chunks ?? ['bench voice reply.']).entries()) {
        if (signal.aborted)
          return
        yield chunk
        if (index === 0) {
          firstChunkYielded.fire()
          if (mode === 'block-after-first-chunk')
            await gate.promise
        }
      }
    },
  }
}

/** One observed voice memory lifecycle call. */
export interface VoiceMemoryCall {
  readonly method: 'admit' | 'prepareGeneration' | 'recordPlayback' | 'completeGeneration' | 'cancelGeneration' | 'failGeneration' | 'endSession'
  readonly turnId?: string
  /** Playback status a `recordPlayback` call carried; only completed playback may become context. */
  readonly playbackStatus?: PlaybackResult['status']
  /** Context status `prepareGeneration` resolved; distinguishes the active and inert arms. Absent when it threw. */
  readonly contextStatus?: MemoryContextResult['status']
  /** Set instead of `contextStatus` when the call rejected: which failure it was, never why in words. */
  readonly diagnosticId?: VoiceSampleDiagnosticId
}

/**
 * The production deadline `createVoiceMemoryAdapter` puts around durable
 * context assembly rejects with this text.
 *
 * Matching it is what separates "the context authority was too slow" from every
 * other preparation failure, and production exposes no other signal — it throws
 * one `Error`, and adding a typed production diagnostic solely so the benchmark
 * could read it is exactly the production coupling this decorator exists to
 * avoid. The message is used only as a discriminator: it is mapped to a closed
 * id here and never travels into an artifact.
 */
const CONTEXT_DEADLINE_MESSAGE = /durable voice context deadline exceeded/i

/**
 * Classify one `prepareGeneration` rejection into the closed diagnostic set.
 *
 * Anything unrecognised is `context-preparation-failed` rather than described:
 * preparation is the call that rejected, so that much is known even when the
 * cause is not, and the alternative would be copying an exception message into
 * evidence that must stay content-free.
 */
export function classifyVoicePreparationFailure(error: unknown): VoiceSampleDiagnosticId {
  // NOTICE:
  // @moeru/std's errorMessageFrom is not a direct dependency of discord-bot, so
  // the message is extracted manually here, the same way `controller-runner.ts`
  // already does it. The lint rule suggesting errorMessageFrom does not apply
  // because the package is absent.
  // Removal condition: @moeru/std becomes a dependency of this package.
  const message = error instanceof Error ? error.message : String(error)
  return CONTEXT_DEADLINE_MESSAGE.test(message) ? 'context-deadline-exceeded' : 'context-preparation-failed'
}

/**
 * One timed transition of a voice memory call.
 *
 * Kept in a trace of its own rather than folded into {@link VoiceMemoryCall}.
 * The correctness trace is a statement about *which* calls happened and in what
 * order — the cancellation postconditions read it, and `since(mark)` slices it
 * — so inserting an `entered` record for every call would silently change what
 * "the calls observed after the barge-in" means.
 */
export interface VoiceTimingTraceEntry<TName extends string> {
  /** The closed identity of the call; never an argument, a turn id, or a message. */
  readonly name: TName
  /** Zero-based index among calls of this name on this trace; pairs a repeated call without a turn id. */
  readonly callOrdinal: number
  readonly transition: VoiceMemoryTransition
  /** Monotonic `performance.now()` at the transition; made sample-relative when the record is built. */
  readonly atMs: number
}

/** One timed transition of a voice memory adapter call. */
export type VoiceMemoryTimingEvent = VoiceTimingTraceEntry<VoiceTimedMemoryMethod>

/** One timed transition of a durable authority operation beneath an adapter call. */
export type VoiceAuthorityTimingEvent = VoiceTimingTraceEntry<VoiceTimedAuthorityOperation>

/** One timed transition of a transaction-control statement beneath an authority operation. */
export type VoiceDurableTimingEvent = VoiceTimingTraceEntry<VoiceDurableStatement>

export interface TracedVoiceMemoryAdapter extends VoiceMemoryAdapter {
  readonly trace: CallTrace<VoiceMemoryCall>
  /**
   * Entry/exit timings for the four nominal lifecycle calls, when the workload
   * asked for them. Absent otherwise, so no workload pays for an observation
   * nothing publishes.
   */
  readonly timingTrace: CallTrace<VoiceMemoryTimingEvent> | undefined
  /** Fires when the controller's cancellation path reaches durable memory. */
  readonly cancelGenerationCalled: BenchmarkSignal
  /** Fires when a turn commits its durable evidence. */
  readonly completeGenerationCalled: BenchmarkSignal
  /** Fires on whichever terminal state a turn reaches: complete, cancel, or fail. */
  readonly terminalStateReached: BenchmarkSignal
  /** Fires once `endSession` has finished, so the runtime can be closed after it. */
  readonly endSessionCompleted: BenchmarkSignal
  /** Diagnostics for every `prepareGeneration` that rejected, in the order observed. */
  readonly preparationDiagnosticIds: readonly VoiceSampleDiagnosticId[]
}

/**
 * Wrap a voice memory adapter so its lifecycle becomes observable.
 *
 * The cancellation postconditions are statements about the durable memory
 * lifecycle — that a cancelled turn was cancelled, never committed, and never
 * recorded a delivery afterwards. Production exposes no hook for that, and
 * adding one solely for the benchmark is forbidden, so the evidence is taken by
 * decorating the adapter the controller is handed. The delegate still performs
 * every real call: this observes, it does not replace.
 *
 * The signals exist so a driver can await a lifecycle transition instead of
 * sleeping. `cancel()` reaches memory last — after the epoch bump, the provider
 * abort, and the playback cancellation — so awaiting `cancelGenerationCalled`
 * means the whole cancellation sequence has run.
 *
 * `options.timing` additionally records when each nominal lifecycle call was
 * entered and how it exited. It is off by default: only the two condition-5
 * workloads publish a timing artifact, and an observation nothing reads is
 * overhead one arm of a matched pair might not share.
 */
export function traceVoiceMemory(delegate: VoiceMemoryAdapter, options: { readonly timing?: boolean } = {}): TracedVoiceMemoryAdapter {
  const trace = createCallTrace<VoiceMemoryCall>()
  const timingTrace = options.timing ? createCallTrace<VoiceMemoryTimingEvent>() : undefined
  const cancelGenerationCalled = createSignal()
  const completeGenerationCalled = createSignal()
  const terminalStateReached = createSignal()
  const endSessionCompleted = createSignal()
  const preparationDiagnosticIds: VoiceSampleDiagnosticId[] = []
  return {
    trace,
    timingTrace,
    cancelGenerationCalled,
    completeGenerationCalled,
    terminalStateReached,
    endSessionCompleted,
    preparationDiagnosticIds,
    admit: async (event, transcript) => {
      trace.record({ method: 'admit', turnId: event.turnId })
      await timed(timingTrace, 'admit', () => delegate.admit(event, transcript))
    },
    prepareGeneration: async (turnId, events) => {
      // A rejection here is the failure mode the artifacts could not name. The
      // controller catches it, ends the turn at `failGeneration`, and the
      // sample then dies waiting for a completion that will never come — so
      // without this branch the only evidence left was a watchdog timeout that
      // looked identical to every other way the turn could stall.
      let prepared: PreparedModelMemory
      try {
        prepared = await timed(timingTrace, 'prepareGeneration', () => delegate.prepareGeneration(turnId, events))
      }
      catch (error) {
        const diagnosticId = classifyVoicePreparationFailure(error)
        preparationDiagnosticIds.push(diagnosticId)
        trace.record({ method: 'prepareGeneration', turnId, diagnosticId })
        throw error
      }
      trace.record({ method: 'prepareGeneration', turnId, contextStatus: prepared.context.status })
      return prepared
    },
    recordPlayback: async (turnId, channelId, chunkIndex, text, result) => {
      trace.record({ method: 'recordPlayback', turnId, playbackStatus: result.status })
      await timed(timingTrace, 'recordPlayback', () => delegate.recordPlayback(turnId, channelId, chunkIndex, text, result))
    },
    // The ordering evidence is recorded on entry, but the signals fire on exit:
    // a driver that resumed before the delegate finished would race the
    // controller's own continuation after the same await.
    completeGeneration: async (turnId) => {
      trace.record({ method: 'completeGeneration', turnId })
      try {
        await timed(timingTrace, 'completeGeneration', () => delegate.completeGeneration(turnId))
      }
      finally {
        completeGenerationCalled.fire()
        terminalStateReached.fire()
      }
    },
    cancelGeneration: async (turnId) => {
      trace.record({ method: 'cancelGeneration', turnId })
      try {
        await delegate.cancelGeneration(turnId)
      }
      finally {
        cancelGenerationCalled.fire()
        terminalStateReached.fire()
      }
    },
    failGeneration: async (turnId) => {
      trace.record({ method: 'failGeneration', turnId })
      try {
        await delegate.failGeneration(turnId)
      }
      finally {
        terminalStateReached.fire()
      }
    },
    endSession: async (guildId) => {
      trace.record({ method: 'endSession' })
      try {
        await delegate.endSession(guildId)
      }
      finally {
        endSessionCompleted.fire()
      }
    },
  }
}

/**
 * Record entry and exit around one delegate call, then return what it returned.
 *
 * A no-op when no timing trace was requested, so the untimed workloads run the
 * delegate exactly as before. The call ordinal is derived from the entries
 * already recorded rather than kept in a counter: a sample makes at most a
 * handful of these calls, and reading it off the trace keeps the two from
 * drifting apart.
 */
async function timed<TName extends string, TResult>(
  timingTrace: CallTrace<VoiceTimingTraceEntry<TName>> | undefined,
  name: TName,
  call: () => Promise<TResult>,
): Promise<TResult> {
  if (!timingTrace)
    return call()

  const callOrdinal = timingTrace.entries.filter(entry => entry.name === name && entry.transition === 'entered').length
  const mark = (transition: VoiceMemoryTransition): void => {
    timingTrace.record({ name, callOrdinal, transition, atMs: performance.now() })
  }
  mark('entered')
  try {
    const result = await call()
    mark('resolved')
    return result
  }
  catch (error) {
    // Only that it rejected. The message is what the caller classifies into a
    // closed diagnostic id, and it never travels further than that.
    mark('rejected')
    throw error
  }
}

/**
 * Wrap a durable trace authority so each of its operations is timed.
 *
 * ROOT CAUSE:
 *
 * Adapter-level timing localised a 515.795 ms `voice-active-memory` sample to
 * 480.337 ms inside one `recordPlayback` call, and then stopped. `recordPlayback`
 * issues up to four authority operations — `appendSegments`, `beginDelivery`,
 * and two `transitionDelivery` calls — so "inside `recordPlayback`" was still
 * four candidate operations wide.
 *
 * The runtime is constructed by the benchmark and handed to
 * `createVoiceMemoryAdapter`, so its authority is decorated at that existing
 * injection seam. Production is untouched: the delegate performs every real
 * call, and nothing about the durable work changes — this observes when each
 * operation was entered and when it exited.
 *
 * Active arm only, and not by choice: the inert control has no runtime and
 * therefore no authority to decorate. The two arms already differ here by
 * construction, which is exactly what the active/control delta measures.
 */
export function traceVoiceAuthority(delegate: TraceMemoryAuthority, timingTrace: CallTrace<VoiceAuthorityTimingEvent>, durableTrace?: CallTrace<VoiceDurableTimingEvent>): TraceMemoryAuthority {
  const under = <TResult>(name: VoiceTimedAuthorityOperation, call: () => Promise<TResult>): Promise<TResult> =>
    timed(timingTrace, name, () => recordingDurableStatements(durableTrace, call))
  return {
    appendEvent: (authorization, input) => under('appendEvent', () => delegate.appendEvent(authorization, input)),
    beginGeneration: (authorization, input) => under('beginGeneration', () => delegate.beginGeneration(authorization, input)),
    transitionGeneration: (authorization, generation, from, to, at) => under('transitionGeneration', () => delegate.transitionGeneration(authorization, generation, from, to, at)),
    appendSegments: (authorization, generation, segments) => under('appendSegments', () => delegate.appendSegments(authorization, generation, segments)),
    beginDelivery: (authorization, input) => under('beginDelivery', () => delegate.beginDelivery(authorization, input)),
    transitionDelivery: (authorization, transition) => under('transitionDelivery', () => delegate.transitionDelivery(authorization, transition)),
  }
}

/**
 * Where a statement observed by the probe is currently being recorded, if
 * anywhere.
 *
 * Module-scoped because the probe patches a prototype and so has no per-database
 * identity to key on, and gated rather than always-on because an ungated probe
 * would time every `exec` in the process — the open-time pragmas, the
 * search-index maintenance, the reconciliation passes — none of which is under
 * investigation. Nothing is recorded unless an authority operation is on the
 * stack, so the artifact carries exactly the transaction control of the six
 * operations already being timed.
 *
 * Safe as a single slot because `node:sqlite` is synchronous and the benchmark
 * runs one sample at a time against one runtime: no second operation can begin
 * between this being set and being restored.
 */
let durableStatementSink: ((statement: VoiceDurableStatement, transition: VoiceMemoryTransition) => void) | undefined

/**
 * Classify one executed statement into the closed durable vocabulary.
 *
 * Reads the leading keyword only, so `BEGIN IMMEDIATE` and `BEGIN EXCLUSIVE`
 * are both `begin`, and anything the repositories do not use for transaction
 * control is `other`. The SQL never leaves this function, which is what makes
 * the published field content-free by construction rather than by review.
 */
export function classifyDurableStatement(sql: string): VoiceDurableStatement {
  const leading = sql.trimStart().slice(0, 8).toUpperCase()
  if (leading.startsWith('BEGIN'))
    return 'begin'
  if (leading.startsWith('COMMIT'))
    return 'commit'
  if (leading.startsWith('ROLLBACK'))
    return 'rollback'
  return 'other'
}

/**
 * Time the transaction control of one authority operation.
 *
 * A no-op without a durable trace, so every workload that did not ask for this
 * runs the delegate exactly as before. The previous sink is restored rather
 * than cleared: the authority issues its operations in sequence rather than
 * nested, but restoring keeps the invariant true if that ever changes.
 */
async function recordingDurableStatements<TResult>(durableTrace: CallTrace<VoiceDurableTimingEvent> | undefined, call: () => Promise<TResult>): Promise<TResult> {
  if (!durableTrace)
    return call()

  const previous = durableStatementSink
  durableStatementSink = (statement, transition) => {
    // `entered` opens a new ordinal; its exit reuses the one just opened, so a
    // pair always carries the same ordinal without a counter to keep in step.
    const entered = durableTrace.entries.filter(entry => entry.name === statement && entry.transition === 'entered').length
    durableTrace.record({ name: statement, callOrdinal: transition === 'entered' ? entered : Math.max(0, entered - 1), transition, atMs: performance.now() })
  }
  try {
    return await call()
  }
  finally {
    durableStatementSink = previous
  }
}

/**
 * Observe the transaction boundaries beneath the durable authority.
 *
 * ROOT CAUSE:
 *
 * Authority-level timing localised a 410.899 ms `voice-active-memory` sample to
 * 369.074 ms inside one `DeliveryRepository.transition` call and stopped there,
 * because the authority port is the deepest seam the benchmark is handed.
 * `transition` is one `BEGIN IMMEDIATE`, five prepared statements, and one
 * `COMMIT`, so "inside `transition`" is still three candidate intervals wide:
 * the write-lock acquisition, the statements, and the durable commit.
 *
 * The runtime opens its own database and does not expose it, so no injected
 * object is left to decorate. This patches `DatabaseSync.prototype.exec`
 * instead — the one method the `BEGIN` / `COMMIT` / `ROLLBACK` triple runs
 * through, while every read and write runs through prepared statements it does
 * not touch. The wrapper delegates unconditionally and rethrows unchanged, so
 * no statement, transaction, or durability semantic differs; it observes when
 * `exec` was entered and when it returned.
 *
 * It is a process-global patch, which is why it is installed for the
 * condition-5 active workload only and uninstalled in the same `finally` that
 * closes the runtime. Returns its own uninstaller, which restores the original
 * method only if nothing else replaced it in the meantime.
 */
export function installDurableStatementProbe(): () => void {
  const original = DatabaseSync.prototype.exec
  const patched = function (this: DatabaseSync, ...args: Parameters<DatabaseSync['exec']>): ReturnType<DatabaseSync['exec']> {
    const sink = durableStatementSink
    if (!sink)
      return original.apply(this, args)

    const statement = classifyDurableStatement(String(args[0]))
    sink(statement, 'entered')
    try {
      const result = original.apply(this, args)
      sink(statement, 'resolved')
      return result
    }
    catch (error) {
      // Only that it rejected, on the same terms as every other timed boundary.
      sink(statement, 'rejected')
      throw error
    }
  }
  DatabaseSync.prototype.exec = patched
  return () => {
    if (DatabaseSync.prototype.exec === patched)
      DatabaseSync.prototype.exec = original
  }
}

/** An inert voice memory adapter; mirrors the active lifecycle but resolves disabled context. */
export function createInertVoiceMemoryAdapter(): VoiceMemoryAdapter & { readonly callCount: number } {
  let callCount = 0
  const bump = (): void => {
    callCount += 1
  }
  return {
    get callCount() { return callCount },
    async admit() { bump() },
    async prepareGeneration() {
      bump()
      return { context: { status: 'disabled' } satisfies MemoryContextResult } satisfies PreparedModelMemory
    },
    async recordPlayback() { bump() },
    async completeGeneration() { bump() },
    async cancelGeneration() { bump() },
    async failGeneration() { bump() },
    async endSession() { bump() },
  }
}
