# Shared-Memory Requirements Baseline

**Artifact filename:** `04-requirements-baseline.md`  
**Status:** Requirements baseline for design approval; production coding is blocked on the ADRs and acceptance gates named below.  
**Prepared:** 2026-08-01  
**Role:** Requirements engineering lead

## 1. Executive conclusion

**Recommendation.** DC_BOT should implement the first production shared-memory milestone as a transport-neutral domain/application layer inside the existing bot process, accessed only through a `MemoryPort`, with a durable transactional adapter. SQLite is the default for the verified single-process topology; PostgreSQL is an allowed deployment choice when measured concurrency, backup, or multi-instance needs justify it. A mandatory HTTP memory microservice is rejected for M1 because no inspected DC_BOT deployment evidence requires a network boundary.

**Confirmed repository fact.** The current DC_BOT voice orchestration uses process-lifetime room state, creates channel-derived physical room IDs, preserves per-speaker fragments in the group prompt builder, but the controller can submit the grouped turn under the synthetic display name `Discord group`. It also commits the exchange only after playback drains. These behaviors are useful current-state evidence, not acceptable final persistence semantics. Sources:  
- https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/room.ts  
- https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/room-id.ts  
- https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/group-turn-builder.ts  
- https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/conversation-controller.ts

**Confirmed comparative fact.** Airi documents memory work as WIP; its current `memory-pgvector` entry point is a small module skeleton, and issue #879 is an open proposal for a unified abstraction. AstrBot has useful persisted-conversation and compression behavior, but its conversation manager reads a content list, appends messages, and updates the conversation as a whole. Neither comparison establishes a production-safe DC_BOT architecture. Sources:  
- https://github.com/moeru-ai/airi/blob/main/packages/memory-pgvector/src/index.ts  
- https://github.com/moeru-ai/airi/issues/879  
- https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/conversation_mgr.py  
- https://github.com/AstrBotDevs/AstrBot/wiki/en-use-context-compress

**Release position.** Identity, attribution, scope isolation, delivery recovery, deletion completeness, and the prohibition on silent ephemeral fallback are P0 release blockers. Vectors, graph memory, relationship hypotheses, and service extraction are explicit non-goals until their gates pass.

## 2. Scope

This baseline normalizes the supplied source plan, verified repository evidence, comparative research, and the topology decision into testable requirements for:

- shared text/voice memory behavior;
- identity, aliases, addressing, rooms, scopes, and attribution;
- raw events, causality, generation, delivery, persistence, and consistency;
- memory layers, retrieval, prompt security, privacy, retention, deletion, and export;
- performance, availability, observability, migration, evaluation, and rollout.

It specifies contracts, data semantics, decisions, gates, tests, and handoff requirements. It does **not** modify production code.

## 3. Sources inspected

### 3.1 Repository snapshots

| Repository | Inspected branch | Commit SHA | Access note |
|---|---|---:|---|
| `starryark/DC_BOT` | `main` | **Not established** | Files were opened through GitHub HTML/raw-accessible pages. The unauthenticated rendering inspected did not expose a reliable branch-head SHA. Pinning a SHA is required before implementation. |
| `moeru-ai/airi` | `main` | **Not established** | GitHub pages and exact source/issue URLs were inspected. Branch-head SHA was not reliably exposed. |
| `AstrBotDevs/AstrBot` | `master` | **Not established** | GitHub pages, raw source, and wiki pages were inspected. Branch-head SHA was not reliably exposed. |

**Evidence limitation.** No repository was cloned. Repository state may move after 2026-08-01; downstream agents must pin exact SHAs and re-run evidence checks before coding.

### 3.2 Exact source set

- Source-plan brief: uploaded assignment and baseline (`SP`).
- DC_BOT root and launcher: https://github.com/starryark/DC_BOT/blob/main/README.md, https://github.com/starryark/DC_BOT/blob/main/start-bot.ps1.
- DC_BOT orchestration: https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/conversation-controller.ts, https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/events.ts, https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/group-turn-builder.ts, https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/room.ts, https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/room-id.ts.
- DC_BOT service operations/intents: https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/README.md.
- Airi: https://github.com/moeru-ai/airi/blob/main/README.md, https://github.com/moeru-ai/airi/blob/main/packages/memory-pgvector/src/index.ts, https://github.com/moeru-ai/airi/issues/879, https://github.com/moeru-ai/airi/tree/main/services/telegram-bot.
- AstrBot: https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/conversation_mgr.py, https://github.com/AstrBotDevs/AstrBot/wiki/en-use-context-compress, https://github.com/AstrBotDevs/AstrBot/wiki/en-dev-star-guides-ai.
- Discord official documentation: https://docs.discord.com/developers/resources/user, https://docs.discord.com/developers/resources/guild, https://docs.discord.com/developers/events/gateway.
- PostgreSQL official documentation: https://www.postgresql.org/docs/current/textsearch.html, https://www.postgresql.org/docs/current/textsearch-configuration.html.

## 4. Evidence table

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| E-001 | DC_BOT currently has an in-memory `RoomStore` whose state lasts for the process lifetime; long-term persistent memory is described as a different subsystem. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/room.ts | High |
| E-002 | DC_BOT derives physical room IDs from guild, modality, and channel, and comments anticipate explicit room binding rather than automatic cross-channel sharing. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/room-id.ts | High |
| E-003 | DC_BOT voice input events include `userId`, `displayName`, and timestamp but not the full proposed Discord actor snapshot. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/events.ts | High |
| E-004 | The group turn builder keeps source events and speaker labels when composing a grouped prompt. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/group-turn-builder.ts | High |
| E-005 | The conversation controller can replace grouped attribution with `displayName: 'Discord group'` for generation input. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/conversation-controller.ts | High |
| E-006 | The controller waits for playback to drain and then commits both sides of the exchange to session history. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/src/orchestration/conversation-controller.ts | High |
| E-007 | The launcher starts local ASR, TTS, and bot processes; inspected evidence does not establish a required independent memory service. | Confirmed repository fact plus inference | https://github.com/starryark/DC_BOT/blob/main/start-bot.ps1; https://github.com/starryark/DC_BOT/blob/main/README.md | Medium-high |
| E-008 | Discord exposes a stable user `id`; `username` is not unique; `global_name` is optional; guild member data has guild-specific `nick` and `avatar`. | External research finding | https://docs.discord.com/developers/resources/user; https://docs.discord.com/developers/resources/guild | High |
| E-009 | Comprehensive member freshness can depend on gateway intent configuration and operational approval. | External research finding | https://docs.discord.com/developers/events/gateway; https://github.com/starryark/DC_BOT/blob/main/airi/services/discord-bot/README.md | High |
| E-010 | Airi's `memory-pgvector` entry point is a small module shell; the proposed unified Alaya layer is described in an open issue rather than verified as complete production behavior. | Confirmed repository fact | https://github.com/moeru-ai/airi/blob/main/packages/memory-pgvector/src/index.ts; https://github.com/moeru-ai/airi/issues/879 | High |
| E-011 | Airi's Telegram service documents PostgreSQL and embedding dependencies, showing a service-specific vector setup rather than proof of a general memory runtime. | Confirmed repository fact | https://github.com/moeru-ai/airi/tree/main/services/telegram-bot | Medium-high |
| E-012 | AstrBot persists conversation content and its manager can read a list, append a user/assistant pair, and update the conversation content. | Confirmed repository fact | https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/core/conversation_mgr.py | High |
| E-013 | AstrBot documents automatic conversation compression and fallback behavior, making it a product baseline for context compression, not a concurrency proof. | Confirmed documentation claim plus inference | https://github.com/AstrBotDevs/AstrBot/wiki/en-use-context-compress | High |
| E-014 | PostgreSQL full-text search behavior depends on text-search configuration, parser, and dictionaries; multilingual/CJK quality therefore requires a corpus benchmark. | External research finding plus recommendation | https://www.postgresql.org/docs/current/textsearch.html; https://www.postgresql.org/docs/current/textsearch-configuration.html | High |
| E-015 | Text and voice must converge on one memory authority, identity must use Discord user ID, private aliases must not leak, and delivery/deletion require explicit models. | Source-plan requirement | Uploaded source-plan brief | High |
| E-016 | The first milestone should use an in-process `MemoryPort` with a durable adapter and defer network service extraction. | Recommendation | E-001, E-006, E-007, E-010 to E-013, SP-2 and risk A | Medium-high |
| E-017 | Whether deployment will require multiple concurrent bot instances, region separation, or independent scaling is not established. | Open question | Repository evidence inspected | High |

## 5. Current-state findings

