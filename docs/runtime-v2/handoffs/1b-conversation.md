# 1B Conversation Domain — room-scoped context, InputEvent, TurnOutput, delivery, cancellation

## Summary

Wave 1 Conversation Domain contracts, implemented exactly against
`02-public-contracts.md` §1–§4 and §11. Purely additive: six new modules
under `src/orchestration/` (room-id, events, output, delivery, room, turn)
plus four inline Vitest suites. No existing file was modified. The frozen
invariants are proven by tests: two text channels in one guild are isolated,
two speakers in one voice room share history, room ids are deterministic,
cancellation is per-room with barge-in finalize semantics.

## Files changed

All NEW (additive). None of the Integration-Lead-owned or other agents' files
were touched.

- `airi/services/discord-bot/src/orchestration/room-id.ts` — `ConversationRoomId` + `textRoom`/`threadRoom`/`voiceRoom`.
- `airi/services/discord-bot/src/orchestration/events.ts` — `BaseInputEvent` + `VoiceInputEvent`/`DiscordMentionInputEvent`/`SlashCommandInputEvent`/`ActivityInteractionInputEvent` + `InputEvent` union.
- `airi/services/discord-bot/src/orchestration/output.ts` — `AvatarAction` + `TurnOutput` union.
- `airi/services/discord-bot/src/orchestration/delivery.ts` — `DeliveryPolicy` + `voiceDefault`/`mentionDefault`/`activityDefault` + `defaultPolicyFor`.
- `airi/services/discord-bot/src/orchestration/room.ts` — `ConversationTurn`, `ConversationRoom`, `RoomStore`, `InMemoryRoomStore`.
- `airi/services/discord-bot/src/orchestration/turn.ts` — `TurnAbortManager` + `propagate` helper.
- Tests (inline `*.test.ts`, matching the repo convention `conversation-controller.test.ts`):
  - `airi/services/discord-bot/src/orchestration/room.test.ts`
  - `airi/services/discord-bot/src/orchestration/events.test.ts`
  - `airi/services/discord-bot/src/orchestration/delivery.test.ts`
  - `airi/services/discord-bot/src/orchestration/turn.test.ts`

## Public interfaces added/changed

No existing interface was changed. The following are added (all under
`src/orchestration/`, exported for the Integration Lead to wire during the
Wave 1 gate):

- `ConversationRoomId` (type alias for `string`, opaque), `textRoom`, `threadRoom`, `voiceRoom` (deterministic id builders).
- `BaseInputEvent`, `VoiceInputEvent`, `DiscordMentionInputEvent`, `SlashCommandInputEvent`, `ActivityInteractionInputEvent`, `InputEvent` (discriminated union on `type`).
- `AvatarAction`, `TurnOutput` (discriminated union: `text.delta` | `speech.segment` | `avatar.action` | `pause` | `final`).
- `DeliveryPolicy`, `voiceDefault`, `mentionDefault`, `activityDefault`, `defaultPolicyFor(event)`.
- `ConversationTurn`, `ConversationRoom`, `RoomStore`, class `InMemoryRoomStore implements RoomStore`.
- class `TurnAbortManager` (methods: `begin`, `signal`, `abort`, `child`, `isActive`), standalone `propagate(parent, child)`.

## Behavior implemented

**Room ids** (`room-id.ts`): deterministic strings
`guild:<g>:<medium>:<channelId>` for medium ∈ {`text`,`thread`,`voice`}. Same
inputs always produce the same id; different channels/guilds/mediums produce
different ids.

**Input events** (`events.ts`): the four-variant union from 02 §1. `VoiceInputEvent`
mirrors `VoiceUtterance` — carries `pcm: Buffer`, `sampleRate: 16000`,
`voiceChannelId`. Voice has NO `text` field (ASR runs after the event is
received, per 02 §1). The voice adapter converts a `VoiceUtterance` into a
`VoiceInputEvent`.

