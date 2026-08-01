import type { Readable } from 'node:stream'

import type { Content } from '@google/genai'

import type { PromptCompiler } from '../character/prompt-compiler'
import type { CharacterRuntime } from '../character/types'
import type { AsrProvider } from '../providers/asr/types'
import type { BrainProvider } from '../providers/brain/types'
import type { GptSoVitsLang, TtsProvider } from '../providers/tts/types'
import type { VoiceUtterance } from '../voice/types'
import type { VoiceManager } from '../voice/voice-manager'
import type { AcceptedTurn, CancellationReason, GuildConversationSession } from './conversation-state'
import type { VoiceInputEvent } from './events'
import type { ConversationInput } from './group-turn-builder'

import { randomUUID } from 'node:crypto'

import { useLogg } from '@guiiai/logg'

import { parseActV1 } from '../character/output-protocol/act-v1-parser'
import { config } from '../config'
import { BrainRateLimitError, BrainRequestAbortedError } from '../providers/brain/errors'
import { FALLBACK_SYSTEM_PROMPT } from '../providers/brain/prompt'
import { normalizeLanguage, resolveTtsLanguage } from '../providers/tts/language'
import { prepareSpeechText } from '../providers/tts/pronunciation'
import { convertOpusToWav } from '../utils/audio'
import { ConversationFloorCoordinator } from './conversation-floor-coordinator'
import {
  admitUtterance,
  GuildConversationRegistry,
  isAdmissionRejected,
  isBusyPhase,
  isInCooldown,
  shouldAnnounceCooldown,
  transitionGuildPhase,
} from './conversation-state'
import { isStableLanguageEvidence, resolveInputUnderstanding } from './input-understanding'
import { chunkStream } from './speech-chunker'
import { filterTranscript } from './transcript-filter'
import { runBoundedTtsPipeline } from './tts-pipeline'

/**
 * Spoken when the model is rate-limited. Japanese to match the Kurisu reference
 * voice, and short so it synthesizes quickly even on a cold TTS process.
 */
const COOLDOWN_NOTICE = '悪いけど、今は答えられないわ。少し待って。'
const ONE_AT_A_TIME_NOTICE = '一人ずつ話してちょうだい。'

/**
 * Owner of all conversational policy (Optimize.md §10).
 *
 *   utterance → admission → ASR → transcript filter → Gemini
 *     → chunker → TTS → playback scheduler
 *
 * Three invariants distinguish this from the previous implementation:
 *
 * 1. **Admission precedes inference.** A busy guild drops speech before
 *    `convertOpusToWav`, so ignored input costs no ASR and no model call.
 *
 * 2. **A turn is not finished until its audio is.** `generateAndSpeak` awaits
 *    the playback scheduler draining its epoch, so the guild leaves `speaking`
 *    only once the last chunk has actually been heard. The old code resolved
 *    when the last `play()` was *issued*, which let the next turn overwrite an
 *    audible response (`baseline-findings.md` §2, §3).
 *
 * 3. **Every async result is epoch-checked.** A generation, synthesis, or
 *    playback belonging to a superseded response can neither speak nor mutate
 *    history.
 */
export class ConversationController {
  private logger = useLogg('ConversationController').useGlobalConfig()
  private voice: VoiceManager
  private asr: AsrProvider
  private brain: BrainProvider
  private tts: TtsProvider
  private states: GuildConversationRegistry
  private character?: CharacterRuntime
  private promptCompiler?: PromptCompiler
  private conversationFloor: ConversationFloorCoordinator

  constructor(deps: {
    voice: VoiceManager
    asr: AsrProvider
    brain: BrainProvider
    tts: TtsProvider
    /** Present when a character card is configured; absent falls back to the generic prompt. */
    character?: CharacterRuntime
    promptCompiler?: PromptCompiler
  }) {
    this.voice = deps.voice
    this.asr = deps.asr
    this.brain = deps.brain
    this.tts = deps.tts
    this.character = deps.character
    this.promptCompiler = deps.promptCompiler
    this.states = new GuildConversationRegistry(config().inputPolicy)
    const floorConfig = config().conversationFloor
    this.conversationFloor = new ConversationFloorCoordinator({
      floorOptions: guildId => ({
        ...floorConfig,
        isEpochCurrent: epoch => this.states.get(guildId).responseEpoch === epoch,
        emit: (event, fields) => this.logger.withFields(fields).log(event),
      }),
      onFlush: input => this.onConversationGroup(input),
    })

    this.voice.on('utterance', u => this.onUtterance(u))
    this.voice.on('bargeIn', ({ guildId }) => this.onBargeIn(guildId))
    this.voice.on('sessionEnd', ({ guildId }) => {
      void this.onSessionEnd(guildId)
    })
  }

