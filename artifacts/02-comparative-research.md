# Comparative Upstream Memory Implementation Research

**Artifact filename:** `02-comparative-research.md`  
**Prepared for:** DC_BOT shared-memory documentation program  
**Inspection date:** 2026-08-01  
**Repository access method:** GitHub web pages, raw GitHub URLs, repository trees, commit pages, issues, and official documentation. No repository was cloned.

---

## 1. Executive conclusion

The inspected default branches do **not** provide a complete upstream implementation that DC_BOT should copy wholesale.

- **DC_BOT** has the best evidence of voice-specific orchestration discipline: bounded per-guild history, supersession checks, speaker-preserving group aggregation, and committing a voice exchange only after playback drains. However, text and voice still own separate process-local histories, the active voice key is guild-scoped rather than physical- or logical-room-scoped, group history is flattened to the synthetic speaker `"Discord group"` at commit time, and there is no durable delivery ledger, semantic memory, deletion workflow, or multi-process authority.
- **Airi** has the strongest reusable mechanics for local-first chat persistence and cross-device synchronization: IndexedDB-backed sessions, stable message IDs, a durable client outbox, idempotent retries, cloud sequence reconciliation, deletion tombstones, and import/export. It also has structured context projection and compaction. These are **conversation and synchronization features**, not proof that “Memory Alaya” or its semantic-memory architecture is production-complete. The default-branch `memory-pgvector` package is only a module shell, while the broader semantic layer remains an open proposal.
- **AstrBot** provides a useful product baseline for persisted sessions, multiple selectable conversations, configurable context compression, platform-message history with sender attribution, and SQLite-backed storage. Its main conversation path nevertheless serializes and replaces a mutable whole-history message list. The convenience append path is read–append–replace without an observed version predicate, and the in-process session lock does not establish distributed consistency. LLM compression is wired into the live request path and therefore should not be copied into DC_BOT’s voice-critical path. Aborted output can be saved without a durable delivery-state model.

**Recommended first milestone:** implement a transport-neutral `MemoryPort` as an in-process application/domain boundary, backed by SQLite in the single-process deployment. Use append-oriented attributable events, separate derived projections, explicit identity and authorization scopes, many-to-many response causality, and a durable delivery-attempt ledger. Preserve a clean adapter path to PostgreSQL or a standalone Memory Runtime, but do not require an HTTP microservice until deployment evidence shows independent scaling, multiple writers, language/runtime separation, or operational isolation is necessary.

**Release-blocking areas:** identity continuity, group attribution, privacy-scope isolation, correction/supersession semantics, deletion completeness, and delivery/crash recovery.

---

## 2. Scope

This artifact compares current evidence from:

1. `starryark/DC_BOT`
2. `moeru-ai/airi`
3. `AstrBotDevs/AstrBot`

It evaluates:

1. Conversation persistence.
2. Append events versus whole-history replacement.
3. Session and conversation separation.
4. Identity representation.
5. Multi-user and group attribution.
6. Context compression and summary generation.
7. Semantic-memory extraction.
8. Temporal correction and invalidation.
9. Retrieval architecture.
10. Prompt placement and provider prompt caching.
11. Privacy scopes.
12. Deletion and export.
13. Multi-process consistency.
14. Voice-latency suitability.
15. Delivery and crash recovery.
16. Evaluation methodology.
17. Operational complexity.

The external-research portion is limited to primary papers and official documentation that materially affect architectural decisions. Vendor-authored claims are treated as claims, not as independently reproduced evidence.

### Classification legend

Every upstream or external finding uses one of these evidence classes:

- **A — Implemented on the inspected default branch.**
- **B — Implemented on another identifiable branch.**
- **C — Open pull request.**
- **D — Open issue or proposal.**
- **E — Documentation claim.**
- **F — Experimental code.**
- **G — Paper or vendor benchmark claim.**
- **H — Researcher inference.**

Each claim also states whether it is a **Confirmed repository fact**, **Source-plan requirement**, **External research finding**, **Inference**, **Recommendation**, or **Open question**.

### Evidence limits

- The inspection is a targeted architectural review, not an exhaustive audit of every file.
- “Not found” means “not verified in the inspected paths,” not proof that no related code exists anywhere.
- No branch other than the identified default branches was treated as implemented unless explicitly noted.
- No benchmark result is treated as transferable to DC_BOT without reproduction on DC_BOT workloads.

---

## 3. Sources inspected

### 3.1 DC_BOT

**Default branch:** `main`  
**Inspected commit:** `0ea3cbf5ec92f719e2b48066c3ada45aa50122ad`

- Repository and deployment overview:  
  https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/README.md
- Voice session history:  
  https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/guild-session.ts
- Per-guild state registry:  
  https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-state.ts
- Voice conversation controller:  
  https://raw.githubusercontent.com/starryark/DC_BOT/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-controller.ts
- Event envelope:  
  https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/events.ts
- Group-turn aggregation:  
  https://raw.githubusercontent.com/starryark/DC_BOT/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/group-turn-builder.ts
- Room-ID helpers:  
  https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/room-id.ts
- In-memory room store:  
  https://raw.githubusercontent.com/starryark/DC_BOT/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/room.ts
- Text mention responder:  
  https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/mention-responder.ts
- Voice benchmark script:  
  https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/scripts/benchmark-voice.ts

### 3.2 Airi

**Default branch:** `main`  
**Inspected commit:** `4d6e61f77dc99ec76c7cf352df62abb4282386c5`

- Repository overview and roadmap status:  
  https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/README.md
- Chat session persistence, cloud synchronization, outbox, deletion, and export/import:  
  https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/stage-ui/src/stores/chat/session-store.ts
- Stored/current message merge:  
  https://raw.githubusercontent.com/moeru-ai/airi/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/core-agent/src/session/merge-loaded-session-messages.ts
- Context compaction:  
  https://raw.githubusercontent.com/moeru-ai/airi/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/core-agent/src/messages/compaction.ts
- Context prompt projection:  
  https://raw.githubusercontent.com/moeru-ai/airi/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/core-agent/src/messages/context-prompt.ts
- Cross-tab/window chat synchronization:  
  https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/apps/stage-tamagotchi/src/renderer/stores/chat-sync.ts
- `memory-pgvector` default-branch package entry point:  
  https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/memory-pgvector/src/index.ts
- Open unified memory proposal, issue `#879`:  
  https://github.com/moeru-ai/airi/issues/879
- Open memory/topic-bias proposal, issue `#2005`:  
  https://github.com/moeru-ai/airi/issues/2005
- Official Tamagotchi data-management documentation:  
  https://airi.moeru.ai/docs/en/docs/manual/tamagotchi/setup-and-use/

### 3.3 AstrBot

**Default branch:** `master`  
**Inspected commit:** `49095d3ba3fca9272a67aa5eeab2f6c0719c5091`

- Repository overview:  
  https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/README.md
- Session/conversation manager:  
  https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/conversation_mgr.py
- SQLite persistence:  
  https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/db/sqlite.py
- Persistence objects:  
  https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/db/po.py
- Platform message-history manager:  
  https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/platform_message_history_mgr.py
- Main agent assembly and compression configuration:  
  https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/astr_main_agent.py
- Request processing, session lock, streaming/live mode, and history save:  
  https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py

### 3.4 External primary sources

- LangGraph official memory concepts:  
  https://docs.langchain.com/oss/python/concepts/memory
- LongMemEval:  
  https://arxiv.org/abs/2410.10813
- MemoryAgentBench:  
  https://openreview.net/forum?id=DT7JyQC3MR
- GroupMemBench:  
  https://arxiv.org/abs/2605.14498
- EverMemBench:  
  https://arxiv.org/abs/2602.01313
- DynamicMem:  
  https://arxiv.org/abs/2606.22877
- PostgreSQL full-text search controls:  
  https://www.postgresql.org/docs/current/textsearch-controls.html
- PostgreSQL text-search index types:  
  https://www.postgresql.org/docs/current/textsearch-indexes.html

---

