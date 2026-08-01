# Architecture Contract — voice optimization

Frozen contract for Optimize.md Waves 1–2. Every implementation change is
measured against this file. Scope is the existing `direct` pipeline; this is an
optimization, not a redesign.

## 1. Pipeline

```
Discord voice → VoiceManager capture → admission gate → Qwen3-ASR
  → transcript filter → ConversationController (turn) → Gemini
  → speech chunker → GPT-SoVITS → PlaybackScheduler → Discord voice
```

## 2. Guild state machine

```
idle          accept speech
collecting    accept and merge speech for the current turn
thinking      ignore newly finalized speech
speaking      ignore newly finalized speech
disconnecting reject all work, cancel active operations
```

Legal transitions:

```
idle → collecting → thinking → speaking → idle
collecting → idle          (nothing admitted)
thinking → idle            (failure / cancel)
speaking → idle            (playback drained)
<any active> → disconnecting
disconnecting → idle       only when a new voice session is created
```

Transitions go through one function; unexpected transitions are logged and
rejected. Phase is per guild and never global.

## 3. Input policy

Default is `half_duplex`. While `thinking` or `speaking`, a newly finalized
utterance must **not** invoke ASR, Gemini or TTS, must **not** stop playback,
and must **not** enter a backlog. It is dropped and logged:

```
input_discarded reason=bot_busy phase=speaking
```

`latest_wins` (at most one waiting turn, replaced by the newest) and `barge_in`
are optional and disabled by default. `BARGE_IN_ENABLED=false` is the shipped
default; the existing amplitude-triggered barge-in is gated behind it.

## 4. Response epoch — the cancellation contract

Every accepted response gets an immutable epoch: `const epoch = ++session.responseEpoch`.

`epoch` is threaded through Gemini generation, chunking, TTS, playback enqueue,
history commit and telemetry. Before any async result is used:

```ts
if (epoch !== session.responseEpoch) return
```

Cancellation increments the epoch and must invalidate **all** of: the Gemini
stream, pending text chunks, the active TTS request, completed-but-unplayed TTS
results, the playback queue, and the active Discord resource. A stale result may
never mutate history, enqueue audio, or change phase.

## 5. Playback ownership

- Exactly **one persistent `AudioPlayer` per guild voice session**.
- Exactly **one scheduler** owns every `AudioPlayer.play()` call. No other
  module may call `play()`.
- `play()` is never invoked while another resource is active, except after an
  explicit cancellation has stopped it.
- Chunks play in submission order.
- The enqueue promise resolves only after the resource reaches `Idle` or fails —
  never at play start.
- Each completed resource is released; listeners are registered once at session
  level, not per resource.
- On disconnect: pending promises reject, the current resource stops, listeners
  and queue are cleared.
- A replacement attempt logs `playback_invariant_violation`.

Scheduler API:

```ts
interface PlaybackScheduler {
  enqueue(item: PlaybackItem): Promise<PlaybackResult>
  cancelEpoch(epoch: number): void
  stopAll(reason: PlaybackStopReason): Promise<void>
  awaitDrained(epoch: number): Promise<void>
  getSnapshot(): PlaybackSnapshot
}
```

## 6. Turn completion semantics

A turn task resolves only when **all** of the following hold:

```
all generated text consumed
AND all accepted TTS requests settled
AND all accepted playback items completed
```

This is what prevents the next queued turn from starting while the previous
response is still audible.

## 7. Queue limits

| Policy | Max waiting turns |
|--------|-------------------|
| `half_duplex` (default) | **0** |
| `latest_wins` | 1, replaced by the newest completed turn |

No unbounded FIFO of future spoken turns. The playback queue itself is bounded;
overflow is a logged drop, not unbounded growth.

## 8. Transcript admission

Before Gemini, a transcript must pass, in order:

1. **normalize** — trim, Unicode normalize, collapse whitespace, normalize
   punctuation spacing, preserve semantic casing. Pure function, no rewriting.
