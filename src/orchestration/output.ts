/**
 * Semantic turn output (Runtime V2, `02-public-contracts.md` §3).
 *
 * The orchestrator no longer returns one finished string. It emits a stream of
 * semantic `TurnOutput` events that consumers (`DiscordTextSink`, `SpeechSink`,
 * `AvatarSink`, telemetry) each subscribe to. Which sinks actually receive an
 * event is decided by a {@link DeliveryPolicy} (`delivery.ts`).
 *
 * Critical rule (`04-decisions.md` D006, `01-architecture.md` invariant #4):
 * ACT tokens are an LLM-output *encoding* parsed immediately into
 * `AvatarAction`. ACT markup MUST NEVER reach TTS, Discord visible replies,
 * memory summaries, or conversation history. Only `text.delta` /
 * `speech.segment` carry clean text.
 */

/**
 * Parsed, internal representation of an avatar action (one possible encoding
 * of an ACT token — see `02-public-contracts.md` §8). This is the shape the
 * avatar sink consumes; it never contains raw ACT markup.
 */
export interface AvatarAction {
  /** 'happy' | 'sad' | 'angry' | 'think' | 'surprised' | 'awkward' | 'question' | 'curious' | 'neutral' */
  emotion?: string
  /** 0..1 */
  intensity?: number
  /** Free-text short motion, e.g. '眉をひそめる'. */
  motionHint?: string
}

/**
 * One semantic event in a turn's output stream.
 *
 * - `text.delta`     — clean text chunk for Discord replies / history.
 * - `speech.segment` — a sentence/clause ready for TTS (segmentId lets the
 *                      speech sink correlate playback with cancellation).
 * - `avatar.action`  — a parsed avatar action for the avatar sink only.
 * - `pause`          — a timed pause (e.g. from `<|DELAY:n|>` when allowed).
 * - `final`          — marks the end of the turn's output stream.
 */
export type TurnOutput
  = | { type: 'text.delta', text: string }
    | { type: 'speech.segment', segmentId: string, text: string }
    | { type: 'avatar.action', action: AvatarAction }
    | { type: 'pause', durationMs: number }
    | { type: 'final' }
