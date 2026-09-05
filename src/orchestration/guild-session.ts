import type { Content } from '@google/genai'

import type { ConversationRoom, ConversationTurn } from './room'

import { config } from '../config'
import { voiceRoom } from './room-id'

/**
 * Bounded, in-memory conversation history per guild (plan.md §21, §22).
 *
 * One logical session per guild — everyone in the voice channel talks to the
 * same bot with shared room context. History is speaker-labeled so the model
 * can tell humans apart. We do NOT persist to a database in v1.
 *
 * Turns are stored in the {@link ConversationTurn} shape so the session can be
 * projected straight into a {@link ConversationRoom} for the prompt compiler
 * (`asRoom`) without a second parallel history representation. Room-*scoped*
 * context (one room per channel, runtime-v2 D003) is deliberately NOT adopted
 * here — see `docs/voice-optimization/decisions.md` D-V01; the projection is a
 * view over guild-scoped state.
 *
 * **Commit semantics.** Nothing is written while a response is being generated.
 * The caller holds the pending user text and calls {@link commitExchange} only
 * after the assistant reply succeeds, so an aborted or rate-limited turn can
 * never leave an unmatched user message behind (Optimize.md §10 Step 7).
 *
 * Bound: keep at most `CONVERSATION_MAX_MESSAGES` recent turns.
 */
export class GuildSession {
  readonly guildId: string
  /** Committed turns, oldest first. */
  private turns: ConversationTurn[] = []
  private readonly maxTurns: number
  private turnCounter = 0

  constructor(guildId: string) {
    this.guildId = guildId
    this.maxTurns = config().brain.maxMessages
  }

  /**
   * Atomically append a completed user→assistant exchange.
   *
   * Both turns land together or neither does; this is the only way normal
   * history is written. A blank assistant reply commits nothing, because an
   * unanswered user turn is exactly the unpaired state we are avoiding.
   */
  commitExchange(user: { speaker: string, text: string, language?: string }, assistantText: string): void {
    const userText = user.text.trim()
    const replyText = assistantText.trim()
    if (userText === '' || replyText === '')
      return

    const now = Date.now()
    this.turns.push({
      turnId: this.nextTurnId(),
      role: 'user',
      speaker: user.speaker,
      text: userText,
      language: user.language,
      timestamp: now,
    })
    this.turns.push({
      turnId: this.nextTurnId(),
      role: 'assistant',
      text: replyText,
      timestamp: now,
    })
    this.trim()
  }

  /**
   * Project committed history as a {@link ConversationRoom} for the prompt
   * compiler. The current (in-flight) input is NOT included — the compiler
   * appends it itself as the final user turn, so including it here would
   * duplicate it.
   */
  asRoom(characterId: string): ConversationRoom {
    const now = Date.now()
    return {
      id: voiceRoom(this.guildId, this.guildId),
      characterId,
      recentTurns: this.turns.map(t => ({ ...t })),
      createdAt: now,
      updatedAt: now,
    }
  }

  /**
   * Committed history as Gemini `contents`, used by the persona-less fallback
   * prompt path. The caller appends the current user turn.
   */
  getContents(): Content[] {
    return this.turns.map((t) => {
      if (t.role === 'assistant')
        return { role: 'model', parts: [{ text: t.text }] }
      const speaker = t.speaker?.trim() ?? ''
      return { role: 'user', parts: [{ text: speaker !== '' ? `${speaker}: ${t.text}` : t.text }] }
    })
  }

  /** Number of committed turns; used by telemetry and tests. */
  get turnCount(): number {
    return this.turns.length
  }

  clear(): void {
    this.turns = []
  }

  private nextTurnId(): string {
    this.turnCounter += 1
    return `${this.guildId}:${this.turnCounter}`
  }

  private trim(): void {
    if (this.turns.length <= this.maxTurns)
      return
    // Drop from the oldest end. The bound is even and turns are pushed in
    // user/assistant pairs, so trimming cannot orphan half an exchange.
    this.turns = this.turns.slice(this.turns.length - this.maxTurns)
  }
}
