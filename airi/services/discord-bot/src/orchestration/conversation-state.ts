import type { SupportedLanguage } from '../character/types'
import type { InputPolicy } from '../config'
import type { VoiceInputEvent } from './events'
import type { InputUnderstanding } from './input-understanding'
import type { RecentTranscript } from './transcript-filter'

import { useLogg } from '@guiiai/logg'

import { GuildSession } from './guild-session'

/**
 * Per-guild conversational state machine (Optimize.md §5.1, §6;
 * `architecture-contract.md` §2).
 *
 * The controller used to have no notion of "busy": every finalized utterance
 * ran ASR and Gemini regardless of what the bot was already doing, which is how
 * six model requests landed in fifteen seconds (`baseline-findings.md` §5).
 * Phase is that missing notion, and it is explicit so illegal transitions are
 * caught rather than silently absorbed.
 */

export type GuildPhase = 'idle' | 'collecting' | 'thinking' | 'speaking' | 'disconnecting'

/**
 * Legal transitions. A phase may always re-enter itself (a no-op), and
 * `disconnecting` is reachable from anywhere. Leaving `disconnecting` requires a
 * brand-new voice session, which is why only `resetForNewSession` clears it.
 */
const LEGAL_TRANSITIONS: Record<GuildPhase, readonly GuildPhase[]> = {
  idle: ['collecting', 'disconnecting'],
  collecting: ['thinking', 'idle', 'disconnecting'],
  thinking: ['speaking', 'idle', 'disconnecting'],
  speaking: ['idle', 'disconnecting'],
  disconnecting: ['idle'],
}

/** Why an active response was cancelled; carried into telemetry. */
export type CancellationReason = 'disconnect' | 'barge_in' | 'superseded' | 'failure' | 'rate_limited'

/**
 * A turn that passed admission and transcript filtering and is ready to
 * generate. Carries the normalized {@link VoiceInputEvent} so the prompt
 * compiler receives the real input rather than a reconstructed stand-in.
 */
export interface AcceptedTurn {
  turnId: string
  inputEvent: VoiceInputEvent
  userId: string
  displayName: string
  text: string
  language: string
  understanding: InputUnderstanding
}

export interface GuildConversationSession {
  guildId: string
  phase: GuildPhase
  inputPolicy: InputPolicy

  /** Incremented for every accepted response; stale async results compare against it. */
  responseEpoch: number
  currentTurnId?: string

  generationAbort?: AbortController

  /** Last accepted transcript per user, for duplicate suppression. Never shared across users. */
  recentTranscripts: Map<string, RecentTranscript>
  /** At most one waiting turn, and only under `latest_wins`. */
  pendingTurn?: AcceptedTurn

  history: GuildSession

  /** Epoch ms until which Gemini must not be called again. */
  geminiCooldownUntil: number
  /** Epoch ms of the last spoken "temporarily unavailable" notice, for debouncing. */
  lastCooldownPromptAt?: number
  /** True when the bot's last reply ended in a question, exempting confirmations from the filler filter. */
  awaitingConfirmation: boolean
  lastStableResponseLanguage?: SupportedLanguage
}

const logger = useLogg('ConversationState').useGlobalConfig()

export function createGuildConversationSession(guildId: string, inputPolicy: InputPolicy): GuildConversationSession {
  return {
    guildId,
    phase: 'idle',
    inputPolicy,
    responseEpoch: 0,
    recentTranscripts: new Map(),
    history: new GuildSession(guildId),
    geminiCooldownUntil: 0,
    awaitingConfirmation: false,
  }
}

/**
 * Move a guild to `next`, refusing transitions the contract does not allow.
 *
 * Returns whether the move happened. An illegal transition is a bug in the
 * caller (usually a stale async continuation), so it is logged loudly and
 * ignored rather than corrupting the phase — a `speaking → thinking` slip would
 * make the bot believe it is free while audio is still playing.
 */
export function transitionGuildPhase(session: GuildConversationSession, next: GuildPhase, reason: string): boolean {
  const from = session.phase
  if (from === next)
    return true

  if (!LEGAL_TRANSITIONS[from].includes(next)) {
    logger.withFields({ guildId: session.guildId, from, to: next, reason }).warn('guild_phase_transition_rejected')
    return false
  }

  session.phase = next
  logger.withFields({ guildId: session.guildId, from, to: next, reason }).log('guild_phase_changed')
  return true
}

