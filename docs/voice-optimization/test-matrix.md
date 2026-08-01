# Test Matrix — voice optimization

Runner: **Vitest** (`vitest.config.ts` globs `src/**/*.test.ts`, tests inline
beside source). Run with `pnpm --filter @proj-airi/discord-bot test`.

**Current state: 22 files, 266 tests, all passing.** `tsc --noEmit` clean.

| Suite | Tests |
|-------|-------|
| `voice/playback.test.ts` | 15 |
| `orchestration/conversation-controller.test.ts` | 30 |
| `orchestration/conversation-state.test.ts` | 14 |
| `orchestration/transcript-filter.test.ts` | 24 |
| `orchestration/speech-chunker.test.ts` | 17 |
| `orchestration/tts-pipeline.test.ts` | 3 |
| `providers/brain/errors.test.ts` | 14 |
| `providers/brain/rate-limiter.test.ts` | 10 |
| `providers/asr/qwen-http.test.ts` | 2 |
| `providers/tts/gpt-sovits.test.ts` | 9 |
| `config.test.ts` | 2 |
| character subsystem (`card-schema`, `character-registry`, `prompt-compiler`, `act-v1-parser`) | 70 |
| pre-existing (`room`, `events`, `language`, `gpt-sovits`, `publisher`) | 45 |

## Mocking approach

`@discordjs/voice` has no mock in this repo, so the scheduler talks to a
`PlaybackPlayer` port and the tests supply a `FakePlayer` mirroring the real
state machine (`play()` → playing, `stop()`/end-of-stream → idle). It counts
*replacements* — a `play()` issued while already playing — which is the exact
`@discordjs/voice` behaviour that caused the cut-off defect. `VoiceManager`
adapts the real `AudioPlayer` onto that port in one function.

The controller tests use hand-rolled fakes (matching the existing repo
convention) rather than `vi.mock`, with a `manualPlayback` mode that holds
playback promises open so the "a turn is not finished until its audio is"
contract can be asserted deterministically. `resetConfigCache()` isolates
config; `vi.useFakeTimers()` drives the limiter's windows.

## Coverage

Legend: **direct** = asserted by a test targeting that behaviour;
**indirect** = guaranteed by a tested lower-level component, not re-asserted at
the higher level; **by construction** = the code path does not exist.

### Playback serialization (Wave 1A)

| # | Case | Status |
|---|------|--------|
| P1 | Three chunks enqueued concurrently play in submission order | direct |
| P2 | `play()` never called twice without an intervening `Idle` | direct |
| P3 | `enqueue` resolves after playback completes, not at play start | direct |
| P4 | Player error fails the current item and the queue continues | direct |
| P5 | `cancelEpoch` removes pending items of that epoch | direct |
| P6 | A stale-epoch item never reaches `play()` | direct |
| P7 | `stopAll`/disconnect empties the queue and settles promises | direct |
| P8 | Observer count does not grow across repeated playback | direct |
| P9 | Bounded queue drops beyond capacity instead of growing | direct |
| P10 | `awaitDrained` resolves only after the last item finishes | direct |
| P11 | A resource that cannot be built fails just that item | direct |
| P12 | A late idle after cancellation cannot settle a new item | direct |

### Input gate, endpointing, transcript filter (Wave 1B)

| # | Case | Status |
|---|------|--------|
| I1 | Speech while `speaking` is rejected before ASR | direct |
| I2 | Speech while `thinking` is rejected | direct (state suite) |
| I3 | Speech while `idle` is accepted | direct |
| I4 | Rejected input calls neither ASR nor the model | direct |
| I5 | `disconnecting` rejects under every policy | direct |
| T1 | Normalization trims, collapses whitespace, fixes punctuation spacing | direct |
| T2 | Semantic casing preserved | direct |
| T3 | Full-width CJK punctuation is **not** folded onto ASCII | direct (regression) |
| T4 | Standalone `嗯。` rejected as filler | direct |
| T5 | Confirmations accepted when `awaitingConfirmation` | direct |
| T6 | Punctuation-only and width-variant fillers rejected | direct |
| T7 | Filler words inside a sentence are not filler | direct |
| T8 | Same-user duplicate inside the window rejected | direct |
| T9 | Different users saying the same text are not deduplicated | direct |
| T10 | Duplicate outside the window accepted | direct |
| T11 | Empty / punctuation-only rejected as `empty` | direct |
| T12 | Stray single Latin char rejected as `too_short`; single Han kept | direct |

