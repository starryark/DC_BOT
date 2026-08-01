import type { Readable } from 'node:stream'

import type { AudioPlayer, VoiceConnection, VoiceConnectionState } from '@discordjs/voice'
import type { Logg } from '@guiiai/logg'
import type {
  BaseGuildVoiceChannel,
  CacheType,
  ChatInputCommandInteraction,
  Client as DiscordClient,
  GuildMember,
} from 'discord.js'

import type { PlaybackItem, PlaybackPlayer, PlaybackPlayerHandlers, PlaybackResult, PlaybackStopReason } from './playback'
import type { GuildVoiceSession, UserCaptureSession, VoiceManagerEvents, VoiceUtterance } from './types'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream'

import {
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnections,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
} from '@discordjs/voice'
import { useLogg } from '@guiiai/logg'

import { config } from '../config'
import { DECODE_SAMPLE_RATE } from '../constants/audio'
import { convertOpusToWav } from '../utils/audio'
import { OpusDecoder } from '../utils/opus'
import { GuildPlaybackScheduler } from './playback'

/** 16 kHz mono 16-bit => 32 000 bytes per second of audio. */
const BYTES_PER_MS = (DECODE_SAMPLE_RATE * 2) / 1000

/**
 * Bridge the real `AudioPlayer` onto the scheduler's {@link PlaybackPlayer}
 * port.
 *
 * The scheduler is deliberately Discord-agnostic so its ordering and
 * cancellation rules can be tested without a gateway connection; this adapter
 * is the one place the two meet. Handlers are attached once per session and
 * removed by the returned disposer, which is why repeated playback cannot grow
 * the listener count.
 */
function adaptAudioPlayer(player: AudioPlayer): PlaybackPlayer {
  return {
    play: resource => player.play(resource as Parameters<AudioPlayer['play']>[0]),
    stop: () => player.stop(),
    observe: (handlers: PlaybackPlayerHandlers) => {
      const onStateChange = (_old: { status: string }, next: { status: string }) => {
        if (next.status === 'idle')
          handlers.onIdle()
      }
      const onError = (error: Error) => handlers.onError(error)
      player.on('stateChange', onStateChange)
      player.on('error', onError)
      return () => {
        player.off('stateChange', onStateChange)
        player.off('error', onError)
      }
    },
  }
}

async function setSelfVoice(logger: Logg, me?: GuildMember | null) {
  if (me?.voice && me.permissions.has('DeafenMembers')) {
    try {
      await me.voice.setDeaf(false)
      await me.voice.setMute(false)
    }
    catch (error) {
      logger.withError(error).log('Failed to modify voice state') // Continue anyway
    }
  }
}

/**
 * Typed EventEmitter helper so consumers get autocomplete on `.on('utterance', ...)`
 * without a runtime dependency.
 */
export class TypedVoiceEmitter extends EventEmitter {
  override on<K extends keyof VoiceManagerEvents>(event: K, listener: (...args: VoiceManagerEvents[K]) => void): this {
    return super.on(event, listener as (...args: any[]) => void)
  }

  override once<K extends keyof VoiceManagerEvents>(event: K, listener: (...args: VoiceManagerEvents[K]) => void): this {
    return super.once(event, listener as (...args: any[]) => void)
  }

  override off<K extends keyof VoiceManagerEvents>(event: K, listener: (...args: VoiceManagerEvents[K]) => void): this {
    return super.off(event, listener as (...args: any[]) => void)
  }

  override emit<K extends keyof VoiceManagerEvents>(event: K, ...args: VoiceManagerEvents[K]): boolean {
    return super.emit(event, ...(args as any[]))
  }

  override removeListener<K extends keyof VoiceManagerEvents>(event: K, listener: (...args: VoiceManagerEvents[K]) => void): this {
    return super.removeListener(event, listener as (...args: any[]) => void)
  }
}