  /** Cancel whatever the guild is doing. Used by `/leave` and shutdown. */
  async cancelActiveResponse(guildId: string, reason: CancellationReason): Promise<void> {
    await this.cancel(this.states.get(guildId), reason)
  }

  private onUtterance(utterance: VoiceUtterance): void {
    void this.handleUtterance(utterance)
  }

  private async handleUtterance(utterance: VoiceUtterance): Promise<void> {
    const session = this.states.get(utterance.guildId)

    // Admission first: everything below this line costs inference.
    const decision = admitUtterance(session)
    if (isAdmissionRejected(decision)) {
      this.logger.withFields({
        guildId: utterance.guildId,
        userId: utterance.userId,
        phase: session.phase,
        reason: decision.reason,
        durationMs: utterance.endedAt - utterance.startedAt,
      }).log('utterance_discarded')
      return
    }

    // Under an interrupting policy the utterance was admitted while a response
    // was still running; that response must be torn down before this one can
    // take the floor, otherwise the phase guard would reject the transition and
    // the newly admitted speech would be silently lost.
    if (session.inputPolicy !== 'half_duplex' && session.phase !== 'collecting' && isBusyPhase(session.phase))
      await this.cancel(session, 'superseded')

    if (session.phase === 'idle' && !transitionGuildPhase(session, 'collecting', 'utterance_admitted'))
      return
    const admissionEpoch = session.responseEpoch

    const turnId = randomUUID()
    // The normalized event is built here, where the PCM genuinely exists, and
    // travels with the turn: the prompt compiler takes an InputEvent, and Wave 3
    // adds text adapters behind the same union.
    const inputEvent: VoiceInputEvent = {
      type: 'voice',
      eventId: `${turnId}:in`,
      turnId,
      guildId: utterance.guildId,
      channelId: utterance.channelId,
      voiceChannelId: utterance.channelId,
      userId: utterance.userId,
      displayName: utterance.displayName,
      timestamp: utterance.endedAt,
      pcm: utterance.pcm,
      sampleRate: 16000,
    }

    let asrText = ''
    let asrLanguage = 'und'
    try {
      const wav = convertOpusToWav(utterance.pcm)
      const result = await this.asr.transcribe({ wav, sampleRate: 16000 })
      asrText = result.text
      asrLanguage = result.language
    }
    catch (err) {
      this.logger.withError(err).error('ASR failed')
      if (!this.conversationFloor.hasPending(session.guildId))
        transitionGuildPhase(session, 'idle', 'asr_failed')
      return
    }

    // Cancellation while ASR was running invalidates this transcript before it
    // can mutate duplicate history or reopen a cleared conversation floor.
    if (session.responseEpoch !== admissionEpoch)
      return

    const verdict = filterTranscript(asrText, {
      language: asrLanguage,
      awaitingConfirmation: session.awaitingConfirmation,
      recentTranscript: session.recentTranscripts.get(utterance.userId),
      duplicateWindowMs: config().voice.duplicateWindowMs,
      now: Date.now(),
    })

    if (!verdict.accept) {
      this.logger.withFields({
        guildId: utterance.guildId,
        userId: utterance.userId,
        reason: verdict.reason,
        chars: verdict.normalizedText.length,
        language: asrLanguage,
      }).log('transcript_filtered')
      if (!this.conversationFloor.hasPending(session.guildId))
        transitionGuildPhase(session, 'idle', `transcript_${verdict.reason}`)
      return
    }

    session.recentTranscripts.set(utterance.userId, { normalizedText: verdict.normalizedText, at: Date.now() })

    const previousStableLanguage = session.lastStableResponseLanguage
    const understanding = resolveInputUnderstanding({
      text: verdict.normalizedText,
      asrLanguage,
      previousStableLanguage,
      characterInteractionProfile: this.character?.interaction ?? { defaultResponseLanguage: 'en', entities: [], pronunciationProfileVersion: 'default-v1' },
    })
    const stableLanguageUpdated = isStableLanguageEvidence(understanding.reason)
    if (stableLanguageUpdated)
      session.lastStableResponseLanguage = understanding.responseLanguage
    this.logger.withFields({ guildId: utterance.guildId, userId: utterance.userId, turnId, asrLanguageRaw: asrLanguage, asrLanguageNormalized: understanding.asrLanguageNormalized ?? 'und', responseLanguage: understanding.responseLanguage, resolutionReason: understanding.reason, confidence: understanding.confidence, isAmbiguous: understanding.isAmbiguous, entityIds: understanding.entities.map(entity => entity.entityId), entityCount: understanding.entities.length, previousStableLanguage, stableLanguageUpdated }).log('input_understanding_resolved')

    this.logger.withFields({
      guildId: utterance.guildId,
      userId: utterance.userId,
      displayName: utterance.displayName,
      language: asrLanguage,
      turnId,
      chars: verdict.normalizedText.length,
      asrLatencyMs: Math.max(0, Date.now() - utterance.endedAt),
    }).log('utterance_received')

    // Never spend a request we already know will 429.
    const now = Date.now()
    if (isInCooldown(session, now)) {
      await this.handleCooldownUtterance(session, now)
      return
    }

    const floorDecision = this.conversationFloor.add({
      inputEvent,
      text: verdict.normalizedText,
      language: asrLanguage,
      startedAt: utterance.startedAt,
      endedAt: utterance.endedAt,
      responseEpoch: admissionEpoch,
      understanding,
    })
    if (floorDecision.kind === 'ignored' && !this.conversationFloor.hasPending(session.guildId))
      transitionGuildPhase(session, 'idle', `conversation_floor_${floorDecision.reason}`)
  }

