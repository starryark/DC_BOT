import type { Buffer } from 'node:buffer'
import type { Readable } from 'node:stream'

import type { AudioPlayer, VoiceConnection } from '@discordjs/voice'

import type { IngressActorEvidence } from '../memory/discord-actor-snapshot'
import type { GuildPlaybackScheduler } from './playback'

/**
 * A completed per-user utterance emitted by the VoiceManager.
 *
 * The transport knows nothing about STT/LLM/TTS — it only guarantees that the
 * `pcm` buffer is 16 kHz, mono, 16-bit little-endian PCM16 captured between the
 * user's speaking-start and speaking-end (plus the configured trailing silence).
 */
export interface VoiceUtterance {
  guildId: string
  channelId: string
  userId: string
  displayName: string
  actorEvidence: IngressActorEvidence

  pcm: Buffer
  sampleRate: 16000
  channels: 1

  startedAt: number
  endedAt: number
}

/**
 * Per-guild voice state. One voice connection per guild; one capture session
 * per speaking user. Capture is fully independent across users and across
 * guilds — no global transcription timer exists.
 */
export interface GuildVoiceSession {
  guildId: string
  channelId: string
  connection: VoiceConnection
  users: Map<string, UserCaptureSession>
  /**
   * The single persistent player for this session, created and subscribed once
   * on join. All `play()` calls go through {@link playback} — nothing else may
   * touch this player (`architecture-contract.md` §5).
   */
  audioPlayer: AudioPlayer
  /** Sole owner of playback ordering, cancellation and completion for this guild. */
  playback: GuildPlaybackScheduler
}

export type UserCaptureState = 'idle' | 'speaking' | 'finalizing'

/**
 * Per-user capture bookkeeping. Buffers accumulate opus-decoded PCM while the
 * user is speaking. A `finalizeTimer` is (re)started on every silence so the
 * utterance is only emitted once the user has paused for long enough.
 */
export interface UserCaptureSession {
  userId: string
  displayName: string
  actorEvidence: IngressActorEvidence

  pcmChunks: Buffer[]
  totalBytes: number

  speechStartedAt: number
  lastPacketAt: number

  finalizeTimer?: NodeJS.Timeout
  state: UserCaptureState
}

/**
 * Events emitted by the VoiceManager.
 *  - `utterance`: a user finished speaking; payload is ready for ASR.
 *  - `bargeIn`: a human voice was detected while the bot was speaking.
 *  - `bargeInLevel`: raw volume telemetry (optional, for tuning).
 */
export interface VoiceManagerEvents {
  utterance: [VoiceUtterance]
  bargeIn: [{ guildId: string, userId: string, displayName: string }]
  bargeInLevel: [{ guildId: string, userId: string, avgVolume: number }]
  /** A guild voice session started (joined) or ended (left/destroyed). */
  sessionStart: [{ guildId: string, channelId: string }]
  sessionEnd: [{ guildId: string, channelId: string }]
}

/**
 * A provider of audio to play back into a voice channel. The transport accepts
 * any readable byte stream and plays it; it does not know the TTS backend.
 */
export type AudioStreamProvider = (guildId: string) => Readable | Promise<Readable>
