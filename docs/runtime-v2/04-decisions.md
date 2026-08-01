# 04 — Decision Log (ADR-style, append-only)

> Append-only record of architectural decisions for Runtime V2. New decisions
> are added at the bottom with the next free `D0xx` id. Never edit a past
> decision's *status/outcome* in place — supersede it with a new decision that
> references the old one. This is how context is preserved across waves without
> re-feeding agents the whole repository.

Format per entry:
```
## D0xx — <short title>  (status: Accepted | Superseded by D0yy | Deprecated)
- Date: YYYY-MM-DD
- Context: why this decision is needed
- Decision: what we chose
- Consequences: what follows
```

---

## D001 — Keep ASR and TTS as separate Python processes  (Accepted)
- Date: 2026-07-31
- Context: `qwen3-asr` pins `transformers==4.57.6` + `accelerate==1.12.0`
  (via `qwen-asr==0.0.6`), while GPT-SoVITS needs its own incompatible
  `transformers`. They cannot share a venv. Verified in
  `00-current-state.md` §2.
- Decision: Preserve the two-process boundary. ASR (`qwen3-asr/.venv`,
  `:8765`) and TTS (`GPT-SoVITS/.venv`, `:9880`) remain independent services
  coordinated only over loopback HTTP from the Node bot.
- Consequences: No "merge the environments to simplify scheduling"捷径. GPU
  scheduling, if ever needed, is done via a `ComputeScheduler` interface in
  Node that wraps the two HTTP services — never by collapsing venvs. Aligns
  with master plan §37 and non-goal §47.

## D002 — Voice and text use the same TurnOrchestrator  (Accepted)
- Date: 2026-07-31
- Context: The master plan's central design rule (§2) is "one character runtime,
  one conversation model." Building separate text-bot and voice-bot brains would
  duplicate character/prompt/context logic and diverge.
- Decision: All input media are normalized to `InputEvent` and routed through a
  single `TurnOrchestrator`. Output is fanned out to sinks by `DeliveryPolicy`.
  The existing voice loop is rewired onto this orchestrator in Wave 1; text is
  added in Wave 3 as another adapter, not a new brain.
- Consequences: `02-public-contracts.md` §1–§4 are frozen. Today's
  `ConversationController` is refactored into the orchestrator + adapters rather
  than copied for text.

## D003 — Conversation context is room-scoped, not guild-scoped  (Accepted)
- Date: 2026-07-31
- Context: Today's `GuildSession` (`00-current-state.md` §4.9) keys history by
  `guildId`, so any two channels in a guild share context. The master plan (§4)
  requires `#science` and `#gaming` not to contaminate each other, while two
  speakers in one voice room share history.
- Decision: Introduce `ConversationRoomId`
  (`guild:<g>:text:<c>` / `:thread:<t>` / `:voice:<vc>`). History is keyed by
  room. Optional explicit room binding (Wave 3B) lets a voice room + text channel
  share a logical room; unbound channels stay isolated.
- Consequences: `brain.setContentsProvider` in `index.ts:50-54` switches from
  `sessions.get(turn.guildId)` to the room-scoped store. `BrainTurn` gains
  `roomId` (`02-public-contracts.md` §6). This is an Integration-Lead-coordinated
  bootstrap change.

## D004 — SQLite + FTS5 precedes any vector database for memory  (Accepted)
- Date: 2026-07-31
- Context: Memory must be a separate subsystem from context (master plan §9),
  but the first deployment is a single machine. A vector DB adds operational
  complexity before it is justified.
- Decision: Wave 4 implements `MemoryStore` on SQLite + FTS5 with a score of
  `scope match + lexical relevance + recency + salience`. An embedding column
  may be added later; a vector DB is deferred until SQLite retrieval is
  demonstrably insufficient.
- Consequences: No Redis, no vector DB dependency in Wave 1–4. Memory jobs run
  after the response and never block audio. DB files live outside upstream
  source dirs where avoidable (`MEMORY_DB_PATH`).

## D005 — Live2D uses a Discord Activity; never stream rendered video  (Accepted)
- Date: 2026-07-31
- Context: Discord Activities render a web app in an iframe and communicate via
  the Embedded App SDK. Streaming a fake webcam/video of rendered Live2D is
  fragile and against Discord's model (master plan §1.2, §7).
- Decision: The avatar is a Discord Activity that renders AIRI's Live2D locally.
  The bot publishes semantic `AvatarAction` events over a relay; the Activity
  consumes them. Lip sync derives from the actual playable TTS PCM amplitude
  envelope, not LLM text timing. The LLM never decides raw Cubism parameters.
- Consequences: Avatar failure is nonfatal (voice/text continue). Avatar
  publishing never blocks voice. Semantic action → Kurisu animation profile
  mapping lives in a motion director (Wave 7G), keeping the protocol
  avatar-agnostic.

## D006 — ACT tokens are an output encoding, parsed immediately; never reach TTS/text/history/memory  (Accepted)
- Date: 2026-07-31
- Context: The Kurisu card stores an ACT/emotion protocol in `creator_notes`
  (`00-current-state.md` §7). ACT markup leaking into TTS/visible
  replies/memory/history is a correctness and quality bug (master plan §5).
- Decision: ACT-v1 is one LLM-output *encoding*. The output-protocol parser
  (Wave 6) parses it immediately into `AvatarAction` + clean text. Clean text
  only is what reaches TTS, Discord replies, conversation history, and memory.
  The protocol metadata moves from `creator_notes` into
  `extensions.dc_bot.outputProtocol`; `creator_notes` is preserved on the card
  but is NOT auto-injected into prompts.