2. **empty / too-short** rejection.
3. **filler** rejection — standalone `uh, um, hmm, mhm` / `嗯, 呃, 啊` /
   `えー, えっと, うん`, including punctuation-only variants. Exempt when
   `awaitingConfirmation` is true (`yes`, `no`, `嗯`, `うん` are then meaningful).
4. **duplicate** rejection — identical normalized text from the **same** user
   inside `VOICE_DUPLICATE_WINDOW_MS`. Never compared across users.

Each rejection reports a machine-readable reason (`empty | too_short | filler |
duplicate`) and never reaches the model.

## 9. Brain provider contract

- A local limiter is consulted **before** generation (RPM + max concurrent),
  scoped by API key/model within the process.
- `429` becomes `BrainRateLimitError { retryAfterMs, quotaMetric, quotaId, model }`,
  parsed from the SDK error's structured fields where available.
- A rate limit immediately blocks further acquisitions until the retry time.
- Abort becomes `BrainRequestAbortedError`, never a generic failure.
- The provider performs **no** internal retry and never retries an obsolete turn.
- The streaming interface (`AsyncIterable<string>`) is preserved.

On `BrainRateLimitError` the controller sets `geminiCooldownUntil`, may play one
cached "temporarily unable to answer" prompt (debounced by
`GEMINI_COOLDOWN_PROMPT_INTERVAL_MS`), and makes no further Gemini request until
cooldown expires.

## 10. History commit

Transactional. Build a provisional user turn, generate, and commit the user
input **and** assistant text together only on success. An aborted or
rate-limited turn commits neither, so normal history never contains an unmatched
user message.

## 11. Audio format assumptions

Capture is PCM16 / 16 kHz / mono (`DECODE_SAMPLE_RATE`, 32 000 bytes per
second). TTS returns a byte stream consumed as `StreamType.Arbitrary`. Complete
WAV files are never concatenated; when streaming, only the first chunk may carry
a WAV header. `prompt_lang` identifies the reference-clip language and is never
switched per turn; `text_lang` is resolved per chunk and describes the
synthesized content.

## 12. Character/persona boundary

The persona reaches the model through the character runtime
(`src/character/**`): `CharacterRegistry` loads a CCv3 card,
`PromptCompiler` renders the system instruction. Delivery rules (output
language follows the most recent speaker; TTS-safe plain text) are emitted by
the compiler and outrank card directives where they conflict.

ACT-v1 markup (`<|ACT:...|>`, `<|DELAY:n|>`) is an **output encoding**. It is
parsed at the output boundary into avatar actions plus clean text; only clean
text may reach TTS, Discord replies, or history (runtime-v2 D006). A defensive
stripper remains at the TTS boundary so an unparsed token can never be spoken.

## 13. Environment settings

```env
BOT_INPUT_POLICY=half_duplex
BARGE_IN_ENABLED=false

VOICE_END_SILENCE_MS=900
VOICE_MIN_UTTERANCE_MS=300
VOICE_MAX_UTTERANCE_MS=30000
VOICE_PRE_ROLL_MS=200
VOICE_POST_ROLL_MS=150
VOICE_DUPLICATE_WINDOW_MS=3000

GEMINI_REQUESTS_PER_MINUTE=4
GEMINI_MAX_CONCURRENT_REQUESTS=1
GEMINI_DEFAULT_COOLDOWN_MS=60000
GEMINI_COOLDOWN_PROMPT_INTERVAL_MS=60000

CHARACTER_PATH=
CHARACTER_ID=kurisu
```

All numeric values are validated: negatives rejected, zero rejected where
invalid, safe upper bounds enforced, effective configuration logged without
secrets.

## 14. Non-goals

No new bot; no RTP/Opus rewrite; no pre-ASR audio mixing; no diarization; no
alternative STT; no per-turn model reloads; no full duplex by default; no
simultaneous responses in one guild; no unbounded turn queue; no LLM response
cache as a substitute for input filtering; no edits to unrelated AIRI services;
no destructive Git operations; no committed secrets, audio caches, or recorded
speech.