## 4. Evidence table

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| EV-DC-001 | DC_BOT voice history is bounded, per-guild, process-local, and explicitly not persisted in v1. | Confirmed repository fact — **A** | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/guild-session.ts | High |
| EV-DC-002 | DC_BOT voice commits user and assistant history after playback drains, reducing the chance that unheard output becomes a normal committed turn. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/starryark/DC_BOT/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-controller.ts | High |
| EV-DC-003 | DC_BOT text mentions use a separate `InMemoryRoomStore`, so text and voice do not share one memory authority. | Confirmed repository fact — **A** | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/mention-responder.ts | High |
| EV-DC-004 | The event envelope carries `userId` and `displayName`, but not a complete Discord actor snapshot with username, global display name, guild nickname, avatar, and provenance. | Confirmed repository fact — **A** | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/events.ts | High |
| EV-DC-005 | Group aggregation retains individual speaker events while building the prompt. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/starryark/DC_BOT/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/group-turn-builder.ts | High |
| EV-DC-006 | The controller later represents the aggregate as `"Discord group"` and commits that synthetic speaker to history. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/starryark/DC_BOT/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-controller.ts | High |
| EV-DC-007 | Physical room-ID helpers exist, but the active voice session still constructs a guild-scoped voice room. | Confirmed repository fact — **A** | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/room-id.ts ; https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/guild-session.ts | High |
| EV-DC-008 | DC_BOT has voice latency instrumentation, but no verified memory-quality evaluation suite. | Confirmed repository fact — **A** | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/scripts/benchmark-voice.ts | Medium-high |
| EV-AIRI-001 | Airi persists session records locally and queues persistence through a serialized client-side queue. | Confirmed repository fact — **A** | https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/stage-ui/src/stores/chat/session-store.ts | High |
| EV-AIRI-002 | Airi’s local session append produces a new in-memory list and persists a whole session record; it is not a durable append-only event log. | Confirmed repository fact — **A** | Same as EV-AIRI-001 | High |
| EV-AIRI-003 | Airi has a durable IndexedDB outbox, retries, stable client message IDs, and server-side idempotent message submission for cloud chat sync. | Confirmed repository fact — **A** | Same as EV-AIRI-001 | High |
| EV-AIRI-004 | Failed outbox entries are retained rather than silently discarded after the configured retry limit. | Confirmed repository fact — **A** | Same as EV-AIRI-001 | High |
| EV-AIRI-005 | Airi uses deletion tombstones and reconciliation to avoid resurrecting locally deleted cloud sessions. | Confirmed repository fact — **A** | Same as EV-AIRI-001 | High |
| EV-AIRI-006 | Airi supports session export/import and explicit deletion. | Confirmed repository fact — **A** | Same as EV-AIRI-001 | High |
| EV-AIRI-007 | Airi’s core compaction is a deterministic history projection that accepts an optional summary; its fallback is a count marker, not semantic summarization. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/moeru-ai/airi/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/core-agent/src/messages/compaction.ts | High |
| EV-AIRI-008 | Airi’s context projection is deliberately stable and omits volatile identifiers/timestamps to improve cache-friendly prompt structure. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/moeru-ai/airi/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/core-agent/src/messages/context-prompt.ts | High |
| EV-AIRI-009 | The default-branch `memory-pgvector` entry point is a small module shell with no verified database/retrieval implementation in that file. | Confirmed repository fact — **A** | https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/memory-pgvector/src/index.ts | High |
| EV-AIRI-010 | The unified semantic-memory/Alaya direction is an open issue/proposal, not verified complete production behavior. | Confirmed proposal status — **D** | https://github.com/moeru-ai/airi/issues/879 | High |
| EV-ASTR-001 | AstrBot separates a session/origin from selectable conversations. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/conversation_mgr.py | High |
| EV-ASTR-002 | AstrBot’s main conversation stores a mutable message-list payload and updates the whole serialized history. | Confirmed repository fact — **A** | Same as EV-ASTR-001 ; https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/db/sqlite.py | High |
| EV-ASTR-003 | The convenience append path loads the conversation, appends a pair, and replaces the stored content without an observed version/CAS predicate. | Confirmed repository fact — **A** | Same as EV-ASTR-001 | High |
| EV-ASTR-004 | AstrBot serializes LLM handling per unified message origin with an in-process lock. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py | High |
| EV-ASTR-005 | The inspected lock does not establish cross-process or cross-instance consistency. | Inference — **H** | Same as EV-ASTR-004 | High |
| EV-ASTR-006 | Platform-message history stores sender ID and sender name separately from the group’s unified origin. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/platform_message_history_mgr.py | High |
| EV-ASTR-007 | Configured LLM context compression is passed into `AgentRunner.reset`, which is awaited during the locked live request path. | Confirmed repository fact — **A** | https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/astr_main_agent.py ; https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py | High |
| EV-ASTR-008 | AstrBot may save an aborted run; the explicit partial-output marker is commented out, and there is no verified durable delivery-state relation attached to the conversation turn. | Confirmed repository fact plus inference — **A/H** | Same as EV-ASTR-004 | High |
| EV-EXT-001 | LangGraph distinguishes thread-scoped short-term state from long-term data stored in custom namespaces. | Official documentation claim — **E** | https://docs.langchain.com/oss/python/concepts/memory | High |
| EV-EXT-002 | LongMemEval evaluates extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention. | Paper claim — **G** | https://arxiv.org/abs/2410.10813 | High |
| EV-EXT-003 | MemoryAgentBench argues for evaluation beyond retrieval, including test-time learning and long-range behavior. | Paper claim — **G** | https://openreview.net/forum?id=DT7JyQC3MR | Medium-high |
| EV-EXT-004 | GroupMemBench explicitly targets group dynamics, speaker-grounded belief tracking, audience adaptation, temporal updates, ambiguity, and abstention. | Paper claim — **G** | https://arxiv.org/abs/2605.14498 | High |
| EV-EXT-005 | EverMemBench reports severe difficulty in multi-party, temporally evolving, role-conditioned memory and does not establish that graph storage alone solves it. | Paper claim plus inference — **G/H** | https://arxiv.org/abs/2602.01313 | Medium-high |
| EV-EXT-006 | DynamicMem finds a central difficulty in retaining stable facts while replacing changed facts, with many failures attributed to retrieval. | Paper claim — **G** | https://arxiv.org/abs/2606.22877 | High |
| EV-EXT-007 | PostgreSQL full-text search depends on parser/configuration/dictionary behavior; a generic statement that “PostgreSQL FTS supports multilingual/CJK retrieval” is insufficient without tokenizer/configuration evaluation. | Official documentation plus inference — **E/H** | https://www.postgresql.org/docs/current/textsearch-controls.html | High |
| EV-REC-001 | DC_BOT should begin with an in-process `MemoryPort` and SQLite, not a mandatory HTTP service. | Recommendation — **H** | Derived from EV-DC-001 through EV-DC-008 | Medium-high |
| EV-REC-002 | Raw events, derived summaries, semantic memories, and delivery lifecycle should be separate records with separate mutation rules. | Recommendation — **H** | Cross-source synthesis | High |
| EV-REC-003 | Vector and graph retrieval should be introduced only after benchmark evidence shows measurable value over authorized structured, temporal, and lexical retrieval. | Recommendation — **H** | EV-EXT-002 through EV-EXT-007 | High |

---

## 5. Current-state findings

### 5.1 DC_BOT current state

#### 5.1.1 Conversation persistence

**Confirmed repository fact — A.** `GuildSession` explicitly states that v1 does not persist to a database. It retains a bounded in-memory history per guild and trims older turns. The mention responder independently owns an `InMemoryRoomStore`. A process restart loses both stores, and the two modalities do not share a single authority.

Evidence:

- https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/guild-session.ts
- https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/mention-responder.ts
- https://raw.githubusercontent.com/starryark/DC_BOT/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/room.ts

**Implication.** The source-plan diagnosis that text and voice currently own unrelated process-local histories is supported.

#### 5.1.2 Append versus replacement

**Confirmed repository fact — A.** Voice history appends paired user/assistant turns to an array and trims it. Text room history also appends in memory. This is append-like inside one process, but it is not a durable event log: there is no durable event identity, transaction boundary, provenance relation, redaction state, or replay contract.

**Recommendation — H.** Preserve the simplicity of append semantics, but move the authority to durable event records. Do not persist only a mutable prompt-ready transcript.

#### 5.1.3 Session, room, and conversation separation

**Confirmed repository fact — A.** The code contains physical room-ID helpers for Discord text, thread, DM, and voice channels. However, voice `GuildSession.asRoom()` uses guild identifiers for the room construction, and the active registry is per guild. The helper design anticipates room distinctions, but current voice behavior does not enforce them.

**Risk RISK-ROOM-001.** Two voice channels in one guild can unintentionally share the same recent voice history if the runtime allows concurrent or sequential use under the same guild session.

#### 5.1.4 Identity representation

**Confirmed repository fact — A.** The inbound event model carries `userId` and `displayName`. That is enough for immediate attribution, but not enough to preserve a full actor snapshot or distinguish current presentation from historical presentation. There is no verified alias store, scope model, validity interval, provenance, or cross-platform linkage proof.

**Recommendation — H.** Treat `discord:user:<id>` as a durable **Discord identity**, not as a verified universal human identity.

#### 5.1.5 Multi-user and group attribution

**Confirmed repository fact — A.** `group-turn-builder.ts` preserves source events and labels individual speakers in the generated group prompt. This is valuable and should be retained.

**Confirmed repository fact — A.** In the controller’s aggregate-turn path, the synthetic display name `"Discord group"` is assigned and later committed as the history speaker. This discards durable per-speaker attribution at the point where history is recorded.

**Decision impact.** A response triggered by several user events cannot be represented correctly by a fixed schema with one `user_event_id`. The durable relation must be many-to-many.

#### 5.1.6 Context compression and summary generation

**Confirmed repository fact — A.** `Room` exposes a `runningSummary` field/setter, but no verified default-branch pipeline was found that durably generates, versions, invalidates, or regenerates summaries. Current voice history is bounded by trimming.

**Recommendation — H.** Do not put summarization in the voice-critical path. Generate it asynchronously from committed attributable events, and keep a recent exact tail.

#### 5.1.7 Delivery and interruption behavior

**Confirmed repository fact — A.** The controller checks generation epochs to prevent superseded work from speaking or mutating history. It waits for playback to drain before committing the exchange. This is a sound local invariant.

**Limitation.** There is no durable `delivery_attempt` state. A crash after audio begins but before commit, or after commit but before the final transport acknowledgement, cannot be reconstructed reliably. Discord send/playback cannot be atomically committed with a database transaction.

**Recommendation — H.** Borrow the local epoch discipline, then add a durable delivery state machine and reconciliation.

#### 5.1.8 Evaluation and operations

**Confirmed repository fact — A.** The repository includes voice benchmarking for ASR/TTS and end-to-end latency. No inspected suite evaluates identity continuity, attribution, corrections, deletion, privacy leakage, concurrent writes, delivery recovery, or multilingual retrieval.

**Inference — H.** The present topology does not demonstrate a requirement for a standalone memory microservice in milestone one. The bot is already a direct Discord/ASR/LLM/TTS process, and an in-process port can enforce the architecture without introducing network deployment.

---

### 5.2 Airi current state

#### 5.2.1 Conversation persistence

**Confirmed repository fact — A.** Airi stores chat session records in a local repository backed by browser storage and maintains a session index by user and character. It supports loading, creating, forking, switching, deleting, importing, and exporting sessions.

**Important qualification.** The local append path creates a new message array and saves a session record. That is safe enough under its serialized client persistence queue, but it is still a session snapshot model rather than an append-only durable event store.

#### 5.2.2 Cross-device synchronization and outbox

**Confirmed repository fact — A.** For signed-in users, Airi:

- writes cloud-bound authored messages to an IndexedDB outbox before network dispatch;
- assigns stable client message IDs;
- retries after reconnect/reconcile;
- uses server sequence cursors for gap filling;
- batches messages in queued order per session;
- relies on idempotent client-supplied message IDs;
- retains terminally failed entries for visibility/manual recovery;
- uses deletion tombstones to prevent remote data from resurrecting locally deleted sessions.

Source:

https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/stage-ui/src/stores/chat/session-store.ts

