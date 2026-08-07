# 1C Telemetry / Tracing — unified per-turn observability that traces one turnId through every pipeline stage

## Summary

Implemented the unified observability layer for Runtime V2 (`02-public-contracts.md`
§12, `01-architecture.md` §12). One `TurnTracer` per turn traces a `turnId` through
**every** stage of the voice pipeline and emits a single structured record at
`finish()`. It fills the four latency gaps flagged in `03-performance-baseline.md`
§7.1 — `prompt_compile_ms`, `speech_segment_ready_ms`, `tts_first_byte_ms`, and
`total_turn_ms` — and carries the §7.2 metadata set via `setMeta()`.

The work is a **strict superset** of `orchestration/telemetry.ts`'s `TurnTimer`:
same `Date.now()` cumulative-since-user-stop clock, same idempotent
first-occurrence semantics for TTFT / first-PCM / playback-start, same one-line
`'turn telemetry'` log shape (context `Telemetry`). `telemetry.ts` and
`conversation-controller.ts` are **untouched**; the Integration Lead swaps the
controller's call sites onto `TurnTracer` at the Wave-1 gate. A `TracingSink`
seam (`LoggTracingSink` default) lets a future OpenTelemetry sink be added
without rewriting call sites — no OTel dependency is pulled in now.

Purely additive: 3 new source files + 1 test file, all under
`src/observability/**`. No existing file was modified.

## Files changed

All NEW, all under `airi/services/discord-bot/src/observability/**`:

- `src/observability/types.ts` — `TurnStage` enum, `TurnTrace` (full per-turn
  record), `TurnLatencyMetrics` (baseline §7.1), `TurnMetadata` (§7.2),
  `TurnAttentionDecision`.
- `src/observability/stage-timing.ts` — `TracingSink` interface (the OTel seam)
  + `LoggTracingSink` default that writes the structured logg line.
- `src/observability/turn-tracer.ts` — `TurnTracer` class: `mark*()` for every
  stage, `setMeta()`, `setOutcome()`, idempotent `finish()`, `toTrace()`.
- `src/observability/turn-tracer.test.ts` — 15 Vitest unit tests.

No existing files modified. `orchestration/telemetry.ts` and
`orchestration/conversation-controller.ts` are deliberately untouched (Integration
Lead wires them onto this tracer during the gate).

## Public interfaces added/changed

```ts
// src/observability/types.ts
export enum TurnStage { /* discord_receive … avatar_events */ }

export interface TurnLatencyMetrics {
  endpoint_ms?, asr_ms?, prompt_compile_ms?, brain_ttft_ms?, brain_complete_ms?,
  speech_segment_ready_ms?, tts_first_byte_ms?, tts_first_pcm_ms?,
  playback_start_ms?, total_turn_ms?, user_stop_to_audio_ms?
}
export interface TurnMetadata {
  asr_backend?, asr_prompt_size?, asr_language?, model?,
  tts_streaming_mode?, tts_media_format?, tts_text_length?,
  speech_segment_length?, character_prompt_token_estimate?
}
export interface TurnAttentionDecision { type: 'respond'|'observe'|'ignore'; reason: string; confidence?: number }
export interface TurnTrace {
  turnId: string; guildId?, roomId?, userId?, displayName?: string
  startedAt: number; userStoppedAt: number
  metrics: TurnLatencyMetrics; metadata: TurnMetadata
  attentionDecision?: TurnAttentionDecision
  avatarEventCount?, memory_ms?: number
  outcome?: 'complete'|'aborted'|'error'; finishedAt?: number
}

// src/observability/stage-timing.ts
export interface TracingSink { emit(trace: TurnTrace): void }
export class LoggTracingSink implements TracingSink { /* wraps a logg line */ }

// src/observability/turn-tracer.ts
export class TurnTracer {
  constructor(opts: { turnId, userStoppedAt, guildId?, roomId?, userId?, displayName?, sink? })
  markDiscordReceive(), markEndpointFinalized(),
  markAsrBegin(), markAsrEnd({ inferenceMs, language, backend? }),
  markAttentionDecision(decision), markPromptCompile(compileMs?),
  markLlmRequest(), markLlmFirstToken() [idempotent], markLlmComplete(),
  markSpeechSegmentReady() [idempotent], markTtsRequest(),
  markTtsFirstByte(firstByteMs) [idempotent, inter-stage],
  markTtsFirstPcm() [idempotent], markPlaybackQueued(),
  markPlaybackStart() [idempotent], markPlaybackEnd(),
  markMemoryWork(workMs?), markAvatarEvents(count?)
  setMeta(meta: Partial<TurnMetadata>), setOutcome(outcome), finish() [idempotent], toTrace()
}
```