/**
 * VoiceManager is a pure Discord voice transport.
 *
 * Responsibilities end at "emit a completed per-user utterance" and "play a
 * byte stream into a guild's voice channel". It deliberately knows nothing
 * about ASR, the LLM, TTS, or the AIRI server. The previous implementation had
 * a single global `processingVoice`/`transcriptionTimeout` pair that dropped
 * every other user's audio while one user was being transcribed and cleared
 * ALL users' buffers after a single transcription — this class fixes that by
 * keying all state per-guild and per-user.
 *
 * Endpointing (see plan.md §14): each captured PCM packet restarts a per-user
 * `finalizeTimer`. When the user goes silent for `voice.endSilenceMs`, the
 * timer fires and a {@link VoiceUtterance} is emitted. A new speaking burst or
 * a fresh packet cancels the pending timer.
 */
export class VoiceManager extends TypedVoiceEmitter {
  private logger = useLogg('VoiceManager').useGlobalConfig()

  /** One voice session per guild (Discord permits one bot connection per guild). */
  private sessions: Map<string, GuildVoiceSession> = new Map()

  /** Per-user capture bookkeeping, keyed `${guildId}:${userId}`. */
  private captures: Map<string, UserCaptureSession> = new Map()

  /** Opus-decoder pipelines kept alive while a user is subscribed, keyed `${guildId}:${userId}`. */
  private decoders: Map<string, Readable> = new Map()
  private endedSessions = new WeakSet<GuildVoiceSession>()

  private client: DiscordClient

