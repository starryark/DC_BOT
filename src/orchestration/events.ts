/**
 * Normalized input events (Runtime V2, `02-public-contracts.md` §1).
 *
 * Every input medium — voice, Discord @mention, slash command, Activity
 * interaction — is normalized into one `InputEvent` union before it reaches
 * the orchestrator. Downstream conversation code depends only on this union,
 * never on Discord message/voice classes (`01-architecture.md` invariant #1,
 * `04-decisions.md` D002).
 *
 * ASR is a provider operation performed **after** a voice event is received;
 * the orchestrator owns no `text` field on voice events until ASR fills it.
 */
import type { Buffer } from 'node:buffer'

import type { IngressActorEvidence } from '../memory/discord-actor-snapshot'

/**
 * Fields common to every input event. `eventId` identifies the input itself;
 * `turnId` is assigned by the orchestrator to group everything that happens
 * during one conversation turn (input, generation, outputs).
 */
export interface BaseInputEvent {
  /** Unique id for this input event (e.g. `${turnId}:in`). */
  eventId: string
  /** The turn this input belongs to. Assigned by the orchestrator. */
  turnId: string

  guildId?: string
  channelId?: string
  userId: string
  displayName: string
  /** Immutable transport evidence captured before internal person resolution. */
  actorEvidence: IngressActorEvidence

  timestamp: number
}

/**
 * A finalized user utterance from a voice channel.
 *
 * Mirrors `VoiceUtterance` (`src/voice/types.ts`): the voice adapter converts
 * a `VoiceUtterance` into a `VoiceInputEvent`. `pcm` is exactly the 16 kHz
 * mono PCM16 the VoiceManager emits today; ASR runs after this event is
 * received.
 */
export interface VoiceInputEvent extends BaseInputEvent {
  type: 'voice'
  voiceChannelId: string
  /** 16 kHz mono PCM16, exactly as emitted by the VoiceManager today. */
  pcm: Buffer
  sampleRate: 16000
}

/** A Discord message that explicitly mentions the application. */
export interface DiscordMentionInputEvent extends BaseInputEvent {
  type: 'discord-mention'
  messageId: string
  /** Mention text already stripped of the bot's application mention. */
  text: string
}

/** A registered slash command invocation. */
export interface SlashCommandInputEvent extends BaseInputEvent {
  type: 'slash-command'
  commandName: string
  // subcommand/args may be added later; do not over-design now.
}

/** A user interaction inside a Discord Activity (e.g. Live2D touch). */
export interface ActivityInteractionInputEvent extends BaseInputEvent {
  type: 'activity'
  activitySessionId: string
  action: string
  payload?: unknown
}

/**
 * The union all downstream code narrows on. The `type` discriminates the
 * medium; everything else is provider/adapter-agnostic.
 */
export type InputEvent
  = | VoiceInputEvent
    | DiscordMentionInputEvent
    | SlashCommandInputEvent
    | ActivityInteractionInputEvent