  private async onConversationGroup(input: ConversationInput): Promise<void> {
    const session = this.states.get(input.guildId)
    if (session.phase !== 'collecting' || session.responseEpoch !== input.responseEpoch)
      return
    if (input.kind === 'request_one_at_a_time') {
      await this.announceOneAtATime(session)
      return
    }
    const latest = input.messages.at(-1)!
    const firstEvent = input.utterances[0].inputEvent
    await this.generateAndSpeak(session, {
      turnId: firstEvent.turnId,
      inputEvent: firstEvent,
      userId: latest.userId,
      displayName: 'Discord group',
      text: input.promptText,
      language: latest.language,
      understanding: latest.understanding,
    })
  }

  /** Speak the cacheable local arbitration prompt without spending Gemini quota. */
  private async announceOneAtATime(session: GuildConversationSession): Promise<void> {
    if (!transitionGuildPhase(session, 'thinking', 'conversation_group_rejected'))
      return
    const epoch = ++session.responseEpoch
    const abort = new AbortController()
    session.generationAbort = abort
    session.currentTurnId = 'one-at-a-time'
    try {
      const stream = await this.tts.synthesize({ text: ONE_AT_A_TIME_NOTICE, language: 'ja' }, abort.signal)
      if (session.responseEpoch !== epoch || abort.signal.aborted)
        return
      transitionGuildPhase(session, 'speaking', 'one_at_a_time_audio_queued')
      await this.voice.playAudioStream(session.guildId, stream, { turnId: 'one-at-a-time', responseEpoch: epoch, chunkIndex: 0 })
      await this.voice.awaitPlaybackDrained(session.guildId, epoch)
    }
    catch (err) {
      if (!abort.signal.aborted)
        this.logger.withError(err).withFields({ guildId: session.guildId }).log('one_at_a_time_prompt_failed')
    }
    finally {
      if (session.responseEpoch === epoch) {
        session.generationAbort = undefined
        session.currentTurnId = undefined
        transitionGuildPhase(session, 'idle', 'one_at_a_time_finished')
      }
    }
  }

