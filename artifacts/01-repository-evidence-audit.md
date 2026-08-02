# DC_BOT Current Repository Evidence Audit

**Artifact filename:** `01-repository-evidence-audit.md`  
**Audit role:** Forensic repository auditor  
**Audit date:** 2026-08-01  
**Primary repository:** `starryark/DC_BOT`  
**Inspected branch:** `main`  
**Pinned inspected revision:** short commit SHA `0ea3cbf` (`added reference audio profile`)  
**Method:** Web-accessible GitHub pages and raw GitHub file URLs only. No repository was cloned.

---

## 1. Executive conclusion

**Confirmed repository fact.** The current, default DC_BOT deployment is not a memory microservice architecture. `start-bot.ps1` launches three operating-system processes: a local Qwen ASR service, a local GPT-SoVITS service, and one Node.js Discord bot process. In the default `direct` backend, that single Node process constructs both the text `MentionResponder` and the voice `ConversationController`, sharing the Discord adapter and voice transport but **not** sharing conversation history. Sources: [`start-bot.ps1`, process launch commands](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.ps1#L150-L197); [`src/index.ts`, direct-mode wiring](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L45-L132); [`package.json`, service start script](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json#L16-L20).

**Confirmed repository fact.** Text recent history is owned by `MentionResponder` through an `InMemoryRoomStore`; voice recent history is owned separately by `GuildConversationRegistry`/`GuildSession`. Both are bounded, process-local, and non-durable. There is no active long-term conversational memory database, migration set, durable event log, persisted conversation queue, or shared memory authority in `airi/services/discord-bot`. Sources: [`mention-responder.ts`, private room store](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L49-L61); [`guild-session.ts`, explicit in-memory/no-database contract](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L6-L25); [`package.json`, dependencies](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json#L22-L44).

**Confirmed repository fact.** Discord user IDs are captured on both text and voice input, but the current event model only carries one undifferentiated `displayName` presentation field. There is no current-versus-historical identity record, scoped alias model, alias authorization, actor profile persistence, or verified cross-platform person identity. Voice capture caches a display name when the per-user capture session is created and does not refresh it on subsequent utterances in that session. Sources: [`airi-adapter.ts`, text event snapshot](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L220-L238); [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts); [`voice/types.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/types.ts); [`orchestration/events.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/events.ts).

**Confirmed repository fact.** The current text path mutates history before Discord delivery. `MentionResponder.generateReply()` appends the user and assistant turns and returns a string; only afterward does `DiscordAdapter` call `message.reply()` and possibly additional `channel.send()` operations. A permission change, network failure, process crash, or partial multi-chunk send can therefore leave history claiming that an assistant reply occurred even when no reply, or only part of it, reached Discord. Sources: [`mention-responder.ts`, generation and append path](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L84-L161); [`airi-adapter.ts`, delivery after responder completion](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L239-L270).

**Confirmed repository fact.** The voice path has stronger cancellation and drain handling than text, but its history-commit predicate is still not equivalent to “heard successfully.” Generated chunks are accumulated into `fullReply` before TTS success is known; TTS errors may return `null` and skip audio; playback returns `played`, `cancelled`, `failed`, or `dropped`, but the controller does not use the returned status to remove unheard text or fail the exchange. If the epoch remains current, the controller can commit text that was not synthesized or not played. Sources: [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`tts-pipeline.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/tts-pipeline.ts); [`playback.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts).

**Confirmed repository fact.** Group voice attribution is preserved during capture, ASR, and conversation-floor aggregation, but the orchestration path later collapses a grouped turn into one synthetic actor presentation, `Discord group`, while selecting a single event/user as the current input envelope. The committed voice history then stores one user turn whose speaker is that synthetic label. This loses durable per-speaker causal attribution even though the earlier group object contains attributable utterances. Sources: [`group-turn-builder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/group-turn-builder.ts); [`conversation-floor-coordinator.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-floor-coordinator.ts); [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`guild-session.ts`, one speaker field per committed user turn](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L37-L64).

**Verified topology conclusion.** The evidence does **not** justify making an HTTP memory microservice mandatory in the first implementation milestone. The default text and voice orchestration already coexist inside one Node process. A transport-neutral boundary is justified; a network hop is not yet justified by the inspected deployment. The proportionate next design artifact is an ADR comparing an in-process memory application/domain layer with a later standalone runtime, while preserving a port that does not bind callers to either topology.

**Release-blocking findings for a shared-memory implementation:**

1. Per-speaker group attribution is lost at voice history commitment.
2. Text history is committed before external delivery.
3. Voice history can include generated clauses that failed synthesis or playback.
4. Current actor and room models are too weak to enforce alias privacy and cross-channel isolation.
5. No deletion/export/retention contract exists for future conversational persistence; existing generated-audio cache and optional input WAV dumps already require explicit operational treatment.
6. The test suite does not currently prove delivery recovery, failed-playback history behavior, actor-presentation refresh, restart persistence, deletion completeness, or logical-room authorization.

---

## 2. Scope

### 2.1 Included

This audit maps the current DC_BOT implementation relevant to:

- repository/workspace layout, package scripts, and launch entry points;
- Discord client construction and gateway intents;
- text input filtering for DMs, mentions, replies, guild messages, and threads;
- text room construction and in-memory history ownership;
- ordering of reception, context read, generation, history mutation, Discord send, and failure handling;
- voice receiver identity, voice-channel identity, capture-session lifecycle, and display-name refresh behavior;
- ASR transcript and utterance representations;
- group-turn aggregation and per-speaker attribution;
- generation, cancellation epochs, bounded TTS preparation, playback, interruption, drain completion, and history commitment;
- existing databases, persistence, caches, queues, migrations, and relevant configuration;
- direct versus AIRI backend launch topology;
- tests that constrain refactoring;
- applicable AIRI monorepo conventions;
- narrowly scoped comparison evidence from current AIRI and AstrBot sources.

### 2.2 Excluded

**Non-goal.** This artifact does not choose the final shared-memory schema, database, retrieval algorithm, embedding model, graph store, summarizer, cross-platform identity system, or deployment topology.

**Non-goal.** It does not modify production code.

**Non-goal.** It does not treat planning documents, comments, open issues, or upstream WIP claims as implemented behavior.

**Evidence limitation.** The audit used public web-accessible contents. It did not execute the code, inspect an operator’s `.env`, query a running Discord application, inspect private branches, or validate production logs. Runtime consequences described below are direct control-flow consequences or clearly labeled inferences.

---

## 3. Sources inspected

### 3.1 Revision pins

| Repository | Branch/current revision inspected | Evidence | Notes |
|---|---:|---|---|
| `starryark/DC_BOT` | `main` at short SHA `0ea3cbf` | [Commit page](https://github.com/starryark/DC_BOT/commit/0ea3cbf) | Primary evidence set. Commit title: `added reference audio profile`. GitHub exposed the short SHA in the inspected page; this artifact does not claim a recorded 40-character SHA. |
| `moeru-ai/airi` | current short SHA observed as `4d6e61f` | [Commit page](https://github.com/moeru-ai/airi/commit/4d6e61f) | Used only to distinguish current upstream conventions/WIP from DC_BOT’s pinned fork. |
| `AstrBotDevs/AstrBot` | current short SHA observed as `49095d3` | [Commit page](https://github.com/AstrBotDevs/AstrBot/commit/49095d3) | Used as a limited persisted-conversation comparison, not as a recommended concurrency model. |

### 3.2 Primary DC_BOT sources

| Source | Symbols/behavior inspected |
|---|---|
| [`start-bot.cmd`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.cmd) | Windows wrapper; delegates to `start-bot.ps1`. |
| [`start-bot.ps1`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.ps1) | Validation, readiness checks, process topology, ASR/TTS/bot launch. |
| [`README.md`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/README.md) | Documented deployment, default backend, permissions/intents claims, voice behavior, debug audio. |
| [`airi/services/discord-bot/README.md`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/README.md) | Service setup, privileged-intent and permission claims. |
| [`airi/services/discord-bot/package.json`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json) | Package scripts and dependency surface. |
| [`src/index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts) | Composition root, backend branch, direct-mode orchestrators, shared adapter/voice manager. |
| [`src/config.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/config.ts) | Backend, group-window, input-policy, TTS cache, debug, and history limits. |
| [`src/adapters/airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts) | Discord client, intents, text filters, text event snapshot, direct/AIRI routing, delivery. |
| [`src/orchestration/events.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/events.ts) | Text/voice orchestration event envelopes. |
| [`src/orchestration/mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts) | Text queue, room resolution, context read, generation, cleaning, history append. |
| [`src/orchestration/room-id.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room-id.ts) | DM, text-channel, thread, and voice room ID helpers. |
| [`src/orchestration/room.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room.ts) | `ConversationTurn`, `ConversationRoom`, `InMemoryRoomStore`. |
| [`src/voice/types.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/types.ts) | Voice utterance and capture/session types. |
| [`src/voice/voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts) | Guild voice session, receiver speaker ID, member lookup, capture lifecycle, finalized utterances, teardown. |
| [`src/voice/playback.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts) | Serialized playback owner, result statuses, cancellation, queue bound, drain. |
| [`src/orchestration/conversation-state.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-state.ts) | Per-guild phase, pending turns, epochs, abort controller, guild-session registry. |
| [`src/orchestration/conversation-floor-coordinator.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-floor-coordinator.ts) | Group collection and bounded aggregation policy. |
| [`src/orchestration/group-turn-builder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/group-turn-builder.ts) | Per-speaker grouped prompt construction. |
| [`src/orchestration/conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts) | Voice orchestration from utterance through ASR, generation, TTS, playback, cancellation, commitment. |
| [`src/orchestration/tts-pipeline.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/tts-pipeline.ts) | Bounded synth/play pipeline and callbacks. |
| [`src/providers/tts/tts-cache.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/providers/tts/tts-cache.ts) | Memory/disk generated-audio cache, atomic file writes, metadata, expiration and eviction. |
| [`src/orchestration/mention-responder.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.test.ts) | Text history/isolation/queue/failure constraints. |
| [`src/orchestration/conversation-controller.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.test.ts) | Voice grouping, cancellation, pairing, phase and playback-drain constraints. |
| [`src/voice/playback.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.test.ts) | Playback sequencing, failure status, cancellation, bound and drain. |
| [`src/orchestration/room.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room.test.ts) | Room-store behavior. |
| [`src/orchestration/conversation-floor.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-floor.test.ts) | Group window/limits and attributable utterance aggregation. |
| [`airi/AGENTS.md`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/AGENTS.md) | Monorepo implementation, test, boundary, documentation, and readability rules. |

### 3.3 Comparison sources

| Source | What it establishes | What it does not establish |
|---|---|---|
| [AIRI current repository](https://github.com/moeru-ai/airi) and [current commit](https://github.com/moeru-ai/airi/commit/4d6e61f) | AIRI remains the upstream monorepo and has evolving runtime/memory work and conventions. | It does not prove that DC_BOT currently uses an implemented production memory subsystem. |
| [AIRI issue #879](https://github.com/moeru-ai/airi/issues/879) | Memory Alaya work exists as a tracked proposal/WIP area. | An issue is not executed code and cannot be treated as a production implementation. |
| [`AstrBot` `conversation_mgr.py`](https://github.com/AstrBotDevs/AstrBot/blob/49095d3/astrbot/core/conversation_mgr.py) | AstrBot persists conversation objects through a database abstraction; current code can update whole `content` history and append a user/assistant pair after reading the conversation. | This does not establish safe concurrent append semantics, event provenance, delivery reconciliation, or suitability for DC_BOT. |

---

## 4. Evidence table

Classification vocabulary is exactly: **Confirmed repository fact**, **Source-plan requirement**, **External research finding**, **Inference**, **Recommendation**, or **Open question**.

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| EVID-001 | The audited DC_BOT revision is `main` at short SHA `0ea3cbf`. | Confirmed repository fact | [Commit](https://github.com/starryark/DC_BOT/commit/0ea3cbf) | High |
| EVID-002 | `start-bot.cmd` delegates to `start-bot.ps1`. | Confirmed repository fact | [`start-bot.cmd`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.cmd#L1-L6) | High |
| EVID-003 | `start-bot.ps1` launches ASR, GPT-SoVITS, and the Discord bot as separate processes after bounded readiness checks. | Confirmed repository fact | [`start-bot.ps1`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.ps1#L150-L197) | High |
| EVID-004 | The Node bot starts at `src/index.ts` through `tsx` and loads `.env`, `.config`, and `.env.local`. | Confirmed repository fact | [`package.json`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json#L16-L20) | High |
| EVID-005 | Default/direct mode constructs both `ConversationController` and `MentionResponder` in one Node process. | Confirmed repository fact | [`index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L114-L126) | High |
| EVID-006 | AIRI mode omits those direct-mode orchestrators and logs that work is deferred to a WebSocket server. | Confirmed repository fact | [`index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L114-L126) | High |
| EVID-007 | The Discord client requests `Guilds`, `GuildMessages`, `MessageContent`, `DirectMessages`, and `GuildVoiceStates`; it does not request `GuildMembers`. | Confirmed repository fact | [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L87-L99) | High |
| EVID-008 | The root README’s statement that only Guilds/Voice States are requested and Message Content is unnecessary is stale. | Confirmed repository fact | [Root README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/README.md#L20-L24); [actual client](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L87-L99) | High |
| EVID-009 | The service README asks operators to enable Server Members Intent, but active code does not request `GuildMembers`. | Confirmed repository fact | [Service README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/README.md#L10-L24); [actual client](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L87-L99) | High |
| EVID-010 | Text ignores bots, system messages, and webhooks. | Confirmed repository fact | [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L204-L210) | High |
| EVID-011 | Text accepts every DM, or a guild message that directly mentions the bot, or a reply whose referenced author is the bot. | Confirmed repository fact | [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L211-L226) | High |
| EVID-012 | Ordinary guild messages that neither mention nor reply to the bot are ignored. | Confirmed repository fact | [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L220-L224) | High |
| EVID-013 | Thread status is passed into `MentionResponder` and is used to construct a thread-specific room ID. | Confirmed repository fact | [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L252-L258); [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts); [`room-id.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room-id.ts) | High |
| EVID-014 | Text room IDs distinguish `dm:<user>`, guild text channels, and guild threads. | Confirmed repository fact | [`room-id.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room-id.ts); [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L84-L113) | High |
| EVID-015 | `MentionResponder` owns a private `InMemoryRoomStore`, per-room promise queues, and pending counts. | Confirmed repository fact | [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L49-L78) | High |
| EVID-016 | Same-room text requests are serialized; different rooms may progress independently; pending depth is bounded. | Confirmed repository fact | [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L63-L82); [tests](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.test.ts) | High |
| EVID-017 | Text reads context before LLM generation and appends a paired user/assistant exchange after successful generation. | Confirmed repository fact | [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L84-L161) | High |
| EVID-018 | Discord text delivery occurs after the responder has already mutated its in-memory history. | Confirmed repository fact | [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L114-L161); [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L239-L270) | High |
| EVID-019 | Text event identity includes `userId` and one `displayName`, but not distinct username/global display/guild nickname/avatar/alias fields. | Confirmed repository fact | [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L227-L238); [`events.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/events.ts) | High |
| EVID-020 | The voice receiver supplies a Discord user ID; the manager resolves a `GuildMember` from the current channel or guild and uses `member.displayName`. | Confirmed repository fact | [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts) | High |
| EVID-021 | Voice capture sessions are keyed by guild/user and retain the display name assigned at creation; existing captures are not refreshed on each speaking start. | Confirmed repository fact | [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts) | High |
| EVID-022 | Finalized voice utterances remain individually attributable by Discord `userId` and `displayName`. | Confirmed repository fact | [`voice/types.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/types.ts); [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts) | High |
| EVID-023 | Conversation-floor/group-building code retains a bounded list of attributable utterances and speaker labels. | Confirmed repository fact | [`conversation-floor-coordinator.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-floor-coordinator.ts); [`group-turn-builder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/group-turn-builder.ts) | High |
| EVID-024 | The grouped voice turn is later represented as a synthetic `Discord group` speaker for generation/history, losing first-class per-speaker commitment. | Confirmed repository fact | [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L37-L64) | High |
| EVID-025 | Voice history is one bounded in-memory session per guild and is explicitly not persisted to a database. | Confirmed repository fact | [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L6-L35) | High |
| EVID-026 | Voice room projection calls `voiceRoom(guildId, guildId)`, not `voiceRoom(guildId, actualVoiceChannelId)`. | Confirmed repository fact | [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L72-L80) | High |
| EVID-027 | The voice manager supports one active voice session per guild, with the actual joined channel stored in transport session state. | Confirmed repository fact | [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts); [`voice/types.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/types.ts) | High |
| EVID-028 | Voice cancellation increments an epoch, aborts active generation, cancels/stops playback, and prevents superseded epochs from mutating history. | Confirmed repository fact | [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`conversation-state.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-state.ts) | High |
| EVID-029 | Playback is serialized and returns explicit `played`, `cancelled`, `failed`, or `dropped` results; queue size is bounded. | Confirmed repository fact | [`playback.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts); [playback tests](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.test.ts) | High |
| EVID-030 | `ConversationController` awaits playback calls/drain but does not make history commitment contingent on every playback result being `played`. | Confirmed repository fact | [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`playback.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts) | High |
| EVID-031 | TTS errors can be caught and represented as a skipped/null synthesized clause, while generated text has already entered `fullReply`. | Confirmed repository fact | [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`tts-pipeline.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/tts-pipeline.ts) | High |
| EVID-032 | Current voice commitment may therefore include text the listener did not hear. | Inference | Control flow in [controller](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts), [TTS pipeline](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/tts-pipeline.ts), and [playback](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts) | High |
| EVID-033 | The only active disk persistence found in the bot service is generated TTS cache data and optional debug input WAV dumps, not conversation memory. | Confirmed repository fact | [`tts-cache.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/providers/tts/tts-cache.ts); [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts); [README debug setting](https://github.com/starryark/DC_BOT/blob/0ea3cbf/README.md#L303-L321) | High |
| EVID-034 | The active package dependency list does not include a database driver or ORM. | Confirmed repository fact | [`package.json`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json#L22-L44) | High |
| EVID-035 | AIRI mode still constructs a `VoiceManager`, but no local `ConversationController` subscribes to it. | Confirmed repository fact | [`index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L57-L66); [`index.ts`, backend branch](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L114-L126) | High |
| EVID-036 | In the inspected AIRI-mode wiring, locally captured voice utterances appear to have no active orchestration consumer. | Inference | [Composition root](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts); [adapter events](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts) | Medium-high |
| EVID-037 | Existing text tests cover isolation, serialization, generation failure, output cleanup/bounds, and process-local continuity, but not Discord send failure after commitment. | Confirmed repository fact | [`mention-responder.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.test.ts) | High |
| EVID-038 | Existing voice tests cover cancellation, grouping, paired commitment, rate-limit/fault recovery, and playback drain, but do not prove that `failed`/`dropped` playback excludes unheard text from history. | Confirmed repository fact | [`conversation-controller.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.test.ts); [`playback.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.test.ts) | High |
| EVID-039 | AIRI’s checked-in `AGENTS.md` requires stable domain boundaries, lean entry points, public-contract documentation, Vitest, explicit lifecycle/state semantics, and regression tests. | Confirmed repository fact | [`airi/AGENTS.md`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/AGENTS.md#L198-L241); [readability checklist](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/AGENTS.md#L291-L303) | High |
| EVID-040 | AIRI Memory Alaya evidence found in current upstream includes proposal/WIP material and must not be represented as a complete production implementation. | External research finding | [AIRI issue #879](https://github.com/moeru-ai/airi/issues/879); [AIRI repository](https://github.com/moeru-ai/airi) | Medium-high |
| EVID-041 | AstrBot currently uses a database abstraction for conversations and can replace a conversation’s whole content list or read-append-write a pair. | External research finding | [`conversation_mgr.py`](https://github.com/AstrBotDevs/AstrBot/blob/49095d3/astrbot/core/conversation_mgr.py#L256-L282); [pair append](https://github.com/AstrBotDevs/AstrBot/blob/49095d3/astrbot/core/conversation_mgr.py#L327-L358) | High |
| EVID-042 | AstrBot’s mutable whole-history operation is a product baseline, not proof of conflict-safe append semantics for DC_BOT. | Inference | [`conversation_mgr.py`](https://github.com/AstrBotDevs/AstrBot/blob/49095d3/astrbot/core/conversation_mgr.py#L327-L358) | High |
| EVID-043 | A mandatory memory HTTP service is not supported by current topology evidence. | Recommendation | EVID-003, EVID-005, EVID-006 | High |
| EVID-044 | A transport-neutral memory port remains justified so in-process and later standalone deployments can share contracts. | Source-plan requirement | User-supplied source-plan baseline | High |

---

## 5. Current-state findings

## 5.1 Repository and workspace structure

**Confirmed repository fact.** DC_BOT is a composite repository rather than a small standalone bot package. The inspected launch scripts refer to:

- `airi/services/discord-bot` — the active TypeScript Discord bot;
- `qwen3-asr` — the local ASR service;
- `GPT-SoVITS` — the local TTS service;
- local Kurisu model/reference assets and setup scripts.

Source: [`start-bot.ps1`, resolved directories](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.ps1#L13-L24).

**Confirmed repository fact.** The active Discord package is `@proj-airi/discord-bot`; it is an ES module, started by `tsx`, tested by Vitest, and typechecked by `tsc --noEmit`. Source: [`package.json`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json#L1-L20).

**Confirmed repository fact.** The package depends on AIRI workspace packages (`server-sdk`, `server-shared`, audio/protocol packages), Discord libraries, Gemini/xsAI packages, and voice/audio tooling. No database client or ORM is listed in the service manifest. Source: [`package.json`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json#L22-L44).

**Inference.** The absence of a database dependency does not mathematically prove that no indirect workspace package could persist data. It does, however, align with the inspected live history classes’ explicit in-memory contracts and the absence of any database wiring in `index.ts`.

## 5.2 Launch and deployment entry points

### 5.2.1 Windows wrapper

**Confirmed repository fact.** `start-bot.cmd` is only a wrapper that runs `start-bot.ps1` under PowerShell with execution-policy bypass and propagates its exit code. Source: [`start-bot.cmd`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.cmd#L1-L6).

### 5.2.2 PowerShell launcher

**Confirmed repository fact.** The launcher:

1. validates `.env`, `DISCORD_TOKEN`, and `GEMINI_API_KEY`;
2. validates ASR and TTS Python/runtime prerequisites;
3. prepares model/runtime environment variables;
4. starts or reuses ASR on port 8765;
5. starts or reuses GPT-SoVITS on port 9880;
6. waits for bounded readiness;
7. starts `pnpm.cmd start` in `airi/services/discord-bot`.

Sources: [`start-bot.ps1`, validation](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.ps1#L83-L146); [`start-bot.ps1`, commands and process launch](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.ps1#L150-L197).

### 5.2.3 Node composition root

**Confirmed repository fact.** `src/index.ts` constructs one `DiscordAdapter`, obtains the adapter-owned `VoiceManager`, constructs ASR/brain/TTS providers, and then branches on backend:

- `direct`: creates a `ConversationController` and installs a `MentionResponder`;
- non-direct/AIRI: does not create either local orchestrator and logs WebSocket deferral.

Source: [`src/index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L45-L132).

**Confirmed repository fact.** Shutdown calls `adapter.stop()`, which destroys the Discord client and closes the AIRI client. Voice session teardown is expected to flow from Discord/voice transport lifecycle rather than an explicitly retained controller instance in `index.ts`. Sources: [`index.ts`, shutdown](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L133-L145); [`airi-adapter.ts`, stop](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L323-L350).

## 5.3 Discord client and gateway intents

**Confirmed repository fact.** The Discord client requests:

- `Guilds`;
- `GuildMessages`;
- `MessageContent`;
- `DirectMessages`;
- `GuildVoiceStates`;
- channel partials.

It does not request `GuildMembers`. Source: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L87-L99).

**Confirmed repository fact.** Documentation is internally inconsistent:

- root README says the implemented bot requests only Guilds and Guild Voice States and does not require Message Content;
- service README tells operators to enable Server Members and Message Content;
- code requests Message Content but not GuildMembers.

Sources: [root README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/README.md#L20-L24); [service README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/README.md#L10-L24); [client code](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L87-L99).

**Inference.** Comprehensive current-member/presentation synchronization cannot be assumed from the present intent set. The existing voice path may fetch a member explicitly, but no repository evidence was found for a complete member-update ingestion policy or durable alias/profile synchronization.

## 5.4 Text event filtering

### DMs

**Confirmed repository fact.** Every non-bot, non-system, non-webhook DM reaches the text handler because `isDirectMessage` bypasses mention/reply requirements. Source: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L204-L224).

### Mentions

**Confirmed repository fact.** In guild channels, a direct user mention of the bot is accepted. The bot mention token is removed from the user-visible input before generation. Source: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L220-L238).

### Replies

**Confirmed repository fact.** A message is accepted if its fetched reference was authored by the bot. Failed reference fetch does not discard the input; it simply prevents the reply-to-bot predicate and quoted context from being established. Source: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L211-L224).

### Ordinary guild messages

**Confirmed repository fact.** Ordinary guild messages that do not directly mention the bot and do not reply to the bot are ignored. Source: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L220-L224).

### Threads

**Confirmed repository fact.** Threads are not filtered out. `message.channel.isThread()` is passed to `MentionResponder`, which chooses a thread-specific room ID. The service README also lists `Send Messages in Threads` as required for thread replies. Sources: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L252-L264); [`room-id.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room-id.ts); [service README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/README.md#L17-L19).

## 5.5 Text room identity

**Confirmed repository fact.** Current text room construction is deterministic and physical-channel-oriented:

```text
DM                 -> dm:<discord-user-id>
Guild text channel -> guild:<guild-id>:text:<channel-id>
Guild thread       -> guild:<guild-id>:thread:<thread-channel-id>
```

Sources: [`room-id.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room-id.ts); [`mention-responder.ts`, room resolution](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L84-L113).