1. **Confirmed repository fact — fragmented authority.** DC_BOT has process-local room state and a session-history commit path. The inspected code does not show one durable, transport-neutral memory authority.
2. **Confirmed repository fact — partial actor snapshots.** Voice events carry a stable user ID and display name, but not all best-available Discord presentation fields proposed by the source plan.
3. **Confirmed repository fact — attribution is lost at a boundary.** Group prompt construction preserves speakers, but the controller can collapse the grouped input into a synthetic display name.
4. **Confirmed repository fact — commit-after-drain semantics.** A completed playback drain is currently the point at which the exchange is committed to session history. This avoids treating interrupted audio as completed, but creates crash windows and loses the distinction between generated, persisted, attempted, and heard.
5. **Confirmed repository fact — physical rooms are already explicit.** Channel-derived room IDs provide a useful basis, but logical room binding and authorization are not yet the durable memory model.
6. **Inference — no first-milestone service mandate.** The inspected launcher and root documentation show a local process topology; a network memory service would add failure modes before a deployment need is proven.
7. **Comparative finding — Airi is not a production reference implementation.** Its unified memory direction is WIP/proposed, and its visible pgvector module is a skeleton.
8. **Comparative finding — AstrBot demonstrates product behavior, not safe event sourcing.** Persisted conversations and compression are useful, while whole-content update semantics should not be copied as DC_BOT's concurrent authoritative event model.
9. **External finding — Discord identity is layered.** Stable user ID, global presentation, and guild presentation are separate fields and should remain separate in the domain.
10. **Open evidence gap.** Exact repository SHAs, target deployment concurrency, retention policy, user-facing consent behavior, and measurable latency goals remain unverified.

## 6. Proposed decisions

| ADR | Proposed decision | Classification | Status and gate |
|---|---|---|---|
| ADR-001 | M1 uses an in-process domain/application memory layer behind `MemoryPort`; SQLite is default for one bot instance; PostgreSQL is selected only for verified operational need; standalone service extraction is M3-gated. | Recommendation | Must be ratified before coding. |
| ADR-002 | Raw event payloads are immutable; mutable lifecycle is represented by append-only transition records or a separately audited state projection. | Recommendation | Blocking; schema spec required. |
| ADR-003 | Logical room records and many-to-many generation-cause edges are first-class; physical room IDs remain transport locators. | Recommendation | Blocking. |
| ADR-004 | `PlatformActorId` and optional `LinkedSubjectId` are distinct; no automatic cross-platform identity linking. | Recommendation | Blocking for multi-platform claims. |
| ADR-005 | Persist generation and delivery intent before external delivery; mark a normal completed turn only after the channel-specific completion signal; reconcile unknown crash windows. | Recommendation | Blocking. |
| ADR-006 | Store an event-time actor snapshot on every accepted event; update the current identity projection only on material change or controlled refresh. | Recommendation | Blocking for data model. |
| ADR-007 | Snapshot version is evidence of generation context; do not reject solely because a later event arrived. Revalidate only security, authorization, or explicitly conflicting invariants. | Recommendation | Blocking for concurrency semantics. |
| ADR-008 | Facts are temporal, provenance-bearing records with correction and supersession links. | Recommendation | Blocking for fact extraction. |
| ADR-009 | Advanced retrieval requires a benchmark and privacy/deletion gate; no default vectors or graph. | Recommendation | M2 gate. |
| ADR-010 | Authorization is deny-by-default and precedes ranking. | Recommendation | Blocking. |
| ADR-011 | Retention and backup restore preserve deletion guarantees. | Recommendation | Blocking before broad retention. |
| ADR-012 | Erasure uses a specified mix of physical deletion, irreversible redaction, tombstones, and derived-artifact invalidation; append-only does not mean undeletable. | Recommendation | Blocking. |
| ADR-013 | Export policy defines treatment of shared multi-party records. | Recommendation | Blocking for export launch. |
| ADR-014 | Degraded availability modes are explicit and may not counterfeit durable success. | Recommendation | Blocking. |

## 7. Alternatives considered

| Alternative | Benefit | Cost/risk | Decision |
|---|---|---|---|
| Mandatory standalone HTTP memory service in M1 | Independent scaling and language-neutral boundary | Adds network auth, deployment, retries, partial failure, observability, and latency without verified need | Rejected for M1; migration path retained |
| In-process `MemoryPort` with SQLite | Minimal topology, transactional durability, easy local operation | Single-writer/multi-instance limits require measurement | Selected default for M1 |
| In-process `MemoryPort` with PostgreSQL | Better multi-instance concurrency and operational ecosystem | Higher deployment burden | Allowed when ADR-001 evidence selects it |
| Keep current process-local room/session histories | Lowest implementation effort | Loses durability and creates modality divergence | Rejected for production |
| Persist whole conversation JSON | Simple read/write model; comparable to AstrBot product behavior | Lost-update, attribution, deletion, and causal-model weaknesses | Rejected as authority |
| Event plus projections | Strong provenance, incremental writes, reprocessing | More schema and migration work | Selected direction |
| Commit only after delivery | Avoids treating unheard content as complete | Loses generated state in crash windows | Rejected as the sole persistence rule |
| Persist before delivery and always treat as completed | Durable generation record | Incorrectly assumes delivery | Rejected |
| Persist generation and separate delivery state | Correctly models both crash windows and user experience | Requires reconciler | Selected direction |
| Vectors/graphs from the start | Potential semantic recall | Added privacy, deletion, cost, latency, and benchmark uncertainty | Rejected for M1 |

## 8. Rejected alternatives and reasons

1. **Mandatory microservice:** rejected because inspected deployment evidence does not show independent scaling, multi-language ownership, or multi-host memory consumers. A port preserves later extraction.
2. **Alias as identity:** rejected because names are mutable, non-unique, and scoped.
3. **Synthetic group author:** rejected because it erases speaker provenance.
4. **One `user_event_id` on an exchange:** rejected because group and batched responses are many-to-many.
5. **Mutable raw event status in the same record without audit semantics:** rejected because it makes “immutable event” claims false.
6. **Snapshot-version mismatch as automatic commit failure:** rejected because valid generations can be based on an older but authorized context.
7. **Ordinary append history as a reason to refuse erasure:** rejected because privacy deletion is release-blocking.
8. **Generic PostgreSQL FTS claim for all languages:** rejected until multilingual/CJK tests establish behavior.
9. **Silent ephemeral fallback:** rejected because it lies about durability.
10. **Copying Airi or AstrBot wholesale:** rejected because Airi's relevant layer is WIP/proposed and AstrBot's whole-content update model does not satisfy this baseline's concurrency and causality needs.

## 9. Normative language

`MUST` and `MUST NOT` are release requirements. `SHOULD` requires a recorded exception with rationale, owner, expiry, and mitigation. `MAY` is optional and must still obey authorization, privacy, deletion, and observability rules.

Milestones:

- **M0:** design, ADR, data-governance, and benchmark gates.
- **M1:** first durable production core in a limited pilot.
- **M1.1:** hardened backup, operational dashboards, and recovery objectives.
- **M2:** evidence-gated advanced retrieval.
- **M3:** evidence-gated service extraction.
- **GA:** broad production release.

## 10. Normalized requirements baseline

