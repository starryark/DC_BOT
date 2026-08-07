# 01 — Target Architecture (Runtime V2)

> **Status: FROZEN by the Integration Lead at the Wave 0 integration gate.**
> Authored from `Proposal.md` (the master plan) reconciled against the verified
> ground truth in `00-current-state.md` and the baseline in `03-performance-baseline.md`.
> Specialist agents (Wave 1+) MUST conform to this architecture. If reality
> contradicts it, record the divergence in `04-decisions.md` — do not silently
> diverge.

---

## 1. Governing principle

> **There is one character runtime and one conversation model. Voice, Discord
> text, and Live2D are adapters/sinks around it.**

Do not build independent "text bot logic" and "voice bot logic." Every input
medium is normalized into one `InputEvent`; every output is a stream of
semantic `TurnOutput` events fanned out to sinks (text, speech, avatar) by a
`DeliveryPolicy`.

The character is the product. Discord, Gemini, Qwen, GPT-SoVITS, AIRI
components, SQLite, and Live2D are replaceable capabilities around that
character.

---

## 2. Architecture diagram

```
                 Discord Voice
                       │
                       ▼
                 Voice Adapter
                       │
                 VoiceUtterance
                       │
                       ▼
                 ┌────────────┐
Discord @mention │            │ Activity interaction
───────────────► │   Input    │ ◄──────────────────
                 │ Adapters   │
                 └─────┬──────┘
                       │
                 normalized InputEvent
                       │
                       ▼
              ┌──────────────────┐
              │ TurnOrchestrator │
              │                  │
              │ room state       │
              │ attention        │
              │ cancellation     │
              │ context          │
              │ memory retrieval │
              └───────┬──────────┘
                      │
               PromptCompiler
                      │
                      ▼
               BrainProvider
                    Gemini
                      │
             streaming TurnOutput
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
   Discord text   Speech sink    Avatar sink
                      │              │
                 GPT-SoVITS      Discord
                      │           Activity
                 Discord voice      │
                                     ▼
                                   Live2D
```

---

## 3. Layers and their owners

| Layer | Responsibility | Owner wave | Files (target) |
|-------|----------------|------------|----------------|
| Input adapters | Convert Discord voice / `@mention` / Activity into a normalized `InputEvent`; know nothing about LLM/TTS/ASR | Wave 1 (voice, existing), Wave 3 (text), Wave 7 (Activity) | `src/adapters/**`, `src/voice/**` |
| TurnOrchestrator | The single orchestrator: room state, attention, cancellation, context assembly, fan-out to sinks | Wave 1 | `src/orchestration/**` |
| Conversation rooms | Room-scoped context (`ConversationRoomId`), recent turns, running summary | Wave 1 | `src/orchestration/room*` |
| Attention policy | Decide `respond`/`observe`/`ignore` before expensive generation | Wave 2D | `src/orchestration/attention/**` |
| Character subsystem | CCv3 card load/validate/normalize → immutable `CharacterRuntime`; `PromptCompiler`; output-protocol parser | Wave 1, Wave 6 | `src/character/**` |
| Brain provider | Provider abstraction over the LLM (Gemini); streams text | Wave 2C | `src/providers/brain/**` |
| ASR provider | Provider abstraction over transcription (Qwen3-ASR HTTP) | Wave 2B | `src/providers/asr/**`, `qwen3-asr/**` |
| TTS provider | Provider abstraction over GPT-SoVITS streaming synthesis | Wave 2A | `src/providers/tts/**` |
| Memory subsystem | SQLite + FTS5 persistent memory; context summarizer; noncritical path | Wave 4 | `src/memory/**` |
| Sinks | Discord text sink, speech sink (TTS→playback), avatar sink | Wave 1+, Wave 7 | `src/orchestration/**`, `src/avatar/**` |
| Observability | One `turnId` traced across every stage | Wave 1C | `src/observability/**` |
| Avatar / Live2D | Discord Activity rendering AIRI Live2D; semantic action mapping; lip sync | Wave 6–7 | shared avatar-protocol pkg, Activity, relay, renderer |

---

## 4. Invariants Runtime V2 must hold

1. **One orchestrator.** Voice and text route through the same `TurnOrchestrator`.
   No parallel "text bot brain."
2. **Room-scoped context.** `ConversationRoomId` (not guildId) keys history.
   Two unrelated channels in one guild must not share raw context.
3. **Character is data-driven.** Persona, voice, ASR hotwords, avatar, and output
   protocol come from `Makise Kurisu/card.json` via the `CharacterRegistry`, not
   from hardcoded env or source.