- Consequences: `02-public-contracts.md` §3, §7, §8 frozen. Parsing must be
  robust (malformed ACT must not break the turn; no `eval`/blind `JSON.parse`).

## D007 — Repository topology: nested clones (orphan gitlinks), code stays under airi/services/discord-bot for now  (Accepted)
- Date: 2026-07-31
- Context: `airi/` and `GPT-SoVITS/` are orphan gitlinks (mode `160000`, no
  `.gitmodules`); `qwen3-asr/` is fully tracked in the outer repo. The
  discord-bot source is version-controlled by `airi/.git`, not the outer
  `DC_BOT` repo (`00-current-state.md` §1).
- Decision: Do NOT relocate the repo during Runtime V2. New code is added
  inside `airi/services/discord-bot/src/`. Wave 8 (repository hygiene) evaluates
  relocation to `apps/discord-bot` / `packages/*` / `services/*` only after the
  runtime is stable, and decides between pinned submodules / patches / small
  adapter packages vs. an increasingly divergent AIRI fork.
- Consequences: All Wave 1–7 file paths in `02-public-contracts.md` are under
  `airi/services/discord-bot/src/`. Commits for discord-bot changes land in the
  nested `airi/` repo.

## D008 — GPT-SoVITS reference conditioning is the first latency fix; streaming mode benchmarked after  (Accepted)
- Date: 2026-07-31
- Context: `03-performance-baseline.md` §4 shows the
  `Prompt free is not supported batch_infer! switch to naive_infer` fallback
  fires on 17/17 (100%) of successful syntheses because `prompt_text` is empty.
  This forces the slower naive path on every request. Master plan §1.2/§40
  names this Experiment A and the first optimization target.
- Decision: Wave 2A Step 1 first generates/reviews a transcript for the Kurisu
  reference clip into `Makise Kurisu/reference.txt` and sends
  `ref_audio_path + prompt_text + prompt_lang=ja` for every request, verifying
  the fallback log line disappears. Only then are streaming modes 1/2/3
  benchmarked fairly (Experiment B). Default candidate is mode 2 but is not
  made permanent until measured.
- Consequences: No latency conclusion about streaming modes is valid until
  conditioning is fixed. The `naive_infer` fallback's removal is a Wave 2
  acceptance criterion.

## D009 — No privileged Message Content intent for the mention-only text MVP  (Accepted)
- Date: 2026-07-31
- Context: Discord's Message Content intent is privileged, but messages that
  explicitly mention the application remain available without it (master plan
  §1.2). Today's client uses only `Guilds` + `GuildVoiceStates`
  (`00-current-state.md` §4.2).
- Decision: Wave 3A adds `GuildMessages` and listens to `messageCreate` but
  ignores any message without an explicit bot mention. It does NOT request
  general Message Content merely to implement `@Kurisu ...`.
- Consequences: Plain unrelated guild messages are ignored. The mention text is
  stripped safely. Typing indicators are used while appropriate. Text mentions
  never invoke GPT-SoVITS by default (delivery policy: `speech: false`).

## D010 — Wave 1 specialists run 1B+1C in parallel, then 1A (compile-order dependency)  (Accepted)
- Date: 2026-07-31
- Context: The master plan (§16) lists Wave 1 as three parallel agents
  (1A Character, 1B Conversation, 1C Telemetry). But 1A's `PromptCompiler`
  imports `ConversationRoom` and `InputEvent` types that 1B owns, while 1C is
  fully self-contained. Running all three concurrently would force 1A to either
  redefine sibling types (a duplicated-abstraction anti-pattern, §44) or block
  on type resolution.
- Decision: Sequenced Wave 1 — 1B and 1C run in parallel (both self-contained,
  purely additive), then 1A runs once 1B's types exist. All three produced
  additive modules; the Integration Lead performs the bootstrap/controller
  rewiring at the gate (§42: shared files are Integration-Lead-owned).
- Consequences: Zero merge conflicts; clean `tsc`/`vitest` after each agent.
  Result: 156 new-module tests green before any live-path rewire. This
  sequencing is the template for future waves with cross-agent type deps.

## D011 — Room-scoped context adopted; per-guild GuildSession superseded  (Accepted)
- Date: 2026-07-31
- Context: D003 froze the room-scoped context contract. The Wave 1 gate rewires
  the live voice path: `ConversationController` now keys history by
  `voiceRoom(guildId, channelId)` via `InMemoryRoomStore`, and the Gemini brain
  resolves its prompt from the room (via `setPromptCompiler` when a character
  is configured, else the legacy `setContentsProvider` fallback).
- Decision: Adopt room-scoped context as the live behavior. Two voice channels
  in one guild no longer share context (proven by a new integration test);
  two users in one voice room do share it. The per-guild `GuildSession`/
  `GuildSessionRegistry` is retained only as the legacy fallback's data source
  and is marked `@deprecated` in `services.ts`.
- Consequences: `BrainTurn` carries `roomId`. The character runtime is wired
  behind `CHARACTER_PATH` (unset → generic prompt fallback, so the change is
  safe and reversible). `TurnTimer` (`orchestration/telemetry.ts`) is no longer
  referenced by the controller — `TurnTracer` (`observability/`) is the live
  tracer; `telemetry.ts` deletion is a follow-up once confirmed unreferenced.
  Gate result: typecheck ✓, 158 tests ✓, ASR pytest ✓.