**Confirmed repository fact.** No logical-room binding layer was found. Separate physical channels/threads do not share recent context unless they resolve to the same hard-coded ID shape; no configured binding map or authorization-aware room graph exists.

**Inference.** `dm:<userId>` is a private-conversation scope for one Discord user, not a verified cross-platform person scope.

## 5.6 Text history ownership, reads, writes, and lifecycle

**Confirmed repository fact.** `MentionResponder` owns:

- `private readonly rooms = new InMemoryRoomStore()`;
- a map of per-room promise tails;
- a map of pending counts;
- generation timeout and output limits.

Source: [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L12-L19), [`MentionResponder` state](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L49-L78).

**Confirmed repository fact.** The store is bounded and process-local. It is recreated when the Node process restarts and is unrelated to voice state. Sources: [`room.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/room.ts); [`index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L114-L122).

### Text operation ordering

```text
Discord MessageCreate
  -> adapter filter / actor snapshot / reply fetch
  -> MentionResponder.respond()
  -> resolve physical text room ID
  -> wait for prior same-room request
  -> read InMemoryRoomStore recent context
  -> compile prompt
  -> call brain / collect generated response
  -> strip ACT/DELAY protocol from visible text
  -> append user turn + assistant turn to InMemoryRoomStore
  -> return response string to adapter
  -> adapter splits response
  -> Discord message.reply(first chunk)
  -> Discord channel.send(remaining chunks)
```