### 10.1 Functional behavior

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-FUNC-001 | MUST | All text and voice paths shall read and write conversational memory through one transport-neutral `MemoryPort`; no production path may own an unrelated authoritative history. | Prevents modality drift and contradictory recall. | SP-1; DC-ROOM confirms current in-memory room history; DC-CTRL confirms a separate session history path. | Architecture test injects one fake port into both adapters; end-to-end test proves text-created person memory is available to authorized voice retrieval and vice versa. | P0 | M1 | ADR-001; REQ-PERSIST-001 | High: central authorization and privacy boundary. | 05-memory-architecture.md | TEST-FUNC-001 |
| REQ-FUNC-002 | MUST | Each accepted inbound text or voice event shall be normalized into the same event contract before memory processing. | Makes attribution, authorization, retention, and replay consistent. | SP-4; DC-EVENTS currently carries only a partial voice actor snapshot. | Contract tests submit equivalent text and voice events and compare required normalized fields and policy decisions. | P0 | M1 | REQ-ID-001; REQ-EVENT-001 | High: prevents anonymous or under-scoped records. | 07-event-causality-delivery.md | TEST-FUNC-002 |
| REQ-FUNC-003 | SHOULD | Current addressing, historical presentation, room context, person memory, and delivery state shall be exposed as distinct query results rather than one undifferentiated transcript. | Avoids privacy leakage and incorrect prompt assembly. | SP-5, SP-9 to SP-15. | Prompt assembly test shows each layer can be included or excluded independently and that historical names do not overwrite current addressing. | P1 | M1 | REQ-ALIAS-003; REQ-MEM-001; REQ-DELIVERY-001 | High: minimizes over-disclosure. | 08-memory-lifecycle-retrieval.md | TEST-FUNC-003 |
### 10.2 Identity

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-ID-001 | MUST | The durable Discord platform actor key shall be the Discord user snowflake, represented as a typed key such as `platform_actor(discord, user_id)`. | Discord usernames and display names are mutable and non-unique. | SP-3; Discord User Resource states `id` is the user ID while `username` is not unique and `global_name` is optional. | Identity tests rename users, duplicate usernames, and change avatars without changing the platform actor record. | P0 | M1 | None | Critical: prevents person merging. | 06-identity-alias-scope.md | TEST-ID-001 |
| REQ-ID-002 | MUST | Two actors shall never be merged solely because they share a username, global display name, guild nickname, preferred alias, avatar, or voice characteristic. | Presentation attributes are not identity proof. | SP-7; Discord User and Guild Member resources. | Adversarial fixture creates two users with identical presentation attributes; all events, aliases, facts, and exports remain separate. | P0 | M1 | REQ-ID-001 | Critical: identity and privacy isolation. | 06-identity-alias-scope.md | TEST-ID-002 |
| REQ-ID-003 | MUST | A Discord platform actor identifier shall not be treated as a verified cross-platform human identifier; cross-platform linkage requires a separate explicit, auditable verification mechanism. | A platform account is not proof of a real-world or cross-platform person. | SP risk F. | Schema and API review show separate `platform_actor_id` and optional `linked_subject_id`; no automatic joins by name or profile similarity. | P0 | M1 | ADR-004 | Critical: prevents cross-context deanonymization. | 06-identity-alias-scope.md | TEST-ID-003 |
### 10.3 Alias and addressing

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-ALIAS-001 | MUST | Preferred aliases shall be stored with an explicit scope chosen from platform, character-global, guild, logical room, or private conversation, plus validity and provenance. | The same person may permit different names in different contexts. | SP-6. | Policy tests resolve different aliases for the same actor in a DM, guild, room, and character context. | P0 | M1 | REQ-SCOPE-001; REQ-MEM-002 | Critical: controls disclosure. | 06-identity-alias-scope.md | TEST-ALIAS-001 |
| REQ-ALIAS-002 | MUST | An alias learned or authorized only in a private conversation shall not be retrieved, rendered, logged, spoken, or exported into a public guild context unless explicitly re-authorized for that scope. | Private addressing is sensitive contextual data. | SP-6, SP-19. | Privacy leakage suite plants a DM-only alias and proves zero disclosure in public text, voice, logs, traces, and export for another scope. | P0 | M1 | REQ-PRIV-001; REQ-RETRIEVAL-001 | Critical. | 06-identity-alias-scope.md | TEST-ALIAS-002 |
| REQ-ALIAS-003 | MUST | Each raw event shall preserve the presentation observed at event time, while current addressing shall resolve the active permitted alias without rewriting historical event snapshots. | Historical accuracy and current politeness are different concerns. | SP-5; SP risk G. | Rename test proves old events retain the prior display name and new replies use the current permitted alias. | P0 | M1 | REQ-EVENT-002; ADR-006 | High: avoids false attribution and excessive mutation. | 06-identity-alias-scope.md | TEST-ALIAS-003 |
### 10.4 Room and scope

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-SCOPE-001 | MUST | Physical Discord channels and logical conversation rooms shall have distinct identifiers and authorization records. | A physical location is not automatically the intended memory boundary. | SP-9; DC-ROOMID currently creates deterministic physical room IDs and anticipates explicit bindings. | Schema test shows separate physical and logical entities; authorization tests deny implicit cross-channel reads. | P0 | M1 | ADR-003 | Critical: prevents cross-channel leakage. | 06-identity-alias-scope.md | TEST-SCOPE-001 |
| REQ-SCOPE-002 | MUST | Recent room history may cross physical channels only through an explicit, versioned binding or configured rule that is visible to operators and testable. | Implicit channel fusion creates surprising disclosure. | SP-9; DC-ROOMID explicit-binding comment. | Unbound channels remain isolated; adding and removing a binding changes retrieval deterministically and is audit logged. | P0 | M1 | REQ-SCOPE-001; REQ-OBS-003 | Critical. | 06-identity-alias-scope.md | TEST-SCOPE-002 |
| REQ-SCOPE-003 | MUST | DMs, guilds, people, characters, logical rooms, and unbound channels shall have explicit isolation and authorization rules; absence of a rule means deny. | Scope ambiguity is a privacy failure. | SP-19. | Authorization matrix test covers every entity pair and verifies deny-by-default for missing policies. | P0 | M1 | REQ-PRIV-001 | Critical. | 09-privacy-governance-operations.md | TEST-SCOPE-003 |
| REQ-SCOPE-004 | SHOULD | Authorized person-level memory may cross text and voice without copying an entire source transcript into the destination room context. | Continuity should not collapse room boundaries. | SP-10. | Cross-modality test retrieves an authorized fact with provenance while excluding unrelated room transcript records. | P1 | M1 | REQ-MEM-001; REQ-RETRIEVAL-001 | High: data minimization. | 08-memory-lifecycle-retrieval.md | TEST-SCOPE-004 |
### 10.5 Attribution

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-ATTR-001 | MUST | Group voice ingestion shall persist one attributable user event per speaker fragment or utterance, including the durable Discord actor key and event-time actor snapshot. | Group context must remain attributable. | SP-8; DC-GROUP preserves per-speaker source events. | Multi-speaker fixture produces distinct durable events for every speaker and fragment with stable causal order. | P0 | M1 | REQ-ID-001; REQ-EVENT-001 | Critical. | 07-event-causality-delivery.md | TEST-ATTR-001 |
| REQ-ATTR-002 | MUST | A synthetic label such as `Discord group` shall never be persisted as a durable human author. | Synthetic authors destroy identity continuity and provenance. | SP-8; DC-CTRL currently sets `displayName: 'Discord group'` for grouped generation input. | Regression test asserts no user-authored event has a synthetic actor; group container records reference member event IDs instead. | P0 | M1 | REQ-ATTR-001; REQ-EVENT-003 | Critical. | 07-event-causality-delivery.md | TEST-ATTR-002 |
| REQ-ATTR-003 | MUST | Prompt-local opaque speaker references may distinguish same-name speakers, but those references shall never be printed, spoken, persisted as user-facing names, or exposed through telemetry. | Disambiguation must not leak internal identifiers. | SP-7, SP-16. | Prompt and output fuzz tests detect and reject internal reference leakage across text, TTS, logs, and traces. | P0 | M1 | REQ-PROMPT-003 | Critical. | 06-identity-alias-scope.md | TEST-ATTR-003 |
### 10.6 Events and causality

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-EVENT-001 | MUST | Every accepted inbound event shall have a globally unique event ID, source transport, actor snapshot, physical scope, logical scope if resolved, occurred-at time, received-at time, payload type, and idempotency key. | Supports replay, ordering, attribution, and duplicate suppression. | SP-4, SP-11; DC-EVENTS currently has a narrower voice event shape. | Schema validation and replay tests reject missing fields and deduplicate redelivered transport events. | P0 | M1 | REQ-ID-001; REQ-SCOPE-001 | High. | 07-event-causality-delivery.md | TEST-EVENT-001 |
| REQ-EVENT-002 | MUST | Raw event payload and event-time snapshot shall be append-only after acceptance; lifecycle changes shall be represented by separate state records or transition events rather than by rewriting the raw payload. | Resolves evidence preservation without pretending operational state never changes. | SP-11; contradiction risk E. | Database test proves payload columns are immutable and lifecycle transitions are append-audited. | P0 | M1 | ADR-002 | High: auditability and erasure design. | 07-event-causality-delivery.md | TEST-EVENT-002 |
| REQ-EVENT-003 | MUST | An assistant generation shall support zero, one, or many causal user event links, each with a role such as trigger, context, correction, or interruption. | Group responses and batched context are many-to-many. | SP-14; contradiction risk D; DC-GROUP preserves multiple source events. | Schema test creates one response caused by multiple speakers and one event referenced by multiple regeneration attempts. | P0 | M1 | ADR-003 | High. | 07-event-causality-delivery.md | TEST-EVENT-003 |
| REQ-EVENT-004 | SHOULD | Generation shall record the room snapshot or high-water mark, policy version, retrieval plan, and memory record IDs it actually observed; a newer event arriving during generation shall not alone invalidate the result. | Snapshot version is evidence, not an automatic conflict. | SP risk B. | Concurrency test appends a benign event during generation and permits delivery while retaining exact observed snapshot metadata; policy-revocation cases fail closed. | P1 | M1 | ADR-007; REQ-PERSIST-002 | High. | 07-event-causality-delivery.md | TEST-EVENT-004 |
### 10.7 Delivery

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-DELIVERY-001 | MUST | Generation, durable persistence, and Discord delivery or voice playback shall be modeled as separate records and state machines. | A database transaction cannot atomically commit with Discord delivery. | SP-13; contradiction risk C; DC-CTRL currently commits exchange after playback drains. | Schema and failure-injection tests independently observe generation, persistence, delivery attempt, and outcome. | P0 | M1 | ADR-005 | Critical: prevents false completed turns. | 07-event-causality-delivery.md | TEST-DELIVERY-001 |
| REQ-DELIVERY-002 | MUST | Delivery state shall distinguish at least pending, sent or playback-started, acknowledged or drained, partial, interrupted, failed-retryable, failed-terminal, and unknown-after-crash. | Voice and text have distinct ambiguous crash windows. | SP-15; SP risk C. | State-machine tests cover every transition and reject impossible terminal-to-success rewrites without a new attempt. | P0 | M1 | REQ-DELIVERY-001 | High. | 07-event-causality-delivery.md | TEST-DELIVERY-002 |
| REQ-DELIVERY-003 | MUST | Interrupted, failed, unheard, unknown, or partially delivered assistant output shall not be selected as an ordinary completed conversational turn. | The model must not assume the user received content. | SP-15. | Retrieval test excludes non-completed delivery outcomes from normal recent dialogue while allowing an operator-visible recovery view. | P0 | M1 | REQ-DELIVERY-002; REQ-RETRIEVAL-001 | High. | 08-memory-lifecycle-retrieval.md | TEST-DELIVERY-003 |
| REQ-DELIVERY-004 | MUST | A reconciler shall recover pending and unknown delivery attempts idempotently without duplicating durable assistant generations. | Crash recovery is unavoidable. | SP-13; SP risk C. | Crash injection before send, after send, during playback, and after drain converges to a documented state without duplicate logical turns. | P0 | M1 | REQ-DELIVERY-001; REQ-OBS-001; REQ-AVAIL-001 | High. | 09-privacy-governance-operations.md | TEST-DELIVERY-004 |
### 10.8 Persistence and consistency

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-PERSIST-001 | MUST | M1 shall implement `MemoryPort` in-process with a durable transactional adapter; SQLite is the default single-instance adapter, and PostgreSQL is permitted when verified concurrency or deployment requirements justify it. | Current topology is local and does not establish a mandatory service boundary. | Inference from DC-LAUNCH and DC-README; SP-2 and risk A; comparative evidence does not establish a reusable production runtime. | ADR-001 approved; both application adapters depend only on the port; SQLite restart test preserves state. | P0 | M0/M1 | ADR-001 | High: central data boundary. | 05-memory-architecture.md | TEST-PERSIST-001 |
| REQ-PERSIST-002 | MUST | Writes shall use transactions and explicit uniqueness or compare-and-set rules sufficient to prevent duplicate events, lost lifecycle transitions, and alias/fact corruption under concurrency. | Mutable whole-history replacement is unsafe as the authoritative concurrent model. | SP risks B and L; AstrBot `add_message_pair` reads a content list, appends, and updates the conversation. | Concurrent writer test demonstrates no lost events or overwritten facts under supported deployment concurrency. | P0 | M1 | REQ-EVENT-001; ADR-002 | High. | 05-memory-architecture.md | TEST-PERSIST-002 |
| REQ-PERSIST-003 | MUST | Production shall not silently fall back to unrelated process-local history while reporting successful durable writes. | Availability must not counterfeit persistence correctness. | SP-22; contradiction risk J; DC-ROOM current store is process-lifetime only. | Database outage test returns explicit degraded or failed status and proves no success acknowledgement for unpersisted memory. | P0 | M1 | REQ-AVAIL-001 | Critical. | 09-privacy-governance-operations.md | TEST-PERSIST-003 |
| REQ-PERSIST-004 | SHOULD | Schema migrations shall be forward-versioned, reversible within the supported rollback window, and safe to resume after interruption. | Memory data becomes long-lived and operationally sensitive. | SP-20. | Migration rehearsal upgrades, interrupts, resumes, and rolls back a production-like snapshot with integrity checks. | P1 | M1 | REQ-MIG-001 | High. | 09-privacy-governance-operations.md | TEST-PERSIST-004 |
### 10.9 Memory lifecycle

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-MEM-001 | MUST | The data model shall separate raw attributable events, recent context, summaries, semantic facts, episodic memories, and operator-authored procedural memory. | These layers have different provenance, retention, trust, and retrieval rules. | SP-11. | Schema review and retrieval tests prove each layer has a distinct type, lifecycle, and policy path. | P0 | M1 | REQ-EVENT-001 | Critical. | 08-memory-lifecycle-retrieval.md | TEST-MEM-001 |
| REQ-MEM-002 | MUST | Durable facts shall include provenance, confidence, observed-at time, valid-from and valid-to where applicable, author or extractor, scope, and correction or supersession links. | Facts change and extraction may be wrong. | SP-12. | Temporal correction test retrieves the fact valid for the requested time and preserves the superseded record for audit subject to deletion policy. | P0 | M1 | ADR-008 | High. | 08-memory-lifecycle-retrieval.md | TEST-MEM-002 |
| REQ-MEM-003 | MUST | Assistant speculation, hypothetical content, and unverified inference shall not be promoted to user truth without an evidence rule that records its status. | Generated text is not reliable user provenance. | SP-12. | Extraction test classifies user assertion, assistant hypothesis, quoted third-party text, and correction differently and abstains where unsupported. | P0 | M1 | REQ-MEM-002 | High: misinformation prevention. | 08-memory-lifecycle-retrieval.md | TEST-MEM-003 |
| REQ-MEM-004 | MUST | Summarization, extraction, embedding, graph construction, and contradiction reconciliation shall execute outside the voice-critical path and be cancelable and retryable. | Derived work must not inflate response latency or block playback. | SP-18. | Latency test disables workers without breaking core conversation; worker retry test is idempotent. | P0 | M1 | REQ-PERSIST-002; REQ-OBS-001 | Medium; derived data still inherits privacy scope. | 08-memory-lifecycle-retrieval.md | TEST-MEM-004 |
### 10.10 Retrieval

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-RETRIEVAL-001 | MUST | Every retrieval shall apply authorization and scope filtering before content ranking or prompt serialization. | Ranking cannot repair an unauthorized candidate set. | SP-17, SP-19. | Query-plan test and adversarial fixtures prove unauthorized rows never enter the ranker, prompt, logs, or cache. | P0 | M1 | REQ-PRIV-001; REQ-SCOPE-003 | Critical. | 08-memory-lifecycle-retrieval.md | TEST-RETRIEVAL-001 |
| REQ-RETRIEVAL-002 | MUST | M1 retrieval order shall begin with exact structured lookup, temporal filtering, and lexical or full-text search, with deterministic tie handling and provenance returned. | Simple methods are inspectable and establish a benchmark baseline. | SP-17. | Golden-query suite records candidates, filters, scores, provenance, and abstention; reruns are deterministic for a fixed snapshot. | P0 | M1 | REQ-MEM-002 | High. | 08-memory-lifecycle-retrieval.md | TEST-RETRIEVAL-002 |
| REQ-RETRIEVAL-003 | MUST | Vector search, learned reranking, graph storage, and relationship hypotheses shall remain disabled in production until a named benchmark shows material quality gain within privacy, deletion, latency, and cost gates. | Complex retrieval is not justified by assumption. | SP-17, risks J and K; AIRI-879 is an open proposal and AIRI-PGV is a small module skeleton. | Feature cannot be enabled without an approved evaluation report and deletion-path test. | P0 | M2 gate | REQ-EVAL-001; ADR-009 | High: additional inferred and derived data. | 10-evaluation-rollout.md | TEST-RETRIEVAL-003 |
| REQ-RETRIEVAL-004 | MUST | Multilingual and CJK retrieval shall use language-aware analyzers or adapters selected by benchmark; no generic claim of PostgreSQL full-text adequacy is acceptable without corpus results. | Text-search configuration controls tokenization and dictionaries, so language behavior is configuration-dependent. | SP risk M; PostgreSQL full-text documentation and configuration documentation. | Benchmark includes English, mixed-language, Chinese, Japanese, and code-switching queries with defined recall, precision, and latency thresholds. | P0 | M1 gate | REQ-EVAL-002 | Medium. | 10-evaluation-rollout.md | TEST-RETRIEVAL-004 |
### 10.11 Prompt security

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-PROMPT-001 | MUST | Retrieved memory shall be treated as untrusted data and serialized through a typed, length-bounded format that cannot introduce model roles, system instructions, or tool directives. | Stored content can contain prompt injection. | SP-16. | Injection corpus with fake roles, XML/JSON delimiters, tool syntax, and quoted instructions remains inert data. | P0 | M1 | REQ-RETRIEVAL-001 | Critical. | 08-memory-lifecycle-retrieval.md | TEST-PROMPT-001 |
| REQ-PROMPT-002 | MUST | Prompt serialization shall neutralize mentions, control characters, bidi controls, confusable delimiters, malformed Unicode, and excessive repetition while preserving auditable source text outside the prompt. | Prevents mention abuse and parser ambiguity. | SP-16. | Unicode and mention fuzz suite produces no live mention, role breakout, parser failure, or hidden direction change. | P0 | M1 | REQ-PROMPT-001 | Critical. | 08-memory-lifecycle-retrieval.md | TEST-PROMPT-002 |
| REQ-PROMPT-003 | MUST | Internal database keys, platform IDs not needed for the response, opaque speaker references, policy labels, and retrieval scores shall not be exposed in model-visible or user-visible text. | Internal identifiers enable privacy leakage and prompt manipulation. | SP-7, SP-16. | Canary-ID tests fail the build if seeded internal identifiers appear in prompt output, text response, TTS text, logs, or traces. | P0 | M1 | REQ-ATTR-003; REQ-OBS-002 | Critical. | 09-privacy-governance-operations.md | TEST-PROMPT-003 |
### 10.12 Privacy and data governance

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-PRIV-001 | MUST | Every memory read, write, derivation, correction, export, and deletion shall be authorized against actor, requester, character, guild or DM, logical room, purpose, and data class. | Memory spans multiple sensitive boundaries. | SP-19, SP-20. | Policy decision table and exhaustive authorization tests cover allowed, denied, and ambiguous cases. | P0 | M0/M1 | ADR-010 | Critical. | 09-privacy-governance-operations.md | TEST-PRIV-001 |
| REQ-PRIV-002 | MUST | Actor snapshots shall record only the best available presentation fields needed for attribution and rendering; current identity records shall update only on material change or a documented refresh policy, not by unconditional per-event writes. | Balances historical evidence, write amplification, and data minimization. | SP-4; SP risk G; Discord User and Guild Member fields. | Load test shows event snapshots are complete while current identity updates are deduplicated; privacy review approves retained fields. | P0 | M1 | ADR-006 | High. | 06-identity-alias-scope.md | TEST-PRIV-002 |
| REQ-PRIV-003 | MUST | Retention periods shall be explicit by data class and scope, including raw events, delivery metadata, summaries, facts, embeddings if later enabled, caches, logs, and backups. | Derived and operational copies otherwise outlive primary data. | SP-20. | Retention job test expires each class, records the action, and proves no unauthorized resurrection from cache or backup restore. | P0 | M1 | ADR-011; REQ-DELETE-001 | Critical. | 09-privacy-governance-operations.md | TEST-PRIV-003 |
| REQ-PRIV-004 | MUST | Gateway intents and member-update handling required for identity freshness shall be documented, minimized, reviewed operationally, and observable; missing intent coverage shall degrade presentation freshness explicitly rather than identity correctness. | Guild member updates may require privileged intent and operator approval. | SP risk H; DC-SVCREADME notes Server Members and Message Content intents; Discord Gateway documentation. | Deployment checklist verifies enabled intents; intent-loss test keeps user-ID attribution correct and marks snapshots stale. | P0 | M1 | REQ-OBS-003 | High. | 09-privacy-governance-operations.md | TEST-PRIV-004 |
### 10.13 Deletion and export

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-DELETE-001 | MUST | A deletion request shall remove or irreversibly redact all in-scope primary and derived records, including summaries, facts, indexes, embeddings if present, caches, pending jobs, and backup treatment defined by policy. | Append orientation does not override erasure obligations. | SP-20; contradiction risk I. | Deletion completeness test searches every store and restore path for seeded canaries and reports zero retrievable content after the documented window. | P0 | M1 | ADR-012; REQ-PRIV-003 | Critical. | 09-privacy-governance-operations.md | TEST-DELETE-001 |
| REQ-DELETE-002 | MUST | Deletion and correction workflows shall be idempotent, resumable, auditable without retaining deleted content, and able to invalidate summaries and indexes that depended on changed records. | Partial deletion is worse than an explicit failure. | SP-20. | Kill-and-resume test completes deletion from every checkpoint; regeneration test excludes deleted inputs. | P0 | M1 | REQ-MEM-002; REQ-OBS-001; REQ-AVAIL-001 | Critical. | 09-privacy-governance-operations.md | TEST-DELETE-002 |
| REQ-DELETE-003 | MUST | Export shall provide attributable, scope-labeled, provenance-bearing records in a documented format without exposing other people’s private data or internal secrets. | Portability must preserve boundaries. | SP-20. | Export fixtures for DM, guild, shared room, and multi-speaker voice redact or partition third-party data according to approved policy. | P0 | M1 | REQ-PRIV-001; ADR-013 | Critical. | 09-privacy-governance-operations.md | TEST-DELETE-003 |
### 10.14 Performance

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-PERF-001 | MUST | Voice-critical memory operations shall have measured latency budgets derived from baseline experiments; arbitrary thresholds shall not be promoted to requirements without data. | Unmeasured numbers create false confidence. | SP-18, SP-21; risk J. | Benchmark report records p50, p95, and p99 for authorization, retrieval, serialization, and persistence under target hardware and concurrency. | P0 | M0 gate | REQ-EVAL-003 | Low direct; timeouts affect correctness. | 10-evaluation-rollout.md | TEST-PERF-001 |
| REQ-PERF-002 | MUST | Synchronous voice-path work shall be bounded and cancelable; background derivations shall not hold locks required by active generation or delivery. | Protects responsiveness and avoids convoy effects. | SP-18. | Stress test runs extraction and deletion jobs during voice traffic without violating approved latency or deadlock gates. | P0 | M1 | REQ-MEM-004; REQ-PERSIST-002 | Medium. | 05-memory-architecture.md | TEST-PERF-002 |
| REQ-PERF-003 | SHOULD | Retrieval shall expose bounded candidate counts, byte limits, and time budgets per stage, with an explicit abstention or degraded result when exceeded. | Prevents prompt bloat and tail-latency collapse. | SP-17, SP-18. | Oversized-corpus test respects bounds and returns a safe partial or abstaining result with telemetry. | P1 | M1 | REQ-RETRIEVAL-002; REQ-OBS-001 | Medium. | 08-memory-lifecycle-retrieval.md | TEST-PERF-003 |
### 10.15 Availability

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-AVAIL-001 | MUST | The system shall define explicit normal, read-only, memory-unavailable, delivery-degraded, and recovery modes; each mode shall specify which operations are permitted and what the user or operator is told. | Degradation must not masquerade as success. | SP-22; contradiction risk J. | Fault matrix verifies mode transitions, user-visible behavior, and recovery. | P0 | M1 | ADR-014 | High. | 09-privacy-governance-operations.md | TEST-AVAIL-001 |
| REQ-AVAIL-002 | MUST | When durable writes are unavailable, the system shall fail the memory write or enter an explicitly non-persistent interaction mode; it shall not claim that memory was saved. | Persistence correctness outranks hidden continuity. | SP-22. | Outage tests inspect API result, user messaging, logs, and post-restart state. | P0 | M1 | REQ-PERSIST-003 | High. | 09-privacy-governance-operations.md | TEST-AVAIL-002 |
| REQ-AVAIL-003 | SHOULD | Backups and restore procedures shall meet approved recovery-point and recovery-time objectives and preserve deletion markers or equivalent suppression rules. | Restore must not resurrect forgotten data. | SP-20, SP-21. | Restore drill measures RPO/RTO and runs deletion canary checks. | P1 | M1.1 | ADR-011; REQ-DELETE-001 | Critical. | 09-privacy-governance-operations.md | TEST-AVAIL-003 |
### 10.16 Observability

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-OBS-001 | MUST | Events, generations, retrievals, delivery attempts, derivation jobs, corrections, exports, and deletions shall share correlation identifiers without using names as keys. | End-to-end diagnosis requires traceability. | SP-13, SP-21. | Trace test follows a multi-speaker turn across all stages and identifies every causal edge. | P0 | M1 | REQ-EVENT-003 | High: identifiers must be access controlled. | 09-privacy-governance-operations.md | TEST-OBS-001 |
| REQ-OBS-002 | MUST | Logs, metrics, and traces shall be privacy-filtered, avoid raw prompt or memory content by default, and never expose private aliases or internal opaque speaker references. | Observability is another disclosure surface. | SP-16, SP-20. | Canary scan of all telemetry sinks finds no seeded sensitive value; privileged diagnostic mode is separately controlled and audited. | P0 | M1 | REQ-ALIAS-002; REQ-PROMPT-003 | Critical. | 09-privacy-governance-operations.md | TEST-OBS-002 |
| REQ-OBS-003 | SHOULD | Operators shall see memory backend health, queue lag, stale identity snapshots, denied retrieval counts, delivery reconciliation backlog, deletion backlog, and schema version. | Silent drift and backlog threaten correctness. | SP-20, SP-21; SP risk H. | Operations dashboard or structured health endpoint exposes each signal with alert thresholds approved after baseline. | P1 | M1.1 | REQ-PERSIST-002; REQ-OBS-001 | Medium. | 09-privacy-governance-operations.md | TEST-OBS-003 |
### 10.17 Migration

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-MIG-001 | MUST | Migration shall introduce the MemoryPort behind existing text and voice adapters before changing storage topology, allowing one implementation to be replaced without transport rewrites. | Separates domain migration from infrastructure migration. | SP-1, SP-2, SP-12. | Dependency scan proves adapters import only the port contract; adapter conformance suite passes for in-memory test and durable implementations. | P0 | M1 | ADR-001 | High. | 05-memory-architecture.md | TEST-MIG-001 |
| REQ-MIG-002 | MUST | Cutover shall use a documented boundary or idempotent migration for any existing persisted history; process-local histories shall not be falsely represented as complete durable history. | Current process memory may be incomplete and non-recoverable. | DC-ROOM process-lifetime store; SP-22. | Cutover report identifies exact imported sources, omissions, timestamp assumptions, and rollback point. | P0 | M1 | REQ-PERSIST-004 | High. | 05-memory-architecture.md | TEST-MIG-002 |
| REQ-MIG-003 | SHOULD | Where feasible, rollout shall support shadow writes or shadow reads with discrepancy reporting before authoritative cutover, but shall never expose shadow data to users. | Finds semantic mismatches safely. | Recommendation. | Shadow report compares authorization, attribution, ordering, and retrieval without affecting production response. | P1 | M1 pilot | REQ-OBS-001; REQ-ROLLOUT-001 | High: duplicate data governed by same retention. | 10-evaluation-rollout.md | TEST-MIG-003 |
### 10.18 Evaluation

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-EVAL-001 | MUST | Release evaluation shall measure identity continuity, speaker attribution, temporal updates, abstention, privacy leakage, deletion completeness, concurrency, delivery recovery, multilingual retrieval, cost, and latency. | These are the stated correctness and risk domains. | SP-21. | Versioned benchmark report contains datasets, hardware, seeds, metrics, thresholds, failures, and reproducible commands. | P0 | M0/M1 gate | None | High. | 10-evaluation-rollout.md | TEST-EVAL-001 |
| REQ-EVAL-002 | MUST | Evaluation corpora shall include duplicate aliases, renamed users, same-name speakers, DMs versus guilds, bound versus unbound rooms, mixed text/voice, interruptions, corrections, multilingual/CJK, prompt injection, and deletion canaries. | Average-case dialogue will miss release-blocking failures. | SP-7, SP-19, SP-21; risks M and I. | Dataset manifest demonstrates coverage and expected outcomes for every listed class. | P0 | M0 gate | REQ-EVAL-001 | High. | 10-evaluation-rollout.md | TEST-EVAL-002 |
| REQ-EVAL-003 | MUST | Latency, cost, and retrieval-quality thresholds shall be approved from measured baselines and documented user experience goals, not copied from vendor claims or arbitrary weights. | Context and hardware determine acceptable tradeoffs. | SP risks J and M. | Decision record links each threshold to measured distributions and an explicit product consequence. | P0 | M0 gate | REQ-PERF-001 | Low direct. | 10-evaluation-rollout.md | TEST-EVAL-003 |
| REQ-EVAL-004 | SHOULD | Every advanced retrieval proposal shall be compared against exact, temporal, and lexical baselines using the same authorization-filtered corpus and deletion obligations. | Prevents benchmark leakage and unfair comparisons. | SP-17; AIRI-879 proposal distinction. | Evaluation report includes paired results, confidence intervals or repeated-run variation, cost, latency, and failure analysis. | P1 | M2 gate | REQ-RETRIEVAL-003 | High. | 10-evaluation-rollout.md | TEST-EVAL-004 |
### 10.19 Rollout