  private async generateAndSpeak(
    session: GuildConversationSession,
    turn: AcceptedTurn,
  ): Promise<void> {
    if (!transitionGuildPhase(session, 'thinking', 'generation_started'))
      return

    const epoch = ++session.responseEpoch
    session.currentTurnId = turn.turnId
    const abort = new AbortController()
    session.generationAbort = abort

    const turnLang = normalizeLanguage(turn.understanding.responseLanguage)
    let fullReply = ''
    let chunkIndex = 0

    try {
      const request = { ...this.compileRequest(session, turn), turnId: turn.turnId, responseEpoch: epoch }
      this.logger.withFields({ guildId: session.guildId, turnId: turn.turnId, responseEpoch: epoch }).log('response_epoch_started')

      const stream = chunkStream(
        this.brain.generate(request, abort.signal),
        token => this.onControlToken(session, epoch, turn.turnId, token),
        config().ttsChunking,
      )

      const pipeline = await runBoundedTtsPipeline(stream, {
        synthesize: (text, index) => this.synthesizeChunk(session, epoch, turn.turnId, text, index, turnLang, turn.understanding.responseLanguage, abort.signal),
        play: chunk => this.playChunk(session, epoch, turn.turnId, chunk.audio, chunk.chunkIndex, abort.signal),
        isCancelled: () => this.isStale(session, epoch, abort),
        onChunk: (text) => {
          fullReply += text
        },
      })
      chunkIndex = pipeline.chunksSeen

      if (this.isStale(session, epoch, abort))
        return

      // The turn is not over until the audio is.
      await this.voice.awaitPlaybackDrained(session.guildId, epoch)

      if (this.isStale(session, epoch, abort))
        return

      // Commit only on success, and only both halves together.
      session.history.commitExchange(
        { speaker: turn.displayName, text: turn.text, language: turn.language },
        fullReply,
      )
      session.awaitingConfirmation = endsWithQuestion(fullReply)

      this.logger.withFields({
        guildId: session.guildId,
        turnId: turn.turnId,
        responseEpoch: epoch,
        chars: fullReply.length,
        chunks: chunkIndex,
      }).log('response_completed')
    }
    catch (err) {
      await this.handleGenerationError(session, epoch, err)
    }
    finally {
      // Only the owning epoch may release the guild; a superseded turn's
      // teardown must not move the phase out from under its replacement.
      if (session.responseEpoch === epoch) {
        session.generationAbort = undefined
        session.currentTurnId = undefined
        transitionGuildPhase(session, 'idle', 'turn_finished')
        await this.startPendingTurn(session)
      }
    }
  }

  /**
   * Compile the model request.
   *
   * With a character configured the prompt compiler owns composition end to
   * end; without one the bot still answers using the generic prompt plus
   * committed history, so a missing card degrades behaviour instead of
   * breaking it.
   */
  private compileRequest(
    session: GuildConversationSession,
    turn: AcceptedTurn,
  ): { guildId: string, userId: string, systemInstruction: string, contents: Content[] } {
    if (this.character && this.promptCompiler) {
      const { prompt } = this.promptCompiler.compile({
        character: this.character,
        room: session.history.asRoom(this.character.id),
        currentInput: turn.inputEvent,
        currentInputText: turn.text,
        currentTurnUnderstanding: turn.understanding,
      })
      return {
        guildId: session.guildId,
        userId: turn.userId,
        systemInstruction: prompt.systemInstruction,
        contents: prompt.contents,
      }
    }

    const contents = session.history.getContents()
    contents.push({ role: 'user', parts: [{ text: `${turn.displayName}: ${turn.text}` }] })
    return {
      guildId: session.guildId,
      userId: turn.userId,
      systemInstruction: `${FALLBACK_SYSTEM_PROMPT}\n\n# Current-turn runtime routing\nSelected reply language: ${turn.understanding.responseLanguage}. Reply in this selected language.`,
      contents,
    }
  }

