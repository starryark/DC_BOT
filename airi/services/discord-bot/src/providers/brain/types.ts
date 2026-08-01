import type { Content } from '@google/genai'

/**
 * Brain (LLM) provider interface (plan.md §11). Discord classes know only
 * this interface — never "Gemini" by name. The `generate` method streams
 * text chunks; the controller chunks them further for TTS (plan.md §24).
 */

/** Turn metadata the controller carries for telemetry and language routing. */
export interface BrainTurn {
  guildId: string
  userId: string
  userName: string
  /** Detected language from ASR (`zh` | `en` | `ja` | ...). */
  language: string
  text: string
}

/**
 * A fully composed generation request.
 *
 * The provider is stateless and owns no prompt policy: the controller compiles
 * the system instruction and contents (via the character prompt compiler, or
 * the persona-less fallback) and hands over a finished request. This replaces
 * the previous `setContentsProvider` callback seam.
 */
export interface BrainRequest {
  guildId: string
  userId: string
  /** Correlation fields for voice-pipeline telemetry. */
  turnId?: string
  responseEpoch?: number
  /** Complete system instruction for this turn. */
  systemInstruction: string
  /** Conversation contents oldest-first, ending with the current user turn. */
  contents: Content[]
}

export interface BrainProvider {
  /**
   * Stream a response. Yields text deltas (token-ish chunks from the model).
   * The controller may abort the stream via `signal`.
   *
   * Throws `BrainRateLimitError` when the upstream quota is exhausted and
   * `BrainRequestAbortedError` when cancelled, so the controller can react to
   * each without string-matching provider messages.
   */
  generate: (request: BrainRequest, signal: AbortSignal) => AsyncIterable<string>
}
