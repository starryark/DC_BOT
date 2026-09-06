import type { SpeechAuthorityContext } from '../providers/tts/types'
import type { VoiceUtterance } from './types'
import type { VoiceManager } from './voice-manager'

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { connect, Socket } from 'node:net'
import { PassThrough } from 'node:stream'

export const PCM_PROTOCOL = 'voice-agent.discord-pcm.v1'
const MAX_RECORD = 8192
const MAX_SOCKET_BYTES = 65536
const MAX_SOURCES = 8

export interface BridgeOptions {
  port: number
  token: string
  createSocket?: () => Socket
  mode?: 'off' | 'shadow' | 'active'
}

export interface CaptureFrame {
  guildId: string
  channelId: string
  userId: string
  pcm: Buffer
  ssrc?: number
}

export interface FloorDecision {
  type: 'floor.decision'
  decision: 'TAKE_TURN' | 'STOP_SPEAKING' | 'BACKCHANNEL' | 'LISTEN' | 'CONTINUE_LISTENING'
  guild_id: string
  stream_id: string
  revision_id: string
  floor_epoch: number
  text: string
  language: 'zh' | 'en' | 'ja' | 'auto'
}

interface SourceState {
  generation: number
  frame: CaptureFrame
  streamId?: string
  nextSample: number
  pending: { start: number, pcm: Buffer }[]
  ending: boolean
  utterance?: VoiceUtterance
}

interface SpeechState {
  guildId: string
  id: string
  audio: PassThrough
  resolve: (audio: PassThrough) => void
  reject: (error: Error) => void
  started: boolean
  cleanup: () => void
}

/** One bounded, authenticated, replaceable connection to the Python voice service. */
export class VoiceModelBridge extends EventEmitter {
  private socket?: Socket
  private epoch = randomUUID()
  private generation = 0
  private ready = false
  private input = Buffer.alloc(0)
  private sources = new Map<number, SourceState>()
  private byMember = new Map<string, SourceState>()
  private speeches = new Map<string, SpeechState>()
  private command?: { id: string, resolve: (authority: SpeechAuthorityContext) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout> }