**Architectural lesson.** This is the most directly reusable upstream pattern for DC_BOT’s **durable intent and reconciliation** problem, although DC_BOT’s delivery target is Discord/TTS rather than a cloud chat mirror.

#### 5.2.3 Session and identity separation

**Confirmed repository fact — A.** The session index is scoped by the authenticated Airi user and character. The inspected paths demonstrate user/session/character separation, but they do not establish a platform-person identity model with Discord actor snapshots, guild-scoped aliases, or same-alias collision protection.

**Recommendation — H.** Borrow the explicit user/character/session scoping and stale-user epoch guards, but adapt them to Discord identity and room authorization.

#### 5.2.4 Context compaction and prompt placement

**Confirmed repository fact — A.** Airi’s core compaction keeps recent turns and can place a caller-supplied summary before the exact tail. If no summary is supplied, it inserts a deterministic count-style marker. This is context projection, not a semantic-memory extractor.

**Confirmed repository fact — A.** Airi emits a stable `[Context]` block and intentionally omits volatile IDs/timestamps for cache-friendly prompt structure.

**Not proven.** The inspected code supports stable prompt shape, but it does not prove that every provider uses explicit cache-control directives or that cache-hit economics are measured.

#### 5.2.5 Semantic memory and retrieval

**Confirmed repository fact — A.** The inspected `packages/memory-pgvector/src/index.ts` is only a small module entry point with an empty configuration handler; it does not establish a production pgvector memory implementation.

**Confirmed proposal status — D.** Issue `#879` proposes a unified semantic layer, time decay, weighting, and related behavior. It is open and has no verified linked implementation branch or pull request in the inspected evidence.

**Conclusion.** Airi’s “Memory Alaya” direction must be treated as roadmap/proposal evidence, not as a finished upstream system.

#### 5.2.6 Privacy, deletion, and export

**Confirmed repository fact — A.** Airi can export/import chat sessions, delete local sessions, attempt soft deletion of mapped cloud chats, and maintain tombstones for retry.

**Not proven.** The inspected session deletion path does not prove deletion of future semantic derivatives, embeddings, summaries, model-provider caches, analytics copies, or backups. Those concerns become mandatory if broader memory retention is introduced.

#### 5.2.7 Multi-process consistency

**Confirmed repository fact — A.** Airi has cross-tab authority/follower synchronization and server reconciliation. This is stronger than a single uncoordinated browser store.

**Limitation.** Cross-tab coordination and cloud synchronization do not by themselves define the correctness of a multi-writer semantic-memory service. They are reusable synchronization patterns, not proof of a general distributed memory authority.

---

### 5.3 AstrBot current state

#### 5.3.1 Conversation persistence and selection

**Confirmed repository fact — A.** AstrBot separates a unified message origin/session from multiple conversations. A session can select, create, switch, and delete conversations.

Source:

https://raw.githubusercontent.com/AstrBotDevs/AstrBot/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/conversation_mgr.py

This is a useful product baseline: “where the conversation occurs” is not identical to “which conversation record is active.”

#### 5.3.2 Whole-history replacement

**Confirmed repository fact — A.** A conversation’s content is represented as a message-list payload. `update_conversation` serializes/replaces the history. `add_message_pair` loads the record, appends the user and assistant messages, then writes the entire content.

**Confirmed repository fact — A.** The observed SQLite update sets the content field; no version predicate or compare-and-swap token was observed in the update path.

**Inference — H.** An in-process per-origin lock reduces races inside one process, but the read–append–replace pattern can lose updates if multiple processes or independent writers target the same conversation. The current model should not be copied as DC_BOT’s durable concurrent event authority.

#### 5.3.3 Multi-user attribution

**Confirmed repository fact — A.** AstrBot’s separate `PlatformMessageHistoryManager` records `sender_id` and `sender_name` in addition to the platform instance and the group’s unified origin. That preserves useful group attribution in the platform-history layer.

**Limitation.** The main LLM conversation is still a role/content message list. The inspected evidence does not establish a durable many-to-many causal graph between several human events and one assistant response.

#### 5.3.4 Compression and voice path

**Confirmed repository fact — A.** AstrBot supports `truncate_by_turns` and `llm_compress`, a compression instruction, keep-recent ratio, and an optional compression provider. Those options are passed to `AgentRunner.reset`, and reset is awaited while the request holds an in-process session lock.

**Inference — H.** When compression invokes an LLM, it is on the request path and can add latency and failure modes before the live response. That may be acceptable for asynchronous text, but it is not an appropriate default for DC_BOT’s voice-critical path.

#### 5.3.5 Aborted output and delivery

**Confirmed repository fact — A.** AstrBot can save history when the agent runner reports `was_aborted()`. The code contains a commented-out marker that would have made the preserved partial output explicit.

**Limitation.** Provider statistics can classify a run as completed, aborted, or error, but this is not the same as a durable transport-delivery record. The inspected conversation update does not encode whether text was sent, audio began, audio completed, a user heard only part, or a crash left delivery unknown.

**Recommendation — H.** Store generated content separately from delivery attempts. Never infer “delivered” solely because generation completed or history was saved.

#### 5.3.6 Retrieval, privacy, and deletion

**Confirmed repository fact — A.** AstrBot has knowledge-base and platform-message-history capabilities beyond the main conversation list, but this inspection did not verify a provenance-rich semantic fact store with temporal validity, contradiction handling, or scope-aware person memory.

**Confirmed repository fact — A.** Conversations and platform-history records can be deleted.

**Not proven.** Complete cascading erasure across summaries, embeddings, provider caches, backups, and all plugin-owned derivatives was not established.

---

### 5.4 State-of-the-art research lessons

#### 5.4.1 Separate thread/room state from long-term namespace

**External research finding — E.** LangGraph’s official memory model distinguishes thread-scoped short-term state from long-term data stored under custom namespaces:

https://docs.langchain.com/oss/python/concepts/memory

**Lesson.** DC_BOT should similarly separate:

- exact recent logical-room context;
- person-level memory authorized to cross rooms/modalities;
- character-specific memory;
- private-conversation memory;
- operator-authored procedures.

A namespace mechanism is useful only if authorization and alias-scope rules are explicit.

#### 5.4.2 Evaluate temporal updates and abstention, not only recall

**External research finding — G.** LongMemEval tests information extraction, multi-session reasoning, temporal reasoning, knowledge updates, and abstention:

https://arxiv.org/abs/2410.10813

**Lesson.** A memory system that retrieves an old preference confidently after the user corrected it is worse than one that abstains.

#### 5.4.3 Multi-party memory is not concatenated one-to-one memory

**External research finding — G.** GroupMemBench explicitly evaluates group dynamics, speaker-grounded belief tracking, audience-adapted language, knowledge updates, ambiguity, temporal reasoning, and abstention:

https://arxiv.org/abs/2605.14498

**External research finding — G.** EverMemBench studies multi-party, multi-group, temporally evolving conversations with role-specific personas and reports major difficulty in multi-hop and temporal reasoning:

https://arxiv.org/abs/2602.01313

**Lesson.** Durable speaker identity and query-time audience scope are first-class requirements, not optional metadata.

#### 5.4.4 Dynamic information requires validity and supersession

**External research finding — G.** DynamicMem focuses on retaining facts that remain true while replacing facts that change:

https://arxiv.org/abs/2606.22877

**Lesson.** Memory records need `valid_from`, `valid_to`, provenance, confidence, and correction/supersession relationships. “Latest timestamp wins” is not always enough: a later speculative assistant statement must not supersede an earlier direct user assertion.

#### 5.4.5 Graph and vector storage are hypotheses, not conclusions

**Inference — H.** The inspected benchmarks define hard memory behaviors; they do not prove that graph storage is universally superior, nor that arbitrary vector similarity weights generalize to DC_BOT.

**Recommendation — H.** Start with authorization, exact structured lookup, validity filtering, and lexical retrieval. Add vectors, learned rerankers, or graph traversal only when an evaluation shows a statistically and operationally meaningful gain.

#### 5.4.6 PostgreSQL FTS is configurable, not magically multilingual

**External research finding — E.** PostgreSQL full-text search converts documents and queries through text-search configurations, parsers, and dictionaries:

https://www.postgresql.org/docs/current/textsearch-controls.html

GIN is the preferred built-in text-search index type:

https://www.postgresql.org/docs/current/textsearch-indexes.html

**Inference — H.** These facts do not establish acceptable Chinese/Japanese tokenization or mixed-language recall for DC_BOT. CJK and multilingual retrieval require a corpus-specific benchmark and possibly an extension or alternate tokenizer.

---

## 6. Comparative capability matrix