Nothing removed; nothing in the frozen contracts (`02-public-contracts.md`)
changed — this implements §12 as specified.

## Behavior implemented

- **Every stage in `02-public-contracts.md` §12 has a mark method.** Stages:
  discordReceive, endpointFinalized (`endpoint_ms`), asrBegin/asrEnd (`asr_ms` +
  language + backend), attentionDecision (respond|observe|ignore + reason),
  promptCompile (`prompt_compile_ms`), llmRequest, llmFirstToken (`brain_ttft_ms`),
  llmComplete (`brain_complete_ms`), speechSegmentReady
  (`speech_segment_ready_ms`), ttsRequest, ttsFirstByte (`tts_first_byte_ms`),
  ttsFirstPcm (`tts_first_pcm_ms`), playbackQueued, playbackStart
  (`playback_start_ms`), playbackEnd (`total_turn_ms`), memoryWork (`memory_ms`),
  avatarEvents (`avatarEventCount`).
- **Time model matches `telemetry.ts` exactly.** Wall-clock stages are
  cumulative-since-user-stop via `Date.now()` (same clock as `TurnTimer`).
  `asr_ms` and `tts_first_byte_ms` are the documented **inter-stage** exceptions:
  caller-supplied provider-internal durations, not wall-clock deltas.
- **Idempotent first-occurrence marks** preserved from `telemetry.ts`:
  `markLlmFirstToken` (= markGeminiFirstToken), `markTtsFirstPcm` (=
  markTtsFirstAudio), `markPlaybackStart` (= markPlaybackStarted), plus
  `markTtsFirstByte` and `markSpeechSegmentReady`. Repeated calls never
  overwrite. Tests assert each of these.
- **`user_stop_to_audio_ms` (the key UX metric)** is set from the first of
  tts-first-PCM / playback-start, exactly as `totalUserStopToAudioMs` is in
  `telemetry.ts`. In whole-file mode (`streaming_mode=0`) the controller calls
  markTtsFirstAudio + markPlaybackStarted together; `TurnTracer` populates the
  UX metric from whichever fires first. Test covers the playback-only path.
- **`finish()` emits exactly one record** through the sink (idempotent; later
  calls no-op). Default sink writes the `@guiiai/logg` line with message
  `'turn telemetry'`, context `'Telemetry'`, fields = full flattened trace — the
  same shape `TurnTimer.finish()` uses, so existing log parsers keep working.
- **`setMeta()` merges** §7.2 metadata; later calls win, undefined values
  ignored. Test covers all 9 §7.2 fields + override + undefined-skip.
- **OTel seam:** `TracingSink` interface with `LoggTracingSink` default. A future
  `OtelTracingSink implements TracingSink` can be injected via the constructor
  `sink` option with zero call-site changes. No OTel dependency today.

## Configuration added

None. No env vars, no config.ts changes (config.ts is Integration-Lead-owned).
The tracer is constructed in code with a `turnId` + `userStoppedAt`; the sink
defaults internally to `useLogg('Telemetry').useGlobalConfig()`.

## Tests added

`src/observability/turn-tracer.test.ts` — **15 tests**, 4 describe blocks:

1. **Idempotent first-occurrence marks (5 tests)** — brain_ttft_ms,
   tts_first_pcm_ms + user_stop_to_audio_ms, playback_start_ms, tts_first_byte_ms,
   speech_segment_ready_ms each recorded once and never overwritten.
2. **All stage fields populate (2 tests)** — a full complete turn populates every
   metric + attention decision + avatar count + memory + outcome + finishedAt;
   `markAsrEnd` flows language/backend into metadata.
3. **setMeta merges metadata (2 tests)** — all 9 §7.2 fields + later-call-wins +
   undefined-skip.