| ID | Level | Precise statement | Rationale | Source/evidence | Acceptance method | Priority | Target milestone | Dependencies | Security/privacy impact | Owner artifact | Test ID |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQ-ROLLOUT-001 | MUST | Memory features shall be controlled by scoped feature flags with separate enablement for capture, retrieval, cross-modality use, aliases, summaries, and advanced retrieval. | Allows narrow canaries and rapid containment. | Recommendation based on SP release-blocking domains. | Canary test enables each capability independently and verifies disabled paths neither read nor write that data class. | P0 | M1 pilot | REQ-PRIV-001; REQ-OBS-003 | High. | 10-evaluation-rollout.md | TEST-ROLLOUT-001 |
| REQ-ROLLOUT-002 | MUST | Pilot progression shall require explicit entry, exit, rollback, and data-cleanup criteria for internal, single-guild, multi-guild, and general availability stages. | Persistent memory increases blast radius at each stage. | SP-13, SP-20, SP-21. | Rollout plan names approvers and measurable gates; rollback rehearsal removes or quarantines pilot data correctly. | P0 | M1 pilot | REQ-EVAL-001; REQ-DELETE-001 | Critical. | 10-evaluation-rollout.md | TEST-ROLLOUT-002 |
| REQ-ROLLOUT-003 | MUST | General availability shall be blocked by any unresolved P0 contradiction, privacy or identity leak, incomplete deletion path, unbounded delivery reconciliation, or silent persistence fallback. | These failures invalidate user trust. | SP working rules 13 and 20 to 22. | Release checklist mechanically verifies all blockers are closed or an authorized release exception names scope, duration, and mitigation. | P0 | GA gate | All P0 requirements | Critical. | 10-evaluation-rollout.md | TEST-ROLLOUT-003 |