| Capability | DC_BOT current | Airi current | AstrBot current | State-of-art lesson | Borrow | Adapt | Reject | Not yet proven |
|---|---|---|---|---|---|---|---|---|
| **1. Conversation persistence** | In-memory bounded voice history and separate in-memory text rooms; lost on restart. **A** | IndexedDB-backed sessions plus optional cloud synchronization. **A** | SQLite-backed conversations and platform history. **A** | Persistence is necessary but should preserve attributable source records, not only prompt transcripts. | Airi local-first persistence; AstrBot selectable conversations. | Store exact events and derived views separately. | Process-local history as production authority. | Retention/deletion behavior for derived memory. |
| **2. Append events vs whole-history replacement** | Appends to in-memory arrays; no durable event log. **A** | Local append creates a new list and saves a whole session record; cloud sync sends individual ID-addressed messages. **A** | Read–append–replace of serialized whole history. **A** | Durable append plus idempotent IDs is safer for concurrent writers; projections may be replaceable with versions. | Airi client message IDs/outbox. | Append raw events; version/CAS only derived projections. | AstrBot whole-history replacement as the canonical concurrent model. | Optimal compaction boundary under DC_BOT load. |
| **3. Session/conversation separation** | Per-guild voice session; room helpers exist but active voice scope is guild-level. Text uses separate room store. **A** | User → character → sessions, including fork/switch. **A** | Unified origin/session can select multiple conversations. **A** | Physical transport location, logical conversation, character, and person memory are distinct axes. | Airi and AstrBot explicit selectable sessions. | Introduce logical rooms and explicit channel bindings. | Implicit cross-channel sharing. | Product UX for binding/switching logical rooms. |
| **4. Identity representation** | `userId` plus `displayName`; no complete current/historical profile model. **A** | Auth user and character scoping; no verified Discord-like person/alias model in inspected path. **A/H** | Unified origin and sender fields exist; no verified cross-platform identity proof model. **A/H** | Platform IDs identify platform principals; aliases are scoped attributes. | Stable platform actor ID as the durable key. | Actor snapshots + current profile + scoped aliases. | Username/display name as identity key; automatic cross-platform merging. | Verified account-linking protocol. |
| **5. Multi-user/group attribution** | Individual events survive aggregation, then committed speaker becomes `"Discord group"`. **A** | Inspected chat session path is not proof of multi-party durable attribution. | Platform history stores `sender_id`/`sender_name`; main conversation remains role/content. **A** | Group memory needs speaker-grounded and audience-grounded records. | DC_BOT source event preservation; AstrBot sender fields. | Many-to-many response causes and opaque prompt-local person refs. | Synthetic durable authors and alias-based merging. | Benchmarked group-memory quality. |
| **6. Compression/summary** | Bounded trim; summary field exists but generator not verified. **A** | Deterministic compaction with optional summary and exact recent tail. **A** | Configurable truncation or LLM compression. **A** | Derived summaries need provenance, versioning, invalidation, and asynchronous generation. | Airi exact-tail projection. | Generate summaries off-path and atomically replace only the derived projection. | Synchronous LLM compression in the voice-critical path. | Summary quality and regeneration thresholds. |
| **7. Semantic-memory extraction** | Not verified. | `memory-pgvector` shell on default branch; unified semantic layer is open proposal. **A/D** | No provenance-rich semantic extractor verified in inspected path. | Extraction output is uncertain derived data, not raw truth. | None wholesale. | Background candidate extraction with confidence and provenance. | Treating model inference as user fact. | Extraction model, schema, and precision target. |
| **8. Temporal correction/invalidation** | Not verified. | Proposed concepts exist, but production semantics not verified. **D/H** | Not verified in main conversation model. | Benchmarks require knowledge updates, temporal reasoning, and abstention. | None directly. | Validity intervals, supersession, contradiction queue, source ranking. | Unqualified “latest write wins.” | Conflict-resolution policy for ambiguous corrections. |
| **9. Retrieval architecture** | Recent bounded history only. | Cloud sequence sync and session loading; semantic retrieval proposal unproven. **A/D** | Recent conversation plus knowledge/platform-history mechanisms. **A** | Authorize first; exact/temporal/lexical retrieval before vectors/graphs. | Structured session/room filters. | Hybrid retrieval behind an evaluation interface. | Graph/vector adoption by fashion or vendor claim. | CJK tokenizer, embedding model, reranker, graph benefit. |
| **10. Prompt placement/cache** | Speaker-labeled history; group prompt quotes names. **A** | Stable `[Context]` projection omits volatile data for cache-friendly shape. **A** | Dynamic system prompt assembly; explicit provider cache controls not verified. **A/H** | Stable invariant prefixes can improve provider caching, but private data and freshness must remain scoped. | Airi deterministic prompt layout. | Put policy/character before volatile retrieved memory; serialize memory as untrusted data. | Raw memory concatenation that permits fake roles/delimiters. | Provider-specific cache hit rates and privacy implications. |
| **11. Privacy scopes** | DM/text/voice room IDs exist; no full alias/memory authorization model. **A** | User isolation and character sessions; auth-user swap guards prevent stale leakage. **A** | Per-origin conversations; no comprehensive person/guild/private memory policy verified. | Scope is an authorization rule, not only a retrieval filter. | Airi stale-user epoch clearing. | Explicit DM, guild, room, character, person, and alias scopes. | Private alias leakage into public guild prompts. | Cross-guild/person policy and operator UX. |
| **12. Deletion/export** | In-memory clear only; no durable export/erasure workflow. **A** | Session delete, cloud tombstones, import/export. **A** | Conversation and platform-history deletion. **A** | Deletion must cascade to summaries, vectors, caches, exports, and backups under a declared policy. | Airi tombstones/retry and export format versioning. | Add deletion jobs and derivative invalidation ledger. | Claiming deletion complete after deleting one primary row. | Backup erasure SLA and provider-cache controls. |
| **13. Multi-process consistency** | No durable multi-process authority. | Cross-tab authority plus cloud sequence reconciliation and idempotent messages. **A** | In-process per-origin lock; whole-history DB update. **A** | Idempotent commands, append records, versioned projections, and reconciliation are safer than mutable snapshots. | Airi outbox/sequence/idempotency patterns. | DB transactions and uniqueness constraints; introduce service only when needed. | Assuming an in-process lock protects multiple bot instances. | Required deployment topology and write volume. |
| **14. Voice-latency suitability** | Designed for direct voice pipeline; no durable memory query yet. **A** | Browser chat sync is not evidence of voice-path latency. | Live mode exists; optional LLM compression can run before response. **A** | Voice path should use bounded, precomputed retrieval; extraction/summary/embedding stay asynchronous. | DC_BOT epoch/interrupt handling. | Hard latency budgets for memory query and prompt assembly. | Synchronous semantic extraction or compression before TTS. | P50/P95/P99 memory budget on production hardware. |
| **15. Delivery/crash recovery** | Playback-drain-before-history commit, but no durable state/outbox. **A** | Durable cloud outbox, retry, idempotent IDs, tombstones. **A** | Generation/history save exists; no verified durable Discord/TTS delivery ledger. **A/H** | Generation, persistence, and transport delivery are separate state machines. | Airi outbox/reconciliation; DC_BOT supersession checks. | Delivery attempts with target-specific acknowledgements and unknown-state recovery. | Pretending DB and Discord/TTS commit atomically. | Best confirmation signal for “heard” voice output. |
| **16. Evaluation methodology** | Voice latency benchmark only. **A** | No inspected benchmark proving Alaya production behavior. | Product features, no inspected comprehensive memory benchmark. | Evaluate recall, updates, abstention, groups, privacy, deletion, concurrency, cost, and latency. | Existing voice timing harness. | Add LongMemEval-style and group/dynamic tests with DC_BOT traces. | Vendor leaderboard claims as acceptance evidence. | Target thresholds and representative datasets. |
| **17. Operational complexity** | Lowest current complexity; no durable memory guarantees. | Browser DB, cloud WS, outbox, reconciliation, tombstones. **A** | SQLite/DB plus plugins, providers, locks, compression. **A** | Add infrastructure only for a measured requirement. | Simple in-process adapter boundary. | SQLite first, PostgreSQL/service migration path. | Mandatory HTTP microservice before deployment need is demonstrated. | Multi-instance roadmap, HA, and data residency. |

---

## 7. Proposed decisions

### ADR-001 — Begin with an in-process MemoryPort

**Classification:** Recommendation — H  
**Decision:** Implement memory as a transport-neutral application/domain interface inside the Discord bot process for milestone one.

**Initial adapter:** SQLite with WAL enabled, explicit migrations, foreign keys, busy timeout, transaction retries, and a single write policy.

**Migration path:** PostgreSQL adapter and optional standalone Memory Runtime using the same contract.

**Rationale:**

1. DC_BOT currently runs direct orchestration in one bot process.
2. No inspected evidence establishes an immediate need for independent memory scaling.
3. A mandatory HTTP hop adds latency, authentication, deployment, observability, retry, versioning, and partial-failure concerns.
4. The port boundary preserves future separation without paying those costs immediately.

**Promotion criteria to standalone runtime:**

- more than one independent bot/process must write the same memory authority;
- memory workers need a different runtime or release cadence;
- measured DB contention exceeds the SQLite envelope;
- independent scaling/HA/data residency is required;
- operators require central policy enforcement across several clients.

### ADR-002 — Raw events are append-oriented; projections are versioned and replaceable

**Classification:** Recommendation — H

- Inbound user events are durable attributable records.
- Generated assistant responses are separate durable records.
- Prompt-ready recent history, summaries, embeddings, and graphs are derived projections.
- Appending a new event does **not** require rejecting an ordinary commit merely because another event arrived during generation.
- A generation records the room snapshot version or event frontier it observed as evidence.
- Compare-and-swap is used when replacing a derived projection based on a specific source frontier, not for every independent raw append.

This resolves critical risk **B** from the source plan.

### ADR-003 — Discord identity is platform-scoped

**Classification:** Recommendation — H

`discord:user:<snowflake>` identifies a Discord account/principal. It must not automatically merge with an identity from another platform. Cross-platform linkage requires an explicit verified account-link procedure and a reversible link record.

This resolves critical risk **F**.

### ADR-004 — Preserve event-time actor snapshots and a separate current profile

**Classification:** Recommendation — H

Every inbound event stores the best available presentation snapshot. Current addressing reads from a separate current profile and allowed alias records. Event snapshots are immutable except for privacy redaction.

To control write amplification:

- always persist the event snapshot;
- update the current profile only when a normalized field changes, a minimum refresh interval expires, or a trusted member-update event arrives;
- do not create a new alias row for every repeated observation.

This resolves critical risk **G**.

### ADR-005 — Logical rooms require explicit binding

**Classification:** Recommendation — H

Physical Discord channels and logical conversation rooms are separate. A physical room maps to one logical room at a time unless an operator explicitly configures a more complex binding. Cross-channel recent history is prohibited by default.

### ADR-006 — Response causality is many-to-many

**Classification:** Recommendation — H

An assistant response can be caused by one or more inbound events. Use a join table, not a single `user_event_id`.

This resolves critical risk **D**.

### ADR-007 — Delivery is separate from generation and memory persistence

**Classification:** Recommendation — H

Generated content, attempted sends/playback, and confirmed delivery are separate records. Discord/TTS cannot participate in the database transaction, so the design must expose and reconcile crash windows.

This resolves critical risk **C**.

### ADR-008 — “Immutable event” means immutable payload plus append-only state transitions

**Classification:** Recommendation — H

Do not mutate the original event content/lifecycle field in place while also claiming full immutability. Use:

- immutable source payload;
- append-only event-state or delivery-transition records;
- explicit redaction/tombstone overlays for privacy actions;
- optionally encrypted payloads with key destruction where legally/operationally appropriate.

