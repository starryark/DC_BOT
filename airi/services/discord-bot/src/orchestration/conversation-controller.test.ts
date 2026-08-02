import type { Readable } from 'node:stream'

import type { AsrProvider, AsrResult } from '../providers/asr/types'
import type { BrainProvider, BrainRequest } from '../providers/brain/types'
import type { TtsProvider, TtsRequest } from '../providers/tts/types'
import type { PlaybackResult } from '../voice/playback'
import type { VoiceUtterance } from '../voice/types'

import { Buffer } from 'node:buffer'
import { env } from 'node:process'

import { afterEach, describe, expect, it } from 'vitest'

import { resetConfigCache } from '../config'
import { buildDiscordActorEvidence } from '../memory/discord-actor-snapshot'
import { BrainRateLimitError } from '../providers/brain/errors'
import { createSingleReferenceCatalog, parseVoiceProfileCatalog } from '../providers/tts/voice-profile-catalog'
import type { VoiceProfileCatalog } from '../providers/tts/speech-style-types'
import { ConversationController } from './conversation-controller'

afterEach(() => {
  delete env.BOT_INPUT_POLICY
  delete env.VOICE_GROUP_WINDOW_MS
  delete env.VOICE_ACTIVE_SPEAKER_LEASE_MS
  resetConfigCache()
})

/**
 * Orchestration tests.
 *
 * Two families live here: the Language_Fix_Proposal §25–§28 regressions (ASR
 * language propagates into TTS as a turn hint, strong text evidence may
 * override it, unknown falls back to auto) and the Optimize.md §10 turn
 * contract (half-duplex admission, epoch cancellation, playback-gated
 * completion, transactional history, quota cooldown).
 */

type VoiceListener = (payload: unknown) => void

interface PlayedItem {
  guildId: string
  turnId?: string
  responseEpoch?: number
  chunkIndex?: number
}

/**
 * Minimal VoiceManager fake.
 *
 * `manualPlayback` holds every `playAudioStream` promise open until
 * `finishPlayback()` is called, which is how the "a turn is not finished until
 * its audio is" contract is asserted without real Discord state.
 */