Sources: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L204-L298); [`mention-responder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts).

**Defect consequence.** The history write precedes every Discord send. Multi-chunk delivery can be partially successful. There is no delivery record, attempt ID, chunk receipt, retry state, or reconciliation job.

## 5.7 Text prompt safety already present

**Confirmed repository fact.** The direct text responder instructs the model that quoted/replied-to message content is untrusted, bounds quoted text, and disallows intentional mentions; Discord delivery also sets `allowedMentions` to parse none. Sources: [`mention-responder.ts`, Discord delivery instruction](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L20-L26); [`airi-adapter.ts`, allowed mentions and delivery](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L51-L76), [`delivery`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L260-L264).

**Source-plan requirement.** Retrieved durable memory will need stronger structured serialization and internal-ID protection than this current quoted-message safeguard alone.

## 5.8 Voice receiver identity and channel identity

**Confirmed repository fact.** Discord voice receiver events identify the speaker by Discord user ID. On speaking start, `VoiceManager` resolves a guild member from the joined channel’s member map or via guild fetch, ignores bots, derives `member.displayName`, and ensures a per-user capture session. Source: [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts).

**Confirmed repository fact.** The transport session contains the actual joined `channelId`; one active voice session is held per guild. Source: [`voice/types.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/types.ts); [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts).

**Confirmed repository fact.** The conversational voice history does not use that actual channel ID. `GuildSession.asRoom()` calls `voiceRoom(this.guildId, this.guildId)`. Source: [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L72-L80).

**Consequence.** Transport knows the physical voice channel, but the current history projection represents voice scope as guild-scoped and fabricates the channel component from the guild ID. This blocks reliable physical-room attribution and any future logical-room binding audit unless corrected.

## 5.9 Voice capture-session creation and refresh

**Confirmed repository fact.** Capture sessions are created per guild/user and include the user ID, display name, decoder/PCM buffers, and timing state. Source: [`voice/types.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/types.ts); [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts).

**Confirmed repository fact.** When `ensureCapture` finds an existing capture for that guild/user, the inspected implementation reuses it rather than assigning the newly observed display name. Source: [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts).

**Observable consequence.** A guild nickname or other display-name change during an active joined session can leave later finalized utterances stamped with the stale presentation value from capture creation.

**Important distinction.** This is not evidence that the durable Discord identity changes; the durable platform identity remains the Discord user ID. It is evidence that event-time presentation snapshots are not refreshed reliably.

## 5.10 ASR transcript and utterance types

**Confirmed repository fact.** `VoiceUtterance` is one finalized attributable audio event, including guild/channel/user identity, display name, PCM/audio data, and timing. Source: [`voice/types.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/types.ts).

**Confirmed repository fact.** The controller converts audio and invokes the ASR provider, then creates a voice input event carrying the attributable speaker identity and transcript for filtering/grouping. Sources: [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`events.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/events.ts).

**Confirmed repository fact.** Current orchestration envelopes do not model a full Discord actor snapshot. They flatten presentation to a `displayName` instead of preserving username, global display name, guild nickname, avatar, or observed voice attributes as separately named fields. Source: [`events.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/events.ts).

## 5.11 Group-turn aggregation and speaker attribution

**Confirmed repository fact.** Conversation-floor grouping is bounded by configured timing/speaker/utterance limits and retains individual attributable messages. The group-turn builder serializes distinct speaker names into a prompt rather than mixing PCM into one anonymous waveform. Sources: [`config.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/config.ts); [`conversation-floor-coordinator.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-floor-coordinator.ts); [`group-turn-builder.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/group-turn-builder.ts).

**Confirmed repository fact.** The controller subsequently reduces the group to a single current event envelope and assigns `displayName: 'Discord group'` for generation/commit. Source: [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts).

**Confirmed repository fact.** `GuildSession.commitExchange()` can store only one speaker string on one user turn for each assistant exchange. Source: [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L37-L64).

**Conclusion.** The source-plan diagnosis is correct: a one-user-turn exchange shape conflicts with multi-speaker causality. Current transient attribution is better than the committed history model, but it is not durable.

## 5.12 Voice generation, cancellation, TTS, playback, and commitment

### Generation and state

**Confirmed repository fact.** `ConversationController` owns policy from admission through ASR, filtering, generation, chunking, TTS, and playback. It uses a per-guild registry/state with response epochs and abort controllers. Source: [`conversation-controller.ts`, class contract](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts#L39-L77); [`conversation-state.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-state.ts).

### Cancellation

**Confirmed repository fact.** Cancellation increments the response epoch, aborts active work, cancels the scheduler epoch, and stops playback. Disconnect/session end transitions state, cancels work, and removes the guild state. Sources: [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`playback.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts).

**Confirmed repository fact.** Existing controller tests require cancelled or disconnected turns not to commit history. Source: [`conversation-controller.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.test.ts).

### TTS preparation

**Confirmed repository fact.** The bounded TTS pipeline invokes a chunk callback, synthesizes, skips a chunk when synthesis produces no stream, and otherwise awaits playback. Source: [`tts-pipeline.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/tts-pipeline.ts).

**Confirmed repository fact.** The controller adds generated chunk text to `fullReply` before synthesis/playback success is established. TTS errors are caught and can cause a clause to be skipped. Source: [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts).

### Playback

**Confirmed repository fact.** `GuildPlaybackScheduler` owns serialized playback and returns an explicit result status. It has a bounded queue, cancellation by epoch, `stopAll`, and drain completion. Source: [`playback.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts).

**Confirmed repository fact.** `VoiceManager.playAudioStream()` returns that playback result. Source: [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts).

**Confirmed repository fact.** The controller awaits the call but does not enforce `result.status === 'played'` as a precondition for adding the text to committed conversational history. Source: [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts).

### History commitment

