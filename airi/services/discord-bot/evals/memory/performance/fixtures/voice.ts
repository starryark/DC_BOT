import type { Readable } from 'node:stream'

import type { AsrProvider, AsrResult, AsrInput } from '../../../../src/providers/asr/types'
import type { BrainProvider, BrainRequest } from '../../../../src/providers/brain/types'
import type { TtsProvider, TtsRequest } from '../../../../src/providers/tts/types'
import type { PlaybackResult } from '../../../../src/voice/playback'
import type { VoiceUtterance } from '../../../../src/voice/types'
import type { VoiceMemoryAdapter } from '../../../../src/memory/voice-memory-adapter'
import type { MemoryContextResult, PreparedModelMemory } from '../../../../src/memory/text-observer'

import { Buffer } from 'node:buffer'

import { buildDiscordActorEvidence } from '../../../../src/memory/discord-actor-snapshot'
import { syntheticSnowflake } from './text'

/**
 * Benchmark-owned deterministic fakes for the voice-orchestration path.
 *
 * The VoiceManager fake is the single playback + event-bus seam the
 * ConversationController drives: the benchmark emits `utterance` on it to
 * start a turn and asserts cancellation by observing `stopPlayback`,
 * `cancelPlaybackEpoch`, and the brain's abort signal. Each fake accepts a
 * scripted delay/failure sequence, timestamps method entry, exposes numeric
 * counters, and stores no content.
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
  on(event: string, listener: (payload: unknown) => void): void
  emit(event: string, payload: unknown): void
  playAudioStream(guildId: string, stream: Readable, item?: Partial<PlayedItem>): Promise<PlaybackResult>
  awaitPlaybackDrained(guildId: string, epoch: number): Promise<void>
  cancelPlaybackEpoch(guildId: string, epoch: number): void
  stopPlayback(guildId: string, reason?: string): void
  /** Settle every held playback promise so a draining turn can complete. */
  finishPlayback(): void
}

export function createBenchmarkVoiceManagerFake(options: { manualPlayback?: boolean } = {}): VoiceManagerFake {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const played: PlayedItem[] = []
  const cancelledEpochs: number[] = []
  const stops: string[] = []
  let outstanding: Array<(result: PlaybackResult) => void> = []

  return {
    played,
    cancelledEpochs,
    stops,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? [])
        listener(payload)
    },
    async playAudioStream(guildId: string, _stream: Readable, item?: Partial<PlayedItem>): Promise<PlaybackResult> {
      played.push({ guildId, ...item })
      if (!options.manualPlayback)
        return { status: 'played', durationMs: 1 }
      return new Promise<PlaybackResult>((resolve) => {
        outstanding.push(resolve)
      })
    },
    async awaitPlaybackDrained() {},
    cancelPlaybackEpoch(_guildId: string, epoch: number) {
      cancelledEpochs.push(epoch)
    },
    stopPlayback(_guildId: string, reason?: string) {
      stops.push(reason ?? 'cancelled')
    },
    finishPlayback() {
      const pending = outstanding
      outstanding = []
      for (const resolve of pending)
        resolve({ status: 'played', durationMs: 1 })
    },
  }
}

/** Build a content-free voice utterance fixture. */
export function createBenchmarkUtterance(workloadId: string, seed: number, ordinal: number): VoiceUtterance {
  const endedAt = Date.now()
  const guildId = syntheticSnowflake(seed, workloadId, 'guild')
  const userId = syntheticSnowflake(seed, workloadId, 'user')
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
  readonly script?: readonly { text: string, language: string }[]
  readonly failures?: number
  readonly delayMs?: number
}): AsrProvider & { readonly callCount: number } {
  let callCount = 0
  let scriptIndex = 0
  return {
    get callCount() { return callCount },
    async transcribe(_input: AsrInput): Promise<AsrResult> {
      callCount += 1
      if (options.delayMs)
        await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (callCount <= (options.failures ?? 0))
        throw new DOMException('ASR timed out', 'AbortError')
      const scripted = options.script?.[scriptIndex++]
      return {
        text: scripted?.text ?? options.transcript ?? 'bench-transcript',
        language: scripted?.language ?? options.language ?? 'en',
        inferenceMs: 1,
      }
    },
    async health() {
      return { ready: true }
    },
  }
}

/** A TTS fake that returns an empty readable and can script delays/failures. */
export function createBenchmarkTtsFake(options: {
  readonly delayMs?: number
  readonly failures?: number
} = {}): TtsProvider & { readonly callCount: number, readonly requests: readonly TtsRequest[] } {
  const requests: TtsRequest[] = []
  let callCount = 0
  return {
    get callCount() { return callCount },
    requests,
    async synthesize(request: TtsRequest, _signal: AbortSignal): Promise<Readable> {
      callCount += 1
      requests.push(request)
      if (options.delayMs)
        await new Promise(resolve => setTimeout(resolve, options.delayMs))
      if (callCount <= (options.failures ?? 0))
        throw new Error('TTS unavailable')
      const { Readable } = await import('node:stream')
      return Readable.from([])
    },
  }
}

/** A brain fake for the voice path; shares the text-fake shape. */
export interface VoiceBrainFake extends BrainProvider {
  readonly requests: readonly BrainRequest[]
  readonly signals: readonly AbortSignal[]
  readonly callCount: number
}

export function createBenchmarkVoiceBrainFake(options: {
  readonly chunks?: readonly string[]
  readonly chunkDelayMs?: number
  readonly failure?: Error
}): VoiceBrainFake {
  const requests: BrainRequest[] = []
  const signals: AbortSignal[] = []
  let callCount = 0
  return {
    requests,
    signals,
    get callCount() { return callCount },
    generate: async function* (request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
      callCount += 1
      requests.push(request)
      signals.push(signal)
      if (options.failure)
        throw options.failure
      for (const chunk of options.chunks ?? ['bench-voice-reply']) {
        if (options.chunkDelayMs)
          await new Promise(resolve => setTimeout(resolve, options.chunkDelayMs))
        if (signal.aborted)
          return
        yield chunk
      }
    },
  }
}

/** An inert voice memory adapter; mirrors the active lifecycle but resolves disabled context. */
export function createInertVoiceMemoryAdapter(): VoiceMemoryAdapter & { readonly callCount: number } {
  let callCount = 0
  const bump = (): void => { callCount += 1 }
  return {
    get callCount() { return callCount },
    async admit() { bump() },
    async prepareGeneration() { bump(); return { context: { status: 'disabled' } satisfies MemoryContextResult } satisfies PreparedModelMemory },
    async recordPlayback() { bump() },
    async completeGeneration() { bump() },
    async cancelGeneration() { bump() },
    async failGeneration() { bump() },
    async endSession() { bump() },
  }
}