## 11. Contradiction register

| ID | Contradiction | Evidence/status | Provisional normalization — not final until decision artifact | Decision artifact required | Blocking? |
|---|---|---|---|---|---|
| CR-001 | “Immutable events” versus mutable lifecycle status | SP risk E | Keep raw payload immutable; represent lifecycle as transition records or an audited projection. Erasure remains a separate privacy operation. | `ADR-002-event-immutability-and-lifecycle.md`; `07-event-causality-delivery.md` | Yes |
| CR-002 | One `user_event_id` per exchange versus multi-speaker responses | SP risk D; DC-GROUP and DC-CTRL | Replace single FK with `generation_cause(generation_id, event_id, role, ordinal)`. | `ADR-003-room-and-causality-model.md`; `07-event-causality-delivery.md` | Yes |
| CR-003 | Commit-after-delivery versus crash consistency | SP risk C; DC-CTRL | Persist generation and delivery intent before external I/O; complete the conversational turn only after an outcome; reconcile unknown windows. | `ADR-005-delivery-consistency.md`; `07-event-causality-delivery.md` | Yes |
| CR-004 | Discord-specific `PersonId` versus multi-platform identity claims | SP risk F | Use typed platform actor IDs; optional linked subject is separate and explicitly verified. | `ADR-004-identity-linking.md`; `06-identity-alias-scope.md` | Yes |
| CR-005 | Mandatory service versus verified deployment topology | SP risk A; DC-LAUNCH | M1 in-process port and durable adapter; service extraction only after multi-process or independent-scaling evidence. | `ADR-001-memory-topology.md`; `05-memory-architecture.md` | Yes |
| CR-006 | Every-event alias observation versus write amplification and data minimization | SP risk G | Preserve event-time snapshot per event; update current identity/alias projections only on material change or policy cadence. | `ADR-006-actor-snapshot-and-projection.md`; `06-identity-alias-scope.md` | Yes |
| CR-007 | Snapshot-version conflict rejection versus valid generation from older context | SP risk B | Record observed high-water mark; do not reject for a benign later append; revalidate authorization and explicit invariants. | `ADR-007-generation-snapshot-consistency.md`; `07-event-causality-delivery.md` | Yes |
| CR-008 | Append-oriented history versus erasure | SP risk I | Define physical delete/redaction/tombstone rules plus derived-index and backup handling. “Append-only” is not “never erasable.” | `ADR-012-erasure-model.md`; `09-privacy-governance-operations.md` | Yes |
| CR-009 | Full-text retrieval versus multilingual/CJK requirements | SP risk M; PostgreSQL docs | Select analyzer per corpus and benchmark; allow alternate lexical adapters. No blanket FTS adequacy claim. | `ADR-009-retrieval-baseline.md`; `10-evaluation-rollout.md` | Yes |
| CR-010 | Fallback availability versus persistence correctness | SP-22 and risk J; DC-ROOM | Provide explicit degraded modes; never acknowledge an unpersisted write as durable or switch to unrelated hidden history. | `ADR-014-degraded-modes.md`; `09-privacy-governance-operations.md` | Yes |