**TurnOutput** (`output.ts`): the five-variant semantic stream from 02 §3.
`AvatarAction` is the parsed internal shape (emotion/intensity/motionHint);
raw ACT markup never reaches this type (D006 — parsing is Wave 6A's job).

**DeliveryPolicy** (`delivery.ts`): the three default policies from the 02 §4
table. **`avatar` defaults to `false` for voice and mention** (a future wire
flips it `true` when an Activity is active); activity defaults `avatar: true`.
Voice → speech only (no Discord text); mention → text only (no speech into VC,
per D009); activity → avatar only (Activity-visible, optional voice bound
later). `defaultPolicyFor(event)` is an exhaustive switch over the union;
slash commands default to fully-enabled (admin/debug flows like `/voice-test`).

**RoomStore** (`room.ts`): in-memory, process-lifetime, lazily creates rooms.
`recentTurns` bounded to `maxTurns`, defaulting to `config().brain.maxMessages`
(default 24, matching today's `CONVERSATION_MAX_MESSAGES`). Oldest turns
dropped on overflow (mirrors `GuildSession.trim`). `appendTurn`,
`setRunningSummary`, `setActiveMode`, `clear`, `getOrCreate(roomId,
characterId)`. `clear()` empties turns+summary but keeps the room registered.
`updatedAt` is the wall-clock mutation time (bumped on every mutation);
`ConversationTurn.timestamp` is the turn's own logical time and is left
untouched.

**TurnAbortManager** (`turn.ts`): one active `AbortController` per room.
`begin(roomId)` aborts any prior active turn in that room first (barge-in
finalize: an old turn can never resume after a new turn begins — 01 invariant
#7). `child(parent)` derives a child controller whose signal follows the
parent (used for brain/tts/queued-speech/avatar per the 02 §11 hierarchy).
`abort(roomId)` finalizes the whole turn. Provider-agnostic — it only hands
out/aborts signals; providers accept whatever `AbortSignal` they are given.
Cross-room concurrency is preserved (two rooms = two independent controllers).

## Configuration added

None. `InMemoryRoomStore` reads the existing `config().brain.maxMessages`
(`CONVERSATION_MAX_MESSAGES`, default 24) for its turn bound. No new env vars,
no `package.json`/`config.ts` changes.

## Tests added

43 new tests across 4 files (inline `*.test.ts` next to source, matching the
repo convention — `vitest.config.ts` globs `src/**/*.test.ts`):

- `room.test.ts` (15): room-id determinism; text-channel isolation within a
  guild; voice-room history shared across two speakers; lazy `getOrCreate`;
  lazy creation on `appendTurn`; turn bounding (custom + default-to-24);
  running summary set/overwrite; active mode set/clear; `clear()` empties but
  keeps the room; `clear()` no-op on missing room; `updatedAt` bumped on
  mutation.
- `events.test.ts` (7): `type` narrowing for all four variants; voice-only
  fields (pcm/sampleRate/voiceChannelId) present, `text` absent; mention-only
  fields (messageId/stripped text) present, voice fields absent;
  `BaseInputEvent` shared fields on every variant; VoiceInputEvent mirrors
  VoiceUtterance; exhaustive switch over the union.
- `delivery.test.ts` (8): the three default policies match the 02 §4 table
  exactly; `defaultPolicyFor` routes each variant correctly; slash falls back
  to fully-enabled; exhaustive over the union.
- `turn.test.ts` (13): per-room signal lifecycle (`begin`/`abort`/`isActive`/
  `signal`); `abort` no-op on inactive room; `signal()` falls back to a
  never-aborted signal; child propagation (parent abort → all children abort);
  independent child abort (TTS cancels without killing siblings/parent);
  `propagate` immediate-abort and already-aborted edge cases; cross-room
  independence (voice vs text in same guild); barge-in finalize (`begin`
  aborts prior turn; stale children cannot be revived; sequential turns get
  fresh independent signals).

## Tests executed

From `airi/services/discord-bot/`:

- `pnpm typecheck` (`tsc --noEmit`): **PASS** (no errors).
- `pnpm test` (`vitest run`): **PASS** — 9 test files, 87 tests, 0 failures.

Baseline before my changes: 4 files / 29 tests (per `00-current-state.md` §3).
A parallel Wave 1C telemetry suite (`src/observability/turn-tracer.test.ts`,
15 tests) landed alongside mine; it is not my code and I did not touch it.
After my changes the total is 9 files / 87 tests, all green. Existing suites
(`conversation-controller`, `gpt-sovits`, `language`, `publisher`) remain
green — confirming the additive-only constraint.

## Benchmark results

N/A — this wave adds types and an in-memory store with no I/O or provider
calls. No latency-relevant code path runs yet (the orchestrator rewiring that
would route through these types is the Integration Lead's gate work).

## Assumptions

1. `import type` for interface-only imports, no semicolons (ASI), `@guiiai/logg`'s `useLogg` — all matched to existing files (verified against `conversation-controller.ts`, `guild-session.ts`, `publisher.ts`).
2. Test location is inline `*.test.ts` next to source (not a `__tests__/` dir) — confirmed by `conversation-controller.test.ts` and the `vitest.config.ts` glob `src/**/*.test.ts`.
3. `InMemoryRoomStore`'s turn bound defaults to `config().brain.maxMessages` (24) per the task spec, so the store matches the prior `GuildSession` bound before the Integration Lead rewires `index.ts`/`guild-session.ts`.
4. `DeliveryPolicy.avatar` defaults to `false` for voice and mention (per the task note: a future wire flips it `true` when an Activity is active). Activity defaults `avatar: true`.
5. `TurnAbortManager` is provider-agnostic: it owns no provider references, only hands out/aborts `AbortSignal`s. Providers stay decoupled (01 invariant #8).
6. `updatedAt` is the wall-clock time of the last mutation (`Date.now()`), distinct from `ConversationTurn.timestamp` (the turn's logical time, preserved as given).

## Known limitations

- The store is **in-memory only**, process-lifetime. Persistence of context is explicitly out of scope for Wave 1 (02 §2.3); persistent memory is Wave 4 and a different subsystem (D004).
- `appendTurn` does not deduplicate or coalesce; it appends exactly what it is given (matching `GuildSession.addUserTurn`/`addModelTurn` semantics). The orchestrator decides what to record.
- Nothing here is wired into the live voice loop yet. `conversation-controller.ts`, `guild-session.ts`, `index.ts`, and `providers/brain/types.ts` (BrainTurn.roomId) are Integration-Lead-owned rewires for the Wave 1 gate — I did not touch them.
- `defaultPolicyFor` returns a fully-enabled policy for slash commands as a safe default for admin/debug flows; if a future slash command needs different delivery, it supplies its own policy.

## Integration instructions

For the Integration Lead (Wave 1 gate):

1. **Room-scoped context (D003):** replace `brain.setContentsProvider((turn) => sessions.get(turn.guildId).getContents())` in `index.ts:50-54` with a resolver that reads from `InMemoryRoomStore`. The new `BrainTurn` (02 §6) gains `roomId: ConversationRoomId`; the resolver becomes `rooms.getOrCreate(turn.roomId, characterId).recentTurns` (the prompt compiler, Wave 1A, consumes `ConversationRoom` per 02 §5.3). Speaker-label folding (today's `${displayName}: ${text}`) moves into the prompt compiler's turn rendering, not the store — the store keeps raw `ConversationTurn` records.
2. **Input normalization (D002):** the voice adapter converts each `VoiceUtterance` into a `VoiceInputEvent` (carrying `pcm`/`sampleRate`/`voiceChannelId`); the orchestrator assigns `eventId`/`turnId` and runs ASR after. `room-id.ts` gives `voiceRoom(guildId, utterance.channelId)` for the room key.
3. **Delivery:** wire `defaultPolicyFor(event)` at the fan-out point; sinks subscribe to `TurnOutput` variants gated by the policy booleans. Flip `avatar: true` for voice/mention only when an Activity session is active (Wave 7).
4. **Cancellation:** at turn start call `turnAbortManager.begin(roomId)` and pass the returned signal (or `child()` derivatives) to brain/tts/queued-speech/avatar. On barge-in finalize (human utterance completes during bot speech), the existing controller already aborts generation on finalize — that becomes `turnAbortManager.abort(roomId)` at the start of the next `begin`, which the manager now does automatically.
5. **Turn bounding:** `InMemoryRoomStore` already reads `config().brain.maxMessages`, so the 24-turn bound is preserved with no config change.

## Follow-up items

- Wave 3B (room binding): add an explicit room-binding map so a voice room + text channel can share a logical `ConversationRoomId`; today's helpers produce isolated rooms only.
- Wave 4 (memory): `ConversationRoom.runningSummary` is written by the context summarizer; the `setRunningSummary` store method is ready.
- Wave 6A (output-protocol parser): emits `avatar.action` / `pause` / `speech.segment` `TurnOutput`s from raw LLM text + ACT markup; the `TurnOutput` union is ready to consume.
- Wave 7 (avatar): flip `DeliveryPolicy.avatar` to `true` for voice/mention when an Activity is active.
- Optional: a `delete(roomId)` on `RoomStore` for explicit teardown (today's `GuildSessionRegistry.delete`); not needed for Wave 1 since rooms are process-lifetime and cheap.