/** True while the bot owns a turn and half-duplex should reject new speech. */
export function isBusyPhase(phase: GuildPhase): boolean {
  return phase === 'collecting' || phase === 'thinking' || phase === 'speaking'
}

export type AdmissionRejectionReason = 'bot_collecting' | 'bot_thinking' | 'bot_speaking' | 'disconnecting'

export type UtteranceAdmissionDecision
  = | { accept: true }
    | { accept: false, reason: AdmissionRejectionReason }

/**
 * Narrow a decision to its rejection branch.
 *
 * NOTICE:
 * This service's `tsconfig.json` does not enable `strictNullChecks`, and
 * without it TypeScript will not narrow a discriminated union on a *boolean*
 * literal discriminant — `if (!decision.accept)` leaves `decision.reason`
 * inaccessible. Verified against `services/discord-bot/tsconfig.json`, which
 * sets neither `strict` nor `strictNullChecks` and does not extend the root
 * config. Changing tsconfig to fix a type error is explicitly disallowed
 * (AGENTS.md), so this user-defined type guard does the narrowing instead; the
 * union keeps the exact shape Optimize.md §9 specifies.
 * Removal condition: delete once the service enables `strictNullChecks`.
 */
export function isAdmissionRejected(
  decision: UtteranceAdmissionDecision,
): decision is { accept: false, reason: AdmissionRejectionReason } {
  return !decision.accept
}

/**
 * Decide whether a finalized utterance may proceed — evaluated **before** ASR
 * so a rejected utterance costs no inference (`decisions.md` D-V05).
 *
 * Under `half_duplex` any busy phase rejects. Under `latest_wins` and
 * `barge_in` the utterance is admitted and the caller decides what to do with
 * the turn already in flight.
 *
 * `collecting` admits additional finalized speech into the bounded conversation
 * floor. Thinking and speaking retain the configured interruption policy and
 * never acquire a second simultaneous response.
 */
export function admitUtterance(session: GuildConversationSession): UtteranceAdmissionDecision {
  if (session.phase === 'disconnecting')
    return { accept: false, reason: 'disconnecting' }

  if (session.inputPolicy === 'half_duplex' && (session.phase === 'thinking' || session.phase === 'speaking')) {
    return { accept: false, reason: busyReason(session.phase) }
  }

  return { accept: true }
}

function busyReason(phase: GuildPhase): AdmissionRejectionReason {
  if (phase === 'thinking')
    return 'bot_thinking'
  if (phase === 'speaking')
    return 'bot_speaking'
  return 'bot_collecting'
}

/** Is the guild inside a Gemini cooldown window right now? */
export function isInCooldown(session: GuildConversationSession, now: number): boolean {
  return session.geminiCooldownUntil > now
}

/**
 * Should a "temporarily unable to answer" notice be spoken?
 *
 * Debounced so a user talking through a long cooldown hears it once, not once
 * per utterance (Optimize.md §10 Step 8).
 */
export function shouldAnnounceCooldown(session: GuildConversationSession, now: number, intervalMs: number): boolean {
  const last = session.lastCooldownPromptAt
  return last == null || now - last >= intervalMs
}

/** Reset a guild after a fresh voice session; the only way out of `disconnecting`. */
export function resetForNewSession(session: GuildConversationSession): void {
  session.phase = 'idle'
  session.currentTurnId = undefined
  session.generationAbort = undefined
  session.pendingTurn = undefined
  session.recentTranscripts.clear()
  session.awaitingConfirmation = false
}

/** Registry of per-guild conversational state. */
export class GuildConversationRegistry {
  private sessions = new Map<string, GuildConversationSession>()

  constructor(private readonly inputPolicy: InputPolicy) {}

  get(guildId: string): GuildConversationSession {
    let session = this.sessions.get(guildId)
    if (!session) {
      session = createGuildConversationSession(guildId, this.inputPolicy)
      this.sessions.set(guildId, session)
    }
    return session
  }

  delete(guildId: string): void {
    this.sessions.delete(guildId)
  }
}