This resolves critical risk **E**.

### ADR-009 — Asynchronous derived memory

**Classification:** Recommendation — H

Summarization, fact extraction, embeddings, graph construction, and contradiction reconciliation run outside the voice-critical path. The live path consumes only committed, authorized, precomputed material and bounded exact recent events.

### ADR-010 — Retrieval starts simple and benchmarked

**Classification:** Recommendation — H

Retrieval order:

1. authorization and scope filtering;
2. exact identifiers and structured fields;
3. validity/temporal filtering;
4. lexical/full-text retrieval;
5. optional vector recall;
6. optional learned reranking;
7. optional graph expansion.

Every later stage must demonstrate incremental benefit against cost, latency, privacy, deletion complexity, and failure behavior.

### ADR-011 — Production write failure is explicit

**Classification:** Recommendation — H

If the durable authority rejects or cannot commit a write, production must not silently continue with an unrelated ephemeral history while reporting success. Permitted behaviors:

- fail closed for memory-dependent operations;
- continue in a visibly degraded no-retention mode only when product policy explicitly allows it;
- surface health/telemetry and retry status;
- never acknowledge persistence that did not occur.

---

## 8. Alternatives considered

### Alternative A — Mandatory HTTP Memory Runtime immediately

**Advantages:**

- clean process boundary;
- centralized authorization;
- easier multi-client access;
- independent scaling and deployment.

**Costs:**

- network latency in the voice path;
- new authentication and service-discovery requirements;
- retries and idempotency at another boundary;
- another schema/API compatibility surface;
- more difficult local development and single-node operation.

**Outcome:** Deferred. Use a port that can later be hosted behind HTTP/gRPC.

### Alternative B — PostgreSQL from milestone one

**Advantages:**

- stronger concurrent multi-process capability;
- mature indexing and operational tooling;
- easier future centralization.

**Costs:**

- external service requirement for every deployment;
- higher setup/backup/credential complexity;
- no verified current workload requiring it.

**Outcome:** Supported as a planned adapter, not required for first implementation.

### Alternative C — Reuse AstrBot-style serialized whole history

**Advantages:**

- simple application model;
- easy prompt reconstruction;
- easy conversation export.

**Costs:**

- lost-update risk under independent writers;
- expensive rewrites as history grows;
- difficult event provenance and many-to-many causality;
- deletion/correction semantics become coarse;
- delivery lifecycle is entangled with transcript content.

**Outcome:** Rejected as canonical storage. A serialized transcript may exist as a versioned derived projection.

### Alternative D — Copy Airi’s complete chat/session model

**Advantages:**

- strong client outbox and synchronization mechanics;
- robust deletion tombstones;
- import/export and session UX.

**Costs:**

- browser/client assumptions;
- user/character/session model does not directly express Discord guild, logical room, per-speaker group attribution, or voice delivery;
- local session persistence still uses whole-record snapshots.

**Outcome:** Borrow outbox, idempotency, reconciliation, tombstones, epoch guards, and export versioning; adapt the domain model.

### Alternative E — Synchronous LLM summarization before every generation

**Advantages:**

- compact context immediately;
- conceptually straightforward.

**Costs:**

- unpredictable voice latency;
- another provider failure in the critical path;
- can overwrite or distort provenance;
- repeated cost and cache churn.

**Outcome:** Rejected for the live voice path.

### Alternative F — Graph-first memory

**Advantages:**

- potentially useful for explicit relations and multi-hop traversal.

**Costs:**

- extraction errors become graph edges;
- temporal correction and deletion become harder;
- no inspected evidence proves superiority for DC_BOT;
- operational and query complexity.

**Outcome:** Not adopted until a benchmark demonstrates value over structured/lexical/vector baselines.

---

## 9. Rejected alternatives and reasons

| Rejected alternative | Reason |
|---|---|
| A username, nickname, alias, avatar, or voice embedding as the primary person key | Presentation fields change and collide; voice characteristics are probabilistic attributes. |
| Automatic cross-platform person merge | A Discord identity is not proof of the same human on another platform. |
| One durable author named `"Discord group"` | It destroys speaker provenance and makes corrections/privacy requests unsafe. |
| One `user_event_id` on every assistant response | Group and accumulated-trigger responses can have several causes. |
| Reject every append when the room snapshot changed during generation | Independent new events do not invalidate an already-generated response; record the observed frontier instead. |
| Treat generated output as delivered when persisted | Database commit and Discord send/TTS playback are not atomic. |
| Mutate a raw event’s lifecycle status while calling the entire row immutable | Payload immutability and lifecycle transitions need separate semantics. |
| Update identity/alias tables on every event even when values are unchanged | Causes write amplification without improving historical evidence. |
| Put extraction, embeddings, graph construction, contradiction resolution, or LLM compression in the live voice path | Adds unpredictable latency and failure modes. |
| Assume PostgreSQL default FTS is sufficient for CJK/multilingual use | Tokenization and configuration must be measured on the target corpus. |
| Silent fallback to process-local memory after durable write failure | Produces false persistence guarantees and split-brain user experience. |

---

## 10. Normative specification and detailed plan

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are normative.

### 10.1 Identity requirements

**REQ-ID-001.** The durable Discord actor key MUST be the Discord user ID namespaced by platform, for example `discord:user:<id>`.

**REQ-ID-002.** Usernames, global display names, guild nicknames, aliases, avatars, and voice characteristics MUST NOT be primary identity keys.

**REQ-ID-003.** Every inbound user event MUST include an event-time actor snapshot containing all fields available without extra critical-path network calls:

- Discord user ID;
- username where available;
- global display name where available;
- guild nickname where applicable;
- avatar references/hashes where available;
- guild ID and channel ID where applicable;
- source and observation timestamp.

**REQ-ID-004.** The current profile MUST be stored separately from event-time snapshots.

**REQ-ID-005.** Current-profile updates SHOULD be conditional on a material field change or refresh policy, not written unconditionally on every event.

**REQ-ID-006.** Cross-platform identity links MUST require explicit verified linkage and MUST be reversible.

**REQ-ID-007.** Voice embeddings or speaker characteristics MAY assist attribution only after Discord session/user mapping; they MUST NOT silently create or merge durable people.

### 10.2 Alias and scope requirements

**REQ-SCOPE-001.** Preferred aliases MUST include a scope type and scope identifier.

Permitted initial scope types:

- `platform`;
- `character_global`;
- `guild`;
- `logical_room`;
- `private_conversation`.

**REQ-SCOPE-002.** A private-conversation alias MUST NOT be emitted or retrieved in a public guild context.

**REQ-SCOPE-003.** Alias equality MUST NOT merge identities.

**REQ-SCOPE-004.** Prompt serialization MUST use opaque prompt-local person references such as `P1`, `P2`, while preserving a separate mapping to permitted display labels.

**REQ-SCOPE-005.** Opaque internal IDs MUST NOT be printed or spoken to users.

### 10.3 Event requirements

**REQ-EVENT-001.** Each inbound text or voice contribution used by the bot MUST be stored as its own attributable event.

**REQ-EVENT-002.** Group voice input MUST preserve one event per speaker contribution after segmentation. Adjacent same-speaker segments MAY be merged only when the source IDs and time range remain recoverable.

**REQ-EVENT-003.** The durable author of a user event MUST be a real platform actor or an explicit system actor; it MUST NOT be `"Discord group"`.

**REQ-EVENT-004.** Raw event payloads SHOULD be immutable after commit, except through an explicit privacy-redaction mechanism.

**REQ-EVENT-005.** Lifecycle changes MUST be represented as append-only transition records or a clearly documented mutable operational projection.

**REQ-EVENT-006.** Event IDs MUST be idempotency keys at ingestion. Duplicate delivery from Discord or internal retries MUST NOT create duplicate durable events.

**REQ-EVENT-007.** Event ordering MUST use both observed timestamps and a durable append sequence. Timestamps alone MUST NOT establish a total order.

### 10.4 Room requirements

**REQ-SCOPE-010.** A physical Discord room and a logical conversation room MUST be separate entities.

**REQ-SCOPE-011.** Physical-to-logical room bindings MUST be explicit and auditable.

**REQ-SCOPE-012.** Unbound channels MUST receive isolated logical rooms by default.

**REQ-SCOPE-013.** DMs MUST be isolated from guild rooms unless a user-authorized person-memory policy permits a specific derived memory to cross the boundary.

**REQ-SCOPE-014.** Recent exact room history MUST NOT cross physical channels merely because they share a guild.

### 10.5 Response causality requirements

**REQ-EVENT-020.** Assistant responses MUST have their own durable response IDs.

**REQ-EVENT-021.** A response MUST relate to zero or more causal events through a join relation.

**REQ-EVENT-022.** The relation MUST support ordering or contribution metadata where several events triggered one response.

**REQ-EVENT-023.** A generation record MUST capture the source frontier/snapshot version it observed.

**REQ-EVENT-024.** An ordinary response append MUST NOT be rejected solely because newer unrelated events arrived after generation began.

### 10.6 Delivery requirements

**REQ-DELIVERY-001.** Generation, persistence, text send, and voice playback MUST be modeled separately.

**REQ-DELIVERY-002.** Each transport attempt MUST have a durable idempotency key and target.

**REQ-DELIVERY-003.** Initial delivery states MUST include:

- `planned`;
- `started`;
- `delivered`;
- `partially_delivered`;
- `failed`;
- `interrupted`;
- `unknown`.

**REQ-DELIVERY-004.** A response MUST NOT enter normal completed recent history merely because generation completed.

**REQ-DELIVERY-005.** Prompt projection MUST distinguish delivered, interrupted, failed, and unknown outputs.

**REQ-DELIVERY-006.** Crash recovery MUST reconcile attempts left in `started` or `unknown`.

**REQ-DELIVERY-007.** Voice delivery SHOULD record measurable playback evidence such as queued duration, started timestamp, drained timestamp, interruption position, and reason.

**REQ-DELIVERY-008.** The system MUST NOT claim exactly-once delivery. It SHOULD provide idempotent attempt creation and at-least-once reconciliation where the transport permits.

### 10.7 Memory-layer requirements