  /**
   * Synthesize one chunk and queue it for playback.
   *
   * TTS failures are logged and skipped rather than aborting the turn: losing
   * one clause is better than truncating an otherwise-good answer.
   */
  private async synthesizeChunk(
    session: GuildConversationSession,
    epoch: number,
    turnId: string,
    text: string,
    chunkIndex: number,
    turnLang: GptSoVitsLang,
    responseLanguage: 'ja' | 'zh' | 'en',
    parentSignal: AbortSignal,
  ): Promise<Readable | null> {
    if (!text.trim() || parentSignal.aborted)
      return null

    const resolved = resolveTtsLanguage({
      text,
      inputLanguageHint: turnLang === 'auto' ? undefined : turnLang,
      textLangFallback: config().tts.textLangFallback,
    })
    const prepared = prepareSpeechText({ text, language: resolved.language === 'auto' ? responseLanguage : resolved.language, entities: this.character?.interaction.entities ?? [] })

    try {
      const synthesisStartedAt = Date.now()
      this.logger.withFields({
        guildId: session.guildId,
        turnId,
        responseEpoch: epoch,
        chunkIndex,
        targetLanguage: resolved.language,
        resolution: resolved.source,
        responseLanguageHint: responseLanguage,
        pronunciationSubstitutions: prepared.substitutions.length,
        pronunciationProfileVersion: this.character?.interaction.pronunciationProfileVersion ?? 'default-v1',
        chars: text.length,
      }).log('tts_synthesis_started')

      const stream = await this.tts.synthesize({ text: prepared.speechText, language: resolved.language, pronunciationProfileVersion: this.character?.interaction.pronunciationProfileVersion ?? 'default-v1' }, parentSignal)

      // A synthesis that finished after its response was superseded must never
      // reach the speaker.
      if (session.responseEpoch !== epoch || parentSignal.aborted)
        return null
      this.logger.withFields({
        guildId: session.guildId,
        turnId,
        responseEpoch: epoch,
        chunkIndex,
        chars: text.length,
        language: resolved.language,
        synthesisMs: Date.now() - synthesisStartedAt,
      }).log('tts_synthesis_completed')
      return stream
    }
    catch (err) {
      if (!parentSignal.aborted)
        this.logger.withError(err).withFields({ guildId: session.guildId, turnId, chunkIndex }).error('tts_synthesis_failed')
      return null
    }
  }

  private async playChunk(
    session: GuildConversationSession,
    epoch: number,
    turnId: string,
    stream: Readable,
    chunkIndex: number,
    parentSignal: AbortSignal,
  ): Promise<void> {
    if (session.responseEpoch !== epoch || parentSignal.aborted)
      return

    // Enter `speaking` on the first queued chunk so admission stays correct
    // while one successor is synthesized in the bounded lookahead slot.
    transitionGuildPhase(session, 'speaking', 'first_audio_queued')
    await this.voice.playAudioStream(session.guildId, stream, {
      turnId,
      responseEpoch: epoch,
      chunkIndex,
    })
  }

  /** Quota failure: arm the cooldown, optionally say so once, commit nothing. */
  private async handleGenerationError(session: GuildConversationSession, epoch: number, err: unknown): Promise<void> {
    if (err instanceof BrainRequestAbortedError) {
      this.logger.withFields({ guildId: session.guildId, responseEpoch: epoch }).log('response_cancelled')
      return
    }

    if (err instanceof BrainRateLimitError) {
      const now = Date.now()
      session.geminiCooldownUntil = now + err.retryAfterMs
      this.logger.withFields({
        guildId: session.guildId,
        responseEpoch: epoch,
        cooldownMs: err.retryAfterMs,
        quotaMetric: err.quotaMetric,
      }).warn('gemini_rate_limited')
      await this.announceCooldown(session, now)
      return
    }

    if (session.responseEpoch === epoch)
      this.logger.withError(err).withFields({ guildId: session.guildId, responseEpoch: epoch }).error('generation_failed')
  }

  /** An utterance that arrived while the cooldown is still running. */
  private async handleCooldownUtterance(session: GuildConversationSession, now: number): Promise<void> {
    this.logger.withFields({
      guildId: session.guildId,
      phase: session.phase,
      cooldownMs: session.geminiCooldownUntil - now,
    }).log('gemini_cooldown_active')
    await this.announceCooldown(session, now)
    transitionGuildPhase(session, 'idle', 'cooldown_active')
  }