  constructor(client: DiscordClient) {
    super()
    this.client = client
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  handleVoiceConnectionStateChange(session: GuildVoiceSession): (oldState: VoiceConnectionState, newState: VoiceConnectionState) => Promise<void> {
    return async (oldState, newState) => {
      this.logger.withFields({ old: oldState.status, new: newState.status }).log(
        `Voice connection state changed from ${oldState.status} to ${newState.status}`,
      )

      if (newState.status === VoiceConnectionStatus.Destroyed) {
        await this.teardownSession(session.guildId)
      }
      else if (newState.status === VoiceConnectionStatus.Disconnected) {
        this.logger.log('Handling disconnection...')
        try {
          await Promise.race([
            entersState(session.connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(session.connection, VoiceConnectionStatus.Connecting, 5_000),
          ])
          this.logger.log('Reconnecting to channel...')
        }
        catch {
          this.logger.log('Disconnection confirmed - cleaning up...')
          session.connection.destroy()
          await this.teardownSession(session.guildId)
        }
      }
    }
  }

  handleVoiceConnectionError(error: unknown) {
    this.logger.withError(error).log('Voice connection error')
    this.logger.log('Connection error - will attempt to recover...')
  }

  async joinChannel(channel: BaseGuildVoiceChannel) {
    const guildId = channel.guild.id
    const existing = this.sessions.get(guildId)
    if (existing) {
      try {
        existing.connection.destroy()
      }
      catch (error) {
        this.logger.withError(error).log('Error leaving previous voice channel')
      }
      await this.teardownSession(guildId)
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId,
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      selfDeaf: false,
      selfMute: false,
      group: this.client.user.id,
    })

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000)

      this.logger.withField('state', connection.state.status).log('Voice connection established in state')

      // One player per voice session, subscribed once. Creating a player per
      // chunk (the previous behaviour) is what let each chunk destroy the last.
      const audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } })
      connection.subscribe(audioPlayer)

      const session: GuildVoiceSession = {
        guildId,
        channelId: channel.id,
        connection,
        users: new Map(),
        audioPlayer,
        playback: new GuildPlaybackScheduler({
          guildId,
          player: adaptAudioPlayer(audioPlayer),
          createResource: item => createAudioResource(item.audio as Readable, { inputType: StreamType.Arbitrary }),
        }),
      }
      this.sessions.set(guildId, session)

      connection.on('stateChange', this.handleVoiceConnectionStateChange(session))
      connection.on('error', this.handleVoiceConnectionError)
      connection.receiver.speaking.on('start', this.handleSpeakingStart(session, channel))
      connection.receiver.speaking.on('end', this.handleSpeakingEnd(session, channel))

      await setSelfVoice(this.logger, channel.guild.members.me)

      this.emit('sessionStart', { guildId, channelId: channel.id })
    }
    catch (error) {
      this.logger.withError(error).log('Failed to establish voice connection')
      connection.destroy()
      await this.teardownSession(guildId)
      throw error
    }
  }

  private getVoiceConnection(guildId: string): VoiceConnection | undefined {
    const connections = getVoiceConnections(this.client.user.id)
    if (!connections) {
      this.logger.warn('No voice connections found')
      return undefined
    }
    const connection = [...connections.values()].find(c => c.joinConfig.guildId === guildId)
    if (!connection)
      this.logger.warn('No voice connection found for guild')
    return connection
  }

  /** Leave the voice channel in the guild referenced by the interaction. */
  async leaveChannel(guildId: string, channelId?: string): Promise<void> {
    const session = this.sessions.get(guildId)
    if (session) {
      try {
        session.connection.destroy()
      }
      catch (error) {
        this.logger.withError(error).log('Error leaving voice channel')
      }
      await this.teardownSession(guildId, channelId ?? session.channelId)
    }
    else {
      const connection = this.getVoiceConnection(guildId)
      connection?.destroy()
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Capture
  // ─────────────────────────────────────────────────────────────────────────

  private handleSpeakingStart(session: GuildVoiceSession, channel: BaseGuildVoiceChannel): (userId: string) => Promise<void> {
    return async (userId: string) => {
      // Never capture the bot itself.
      if (userId === this.client.user?.id)
        return

      let member = channel.members.get(userId)
      if (!member) {
        try {
          member = await channel.guild.members.fetch(userId)
        }
        catch (error) {
          this.logger.withError(error).error('Failed to fetch member')
          return
        }
      }
      if (member?.user.bot)
        return

      const displayName = member.displayName
      const key = captureKey(session.guildId, userId)
      const capture = this.ensureCapture(session, userId, displayName)

      // A new speaking burst cancels any pending finalize for this user.
      if (capture.finalizeTimer) {
        clearTimeout(capture.finalizeTimer)
        capture.finalizeTimer = undefined
      }
      capture.state = 'speaking'
      if (capture.speechStartedAt === 0)
        capture.speechStartedAt = Date.now()
      capture.lastPacketAt = Date.now()

      // Subscribe + wire the opus decoder once, then keep it alive.
      if (!this.decoders.has(key)) {
        this.logger.withFields({ displayName, userId }).log('User speaking: subscribing')
        this.subscribeMember(session, member, displayName)
      }
    }
  }

  private handleSpeakingEnd(_session: GuildVoiceSession, _channel: BaseGuildVoiceChannel): (userId: string) => void {
    return (userId: string) => {
      if (userId === this.client.user?.id)
        return
      // Discord's speaking-end is a hint, not a guarantee. We rely on the
      // trailing-silence finalize timer as the source of truth (plan.md §14),
      // but nudge it here so a clear stop finalizes promptly.
      const capture = this.captures.get(captureKey(_session.guildId, userId))
      if (capture && capture.state === 'speaking')
        this.scheduleFinalize(_session.guildId, userId)
    }
  }

  private ensureCapture(session: GuildVoiceSession, userId: string, displayName: string): UserCaptureSession {
    const key = captureKey(session.guildId, userId)
    let capture = this.captures.get(key)
    if (!capture) {
      capture = {
        userId,
        displayName,
        pcmChunks: [],
        totalBytes: 0,
        speechStartedAt: 0,
        lastPacketAt: 0,
        state: 'idle',
      }
      this.captures.set(key, capture)
      session.users.set(userId, capture)
    }
    return capture
  }

  /**
   * Subscribe to a member's receive stream, decode Opus → PCM16/16k/mono, and
   * route each decoded packet through {@link onPcmPacket}. Built once per user
   * per guild and torn down on session end.
   */
  private subscribeMember(session: GuildVoiceSession, member: GuildMember, displayName: string) {
    const guildId = session.guildId
    const userId = member.id
    const key = captureKey(guildId, userId)
    const connection = session.connection

    const receiveStream = connection.receiver.subscribe(userId, {
      autoDestroy: true,
      emitClose: true,
    })
    if (!receiveStream) {
      this.logger.warn('No voice data received')
      return
    }

    const opusDecoder = new OpusDecoder(DECODE_SAMPLE_RATE, 1)
    this.decoders.set(key, opusDecoder)

    const dataHandler = (pcmData: Buffer) => this.onPcmPacket(guildId, userId, pcmData, session)
    const errorHandler = (err: Error) => this.logger.withError(err).error('Opus decoding error')
    const closeHandler = () => {
      this.logger.withField('displayName', displayName).log('Opus decoder closed')
      opusDecoder.removeListener('data', dataHandler)
      opusDecoder.removeListener('error', errorHandler)
      opusDecoder.removeListener('close', closeHandler)
    }
    const streamCloseHandler = () => {
      this.logger.withField('displayName', displayName).log('Voice stream closed')
      this.decoders.delete(key)
    }

    opusDecoder.on('data', dataHandler)
    opusDecoder.on('error', errorHandler)
    opusDecoder.on('close', closeHandler)
    receiveStream.on('close', streamCloseHandler)

    pipeline(receiveStream, opusDecoder, (err) => {
      if (err)
        this.logger.withError(err).error('Opus decoding pipeline error')
    })

    this.logger.log(`Monitoring user: ${displayName}`)
  }

  /**
   * Handle one decoded PCM packet for a user. This is the heart of endpointing
   * and barge-in detection.
   */
  private onPcmPacket(guildId: string, userId: string, pcmData: Buffer, session: GuildVoiceSession) {
    const key = captureKey(guildId, userId)
    const capture = this.captures.get(key)
    if (!capture)
      return

    capture.pcmChunks.push(pcmData)
    capture.totalBytes += pcmData.length
    capture.lastPacketAt = Date.now()
    if (capture.state === 'idle') {
      capture.state = 'speaking'
      capture.speechStartedAt = capture.lastPacketAt
    }

    // Barge-in: while the bot is speaking, watch this user's amplitude. A
    // sustained average above threshold means a real human is talking — stop
    // playback immediately and let the controller decide on LLM/TTS abort.
    //
    // Disabled by default (D-V06): a single loud packet used to stop audible
    // audio while generation and synthesis carried on regardless
    // (`baseline-findings.md` §4). Under half-duplex the controller drops
    // busy-state speech at admission instead.
    if (config().voice.bargeInEnabled && session.playback.getSnapshot().playing) {
      const avg = averageAmplitude(pcmData)
      this.emit('bargeInLevel', { guildId, userId, avgVolume: avg })
      if (this.bargeInTriggered.has(key)) {
        if (avg < config().voice.bargeInThreshold * 0.5)
          this.bargeInTriggered.delete(key)
      }
      else if (avg > config().voice.bargeInThreshold) {
        this.bargeInTriggered.add(key)
        this.logger.withFields({ userId, displayName: capture.displayName, avgVolume: avg.toFixed(3) }).log('Barge-in detected')
        this.stopPlayback(guildId)
        this.emit('bargeIn', { guildId, userId, displayName: capture.displayName })
      }
    }

    // Force-finalize overlong utterances so ASR is never asked to handle an
    // unbounded buffer.
    if (capture.totalBytes >= config().voice.maxUtteranceMs * BYTES_PER_MS) {
      this.logger.withFields({ userId, ms: Math.round(capture.totalBytes / BYTES_PER_MS) }).log('Max utterance length reached, finalizing')
      this.finalizeUtterance(guildId, userId)
      return
    }

    // Trailing-silence endpointing: every packet restarts the finalize timer.
    this.scheduleFinalize(guildId, userId)
  }

  private bargeInTriggered: Set<string> = new Set()
  /** Monotonic counter giving every enqueued playback item a unique id. */
  private playbackSequence = 0

  private scheduleFinalize(guildId: string, userId: string) {
    const key = captureKey(guildId, userId)
    const capture = this.captures.get(key)
    if (!capture)
      return

    if (capture.finalizeTimer)
      clearTimeout(capture.finalizeTimer)

    capture.state = 'finalizing'
    capture.finalizeTimer = setTimeout(() => {
      this.finalizeUtterance(guildId, userId)
    }, config().voice.endSilenceMs)
  }

  /**
   * Concatenate the user's captured PCM, drop noise-length utterances, and
   * emit a {@link VoiceUtterance} for downstream ASR. Optionally dump a WAV.
   */
  private finalizeUtterance(guildId: string, userId: string) {
    const key = captureKey(guildId, userId)
    const capture = this.captures.get(key)
    if (!capture)
      return

    capture.finalizeTimer = undefined
    capture.state = 'idle'

    const startedAt = capture.speechStartedAt
    const endedAt = capture.lastPacketAt
    const durationMs = endedAt - startedAt

    const pcm = Buffer.concat(capture.pcmChunks, capture.totalBytes)

    // Reset this user's buffer for the next utterance (independent of all
    // other users — the old code wiped every user here).
    capture.pcmChunks = []
    capture.totalBytes = 0
    capture.speechStartedAt = 0

    if (durationMs < config().voice.minUtteranceMs || pcm.length === 0) {
      this.logger.withFields({ userId, ms: durationMs }).log('Discarding too-short utterance')
      return
    }

    const utterance: VoiceUtterance = {
      guildId,
      channelId: this.sessions.get(guildId)?.channelId ?? '',
      userId,
      displayName: capture.displayName,
      pcm,
      sampleRate: 16000,
      channels: 1,
      startedAt,
      endedAt,
    }

    this.logger.withFields({
      guildId,
      userId,
      displayName: capture.displayName,
      durationMs,
      bytes: pcm.length,
    }).log('Utterance finalized')

    if (config().voice.debugDumpAudio)
      void this.dumpWav(utterance)

    this.emit('utterance', utterance)
  }

  private async dumpWav(utterance: VoiceUtterance) {
    try {
      const dir = join(process.cwd(), 'dumps')
      await mkdir(dir, { recursive: true })
      const wav = convertOpusToWav(utterance.pcm)
      const stamp = new Date(utterance.endedAt).toISOString().replace(/[:.]/g, '-')
      const path = join(dir, `${utterance.guildId}_${utterance.userId}_${stamp}.wav`)
      const ws = createWriteStream(path)
      ws.end(wav)
      this.logger.withField('path', path).log('Dumped utterance WAV')
    }
    catch (error) {
      this.logger.withError(error).error('Failed to dump utterance WAV')
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Playback (guild-oriented)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Queue audio for a guild and resolve when it has finished playing.
   *
   * Ordering, cancellation and completion belong to the guild's
   * {@link GuildPlaybackScheduler}; this method only adapts a raw stream into a
   * {@link PlaybackItem}. Callers that own a response epoch should pass it so
   * cancellation can reach this audio — `/voice-test` and other one-shot
   * callers use the default epoch 0.
   */
  async playAudioStream(guildId: string, audioStream: Readable, item?: Partial<PlaybackItem>): Promise<PlaybackResult> {
    const session = this.sessions.get(guildId)
    if (!session) {
      this.logger.withField('guildId', guildId).log('No voice session, cannot play audio')
      return { status: 'cancelled', durationMs: 0 }
    }

    this.playbackSequence += 1
    return session.playback.enqueue({
      id: `${guildId}:${this.playbackSequence}`,
      guildId,
      turnId: item?.turnId ?? 'adhoc',
      responseEpoch: item?.responseEpoch ?? 0,
      chunkIndex: item?.chunkIndex ?? 0,
      audio: audioStream,
    })
  }

  /** Drop every queued and active playback item belonging to `epoch`. */
  cancelPlaybackEpoch(guildId: string, epoch: number): void {
    this.sessions.get(guildId)?.playback.cancelEpoch(epoch)
  }

  /** Resolve once `epoch` has no queued or active audio left in this guild. */
  async awaitPlaybackDrained(guildId: string, epoch: number): Promise<void> {
    await this.sessions.get(guildId)?.playback.awaitDrained(epoch)
  }

  /** Immediately stop the guild's playback and clear its queue. */
  stopPlayback(guildId: string, reason: PlaybackStopReason = 'cancelled'): void {
    void this.sessions.get(guildId)?.playback.stopAll(reason)
  }

  /** Is the bot currently playing audio into this guild? */
  isPlaying(guildId: string): boolean {
    return this.sessions.get(guildId)?.playback.getSnapshot().playing ?? false
  }

  /** Does this guild have an active voice session (joined a channel)? */
  hasSession(guildId: string): boolean {
    return this.sessions.has(guildId) || this.getVoiceConnection(guildId) != null
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Teardown
  // ─────────────────────────────────────────────────────────────────────────

  private async teardownSession(guildId: string, channelId?: string): Promise<void> {
    const session = this.sessions.get(guildId)
    const cid = channelId ?? session?.channelId

    // Tear down every per-user capture pipeline for this guild.
    for (const key of [...this.captures.keys()]) {
      if (key.startsWith(`${guildId}:`)) {
        const capture = this.captures.get(key)!
        if (capture.finalizeTimer)
          clearTimeout(capture.finalizeTimer)
        this.captures.delete(key)
      }
    }
    for (const key of [...this.decoders.keys()]) {
      if (key.startsWith(`${guildId}:`)) {
        const decoder = this.decoders.get(key)
        try {
          ;(decoder as any)?.destroy?.()
        }
        catch {
          // ignore
        }
        this.decoders.delete(key)
      }
    }

    if (session) {
      // Dispose settles every pending playback promise and detaches the
      // scheduler's observers; the player itself is dropped with the session.
      session.playback.dispose()
      session.audioPlayer.removeAllListeners()
      try {
        session.connection.receiver.speaking.removeAllListeners('start')
        session.connection.receiver.speaking.removeAllListeners('end')
      }
      catch {
        // ignore
      }
      this.sessions.delete(guildId)
    }

    if (session && cid && !this.endedSessions.has(session)) {
      this.endedSessions.add(session)
      this.emit('sessionEnd', { guildId, channelId: cid })
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command handlers
  // ─────────────────────────────────────────────────────────────────────────

  async handleJoinChannelCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    await interaction.deferReply()
    try {
      const currVoiceChannel = (interaction.member as GuildMember).voice.channel
      if (!currVoiceChannel)
        return await interaction.editReply('Please join a voice channel first.')
      await this.joinChannel(currVoiceChannel)
      await interaction.editReply(`Joined: ${currVoiceChannel.name}.`)
    }
    catch (error) {
      this.logger.withError(error).log('Error joining voice channel')
      await interaction.editReply('Failed to join the voice channel.').catch(() => {})
    }
  }

  async handleLeaveChannelCommand(interaction: ChatInputCommandInteraction<CacheType>) {
    const guildId = interaction.guildId
    if (!guildId)
      return await interaction.reply('This command can only be used in a server.')

    if (!this.sessions.has(guildId)) {
      const connection = this.getVoiceConnection(guildId)
      if (!connection)
        return await interaction.reply('Not currently in a voice channel.')
    }

    try {
      await this.leaveChannel(guildId)
      await interaction.reply('Left the voice channel.')
    }
    catch (error) {
      this.logger.withError(error).log('Error leaving voice channel')
      await interaction.reply('Failed to leave the voice channel.')
    }
  }
}

function captureKey(guildId: string, userId: string): string {
  return `${guildId}:${userId}`
}

/** Max |sample| / 32768 across a PCM16 buffer — a cheap per-packet loudness proxy. */
function averageAmplitude(pcm: Buffer): number {
  if (pcm.length < 2)
    return 0
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2))
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] < 0 ? -samples[i] : samples[i]
    sum += v
  }
  return sum / samples.length / 32768
}