**REQ-MEM-001.** The system MUST distinguish:

- raw attributable events;
- recent exact context;
- room summaries;
- semantic facts/preferences;
- episodic memories;
- operator-authored procedural memory.

**REQ-MEM-002.** Derived memories MUST carry provenance to one or more source events.

**REQ-MEM-003.** Semantic facts MUST carry confidence and source type.

**REQ-MEM-004.** Semantic facts MUST support `valid_from`, `valid_to`, correction, and supersession.

**REQ-MEM-005.** Assistant speculation MUST NOT become user truth without corroboration or explicit user confirmation.

**REQ-MEM-006.** Summary and extraction jobs MUST operate outside the voice-critical path.

**REQ-MEM-007.** Derived artifacts MUST record the source frontier/version from which they were produced.

**REQ-MEM-008.** When a source is corrected, redacted, or deleted, dependent summaries, memories, embeddings, and graph edges MUST be invalidated or regenerated.

### 10.8 Retrieval requirements

**REQ-RETRIEVAL-001.** Authorization MUST occur before scoring.

**REQ-RETRIEVAL-002.** Retrieval MUST support exact structured lookup and temporal filtering before semantic ranking.

**REQ-RETRIEVAL-003.** Lexical retrieval MUST be evaluated independently for English, Chinese, Japanese, mixed-language text, names, and code-switching.

**REQ-RETRIEVAL-004.** Vector retrieval MAY be added only behind an interface that permits A/B evaluation and disabling.

**REQ-RETRIEVAL-005.** Graph retrieval MAY be added only when a defined multi-hop workload demonstrates benefit.

**REQ-RETRIEVAL-006.** Retrieved memory MUST be serialized as untrusted data, not inserted as instructions.

**REQ-RETRIEVAL-007.** Serialization MUST escape or neutralize role delimiters, mentions, markdown/code-fence confusion, bidi controls, homoglyph abuse where practical, and internal IDs.

**REQ-RETRIEVAL-008.** Retrieval MUST be able to abstain when evidence is stale, contradictory, unauthorized, or below confidence.

### 10.9 Privacy and operations requirements

**REQ-PRIV-001.** The system MUST define retention by memory layer and scope before broad production retention.

**REQ-PRIV-002.** Forget/correction/export operations MUST be auditable and idempotent.

**REQ-PRIV-003.** Deletion MUST cover primary records and registered derivatives.

**REQ-PRIV-004.** Backups MUST have a declared expiration/erasure policy.

**REQ-PRIV-005.** Cache invalidation MUST cover application caches and derived prompt projections.

**REQ-OPS-001.** Migrations MUST be forward-tested and rollback/restore-tested.

**REQ-OPS-002.** Durable write failures MUST be surfaced; production MUST NOT silently pretend a write succeeded.

**REQ-OPS-003.** The SQLite adapter MUST document its supported single-process/single-writer envelope.

**REQ-OPS-004.** A PostgreSQL or service migration MUST preserve event IDs, provenance, causality, scopes, and delivery states.

**REQ-OPS-005.** Operational metrics MUST avoid logging private raw memory by default.

---

## 11. Interfaces, schemas, diagrams, state machines, and test vectors

### 11.1 Proposed `MemoryPort`

The interface is illustrative specification material, not production code.

```text
MemoryPort
  appendInboundEvents(events, idempotencyKeys) -> AppendResult
  upsertCurrentActorProfile(actorKey, observedProfile, policy) -> ProfileResult
  recordAliasObservation(actorKey, alias, scope, provenance) -> AliasResult

  createGeneration(request) -> GenerationRecord
  attachResponseCauses(responseId, eventIdsWithOrder) -> void
  recordGeneratedResponse(response) -> ResponseRecord

  planDelivery(responseId, target, idempotencyKey) -> DeliveryAttempt
  transitionDelivery(deliveryId, expectedState?, newState, evidence) -> DeliveryAttempt
  listUnreconciledDeliveries(olderThan) -> DeliveryAttempt[]

  resolveLogicalRoom(physicalRoom, actorContext) -> LogicalRoom
  bindPhysicalRoom(physicalRoom, logicalRoom, authorization) -> Binding

  queryRecentContext(authz, logicalRoom, frontier, limits) -> ExactContext
  queryPersonMemory(authz, actorKey, characterId, query, asOf) -> MemoryResult[]
  queryProcedures(authz, characterId, query) -> ProcedureResult[]

  proposeMemoryCandidates(sourceEventIds) -> Candidate[]
  acceptMemoryCandidate(candidateId, adjudication) -> MemoryItem
  correctMemory(memoryId, correction, provenance) -> MemoryItem
  supersedeMemory(oldId, replacementId, reason) -> void

  redactSubject(subjectKey, scope, requestId) -> RedactionJob
  exportSubject(subjectKey, scope, requestId) -> ExportManifest
  getPrivacyJob(requestId) -> PrivacyJobStatus
```

### 11.2 Minimal logical schema

```text
actor_identity(
  actor_key PK,
  platform,
  platform_actor_id,
  created_at
)

actor_profile_current(
  actor_key PK/FK,
  username,
  global_display_name,
  avatar_ref,
  observed_at,
  source_event_id,
  profile_version
)

alias(
  alias_id PK,
  actor_key FK,
  scope_type,
  scope_id,
  alias_text,
  valid_from,
  valid_to,
  visibility,
  provenance_event_id,
  UNIQUE(actor_key, scope_type, scope_id, alias_text, valid_from)
)

physical_room(
  physical_room_id PK,
  platform,
  guild_id,
  channel_id,
  medium
)

logical_room(
  logical_room_id PK,
  character_id,
  privacy_class,
  created_at
)

room_binding(
  binding_id PK,
  physical_room_id FK,
  logical_room_id FK,
  valid_from,
  valid_to,
  configured_by
)

inbound_event(
  event_id PK,
  idempotency_key UNIQUE,
  logical_room_id FK,
  physical_room_id FK,
  actor_key FK,
  modality,
  occurred_at,
  appended_seq,
  actor_snapshot_json,
  payload_json,
  payload_hash,
  privacy_state
)

event_transition(
  transition_id PK,
  event_id FK,
  transition_type,
  occurred_at,
  evidence_json
)

generation(
  generation_id PK,
  logical_room_id FK,
  character_id,
  observed_frontier_seq,
  prompt_policy_version,
  model_ref,
  started_at,
  completed_at,
  status
)

assistant_response(
  response_id PK,
  generation_id FK,
  content_json,
  content_hash,
  generated_at
)

response_cause(
  response_id FK,
  event_id FK,
  cause_order,
  cause_role,
  PRIMARY KEY(response_id, event_id)
)

delivery_attempt(
  delivery_id PK,
  response_id FK,
  target_json,
  idempotency_key UNIQUE,
  state,
  started_at,
  completed_at,
  delivered_fraction,
  evidence_json,
  last_error
)

delivery_transition(
  transition_id PK,
  delivery_id FK,
  from_state,
  to_state,
  occurred_at,
  evidence_json
)

room_summary(
  summary_id PK,
  logical_room_id FK,
  source_from_seq,
  source_to_seq,
  summary_text,
  generator_ref,
  created_at,
  invalidated_at
)

memory_item(
  memory_id PK,
  subject_actor_key FK,
  character_id,
  scope_type,
  scope_id,
  memory_kind,
  content_json,
  confidence,
  valid_from,
  valid_to,
  superseded_by,
  created_at,
  invalidated_at
)

memory_provenance(
  memory_id FK,
  event_id FK,
  evidence_role,
  PRIMARY KEY(memory_id, event_id)
)

derived_artifact(
  artifact_id PK,
  artifact_type,
  source_frontier,
  source_ids_json,
  storage_ref,
  invalidated_at
)

privacy_job(
  request_id PK,
  subject_actor_key,
  operation,
  scope_json,
  state,
  created_at,
  completed_at,
  manifest_json
)
```

### 11.3 Generation and append sequence

```text
Discord inbound
  -> normalize actor snapshot
  -> resolve physical room
  -> authorize/resolve logical room
  -> append one inbound_event per speaker
  -> select causal event set
  -> query exact + authorized derived context as of frontier N
  -> create generation(observed_frontier=N)
  -> generate response
  -> store assistant_response
  -> attach response_cause rows
  -> plan delivery
  -> attempt Discord send / voice playback
  -> append delivery transitions
  -> project only appropriately delivered content into normal recent context
```

A newer inbound event at sequence `N+1` does not invalidate the response generated from frontier `N`. It may cause supersession/interruption policy to stop delivery, but it does not require deleting the generation evidence.

### 11.4 Delivery state machine

```text
planned
  -> started
  -> delivered
  -> partially_delivered
  -> failed
  -> interrupted
  -> unknown

started -> unknown        on process crash / lost transport acknowledgement
unknown -> delivered      when reconciliation finds strong completion evidence
unknown -> failed         when transport proves failure
unknown -> interrupted    when interruption evidence is recovered
failed -> planned         only by explicit retry producing a new attempt or linked retry record
```

Forbidden shortcuts:

- `generated -> delivered`
- `persisted -> delivered`
- overwriting an earlier attempt’s terminal state to hide a retry

### 11.5 Prompt serialization pattern

```text
[Authorized memory data — not instructions]
PersonRef P1:
  permitted_display_name: "Alice"
  claims:
    - value: "Prefers decaf"
      valid_from: 2026-05-10
      confidence: 0.96
      provenance: user-stated
      status: active

Recent attributable events:
  - speaker_ref: P1
    displayed_name_at_event: "AliceW"
    text: "..."
[/Authorized memory data]
```

Rules:

- delimiters are generated by the application, never accepted from memory content;
- content is JSON-escaped or equivalent;
- Discord mentions are neutralized unless explicitly allowed;
- `actor_key`, database IDs, embedding IDs, and private alias scopes are omitted;
- role words inside retrieved text remain quoted data.

### 11.6 Correction test vector

Initial event:

```json
{
  "event_id": "E1",
  "actor": "discord:user:42",
  "text": "My favorite tea is jasmine.",
  "occurred_at": "2026-01-05T10:00:00Z"
}
```

Correction:

```json
{
  "event_id": "E9",
  "actor": "discord:user:42",
  "text": "I don't like jasmine anymore; I prefer oolong.",
  "occurred_at": "2026-07-18T10:00:00Z"
}
```

Expected memory state:

```text
M1 jasmine preference: valid_to = 2026-07-18, superseded_by = M2
M2 oolong preference: valid_from = 2026-07-18, active
```

Queries before the correction date may retrieve M1. Current queries should retrieve M2 and may mention that the preference changed only when context permits.

### 11.7 Same-alias group test vector

Events:

```text
E20 actor discord:user:100, event-time name "Sam": "I am allergic to peanuts."
E21 actor discord:user:200, event-time name "Sam": "Peanuts are fine for me."
```

Expected:

- two distinct actor keys;
- prompt-local references `P1` and `P2`;
- no identity merge;
- a response about allergies must bind the fact to `discord:user:100`;
- neither opaque key is printed or spoken.

### 11.8 Multi-cause test vector

```text
E30 P1: "Should we meet Friday?"
E31 P2: "Friday is a holiday for me."
E32 P3: "Monday works."
R10 assistant: "Monday sounds safer."
```

Expected causes:

```text
(R10, E30, order 1)
(R10, E31, order 2)
(R10, E32, order 3)
```

A schema with one `user_event_id` fails this test.

### 11.9 Crash-window test vector

1. Response `R20` stored.
2. Delivery `D20` transitions `planned -> started`.
3. TTS emits 35% of audio.
4. Process crashes before drain confirmation.

Expected after restart:

- `D20` is `unknown` or `partially_delivered`, never `delivered`;
- recent context does not serialize it as a normal fully heard assistant turn;
- reconciliation records available playback evidence;
- retry policy does not blindly replay without interruption/duplication policy.

---

## 12. Failure modes

| ID | Failure mode | Consequence | Required mitigation |
|---|---|---|---|
| RISK-001 | Separate text and voice memory authorities diverge | Contradictory context and missing continuity | One `MemoryPort` and one durable authority |
| RISK-002 | Same display name merges two users | Privacy breach and false attribution | Platform actor key; aliases never merge |
| RISK-003 | Group aggregate committed as synthetic person | Facts cannot be assigned or deleted correctly | One event per speaker; many-to-many response causes |
| RISK-004 | Guild-scoped voice history crosses channels | Unintended context leakage | Explicit physical/logical room bindings |
| RISK-005 | Whole-history read–append–replace under concurrent writers | Lost turns | Append records, idempotency, transaction constraints |
| RISK-006 | Strict snapshot CAS rejects harmless append after new event | Unnecessary failures and retry storms | Record frontier; CAS only derived replacement |
| RISK-007 | Generated response persisted before failed send and treated as delivered | Model later assumes user heard it | Delivery ledger and prompt-state filtering |
| RISK-008 | Audio partially plays before crash | Duplicate or confusing replay | Partial/unknown state and reconciliation policy |
| RISK-009 | LLM summary in voice path times out | Voice latency spike or no response | Background derivation and exact-tail fallback |
| RISK-010 | Assistant speculation extracted as user fact | Persistent false personalization | Source-type ranking and confirmation |
| RISK-011 | Old fact retrieved after correction | Incorrect personalized answer | Validity and supersession filtering |
| RISK-012 | Private DM alias appears in guild | Privacy leak | Scope authorization before retrieval |
| RISK-013 | Event payload contains fake prompt roles/delimiters | Prompt injection | Structured untrusted-data serialization |
| RISK-014 | Deleting primary event leaves summary/vector | Incomplete erasure | Derivative registry and privacy jobs |
| RISK-015 | Profile table updated every event | Write amplification | Change detection and refresh policy |
| RISK-016 | Guild member update intent added without operational review | Deployment/privacy surprises | Intent inventory, permissions review, fallback snapshots |
| RISK-017 | Default PostgreSQL FTS used for CJK without evaluation | Low recall and incorrect confidence | CJK/multilingual benchmark and tokenizer decision |
| RISK-018 | Durable DB unavailable, ephemeral fallback silently activates | False success and split brain | Explicit degraded mode or fail closed |
| RISK-019 | Vector/graph system adopted before deletion semantics | Undeletable derivatives | Deletion contract before enablement |
| RISK-020 | Vendor benchmark copied as production threshold | Misleading architecture choice | Reproduce on DC_BOT dataset and hardware |

---

## 13. Security and privacy implications

### 13.1 Authorization precedes retrieval

A privacy scope is not merely a ranking feature. The query planner MUST eliminate unauthorized rows before lexical/vector/graph scoring. Otherwise, scoring infrastructure, logs, caches, or error traces can leak private candidates even if final rendering filters them.

### 13.2 Retrieved memory is hostile input

Stored text may contain:

- fake `system:` or `assistant:` roles;
- closing delimiters;
- Markdown/code-fence injection;
- Discord mentions;
- bidirectional controls;
- homoglyphs;
- instructions to reveal internal IDs;
- text originally supplied by an attacker in a shared room.

The serializer must quote memory as data and enforce output policies independently.

### 13.3 Alias privacy

Alias records need both scope and visibility. An alias learned in a DM must not become the default public form of address. Current addressing should choose the highest-priority alias that is authorized for the active context.

### 13.4 Voice attribution

Voice features can be sensitive biometric-like data. DC_BOT should avoid durable storage of raw voiceprints unless explicitly justified, consented, retained under a narrow policy, and protected. Discord’s user/session mapping is preferable when available. Voice characteristics should remain supporting attributes, never silent cross-context identity keys.

### 13.5 Deletion versus append history

Append-oriented history does not exempt the system from erasure. A workable model is:

- append immutable payload initially;
- on valid erasure, replace payload access with a redaction marker or cryptographic erasure;
- preserve only the minimum non-content audit proof allowed by policy;
- invalidate all registered derivatives;
- expire backups under a declared SLA.

The exact legal policy is outside this artifact, but implementation cannot proceed without an operational choice.

### 13.6 Provider prompt caching

Stable prompt structure can improve cache reuse, but provider caches may retain serialized memory outside the primary database. Before enabling broad personal memory in prompts, document:

- provider retention/cache controls;
- whether cache keys cross users;
- whether private content can be excluded from cacheable prefixes;
- deletion limitations;
- observability without raw prompt logging.

---

## 14. Testable acceptance criteria

### Identity and attribution

**TEST-001.** Two Discord users with the same username/display name remain separate through ingestion, retrieval, correction, export, and deletion.

**TEST-002.** A user rename preserves the old event-time name on historical events while current addressing uses the newly permitted name.

**TEST-003.** A DM-only alias is never selected in any guild prompt or output.

**TEST-004.** A three-speaker group turn creates three attributable inbound events and one response linked to all relevant events.

**TEST-005.** No durable event author is `"Discord group"`.

### Room isolation

**TEST-010.** Two voice channels in one guild do not share recent exact history unless both are explicitly bound to the same logical room.

**TEST-011.** An unbound channel receives an isolated logical room.

**TEST-012.** Person memory crosses text/voice only when its scope authorizes both contexts; the entire transcript is not copied.

### Temporal memory

**TEST-020.** A later direct user correction supersedes an earlier user fact.

**TEST-021.** A later assistant speculation does not supersede a direct user fact.

**TEST-022.** An as-of query can retrieve the fact valid at a historical date.

**TEST-023.** Contradictory evidence below the adjudication threshold causes abstention or a clarification request.

### Concurrency

**TEST-030.** Concurrent independent event appends both commit without lost updates.

**TEST-031.** Duplicate ingestion with the same idempotency key creates one event.

**TEST-032.** A generation based on frontier `N` can commit after event `N+1` arrives; its observed frontier remains recorded.

**TEST-033.** Two workers attempting to replace the same summary use source-frontier/version checks so stale output does not overwrite a newer summary.

### Delivery

**TEST-040.** A stored but unsent response is not projected as delivered history.

**TEST-041.** Interrupted voice output is marked interrupted/partial and excluded or labeled in future prompt context.

**TEST-042.** A crash after `started` leaves a reconcilable `unknown` attempt.

**TEST-043.** Retrying delivery creates a linked attempt and does not rewrite the prior terminal attempt.

### Privacy and deletion

**TEST-050.** Export includes all authorized primary events and memory items with provenance, but excludes internal secrets and unauthorized scopes.

**TEST-051.** Forget removes/redacts primary content and invalidates summaries, semantic memories, embeddings, graph edges, and caches.

**TEST-052.** Deleted Airi-style remote/local reconciliation analogs cannot resurrect erased DC_BOT data.

**TEST-053.** Backup expiration/restore tests prove that erased content does not re-enter the active store after the declared backup window.

### Retrieval and injection safety

**TEST-060.** Retrieved content containing fake roles, delimiters, mentions, bidi controls, and internal-ID requests remains quoted data.

**TEST-061.** English, Chinese, Japanese, and mixed-language retrieval are measured separately for recall, precision, latency, and abstention.

**TEST-062.** Vector or graph retrieval is disabled by default until it beats the structured+lexical baseline on agreed metrics.

### Latency and cost

**REQ-EVAL-001.** Benchmarks MUST report P50/P95/P99 memory query and prompt-assembly latency.

**REQ-EVAL-002.** Voice-path tests MUST include cold start, DB contention, large history, and degraded derived-memory availability.

**REQ-EVAL-003.** Cost reports MUST separate live generation, background summary/extraction, embedding, and storage costs.

**REQ-EVAL-004.** Thresholds are blocked pending baseline measurement; arbitrary values in a source plan MUST be labeled hypotheses.

---

## 15. Non-goals

1. Implementing production code in this artifact.
2. Selecting a final embedding model.
3. Selecting a graph database.
4. Building a universal cross-platform identity graph.
5. Persisting raw voiceprints by default.
6. Guaranteeing exactly-once Discord or audio delivery.
7. Treating every assistant turn as a durable fact.
8. Migrating DC_BOT to a standalone memory service in milestone one.
9. Replacing the existing ASR/LLM/TTS pipeline.
10. Defining legal policy; this artifact only identifies engineering requirements that depend on it.

---

## 16. Dependencies on other artifacts