4. **ACT tokens never reach TTS / visible replies / memory / history.** They are
   parsed into `AvatarAction` immediately by the output-protocol parser.
5. **Memory maintenance never blocks audio response.** Response first; memory after.
6. **Avatar failure is nonfatal.** Voice/text continue normally.
7. **Cancellation is turn-scoped.** Barge-in aborts outstanding Gemini, TTS, queued
   speech, and avatar events. An old turn can never resume speaking after a new
   turn begins.
8. **Provider replaceability.** Discord code depends on `BrainProvider` /
   `AsrProvider` / `TtsProvider` interfaces, never on "Gemini"/"Qwen"/"GPT-SoVITS"
   by name.
9. **ASR and TTS stay in separate Python processes** (dependency conflict). Never
   merge their venvs.
10. **Live2D renders locally in a Discord Activity.** Never stream rendered video
    from the bot. The LLM never decides raw Cubism parameters.

---

## 5. The process & deployment boundary (verified)

Per `00-current-state.md` §2, three long-running processes plus one external API:

```
Process 1 — Node.js (tsx)      airi/services/discord-bot   (pnpm start)
Process 2 — Python 3.11        qwen3-asr/.venv             (python -m app.server)   :8765
Process 3 — Python 3.11        GPT-SoVITS/.venv            (python api_v2.py …)      :9880
External                       Google Gemini API           (generateContentStream)
```

- `airi/` and `GPT-SoVITS/` are **orphan gitlinks** (mode `160000`, no
  `.gitmodules`); `qwen3-asr/` is fully tracked in the outer `DC_BOT` repo.
- The discord-bot source lives inside the nested `airi/` clone — its files are
  version-controlled by `airi/.git`, not the outer repo.
- Runtime V2 code is added **inside** `airi/services/discord-bot/src/` (new
  subtrees `character/`, `memory/`, `observability/`, `orchestration/attention/`,
  etc.). Do not relocate the repo during Runtime V2 (Wave 8 evaluates relocation
  only after the runtime is stable).

---

## 6. Bootstrapping & ownership of shared files (Integration-Lead-owned)

Per master plan §42, the following are **Integration-Lead-owned** during
specialist waves; specialists must NOT edit them directly. A specialist that
needs a shared change documents it in its handoff and exposes its own public
interface; the Integration Lead performs the bootstrap wiring:

```
src/index.ts
src/config.ts
src/services.ts
package.json
bots/discord/commands/index.ts   (command registry)
the main controller constructor
startup scripts (start-bot.ps1, etc.)
```

---

## 7. What Wave 1 delivers (the runtime foundation)

Wave 1 lands the **domain contracts** and wires the existing voice path through
the new `TurnOrchestrator` **without** adding text/memory/Live2D yet:

- `src/character/**` — CCv3 `CharacterRegistry` + `CharacterRuntime` +
  `PromptCompiler` + `extensions.dc_bot` migration.
- `src/orchestration/room*` + `turn*` + `events*` — `ConversationRoomId`,
  `InputEvent`, `TurnOutput`, `DeliveryPolicy`, cancellation.
- `src/observability/**` — one `turnId` traced across all stages.
- The existing voice loop continues to work end-to-end
  (`/summon` → voice → ASR → Gemini → TTS → playback → `/leave`).

Acceptance gate (master plan §17): `pnpm typecheck`, `pnpm test`,
`pytest` (ASR), and the voice smoke test all pass.

---

## 8. Wave ordering (execution graph, abridged)

```
Wave 0  Cartography + Baseline (read-only) ──► Frozen contracts (this doc set)
Wave 1  Character/Card · Conversation Domain · Telemetry ──► Wave 1 integration
Wave 2  TTS perf · ASR backend · Brain streaming ──► Attention ──► Performance gate
Wave 3  Discord text mention · Room binding ──► Text/Voice gate
Wave 4  SQLite memory · Memory maintenance ──► Memory controls
Wave 5  Character-aware ASR
Wave 6  Semantic emotion/action protocol (output-protocol parser)
Wave 7  Avatar protocol · Activity shell · Live2D renderer · relay · publisher · lip-sync · motion director
Wave 8  Repository hygiene
```

Each wave has an **integration gate**: the Integration Lead merges, resolves
public-contract changes, runs the full test suite + a smoke test, updates
`04-decisions.md`, records the benchmark delta, and commits before launching
dependent waves. Waves are intentional context-management boundaries — do not
launch all remaining agents just because earlier ones finished.