Endpointing defaults (`VOICE_END_SILENCE_MS=900`, `VOICE_MIN_UTTERANCE_MS=300`)
are configuration, verified by loading `config()` rather than by a unit test.
`VOICE_PRE_ROLL_MS`/`VOICE_POST_ROLL_MS` from Optimize.md §9 are **not
implemented** — see Gaps.

### Gemini limiter and cooldown (Wave 1C)

| # | Case | Status |
|---|------|--------|
| G1 | RPM limit delays excess requests deterministically | direct |
| G2 | Max-concurrency of 1 serializes acquisitions | direct |
| G3 | A 429 produces `BrainRateLimitError` | direct |
| G4 | `retryDelay: "50s"` / `"37s"` parsed to ms | direct |
| G5 | `quotaMetric` / `quotaId` / `model` extracted | direct |
| G6 | `blockUntil` suppresses subsequent acquisitions | direct |
| G7 | Abort surfaces `BrainRequestAbortedError` | direct |
| G8 | No internal retry after cancellation | by construction (provider has no retry path) |
| G9 | Non-429 errors pass through unchanged | direct |
| G10 | An aborted waiter cannot strand the next release | direct (regression) |

### Controller state machine (Wave 2A)

| # | Case | Status |
|---|------|--------|
| C1 | A turn stays active until its last audio chunk finishes | direct |
| C2 | Utterance during `thinking` is dropped | direct (state suite) |
| C3 | Utterance during `speaking` is dropped | direct |
| C4 | Dropped utterances never reach ASR or the model | direct |
| C5 | A cancelled generation cannot enqueue more audio | direct |
| C6 | A stale-epoch TTS result cannot reach playback | indirect (P6) |
| C7 | An old playback completion cannot release a new turn | indirect (P12 + epoch guard in `finally`) |
| C8 | A 429 emits at most one local notice per interval | direct |
| C9 | Cooldown suppresses further model calls | direct |
| C10 | History stays paired after a cancelled generation | direct |
| C11 | History stays paired after a rate-limited generation | direct |
| C12 | Disconnect cancels the epoch and stops audio | direct |
| C13 | Two guilds process independently | direct |
| C14 | Illegal phase transitions are rejected | direct |
| C15 | Playback items carry turnId/epoch/chunkIndex | direct |
| C16 | `latest_wins` supersedes the in-flight response | direct (regression) |
| C17 | `half_duplex` still drops busy-state speech | direct |

### Character runtime and output protocol

Ported suites retained unchanged (`card-schema` 24, `character-registry` 15,
`prompt-compiler` 13, `act-v1-parser` 18). Added here:

| # | Case | Status |
|---|------|--------|
| K1 | Live `Makise Kurisu/card.json` loads into a full runtime | direct |
| K2 | Unknown character id reports the resolved path | direct (regression) |
| K3 | Empty `CHARACTER_PATH` reports the missing config | direct |
| K4 | ACT tokens are handed to a handler, not silently dropped | direct |
| K5 | A token split across stream deltas is reassembled first | direct |
| K6 | Token text never reaches the TTS chunk stream | direct |

### Versioned TTS cache (Wave 3B)

| # | Case | Status |
|---|------|--------|
| T1 | Memory hit avoids a provider request | direct |
| T2 | Disk hit survives a fresh cache instance | direct |
| T3 | Voice configuration change invalidates the key | direct |
| T4 | Reference-audio identity change invalidates the key | direct |
| T5 | A partial disk pair is never read | direct |
| T6 | Concurrent identical misses share one synthesis and valid disk pair | direct |
| T7 | Disk eviction respects byte and item limits | direct |
| T8 | Corrupt/cache I/O failures fall back to synthesis | direct |
| T9 | Metadata is key-versioned and temporary files are not exposed | direct |
| T10 | `.cache/tts` is excluded by the repository cache ignore rule | inspection |

### Multi-speaker conversation floor (Wave 3C)