  constructor(private readonly options: BridgeOptions) {
    super()
    if (!options.token || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
      throw new Error('Voice model bridge requires a token and valid local port')
  }

  async start(): Promise<void> {
    if (this.socket)
      throw new Error('Bridge already connected')
    this.epoch = randomUUID()
    this.generation = 0
    const socket = this.options.createSocket?.() ?? connect({ host: '127.0.0.1', port: this.options.port })
    this.socket = socket
    socket.setNoDelay(true)
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.close(); reject(new Error('Voice bridge handshake timed out')) }, 5000)
      const onReady = () => { clearTimeout(timer); resolve() }
      this.once('ready', onReady)
      socket.once('connect', () => this.write({ type: 'hello', token: this.options.token }, true))
      socket.on('data', bytes => this.receive(bytes))
      socket.on('error', () => { clearTimeout(timer); reject(new Error('Voice bridge connection failed')); this.close() })
      socket.once('close', () => {
        clearTimeout(timer)
        this.off('ready', onReady)
        reject(new Error('Voice bridge disconnected'))
        this.close()
      })
    })
  }

  bind(voice: VoiceManager): () => void {
    const frame = (value: CaptureFrame) => this.capture(value)
    const end = (value: { guildId: string, userId: string, utterance?: VoiceUtterance }) => this.end(value.guildId, value.userId, value.utterance)
    const abort = (value: { guildId: string, userId?: string }) => this.abortSources(value.guildId, value.userId)
    voice.on('pcmFrame', frame)
    voice.on('pcmEnd', end)
    voice.on('pcmAbort', abort)
    return () => { voice.off('pcmFrame', frame); voice.off('pcmEnd', end); voice.off('pcmAbort', abort) }
  }

  capture(frame: CaptureFrame): void {
    if (!this.ready || !frame.pcm.length || frame.pcm.length % 2)
      return
    const key = `${frame.guildId}:${frame.userId}`
    let state = this.byMember.get(key)
    if (state && (state.ending || state.frame.channelId !== frame.channelId || state.frame.ssrc !== frame.ssrc)) {
      this.abortSources(frame.guildId, frame.userId)
      state = undefined
    }
    if (!state) {
      if (this.sources.size >= MAX_SOURCES)
        return
      state = { generation: this.generation++, frame: { ...frame, pcm: Buffer.alloc(0) }, nextSample: 0, pending: [], ending: false }
      this.sources.set(state.generation, state)
      this.byMember.set(key, state)
      if (!this.write({ type: 'source.open', source: { guild_id: frame.guildId, channel_id: frame.channelId,
        member_id: frame.userId, connection_epoch: this.epoch, source_epoch: state.generation, ssrc: frame.ssrc } }, true))
        return
    }
    for (let offset = 0; offset < frame.pcm.length; offset += 640) {
      const pcm = frame.pcm.subarray(offset, offset + 640)
      const start = state.nextSample
      state.nextSample += pcm.length / 2
      if (state.streamId)
        this.writePcm(state.streamId, start, pcm)
      else if (state.pending.length < 16)
        state.pending.push({ start, pcm: Buffer.from(pcm) })
    }
  }

  end(guildId: string, userId: string, utterance?: VoiceUtterance): void {
    const state = this.byMember.get(`${guildId}:${userId}`)
    if (!state)
      return
    state.utterance = utterance
    state.ending = true
    if (state.streamId)
      this.write({ type: 'source.close', stream_id: state.streamId, end_sample: state.nextSample }, true)
  }

  abortSources(guildId: string, userId?: string): void {
    for (const state of [...this.sources.values()]) {
      if (state.frame.guildId !== guildId || (userId && state.frame.userId !== userId))
        continue
      // Unknown source coordinates cannot be repaired by inventing silence.
      this.write({ type: 'source.abort', source_epoch: state.generation }, true)
      this.forget(state)
    }
    if (!userId) {
      this.emit('roomReset', guildId)
      this.write({ type: 'room.close', guild_id: guildId }, true)
    }
  }

  playback(guildId: string, active: boolean, text = '', floorEpoch?: number): void {
    this.write({ type: 'playback.state', guild_id: guildId, active, text: text.slice(-2048), floor_epoch: floorEpoch }, true)
  }

  authorizeCommand(guildId: string, channelId: string, memberId: string, commandId: string): Promise<SpeechAuthorityContext> {
    if (!this.ready || this.command)
      return Promise.reject(new Error('Voice command service unavailable'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.command?.id === commandId) { this.command = undefined; reject(new Error('Voice command authorization timed out')) }
      }, 5000)
      this.command = { id: commandId, resolve, reject, timer }
      this.write({ type: 'command.authorize', guild_id: guildId, channel_id: channelId, member_id: memberId, command_id: commandId }, true)
    })
  }

  synthesize(decision: SpeechAuthorityContext, text: string, language: string, signal: AbortSignal, prosody?: Readonly<{ pace: number, instruction: string }>): Promise<PassThrough> {
    if (!this.ready || this.speeches.size >= 2 || signal.aborted)
      return Promise.reject(new Error('Voice synthesis unavailable or cancelled'))
    const id = randomUUID()
    const audio = new PassThrough({ highWaterMark: 9600 })
    // A same-socket error may arrive before the promise consumer attaches its
    // listeners. Keep it observed; the errored stream still fails its reader.
    audio.on('error', () => {})
    Object.assign(audio, { voicePcmFormat: 's16le-48000-stereo' })
    return new Promise<PassThrough>((resolve, reject) => {
      const cancel = () => {
        this.write({ type: 'speech.cancel', speech_id: id }, true)
        audio.destroy()
        const speech = this.speeches.get(id)
        if (speech) {
          if (!speech.started)
            reject(new Error('Voice synthesis cancelled'))
          speech.cleanup()
          this.speeches.delete(id)
        }
      }
      this.speeches.set(id, { id, guildId: decision.guild_id, audio, resolve, reject, started: false, cleanup: () => signal.removeEventListener('abort', cancel) })
      signal.addEventListener('abort', cancel, { once: true })
      audio.once('close', () => { if (this.speeches.has(id)) cancel() })
      this.write({ type: 'speech.request', speech_id: id, guild_id: decision.guild_id,
        stream_id: decision.stream_id, revision_id: decision.revision_id, floor_epoch: decision.floor_epoch,
        text, language, prosody }, true)
    })
  }

  private writePcm(streamId: string, start: number, pcm: Buffer): void {
    this.write({ type: 'source.pcm', stream_id: streamId, start_sample: start, pcm_s16le_b64: pcm.toString('base64') }, false)
  }

  private write(record: object, control: boolean): boolean {
    const raw = `${JSON.stringify({ protocol: PCM_PROTOCOL, ...record })}\n`
    if (!this.socket || Buffer.byteLength(raw) > MAX_RECORD || this.socket.writableLength + Buffer.byteLength(raw) > MAX_SOCKET_BYTES) {
      if (control)
        this.close()
      return false
    }
    this.socket.write(raw)
    return true
  }

  private receive(bytes: Buffer): void {
    // Never concatenate an unbounded incoming socket chunk before validating lines.
    let rest = bytes
    while (rest.length) {
      const newline = rest.indexOf(10)
      const length = newline < 0 ? rest.length : newline
      if (this.input.length + length > MAX_RECORD) { this.close(); return }
      this.input = Buffer.concat([this.input, rest.subarray(0, length)])
      if (newline < 0)
        return
      try {
        const record = JSON.parse(this.input.toString('utf8'))
        this.input = Buffer.alloc(0)
        if (record.protocol !== PCM_PROTOCOL) { this.close(); return }
        this.record(record)
      }
      catch { this.close(); return }
      rest = rest.subarray(newline + 1)
    }
  }

  private record(record: any): void {
    if (record.type === 'command.authorized' && this.command?.id === record.command_id) {
      if (![record.guild_id, record.stream_id, record.revision_id].every(value => typeof value === 'string' && value)
        || !Number.isSafeInteger(record.floor_epoch)) throw new Error('Invalid command authority')
      clearTimeout(this.command.timer)
      this.command.resolve(Object.freeze({ guild_id: record.guild_id, stream_id: record.stream_id,
        revision_id: record.revision_id, floor_epoch: record.floor_epoch }))
      this.command = undefined
      return
    }
    if (record.type === 'speech.accepted' && record.prosody_degraded === true) {
      this.emit('degradation', { speechId: record.speech_id, kind: 'speech_prosody' })
      return
    }
    if (record.type === 'ready') {
      if (this.options.mode === 'active' && record.speech_available !== true)
        throw new Error('Active voice mode requires a speech-capable service')
      this.ready = true; this.emit('ready'); return
    }
    if (record.type === 'source.opened') {
      const state = this.sources.get(record.source_epoch)
      if (!state || typeof record.stream_id !== 'string')
        return
      state.streamId = record.stream_id
      for (const frame of state.pending)
        this.writePcm(state.streamId!, frame.start, frame.pcm)
      state.pending = []
      if (state.ending)
        this.write({ type: 'source.close', stream_id: state.streamId, end_sample: state.nextSample }, true)
      return
    }
    if (record.type === 'floor.decision') {
      const state = [...this.sources.values()].find(value => value.streamId === record.stream_id)
      if (!state || record.guild_id !== state.frame.guildId || typeof record.revision_id !== 'string'
        || !Number.isSafeInteger(record.floor_epoch) || record.floor_epoch < 0 || typeof record.text !== 'string'
        || !['zh', 'en', 'ja', 'auto'].includes(record.language)
        || !['TAKE_TURN', 'STOP_SPEAKING', 'BACKCHANNEL', 'LISTEN', 'CONTINUE_LISTENING'].includes(record.decision))
        return
      this.emit('decision', record as FloorDecision, state.utterance)
      return
    }
    if (record.type === 'source.closed') {
      const state = [...this.sources.values()].find(value => value.streamId === record.stream_id)
      if (state)
        this.forget(state)
      return
    }
    if (record.type === 'speech.chunk' && this.speeches.has(record.speech_id)) {
      if (typeof record.pcm_s16le_b64 !== 'string' || record.pcm_s16le_b64.length > 6400)
        throw new Error('Invalid speech payload')
      const data = Buffer.from(record.pcm_s16le_b64, 'base64')
      if (!data.length || data.toString('base64') !== record.pcm_s16le_b64 || data.length % 4 || record.sample_rate_hz !== 48000 || record.channels !== 2)
        throw new Error('Expected Discord PCM48 stereo')
      const speech = this.speeches.get(record.speech_id)!
      if (!speech.started) { speech.started = true; speech.resolve(speech.audio) }
      if (!speech.audio.write(data)) {
        speech.audio.once('drain', () => { if (this.speeches.has(speech.id)) this.write({ type: 'speech.credit', speech_id: speech.id }, true) })
      }
      else this.write({ type: 'speech.credit', speech_id: speech.id }, true)
      return
    }
    if ((record.type === 'speech.done' || record.type === 'speech.error') && this.speeches.has(record.speech_id)) {
      const speech = this.speeches.get(record.speech_id)!
      this.speeches.delete(record.speech_id)
      speech.cleanup()
      if (record.type === 'speech.error' || !speech.started) {
        const error = new Error('Voice model synthesis failed')
        if (!speech.started) { speech.reject(error); speech.audio.destroy() }
        else speech.audio.destroy(error)
      }
      else speech.audio.end()
    }
  }

  private forget(state: SourceState): void {
    this.sources.delete(state.generation)
    const key = `${state.frame.guildId}:${state.frame.userId}`
    if (this.byMember.get(key) === state)
      this.byMember.delete(key)
  }

  close(): void {
    const socket = this.socket
    if (!socket)
      return
    this.socket = undefined
    this.ready = false
    const guilds = [...new Set([...this.sources.values()].map(source => source.frame.guildId).concat([...this.speeches.values()].map(speech => speech.guildId)))]
    this.sources.clear()
    this.byMember.clear()
    this.input = Buffer.alloc(0)
    if (this.command) {
      clearTimeout(this.command.timer)
      this.command.reject(new Error('Voice service disconnected'))
      this.command = undefined
    }
    for (const speech of this.speeches.values()) {
      speech.cleanup()
      speech.reject(new Error('Voice service disconnected'))
      speech.audio.destroy(speech.started ? new Error('Voice service disconnected') : undefined)
    }
    this.speeches.clear()
    socket.destroy()
    this.emit('disconnected', guilds)
  }
}
