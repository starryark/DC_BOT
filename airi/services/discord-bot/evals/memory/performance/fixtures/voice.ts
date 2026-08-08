import type { Readable } from 'node:stream'

import type { MemoryContextResult, PreparedModelMemory } from '../../../../src/memory/text-observer'
import type { VoiceMemoryAdapter } from '../../../../src/memory/voice-memory-adapter'
import type { AsrInput, AsrProvider, AsrResult } from '../../../../src/providers/asr/types'
import type { BrainProvider, BrainRequest } from '../../../../src/providers/brain/types'
import type { TtsProvider, TtsRequest } from '../../../../src/providers/tts/types'
import type { PlaybackResult } from '../../../../src/voice/playback'
import type { VoiceUtterance } from '../../../../src/voice/types'
import type { BenchmarkSignal, CallTrace } from './barrier'

import { Buffer } from 'node:buffer'

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
  /** Context status `prepareGeneration` resolved; distinguishes the active and inert arms. */
  readonly contextStatus?: MemoryContextResult['status']
}

export interface TracedVoiceMemoryAdapter extends VoiceMemoryAdapter {
  readonly trace: CallTrace<VoiceMemoryCall>
  /** Fires when the controller's cancellation path reaches durable memory. */
  readonly cancelGenerationCalled: BenchmarkSignal
  /** Fires when a turn commits its durable evidence. */
  readonly completeGenerationCalled: BenchmarkSignal
  /** Fires on whichever terminal state a turn reaches: complete, cancel, or fail. */
  readonly terminalStateReached: BenchmarkSignal
  /** Fires once `endSession` has finished, so the runtime can be closed after it. */
  readonly endSessionCompleted: BenchmarkSignal
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
 */
export function traceVoiceMemory(delegate: VoiceMemoryAdapter): TracedVoiceMemoryAdapter {
  const trace = createCallTrace<VoiceMemoryCall>()
  const cancelGenerationCalled = createSignal()
  const completeGenerationCalled = createSignal()
  const terminalStateReached = createSignal()
  const endSessionCompleted = createSignal()
  return {
    trace,
    cancelGenerationCalled,
    completeGenerationCalled,
    terminalStateReached,
    endSessionCompleted,
    admit: async (event, transcript) => {
      trace.record({ method: 'admit', turnId: event.turnId })
      await delegate.admit(event, transcript)
    },
    prepareGeneration: async (turnId, events) => {
      const prepared = await delegate.prepareGeneration(turnId, events)
      trace.record({ method: 'prepareGeneration', turnId, contextStatus: prepared.context.status })
      return prepared
    },
    recordPlayback: async (turnId, channelId, chunkIndex, text, result) => {
      trace.record({ method: 'recordPlayback', turnId, playbackStatus: result.status })
      await delegate.recordPlayback(turnId, channelId, chunkIndex, text, result)
    },
    // The ordering evidence is recorded on entry, but the signals fire on exit:
    // a driver that resumed before the delegate finished would race the
    // controller's own continuation after the same await.
    completeGeneration: async (turnId) => {
      trace.record({ method: 'completeGeneration', turnId })
      try {
        await delegate.completeGeneration(turnId)
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