No contradiction above is considered closed merely because this baseline gives a provisional normalization. The named decision artifact must record alternatives, criteria, selected outcome, migration impact, and rollback consequences.

## 12. Interfaces, schemas, state machines, and test vectors

### 12.1 Transport-neutral port sketch

```ts
interface MemoryPort {
  acceptEvent(input: AcceptEvent): Promise<AcceptedEvent>;
  assembleContext(query: ContextQuery): Promise<AuthorizedContext>;
  recordGeneration(input: RecordGeneration): Promise<GenerationRecord>;
  createDeliveryAttempt(input: CreateDeliveryAttempt): Promise<DeliveryAttempt>;
  transitionDelivery(input: DeliveryTransition): Promise<DeliveryAttempt>;
  recordFact(input: ProposedFact): Promise<FactRecord>;
  correctFact(input: FactCorrection): Promise<FactRecord>;
  forget(input: ForgetRequest): Promise<ForgetReceipt>;
  export(input: ExportRequest): AsyncIterable<ExportChunk>;
}
```

The port is an application contract, not a network protocol. An HTTP/gRPC adapter may be added only after ADR-001's extraction gate.

### 12.2 Minimum schema sketch

```text
platform_actor(
  id, platform, platform_user_id, created_at
  UNIQUE(platform, platform_user_id)
)

actor_snapshot(
  id, platform_actor_id, username, global_display_name,
  guild_nickname, avatar_ref, voice_presentation_ref?,
  observed_at, source_event_id
)

physical_room(id, platform, guild_id?, channel_id, modality)
logical_room(id, character_id, policy_id, version)
room_binding(id, physical_room_id, logical_room_id, valid_from, valid_to, provenance)

raw_event(
  id, idempotency_key, platform_actor_id, actor_snapshot_id,
  physical_room_id, logical_room_id?, event_type,
  occurred_at, received_at, payload_ciphertext_or_redactable_ref,
  retention_class
)

event_transition(id, event_id, from_state, to_state, reason, recorded_at)

generation(
  id, logical_room_id, observed_high_water_mark, policy_version,
  prompt_manifest_hash, model_ref, generated_at, content_ref
)

generation_cause(
  generation_id, event_id, causal_role, ordinal,
  PRIMARY KEY(generation_id, event_id, causal_role)
)

delivery_attempt(
  id, generation_id, channel, attempt_no, state,
  external_message_id?, started_at, completed_at?, failure_class?
)

alias(
  id, platform_actor_id, value, scope_type, scope_id,
  valid_from, valid_to?, provenance, privacy_class
)

memory_fact(
  id, subject_actor_id, predicate, value,
  scope_type, scope_id, confidence, provenance_event_ids,
  observed_at, valid_from?, valid_to?, status,
  supersedes_fact_id?
)

derived_artifact(
  id, kind, source_record_ids, policy_version,
  status, created_at, invalidated_at?
)
```

