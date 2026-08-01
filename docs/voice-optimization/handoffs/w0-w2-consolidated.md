# Waves 0–2 — consolidated handoff

Scope: Optimize.md Waves 0, 1A, 1B, 1C and 2A, plus adoption of the Runtime V2
character subsystem. Executed by a single agent in one working tree (see
`README.md` in this folder for why the per-agent branch scheme was collapsed).

## Patch identifier

No commits were created (AGENTS.md: "Do not create commits during
implementation for this spec"). All changes are uncommitted in the working tree.

| Repo | Commit at start | Branch |
|------|-----------------|--------|
| `DC_BOT` | `45678d1` | `main` |
| `DC_BOT/airi` | `2ae95253d` | `main` |

The character subsystem was ported from the nested branch
`discord-bot-wip-backup` (`33d5f00fc`) by file copy — that branch was not merged,
checked out, or otherwise disturbed.

## Files read

`Optimize.md`; `docs/runtime-v2/**` (via `git show new_archetecture:…`);
`bot_log .txt`, `bot_log_2 .txt`, `Inference_Log*.txt`; the whole of
`airi/services/discord-bot/src/**`; `README.md`, `RUNBOOK.md`, `AGENTS.md`.

## Files changed

**Added — Optimize.md work**

- `src/voice/playback.ts` + `.test.ts` — serialized per-guild playback scheduler.
- `src/orchestration/conversation-state.ts` + `.test.ts` — phase machine,
  admission, cooldown helpers.
- `src/orchestration/transcript-filter.ts` + `.test.ts` — normalization, filler
  and duplicate rejection.
- `src/providers/brain/errors.ts` + `.test.ts` — typed brain failures + 429 parsing.
- `src/providers/brain/rate-limiter.ts` + `.test.ts` — local RPM/concurrency limiter.
- `docs/voice-optimization/**` — repository map, baseline findings, architecture
  contract, decisions, test matrix, this handoff.

**Added — ported from `33d5f00fc` (character runtime + its type closure)**

`src/character/{types,card-schema,character-registry,prompt-compiler}.ts`,
`src/character/output-protocol/act-v1-parser.ts` (+ 4 test suites);
`src/orchestration/{room-id,events,output,room}.ts` (+ `room`/`events` tests).

**Rewritten**

- `src/orchestration/conversation-controller.ts` — phases, epochs, cancellation,
  half-duplex admission, playback-gated completion, transactional history, quota
  cooldown, ACT-token handling.
- `src/orchestration/guild-session.ts` — history stored as `ConversationTurn[]`,
  atomic `commitExchange`, `asRoom()` projection for the prompt compiler.
- `src/providers/brain/gemini.ts` — stateless; limiter + typed errors.
- `src/providers/brain/prompt.ts` — now only the persona-less fallback.
- `src/providers/brain/types.ts` — `BrainRequest` replaces the
  `setContentsProvider` callback seam.
- `src/voice/voice-manager.ts` — one persistent `AudioPlayer` per session,
  scheduler ownership, barge-in gating.
- `src/voice/types.ts`, `src/config.ts`, `src/index.ts`, `src/services.ts`,
  `src/orchestration/speech-chunker.ts`.

**Deleted**

- `src/providers/brain/character-card.ts` + test — superseded by
  `src/character/**` (operator decision; `decisions.md` D-V02).
- `src/orchestration/turn-queue.ts`, `src/orchestration/telemetry.ts` — became
  unreferenced once phase-based serialization and structured events replaced
  them. Verified unreferenced by grep before removal.

**Docs**: `README.md` (conversation behavior, character persona, configuration),
`RUNBOOK.md` (key behaviors, log event reference, troubleshooting rows),
`.env.example`, `.config`.

## Public interfaces added/changed

```ts
// voice/playback.ts
interface PlaybackPlayer { play(resource: unknown): void; stop(): void
                           observe(h: PlaybackPlayerHandlers): () => void }
interface PlaybackItem { id, guildId, turnId, responseEpoch, chunkIndex, audio }
type PlaybackStatus = 'played' | 'cancelled' | 'failed' | 'dropped'
class GuildPlaybackScheduler {
  enqueue(item): Promise<PlaybackResult>   // resolves at Idle, never at play start
  cancelEpoch(epoch): void
  stopAll(reason: PlaybackStopReason): Promise<void>
  awaitDrained(epoch): Promise<void>
  getSnapshot(): PlaybackSnapshot
  dispose(): void
}

// voice/voice-manager.ts
playAudioStream(guildId, stream, item?: Partial<PlaybackItem>): Promise<PlaybackResult>
cancelPlaybackEpoch(guildId, epoch): void
awaitPlaybackDrained(guildId, epoch): Promise<void>
stopPlayback(guildId, reason?: PlaybackStopReason): void

// orchestration/conversation-state.ts
type GuildPhase = 'idle' | 'collecting' | 'thinking' | 'speaking' | 'disconnecting'
transitionGuildPhase(session, next, reason): boolean
admitUtterance(session): UtteranceAdmissionDecision
isAdmissionRejected(d): d is { accept: false, reason }   // see NOTICE in source

// orchestration/transcript-filter.ts
normalizeTranscript(text, language?): string
filterTranscript(raw, ctx): { accept, normalizedText, reason? }

// providers/brain
class BrainRateLimitError extends Error { retryAfterMs, quotaMetric?, quotaId?, model? }
class BrainRequestAbortedError extends Error {}
classifyBrainError(err, ctx): unknown
interface BrainRateLimiter { acquire(signal); release(); blockUntil(ts); snapshot() }
interface BrainRequest { guildId, userId, systemInstruction, contents }
```

**Breaking**: `BrainProvider.generate` now takes a `BrainRequest`, and
`setContentsProvider` is gone — the controller composes prompts.
`Services.sessions` was removed. `config().brain.characterCardPath` was replaced
by `config().character.{root,id}`.

## Behavior now guaranteed

1. `AudioPlayer.play()` is called from exactly one place, never while a resource
   is active. A three-chunk response plays all three, in order, uncut.
2. A turn stays active until its last chunk reaches `Idle`; the next turn cannot
   start over audible audio.
3. Under `half_duplex` (default) speech during `collecting`/`thinking`/`speaking`
   is dropped before `convertOpusToWav` — no ASR, no model call, no backlog.
4. Every response carries an epoch; generation, synthesis, playback and history
   commits all re-check it after each await.
5. Disconnect cancels generation, synthesis, the playback queue and the active
   resource, and settles every pending promise.
6. Empty, too-short, filler and same-user duplicate transcripts never reach the
   model; each drop is logged with a machine-readable reason.
7. A 429 becomes `BrainRateLimitError`, arms a process-wide cooldown for the
   API-reported delay, and yields at most one spoken notice per interval.
8. History is written only as a complete user→assistant pair, so a failed or
   cancelled turn leaves no orphan message.
9. ACT/DELAY markup is parsed out of the stream before chunking; only clean text
   reaches TTS or history.

## Tests added

227 total (was 52 at session start), 16 files. New/rewritten:
`playback` 15, `conversation-controller` 23, `conversation-state` 14,
`transcript-filter` 24, `errors` 14, `rate-limiter` 10, `speech-chunker` 12
(3 new). Ported: character subsystem 70, `room`/`events` 22.

## Commands run and results

```
pnpm --filter @proj-airi/discord-bot typecheck   → clean
pnpm --filter @proj-airi/discord-bot test        → 16 files, 227 tests, 0 failures
pnpm exec eslint services/discord-bot/src        → 2 errors, both pre-existing
```

The two remaining lint errors are in files this work never modified:
`adapters/airi-adapter.ts` (unused `normalizeDiscordMetadata`) and
`providers/asr/types.ts` (`Buffer` global). Both were failing before this work
began. Runtime smoke checks: `config()` loads the new settings from `.config`
(including the space in `CHARACTER_ID`), and the live Kurisu card compiles to a
system instruction containing the delivery rules and persona, with
`post_history_instructions` at the tail and no `creator_notes`.

## Known limitations

- `VOICE_PRE_ROLL_MS` / `VOICE_POST_ROLL_MS` are not implemented.
- Wave 3 is untouched: no language-aware chunk sizing, no bounded TTS lookahead,
  no TTS cache, no multi-speaker conversation floor. TTS chunks are still small
  (the §2.2 defect is mitigated by fewer turns, not by better chunking).
- Parsed `AvatarAction`s are logged, not published — the relay protocol has no
  emotion channel yet (Wave 7).
- Runtime V2 room-scoped context is not adopted; history stays guild-scoped, per
  the operator's "stay on current tree" decision (D-V01).
- Wave 4 fault injection (ASR timeout, TTS refusal, premature stream close) is
  not covered.
- GPT-SoVITS still takes the `naive_infer` path on every request
  (`GPT_SOVITS_PROMPT_TEXT` is empty) — runtime-v2 D008, out of scope here.

## Risks

- The controller was rewritten wholesale; behavior under real Discord load has
  not been exercised, only unit/integration-level fakes. Run the §14 manual
  acceptance scenarios (A, B, C, G especially) before trusting it live.
- `BrainProvider.generate`'s signature changed; any out-of-tree caller breaks.
- Deleting `turn-queue.ts`/`telemetry.ts` is safe by grep, but a dynamic import
  elsewhere would not have been caught.

## Context required by the next agent

Read `architecture-contract.md` first — §4 (epochs), §5 (playback ownership) and
§6 (turn completion) are the invariants every later wave must preserve. Wave 3A
(chunker) owns `speech-chunker.ts` and must keep `stripControlTokens` ahead of
chunking, because ACT tokens contain `.` and would otherwise be split. Wave 3B
(TTS cache) should key on the same fields listed in Optimize.md §11 and must not
touch the chunker. Wave 3C (conversation floor) is what finally makes
`collecting` mean "merge nearby utterances" instead of "busy" — see the comment
on `admitUtterance`.

## Continuation — Wave 3A

Wave 3A was integrated after operator-confirmed live testing of the Waves 1–2
controller. `speech-chunker.ts` now applies separate Latin and CJK
minimum/target/maximum sizes, holds tiny opening acknowledgements, protects
decimal points and common abbreviations, and flushes final short responses.
`tts-pipeline.ts` adds deterministic one-chunk synthesis lookahead: while chunk
N plays, N+1 may synthesize, but the model iterator cannot advance to N+2.

Runtime settings were added to `.env.example` and `.config`. The full service
verification is 17 files / 235 tests, clean `tsc --noEmit`, and clean scoped
ESLint for all Wave 3A files. The next implementation boundary is Wave 3B
(`providers/tts/tts-cache.ts`); it must not edit the speech chunker.

## Continuation — Wave 3B

Wave 3B adds `CachedTtsProvider`, a provider wrapper with a 32-item default
memory LRU and a sharded disk tier under `.cache/tts`. Cache keys are SHA-256
over key version plus normalized text, both language identities, the explicit
voice-model version, reference/prompt fingerprints, and all relevant synthesis
settings. `GPT_SOVITS_VOICE_MODEL_VERSION` is deliberately operator-managed:
leave it empty to synthesize without caching, and bump it whenever loaded
weights or synthesis defaults change.

Only complete WAV audio of at least 100 ms is retained. Disk audio/metadata are
written to unique temporary files, fsynced, and renamed; readers require both
final files. In-process identical misses are single-flight. A caller can stop
waiting without aborting shared synthesis, allowing a valid completion to warm
the cache. Cache read/write/corruption failures fall back to provider synthesis.
TTL and LRU disk eviction enforce configured age, item, and byte limits.
`CachedTtsProvider.prewarm()` accepts the standard or localized prompt requests
without hard-coding product copy into the cache layer.

Runtime settings were added to `.env.example` and `.config`. Verification is
18 files / 243 tests, clean `tsc --noEmit`, and clean scoped ESLint for all Wave
3B files. The next implementation boundary is Wave 3C (multi-speaker floor).

## Continuation — Wave 3C

Wave 3C adds `ConversationFloor`, `ConversationFloorRegistry`, and the pure
group-turn builder behind the specified `add` / `flush` / `clear` API. The
first meaningful transcript opens a bounded collection; nearby speakers remain
separate source events, while adjacent fragments from the same speaker become
one structured message. Display names are JSON-quoted in the generated Gemini
input so they cannot create prompt delimiters.

The floor rejects heavily overlapping speech and configured speaker/utterance
overflow with a local `request_one_at_a_time` action. A successful flush grants
the last speaker a bounded lease. Every collection captures its response epoch,
and stale groups clear without producing an input. The registry owns isolated
state per guild. Four validated runtime settings were added to `.env.example`
and `.config`.

Per Agent 3C's ownership rule, the main controller was not changed; the Wave
integration checkpoint must connect transcribed accepted utterances to this API
and schedule `flushAt`, then use the cached local one-at-a-time prompt for the
action branch. Verification is 19 files / 250 tests, clean `tsc --noEmit`, and
clean scoped ESLint. The next independent implementation boundary is Wave 3D
(telemetry), followed by the Wave 3 integration checkpoint.

## Continuation — Wave 3D

Wave 3D adds a typed telemetry event catalog, a primitive-only structured
record emitter that drops sensitive field names, and an incremental metrics
accumulator. The accumulator derives discard/filter/cache rates, Gemini 429 and
stale-result counts, latency averages, playback timing, and TTS real-time
factor without retaining prompts, audio, authorization data, or cache content.

Existing runtime logs now include ASR latency, Gemini turn/epoch correlation
and first-token timing, cache tier/audio duration, TTS synthesis completion,
and playback queue wait. The legacy `input_discarded` name is normalized to the
contract's `utterance_discarded`. Conversation-floor telemetry is injected via
its options so the standalone floor remains deterministic and side-effect-free
unless its integrator supplies an emitter.

Verification is 20 files / 253 tests, clean `tsc --noEmit`, and clean scoped
ESLint. All independent Wave 3 boundaries are now implemented; the next step is
the Wave 3 controller integration checkpoint for the conversation floor.

## Continuation — Wave 3 integration checkpoint

The multi-speaker floor is now connected to `ConversationController` through
`ConversationFloorCoordinator`, which exclusively owns per-guild flush timers
and cleanup. During `collecting`, additional finalized utterances may reach ASR
and join the bounded group; `thinking` and `speaking` retain the established
half-duplex behavior. A normal group becomes one structured Gemini turn. A
speaker/overlap overflow speaks the Japanese one-at-a-time prompt locally via
the versioned TTS cache and makes no Gemini request.

Cancellation clears the guild floor and timer. The epoch captured at admission
is checked again after ASR, preventing a transcript that completes after
cancellation from mutating duplicate state or reopening the floor. Disconnect
uses the same cleanup path. Integration regressions cover two speakers → one
request, three speakers → local prompt/no request, and cancellation → no late
flush.

Verification is 20 files / 256 tests, clean `tsc --noEmit`, and clean scoped
ESLint. Wave 3A–3D and the Wave 3 integration checkpoint are complete. The next
implementation boundary is Wave 4 deterministic and integration QA.

## Continuation — Wave 4 QA and final integration

Wave 4 closes deterministic provider and lifecycle fault injection: ASR timeout
and refusal, Gemini cancellation and quota failure, TTS refusal/timeout/late
completion/premature stream error, player failure, disconnect teardown, and
stale player events. The adversarial playback review found and fixed an actual
stop race: a new resource could start before the cancelled resource emitted its
asynchronous Idle, allowing that old event to settle the new item. A stop/Idle
barrier now prevents replacement until the old player is terminal.

All remaining numeric runtime settings now enforce safe integer/range bounds.
`scripts/benchmark-voice.ts` implements the TTS experiment matrix and optional
approved-WAV ASR measurements, emits hardware and configuration metadata, and
leaves subjective pronunciation/prosody to operator review. Verification is 22
files / 266 tests with clean TypeScript; final lint and repository acceptance
commands are recorded at handoff.