4. **Baseline §7.1 gap metrics present + finish behavior (6 tests)** —
   `prompt_compile_ms`, `speech_segment_ready_ms`, `tts_first_byte_ms`,
   `total_turn_ms` all present; user_stop_to_audio_ms from playback start in
   whole-file mode; `finish()` idempotent (one emit); explicit aborted outcome;
   cumulative avatar counts; explicit prompt_compile_ms override.

Tests use a capturing `TracingSink` (no real logging) so assertions are exact.

## Tests executed

From `airi/services/discord-bot/`:

- `npx vitest run src/observability/` → **1 file, 15 tests, all pass.**
- `npx vitest run` (full suite) → **9 files, 87 tests pass** on a clean run. My
  observability tests are deterministic every time.
- `npx tsc --noEmit` scoped to `src/observability/**` → **0 errors** in my files
  (verified by filtering `tsc` output for `observability`).

### IMPORTANT — pre-existing breakage OUTSIDE this agent's ownership

Two failures exist in the tree that are **not from 1C** and that I was instructed
NOT to fix (they live in `src/orchestration/**`, owned by 1B Conversation Domain,
and I must not modify existing files):

1. **`pnpm typecheck` currently fails** on `src/orchestration/events.test.ts`
   (lines 68, 81, 82) with TS2352 — `as Record<string, unknown>` casts on union
   types that lack an index signature. This is 1B's file; the fix is to cast via
   `unknown` first (`as unknown as Record<string, unknown>`) or restructure the
   assertions. **Not introduced by 1C** — confirmed by filtering `tsc` output:
   zero `observability` errors.