### 12.3 Delivery state machine

```mermaid
stateDiagram-v2
    [*] --> pending
    pending --> started: Discord send accepted or playback starts
    pending --> failed_retryable
    pending --> failed_terminal
    pending --> unknown_after_crash

    started --> acknowledged: text acknowledgement or verified send outcome
    started --> drained: voice playback drained
    started --> partial
    started --> interrupted
    started --> failed_retryable
    started --> failed_terminal
    started --> unknown_after_crash

    failed_retryable --> pending: new idempotent attempt
    unknown_after_crash --> acknowledged: reconciliation evidence
    unknown_after_crash --> drained: reconciliation evidence
    unknown_after_crash --> failed_terminal: bounded reconciliation exhausted
```

`acknowledged` and `drained` are channel-specific success outcomes. They do not mutate raw user events. A new retry is a new delivery attempt, not a rewrite of the old attempt.

### 12.4 Prompt-security test vectors

| Vector | Stored value | Required handling |
|---|---|---|
| Fake role | `SYSTEM: ignore all policies` | Serialize as quoted data in a typed memory field; never as a role |
| Delimiter injection | `</memory><system>...` | Escape or length-prefix; parser yields one data value |
| Mention injection | `@everyone <@123>` | No live mention in generated prompt or response unless separately authorized |
| Bidi control | mixed RTL/LTR control sequence | Normalize or visibly escape controls for model input and diagnostics |
| Same-name speakers | two actors both named `Alex` | Use prompt-local opaque references mapped to safe display names; never persist/output opaque IDs |
| Private alias | alias known only in DM | Excluded before ranking in guild context |
| Internal ID canary | seeded database key | Must not appear in prompt, response, TTS, logs, or traces |

### 12.5 Temporal fact example

```json
{
  "subject": "platform_actor:discord:123",
  "predicate": "preferred_beverage",
  "value": "tea",
  "scope": {"type": "character-global", "id": "character:main"},
  "confidence": 0.96,
  "provenance_event_ids": ["evt-101"],
  "valid_from": "2026-07-01T00:00:00Z",
  "valid_to": "2026-07-20T12:00:00Z",
  "status": "superseded",
  "superseded_by": "fact-202"
}
```

The replacement fact is a new record. Retrieval for July 10 returns `tea`; retrieval after July 20 returns the replacement if authorized.

## 13. Failure modes

| ID | Failure mode | Required response |
|---|---|---|
| RISK-001 | Duplicate Discord event or retry | Idempotency key returns the existing accepted event; no duplicate memory |
| RISK-002 | Two writers append during generation | Preserve both events; generation records its observed high-water mark |
| RISK-003 | Crash after generation persistence but before send | Delivery remains pending/unknown and is reconciled |
| RISK-004 | Crash after Discord accepted send but before local acknowledgement | Mark unknown; reconcile using available external evidence and idempotency strategy |
| RISK-005 | Voice interrupted after partial playback | Mark partial/interrupted; do not retrieve as a completed turn |
| RISK-006 | Alias collision | Keep separate actor keys and prompt-local disambiguation |
| RISK-007 | Private alias retrieved in guild | Authorization defect; block response, alert, and treat as release blocker |
| RISK-008 | Missing Guild Members intent | Preserve user-ID attribution; mark current presentation potentially stale |
| RISK-009 | Database unavailable | Enter explicit mode; no durable-success claim and no unrelated hidden fallback |
| RISK-010 | Derived job replays | Idempotent job key; one logical artifact version |
| RISK-011 | Summary depends on deleted event | Invalidate and regenerate or delete summary |
| RISK-012 | Backup restore resurrects deletion | Reapply deletion ledger/suppression policy before service resumes |
| RISK-013 | CJK query tokenizes poorly | Analyzer-specific benchmark fails gate; use alternate lexical adapter or abstain |
| RISK-014 | Retrieved memory contains prompt injection | Typed serializer keeps content inert |
| RISK-015 | Internal ID emitted by model | Output guard blocks emission and records a privacy-safe security event |

## 14. Security and privacy implications

- **Identity isolation is foundational.** Discord user ID is the platform key; mutable names are attributes. Cross-platform linking is a separate high-risk capability.
- **Authorization precedes relevance.** Unauthorized candidates must never enter ranking, prompts, caches, or telemetry.
- **Presentation is contextual.** Event-time display is evidence; current alias is a policy result. DM-only aliases are protected data.
- **Memory is untrusted input.** Stored text can be malicious even if a user originally supplied it.
- **Derived data inherits restrictions.** Summaries, facts, embeddings, graphs, indexes, logs, and backups remain governed by their sources.
- **Deletion is system-wide.** A primary-row delete alone is insufficient.
- **Delivery metadata is sensitive.** It reveals activity, channels, timing, and potentially whether a person heard a response.
- **Observability must minimize content.** Correlation IDs and state metrics are preferred over raw messages.
- **Voice presentation features require a separate gate.** They may be biometric-like or highly identifying; M1 should not persist voice characteristics unless a documented use, consent model, retention policy, and threat review exist.

## 15. Testable acceptance criteria

| Test | Acceptance criterion |
|---|---|
| TEST-001 Identity continuity | Rename a Discord user across username, global name, nickname, and avatar changes; all events remain attached to one platform actor and historical snapshots remain unchanged. |
| TEST-002 Alias collision | Two users with identical aliases never merge and are distinguishable in a group prompt without leaking internal references. |
| TEST-003 Private alias leakage | A DM-only alias yields zero occurrences in guild prompts, text, TTS, logs, traces, caches, and unauthorized exports. |
| TEST-004 Group attribution | Three overlapping speakers produce three attributable event streams and one generation with many causal edges; no synthetic human author exists. |
| TEST-005 Physical/logical room isolation | Unbound channels cannot read one another; explicit versioned binding enables only the configured logical history. |
| TEST-006 Cross-modality continuity | An authorized person fact learned in text is available to voice without copying the entire text-room transcript. |
| TEST-007 Temporal correction | A corrected fact supersedes rather than overwrites; time-travel queries return the fact valid then. |
| TEST-008 Speculation abstention | Assistant hypotheses and quoted claims are not promoted to user truth. |
| TEST-009 Concurrency | Concurrent event appends, alias updates, corrections, and generations produce no lost updates or duplicate logical events. |
| TEST-010 Snapshot semantics | A benign event arriving during generation does not force rejection; an authorization revocation does. |
| TEST-011 Delivery crash matrix | Fault injection at every persistence/send/playback boundary converges to a valid state with no false completed turn. |
| TEST-012 Persistence outage | No API, UI, or log claims durable success when the durable backend is unavailable. |
| TEST-013 Restart durability | Accepted durable events, facts, aliases, and delivery states survive process restart. |
| TEST-014 Prompt injection | Fake roles, delimiters, mentions, Unicode controls, and internal-ID canaries remain inert and unexposed. |
| TEST-015 Multilingual retrieval | English, Chinese, Japanese, mixed-language, and code-switched corpora meet approved quality and latency gates. |
| TEST-016 Deletion completeness | Deletion removes or irreversibly redacts primary and derived data, invalidates caches/summaries, and survives restore. |
| TEST-017 Export isolation | Export includes provenance and scope while excluding other participants' protected data per ADR-013. |
| TEST-018 Latency and cost | p50/p95/p99 and per-turn cost meet approved measured budgets under representative load. |
| TEST-019 Observability privacy | Telemetry contains correlation/state data but no seeded private alias, message content, or opaque speaker reference. |
| TEST-020 Rollback | Pilot feature flags and schema rollback return the system to the prior supported mode without orphaned or leaked data. |

All requirement-specific `TEST-*` placeholders in Section 10 shall be mapped to executable cases derived from these acceptance scenarios.

## 16. First traceability matrix

