# Wave 1 Integration Gate — rewire the live voice path onto the runtime foundation

## Goal
The three Wave-1 specialists (1A character, 1B conversation domain, 1C telemetry) delivered **purely additive** modules (156 tests, all green). Now the Integration-Lead-owned gate work (§42/§17): wire the existing live voice loop onto the new room-scoped `RoomStore`, the data-driven `CharacterRuntime`/`PromptCompiler`, and the unified `TurnTracer` — **while preserving the exact current voice behavior**, then run the Wave-1 gate (typecheck + tests + ASR pytest).

## Design principle: safe, reversible, behind config
The new modules are additive. I will wire them **with graceful fallback** so that if no character card is configured (`CHARACTER_PATH` unset), behavior is byte-for-byte identical to today (hardcoded `SYSTEM_PROMPT`, per-guild... → actually I'll move to room-scoped since that's pure upside and tested; persona stays the hardcoded prompt only if card absent). This makes the change safe and lets the card be adopted/migrated separately (D006/D008 transition plan).

## Changes (6 files)

### 1. `src/config.ts` — add `character` config block (Integration-Lead-owned)
Add to `AppConfig`:
```ts
character: { root: string; id: string }
```
parsed from `CHARACTER_PATH` (default `''`) and `CHARACTER_ID` (default `'kurisu'`). The registry's `readConfigCharacterRoot` compatibility seam already reads this. No secrets; root is a non-secret path.

### 2. `src/services.ts` — publish shared runtime instances
Extend `Services` with the new singletons so commands/controllers reach them without re-construction (matches the existing `setServices` pattern):
- `rooms: RoomStore` (InMemoryRoomStore)
- `registry?: CharacterRegistry` (undefined when card not configured → fallback path)
- `promptCompiler?: PromptCompiler` (undefined when no character)
Keep existing `sessions` for now (deleted in a follow-up once nothing references it — actually I'll remove its usage in the controller and leave the field to avoid breaking the test; see step 5).

### 3. `src/index.ts` — construct & wire the runtime (Integration-Lead-owned bootstrap)
- Construct `rooms = new InMemoryRoomStore()`.
- Construct registry: if `cfg.character.root` is non-empty, `new FileCharacterRegistry()` + `registry.load(cfg.character.id)` → `character`; build `new DefaultPromptCompiler()`. If empty, log a warning and leave registry/compiler undefined (fallback path keeps the hardcoded persona).
- Swap the brain's `setContentsProvider` resolver from `sessions.get(turn.guildId).getContents()` → the room-scoped+compiled prompt. Because the compiler needs the full `ConversationRoom` + `currentInput`, and the brain provider only takes a `BrainTurn`, I'll **extend the brain provider with an optional prompt-compiler hook** rather than overloading the resolver. Concretely: add `brain.setPromptCompiler({ compiler, rooms, character })` (a new optional method on `GeminiBrainProvider`); when set, `generate()` compiles from the room; when unset, it falls back to the existing `setContentsProvider` path. This keeps `BrainProvider` interface stable and the change localized.
- Pass `rooms`, `registry`, `promptCompiler` into `setServices`.

### 4. `src/orchestration/conversation-controller.ts` — room-scoped context + character + telemetry (the core rewire)
This is the live voice path. Surgical changes:
- **Room-scoped context (D003):** replace `this.sessions` usage with `this.rooms`. On a voice utterance, compute `roomId = voiceRoom(guildId, utterance.channelId)`. Record user turn via `rooms.appendTurn(roomId, {role:'user', speaker, text, language, turnId, timestamp})`; record assistant turn similarly. The brain reads context via the compiler hook (step 3).
- **Character-driven persona:** pass the loaded `character` (if any) into the controller constructor; the controller no longer needs the persona text itself (the compiler owns it).
- **Telemetry (1C):** swap `TurnTimer` → `TurnTracer` per the 1C handoff's 1:1 table (`markEndpoint`→`markEndpointFinalized`, etc.), add the new stage marks where natural (`markPromptCompile` via the compiler metrics, `markSpeechSegmentReady` on first chunker emit, `markTtsRequest`, `markPlaybackEnd`). Call `setMeta({model, tts_streaming_mode, ...})` and `setOutcome('aborted')` on barge-in finalize.
- **Cancellation (1B):** adopt `TurnAbortManager`: `begin(roomId)` at turn start, pass its signal (or `child()`) to brain/tts; on barge-in finalize the manager's `begin`-on-next-turn already aborts the prior turn. Keep the existing immediate-TTS-abort on barge-in (voice→stopPlayback + activeTts abort).
- **Preserve the language-propagation behavior** the existing test asserts (turn-language hint → TTS). The `conversation-controller.test.ts` must stay green; I will update it **only** to inject `rooms` instead of `sessions` (the test constructs the controller directly) — no behavioral assertion changes.

### 5. `src/providers/brain/gemini.ts` + `types.ts` — optional prompt-compiler hook
- `BrainTurn` gains `roomId: ConversationRoomId` (02 §6, D003).
- `GeminiBrainProvider` gains optional `setPromptCompiler({ compiler, rooms, character })`; in `generate()`, if set, compile the prompt (systemInstruction + contents) from the room; else fall back to `SYSTEM_PROMPT` + the existing `setContentsProvider` resolver. This keeps the provider replaceable (01 invariant #8) and the change localized to Gemini.

### 6. Config files — `.env.example` + `.config`
Add `CHARACTER_PATH=` (commented, pointing at the dir containing `Makise Kurisu/`) and `CHARACTER_ID=kurisu`. Leave them **unset by default** so the fallback path is the default until the user opts in (safe rollout).

## NOT doing in this gate (deferred per the plan's wave boundaries)
- Card migration (`creator_notes` → `extensions.dc_bot`) — non-breaking, separate change; registry handles both shapes.
- D008 reference-transcript generation — needs the running ASR service; that's Wave 2A Step 1.
- ACT-v1 parser wiring into the live output stream — Wave 6A (the parser exists + is tested; persona emission of ACT instructions can be toggled off for now by leaving the live card without `extensions.dc_bot`, so no ACT tokens reach TTS yet — safe).
- Text mention adapter — Wave 3.
- Memory — Wave 4.
- Deleting `guild-session.ts`/`telemetry.ts` — only after the controller no longer references them; I'll remove `TurnTimer` usage and can delete `telemetry.ts` in this gate since only the controller used it. I'll keep `guild-session.ts` if `services.ts` still types it, else remove.

## Verification (Wave-1 gate, §17)
1. `pnpm typecheck` — must pass clean (0 errors).
2. `pnpm test` — all existing + new tests green (target ≥156 still passing; the updated controller test stays green).
3. `qwen3-asr/.venv/Scripts/python.exe -m pytest` — ASR tests unaffected, must pass.
4. Add 1–2 integration-style assertions: a voice utterance through the rewired controller routes context to the correct `voiceRoom` and the persona reaches the brain when a character is configured (mocked compiler); room isolation between two voice channels.
5. Update `docs/runtime-v2/04-decisions.md` with D010 (Wave-1 sequencing: 1B+1C parallel, then 1A) and D011 (room-scoped context adopted; per-guild GuildSession superseded).
6. Commit the wave.

## Risk & rollback
- The change is **behind config flags** (`CHARACTER_PATH` unset → behavior matches today's persona source).
- Pure-room-scoping is tested by 1B's invariants; the controller rewire is covered by the updated controller test.
- If anything fails the gate, the additive modules mean I can revert just the controller/config wiring and the tree returns to the current green state.