**Confirmed repository fact.** After the TTS pipeline and playback drain, the controller commits a paired user/assistant exchange if the epoch remains current and the accumulated reply is nonblank. Source: [`conversation-controller.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts); [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L37-L64).

**Inference.** Three audible-state mismatches follow directly:

1. A generated clause whose TTS failed may remain in `fullReply` and be committed.
2. A playback result of `failed` or `dropped` may be ignored for history purposes.
3. If all generated clauses are accumulated but all synthesis operations return no playable audio, a nonblank assistant reply may still be committed after an empty drain.

No durable generation record, delivery attempt, audio-segment receipt, or recovery state exists to repair these mismatches after a crash.

## 5.13 Current persistence, queues, caches, and migrations

### Conversation persistence

**Confirmed repository fact.** None exists in the active direct-mode conversation path. Text and voice histories are in-memory objects.

### Queues

**Confirmed repository fact.** Current queues are process-local runtime controls:

- text: per-room promise chains and pending counts;
- voice: pending-turn policy in per-guild state;
- TTS: bounded in-process concurrency pipeline;
- playback: bounded in-process scheduler queue.

They are not durable jobs and do not survive restart.

### Cache

**Confirmed repository fact.** `CachedTtsProvider` maintains generated speech cache entries in memory and on disk, with versioned identity, metadata, atomic write/rename behavior, expiration, and eviction. Sources: [`index.ts`, cache construction](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L74-L107); [`tts-cache.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/providers/tts/tts-cache.ts).