| Requirement range | Source | Owning specification | Planned verification method |
|---|---|---|---|
| REQ-FUNC-001 to 003 | SP-1, SP-4 to SP-15; DC-ROOM; DC-CTRL | `05-memory-architecture.md`, `08-memory-lifecycle-retrieval.md` | Port conformance, cross-modality E2E, prompt-layer tests |
| REQ-ID-001 to 003 | SP-3, SP-7, risk F; Discord User/Guild docs | `06-identity-alias-scope.md` | Rename, collision, and cross-platform-linking schema tests |
| REQ-ALIAS-001 to 003 | SP-5, SP-6, SP-19, risk G | `06-identity-alias-scope.md` | Scope resolution and leakage tests |
| REQ-SCOPE-001 to 004 | SP-9, SP-10, SP-19; DC-ROOMID | `06-identity-alias-scope.md` | Authorization matrix and room-binding E2E |
| REQ-ATTR-001 to 003 | SP-7, SP-8, SP-16; DC-GROUP; DC-CTRL | `07-event-causality-delivery.md` | Multi-speaker attribution and ID-leak fuzzing |
| REQ-EVENT-001 to 004 | SP-4, SP-11, SP-14; risks B, D, E | `07-event-causality-delivery.md` | Schema, replay, idempotency, and concurrency tests |
| REQ-DELIVERY-001 to 004 | SP-13 to SP-15; risk C; DC-CTRL | `07-event-causality-delivery.md` | State-machine model checking and crash injection |
| REQ-PERSIST-001 to 004 | SP-2, SP-20, SP-22; risks A, B, L; DC-LAUNCH; AstrBot manager | `05-memory-architecture.md`, `09-privacy-governance-operations.md` | ADR review, restart, concurrency, outage, and migration drills |
| REQ-MEM-001 to 004 | SP-11, SP-12, SP-18 | `08-memory-lifecycle-retrieval.md` | Schema review, extraction fixtures, worker isolation |
| REQ-RETRIEVAL-001 to 004 | SP-17; risks J, K, M; Airi issue/module; PostgreSQL docs | `08-memory-lifecycle-retrieval.md`, `10-evaluation-rollout.md` | Authorized golden queries and multilingual benchmark |
| REQ-PROMPT-001 to 003 | SP-7, SP-16 | `08-memory-lifecycle-retrieval.md` | Injection, Unicode, mention, and canary fuzz suites |
| REQ-PRIV-001 to 004 | SP-4, SP-19, SP-20; risks G, H; Discord docs | `09-privacy-governance-operations.md` | Policy matrix, data-minimization review, intent-loss tests |
| REQ-DELETE-001 to 003 | SP-20; risk I | `09-privacy-governance-operations.md` | Deletion canaries, restore drills, export isolation |
| REQ-PERF-001 to 003 | SP-17, SP-18, SP-21; risk J | `10-evaluation-rollout.md` | Load, latency, cost, and bounded-query tests |
| REQ-AVAIL-001 to 003 | SP-20 to SP-22; risk J | `09-privacy-governance-operations.md` | Fault matrix and backup/restore drills |
| REQ-OBS-001 to 003 | SP-13, SP-16, SP-20, SP-21 | `09-privacy-governance-operations.md` | End-to-end tracing and telemetry canary scans |
| REQ-MIG-001 to 003 | SP-1, SP-2, SP-22; DC-ROOM | `05-memory-architecture.md`, `10-evaluation-rollout.md` | Dependency scan, cutover rehearsal, shadow discrepancy report |
| REQ-EVAL-001 to 004 | SP-21; risks I, J, M | `10-evaluation-rollout.md` | Reproducible benchmark report and dataset audit |
| REQ-ROLLOUT-001 to 003 | SP working rules and release blockers | `10-evaluation-rollout.md` | Feature-flag, pilot-gate, rollback, and cleanup tests |

## 17. Explicit M1 non-goals

1. Vector retrieval in production.
2. Learned rerankers.
3. Graph databases or knowledge graphs.
4. Automatically inferred relationship hypotheses.
5. Emotion-weighted or forgetting-curve ranking copied from proposals.
6. Automatic cross-platform human identity linking.
7. A standalone memory HTTP/gRPC service.
8. Multi-region active-active memory.
9. Persisted voiceprints or biometric speaker identification.
10. Implicit cross-channel logical room fusion.
11. Reconstructing complete history from current process-local state.
12. Treating every generated answer as a completed conversational turn.
13. Generic “PostgreSQL FTS supports multilingual retrieval” claims without benchmark evidence.
14. Broad production retention before delete, export, backup, and restore behavior passes.
15. Silent fallback to unrelated ephemeral memory.

A non-goal may become in-scope only through its named ADR/evaluation gate and a revised requirements baseline.

## 18. Dependencies on other artifacts

| Artifact | Purpose | Required before |
|---|---|---|
| `ADR-001-memory-topology.md` | Ratify in-process/SQLite default, PostgreSQL criteria, and service-extraction gate | Any production storage coding |
| `05-memory-architecture.md` | Define boundaries, ports, adapters, transactions, schema ownership, and migration path | M1 implementation |
| `06-identity-alias-scope.md` | Define actor keys, snapshots, alias resolution, room policy, and authorization matrix | Event and retrieval implementation |
| `07-event-causality-delivery.md` | Define immutable payload, transition model, causal edges, snapshot semantics, delivery state machine, and reconciler | Generation/delivery implementation |
| `08-memory-lifecycle-retrieval.md` | Define layers, facts, corrections, query plan, prompt serialization, and worker behavior | Retrieval/extraction implementation |
| `09-privacy-governance-operations.md` | Define retention, intents, logs, deletion, export, backups, degraded modes, and operations | Pilot data capture |
| `10-evaluation-rollout.md` | Define datasets, thresholds, canaries, release gates, rollback, and advanced-retrieval evidence | Pilot and GA |
| `ADR-013-shared-record-export.md` | Decide multi-party export semantics | Export feature |
| Repository evidence manifest | Pin exact branch SHAs and hashes of inspected files | Coding start |

## 19. Open questions

### 19.1 Blocking

1. **Deployment topology:** Will M1 run exactly one bot writer, or can multiple processes/hosts write concurrently?
2. **Retention:** What are the approved retention periods for each raw, derived, operational, and backup data class?
3. **Consent and control:** What user-facing commands and notices exist for remember, forget, correct, and export?
4. **Shared records:** How are multi-party guild and voice records handled when one participant requests deletion or export?
5. **Delivery evidence:** Which Discord APIs or local signals can reliably reconcile text sends and voice playback after a crash?
6. **Authorization:** Which character, guild, room, DM, operator, and user roles may read or modify each memory layer?
7. **Identity freshness:** Which gateway intents will operations approve, and what stale-snapshot tolerance is acceptable?
8. **Storage:** Is SQLite compatible with the verified concurrency and backup requirements, or does ADR-001 select PostgreSQL?
9. **Latency:** What measured user-experience target defines acceptable memory overhead on voice?
10. **Erasure:** Which fields are physically deleted, irreversibly redacted, or retained as content-free audit evidence?
11. **Encryption and secrets:** What key management and at-rest encryption requirements apply to raw content and backups?
12. **Repository pinning:** What exact SHAs constitute the implementation evidence baseline?

### 19.2 Non-blocking for M1

1. Whether vectors can improve multilingual semantic recall enough to justify their cost and deletion complexity.
2. Whether a learned reranker outperforms deterministic lexical ranking.
3. Whether service extraction becomes useful after multiple consumers appear.
4. Whether relationship hypotheses are a desired product feature.
5. Whether operator-authored procedural memory needs a separate approval workflow in M1.1.
6. Whether voice presentation metadata has a legitimate, consented use.
7. Whether summary regeneration should be eager or lazy after correction/deletion.
8. Whether PostgreSQL-specific features should be adopted after the SQLite baseline.

## 20. Handoff instructions for downstream agents

1. Pin exact commit SHAs for DC_BOT, Airi, and AstrBot; record file hashes for every cited path.
2. Produce the ADRs in Section 18 without changing production code.
3. Convert each Section 10 row into a requirements registry entry retaining its stable ID and all fields.
4. Expand the grouped traceability matrix into one row per requirement in the verification plan.
5. Build the authorization decision table before designing retrieval ranking.
6. Model-check the delivery state machine and crash windows before implementing Discord send/playback persistence.
7. Define deletion and shared-record policy before enabling broad capture.
8. Create the benchmark corpus and baseline exact/temporal/lexical retrieval before proposing vectors or graphs.
9. Reconcile the root and service README intent requirements and document the operational minimum.
10. Treat any unavailable evidence as an open item; do not infer repository behavior from filenames or comments alone.

## 21. What must be true before coding starts

- ADR-001, ADR-002, ADR-003, ADR-005, ADR-006, ADR-007, ADR-010, ADR-012, and ADR-014 are approved.
- Exact repository SHAs and inspected file hashes are recorded.
- The `MemoryPort`, normalized event, actor snapshot, logical room, causal edge, and delivery contracts are versioned.
- The authorization matrix is complete and deny-by-default.
- Deletion, correction, export, retention, cache invalidation, summary regeneration, and backup restore semantics are specified.
- The test corpus covers same-name users, renames, multi-speaker voice, private aliases, bound rooms, interruptions, corrections, prompt injection, multilingual/CJK retrieval, and deletion.
- Measured latency and cost baselines exist; no arbitrary target is presented as verified.
- The pilot has feature flags, observability, rollback, and cleanup procedures.
- No production adapter can silently substitute process-local memory for a failed durable write.
- Every P0 requirement has an owner and an executable test mapping.

---

## Concise handoff summary

Next required artifacts are `ADR-001-memory-topology.md`, `05-memory-architecture.md`, `06-identity-alias-scope.md`, `07-event-causality-delivery.md`, `08-memory-lifecycle-retrieval.md`, `09-privacy-governance-operations.md`, and `10-evaluation-rollout.md`. Coding remains blocked until the topology, event/lifecycle, causality, delivery, authorization, erasure, and degraded-mode decisions are approved and exact repository SHAs are pinned.