| # | Case | Status |
|---|------|--------|
| F1 | Two speakers inside one window produce one conversation input | direct |
| F2 | Adjacent fragments from one speaker merge | direct |
| F3 | Original PCM events remain separate and retain buffer identity | direct |
| F4 | A third speaker produces the local one-at-a-time action | direct |
| F5 | The active-speaker lease rejects background fragments | direct |
| F6 | Group windows are independent per guild | direct |
| F7 | A cancelled response epoch suppresses a pending flush | direct |
| F8 | Display names are quoted as data in the group prompt | direct |
| F9 | Controller sends two nearby speakers in one Gemini request | integration |
| F10 | Controller uses local TTS and no Gemini request for three speakers | integration |
| F11 | Cancellation during collection prevents a later group flush | integration |

### Structured telemetry (Wave 3D)

| # | Case | Status |
|---|------|--------|
| M1 | Event catalog contains every required lifecycle event | direct |
| M2 | Records accept only primitive structured fields | type + direct |
| M3 | Sensitive field names are removed before reaching a sink | direct |
| M4 | Discard/filter/cache rates are derived from records | direct |
| M5 | Gemini 429 and stale-cancellation counts are derived | direct |
| M6 | ASR, first-token, first-audio, queue, and playback latency averages are derived | direct |
| M7 | TTS real-time factor is derived from synthesis/audio duration | direct |

Wave 3D also adds correlation-ready `turnId` / `responseEpoch` fields to Gemini
events, ASR latency to `utterance_received`, queue wait to `playback_started`,
cache tier/duration fields, and `tts_synthesis_completed` timing.

## Gaps and deferrals

Recorded rather than silently omitted:

- `VOICE_PRE_ROLL_MS` / `VOICE_POST_ROLL_MS` are **not implemented**. Capture
  already retains audio from speaking-start and finalizes on trailing silence;
  adding roll padding means restructuring the per-user PCM ring buffer, which is
  larger than the Wave 1B remit.
- **Wave 3A is implemented.** Language-aware minimum/target/maximum chunk sizes
  prevent tiny opening acknowledgements from becoming standalone TTS calls;
  final short responses still flush. The orchestration pipeline permits one
  synthesized-but-unplayed successor while the current chunk plays and does
  not advance to a second lookahead item. `TTS_CHUNK_MAX_WAIT_MS` is validated
  and reserved, but there is deliberately no wall-clock forced flush yet: the
  spec marks it "with care," and forcing partial text without a safe boundary
  would reintroduce the tiny-chunk defect.
- **Wave 3B is implemented.** Complete validated WAV responses use a memory LRU
  followed by a versioned, sharded disk cache. Writes are fsynced and renamed;
  misses are coalesced in-process, and cache failures do not block synthesis.
  Cache identity includes text/languages, the operator-managed voice version,
  reference/prompt fingerprints, media/stream/split settings, speed, and
  synthesis parameters. An empty voice version safely disables caching.
- **Wave 3C's owned floor boundary is implemented.** The small `add` / `flush`
  / `clear` API and per-guild registry are connected through a timer-owning
  coordinator. `collecting` now admits nearby group members while `thinking`
  and `speaking` retain half-duplex protection. Two speakers create one Gemini
  request; overflow uses a cacheable local prompt without spending Gemini
  quota. Cancellation clears timers and admission-epoch checks reject ASR that
  completes after cancellation.
- **`latest_wins` supersedes rather than queues.** A completed utterance during
  a live response cancels that response and takes the floor immediately
  (asserted by C16). Optimize.md §10 Step 6 describes this as "one waiting turn,
  replaced by the newest"; superseding reaches the same end state — the newest
  completed turn is the one that runs — without a slot that can only ever hold
  the value that is about to run anyway. The `pendingTurn` field exists for a
  future policy that genuinely defers.
- **Wave 4 deterministic QA is implemented.** Coverage includes ASR timeout and
  connection failure, Gemini abort/429, GPT-SoVITS refusal/timeout/premature
  stream failure, player error, disconnect teardown, stale TTS completion, and
  the old-player Idle race. Every provider failure is followed by a successful
  turn or an explicit reusable-state assertion. A real Discord gateway remains
  a manual acceptance boundary.
- The benchmark runner at `scripts/benchmark-voice.ts` records the TTS mode,
  Latin/CJK target, prefetch and warm/cold matrix plus optional approved ASR
  WAV samples and hardware metadata. Audio quality remains a human score.
- No integration test drives a real `@discordjs/voice` connection; the port
  boundary is the seam.