function makeVoiceFake(options: { manualPlayback?: boolean } = {}) {
  const listeners = new Map<string, VoiceListener[]>()
  const played: PlayedItem[] = []
  const cancelledEpochs: number[] = []
  const stops: string[] = []
  let outstanding: Array<(result: PlaybackResult) => void> = []

  return {
    played,
    cancelledEpochs,
    stops,
    on(event: string, listener: VoiceListener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event: string, payload: unknown) {
      for (const l of listeners.get(event) ?? [])
        l(payload)
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
    /** Settle every held playback promise. */
    finishPlayback() {
      const pending = outstanding
      outstanding = []
      for (const resolve of pending)
        resolve({ status: 'played', durationMs: 1 })
    },
  }
}

function makeUtterance(overrides: Partial<VoiceUtterance> = {}): VoiceUtterance {
  const endedAt = Date.now()
  return {
    guildId: 'g1',
    channelId: 'c1',
    userId: 'u1',
    displayName: 'Tester',
    actorEvidence: buildDiscordActorEvidence({ userId: 'u1', displayName: 'Tester', observedAtEpochMs: endedAt - 1000, source: 'gateway' }),
    pcm: Buffer.alloc(320),
    sampleRate: 16000,
    channels: 1,
    startedAt: endedAt - 1000,
    endedAt,
    ...overrides,
  }
}

interface HarnessOptions {
  asrLanguage?: string
  asrText?: string
  /** Successive ASR results; falls back to `asrText` once exhausted. */
  asrScript?: Array<{ text: string, language: string }>
  replyChunks?: string[]
  brainError?: Error
  manualPlayback?: boolean
  /** Delay between streamed chunks, so a turn can be cancelled mid-generation. */
  chunkDelayMs?: number
  /** Delay synthesis so disconnect can race an in-flight TTS request. */
  ttsDelayMs?: number
  /** Fail this many initial ASR calls. */
  asrFailures?: number
  /** Fail this many initial TTS calls. */
  ttsFailures?: number
  /** Overrides BOT_INPUT_POLICY for this harness. */
  inputPolicy?: 'half_duplex' | 'latest_wins' | 'barge_in'
  voiceProfileCatalog?: VoiceProfileCatalog
}

function buildController(opts: HarnessOptions) {
  env.VOICE_GROUP_WINDOW_MS = '5'
  env.VOICE_ACTIVE_SPEAKER_LEASE_MS = '1'
  resetConfigCache()
  if (opts.inputPolicy) {
    env.BOT_INPUT_POLICY = opts.inputPolicy
    resetConfigCache()
  }
  const voice = makeVoiceFake({ manualPlayback: opts.manualPlayback })
  const asrCalls: number[] = []
  const brainRequests: BrainRequest[] = []
  const ttsRequests: TtsRequest[] = []
  const brainSignals: AbortSignal[] = []
  const ttsSignals: AbortSignal[] = []
  let asrIndex = 0

  const asr: AsrProvider = {
    async transcribe(): Promise<AsrResult> {
      asrCalls.push(Date.now())
      if (asrCalls.length <= (opts.asrFailures ?? 0))
        throw new DOMException('ASR timed out', 'AbortError')
      const scripted = opts.asrScript?.[asrIndex++]
      return {
        text: scripted?.text ?? opts.asrText ?? 'hello there',
        language: scripted?.language ?? opts.asrLanguage ?? 'en',
        inferenceMs: 1,
      }
    },
    async health() {
      return { ready: true }
    },
  }

  const brain: BrainProvider = {
    async* generate(request: BrainRequest, signal: AbortSignal): AsyncIterable<string> {
      brainRequests.push(request)
      brainSignals.push(signal)
      if (opts.brainError)
        throw opts.brainError
      for (const chunk of opts.replyChunks ?? ['Sure, here you go.']) {
        if (opts.chunkDelayMs)
          await new Promise(resolve => setTimeout(resolve, opts.chunkDelayMs))
        yield chunk
      }
    },
  }

  const tts: TtsProvider = {
    async synthesize(request: TtsRequest, signal: AbortSignal): Promise<Readable> {
      ttsRequests.push(request)
      ttsSignals.push(signal)
      if (opts.ttsDelayMs)
        await new Promise(resolve => setTimeout(resolve, opts.ttsDelayMs))
      if (ttsRequests.length <= (opts.ttsFailures ?? 0))
        throw new Error('TTS unavailable')
      const { Readable } = await import('node:stream')
      return Readable.from([])
    },
  }

  const voiceProfileCatalog = opts.voiceProfileCatalog ?? createSingleReferenceCatalog({ referenceAudio: 'neutral.wav', referenceText: 'neutral reference', promptLanguage: 'ja' })
  const controller = new ConversationController({ voice: voice as never, asr, brain, tts, voiceProfileCatalog })
  return { controller, voice, asrCalls, brainRequests, ttsRequests, brainSignals, ttsSignals }
}

/** Let the controller's detached async handler run to completion. */
async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function testStyleCatalog(): VoiceProfileCatalog {
  const profile = (referenceAudio: string, temperature: number) => ({
    label: referenceAudio,
    referenceAudio,
    referenceText: 'exact reference transcript',
    promptLanguage: 'ja',
    topK: 15,
    topP: 0.95,
    temperature,
    repetitionPenalty: 1.35,
    speedFactor: 1,
    fragmentInterval: 0.12,
    textSplitMethod: 'cut0',
    variationSeeds: [1],
    warmup: false,
  })
  return parseVoiceProfileCatalog({
    schemaVersion: 1,
    catalogVersion: 'test-v1',
    defaultProfile: 'neutral',
    profiles: {
      neutral: profile('neutral.wav', 0.85),
      analytical: profile('analytical.wav', 0.65),
    },
    emotionMap: { think: 'analytical' },
  })
}

describe('conversationController — ASR→TTS language propagation', () => {
  // ROOT CAUSE:
  //
  // ACT metadata was consumed by a side-effect callback while the chunk stream
  // passed only plain text into TTS, so the observed emotion could not affect
  // the synthesis request for the following speech.
  it('attaches an ACT emotion to the following TTS request', async () => {
    const { voice, ttsRequests } = buildController({
      replyChunks: ['<|ACT:"emotion":{"name":"think","intensity":0.5},"motion":"looks at the screen"|>', 'Let me examine the evidence.'],
      voiceProfileCatalog: testStyleCatalog(),
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(ttsRequests).toHaveLength(1)
    expect(ttsRequests[0]).toMatchObject({
      conditioning: {
        profileId: 'analytical',
        referenceAudio: 'analytical.wav',
        temperature: 0.75,
      },
    })
  })

  it('routes a Chinese turn to TTS as zh (not ja)', async () => {
    const { voice, ttsRequests } = buildController({
      asrLanguage: 'zh',
      asrText: '你好',
      replyChunks: ['你好，有什么事吗？'],
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(ttsRequests.length).toBeGreaterThan(0)
    expect(ttsRequests.every(req => req.language === 'zh')).toBe(true)
  })

  it('routes an English turn to TTS as en', async () => {
    const { voice, ttsRequests } = buildController({
      asrLanguage: 'en',
      asrText: 'Hello there',
      replyChunks: ['Hi there, how can I help?'],
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(ttsRequests.every(req => req.language === 'en')).toBe(true)
  })

  it('routes a Japanese turn to TTS as ja', async () => {
    const { voice, ttsRequests } = buildController({
      asrLanguage: 'ja',
      asrText: 'こんにちは',
      replyChunks: ['こんにちは、どうしましたか？'],
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(ttsRequests.every(req => req.language === 'ja')).toBe(true)
  })

  it('falls back to the characterless English default when neither ASR nor text gives evidence', async () => {
    const { voice, ttsRequests } = buildController({
      asrLanguage: 'und',
      // NOTE: the input can no longer be a bare filler like "hmm" — the
      // transcript filter now rejects those before the model (Wave 1B).
      asrText: 'What about 42',
      replyChunks: ['42。'],
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(ttsRequests.length).toBeGreaterThan(0)
    expect(ttsRequests.every(req => req.language === 'en')).toBe(true)
  })

  it('lets strong generated-text evidence override the ASR hint', async () => {
    const { voice, ttsRequests } = buildController({
      asrLanguage: 'zh',
      asrText: '用英文打招呼',
      replyChunks: ['Hello, nice to meet you today.'],
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    for (const req of ttsRequests)
      expect(['en', 'auto']).toContain(req.language)
  })

  it('carries the turn language across multiple streamed chunks', async () => {
    const { voice, ttsRequests } = buildController({
      asrLanguage: 'zh',
      asrText: '今天聊什么',
      replyChunks: [
        '你好，今天我们可以先聊聊最近的实验进展。',
        '然后再看看还有哪些数据值得进一步分析？',
        '最后把重要的结论整理成一份清楚的记录！',
      ],
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(ttsRequests.length).toBe(3)
    expect(ttsRequests.map(r => r.language)).toEqual(['zh', 'zh', 'zh'])
  })
})

describe('conversationController — multi-speaker floor integration', () => {
  it('builds one Gemini request for two speakers inside the group window', async () => {
    const { voice, brainRequests } = buildController({
      asrScript: [
        { text: 'Can you explain that?', language: 'en' },
        { text: 'Specifically the cache part.', language: 'en' },
      ],
    })
    const now = Date.now()
    voice.emit('utterance', makeUtterance({ userId: 'u1', displayName: 'Patrick', startedAt: now - 100, endedAt: now }))
    voice.emit('utterance', makeUtterance({ userId: 'u2', displayName: 'Alice', startedAt: now + 1, endedAt: now + 2 }))
    await settle()

    expect(brainRequests).toHaveLength(1)
    const groupText = brainRequests[0].contents.at(-1)?.parts?.[0]?.text
    expect(groupText).toContain('Patrick')
    expect(groupText).toContain('Alice')
    expect(groupText).toContain('Reply once to the group')
  })

  it('uses a local TTS prompt and spends no Gemini request when a third speaker joins', async () => {
    const { voice, brainRequests, ttsRequests } = buildController({
      asrScript: [
        { text: 'First speaker message.', language: 'en' },
        { text: 'Second speaker message.', language: 'en' },
        { text: 'Third speaker message.', language: 'en' },
      ],
    })
    const now = Date.now()
    voice.emit('utterance', makeUtterance({ userId: 'u1', displayName: 'One', startedAt: now - 100, endedAt: now }))
    voice.emit('utterance', makeUtterance({ userId: 'u2', displayName: 'Two', startedAt: now + 1, endedAt: now + 2 }))
    voice.emit('utterance', makeUtterance({ userId: 'u3', displayName: 'Three', startedAt: now + 3, endedAt: now + 4 }))
    await settle()

    expect(brainRequests).toHaveLength(0)
    expect(ttsRequests).toEqual([{ text: '一人ずつ話してちょうだい。', language: 'ja' }])
  })

  it('cannot flush a group after its response epoch is cancelled', async () => {
    const { controller, voice, brainRequests } = buildController({ asrText: 'Pending group message.' })
    voice.emit('utterance', makeUtterance())
    await controller.cancelActiveResponse('g1', 'superseded')
    await settle()

    expect(brainRequests).toHaveLength(0)
  })
})

describe('conversationController — half-duplex admission', () => {
  // ROOT CAUSE:
  //
  // handleUtterance previously ran ASR and Gemini for every finalized utterance
  // regardless of what the bot was doing, so speaking over the bot produced a
  // second transcription and a second model request (baseline-findings.md §5).
  // Admission now runs before convertOpusToWav.
  it('drops speech that arrives while a turn is still playing, before ASR', async () => {
    const { voice, asrCalls, brainRequests } = buildController({
      asrText: 'first question',
      replyChunks: ['Answering now.'],
      manualPlayback: true,
    })

    voice.emit('utterance', makeUtterance())
    await settle()
    expect(asrCalls).toHaveLength(1)

    // The first turn is still holding its playback open.
    voice.emit('utterance', makeUtterance({ userId: 'u2', displayName: 'Second' }))
    await settle()

    expect(asrCalls).toHaveLength(1)
    expect(brainRequests).toHaveLength(1)
  })

  it('accepts the next utterance only after the previous audio finished', async () => {
    const { voice, asrCalls } = buildController({
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
      replyChunks: ['Answering now.'],
      manualPlayback: true,
    })

    voice.emit('utterance', makeUtterance())
    await settle()

    voice.emit('utterance', makeUtterance())
    await settle()
    expect(asrCalls).toHaveLength(1)

    voice.finishPlayback()
    await settle()

    voice.emit('utterance', makeUtterance())
    await settle()
    expect(asrCalls).toHaveLength(2)
  })

  it('keeps two guilds independent', async () => {
    const { voice, asrCalls } = buildController({
      asrScript: [
        { text: 'guild one question', language: 'en' },
        { text: 'guild two question', language: 'en' },
      ],
      replyChunks: ['Answering.'],
      manualPlayback: true,
    })

    voice.emit('utterance', makeUtterance({ guildId: 'g1' }))
    await settle()
    voice.emit('utterance', makeUtterance({ guildId: 'g2' }))
    await settle()

    // g1 being busy must not gate g2.
    expect(asrCalls).toHaveLength(2)
  })
})

describe('conversationController — transcript filtering', () => {
  it('never calls the model for a standalone filler', async () => {
    const { voice, brainRequests, ttsRequests } = buildController({
      asrLanguage: 'zh',
      asrText: '嗯。',
    })
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(brainRequests).toHaveLength(0)
    expect(ttsRequests).toHaveLength(0)
  })

  it('never calls the model twice for a repeated transcript', async () => {
    const { voice, brainRequests } = buildController({
      asrText: 'Hello.',
      replyChunks: ['Hi.'],
    })

    voice.emit('utterance', makeUtterance())
    await settle()
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(brainRequests).toHaveLength(1)
  })

  it('does not deduplicate the same words from a different speaker', async () => {
    const { voice, brainRequests } = buildController({
      asrText: 'Hello.',
      replyChunks: ['Hi.'],
    })

    voice.emit('utterance', makeUtterance({ userId: 'u1' }))
    await settle()
    const secondStartedAt = Date.now()
    voice.emit('utterance', makeUtterance({ userId: 'u2', displayName: 'Other', startedAt: secondStartedAt, endedAt: secondStartedAt + 1 }))
    await settle()

    expect(brainRequests).toHaveLength(2)
  })

  it('skips the model when ASR returns nothing', async () => {
    const { voice, brainRequests } = buildController({ asrText: '   ' })
    voice.emit('utterance', makeUtterance())
    await settle()
    expect(brainRequests).toHaveLength(0)
  })
})

describe('conversationController — history pairing', () => {
  it('commits a paired exchange after a successful turn', async () => {
    const { voice, brainRequests } = buildController({
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
      replyChunks: ['First answer.'],
    })

    voice.emit('utterance', makeUtterance())
    await settle()
    voice.emit('utterance', makeUtterance())
    await settle()

    // The second request carries the first exchange as history: one user turn
    // plus one model turn, then the new user turn.
    expect(brainRequests).toHaveLength(2)
    expect(brainRequests[1].contents).toHaveLength(3)
    expect(brainRequests[1].contents[0].role).toBe('user')
    expect(brainRequests[1].contents[1].role).toBe('model')
    expect(brainRequests[1].contents[2].role).toBe('user')
  })

  // ROOT CAUSE:
  //
  // The user turn used to be appended before generation and the model turn only
  // on success, so a failed or rate-limited turn left an unmatched user message
  // that was replayed as context forever after.
  it('commits nothing when generation is rate limited', async () => {
    const { voice, brainRequests } = buildController({
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
      brainError: new BrainRateLimitError('quota', { retryAfterMs: 5 }),
    })

    voice.emit('utterance', makeUtterance())
    await settle()

    // Wait out the short cooldown, then ask again.
    await settle(30)
    voice.emit('utterance', makeUtterance())
    await settle()

    const last = brainRequests[brainRequests.length - 1]
    // Only the current user turn — no orphaned message from the failed attempt.
    expect(last.contents).toHaveLength(1)
    expect(last.contents[0].role).toBe('user')
  })
})

describe('conversationController — quota cooldown', () => {
  it('suppresses further model calls while the cooldown is active', async () => {
    const { voice, brainRequests } = buildController({
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
        { text: 'third question', language: 'en' },
      ],
      brainError: new BrainRateLimitError('quota', { retryAfterMs: 60_000 }),
    })

    voice.emit('utterance', makeUtterance())
    await settle()
    expect(brainRequests).toHaveLength(1)

    voice.emit('utterance', makeUtterance())
    await settle()
    voice.emit('utterance', makeUtterance())
    await settle()

    // Every later utterance short-circuits before the provider.
    expect(brainRequests).toHaveLength(1)
  })

  it('speaks the unavailable notice at most once per interval', async () => {
    const { voice, ttsRequests } = buildController({
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
      brainError: new BrainRateLimitError('quota', { retryAfterMs: 60_000 }),
    })

    voice.emit('utterance', makeUtterance())
    await settle()
    voice.emit('utterance', makeUtterance())
    await settle()

    expect(ttsRequests).toHaveLength(1)
  })
})

describe('conversationController — cancellation', () => {
  it('aborts Gemini generation on disconnect', async () => {
    const { controller, voice, brainSignals } = buildController({
      replyChunks: ['A delayed response.'],
      chunkDelayMs: 100,
    })
    voice.emit('utterance', makeUtterance())
    await settle(20)

    await controller.cancelActiveResponse('g1', 'disconnect')

    expect(brainSignals).toHaveLength(1)
    expect(brainSignals[0].aborted).toBe(true)
  })

  it('aborts TTS and discards its late completion on disconnect', async () => {
    const { controller, voice, ttsSignals } = buildController({ ttsDelayMs: 80 })
    voice.emit('utterance', makeUtterance())
    await settle(20)

    await controller.cancelActiveResponse('g1', 'disconnect')
    await settle(100)

    expect(ttsSignals).toHaveLength(1)
    expect(ttsSignals[0].aborted).toBe(true)
    expect(voice.played).toHaveLength(0)
  })

  it('cancels the playback epoch and stops audio on disconnect', async () => {
    const { voice } = buildController({
      asrText: 'a question',
      replyChunks: ['Answering.'],
      manualPlayback: true,
    })

    voice.emit('utterance', makeUtterance())
    await settle()

    voice.emit('sessionEnd', { guildId: 'g1', channelId: 'c1' })
    await settle()

    expect(voice.cancelledEpochs.length).toBeGreaterThan(0)
    expect(voice.stops).toContain('disconnect')
  })

  // ROOT CAUSE:
  //
  // Cancellation used to stop only the player: generation, in-flight synthesis
  // and already-completed TTS results all survived, so audio from an abandoned
  // response could still reach the channel (baseline-findings.md §4). Every
  // async continuation is now epoch-checked.
  it('stops enqueuing audio once the turn has been cancelled mid-generation', async () => {
    const { voice } = buildController({
      asrText: 'a long question',
      replyChunks: ['One.', 'Two.', 'Three.', 'Four.'],
      chunkDelayMs: 15,
    })

    voice.emit('utterance', makeUtterance())
    await settle(20)
    const playedBeforeCancel = voice.played.length

    voice.emit('sessionEnd', { guildId: 'g1', channelId: 'c1' })
    await settle(120)

    // Generation may still be draining, but nothing new may be queued.
    expect(voice.played.length).toBe(playedBeforeCancel)
  })

  it('does not commit history for a cancelled turn', async () => {
    const { voice, brainRequests } = buildController({
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
      replyChunks: ['One.', 'Two.', 'Three.'],
      chunkDelayMs: 15,
    })

    voice.emit('utterance', makeUtterance())
    await settle(20)
    voice.emit('sessionEnd', { guildId: 'g1', channelId: 'c1' })
    await settle(120)

    voice.emit('utterance', makeUtterance())
    await settle(120)

    const last = brainRequests[brainRequests.length - 1]
    expect(last.contents).toHaveLength(1)
    expect(last.contents[0].role).toBe('user')
  })

  it('marks playback items with their turn and epoch so cancellation can find them', async () => {
    const { voice } = buildController({
      asrText: 'a question',
      replyChunks: [
        'The first complete playback item carries stable response metadata.',
        'The second complete playback item preserves the same turn ordering.',
      ],
    })

    voice.emit('utterance', makeUtterance())
    await settle()

    expect(voice.played).toHaveLength(2)
    expect(voice.played[0].responseEpoch).toBe(1)
    expect(voice.played[0].chunkIndex).toBe(0)
    expect(voice.played[1].chunkIndex).toBe(1)
    expect(voice.played[0].turnId).toBe(voice.played[1].turnId)
  })
})

describe('conversationController — provider fault recovery', () => {
  it('returns to a usable state after an ASR timeout', async () => {
    const { voice, asrCalls, brainRequests } = buildController({ asrFailures: 1 })
    voice.emit('utterance', makeUtterance())
    await settle()
    voice.emit('utterance', makeUtterance({ endedAt: Date.now() + 1 }))
    await settle()

    expect(asrCalls).toHaveLength(2)
    expect(brainRequests).toHaveLength(1)
  })

  it('returns to a usable state after GPT-SoVITS refuses a chunk', async () => {
    const { voice, brainRequests, ttsRequests } = buildController({
      ttsFailures: 1,
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
    })
    voice.emit('utterance', makeUtterance())
    await settle()
    voice.emit('utterance', makeUtterance({ endedAt: Date.now() + 10 }))
    await settle()

    expect(brainRequests).toHaveLength(2)
    expect(ttsRequests).toHaveLength(2)
  })
})

describe('conversationController — interrupting policies', () => {
  // ROOT CAUSE:
  //
  // admitUtterance lets busy-state speech through under latest_wins/barge_in,
  // but thinking → collecting is not a legal phase transition. Without an
  // explicit supersede the transition was rejected, the admitted utterance was
  // dropped anyway, and a guild_phase_transition_rejected warning was logged for
  // what is actually normal operation under those policies.
  it('supersedes the in-flight response under latest_wins', async () => {
    const { voice, asrCalls, brainRequests } = buildController({
      inputPolicy: 'latest_wins',
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
      replyChunks: ['One.', 'Two.', 'Three.'],
      chunkDelayMs: 15,
    })

    voice.emit('utterance', makeUtterance())
    await settle(20)
    expect(asrCalls).toHaveLength(1)

    // Speaking again mid-response takes the floor instead of being dropped.
    voice.emit('utterance', makeUtterance())
    await settle(120)

    expect(asrCalls).toHaveLength(2)
    expect(brainRequests).toHaveLength(2)
    expect(voice.cancelledEpochs.length).toBeGreaterThan(0)
  })

  it('still drops busy-state speech under the default half_duplex policy', async () => {
    const { voice, asrCalls } = buildController({
      inputPolicy: 'half_duplex',
      asrScript: [
        { text: 'first question', language: 'en' },
        { text: 'second question', language: 'en' },
      ],
      replyChunks: ['One.', 'Two.', 'Three.'],
      chunkDelayMs: 15,
    })

    voice.emit('utterance', makeUtterance())
    await settle(20)
    voice.emit('utterance', makeUtterance())
    await settle(120)

    expect(asrCalls).toHaveLength(1)
  })
})