**Confirmed repository fact.** Optional debug input WAV dumping can write finalized user audio under a `dumps` directory when enabled. Sources: [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts); [README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/README.md#L303-L321).

### Migrations

**Confirmed repository fact.** No conversation-memory migrations were found in the active service evidence set.

## 5.14 Direct and AIRI backend topology

### Direct mode

```text
Process A: Qwen ASR HTTP service
Process B: GPT-SoVITS HTTP service
Process C: Node Discord bot
  ├─ DiscordAdapter / discord.js Client
  ├─ VoiceManager + playback schedulers
  ├─ MentionResponder + text InMemoryRoomStore
  ├─ ConversationController + per-guild GuildSession history
  ├─ Gemini brain provider
  └─ Cached TTS provider
```

**Confirmed repository fact.** This is the default documented and configured deployment path. Sources: [root README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/README.md#L1-L11); [`start-bot.ps1`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/start-bot.ps1#L150-L197); [`index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L114-L126).

### AIRI mode

```text
Node Discord bot
  ├─ DiscordAdapter / discord.js Client
  ├─ AIRI ServerChannel WebSocket client
  ├─ VoiceManager is still created
  ├─ no local MentionResponder
  └─ no local ConversationController

External AIRI server
  └─ expected to produce routed text output
```

**Confirmed repository fact.** Text input is sent to the AIRI server when no local mention responder is installed, and AIRI output can be routed back to Discord text channels. Source: [`airi-adapter.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L174-L196), [`text routing`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L271-L289).

**Inference.** No inspected code connected local `VoiceManager` utterance events to AIRI in this branch when `ConversationController` is absent. AIRI-mode voice support is therefore unverified and appears incomplete in the inspected composition.

## 5.15 Tests that constrain refactoring

### Text constraints

Existing `MentionResponder` tests establish behaviors that a replacement must preserve or deliberately supersede through an ADR:

- same physical room receives continuity;
- guild channels, threads, and DMs are isolated;
- same-room requests are serialized;
- different rooms are not globally serialized;
- queue depth is bounded;
- generation failure does not append an unmatched turn;
- ACT/DELAY output protocol is removed from visible/history text;
- quoted replied-to text is bounded and treated as untrusted;
- generated response length is bounded.

Source: [`mention-responder.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.test.ts).

### Voice constraints

Existing controller/floor/playback tests establish:

- group windows preserve multiple speaker entries for prompting;
- half-duplex/latest-wins/barge-in admission policies have explicit behavior;
- paired history commits occur after successful normal turns;
- cancelled/disconnected/rate-limited paths do not append normal completed history;
- phase completion waits for playback drain;
- scheduler playback is serialized;
- cancellation epochs settle pending playback;
- failed resources return failure status;
- queue size is bounded and can drop work.

Sources: [`conversation-controller.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.test.ts); [`conversation-floor.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-floor.test.ts); [`playback.test.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.test.ts).

### Material test gaps

No inspected test proves:

- history behavior after `message.reply()` failure;
- partial multi-chunk Discord delivery reconciliation;
- voice history exclusion for `failed` or `dropped` playback;
- voice history exclusion for skipped/null TTS clauses;
- display-name refresh after a mid-session nickname change;
- stable actor identity when two people use the same display name;
- actual voice channel ID in room identity;
- process-restart continuity;
- deletion/export/retention completeness;
- authorization between physical and logical rooms;
- non-leakage of a private alias into a guild prompt;
- AIRI-mode voice operation.

## 5.16 AIRI conventions DC_BOT must follow

**Confirmed repository fact.** The checked-in `airi/AGENTS.md` requires, among other things:

- avoiding one-off patterns;
- searching for reusable internal implementations before creating new utilities;
- keeping domain contracts in the owning package and entry points focused on wiring;
- documenting public architectural boundaries and lifecycle/side effects;
- using Vitest for implemented TypeScript behavior;
- making persisted/runtime/cache/session/external state visibly distinct;
- making IDs, correlation keys, freshness semantics, cleanup, and disposal explicit;
- adding regression tests that reproduce the root cause rather than smoke-only tests.

Sources: [`airi/AGENTS.md`, workflow and TypeScript rules](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/AGENTS.md#L198-L241); [`airi/AGENTS.md`, test and readability rules](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/AGENTS.md#L275-L303).

**Recommendation.** A later MemoryPort should be a stable domain/application boundary with lifecycle and error semantics, not a thin wrapper introduced solely for tests. The composition root should wire it; text and voice orchestrators should depend on the contract.

## 5.17 Upstream AIRI and AstrBot comparison findings

### AIRI

**External research finding.** Current upstream AIRI has ongoing memory work, including Memory Alaya issue/proposal material. That evidence must be labeled WIP/proposal unless exact production code and integration are separately verified. Source: [AIRI issue #879](https://github.com/moeru-ai/airi/issues/879).

**Conclusion.** Critical risk K is valid: DC_BOT must not claim an upstream production memory implementation merely because an issue, package skeleton, or documentation section exists.

### AstrBot

**External research finding.** Current AstrBot has a `ConversationManager` backed by a `BaseDatabase`; conversation content is stored as a list/JSON-compatible value. It exposes whole-history update and `add_message_pair`, which reads a conversation, appends two messages to the in-memory list, and writes the list back. Source: [`conversation_mgr.py`](https://github.com/AstrBotDevs/AstrBot/blob/49095d3/astrbot/core/conversation_mgr.py#L256-L282), [`add_message_pair`](https://github.com/AstrBotDevs/AstrBot/blob/49095d3/astrbot/core/conversation_mgr.py#L327-L358).

**Inference.** Without further database-layer transaction/version evidence, that read-append-write pattern should not be cited as proof of conflict-safe concurrent appends. Critical risk L is valid. AstrBot is useful evidence that persisted conversations, deletion callbacks, filtering, and product-facing conversation management are practical; it is not an automatic schema or write-concurrency template for DC_BOT.

---

## 6. Source map of relevant files and symbols

| Layer | File | Relevant symbols | Current responsibility |
|---|---|---|---|
| Launch | `start-bot.cmd` | command wrapper | Invokes PowerShell launcher. |
| Launch | `start-bot.ps1` | `Wait-AsrReady`, `Wait-GptSoVitsReady`, process commands | Starts/reuses ASR and TTS; launches bot after readiness. |
| Package | `airi/services/discord-bot/package.json` | `start`, `test`, `typecheck`, dependencies | Service entry script and tool/dependency inventory. |
| Composition | `src/index.ts` | `main`, `loadCharacter`, direct/AIRI branch | Constructs adapter/providers; installs direct text/voice orchestrators. |
| Configuration | `src/config.ts` | `config()` and nested settings | Input policy, backend, history bounds, group limits, TTS cache/debug. |
| Discord adapter | `src/adapters/airi-adapter.ts` | `DiscordAdapter`, `setupEventHandlers`, `chunkDiscordText` | Owns discord.js client, gateway event ingress, text output, AIRI channel. |
| Text events | `src/orchestration/events.ts` | `DiscordMentionInputEvent`, `VoiceInputEvent` | Flattened orchestration input envelopes. |
| Text orchestration | `src/orchestration/mention-responder.ts` | `MentionResponder`, `respond`, `generateReply`, room resolution | Text queue, context read, generation, cleaning, history append. |
| Room identity | `src/orchestration/room-id.ts` | `textRoom`, `threadRoom`, `voiceRoom` | String construction for physical room IDs. |
| Room history | `src/orchestration/room.ts` | `ConversationTurn`, `ConversationRoom`, `InMemoryRoomStore` | Generic bounded process-local room history. |
| Voice transport types | `src/voice/types.ts` | `VoiceUtterance`, `UserCaptureSession`, guild session types | Attributable captured audio and transport session state. |
| Voice transport | `src/voice/voice-manager.ts` | `VoiceManager`, join/leave, capture, finalize, playback bridge, teardown | Discord voice receive/capture/playback lifecycle. |
| Voice playback | `src/voice/playback.ts` | `GuildPlaybackScheduler`, `PlaybackResult` | Sole serialized playback owner, cancellation, queue, drain. |
| Voice state | `src/orchestration/conversation-state.ts` | `GuildConversationRegistry`, guild state, admission/cooldown helpers | Per-guild conversational phase, pending input, epoch, abort, session history. |
| Voice history | `src/orchestration/guild-session.ts` | `GuildSession`, `commitExchange`, `asRoom`, `getContents` | Bounded guild-level voice recent history. |
| Group floor | `src/orchestration/conversation-floor-coordinator.ts` | `ConversationFloorCoordinator` | Time-bounded aggregation of attributable transcripts. |
| Group serialization | `src/orchestration/group-turn-builder.ts` | group prompt builder | Converts attributable group messages to model prompt text. |
| Voice orchestration | `src/orchestration/conversation-controller.ts` | `ConversationController`, utterance/group handlers, `generateAndSpeak`, cancellation | Admission → ASR → model → TTS → playback → history commitment. |
| TTS orchestration | `src/orchestration/tts-pipeline.ts` | `runBoundedTtsPipeline` | Bounded synth/play pipeline. |
| TTS provider/cache | `src/providers/tts/tts-cache.ts` | `CachedTtsProvider` | Memory/disk generated-audio cache. |
| Text tests | `src/orchestration/mention-responder.test.ts` | responder test suites | Existing text isolation, queue, generation, safety constraints. |
| Voice tests | `src/orchestration/conversation-controller.test.ts` | controller test suites | Existing voice policy, grouping, cancellation, pairing constraints. |
| Playback tests | `src/voice/playback.test.ts` | scheduler test suites | Playback ordering/failure/cancellation/bound constraints. |
| Repo instructions | `airi/AGENTS.md` | workflow, TypeScript, tests, readability rules | Required implementation conventions for downstream work. |

---

## 7. Call graphs

## 7.1 Direct text call graph

```text
Discord gateway: Events.MessageCreate
  -> DiscordAdapter.setupEventHandlers()
     -> discard bot/system/webhook
     -> best-effort fetchReference()
     -> accept DM OR direct mention OR reply-to-bot
     -> construct DiscordMentionInputEvent
        [eventId, turnId, guildId, channelId, userId, displayName,
         timestamp, messageId, text]
     -> MentionResponder.respond(request)
        -> resolveRoomId()
           -> dm:<userId>
           -> guild:<guildId>:thread:<channelId>
           -> guild:<guildId>:text:<channelId>
        -> serialize on roomQueues[roomId]
        -> InMemoryRoomStore.get(roomId)
        -> prompt compiler / fallback prompt
        -> BrainProvider.generate(...)
        -> collect bounded response
        -> parse/strip ACT and DELAY protocol
        -> InMemoryRoomStore.append(user turn)
        -> InMemoryRoomStore.append(assistant turn)
        -> return response text
     -> chunkDiscordText(response)
     -> message.reply(first chunk)
     -> message.channel.send(remaining chunks)
```

**Commit boundary:** before external Discord delivery.  
**Durability:** none.  
**Recovery:** none beyond logging/catch.  
**Ordering:** same physical room serialized in memory; cross-room requests can overlap.

## 7.2 AIRI-routed text call graph

```text
Discord gateway: Events.MessageCreate
  -> DiscordAdapter filter / event snapshot
  -> no local MentionResponder
  -> ServerChannel.send(input:text, Discord metadata)
  -> external AIRI server/runtime [not mapped in this DC_BOT process]
  -> ServerChannel output:gen-ai:chat:message
  -> fetch Discord channel
  -> chunkDiscordText()
  -> channel.send(each chunk)
```

**Open question.** The external runtime’s persistence and delivery semantics were not established by DC_BOT code and must be audited separately before claiming shared memory in AIRI mode.

## 7.3 Direct voice call graph

```text
Discord slash command /summon
  -> DiscordAdapter InteractionCreate
  -> VoiceManager.handleJoinChannelCommand()
  -> VoiceManager creates one guild voice transport session
     [actual guildId + actual voice channelId]
  -> Discord receiver speaking start(userId)
     -> resolve GuildMember
     -> derive displayName
     -> ensureCapture(guildId, userId, displayName)
     -> decode/accumulate per-user audio
  -> endpoint/finalize capture
  -> emit VoiceUtterance
     [guildId, channelId, userId, displayName, audio, times]
  -> ConversationController utterance handler
     -> admission policy / epoch
     -> convert audio
     -> AsrProvider.transcribe()
     -> transcript filter / dedupe / language understanding
     -> VoiceInputEvent with attributable user
     -> ConversationFloorCoordinator.add()
     -> group closes by window/limits
     -> group-turn builder retains per-speaker prompt entries
     -> controller creates one synthetic current input
        [displayName = "Discord group" for grouped turn]
     -> GuildSession context read
     -> BrainProvider generation
     -> style/chunk parsing
     -> onChunk: append generated text to fullReply
     -> TtsProvider.synthesize()
        -> may produce no stream on handled failure
     -> VoiceManager.playAudioStream()
        -> GuildPlaybackScheduler.enqueue()
        -> result: played | cancelled | failed | dropped
     -> await playback drain for epoch
     -> if epoch still current and fullReply nonblank:
        GuildSession.commitExchange(one user speaker, one assistant text)
```

**Commit boundary:** after pipeline/drain and epoch validation, but not after proof that all committed text was successfully heard.  
**Durability:** none.  
**Cancellation:** epoch + abort + scheduler cancellation/stop.  
**Attribution loss point:** grouped input projection before generation/commit.

---

## 8. Ownership matrix

| Concern | Current owner | Scope/key | Persistence | Important limitations |
|---|---|---|---|---|
| Text recent history | `MentionResponder` → `InMemoryRoomStore` | DM user, guild text channel, or guild thread | Process memory only | Separate from voice; write precedes Discord send; no provenance/delivery state. |
| Voice recent history | `GuildConversationRegistry` / `GuildSession` | Guild | Process memory only | Synthetic grouped speaker; no actual voice channel in projected room ID; deleted on session end/restart. |
| Text room identity | `MentionResponder.resolveRoomId` + `room-id.ts` | Physical Discord DM/channel/thread | Deterministic string only | No logical-room binding. |
| Voice room identity | `GuildSession.asRoom` + `voiceRoom` | Fabricated guild/guild voice room | Deterministic string only | Does not use actual joined voice channel ID. |
| Text actor identity | `DiscordAdapter` | Discord author ID plus one display name | Event object only | No complete actor snapshot/current profile/alias scopes. |
| Voice actor identity | `VoiceManager` | Discord receiver user ID plus cached member display name | Capture/utterance object only | Display name may become stale; no durable profile. |
| Group speaker attribution | `ConversationFloorCoordinator` and group builder, then `ConversationController` | Per grouped window | Transient only | Preserved transiently, collapsed at commitment. |
| Text cancellation | `MentionResponder` timeout and queue settlement | Per request/room | Runtime only | No Discord-delivery cancellation or delivery state. |
| Voice cancellation | `ConversationController` + state registry + playback scheduler | Per guild/response epoch | Runtime only | Strong epoch protection; no durable recovery across crash. |
| Playback | `GuildPlaybackScheduler`, reached via `VoiceManager` | Per guild voice session | Runtime only | Result status not fully reflected in committed history. |
| Text delivery | `DiscordAdapter` | Discord message/channel | External side effect | Occurs after history append; partial chunks possible. |
| Voice delivery | `VoiceManager`/scheduler/audio player | Discord voice connection | External side effect | Cannot be atomic with memory; no segment-level durable receipt. |
| TTS generated-audio cache | `CachedTtsProvider` | Cache identity hash | Memory + disk | Retains generated audio/metadata; needs retention/deletion policy. |
| Raw input audio dump | `VoiceManager` debug path | Guild/user/time filename | Disk when enabled | User voice retention; operator-controlled but no broader privacy lifecycle found. |
| Long-term memory | None in active service | N/A | None | No facts, summaries, embeddings, episodic/procedural memory, or deletion/export API. |
| AIRI WebSocket transport | `DiscordAdapter` `ServerChannel` | Process connection | External runtime unknown | Text output route exists; voice consumer unverified. |

---

## 9. Defect table

Severity scale: **Critical** = attribution/privacy/delivery correctness can be materially false in normal supported behavior; **High** = release-blocking for shared memory; **Medium** = important operational/design defect; **Low** = localized/documentation issue.

| ID | Defect and exact source | Observable consequence | Severity | Is source-plan diagnosis correct? | Is proposed remedy proportional? | Required follow-up artifact |
|---|---|---|---|---|---|---|
| DEF-001 | Separate text and voice history authorities: [`MentionResponder.rooms`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts#L49-L56) vs [`GuildSession`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L6-L35). | A person’s permitted text and voice context cannot be coherently retrieved; restart loses both independently. | High | Yes. | A shared transport-neutral port is proportional. A mandatory HTTP service is not yet proportional. | `02-memory-boundary-and-topology-adr.md` |
| DEF-002 | Text appends history before `message.reply`/`channel.send`: [responder](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts), [adapter](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L239-L270). | Bot remembers a reply that failed or was only partly delivered. | Critical | Yes; DB and Discord cannot be one atomic transaction. | Explicit generation/persistence/delivery states and reconciliation are proportional; pretending exact atomicity is not. | `03-event-delivery-state-machine.md` |
| DEF-003 | Voice `fullReply` is accumulated before TTS/playback success; playback statuses are not used as commit predicates: [controller](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts), [pipeline](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/tts-pipeline.ts), [playback](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/playback.ts). | Failed/skipped/unheard clauses can appear as normal completed assistant history. | Critical | Yes. | Segment-aware delivery outcomes and completed/partial/failed response states are proportional. | `03-event-delivery-state-machine.md` plus delivery fault tests |
| DEF-004 | Group messages retain attribution transiently but controller uses synthetic `Discord group`; `GuildSession` accepts one speaker: [group builder](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/group-turn-builder.ts), [controller](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/conversation-controller.ts), [commit](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L37-L64). | Durable history cannot answer which people caused the response; synthetic actor can contaminate person memory. | Critical | Yes. | Many-to-many causal links are proportional. It is not necessary to mix all speakers into one “exchange” row. | `04-event-causality-and-attribution-spec.md` |
| DEF-005 | Voice capture reuses initial display name for existing capture: [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts). | Later event snapshots may show a stale guild nickname/display name. | Medium | Yes, event-time and current presentation must be distinguishable. | Refreshing event snapshot fields without upserting a durable current identity on every packet is proportional. | `05-discord-identity-and-alias-spec.md` |
| DEF-006 | Actor envelopes contain only `userId` plus one `displayName`: [text event](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L227-L238), [`events.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/events.ts). | Username, global display, guild nickname, current preferred alias, and event-time presentation cannot be distinguished. | High | Yes. | A structured Discord actor snapshot plus separately updated current identity is proportional. | `05-discord-identity-and-alias-spec.md` |
| DEF-007 | Voice room projection uses `voiceRoom(guildId, guildId)`: [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L72-L80). | Stored/projection scope cannot identify the actual voice channel; future cross-channel bindings and privacy decisions become unreliable. | High | Yes. | Separate physical-room and logical-room IDs are proportional. | `06-room-scope-and-authorization-spec.md` |
| DEF-008 | No durable conversation persistence; package has no direct DB dependency and histories explicitly use memory: [manifest](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/package.json), [text](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/mention-responder.ts), [voice](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts). | Restart erases context; production cannot honestly claim successful durable writes. | High for shared-memory release | Yes. | An in-process DB-backed implementation behind a port is proportionate first; service extraction remains conditional. | `02-memory-boundary-and-topology-adr.md`, then storage schema |
| DEF-009 | Generated TTS cache and optional user WAV dumps are disk persistence without a unified privacy lifecycle: [`tts-cache.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/providers/tts/tts-cache.ts), [`voice-manager.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/voice/voice-manager.ts). | Export/forget/retention can omit audio artifacts; user speech may remain after memory deletion. | High when retention enabled | Yes, deletion must include derived/cached artifacts. | A data inventory and deletion matrix is proportional before broad retention. | `07-privacy-retention-deletion-spec.md` |
| DEF-010 | Gateway intent documentation contradicts code: [root README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/README.md#L20-L24), [service README](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/README.md#L10-L24), [client](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/adapters/airi-adapter.ts#L87-L99). | Operators can configure the Discord app incorrectly or grant an unnecessary privileged intent. | Medium | Risk H is correct: member updates/intents require review. | Fixing docs and creating an explicit intent decision matrix is proportional. | `08-discord-intents-and-operations-checklist.md` |
| DEF-011 | AIRI backend creates no local voice controller while still creating the voice manager: [`index.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L57-L66), [backend branch](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/index.ts#L114-L126). | Voice utterances appear to have no consumer in that supported configuration. | High if AIRI voice is claimed | Not explicitly in source plan; discovered by audit. | First document whether AIRI mode is text-only or wire/test voice deliberately. | `09-airi-backend-capability-audit.md` |
| DEF-012 | No tests cover Discord send failure after text commit or failed/dropped playback’s effect on voice history. | Refactor can preserve current false-history behavior unnoticed. | High | Yes, delivery recovery is a required benchmark domain. | Regression tests before implementation are proportional. | `10-shared-memory-evaluation-plan.md` and pre-change fault tests |
| DEF-013 | Prompt/history speaker labels use presentation strings without prompt-local opaque person references. | Two users with the same display name can be ambiguous to the model even though transport IDs differ. | High | Yes. | Opaque prompt-local person references with safe display rendering are proportional. | `05-discord-identity-and-alias-spec.md`, `11-prompt-serialization-security-spec.md` |
| DEF-014 | `GuildSession` comments acknowledge room-scoped runtime direction but deliberately keep guild-scoped state: [`guild-session.ts`](https://github.com/starryark/DC_BOT/blob/0ea3cbf/airi/services/discord-bot/src/orchestration/guild-session.ts#L6-L23). | Planning terminology can be mistaken for implemented room behavior. | Medium | Yes: proposals and implemented behavior must be distinguished. | Evidence-labeled documentation and ADRs are proportional. | This audit plus `06-room-scope-and-authorization-spec.md` |
| DEF-015 | Current event/history shapes have no provenance, confidence, temporal validity, correction, or supersession model. | Assistant inference could later be stored indistinguishably from user-grounded fact if persistence is added naively. | Critical for durable facts | Yes. | Separate raw events from extracted memories and require provenance is proportional. | `12-memory-layers-and-provenance-spec.md` |
| DEF-016 | Current text/voice history schemas assume a normal paired exchange and no durable delivery lifecycle. | Interrupted/partial output cannot be represented without lying or discarding evidence. | Critical | Yes. | Append-mostly event/state records plus explicit response/delivery lifecycle are proportional. | `03-event-delivery-state-machine.md`, `04-event-causality-and-attribution-spec.md` |
| DEF-017 | No logical-room authorization or alias-scope enforcement exists. | A future naïve cross-channel retrieval can leak private DM aliases or context into a guild. | Critical for shared memory | Yes. | Authorization-first retrieval and explicit scope types are proportional. | `06-room-scope-and-authorization-spec.md`, `07-privacy-retention-deletion-spec.md` |
| DEF-018 | No benchmark currently covers identity continuity, attribution, deletion completeness, privacy leakage, delivery recovery, multilingual retrieval, or concurrent writes. | Architecture thresholds and retrieval weights would be unsupported hypotheses. | High | Yes. | A staged evaluation plan is proportional before vectors/graph/reranking. | `10-shared-memory-evaluation-plan.md` |

---

## 10. Verified topology conclusion

### 10.1 What is verified

**Confirmed repository fact.** The default launch topology is multi-process for model services but **single-process for Discord text and voice orchestration**:

- ASR is an HTTP service on 8765;
- TTS is an HTTP service on 9880;
- the Node Discord bot contains Discord ingress, direct text generation, voice orchestration, and both in-memory history owners.

### 10.2 What is not verified

- No evidence shows multiple Node Discord bot replicas sharing load.
- No evidence shows text and voice running as separate bot processes in the default deployment.
- No evidence shows a database already shared by replicas.
- No evidence shows a mandatory network boundary for memory.
- No evidence shows the external AIRI server is required in default/direct mode.
- No evidence shows AIRI-mode voice is complete.

### 10.3 Conclusion

**Recommendation ADR-001.** Do not require an HTTP memory microservice in milestone one.

**Recommendation ADR-002.** Require a transport-neutral `MemoryPort`/application boundary so the first adapter may be in-process with SQLite or PostgreSQL and a later adapter may call a standalone Memory Runtime without changing text/voice orchestration contracts.

**Recommendation ADR-003.** A standalone service becomes justified only after verified needs such as independent scaling, multiple bot processes/languages, fault-domain separation, cross-host access, operational ownership boundaries, or measured database-contention requirements.

**Recommendation ADR-004.** Do not use “we may want a service later” as sufficient reason to impose a network protocol, service discovery, distributed tracing, retries, authentication, and split-deployment operations in the first milestone.

---

## 11. Proposed decisions

These are evidence-constraining decisions for downstream specifications, not a final architecture.

### ADR-001 — Evidence revision pin

**Decision.** Treat DC_BOT `main` at short SHA `0ea3cbf` as the baseline for this audit. Re-run or delta-audit if coding begins from another revision.

### ADR-002 — Executing code outranks plans/comments

**Decision.** Treat `MentionResponder`/`InMemoryRoomStore` and `GuildSession` as the current history implementation. Comments that mention runtime-v2, plans, or later room scoping do not supersede executing control flow.

### ADR-003 — Platform identity boundary

**Decision.** Treat `discord:user:<id>` as a durable Discord-platform identity only. Do not equate it to a verified cross-platform human identity without explicit account linking and verification.

### ADR-004 — Delivery is distinct from generation and persistence

**Decision.** Downstream schemas must represent generation, persistence, delivery attempts, partial delivery, cancellation, failure, and reconciliation separately. They must not claim an atomic database-plus-Discord commit.

### ADR-005 — Group causality is many-to-many

**Decision.** A response may be caused by multiple attributable input events. No downstream exchange schema may require exactly one `user_event_id` for an assistant response.

### ADR-006 — Physical and logical rooms are separate

**Decision.** Preserve actual Discord channel identity on every event. Logical conversation-room binding must be explicit/configured and authorization-aware.

### ADR-007 — Minimal topology first

**Decision.** The next architecture ADR must compare in-process database-backed memory versus a standalone runtime; it must not assume HTTP is mandatory. The present evidence favors an in-process first adapter with a clean migration boundary.

### ADR-008 — Release blockers

**Decision.** Attribution, delivery correctness, identity/alias privacy, room authorization, and deletion completeness are release blockers for broad production retention.

---

## 12. Alternatives considered

| Alternative | Evidence-based advantages | Evidence-based costs/risks | Status |
|---|---|---|---|
| Keep separate text/voice in-memory histories | Minimal code change; preserves current tests. | Fails core shared-memory goal; restart loss; no cross-modality continuity; conflicting ownership. | Rejected for shared-memory milestone. |
| Mandatory standalone HTTP memory service immediately | Clear process boundary; future independent deployment possible. | No current topology need; adds distributed failure/retry/auth/ops complexity; text and voice already share one process. | Rejected as mandatory first milestone. |
| In-process MemoryPort with SQLite | Minimal infrastructure; transactional local durability; easy single-process fit. | Single-host/process deployment assumptions; SQLite concurrency and migration constraints need measurement. | Candidate for topology ADR. |
| In-process MemoryPort with PostgreSQL | Stronger concurrent access and operational tooling; easier later multi-process sharing. | Heavier local setup and operations; current single-process deployment may not need it. | Candidate for topology ADR. |
| External AIRI runtime as memory authority now | Reuses AIRI transport conventions. | Current DC_BOT AIRI-mode voice path is unverified; upstream memory work includes WIP/proposal evidence; could bind implementation prematurely. | Blocked pending capability audit. |
| Copy AstrBot whole-history persistence pattern | Simple product-facing conversation storage. | Read-modify-write whole arrays obscure event provenance and may be unsafe under concurrent writers without stronger DB semantics. | Rejected as direct model; useful comparison only. |
| Commit history only after send/play succeeds | Avoids some false completed turns. | Crash after successful external delivery but before DB commit still loses the delivered response; partial delivery still needs representation. | Insufficient alone. |
| Commit generated response before delivery and mark later | Preserves intent before external side effect. | Requires explicit state machine/reconciliation; cannot label as completed until delivery evidence. | Candidate pattern for delivery spec. |
| Store only mixed group prompt as one user event | Simple current schema compatibility. | Destroys attribution and contaminates person-level memory. | Rejected. |
| Store attributable raw events plus causal links to one response | Preserves speakers and many-to-many causality. | Requires additional schema and prompt projection logic. | Required direction for attribution spec. |
| Update durable current identity on every audio packet/event | Maximum freshness. | Write amplification and noisy updates; conflates event snapshot with current profile. | Rejected. |
| Preserve actor snapshot on every event; update current profile conditionally | Accurate historical display plus controlled current-profile updates. | Requires explicit freshness/update policy. | Required direction for identity spec. |

---

## 13. Rejected alternatives and reasons

### 13.1 “The current AIRI packages already solve memory”

Rejected. The inspected DC_BOT direct path does not invoke a memory package. Upstream AIRI memory evidence includes proposals/WIP; implementation claims must be made at exact file/symbol level.

### 13.2 “Discord display name is the identity key”

Rejected. The repository already receives a stable Discord user ID; display names can change and collide. The current code’s use of labels in prompts/history is presentation, not durable identity.

### 13.3 “One grouped voice turn can be authored by Discord group”

Rejected. The source captures the actual users and already has attributable intermediate messages. Replacing them with a synthetic person discards known evidence and is unsafe for person memory.

### 13.4 “Database commit and Discord delivery can be exactly atomic”

Rejected. Discord send/playback is an external side effect outside the database transaction. Crash windows exist in either ordering. The design must expose states and reconcile.

### 13.5 “Append-only means lifecycle status may be silently mutated”

Rejected as underspecified. Downstream design must distinguish immutable event payload, append-only lifecycle transition records, and mutable projections/materialized views. Privacy erasure/redaction also requires an explicit exception/model.

### 13.6 “A room snapshot version should reject every append if another message arrived during generation”

Rejected as a default rule. A generation snapshot is evidence of context seen. Ordinary append commitment need not fail merely because another event arrived, provided causality, ordering, room sequence, and delivery state are recorded. Conflict rules belong in the concurrency specification.

### 13.7 “PostgreSQL full-text search is enough for every language”

Rejected as an unsupported general claim. CJK/multilingual tokenization and ranking require benchmarked configuration or alternative lexical indexes. No retrieval engine is selected by this audit.

---

## 14. Normative specification for downstream work

The following requirements are evidence-derived constraints. They do not prescribe the full final schema.

### Identity and actor events

- **REQ-ID-001.** Every persisted Discord user event MUST carry the Discord user ID as the Discord-platform actor key.
- **REQ-ID-002.** The system MUST NOT merge people because presentation aliases collide.
- **REQ-ID-003.** A Discord identity MUST NOT be treated as a verified cross-platform human identity without explicit verified linking.
- **REQ-ID-004.** Event-time actor presentation MUST be stored separately from the current actor profile.
- **REQ-ID-005.** Discord actor snapshots SHOULD name distinct available fields, including username, global display name, guild nickname/display, avatar reference, and source/freshness, rather than flattening all presentation into `displayName`.
- **REQ-ID-006.** Preferred aliases MUST be scoped and authorization checked. A private alias MUST NOT be projected into public guild context.
- **REQ-ID-007.** Prompt projection MUST use non-display opaque person references when needed to disambiguate same-name speakers, and those internal references MUST NOT be printed or spoken.

### Events and causality

- **REQ-EVENT-001.** Each inbound text or voice utterance used for context MUST have a stable event ID.
- **REQ-EVENT-002.** Group voice MUST preserve one attributable input event per speaker/utterance.
- **REQ-EVENT-003.** A synthetic actor such as `Discord group` MUST NOT become the durable author of attributable user speech.
- **REQ-EVENT-004.** Assistant responses MUST support zero, one, or many causal input-event links.
- **REQ-EVENT-005.** The context snapshot/version used for generation MUST be recorded as evidence, but ordinary response append MUST NOT automatically fail solely because newer events arrived.
- **REQ-EVENT-006.** Immutable raw payload and lifecycle changes MUST be modeled distinctly, whether through append-only transitions or another explicitly documented mechanism.

### Room and scope

- **REQ-SCOPE-001.** Every Discord event MUST retain actual guild/channel/thread/DM identifiers applicable at receipt time.
- **REQ-SCOPE-002.** Physical Discord room identity MUST be distinct from logical conversation-room identity.
- **REQ-SCOPE-003.** Cross-channel recent context MUST occur only through explicit/configured logical binding.
- **REQ-SCOPE-004.** DMs, guilds, people, characters, logical rooms, and unbound channels MUST have explicit isolation rules.
- **REQ-SCOPE-005.** Person-level memory MAY cross text and voice only after authorization and scope checks; this MUST NOT imply copying a whole text transcript into a voice room.

### Delivery

- **REQ-DELIVERY-001.** Generation, persistence, Discord send/playback, and completed-history projection MUST be separate states or records.
- **REQ-DELIVERY-002.** The implementation MUST represent at least pending, attempted, partially delivered, delivered, cancelled, failed, and unknown/reconciliation-needed outcomes where applicable.
- **REQ-DELIVERY-003.** A failed text send MUST NOT be projected as an ordinary completed assistant turn.
- **REQ-DELIVERY-004.** Voice text not synthesized or not played MUST NOT be projected as fully heard.
- **REQ-DELIVERY-005.** Crash windows before and after external delivery MUST have deterministic reconciliation policy.
- **REQ-DELIVERY-006.** Multi-chunk text and multi-segment audio SHOULD have segment/chunk delivery evidence sufficient to represent partial delivery.

### Memory layers and provenance

- **REQ-MEM-001.** Raw attributable events, recent room context, summaries, semantic facts, episodic memories, and operator-authored procedural memory MUST remain distinct layers/types.
- **REQ-MEM-002.** Extracted durable facts MUST include provenance, confidence, observed/effective time, and correction/supersession behavior.
- **REQ-MEM-003.** Assistant speculation MUST NOT silently become user truth.
- **REQ-MEM-004.** Production MUST NOT silently fall back to unrelated process-local history while reporting a durable write as successful.
- **REQ-MEM-005.** Text and voice MUST use one coherent memory application boundary even if adapters or projections differ.

### Retrieval and prompt safety

- **REQ-RETRIEVAL-001.** Retrieval MUST apply authorization and scope filtering before content ranking/projection.
- **REQ-RETRIEVAL-002.** Initial retrieval SHOULD prioritize exact structured lookup, temporal filtering, and measured lexical/full-text search.
- **REQ-RETRIEVAL-003.** Vector, learned reranking, and graph storage MUST require benchmark evidence rather than assumption.
- **REQ-RETRIEVAL-004.** Retrieved memory MUST be serialized as untrusted data, not instructions.
- **REQ-RETRIEVAL-005.** Prompt serialization MUST resist delimiter/fake-role injection, mentions, Unicode control abuse, and internal-ID exposure.
- **REQ-RETRIEVAL-006.** Multilingual and CJK retrieval MUST have explicit evaluation and MUST NOT be represented by an unqualified “PostgreSQL FTS handles it” claim.

### Operations and privacy

- **REQ-PRIV-001.** Forget/delete MUST cover raw events, derived summaries/facts, indexes/embeddings, caches, debug audio, exports, backups according to a documented erasure model.
- **REQ-PRIV-002.** Retention defaults and operator controls MUST be specified before broad production retention.
- **REQ-PRIV-003.** Alias, DM, guild, and logical-room authorization leakage tests are release-blocking.
- **REQ-OPS-001.** Discord intent requirements and member-update behavior MUST be documented consistently with code.
- **REQ-OPS-002.** Cache invalidation, summary regeneration, embedding deletion, backup expiry, and reconciliation MUST have operator procedures.
- **REQ-OPS-003.** Voice-critical processing MUST not synchronously depend on summarization, extraction, embedding, graph construction, or contradiction reconciliation.

### Evaluation

- **REQ-EVAL-001.** Benchmarks MUST cover identity continuity, duplicate aliases, multi-speaker attribution, temporal correction, abstention, privacy leakage, deletion completeness, concurrency, delivery recovery, multilingual retrieval, latency, and cost.
- **REQ-EVAL-002.** Retrieval weights and latency thresholds MUST be treated as hypotheses until measured.
- **REQ-EVAL-003.** Regression tests MUST reproduce current delivery and attribution defects before refactoring.

---

## 15. Interfaces, schemas, state machines, and test vectors

These are specification aids only, not final production code.

## 15.1 Minimal transport-neutral boundary sketch

```ts
interface MemoryPort {
  appendInboundEvents(request: AppendInboundEvents): Promise<AppendResult>
  recordGeneration(request: RecordGeneration): Promise<GenerationRecord>
  recordDeliveryTransition(request: RecordDeliveryTransition): Promise<void>
  readContext(request: ReadAuthorizedContext): Promise<ContextSnapshot>
  correctMemory(request: CorrectMemory): Promise<CorrectionResult>
  forget(request: ForgetRequest): Promise<ForgetResult>
  exportSubject(request: ExportRequest): Promise<ExportBundle>
}
```

**Recommendation.** The interface should carry domain requests/results and typed errors, not expose HTTP concepts. An HTTP adapter may be added later.

## 15.2 Actor snapshot sketch

```text
DiscordActorSnapshot
  platform_actor_id = "discord:user:<snowflake>"
  discord_user_id
  username?
  global_display_name?
  guild_nickname?
  guild_display_name?
  avatar_ref?
  guild_id?
  observed_at
  source_event_id
```

A separate current profile may contain scoped preferred aliases and freshness metadata. Event snapshots are historical evidence and should not be rewritten merely because the current nickname changes.

## 15.3 Causality sketch

```text
input_event A (speaker U1) ─┐
                            ├─ response_cause ─> assistant_response R
input_event B (speaker U2) ─┘

assistant_response R
  ├─ generated payload/version
  ├─ context snapshot ID
  ├─ delivery attempt D1
  ├─ text chunk receipts or audio segment receipts
  └─ final projection state
```

## 15.4 Delivery state machine

```text
GENERATING
  -> GENERATION_FAILED
  -> GENERATED

GENERATED
  -> DELIVERY_PENDING
  -> CANCELLED_BEFORE_DELIVERY

DELIVERY_PENDING
  -> DELIVERY_IN_PROGRESS
  -> DELIVERY_FAILED
  -> RECONCILIATION_NEEDED

DELIVERY_IN_PROGRESS
  -> DELIVERED
  -> PARTIALLY_DELIVERED
  -> DELIVERY_FAILED
  -> CANCELLED_DURING_DELIVERY
  -> RECONCILIATION_NEEDED

RECONCILIATION_NEEDED
  -> DELIVERED
  -> PARTIALLY_DELIVERED
  -> DELIVERY_FAILED
  -> UNKNOWN_FINAL_STATE
```

**Constraint.** The normal completed-conversation projection may include `DELIVERED`; it must distinguish partial, cancelled, failed, and unknown outcomes.

## 15.5 Test vectors

| ID | Input/condition | Required observation |
|---|---|---|
| TEST-001 | Two guild users share identical display name and speak in one group window. | Two distinct actor IDs and prompt-local references; no merge; response causally links to both events. |
| TEST-002 | User changes guild nickname between voice utterances in one joined session. | New event snapshot uses new presentation; historical event retains old presentation. |
| TEST-003 | Text generation succeeds; first `message.reply` throws permission error. | Generated response is retained as generation evidence, delivery is failed, and normal completed-history projection excludes it. |
| TEST-004 | First text chunk sends; second chunk fails. | State is partial delivery with chunk receipts; no claim of full delivery. |
| TEST-005 | Voice chunk 1 plays; chunk 2 TTS fails; chunk 3 plays. | History/projection represents actual audible segments or partial output, not the full generated text as fully heard. |
| TEST-006 | Playback scheduler returns `dropped`. | Dropped clause is not marked heard/completed. |
| TEST-007 | Process crashes after Discord send but before final DB transition. | Reconciliation produces a defined final/unknown state; no duplicate retry without idempotency policy. |
| TEST-008 | DM alias “X” is private; same user is addressed in guild. | Private alias is not retrieved or rendered in guild context. |
| TEST-009 | Physical channels A and B are unbound. | Recent history does not cross channels. |
| TEST-010 | Channels A and B are explicitly bound to logical room L. | Authorized room-level recent context crosses according to binding policy; physical provenance remains intact. |
| TEST-011 | User corrects an old fact. | New fact supersedes prior fact with provenance/time; raw events remain governed by retention/redaction policy. |
| TEST-012 | Forget request for user. | Raw/derived/index/cache/debug/backup obligations are enumerated and completeness is measurable. |
| TEST-013 | Retrieved memory contains fake role delimiters and `@everyone`. | Serialization treats content as data; no role escape, mention, or internal-ID exposure. |
| TEST-014 | Concurrent appends occur while generation uses an earlier context snapshot. | New response records the snapshot it saw; append does not fail solely due to unrelated newer event. |
| TEST-015 | CJK fact is stored and queried using lexical retrieval. | Recall/precision and latency are measured; unsupported tokenizer behavior causes abstention/fallback rather than false confidence. |

---

## 16. Failure modes

| ID | Failure mode | Current behavior/evidence | Required downstream handling |
|---|---|---|---|
| RISK-001 | Discord text send fails after generation/history append | History already mutated. | Delivery-failed state; completed projection exclusion; retry/reconcile policy. |
| RISK-002 | Partial multi-chunk text send | Some chunks sent before error. | Per-chunk attempt evidence and partial-delivery state. |
| RISK-003 | TTS failure for one generated clause | Clause may remain in `fullReply`; no audio. | Segment-level generation/synthesis/delivery distinction. |
| RISK-004 | Playback resource fails/drops | Scheduler reports status; controller may still commit. | Propagate outcome into response lifecycle and projection. |
| RISK-005 | Barge-in/cancellation race | Epoch checks prevent superseded mutation in current process. | Preserve epoch/correlation semantics durably; test crash boundaries. |
| RISK-006 | Bot process restart | Text/voice context lost. | Durable store; explicit degraded mode; no silent fake-success fallback. |
| RISK-007 | Display-name change mid-session | Voice capture can retain stale presentation. | Event-time refresh and conditional current-profile update. |
| RISK-008 | Same alias for two users | Prompt/history labels may be ambiguous. | Stable actor IDs and prompt-local opaque references. |
| RISK-009 | Group response caused by several users | Commitment stores synthetic group speaker. | Many-to-many causes and attributable raw events. |
| RISK-010 | Bot moves/rejoins voice channel | Transport channel and conversational room identity diverge. | Actual physical channel on events; logical binding explicit. |
| RISK-011 | AIRI backend selected | Direct text/voice orchestrators absent; voice consumer unverified. | Capability gating/documentation and integration tests. |
| RISK-012 | Debug audio/cache retained | User/generated audio remains on disk. | Retention, encryption/access, deletion and backup policy. |
| RISK-013 | Concurrent writers in future DB | Whole-history replacement can lose updates. | Append/event transactions, sequence/idempotency, concurrency tests. |
| RISK-014 | Memory contains malicious delimiters/mentions | Current quote safety is limited to immediate replied text. | Typed serialization, escaping, mention suppression, untrusted-memory policy. |
| RISK-015 | Privacy deletion conflicts with append history | No current model. | Defined erasure/redaction/tombstone and derived-data regeneration rules. |
| RISK-016 | Unsupported multilingual lexical search | No current retrieval benchmark. | Language-aware benchmark and explicit fallback/abstention. |

---

## 17. Security and privacy implications

### 17.1 Identity and alias leakage

Current code uses a single display label in prompt/history. A future shared-memory implementation that retrieves aliases without scope checks could expose DM-only or private-conversation labels in guild text/voice. Authorization must precede retrieval and rendering.

### 17.2 Same-name collision

The transport has distinct user IDs, but current prompt/history labels can be identical. Durable person facts must key by platform actor, not presentation string. Prompt-local opaque references should distinguish participants without exposing internal durable IDs.

### 17.3 Retrieved-memory injection

Current text code recognizes quoted replied-to content as untrusted. Durable memory increases the attack surface because stored strings can contain fake roles, delimiters, mentions, zero-width/control characters, or instructions. Memory content must be serialized in a data-only structure and sanitized for the output channel.

### 17.4 Audio retention

Generated TTS cache files and optional user input WAV dumps are privacy-relevant persisted artifacts. A future “forget me” operation that deletes only database rows would be incomplete. Data inventory must include cache keys, files, metadata, debug dumps, exports, and backups.

### 17.5 Discord member intents

Expanding current identity synchronization to broad guild-member events may require privileged-intent decisions and operational review. The current docs already disagree with code, so the implementation must not silently add or assume additional member access.

### 17.6 Delivery truthfulness

False completed history is a security/trust issue, not only a UX defect. Later memory extraction could convert an unheard assistant statement into a durable “conversation fact,” causing incorrect future behavior.

### 17.7 Deletion versus append history

An append-oriented audit trail and privacy erasure are in tension. Downstream work must specify whether payloads are erased, encrypted keys destroyed, fields redacted with tombstones, derived projections regenerated, and backups expired. “Immutable” cannot be used as a reason to refuse valid deletion requirements.

---

## 18. Testable acceptance criteria for this audit and next phase

### Audit completeness

- **TEST-AUDIT-001.** Every major current-state claim in this artifact is labeled by classification and linked to an exact repository source or explicitly labeled inference.
- **TEST-AUDIT-002.** The baseline revision is recorded.
- **TEST-AUDIT-003.** Text and voice call graphs identify context read, generation, delivery, and commitment ordering.
- **TEST-AUDIT-004.** Ownership of text history, voice history, room identity, actor identity, cancellation, playback, delivery, and long-term memory is explicit.
- **TEST-AUDIT-005.** The topology conclusion distinguishes model-service processes from the single Discord orchestration process.
- **TEST-AUDIT-006.** Upstream AIRI proposals and AstrBot comparison behavior are not represented as DC_BOT implementation.

### Before shared-memory implementation approval

- **TEST-ARCH-001.** Topology ADR compares in-process SQLite, in-process/shared PostgreSQL, and standalone runtime using verified deployment criteria.
- **TEST-IDENT-001.** Identity/alias spec demonstrates no merge for duplicate display names and no private-alias leakage.
- **TEST-ATTR-001.** Group voice stores attributable events and many-to-many response causes without synthetic actor authorship.
- **TEST-DELIVERY-001.** Text send failure and partial chunk failure are represented and recovered according to a state machine.
- **TEST-DELIVERY-002.** Failed/skipped/dropped voice segments do not become normal fully heard history.
- **TEST-ROOM-001.** Actual voice channel IDs are preserved and logical bindings are independently authorized.
- **TEST-PRIV-001.** Forget/export/retention matrix covers database, summaries, embeddings/indexes, TTS cache, debug WAVs, exports, and backups.
- **TEST-CONC-001.** Concurrent append tests show no lost events and no unnecessary rejection due only to a newer room event.
- **TEST-RETRIEVAL-001.** Exact/temporal/lexical baseline is benchmarked, including CJK/multilingual cases, before vector/graph claims.
- **TEST-OPS-001.** Production cannot report a durable write success while using an unrelated ephemeral fallback.

---

## 19. Non-goals

- Selecting a final database or ORM.
- Selecting an embedding model/vector database.
- Designing a graph ontology.
- Selecting arbitrary retrieval weights or latency SLOs.
- Implementing account linking across platforms.
- Rewriting current production modules in this artifact.
- Declaring AIRI Memory Alaya production-ready.
- Declaring AstrBot’s conversation storage concurrency-safe without a deeper database-layer audit.
- Treating every current comment or plan reference as a requirement.
- Guaranteeing exactly-once Discord delivery, which the external platform and database cannot jointly provide atomically.

---

## 20. Dependencies on other artifacts

The evidence in this audit requires the following downstream artifacts, in order:

1. **`02-memory-boundary-and-topology-adr.md`**  
   Choose first-milestone deployment/storage topology using current single-process evidence and a migration path.

2. **`03-event-delivery-state-machine.md`**  
   Specify generation, persistence, text chunks, voice segments, cancellation, partial delivery, crash windows, retries, and reconciliation.

3. **`04-event-causality-and-attribution-spec.md`**  
   Define attributable input events and many-to-many assistant-response causes.

4. **`05-discord-identity-and-alias-spec.md`**  
   Define Discord actor snapshots, current profile, presentation history, scoped aliases, duplicate-name handling, and prompt-local references.

5. **`06-room-scope-and-authorization-spec.md`**  
   Separate physical Discord rooms from logical conversation rooms and define cross-channel bindings/authorization.

6. **`07-privacy-retention-deletion-spec.md`**  
   Define retention, export, correction, forget, cache/debug-audio/backup handling, and derived-data regeneration.

7. **`08-discord-intents-and-operations-checklist.md`**  
   Reconcile documentation with actual intents and decide member-update requirements.

8. **`09-airi-backend-capability-audit.md`**  
   Establish whether AIRI mode is text-only or has a complete voice path and what external persistence exists.

9. **`10-shared-memory-evaluation-plan.md`**  
   Define benchmarks and fault-injection coverage before retrieval/infrastructure expansion.

10. **`11-prompt-serialization-security-spec.md`**  
    Define safe memory/context serialization and output-channel sanitization.

11. **`12-memory-layers-and-provenance-spec.md`**  
    Define raw/recent/summary/semantic/episodic/procedural layers, provenance, confidence, temporal validity, corrections, and supersession.

---

## 21. Open questions

## 21.1 Blocking

1. **Open question.** Which deployment(s) must milestone one support: exactly one direct-mode bot process, multiple bot processes on one host, or multiple hosts?
2. **Open question.** Must AIRI backend voice be supported in the same milestone, or should the mode be explicitly text-only until audited and implemented?
3. **Open question.** What is the authoritative privacy/retention policy for raw transcripts, generated audio cache, debug input audio, backups, and exported data?
4. **Open question.** What logical-room binding operations are allowed, who authorizes them, and can bindings cross guilds or DMs?
5. **Open question.** Which alias scopes are required in milestone one, and who may set/override each scope?
6. **Open question.** What evidence counts as delivery for voice: audio player idle, elapsed playback duration, connection health, or another acknowledgement? Discord does not provide human-heard proof.
7. **Open question.** How should partial spoken responses be projected into future context: exact played text segments, a partial marker, or both?
8. **Open question.** What recovery action is allowed after a crash where Discord delivery may have succeeded but final state is unknown?
9. **Open question.** What erasure model satisfies operator/legal requirements while retaining enough tombstone/audit evidence to prevent deleted content from being regenerated?
10. **Open question.** Is SQLite sufficient under verified write/concurrency/load expectations, or is PostgreSQL required from the outset?

## 21.2 Non-blocking

1. Whether vector retrieval is eventually useful after a lexical/structured baseline.
2. Whether a learned reranker is worth its cost/latency.
3. Whether graph storage is justified for relationship-heavy memories.
4. Whether current TTS cache metadata should join the memory data inventory or remain a separate media subsystem with linked deletion hooks.
5. Whether current text queue depth and voice group limits should remain unchanged after persistent sequencing is introduced.
6. Whether current room string formats are retained as external identifiers or migrated behind typed IDs.
7. Whether event payloads are physically immutable with append-only lifecycle records or use another audited append-mostly model.
8. How summaries are regenerated after correction/deletion.
9. Which multilingual lexical engine/tokenizers meet benchmark targets.

---

## 22. Handoff instructions for downstream agents

1. Pin all work to `0ea3cbf` or produce a repository delta before relying on this audit.
2. Do not begin by creating an HTTP service. First write `02-memory-boundary-and-topology-adr.md` from the verified direct-mode topology.
3. Before changing history code, add regression tests that reproduce DEF-002, DEF-003, DEF-004, DEF-005, and DEF-007.
4. Preserve current useful constraints: text room isolation/serialization, voice admission policy, epoch cancellation, playback ownership/drain, bounded queues, untrusted quoted-text handling, and mention suppression.
5. Do not preserve current defects merely to keep old tests green. Amend tests through explicit ADR/spec decisions where behavior must change.
6. Reuse AIRI monorepo conventions: stable domain contracts, lean composition root, explicit lifecycle/state semantics, Vitest regression coverage, and documented IDs/correlation keys.
7. Keep all memory-derived prompt content untrusted and prevent durable/internal IDs from reaching spoken or visible output.
8. Treat generated TTS cache and optional input WAV dumps as part of the privacy/deletion inventory.
9. Audit the external AIRI runtime separately before making claims about AIRI-mode memory or voice.
10. Treat AstrBot as a product comparison, not a concurrency proof or drop-in schema.

---

## 23. What must be true before coding starts

- The topology ADR is approved and does not assume a network service without verified need.
- The event/response/delivery state machine is approved, including partial text/audio and crash reconciliation.
- The actor snapshot, current identity, alias scopes, and duplicate-name behavior are specified.
- Group voice causality supports multiple attributable input events per response.
- Physical and logical room scopes and authorization are specified.
- Privacy retention, deletion, export, backup, cache, and debug-audio handling are specified.
- The initial storage transaction/concurrency model is specified and benchmarkable.
- Regression tests exist for current false-history and attribution defects.
- AIRI-mode support boundaries are explicit.
- Production fallback behavior is explicit and cannot masquerade as durable success.
- Acceptance benchmarks and release blockers are agreed.

---

## 24. Concise handoff summary

DC_BOT currently has two unrelated, bounded, process-local recent-history owners inside one default Node bot process. Text commits before Discord send; voice has robust epoch cancellation and drain behavior but can still commit unheard generated text because synthesis/playback outcomes are not part of the history predicate. Voice group attribution is preserved transiently and then collapsed into a synthetic `Discord group` author. Discord user IDs are available, but presentation, alias, room, delivery, provenance, and privacy models are not yet sufficient for durable shared memory.

Proceed next with:

- `02-memory-boundary-and-topology-adr.md`;
- `03-event-delivery-state-machine.md`;
- `04-event-causality-and-attribution-spec.md`;
- `05-discord-identity-and-alias-spec.md`;
- `06-room-scope-and-authorization-spec.md`;
- `07-privacy-retention-deletion-spec.md`;
- regression tests for delivery, failed playback/TTS, group attribution, stale display names, and actual voice-channel identity.

No production coding should start until those release-blocking decisions are explicit.