2. **`src/orchestration/room.test.ts` "bumps updatedAt on every mutation"` is
   flaky** — it mocks `createdAt=1000` but `updatedAt` uses real `Date.now()`,
   so `expect(updatedAt).toBeGreaterThanOrEqual(createdAt)` can fail when real
   clock >= 1000 (always, in 2026). It passed on one of my runs and failed on
   another. Also 1B's file.

Both are 1B's to fix. The four **original** baseline test files
(`conversation-controller`, `gpt-sovits`, `language`, `publisher`, 29 tests)
remain fully green — 1C did not touch them.

## Benchmark results

None collected (read-only wave for telemetry; no benchmark harness run). The
schema this layer emits is what the §6 benchmark fixtures and §39 ≥20-warm-turn
run will consume once the Integration Lead wires the controller onto `TurnTracer`.

## Assumptions

1. **Clock:** `Date.now()` for wall-clock durations (matches `telemetry.ts`).
   `performance.now()` not used to stay byte-for-byte comparable with existing
   `TurnTimer` records in the baseline logs.
2. **`speech_segment_ready_ms`** (baseline §7.1 gap) is included even though the
   1C task's mark-method list did not name it explicitly — it IS a §7.1 gap and
   sits naturally between `llmComplete` and `ttsRequest` (chunker emitting a
   segment). `markSpeechSegmentReady()` is idempotent. If the Integration Lead
   prefers not to emit it yet, the call site is simply omitted; the field stays
   undefined.
3. **Inter-stage fields** (`asr_ms`, `tts_first_byte_ms`) take caller-supplied
   numbers, per baseline §7.1's explicit note that these are provider-internal
   durations, not cumulative-since-user-stop.
4. **Sink seam is minimal on purpose** — `TracingSink { emit(trace) }` only. No
   span/start-end API yet (deferred until OTel is actually adopted; recorded as a
   follow-up).
5. **Turn id and userStoppedAt are constructor inputs** (assigned by the caller,
   today the controller builds `${guildId}-${endedAt}-${userIdSlice}`). The
   tracer does not generate them.

## Known limitations

- **Not wired into the live pipeline yet.** Until the Integration Lead swaps
  `ConversationController`'s `TurnTimer` call sites onto `TurnTracer`, the new
  gap metrics (`prompt_compile_ms`, `speech_segment_ready_ms`, `tts_first_byte_ms`,
  `total_turn_ms`) are not emitted at runtime — only the schema + tests exist.
  This is by design (1C owns the observability module; the controller is
  Integration-Lead-owned per `01-architecture.md` §6).
- **No OTel export yet** — only the `LoggTracingSink`. The seam is in place;
  implementing `OtelTracingSink` is a follow-up (no external dep added now, per
  task constraint).
- **No percentile aggregation / no histogram** — this layer emits one record per
  turn. Aggregation into P50/P95 (§39) is the benchmark harness's job.

## Integration instructions

For the Integration Lead at the Wave-1 gate:

1. **Construct a `TurnTracer` where the `TurnTimer` is today**
   (`conversation-controller.ts:64`). The constructor takes
   `{ turnId, userStoppedAt, guildId, userId, displayName }`; `turnId` can be
   built the same way (`${guildId}-${utterance.endedAt}-${userId.slice(-4)}`) or
   taken from the new domain `turnId` once 1B's turn module owns it. Pass
   `roomId` once rooms are wired (D003).
2. **Swap the mark call sites 1:1** (all semantically preserved):
   - `timer.markEndpoint()` → `tracer.markEndpointFinalized()`
   - `timer.markAsrDone(ms, lang)` → `tracer.markAsrEnd({ inferenceMs: ms, language: lang, backend: 'qwen3-asr-http' })`
   - `timer.markGeminiFirstToken()` → `tracer.markLlmFirstToken()`
   - `timer.markGeminiComplete()` → `tracer.markLlmComplete()`
   - `timer.markTtsFirstAudio()` → `tracer.markTtsFirstPcm()`
   - `timer.markPlaybackStarted()` → `tracer.markPlaybackStart()`
   - `timer.finish()` → `tracer.finish()`
3. **Add the NEW stage calls** to fill the baseline gaps:
   - `tracer.markPromptCompile()` after prompt/system+history assembly (in the
     brain provider or wherever `contents` are resolved). Optional explicit timer
     arg if you have one: `markPromptCompile(ms)`.
   - `tracer.markSpeechSegmentReady()` when the speech chunker emits the first
     segment boundary.
   - `tracer.markTtsFirstByte(ms)` when the GPT-SoVITS HTTP response yields its
     first byte (instrument in `gpt-sovits.ts` — measure from request issue).
   - `tracer.markTtsRequest()` / `tracer.markPlaybackQueued()` /
     `tracer.markPlaybackEnd()` at the obvious points.
   - `tracer.markAttentionDecision({ type, reason })` once 2D's attention policy
     is wired (before generation).
   - `tracer.markMemoryWork()` / `tracer.markAvatarEvents(n)` on the
     post-response paths (Wave 4 / Wave 7).
4. **Set metadata via `setMeta()`** with `model`, `tts_streaming_mode`,
   `tts_media_format`, `tts_text_length`, `speech_segment_length`,
   `character_prompt_token_estimate`, `asr_prompt_size` as those become
   available. `asr_backend`/`asr_language` are set automatically by
   `markAsrEnd`.
5. **`setOutcome('aborted')`** on barge-in finalize (so aborted turns are
   distinguishable from complete ones in the record).
6. After wiring, `telemetry.ts` (`TurnTimer`) can be deleted — `TurnTracer` is
   its superset. (Do this in the same gate once the controller no longer
   references `TurnTimer`.)
7. **Fix 1B's `events.test.ts`** typecheck errors (TS2352 on the
   `as Record<string, unknown>` casts) — cast through `unknown` first. This is
   blocking `pnpm typecheck` from passing clean and is outside 1C's ownership.

## Follow-up items

- Implement `OtelTracingSink` (real OTel spans/metrics) once an OTel exporter is
  chosen — the `TracingSink` seam needs no change. (Defer until adoption is
  decided; record as a decision in `04-decisions.md` when done.)
- Wire `markTtsFirstByte` instrumentation inside `providers/tts/gpt-sovits.ts`
  (Wave 2A) — needs the HTTP response first-byte timestamp.
- Wire `markSpeechSegmentReady` inside `orchestration/speech-chunker.ts`
  (Integration Lead or Wave 1).
- Benchmark harness (§6 fixtures, §39 ≥20 warm turns) consumes the emitted
  `TurnTrace` records to produce P50/P95 per stage.
- Consider `performance.now()` for sub-millisecond inter-stage durations if TTS
  first-byte measurement needs higher resolution than `Date.now()` — would be a
  localized change inside the TTS provider, not in this module.