  /**
   * Speak the unavailable notice at most once per
   * `GEMINI_COOLDOWN_PROMPT_INTERVAL_MS`, so a user talking through a long
   * cooldown is not answered by a stuck record.
   */
  private async announceCooldown(session: GuildConversationSession, now: number): Promise<void> {
    if (!shouldAnnounceCooldown(session, now, config().brain.cooldownPromptIntervalMs))
      return
    session.lastCooldownPromptAt = now

    const epoch = ++session.responseEpoch
    try {
      const stream = await this.tts.synthesize({ text: COOLDOWN_NOTICE, language: 'ja' }, new AbortController().signal)
      await this.voice.playAudioStream(session.guildId, stream, { turnId: 'cooldown', responseEpoch: epoch, chunkIndex: 0 })
    }
    catch (err) {
      // The notice is a courtesy; failing to speak it must not cascade.
      this.logger.withError(err).withFields({ guildId: session.guildId }).log('cooldown_prompt_failed')
    }
  }

  /** Start the turn parked by `latest_wins`, if any. */
  private async startPendingTurn(session: GuildConversationSession): Promise<void> {
    const pending = session.pendingTurn
    if (!pending)
      return
    session.pendingTurn = undefined
    this.conversationFloor.clear(session.guildId)
    if (!transitionGuildPhase(session, 'collecting', 'pending_turn_started'))
      return
    await this.generateAndSpeak(session, pending)
  }

  /**
   * Handle one `<|ACT:...|>` / `<|DELAY:n|>` span lifted out of the model
   * stream before chunking.
   *
   * ACT-v1 is an output *encoding*, so the markup is parsed here into semantic
   * avatar actions and never reaches TTS, Discord or history (runtime-v2 D006).
   * The relay protocol currently carries only coarse behaviours
   * (idle/listening/thinking/speaking) with no emotion channel, so the parsed
   * action is recorded rather than published; wiring it to the avatar is Wave 7's
   * job and needs no further change here.
   */
  private onControlToken(session: GuildConversationSession, epoch: number, turnId: string, token: string): void {
    if (session.responseEpoch !== epoch)
      return

    const parsed = parseActV1(token, { allowDelay: this.character?.outputProtocol?.allowDelay ?? true })
    for (const action of parsed.actions) {
      this.logger.withFields({
        guildId: session.guildId,
        turnId,
        responseEpoch: epoch,
        emotion: action.emotion,
        intensity: action.intensity,
        motionHint: action.motionHint,
      }).log('avatar_action')
    }
    for (const pause of parsed.pauses) {
      this.logger.withFields({ guildId: session.guildId, turnId, responseEpoch: epoch, durationMs: pause.durationMs }).log('avatar_pause')
    }
  }

  /** True when this response was superseded or aborted; nothing it produced may be used. */
  private isStale(session: GuildConversationSession, epoch: number, abort: AbortController): boolean {
    return session.responseEpoch !== epoch || abort.signal.aborted
  }

  /**
   * Invalidate the active response end to end.
   *
   * Bumping the epoch first is what makes every in-flight continuation stale;
   * the abort and the playback cancellation then release work already running.
   */
  private async cancel(session: GuildConversationSession, reason: CancellationReason): Promise<void> {
    const epoch = session.responseEpoch
    session.responseEpoch++
    session.generationAbort?.abort()
    session.generationAbort = undefined
    session.currentTurnId = undefined
    session.pendingTurn = undefined

    this.voice.cancelPlaybackEpoch(session.guildId, epoch)
    this.voice.stopPlayback(session.guildId, reason === 'disconnect' ? 'disconnect' : 'cancelled')

    this.logger.withFields({ guildId: session.guildId, responseEpoch: epoch, reason }).log('response_cancelled')

    // `disconnecting` is terminal until a new voice session exists.
    if (reason !== 'disconnect')
      transitionGuildPhase(session, 'idle', `cancelled_${reason}`)
  }

  /** Barge-in only fires when `BARGE_IN_ENABLED` is set (D-V06). */
  private onBargeIn(guildId: string): void {
    const session = this.states.get(guildId)
    if (session.inputPolicy === 'half_duplex')
      return
    void this.cancel(session, 'barge_in')
  }

  private async onSessionEnd(guildId: string): Promise<void> {
    const session = this.states.get(guildId)
    transitionGuildPhase(session, 'disconnecting', 'session_ended')
    await this.cancel(session, 'disconnect')
    this.states.delete(guildId)
  }
}

/** Does the reply end in a question, so a bare "yes"/"嗯" is a real answer? */
function endsWithQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text.trim())
}