The following artifacts or decisions are required downstream:

1. **Identity and alias specification**  
   Exact actor snapshot fields, update policy, scoped alias precedence, cross-platform link protocol, and intent requirements.

2. **Room and authorization specification**  
   Physical/logical room model, default bindings, guild/DM isolation, character scope, and operator controls.

3. **Event and causality schema ADR**  
   Final relational schema, idempotency keys, append ordering, many-to-many response causes, and snapshot-frontier semantics.

4. **Delivery correctness ADR**  
   Text and voice acknowledgement evidence, partial playback policy, retry/reconciliation, and prompt projection rules.

5. **Privacy lifecycle specification**  
   Retention, correction, forget, export, derivative registry, backups, caches, and provider retention.

6. **Retrieval and evaluation plan**  
   Baseline corpus, multilingual/CJK tests, LongMemEval-style tasks, group/dynamic tests, latency/cost thresholds, and promotion criteria for vectors/graphs.

7. **Storage topology ADR**  
   SQLite operational envelope, PostgreSQL migration trigger, standalone runtime trigger, and multi-instance roadmap.

---

## 17. Open questions

### 17.1 Blocking

**OQ-B-001.** Will milestone one run exactly one Discord bot process that owns all writes, or are multiple bot instances required?

**OQ-B-002.** What exact Discord intents are currently enabled, and is `GUILD_MEMBERS` operationally acceptable if comprehensive member-update handling is desired?

**OQ-B-003.** What is the authoritative policy for a voice response that began playback but was interrupted: include as partial context, exclude, or summarize as an attempted statement?

**OQ-B-004.** What are the retention defaults for DMs, guild text, guild voice transcripts, raw audio references, summaries, and semantic memory?

**OQ-B-005.** What backup-erasure SLA is acceptable?

**OQ-B-006.** Which actor snapshot fields are available on every current text and voice ingestion path without adding a network call?

**OQ-B-007.** What operator/user action authorizes cross-channel logical-room binding?

**OQ-B-008.** Can user-authored correction always supersede previous user facts, or are there regulated/safety domains requiring additional adjudication?

**OQ-B-009.** What database encryption, filesystem permissions, and secret-management baseline is required?

**OQ-B-010.** What concrete latency budget can memory consume within the voice path, based on current measured P95/P99 pipeline latency?

### 17.2 Non-blocking

**OQ-N-001.** Should current profile refresh be event-change-driven, time-driven, or both?

**OQ-N-002.** Should room summaries be hierarchical or only rolling in the first implementation?

**OQ-N-003.** Which lexical tokenizer/extension should be evaluated for CJK?

**OQ-N-004.** Should private-conversation aliases be character-specific in addition to conversation-specific?

**OQ-N-005.** When should a candidate fact require explicit user confirmation?

**OQ-N-006.** Should export expose derived summaries and confidence, or only raw events plus accepted memories?

**OQ-N-007.** What UI/operator mechanism will display failed or unknown delivery attempts?

**OQ-N-008.** At what scale should PostgreSQL replace SQLite?

---

## 18. Source-plan claims: unsupported, partially supported, or contradicted

### 18.1 Unsupported by current evidence

| Claim or implication | Status | Evidence-based disposition |
|---|---|---|
| A standalone HTTP memory service is required for the first milestone. | **Unsupported** | Current DC_BOT topology is compatible with an in-process port; use deployment criteria before service extraction. |
| Airi/Alaya currently provides a complete production semantic-memory implementation suitable for copying. | **Unsupported** | The default-branch `memory-pgvector` entry is a shell and the unified layer is an open proposal. |
| AstrBot’s persisted conversation list is a safe concurrent-write event model. | **Unsupported** | The main path replaces serialized whole history; no observed CAS/version predicate. |
| Graph storage is automatically superior for long-term conversational memory. | **Unsupported** | Papers establish difficult tasks, not universal storage superiority. |
| Arbitrary retrieval weights or fixed latency thresholds are established. | **Unsupported** | They remain hypotheses until measured on DC_BOT data/hardware. |
| Generic PostgreSQL FTS is sufficient for multilingual and CJK retrieval. | **Unsupported** | Parser/dictionary/tokenization behavior must be benchmarked. |
| Discord identity automatically represents a verified cross-platform human. | **Unsupported** | Discord ID is a platform principal; cross-platform linking needs verification. |

### 18.2 Partially supported

| Claim | Status | Evidence-based disposition |
|---|---|---|
| Every inbound event carries a sufficient actor snapshot. | **Partially supported** | Current events have `userId` and `displayName`, but not the complete proposed snapshot/current-profile split. |
| Physical and logical rooms are distinct. | **Partially supported** | Helpers and comments anticipate room IDs, but voice history remains guild-scoped. |
| Group voice preserves speaker attribution. | **Partially supported** | Source events retain speakers during aggregation, but committed history uses `"Discord group"`. |
| Delivery should be separated from generation. | **Partially supported in current behavior** | DC_BOT waits for playback drain before commit, but no durable delivery ledger or crash reconciliation exists. |
| Event history is immutable. | **Blocked on semantics** | Must distinguish immutable payload, append-only transitions, operational projections, and privacy redaction. |
| Alias observation should occur on every event. | **Needs adaptation** | Event snapshots should always preserve presentation; current-profile/alias rows should update only on material changes. |
| Person memory may cross text and voice. | **Architecturally reasonable but unimplemented** | Must be scope-authorized and must not copy whole transcripts. |
| Exact/lexical retrieval should precede vectors/graphs. | **Supported as recommendation, not benchmark result** | The order minimizes complexity, but final ranking must be evaluated. |

### 18.3 Contradicted by current implementation

| Source-plan target versus current behavior | Status | Evidence |
|---|---|---|
| Text and voice use one coherent memory authority. | **Contradicted today** | `GuildSession` and mention responder own separate in-memory stores. |
| A group input’s durable author is never synthetic. | **Contradicted today** | Controller commits `"Discord group"` for aggregate group turns. |
| A fixed one-user-event exchange schema is sufficient. | **Contradicted by group behavior** | One response can be generated from several speaker events. |
| Interrupted or unheard output is always excluded from completed history across comparison systems. | **Contradicted as an upstream assumption** | AstrBot can save aborted output without an active explicit partial-output marker. |
| Ordinary append must fail whenever the room changed during generation. | **Contradicted by required concurrency semantics** | New independent events can coexist; record the observed frontier rather than treating all change as conflict. |

---

## 19. Handoff instructions for downstream agents

### 19.1 Required next artifacts

1. `03-identity-alias-and-scope-spec.md`
2. `04-event-room-and-causality-schema.md`
3. `05-delivery-and-crash-recovery-spec.md`
4. `06-privacy-retention-deletion-export-spec.md`
5. `07-retrieval-and-evaluation-plan.md`
6. `08-storage-topology-and-migration-adr.md`

### 19.2 Decisions downstream agents must preserve

- Use Discord user ID as a platform-scoped identity key.
- Keep event-time actor snapshots separate from current identity/profile.
- Never merge identities by alias.
- Preserve one attributable event per speaker.
- Use many-to-many response causality.
- Separate physical rooms from logical rooms.
- Keep raw events separate from summaries and semantic memories.
- Keep delivery attempts separate from generated responses.
- Do not require strict snapshot CAS for ordinary event append.
- Keep summary/extraction/embedding/graph work off the voice-critical path.
- Start with authorized structured, temporal, and lexical retrieval.
- Do not introduce graph/vector infrastructure without benchmark evidence.
- Make deletion and derivative invalidation part of the initial schema, not a later patch.
- Do not silently fall back to ephemeral memory after a durable-write failure.

### 19.3 Evidence caveats to carry forward

- Airi’s session outbox is strong evidence for synchronization mechanics, not proof of finished Alaya semantic memory.
- AstrBot’s persisted conversations are strong product evidence for session UX, not proof of concurrency-safe event sourcing.
- DC_BOT’s playback-drain commit rule is a useful local invariant, not a complete crash-recovery protocol.
- Paper and vendor benchmark results must be reproduced or adapted before becoming thresholds.

---

## 20. What must be true before coding starts

1. **ADR-001 through ADR-011 are accepted, amended, or explicitly rejected.**
2. A single owner approves the platform identity, alias scope, and cross-platform linkage rules.
3. The initial deployment topology and SQLite write envelope are documented.
4. The physical/logical room mapping and unbound-channel default are decided.
5. The many-to-many response-cause schema is accepted.
6. The delivery state machine and voice partial-delivery policy are accepted.
7. Retention, correction, deletion, export, backup, cache, and provider-retention policies are specified.
8. A migration/versioning mechanism is selected.
9. The source-event/derived-artifact dependency registry is designed.
10. The prompt serializer has explicit injection test vectors.
11. The evaluation corpus and baseline metrics are defined.
12. Multilingual/CJK retrieval is treated as a separate benchmark track.
13. Production degraded-mode behavior is explicit.
14. No implementation task assumes that Airi proposals, AstrBot whole-history persistence, graph superiority, or vendor benchmark claims are settled facts.

---

## Concise architectural lessons for DC_BOT

1. **Unify authority, not necessarily deployment.** A clean `MemoryPort` matters now; an HTTP service does not.
2. **Persist attributable events before building intelligence around them.**
3. **Treat Discord IDs as platform identities and aliases as scoped presentation.**
4. **Model rooms, people, characters, and privacy scopes independently.**
5. **Represent group causes explicitly; never invent a synthetic durable person.**
6. **Make generation and delivery separate state machines.**
7. **Use snapshot/frontier versions as evidence, not as a blanket reason to reject append.**
8. **Keep exact recent context and derived memory separate.**
9. **Run expensive memory construction outside the voice path.**
10. **Prove vectors, graphs, weighting, multilingual tokenization, and thresholds with DC_BOT benchmarks.**
11. **Design correction and deletion before accumulating durable personal data.**
12. **Never report persistence success while silently using unrelated ephemeral memory.**

### Handoff summary

The next work should finalize identity/scope, event/room/causality, delivery recovery, privacy lifecycle, retrieval evaluation, and storage-topology artifacts. Coding should begin only after those specifications define the release-blocking identity, attribution, delivery, and deletion semantics.
