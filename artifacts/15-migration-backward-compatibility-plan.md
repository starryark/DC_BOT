# Migration and Backward-Compatibility Plan

**Artifact filename:** `15-migration-backward-compatibility-plan.md`  
**Status:** Proposed migration architecture; no production code  
**Primary repository:** `starryark/DC_BOT`  
**Inspected branch and head:** `main` at `0ea3cbf5ec92f719e2b48066c3ada45aa50122ad`  
**Comparison repositories:** `moeru-ai/airi` `main` at `4d6e61f77dc99ec76c7cf352df62abb4282386c5`; `AstrBotDevs/AstrBot` `master` at `49095d3ba3fca9272a67aa5eeab2f6c0719c5091`  
**Prepared:** 2026-08-01 America/Los_Angeles

## 1. Title and artifact filename

**Title:** Migration and Backward-Compatibility Plan  
**Artifact filename:** `15-migration-backward-compatibility-plan.md`

## Classification legend

Every substantive statement in this artifact is marked as one of:

- **Confirmed repository fact** — verified in an opened repository file, tree, commit, issue, or test.
- **Source-plan requirement** — required by the supplied migration baseline.
- **External research finding** — verified outside the primary repository.
- **Inference** — a conclusion derived from verified evidence but not directly stated by a source.
- **Recommendation** — a proposed migration decision.
- **Open question** — evidence or an approval is still required.

---

## 2. Executive conclusion

**Confirmed repository fact.** DC_BOT currently has two unrelated, process-local conversation-history authorities. Text mentions use a private `InMemoryRoomStore`; voice uses a per-guild `GuildSession` whose comments explicitly say that history is bounded, in memory, and not persisted to a database in v1. The direct-mode composition creates the voice `ConversationController` and text `MentionResponder` separately. Sources:

- https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/mention-responder.ts
- https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/guild-session.ts
- https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/index.ts

**Inference.** This is not primarily a bulk database-conversion exercise. Unless an operator has deployment-local files or an uninspected fork, most legacy conversational state exists only inside running processes and is already lost after a restart. A migration can preserve live state only if an inventory/export hook is introduced before the old process is stopped. The repository audit did not locate a DC_BOT conversation database schema, durable history file, or legacy record reader in the inspected conversation paths.

**Recommendation.** Introduce one transport-neutral `MemoryPort` and an additive canonical schema before changing text or voice behavior. The first deployment should remain in-process unless verified topology, scaling, or operational requirements justify a standalone runtime. Migration must be fidelity-preserving rather than identity-inventing:

1. Import records carrying a verified Discord user ID as Discord platform identities.
2. Preserve display names as historical presentation snapshots, never as identity keys.
3. Create isolated **legacy unresolved identities** for display-name-only or unknown speakers.
4. Quarantine synthetic `Discord group` turns and other collapsed multi-speaker records from person-level memory.
5. Preserve uncertain voice scope in a restricted legacy room; never guess a physical voice channel from a guild-collapsed identifier.
6. Mark legacy text assistant responses as `unknown_legacy` delivery unless independent Discord send evidence exists; current text history is appended before the reply send, while current voice history is committed only after playback drains.
7. Prefer dry-run plus shadow comparison over mandatory dual write. Enable dual read or dual write only behind explicit flags and only after deterministic reconciliation is proven.
8. Make post-cutover writes irreversible to old semantics. A downgrade after new-only records exist is read-only or restore-from-backup, not a faithful write downgrade.

**Source-plan requirement.** Historical identities must never be merged using display-name equality alone. Discord user ID is a durable Discord identity key, not proof of a cross-platform human identity.

---

## 3. Scope

### 2.1 In scope

**Recommendation.** This plan covers:

- Existing text in-memory histories.
- Existing voice in-memory histories.
- Any deployment-local persisted legacy records discovered during inventory.
- Records with known Discord user IDs.
- Records containing display names only.
- Synthetic `Discord group` entries.
- Unknown, ambiguous, or conflicting speakers.
- Existing text, thread, DM, and voice room identifiers.
- Incorrect or guild-collapsed voice-room identifiers.
- Existing tests, test builders, and fixtures touching history, speaker, room, ordering, or delivery behavior.
- Transitional `userId` and `displayName` input fields.
- Additive schema rollout, optional dual read, optional dual write, cutover, rollback, cleanup, and downgrade limits.
- Counts, checksums, referential integrity, identity, scope, ordering, delivery, privacy, and deletion validation.

### 2.2 Out of scope

**Recommendation.** This plan does not:

- Write or modify production code.
- Select SQLite versus PostgreSQL without deployment evidence.
- Require a standalone HTTP service.
- Define semantic-memory extraction, embedding, graph construction, or reranking algorithms.
- Retroactively infer identities from names, writing style, voice characteristics, or model guesses.
- Treat a Discord identity as a verified cross-platform person.
- Migrate TTS cache entries, audio reference profiles, telemetry, or unrelated configuration as conversational memory.
- Promise recovery of process-local history that no longer exists.

---

## 4. Sources inspected

| Source ID | Repository / artifact | Branch / SHA | Inspected material | Direct URL |
|---|---|---:|---|---|
| SRC-PLAN-001 | Supplied source-plan baseline | Uploaded artifact | Requirements, risks, mandatory rules, assignment | User-supplied `15_migration_plan.txt` |
| SRC-DC-001 | DC_BOT | `main` / `0ea3cbf5ec92f719e2b48066c3ada45aa50122ad` | Commit head | https://github.com/starryark/DC_BOT/commit/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad |
| SRC-DC-002 | DC_BOT | same | Text mention history and room selection | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/mention-responder.ts |
| SRC-DC-003 | DC_BOT | same | Voice history model | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/guild-session.ts |
| SRC-DC-004 | DC_BOT | same | Per-guild voice registry and lifecycle | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-state.ts |
| SRC-DC-005 | DC_BOT | same | Voice event admission, grouping, generation, playback, commit | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-controller.ts |
| SRC-DC-006 | DC_BOT | same | Room-ID helpers | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/room-id.ts |
| SRC-DC-007 | DC_BOT | same | Input-event identity fields | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/events.ts |
| SRC-DC-008 | DC_BOT | same | Multi-speaker group prompt | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/group-turn-builder.ts |
| SRC-DC-009 | DC_BOT | same | Discord adapter, intents, text event, send ordering | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/adapters/airi-adapter.ts |
| SRC-DC-010 | DC_BOT | same | Text-history tests | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/mention-responder.test.ts |
| SRC-DC-011 | DC_BOT | same | Room isolation and bounding tests | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/room.test.ts |
| SRC-DC-012 | DC_BOT | same | Voice grouping, playback, and history tests | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-controller.test.ts |
| SRC-DC-013 | DC_BOT | same | Voice session reset test | https://github.com/starryark/DC_BOT/blob/0ea3cbf5ec92f719e2b48066c3ada45aa50122ad/airi/services/discord-bot/src/orchestration/conversation-state.test.ts |
| SRC-AIRI-001 | Airi | `main` / `4d6e61f77dc99ec76c7cf352df62abb4282386c5` | Current head | https://github.com/moeru-ai/airi/commit/4d6e61f77dc99ec76c7cf352df62abb4282386c5 |
| SRC-AIRI-002 | Airi | same | `memory-pgvector` module skeleton | https://github.com/moeru-ai/airi/blob/4d6e61f77dc99ec76c7cf352df62abb4282386c5/packages/memory-pgvector/src/index.ts |
| SRC-AIRI-003 | Airi | current issue state | Alaya memory-layer proposal | https://github.com/moeru-ai/airi/issues/879 |
| SRC-ASTR-001 | AstrBot | `master` / `49095d3ba3fca9272a67aa5eeab2f6c0719c5091` | Current head | https://github.com/AstrBotDevs/AstrBot/commit/49095d3ba3fca9272a67aa5eeab2f6c0719c5091 |
| SRC-ASTR-002 | AstrBot | same | Conversation and platform-message models | https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/db/po.py |
| SRC-ASTR-003 | AstrBot | same | Create/update/query history operations | https://github.com/AstrBotDevs/AstrBot/blob/49095d3ba3fca9272a67aa5eeab2f6c0719c5091/astrbot/core/db/sqlite.py |

**Open question.** No running DC_BOT process, production data directory, database, backup, deployment manifest, or operator export was available. Repository inspection cannot prove the absence of deployment-local legacy records.

---

## 5. Evidence table

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| EVID-001 | Text mentions use a private `InMemoryRoomStore`. | Confirmed repository fact | SRC-DC-002 | High |
| EVID-002 | Text rooms distinguish guild text channels, threads, and DMs; malformed guild input can fall back to an `unknown:<userId>` component. | Confirmed repository fact | SRC-DC-002, SRC-DC-006 | High |
| EVID-003 | Text input carries `userId` and `displayName`; remembered user turns retain the display name as `speaker`, not as a durable identity relation. | Confirmed repository fact | SRC-DC-002, SRC-DC-007, SRC-DC-009 | High |
| EVID-004 | Text history is appended after generation but before `message.reply` / subsequent sends. | Confirmed repository fact | SRC-DC-002, SRC-DC-009 | High |
| EVID-005 | Voice history is bounded, process-local, per guild, and explicitly not persisted to a database in v1. | Confirmed repository fact | SRC-DC-003, SRC-DC-004 | High |
| EVID-006 | `GuildSession.asRoom()` constructs `voiceRoom(guildId, guildId)`, so the room identifier is guild-collapsed rather than based on the actual voice channel ID. | Confirmed repository fact | SRC-DC-003, SRC-DC-006 | High |
| EVID-007 | Voice utterances carry actual `guildId`, `channelId`, `userId`, and `displayName` before they are projected into legacy history. | Confirmed repository fact | SRC-DC-005, SRC-DC-007 | High |
| EVID-008 | Group prompt text preserves per-speaker display labels, but the accepted grouped turn uses the latest message’s `userId` and the synthetic display name `Discord group`. | Confirmed repository fact | SRC-DC-005, SRC-DC-008 | High |
| EVID-009 | Voice history is committed only after the playback epoch drains and succeeds. | Confirmed repository fact | SRC-DC-005 | High |
| EVID-010 | Existing tests assert per-channel text isolation, deterministic room IDs, shared voice-room history, bounded history, multi-speaker grouping, and playback completion before the next accepted turn. | Confirmed repository fact | SRC-DC-010 through SRC-DC-013 | High |
| EVID-011 | The adapter currently requests Guilds, GuildMessages, MessageContent, DirectMessages, and GuildVoiceStates, but not GuildMembers. | Confirmed repository fact | SRC-DC-009 | High |
| EVID-012 | No DC_BOT persistent conversation schema or history repository was found in the inspected conversation implementation; both active authorities are explicitly in memory. | Inference from confirmed repository facts | SRC-DC-002 through SRC-DC-005 | Medium |
| EVID-013 | Airi contains a `memory-pgvector` package, but its current entry point is a minimal module-registration skeleton; the broader Alaya abstraction is proposed as WIP in an issue. | Confirmed repository fact | SRC-AIRI-002, SRC-AIRI-003 | High |
| EVID-014 | AstrBot defines persisted platform message rows with `platform_id`, `user_id`, optional sender fields, JSON content, and CRUD operations; it also supports replacing whole conversation content. | Confirmed repository fact | SRC-ASTR-002, SRC-ASTR-003 | High |
| EVID-015 | Display-name equality must never be used to merge historical identities. | Source-plan requirement | SRC-PLAN-001 | High |
| EVID-016 | Delivery, privacy, deletion, identity attribution, and room isolation are release-blocking. | Source-plan requirement | SRC-PLAN-001 | High |

---

## 6. Current-state findings

### 5.1 Text history

**Confirmed repository fact.** `MentionResponder` owns an `InMemoryRoomStore`. It chooses a deterministic room for guild text channels and threads and a per-user DM room. Its tests prove same-channel continuation and isolation across guild channels, a channel versus thread, and DM users. The store is bounded by the configured maximum and is cleared with process loss. Sources: SRC-DC-002, SRC-DC-010, SRC-DC-011.

**Confirmed repository fact.** A text event includes a Discord author ID and a current presentation name selected from guild member display name or author display name. The remembered `ConversationTurn` records the display name in `speaker`; the turn structure used by the in-memory store does not establish a durable actor foreign key. Source: SRC-DC-002 and SRC-DC-009.

**Confirmed repository fact.** The responder appends user and assistant turns after a successful model result. The adapter then attempts Discord delivery. A crash or send failure can therefore leave an assistant turn in history even though the user did not receive all or any chunks. Source: SRC-DC-002 and SRC-DC-009.

**Migration consequence — Recommendation.** Live text history can be imported only from a still-running process or an operator-supplied dump. Imported assistant turns must default to `delivery_status=unknown_legacy`, not `delivered`.

### 5.2 Voice history

**Confirmed repository fact.** `GuildSession` holds an array of conversation turns, bounds it, and states that voice history is per guild and not persisted in v1. The registry creates one `GuildSession` per guild and preserves committed history when resetting transient session state. Sources: SRC-DC-003, SRC-DC-004, SRC-DC-013.

**Confirmed repository fact.** `commitExchange` stores a speaker label, text, optional language, and assistant text. It does not store the user ID that existed on the accepted input. Source: SRC-DC-003.

**Confirmed repository fact.** The current voice event pipeline has the actual voice channel ID and Discord user ID before commit. For an ordinary single-speaker turn, the accepted turn retains these fields. For grouped input, speaker-labeled prompt content is built from individual messages, but the accepted group turn is projected as `displayName: "Discord group"` and `userId` equal to one message rather than a many-to-many participant relation. Sources: SRC-DC-005, SRC-DC-007, SRC-DC-008.

**Confirmed repository fact.** Voice commits only after generation, synthesis, playback scheduling, and `awaitPlaybackDrained`; stale or cancelled epochs return before history mutation. Source: SRC-DC-005.

**Migration consequence — Recommendation.** A migrated ordinary voice assistant response may be classified as `played_legacy` only when it came from a completed legacy exchange captured after commit. A grouped user turn must never be attributed to the latest user ID merely because that value survived in the accepted wrapper.

### 5.3 Persisted legacy records

**Inference.** No DC_BOT persisted conversation records were found in the audited repository paths. This is not proof that deployments contain none. Operators may have logs, custom dumps, hot-reload snapshots, fork-specific tables, or manual exports.

**Recommendation.** Treat every discovered source as untrusted legacy input with a registered source type, schema version, byte checksum, acquisition time, and custodian. Do not import an unregistered file by guessing its schema.

### 5.4 Identity state

**Confirmed repository fact.** Current inbound text and voice events carry `userId` and `displayName`. Existing remembered turns reduce this to a display label in both text and voice history. Sources: SRC-DC-002, SRC-DC-003, SRC-DC-005, SRC-DC-007, SRC-DC-009.

**Source-plan requirement.** Discord user ID is the durable Discord identity key. Usernames, display names, guild nicknames, aliases, avatars, and voice characteristics are attributes. Two people sharing a name must not merge.

**Inference.** Historical process-local turns containing only `speaker="Alice"` cannot be safely attached to `discord:user:<id>` without evidence outside the turn itself, even if only one current guild member is named Alice.

### 5.5 Room and scope state

**Confirmed repository fact.** Room-ID helpers encode guild, medium, and physical channel for text, thread, and voice. Tests state that two channels in one guild must not share history and two users in one voice room should share that room’s history. Sources: SRC-DC-006, SRC-DC-011.

**Confirmed repository fact.** The voice history projection violates the intended physical-room distinction by calling `voiceRoom(guildId, guildId)`. Source: SRC-DC-003.

**Inference.** Historical voice turns captured from the legacy `GuildSession` establish, at most, guild-level legacy scope unless a contemporaneous source record also contains the actual voice channel ID. Mapping them to whichever voice channel is active during migration would invent scope.

### 5.6 Delivery state

**Confirmed repository fact.** Text persistence and Discord send are ordered differently from voice playback and commit. Text remembers before send; voice commits after playback drain. Sources: SRC-DC-002, SRC-DC-005, SRC-DC-009.

**Source-plan requirement.** Generation, persistence, and delivery are separate. Database state and Discord delivery cannot be atomically committed.

**Recommendation.** Canonical migration must model legacy delivery uncertainty explicitly rather than mapping every assistant turn to a completed exchange.

### 5.7 Existing tests and fixtures

**Confirmed repository fact.** Relevant tests include:

- `mention-responder.test.ts`: history continuation, room isolation, no commit on failed generation, same-room serialization, cross-room overlap.
- `room.test.ts`: deterministic room IDs, text isolation, shared voice-room history, bounded turns, clear behavior.
- `conversation-controller.test.ts`: per-speaker group prompt construction, multi-guild independence, speaker-aware deduplication, successful paired history, playback gating.
- `conversation-state.test.ts`: session reset preserves committed history.

**Recommendation.** These tests are compatibility inputs, not unquestionable target semantics. Keep their valid isolation and ordering guarantees, but replace assertions that depend on speaker strings or guild-collapsed voice history with canonical actor and room assertions.

### 5.8 Comparison-repository findings

**Confirmed repository fact.** Airi’s `memory-pgvector` package exists, but the inspected entry point only registers a module client and an empty configuration handler. Issue #879 describes a proposed Alaya abstraction and characterizes memory logic as incomplete/scattered. Sources: SRC-AIRI-002 and SRC-AIRI-003.

**Recommendation.** Do not make DC_BOT migration depend on an unverified future Airi memory runtime. Preserve an adapter boundary so an upstream implementation can be integrated later.

**Confirmed repository fact.** AstrBot provides persisted platform message rows with platform/user/sender fields and JSON content, and provides create/update operations for conversation content. Sources: SRC-ASTR-002 and SRC-ASTR-003.

**Recommendation.** Reuse the product lesson that conversations can be persisted and independently listed, but do not copy a mutable whole-history JSON write model as DC_BOT’s canonical concurrent event model.

---

## 7. Proposed decisions

### ADR-015-001 — Canonical authority and deployment topology

**Decision — Recommendation.** Introduce one transport-neutral `MemoryPort` used by text and voice. Its first implementation should be an in-process application/domain component backed by an approved transactional store. A standalone runtime remains a later deployment option.

**Rationale.** The repository does not currently demonstrate a deployment need that makes a network service mandatory, while two in-process authorities are the immediate correctness problem.

### ADR-015-002 — Additive schema first

**Decision — Recommendation.** Prepare canonical tables and compatibility readers without removing or changing legacy fields. All new columns used during rolling deployment are nullable or have safe defaults until every active writer supports them.

### ADR-015-003 — Discord identity

**Decision — Source-plan requirement.** A verified Discord user ID maps to a platform actor key such as `discord:user:<snowflake>`. It must not be promoted automatically to a cross-platform human identity.

### ADR-015-004 — Legacy unresolved identity

**Decision — Recommendation.** A **legacy unresolved identity** is an isolated surrogate principal representing one unresolved source-speaker occurrence or a source-defined continuity group. It is not a Discord user and is never auto-merged by name.

Canonical shape:

- `legacy_actor_id`: opaque migration-generated ID.
- `source_id`: registered import source.
- `source_partition`: room/session/file partition.
- `historical_display_snapshot`: exact label preserved from the record.
- `resolution_status`: enum defined below.
- `candidate_actor_ids`: optional, non-authoritative evidence references.
- `created_by_migration_run_id`.

Default grouping rule: one unresolved principal per source partition plus stable source-native speaker key. When no stable source-native key exists, use one unresolved principal per event. Display-name equality is never a stable key.

### ADR-015-005 — Historical display snapshot

**Decision — Recommendation.** A **historical display snapshot** is the exact best-available presentation label attached to an event at capture time. It is immutable event evidence, untrusted prompt data, and not an identity key. Current addressing uses a separately authorized current alias.

### ADR-015-006 — Resolution status and evidence

**Decision — Recommendation.** Use these statuses:

- `not_required` — event already has a verified platform actor ID.
- `unresolved` — no safe actor link exists.
- `candidate` — one or more possible actors have evidence, but not enough for resolution.
- `resolved_automatic` — resolved using deterministic source evidence, never name equality.
- `resolved_manual` — resolved by an authorized operator with recorded evidence and reason.
- `quarantined` — attribution or scope is too ambiguous for normal retrieval.
- `invalidated` — a previous resolution was withdrawn or superseded.

Evidence sufficient for automatic resolution:

1. The original record contains a syntactically valid Discord user ID in an author field whose source semantics are known; or
2. A cryptographically or transactionally linked source record connects the legacy record to such an ID; or
3. A deterministic source-native key is mapped through an operator-approved, versioned identity map whose provenance predates migration.

Evidence not sufficient by itself:

- Equal display name, username, nickname, or alias.
- Similar message content, writing style, language, avatar, or voice.
- “Only current member with this name.”
- LLM or embedding similarity.
- Temporal co-occurrence without a source-author link.

### ADR-015-007 — Manual resolution

**Decision — Recommendation.** Manual resolution is allowed only when:

- The operator has a role authorized for identity adjudication.
- The target is a Discord platform actor, not an inferred cross-platform person.
- Evidence type, evidence reference, reason, operator ID, timestamp, and previous status are recorded.
- A second reviewer approves resolutions that would expose private/person-level memory across rooms.
- The original unresolved actor and event attribution remain auditable; resolution creates a superseding link rather than rewriting source evidence.

### ADR-015-008 — Grouped history quarantine

**Decision — Recommendation.** A synthetic `Discord group` record is an aggregate conversational artifact, not a person. It must be imported as one of:

- `aggregate_group_input` with explicit child source events and many-to-many response causes, when those child events exist; or
- `quarantined_aggregate` with no person attribution, when only collapsed prompt text survives.

It must never become a user profile, alias, or durable person fact. The latest user ID on the legacy wrapper is not sufficient attribution evidence.

### ADR-015-009 — Uncertain room scope

**Decision — Recommendation.** Historical records whose only room evidence is `guild:<g>:voice:<g>` or another guild-only key are assigned to `legacy:guild:<g>:voice:unknown`. This room:

- Is isolated from all physical and logical rooms by default.
- Is excluded from person-level and room-level retrieval unless explicitly requested by an authorized migration review tool.
- Can be bound later only with evidence and an audited `room_resolution` decision.
- Never binds to the currently active voice channel merely because migration runs there.

### ADR-015-010 — Dual-read policy

**Decision — Recommendation.** Dual read is optional and diagnostic. During a bounded evaluation window, the application may read both authorities and compare normalized outputs, but only one result is returned to generation. The canonical store becomes read-authoritative per scoped rollout cohort. Legacy fallback is forbidden after a canonical write failure.

### ADR-015-011 — Dual-write policy

**Decision — Recommendation.** Dual write is off by default. If enabled, canonical write is authoritative and must succeed first. The legacy projection is best-effort and monitored. A failed canonical write is a failed operation; the bot must not silently claim memory success because the legacy in-memory append succeeded.

### ADR-015-012 — Downgrade boundary

**Decision — Recommendation.** A full write downgrade is supported only before canonical-only records are accepted. After cutover, older versions may at most consume a lossy, read-only compatibility projection. They cannot faithfully represent many-to-many causes, unresolved identities, room bindings, delivery states, corrections, or deletion tombstones.

---

## 8. Alternatives considered

| Alternative | Classification | Benefits | Risks / limitations |
|---|---|---|---|
| Discard all legacy state and start clean | Alternative | Simple; no ambiguous imports | Loses recoverable live context and audit evidence; does not solve rolling deployment |
| Merge display-name-equal speakers | Alternative | High apparent match rate | Violates non-negotiable identity rule; privacy and attribution failures |
| Map all guild-collapsed voice history to the current voice channel | Alternative | Produces a physical room ID | Invents historical scope; leaks history across channels |
| Create a mandatory HTTP memory service immediately | Alternative | Central process boundary | Adds failure modes and deployment cost without verified need |
| Always dual write indefinitely | Alternative | Easy fallback story | Split-brain semantics, write amplification, uncertain authority, permanent cleanup blocker |
| Import `Discord group` as a normal user | Alternative | Minimal transformation | Creates a synthetic person and contaminates person memory |
| Attribute grouped input to the latest user ID | Alternative | Uses an available field | Contradicts the actual multi-speaker source; silently misattributes others’ content |
| Treat all assistant legacy turns as delivered | Alternative | Simple completed exchanges | Incorrect for text, where history precedes send |
| Copy AstrBot-style whole-history replacement as canonical model | Alternative | Familiar CRUD | Concurrent lost-update and audit-granularity concerns unless protected by stronger versioning |
| Wait for Airi Alaya and perform no local migration work | Alternative | Potential upstream alignment | Current implementation is not a verified complete dependency; blocks DC_BOT correctness |

---

## 9. Rejected alternatives and reasons

### REJ-015-001 — Display-name identity merge

**Rejected — Source-plan requirement.** Two users can share a name, names change, and private aliases can differ by scope. Name equality is presentation evidence only.

### REJ-015-002 — Current-channel repair of legacy voice room IDs

**Rejected — Recommendation.** It converts missing evidence into a false fact. Quarantine preserves auditability without leaking history.

### REJ-015-003 — Synthetic group person

**Rejected — Recommendation.** `Discord group` is a prompt projection, not a Discord actor. It must not own facts or aliases.

### REJ-015-004 — Indefinite dual authority

**Rejected — Recommendation.** Migration must converge on one authority. Permanent dual read/write creates incompatible conflict rules and makes deletion completeness unprovable.

### REJ-015-005 — Mandatory microservice in milestone one

**Rejected pending evidence — Recommendation.** The first milestone should solve authority and schema correctness. A service boundary can be introduced behind `MemoryPort` when deployment evidence requires it.

### REJ-015-006 — Faithful downgrade after canonical-only writes

**Rejected — Recommendation.** The old schemas cannot represent required semantics. Claiming otherwise would silently discard causality, identity uncertainty, and delivery state.

---

## 10. Normative specification and detailed migration plan

Normative terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used as requirements.

### Phase 1 — Inventory

**Goal — Recommendation.** Establish exactly what exists before any transformation.

#### Required actions

1. Register every source as a `legacy_source` with owner, path or process, source type, schema version, acquisition time, read-only status, and SHA-256 of the original bytes or export stream.
2. Enumerate all running bot instances, versions, guild assignments, and restart policies.
3. Determine whether a running instance can expose a read-only snapshot of:
   - Text `InMemoryRoomStore` rooms, recent turns, summaries, and active modes.
   - Voice `GuildSession` histories per guild.
   - Pending or active generations separately from committed history.
4. Search deployment directories, volumes, backups, and operator scripts for persisted history exports. Do not infer from filenames; register and inspect schemas explicitly.
5. Count records by source, medium, guild, room key, role, presence of `userId`, presence of `displayName`, synthetic label, parse status, and timestamp availability.
6. Freeze deletion requests and retention rules into the migration manifest so prohibited data is never imported.
7. Record source time-zone semantics and timestamp precision.
8. Preserve a byte-for-byte source copy in restricted storage when policy permits; otherwise record a source checksum and a policy-approved redacted capture.

#### Inventory classifications

Every record MUST receive one preliminary class:

- `known_discord_actor`
- `display_only_actor`
- `synthetic_group`
- `unknown_actor`
- `assistant`
- `system_or_control`
- `malformed`
- `out_of_retention`
- `deletion_blocked`

#### Exit gate

- Every source is registered or explicitly declared unavailable.
- Counts by class reconcile to total source records.
- No production source is modified.
- Operators sign the list of unavailable process-local histories.

#### Rollback point RP-01

No canonical writes have occurred. Rollback means discard inventory working tables while retaining signed manifests and source checksums.

### Phase 2 — Schema preparation

**Goal — Recommendation.** Deploy an additive canonical schema and compatibility contracts without switching authority.

#### Required canonical entities

- `platform_actor`
- `actor_snapshot`
- `legacy_unresolved_actor`
- `identity_resolution`
- `physical_room`
- `logical_room`
- `room_binding`
- `legacy_room_resolution`
- `conversation_event`
- `event_payload`
- `assistant_generation`
- `response_cause`
- `delivery_attempt`
- `event_state_transition`
- `migration_run`
- `migration_source_record`
- `migration_record_map`
- `deletion_tombstone`

#### Compatibility requirements

- New schema additions MUST be backward-compatible with the currently deployed binary.
- Transitional inbound DTOs MAY continue accepting `userId` and `displayName`.
- Canonical normalization MUST map these to `actor.platformActorId` and `actor.historicalDisplaySnapshot` when possible.
- Old writers MUST NOT be given write access to tables they do not understand.
- New readers MUST tolerate absent canonical fields during the rolling window.
- Schema version and writer version MUST be recorded on every canonical write.

#### Exit gate

- Empty schema migration succeeds and reverses in a production-like copy.
- Old binary starts and performs its normal operations while new tables are present.
- New binary can run in `memory_mode=legacy_only` without writing canonical conversational data.

#### Rollback point RP-02

Reverse only additive, unused schema objects. Do not drop objects after any canonical record is written; disable them instead.

### Phase 3 — Dry run

**Goal — Recommendation.** Parse and classify without inserting canonical domain records.

#### Required actions

1. Parse every inventory source into a staging representation.
2. Compute a raw-record checksum and deterministic normalized-record checksum.
3. Produce proposed actor and room resolutions with rule IDs.
4. Produce a `cannot_safely_migrate` report.
5. Produce expected source-to-target cardinality:
   - One legacy turn may produce one event plus snapshots and ledger rows.
   - One grouped turn may produce one aggregate event plus zero or more child links.
   - One assistant exchange may produce generation, event, cause, and delivery rows.
6. Run privacy filters before any target insert.
7. Re-run dry run at least twice and require byte-identical normalized manifests.

#### Exit gate

- Determinism: normalized manifest checksum matches across runs.
- Zero unresolved parser crashes.
- All rejects have a reason code.
- No display-name-only record is proposed as a resolved Discord actor.

#### Rollback point RP-03

Delete staging outputs. Source manifests remain immutable.

### Phase 4 — Migration simulation

**Goal — Recommendation.** Insert into an isolated target copy and exercise transformations end to end.

#### Required actions

1. Restore a production-like empty or sanitized target.
2. Import using idempotency key `(migration_run_id, source_id, source_record_key, transform_version)`.
3. Create source-to-target mapping rows for every inserted, skipped, quarantined, or rejected record.
4. Simulate concurrent live events arriving after the inventory high-water mark.
5. Simulate retries, partial batch failure, and process restart.
6. Simulate manual identity and room resolutions, then invalidate them.
7. Simulate privacy deletion before import, during import, and after import.
8. Generate a lossy old-schema projection and quantify what cannot round-trip.

#### Exit gate

- Re-running the same import creates no duplicate domain records.
- Batch restart resumes from the last committed source boundary.
- Source-to-target mappings reconcile all source rows.
- Privacy deletions remove or redact all derived forms in the simulation.

#### Rollback point RP-04

Drop or restore the simulation target only. No production authority change.

### Phase 5 — Validation

**Goal — Recommendation.** Prove invariants before live dual-read or write behavior.

#### Required validations

- Counts and checksums defined in Section 10.8.
- Referential integrity defined in Section 10.9.
- Identity invariants defined in Section 10.10.
- Scope invariants defined in Section 10.11.
- Event-order invariants defined in Section 10.12.
- Delivery-state invariants defined in Section 10.13.
- Privacy validation defined in Section 12.
- Performance measurements for canonical append and recent-context read.

#### Exit gate

All release-blocking acceptance tests in Section 13 pass. Any exception requires a recorded risk acceptance; identity, privacy, deletion, room leakage, and delivery falsification cannot be waived.

#### Rollback point RP-05

Remain on legacy authority. Fix schema or transform logic and repeat Phases 3–5.

### Phase 6 — Optional dual read

**Goal — Recommendation.** Compare behavior without introducing two write authorities.

#### Required behavior

- Enable only for selected test guilds or rooms.
- Read legacy and canonical sources independently.
- Normalize to a comparison model that excludes known non-round-trippable fields.
- Log only hashes and structured differences by default; raw text requires restricted diagnostic mode.
- Choose one authority for prompt construction per cohort. Do not merge result sets ad hoc.
- If canonical read fails, return an explicit memory-unavailable behavior or use an approved, visible fallback policy. Do not silently act as if canonical writes succeeded.

#### Exit gate

- Difference rate is below an approved threshold for resolvable records.
- Every expected difference has a reason code.
- No cross-room or cross-person leakage appears.

#### Rollback point RP-06

Disable dual read by feature flag; legacy remains authoritative.

### Phase 7 — Optional dual write

**Goal — Recommendation.** Exercise canonical writes while retaining a temporary compatibility projection.

#### Preconditions

- Dual read validation passed.
- Canonical write idempotency and retry behavior passed.
- A single authority order is approved.

#### Required behavior

1. Canonical write happens first and is authoritative.
2. Legacy projection happens second, best-effort, with a correlation ID.
3. A canonical failure fails the memory operation.
4. A legacy projection failure raises telemetry but does not roll back canonical history.
5. Legacy projection MUST NOT collapse unresolved identities into names or many-to-many causes into one fake user.
6. Dual-write duration MUST be time-bounded and have an owner and end date.

#### Exit gate

- Canonical and compatible legacy projections reconcile within expected lossy rules.
- No canonical duplicate results from retry.
- Legacy failures do not corrupt canonical order.

#### Rollback point RP-07

Disable canonical writing only if no canonical-only record has been consumed as authoritative. Otherwise stop traffic or switch canonical to read-only and restore from the pre-dual-write point; do not let old writers overwrite canonical data.

### Phase 8 — Cutover

**Goal — Recommendation.** Make canonical memory the only authoritative conversation-memory path.

#### Rolling deployment sequence

1. **Expand:** deploy schema and compatibility readers.
2. **Observe:** run legacy-only with migration telemetry.
3. **Shadow:** enable dry-run canonical writes or dual read for test cohorts.
4. **Canary write:** canonical write for one bot instance or guild cohort; legacy projection optional.
5. **Canary read:** canonical prompt context for the same cohort.
6. **Widen:** expand by guild/room cohort, not random individual events within one room.
7. **Freeze legacy authority:** prevent legacy process-local state from accepting authoritative writes.
8. **Drain:** allow active voice playback and in-flight text sends to finish or record explicit interruption states.
9. **Flip default:** all text and voice use `MemoryPort`.
10. **Retain rollback assets:** backups, source manifests, old binaries, and feature flags remain available for the approved rollback window.

#### Cutover invariants

- A logical room MUST have one write authority at a time.
- All bot instances handling the same logical room MUST agree on authority epoch.
- In-flight events started under the old epoch MUST complete under old semantics or be explicitly abandoned; they MUST NOT be replayed as new events without the same idempotency key.
- Voice and text adapters MUST submit the same canonical actor-snapshot contract.

#### Exit gate

- Canonical write/read is healthy for all cohorts.
- No legacy authority writes occur after the cutover high-water mark.
- Delivery reconciliation queue is within approved bounds.

#### Rollback point RP-08

Before canonical-only semantics are used, revert feature flags to legacy. After canonical-only writes exist, rollback means stop affected writes, preserve canonical data, restore application version that understands the canonical schema, or restore the whole system to a pre-cutover backup with explicit loss accounting. An old binary alone is not a safe rollback.

### Phase 9 — Post-cutover verification

**Goal — Recommendation.** Detect latent divergence, leakage, and missed crash windows.

#### Required actions

- Reconcile per-room event counts and high-water marks.
- Verify no event after cutover has `writer_mode=legacy_only`.
- Sample known-ID, display-only, synthetic-group, unknown-speaker, and ambiguous-room records.
- Reconcile delivery attempts with Discord message IDs or voice playback receipts where available.
- Test correction, forget, export, retention, and cache invalidation on migrated records.
- Rebuild summaries from authorized raw events and compare membership, not exact model prose.
- Confirm quarantine records are excluded from normal retrieval.
- Verify prompt serialization does not expose internal IDs or treat legacy content as instructions.

#### Exit gate

A full verification cycle passes for the approved observation period and no release-blocking incidents remain.

#### Rollback point RP-09

Canonical remains authoritative. Roll back specific read features, retrieval layers, or cohorts; do not re-enable incompatible legacy writers.

### Phase 10 — Cleanup

**Goal — Recommendation.** Remove temporary compatibility mechanisms without destroying audit evidence.

#### Required actions

- Disable and remove legacy process-local history writes.
- Remove dual-read and dual-write flags after the rollback window.
- Retain source manifests, source checksums, migration maps, resolution decisions, deletion proofs, and aggregate counts according to policy.
- Delete raw source captures when retention or privacy policy requires it.
- Drop compatibility columns only after every supported binary no longer references them.
- Regenerate summaries and secondary indexes after final deletion reconciliation.
- Document final canonical schema version and minimum application version.

#### Exit gate

- No active code path reads or writes legacy history.
- Deletion/export tooling covers migrated records.
- Old credentials and source mounts are revoked.

#### Rollback point RP-10

Cleanup of raw sources may be irreversible. Require explicit approval and a signed deletion manifest. Schema cleanup must use a separate change window and backup.

### Phase 11 — Rollback

**Goal — Recommendation.** Define rollback by phase rather than claiming one universal reversal.

#### Rollback classes

- **Class A — Pre-write:** Phases 1–3. Discard staging.
- **Class B — Isolated target:** Phases 4–5. Restore or drop simulation target.
- **Class C — Shadow reads:** Phase 6. Disable flags.
- **Class D — Canonical writes not yet authoritative:** early Phase 7. Disable writes and discard only if no consumer relied on them and policy permits.
- **Class E — Canonical authoritative:** Phase 8 onward. Do not downgrade to old writers. Pause traffic, restore an application version that understands canonical data, or perform full point-in-time restore with quantified data loss.
- **Class F — Post-cleanup:** restore from approved backups only; raw legacy sources may no longer exist.

#### Mandatory rollback record

Every rollback MUST record:

- Trigger and incident ID.
- Authority epoch and affected scopes.
- Last safe canonical event ID and source high-water marks.
- In-flight generation and delivery states.
- Data intentionally lost, replayed, or quarantined.
- Privacy/deletion requests that must be re-applied after restore.
- Approval and completion checksums.

---

## 11. Interfaces, schemas, state machines, and test vectors

### 10.1 Transitional inbound actor contract

**Recommendation.** During rolling deployment, accept the old flat fields and the new nested snapshot, but reject conflicting values.

```text
InboundActorCompatibility {
  // New form
  actor?: {
    platform: "discord"
    platformUserId: string
    username?: string
    globalDisplayName?: string
    guildNickname?: string
    effectiveDisplayName?: string
  }

  // Transitional legacy form
  userId?: string
  displayName?: string
}
```

Normalization rules:

1. If `actor.platformUserId` and `userId` both exist, they MUST be equal.
2. A valid Discord ID creates or references `discord:user:<id>`.
3. `displayName` becomes a historical display snapshot only.
4. Missing `userId` MUST NOT be synthesized from `displayName`.
5. Invalid or impossible IDs move the record to unresolved/quarantined review; they are not silently truncated or hashed into a Discord identity.
6. The compatibility fields are deprecated only after all adapters and fixtures use the actor snapshot.

### 10.2 Migration source and ledger schema

```text
migration_run(
  migration_run_id PK,
  transform_version,
  started_at,
  completed_at,
  mode,                 // dry_run | simulation | production
  source_manifest_sha256,
  normalized_manifest_sha256,
  status
)

legacy_source(
  source_id PK,
  source_type,
  source_schema_version,
  branch_or_build,
  acquisition_time,
  owner,
  raw_sha256,
  retention_class
)

migration_source_record(
  source_id,
  source_record_key,
  source_partition,
  raw_record_sha256,
  normalized_record_sha256,
  preliminary_class,
  parse_status,
  observed_order,
  observed_timestamp,
  PRIMARY KEY(source_id, source_record_key)
)

migration_record_map(
  migration_run_id,
  source_id,
  source_record_key,
  target_entity_type,
  target_entity_id,
  disposition,          // inserted | linked | skipped | quarantined | rejected | redacted
  reason_code,
  PRIMARY KEY(migration_run_id, source_id, source_record_key, target_entity_type, target_entity_id)
)
```

### 10.3 Actor and resolution schema

```text
platform_actor(
  platform_actor_id PK, // discord:user:<id>
  platform,
  platform_user_id,
  first_observed_at,
  last_observed_at,
  UNIQUE(platform, platform_user_id)
)

actor_snapshot(
  actor_snapshot_id PK,
  platform_actor_id NULL FK,
  event_id FK,
  username NULL,
  global_display_name NULL,
  guild_nickname NULL,
  effective_display_name NULL,
  historical_display_snapshot NULL,
  captured_at,
  source_id,
  untrusted_payload_hash
)

legacy_unresolved_actor(
  legacy_actor_id PK,
  source_id,
  source_partition,
  source_native_speaker_key NULL,
  historical_display_snapshot NULL,
  resolution_status,
  created_by_migration_run_id
)

identity_resolution(
  identity_resolution_id PK,
  legacy_actor_id FK,
  target_platform_actor_id NULL FK,
  status,
  evidence_type,
  evidence_reference,
  confidence_label,
  decided_by,
  reviewed_by NULL,
  decided_at,
  supersedes_resolution_id NULL
)
```

### 10.4 Room schema

```text
physical_room(
  physical_room_id PK,  // discord:guild:<g>:text:<c>, thread:<t>, voice:<v>, dm:<u>
  platform,
  guild_id NULL,
  channel_id NULL,
  medium,
  source_confidence
)

logical_room(
  logical_room_id PK,
  character_id,
  isolation_class,
  created_at
)

room_binding(
  room_binding_id PK,
  physical_room_id FK,
  logical_room_id FK,
  valid_from,
  valid_to NULL,
  policy_id,
  authorized_by
)

legacy_room_resolution(
  legacy_room_resolution_id PK,
  source_room_key,
  resolved_physical_room_id NULL,
  legacy_quarantine_room_id NULL,
  status,
  evidence_type,
  evidence_reference,
  decided_by,
  decided_at
)
```

### 10.5 Event, causality, and delivery schema

```text
conversation_event(
  event_id PK,
  logical_room_id FK,
  physical_room_id NULL FK,
  author_platform_actor_id NULL FK,
  author_legacy_actor_id NULL FK,
  role,                 // user | assistant | system | aggregate
  medium,               // text | voice | mixed | legacy_unknown
  occurred_at NULL,
  observed_order,
  source_id,
  source_record_key,
  payload_id FK,
  lifecycle_class,
  schema_version,
  writer_version
)

assistant_generation(
  generation_id PK,
  assistant_event_id FK UNIQUE,
  status,               // started | completed | failed | cancelled | partial
  prompt_snapshot_version NULL,
  started_at NULL,
  completed_at NULL
)

response_cause(
  generation_id FK,
  cause_event_id FK,
  causal_role,          // trigger | context | interruption | correction
  ordinal,
  PRIMARY KEY(generation_id, cause_event_id, causal_role)
)

delivery_attempt(
  delivery_attempt_id PK,
  assistant_event_id FK,
  transport,
  status,               // not_attempted | attempted | delivered | played | partial | failed | interrupted | unknown_legacy
  external_message_id NULL,
  playback_epoch NULL,
  attempted_at NULL,
  completed_at NULL,
  failure_code NULL,
  supersedes_attempt_id NULL
)
```

**Recommendation.** Raw event payload is append-oriented. Mutable lifecycle is represented by append-only state transitions or separate delivery/generation rows. Privacy erasure may redact or cryptographically destroy protected payloads while retaining non-identifying audit structure, according to the approved deletion model.

### 10.6 Identity resolution state machine

```text
                 deterministic source evidence
  unresolved ------------------------------------> resolved_automatic
      |                                                   |
      | candidate evidence                                | contradiction/correction
      v                                                   v
   candidate ---- authorized adjudication ----> resolved_manual
      |                                                   |
      | ambiguity / unsafe exposure                       | invalidation
      v                                                   v
  quarantined <-------------------------------------- invalidated
```

Rules:

- `resolved_automatic` MUST cite a deterministic rule and evidence record.
- `resolved_manual` MUST retain the unresolved source principal and decision history.
- `invalidated` MUST NOT delete prior decisions; it supersedes them.
- A display-name-only record begins `unresolved`, never `candidate` solely because a same-named user exists.

### 10.7 Transformation matrix

| Legacy data | Safe canonical treatment | Prohibited treatment |
|---|---|---|
| Text turn with valid `userId` and display label | Event authored by `discord:user:<id>` plus immutable display snapshot | Make display label the actor key |
| Voice single-speaker source event with valid `userId` and actual `channelId` | Actor-linked voice event in physical voice room | Replace channel with guild ID |
| Remembered turn with display name only | Isolated unresolved actor; preserve label snapshot | Merge to current same-named member |
| Empty/missing speaker | Per-event unresolved actor or quarantined event | Attribute to bot owner or room creator |
| Synthetic `Discord group` with child events | Aggregate event plus child events and many-to-many causes | Create a `Discord group` person |
| Synthetic `Discord group` without child events | Quarantined aggregate; no person facts | Attribute all content to latest `userId` |
| Legacy voice room `guild:g:voice:g` with no channel evidence | `legacy:guild:g:voice:unknown`, quarantined from ordinary retrieval | Bind to current/most-used voice channel |
| Text assistant turn from in-memory history | Assistant event with `unknown_legacy` delivery | Mark delivered without send evidence |
| Voice committed exchange captured from live process | Assistant event with `played_legacy` evidence class, unless capture semantics are uncertain | Claim exact audio was heard by every participant |
| Malformed payload but recoverable raw bytes | Quarantine with parse error and checksum | Repair text or identity by model guess |
| Record blocked by retention/deletion | Skip or redact; map with disposition and proof | Import then rely on later cleanup |
| Already-lost process-local record | Count as unavailable in signed inventory | Invent placeholder content |

### 10.8 Counts and checksums

**Recommendation.** Every run MUST publish a reconciliation report with:

#### Source counts

- Total source records.
- Records by source, partition, role, medium, and preliminary class.
- Records with valid Discord ID.
- Records with display name only.
- Synthetic-group records.
- Unknown/empty speaker records.
- Valid, malformed, missing, and duplicate room IDs.
- Records skipped by retention/deletion.
- Parse failures.

#### Target counts

- Events by role and lifecycle class.
- Platform actors and unresolved actors.
- Identity resolutions by status.
- Physical, logical, legacy quarantine rooms, and bindings.
- Generations, response causes, and delivery attempts by status.
- Quarantined and rejected records.

#### Checksum rules

1. `raw_record_sha256` is computed over exact source bytes or a documented canonical source extraction when exact bytes are unavailable.
2. `normalized_record_sha256` is computed over a versioned, deterministic serialization of parsed fields. It does not replace the raw checksum.
3. `source_manifest_sha256` is computed over source records sorted by `(source_id, source_record_key)`.
4. `normalized_manifest_sha256` is computed over normalized records sorted the same way.
5. Per-room event-chain checksum:

```text
H0 = SHA256("DCBOT-MIGRATION-EVENT-CHAIN-v1")
Hn = SHA256(Hn-1 || event_id || payload_hash || author_ref || room_ref || observed_order)
```

6. No expected 1:1 total is assumed. Reconciliation uses `migration_record_map` to prove every source record was inserted, linked, skipped, quarantined, rejected, or redacted.
7. Rerunning the same run with the same transform version MUST yield the same normalized manifest checksum and no duplicate target records.

### 10.9 Referential-integrity checks

- Every event has exactly one payload reference unless policy-redacted.
- A user event has at most one of `author_platform_actor_id` or `author_legacy_actor_id`, never both active simultaneously.
- Every resolved legacy actor has an active resolution chain ending in one current status.
- Every physical-room event belongs to the same platform/guild indicated by its source evidence.
- Every `response_cause.cause_event_id` precedes or is explicitly marked concurrent with its generation.
- Every delivery attempt references an assistant event.
- Every migrated target row is reachable from a migration map or is a post-cutover native row.
- Every deletion tombstone identifies all derived target classes subject to erasure.

### 10.10 Identity invariants

- **REQ-ID-001:** Display-name equality MUST NOT merge identities.
- **REQ-ID-002:** A valid source Discord user ID maps to only one Discord platform actor.
- **REQ-ID-003:** One Discord platform actor MAY have many historical display snapshots.
- **REQ-ID-004:** One historical display snapshot MAY be shared by multiple actors without merging them.
- **REQ-ID-005:** `Discord group` MUST NOT be a platform actor or unresolved person actor.
- **REQ-ID-006:** Cross-platform person linkage MUST remain absent unless a separate approved verification artifact defines it.
- **REQ-ID-007:** Manual resolutions MUST be reversible and auditable.
- **REQ-ID-008:** Voice characteristics MUST NOT serve as identity evidence in this migration.

### 10.11 Scope invariants

- **REQ-SCOPE-001:** Different physical channels do not share recent room history without an explicit logical-room binding.
- **REQ-SCOPE-002:** A guild-collapsed voice room does not bind automatically to any physical channel.
- **REQ-SCOPE-003:** DM history is isolated by the private-conversation policy and must not enter guild retrieval.
- **REQ-SCOPE-004:** Private aliases and private-conversation memories do not appear in public guild prompts.
- **REQ-SCOPE-005:** Quarantined aggregate/group records are excluded from normal person and room retrieval.
- **REQ-SCOPE-006:** Person-level cross-medium retrieval does not copy a full text transcript into a voice room.

### 10.12 Event-order invariants

- **REQ-EVENT-001:** Source-observed order is preserved within each source partition.
- **REQ-EVENT-002:** Equal or missing timestamps use stable observed order; migration must not fabricate precision.
- **REQ-EVENT-003:** Retried imports do not create new events.
- **REQ-EVENT-004:** Multi-speaker child events preserve their individual order and authors.
- **REQ-EVENT-005:** A grouped assistant generation may have multiple causes.
- **REQ-EVENT-006:** A room snapshot version records what generation saw but ordinary later appends do not invalidate an already generated event merely because the room advanced.

### 10.13 Delivery-state invariants

- **REQ-DELIVERY-001:** Generation success does not imply delivery success.
- **REQ-DELIVERY-002:** Legacy text assistant turns default to `unknown_legacy` absent external send evidence.
- **REQ-DELIVERY-003:** Legacy voice committed exchanges may record a legacy playback-completed evidence class, but must not claim every participant heard the audio.
- **REQ-DELIVERY-004:** Failed, interrupted, cancelled, partial, and unknown outputs are not serialized as ordinary completed turns.
- **REQ-DELIVERY-005:** A delivery retry creates a new attempt linked to the same assistant event; it does not regenerate the assistant text by default.
- **REQ-DELIVERY-006:** Database and Discord operations are reconciled, not claimed to be atomic.

### 10.14 Explicit data that cannot be safely migrated

**Recommendation.** The following data cannot be promoted into normal attributed memory:

1. **Already-lost process-local history.** Treatment: signed unavailable count; no invented records.
2. **Display-name-only history as a known Discord person.** Treatment: unresolved actor, isolated by source partition.
3. **Collapsed group history with no child speaker events.** Treatment: quarantined aggregate, no person facts.
4. **Grouped history whose wrapper contains one user ID but content includes several speakers.** Treatment: ignore wrapper ID for content attribution; preserve only as source metadata.
5. **Unknown or ambiguous speaker content.** Treatment: per-event unresolved actor or quarantine according to exposure risk.
6. **Guild-collapsed voice-room history with no contemporaneous channel evidence.** Treatment: restricted legacy unknown-voice room.
7. **Text assistant turns with no send receipt.** Treatment: `unknown_legacy` delivery.
8. **Truncated or corrupted records whose missing fields affect author, room, ordering, or privacy.** Treatment: quarantine or reject; preserve checksum and error.
9. **Records outside retention or subject to deletion.** Treatment: do not import; record non-content proof.
10. **Assistant-generated assertions presented as user facts.** Treatment: preserve as assistant event only; do not extract as durable person fact during migration.
11. **Aliases whose scope is not known.** Treatment: preserve as untrusted historical display text, not as a preferred alias.
12. **Cross-platform identity claims lacking independent verification.** Treatment: remain separate platform actors.

### 10.15 Example migration test vectors

#### TEST-VECTOR-A — Same display name, different IDs

```text
source 1: userId=111, displayName="Alex", text="I prefer tea"
source 2: userId=222, displayName="Alex", text="I prefer coffee"
```

Expected:

- Two platform actors.
- Two snapshots both showing Alex.
- No merged facts.

#### TEST-VECTOR-B — Display-only historical record

```text
speaker="Mayuri", text="Call me Mayushii"
```

Expected:

- One unresolved legacy actor scoped to the source partition.
- Historical display snapshot `Mayuri`.
- No link to any current Discord user named Mayuri.

#### TEST-VECTOR-C — Collapsed group record

```text
wrapper.userId=u2
wrapper.displayName="Discord group"
prompt="[speaker=Patrick] ... [speaker=Alice] ..."
child events unavailable
```

Expected:

- Quarantined aggregate event.
- No person-level memory extraction.
- Wrapper `u2` retained only as source metadata, not authorship.

#### TEST-VECTOR-D — Incorrect voice room

```text
legacyRoom="guild:g1:voice:g1"
actualChannelId unavailable
```

Expected:

- `legacy:guild:g1:voice:unknown` quarantine room.
- No binding to `guild:g1:voice:c1`.

#### TEST-VECTOR-E — Text assistant send failure window

```text
history contains assistant="hello"
Discord message ID absent
```

Expected:

- Assistant event exists.
- Delivery attempt status `unknown_legacy`.
- Retrieval policy can exclude or label it as not confirmed delivered.

---

## 12. Failure modes

| ID | Failure mode | Impact | Detection | Required response |
|---|---|---|---|---|
| RISK-015-001 | Live in-memory histories disappear before inventory | Irrecoverable context loss | Instance restart / empty export | Record unavailable; do not invent; adjust cutover sequence |
| RISK-015-002 | Display-name merge | Cross-person leakage and false facts | Identity invariant test | Stop migration; invalidate links; assess privacy incident |
| RISK-015-003 | Group wrapper ID used as author | Multi-speaker misattribution | Group test vectors and source audit | Quarantine affected records; invalidate derived memories |
| RISK-015-004 | Guild-collapsed room mapped to physical channel | Cross-room leakage | Scope invariant test | Remove binding; quarantine; regenerate summaries/indexes |
| RISK-015-005 | Text assistant turn marked delivered | False conversational continuity | Missing external message ID / send receipt | Change to `unknown_legacy`; exclude from completed-turn assumptions |
| RISK-015-006 | Dual-write retry duplicates events | Repeated context and facts | Idempotency and count reconciliation | Stop cohort; deduplicate through source map; fix key logic |
| RISK-015-007 | Old writer runs after cutover | Split brain | Writer-version and authority-epoch telemetry | Fence old instance; pause room; reconcile high-water mark |
| RISK-015-008 | Canonical failure silently falls back to ephemeral memory | False persistence guarantee | Write-result telemetry and fault injection | Fail visibly; disable affected memory feature; repair store |
| RISK-015-009 | Raw legacy prompt performs delimiter/role injection | Prompt compromise | serialization security tests | Treat as data; escape/structure; quarantine suspicious records |
| RISK-015-010 | Manual resolver links wrong person | Privacy and truth corruption | reviewer audit, correction reports | Invalidate resolution; delete/rebuild derived memory; notify incident owner |
| RISK-015-011 | Deletion misses summaries or indexes | Privacy non-compliance | deletion completeness test | Block release; purge derivatives; rebuild from authorized events |
| RISK-015-012 | Rollback restores deleted data | Privacy regression | tombstone replay check | Reapply deletion ledger before service resumes |
| RISK-015-013 | Whole-history compatibility projection loses concurrent writes | Missing turns | version/checksum mismatch | Keep projection non-authoritative; serialize updates or disable it |
| RISK-015-014 | Gateway member updates assumed without intent/ops approval | Stale current aliases | intent/config audit | Use event snapshots; make richer current identity refresh a separate approved feature |

---

## 13. Security and privacy implications

### 12.1 Identity and attribution

- **REQ-PRIV-001 — Source-plan requirement:** Never merge identities by display name.
- **REQ-PRIV-002 — Recommendation:** Unresolved and quarantined actors must not be exposed as known users.
- **REQ-PRIV-003 — Recommendation:** Internal actor, resolution, and migration IDs must not be printed or spoken.
- **REQ-PRIV-004 — Recommendation:** Manual identity resolution requires least privilege and complete audit history.

### 12.2 Scope and alias privacy

- **REQ-PRIV-005 — Source-plan requirement:** Private aliases and private memory must not leak into public guild contexts.
- **REQ-PRIV-006 — Recommendation:** Historical display snapshots are shown only when policy permits and are never silently promoted to current preferred aliases.
- **REQ-PRIV-007 — Recommendation:** Unknown-room voice history remains excluded from normal retrieval.

### 12.3 Untrusted legacy content

- **REQ-PRIV-008 — Source-plan requirement:** Retrieved memory is data, not instructions.
- **REQ-PRIV-009 — Recommendation:** Migration preserves raw text separately from safe prompt serialization. Delimiters, role labels, mentions, bidirectional Unicode controls, and fake internal IDs must be escaped or structurally encoded at retrieval time.
- **REQ-PRIV-010 — Recommendation:** Diagnostic comparison logs contain hashes and metadata by default, not raw private conversations.

### 12.4 Deletion, retention, and backups

- **REQ-PRIV-011 — Recommendation:** A deletion request blocks import if received before migration.
- **REQ-PRIV-012 — Recommendation:** After import, deletion must cover raw payloads, snapshots, summaries, semantic derivatives, embeddings, caches, exports, and backup handling according to the approved policy.
- **REQ-PRIV-013 — Recommendation:** Migration auditability should preserve non-content evidence such as checksums, disposition, and deletion proof when legally and operationally permitted.
- **REQ-PRIV-014 — Recommendation:** Restores must replay deletion tombstones before user traffic resumes.

### 12.5 Operational intents

**Confirmed repository fact.** The current adapter requests message, message-content, DM, voice-state, and guild intents but not `GuildMembers`. Source: SRC-DC-009.

**Recommendation.** Do not make migration correctness depend on comprehensive member-update history. A future current-identity refresh feature may require intent and operational review, but event-time snapshots and explicit user IDs are sufficient for migration fidelity.

---

## 14. Testable acceptance criteria

### Inventory and determinism

- **TEST-015-001:** Two dry runs over the same sources and transform version produce identical normalized manifest checksums.
- **TEST-015-002:** Source class counts sum exactly to source total.
- **TEST-015-003:** Every source record has one or more mapping dispositions, including explicit skip/reject/quarantine.
- **TEST-015-004:** Import retry after arbitrary batch failure produces no duplicate canonical events.

### Identity

- **TEST-015-005:** Two records with equal display names and different Discord IDs remain separate actors.
- **TEST-015-006:** A display-only record never resolves automatically to a Discord actor.
- **TEST-015-007:** A valid original Discord user ID resolves deterministically and retains the historical display snapshot.
- **TEST-015-008:** Invalidating a manual resolution removes it from active retrieval without deleting the audit chain.
- **TEST-015-009:** `Discord group` never appears in actor or alias tables.

### Scope

- **TEST-015-010:** Two guild text channels remain isolated unless a binding exists.
- **TEST-015-011:** A legacy `voice:<guildId>` room is not returned in any physical voice-channel query.
- **TEST-015-012:** DM records are not returned to guild-room retrieval.
- **TEST-015-013:** Private alias data is absent from public prompt snapshots.

### Event order and causality

- **TEST-015-014:** Events preserve source-observed order when timestamps are equal or absent.
- **TEST-015-015:** One grouped response can reference two or more user causes.
- **TEST-015-016:** Importing a grouped wrapper does not assign all child text to the wrapper user ID.
- **TEST-015-017:** A concurrent append after generation starts does not automatically reject the completed generation; the prompt snapshot records what was seen.

### Delivery

- **TEST-015-018:** Migrated text assistant turns without send receipts are `unknown_legacy`.
- **TEST-015-019:** Failed and interrupted assistant outputs are excluded from ordinary completed-turn context.
- **TEST-015-020:** Delivery retry creates another attempt for the same assistant event, not a duplicate event.
- **TEST-015-021:** Fault injection between canonical commit and Discord send leaves a reconcilable state.

### Privacy and deletion

- **TEST-015-022:** A pre-import deletion request prevents target payload insertion.
- **TEST-015-023:** Post-import deletion removes or redacts all configured derivatives and invalidates summaries/indexes.
- **TEST-015-024:** Backup restore followed by tombstone replay does not resurrect deleted content into retrieval.
- **TEST-015-025:** Quarantined content cannot enter ordinary prompt context, semantic extraction, or person facts.
- **TEST-015-026:** Prompt serialization neutralizes fake role markers, delimiters, mentions, Unicode controls, and internal-ID-like strings.

### Rolling deployment and rollback

- **TEST-015-027:** Old binary operates while additive schema is present and canonical writing is disabled.
- **TEST-015-028:** Authority epoch prevents old and new writers from authoritatively writing the same logical room.
- **TEST-015-029:** Disabling dual read returns the cohort to its prior authority without data mutation.
- **TEST-015-030:** After canonical-only records exist, an attempted old-writer downgrade is fenced and reported.
- **TEST-015-031:** Point-in-time restore reports the exact lost event range and reapplies deletion tombstones before reads.

### Existing test migration

- **TEST-015-032:** Existing text same-room serialization and cross-room overlap tests pass through `MemoryPort`.
- **TEST-015-033:** Existing room isolation and history-bound tests are retained with canonical room/event assertions.
- **TEST-015-034:** Existing multi-speaker test asserts individual actor events and many-to-many causality, not just names inside prompt text.
- **TEST-015-035:** Existing voice playback tests assert delivery state and commit ordering without relying on a guild-collapsed room.

---

## 15. Non-goals

- No production implementation in this artifact.
- No model-selected identity matching.
- No voice biometric identification.
- No cross-platform human identity merge.
- No automatic alias promotion from historical display labels.
- No semantic-memory extraction during bulk migration.
- No embedding or graph backfill on the voice-critical path.
- No guarantee that deleted or already-lost process-local data can be recovered.
- No perpetual legacy compatibility.
- No exact atomicity claim between database and Discord delivery.
- No final datastore or service-topology selection without operational evidence.

---

## 16. Dependencies on other artifacts

**Recommendation.** Coding must depend on approved versions of:

1. **Canonical memory domain model** — event, actor, room, snapshot, generation, causality, delivery, correction, deletion.
2. **MemoryPort contract** — append, read, resolve scope, record delivery, correct, forget, export, and health semantics.
3. **Identity and alias specification** — platform identity, current versus historical presentation, scope precedence, manual resolution governance.
4. **Room and authorization specification** — physical rooms, logical rooms, bindings, DM/guild isolation, unbound-channel behavior.
5. **Delivery state machine** — generation, persistence, send/playback, retries, reconciliation, partial/interrupted handling.
6. **Privacy and deletion specification** — retention, erasure/redaction, backup handling, summary/index invalidation, export.
7. **Prompt serialization security specification** — untrusted memory encoding and internal-ID suppression.
8. **Evaluation plan** — identity continuity, attribution, temporal correction, abstention, leakage, deletion, concurrency, delivery recovery, multilingual retrieval, cost, latency.
9. **Operational topology ADR** — in-process SQLite/PostgreSQL or later standalone runtime, with evidence.
10. **Migration tooling runbook** — source adapters, manifests, dry-run reports, approvals, incident and rollback commands.

---

## 17. Open questions

### 17.1 Blocking

- **OPEN-015-B01:** Are any production or staging DC_BOT instances currently running with recoverable in-memory histories? If yes, what safe snapshot mechanism and drain window are approved?
- **OPEN-015-B02:** Do deployments contain custom persisted records, logs, snapshots, forks, or backups not represented in the repository?
- **OPEN-015-B03:** What canonical store is approved for milestone one, and what concurrency, backup, and restore guarantees are required?
- **OPEN-015-B04:** What exact canonical memory schema and `MemoryPort` version has been approved?
- **OPEN-015-B05:** What retention and deletion rules apply to raw source captures and migration audit records?
- **OPEN-015-B06:** Who is authorized to perform and review manual identity or room resolutions?
- **OPEN-015-B07:** Is any legacy text send receipt available through Discord message IDs, logs, or telemetry, or must all text assistant turns remain `unknown_legacy`?
- **OPEN-015-B08:** How are active in-flight text generations and voice playback handled at the cutover drain boundary?
- **OPEN-015-B09:** What is the authority-epoch fencing mechanism for multiple bot instances serving the same logical room?
- **OPEN-015-B10:** What rollback data-loss objective and rollback observation window are approved?

### 17.2 Non-blocking

- **OPEN-015-N01:** Should quarantined aggregate history be visible in an operator-only audit UI?
- **OPEN-015-N02:** Should manually resolved history become eligible for person-level memory immediately or only after a separate review job?
- **OPEN-015-N03:** What confidence labels are useful beyond the normative status enum?
- **OPEN-015-N04:** Should legacy voice committed turns use `played_legacy` or the more conservative `delivery_completed_legacy` naming?
- **OPEN-015-N05:** How long should lossy read-only old-schema projections be retained?
- **OPEN-015-N06:** Which multilingual tokenization/search strategy will be evaluated later for CJK and mixed-language retrieval?
- **OPEN-015-N07:** Under what verified conditions would an upstream Airi memory runtime replace the in-process adapter?

---

## 18. Handoff instructions for downstream agents

### Schema agent

- Turn Section 10 into a versioned logical schema and migration DDL proposal.
- Preserve nullable/additive rollout and append-oriented state transitions.
- Do not collapse actor snapshot into actor identity or delivery into event completion.

### Identity agent

- Produce the identity/alias ADR and operator resolution workflow.
- Include reviewer roles, evidence types, invalidation, and scope-safe retrieval.
- Use TEST-015-005 through TEST-015-009 as mandatory vectors.

### Room/scope agent

- Define physical/logical room IDs and authorization checks.
- Specify treatment of `legacy:guild:<g>:voice:unknown` and later audited bindings.
- Prove DM/private alias isolation.

### Delivery agent

- Define generation, persistence, send/playback, retry, and reconciliation states.
- Preserve the verified difference between legacy text and voice commit ordering.
- Define what qualifies as evidence for delivered/played.

### Test agent

- Port the existing test guarantees listed in Section 5.7.
- Add all Section 13 acceptance tests.
- Build deterministic fixtures for known IDs, same-name users, display-only speakers, grouped input, unknown rooms, partial delivery, deletion, retries, and rollback.

### Operations agent

- Inventory live instances and deployment-local data.
- Define authority fencing, canary cohorts, backups, tombstone replay, and rollback approvals.
- Produce count/checksum dashboards before cutover.

### Privacy/security agent

- Approve source capture retention, quarantine access, diagnostic logging, erasure/redaction, backup handling, and prompt serialization.
- Treat any cross-person or cross-room leakage as release blocking.

---

## 19. What must be true before coding starts

1. **ADR approval:** ADR-015-001 through ADR-015-012 are approved or explicitly replaced.
2. **Schema approval:** The canonical event, identity, room, causality, delivery, migration-ledger, and deletion schemas are versioned.
3. **Contract approval:** `MemoryPort` defines success, failure, idempotency, consistency, and no-silent-fallback behavior.
4. **Inventory access:** Operators identify every live instance and known deployment-local source.
5. **Privacy approval:** Source capture, quarantine, manual resolution, retention, deletion, backups, and audit access have owners and policies.
6. **Cutover design:** Authority epoch, cohorting, drain behavior, and rollback classes are operationally implementable.
7. **Delivery design:** Text and voice delivery evidence and reconciliation states are approved.
8. **Test fixtures:** Same-name, unresolved, grouped, unknown-room, ordering, failure, deletion, and rollback fixtures exist before implementation merges.
9. **Metrics:** Required counts, checksums, divergence metrics, and alert thresholds are defined.
10. **Downgrade acknowledgement:** Stakeholders accept that canonical-only writes cannot be faithfully downgraded to the old history model.
11. **No identity invention:** Every implementation reviewer agrees that display-name equality, voice similarity, and LLM guesses are prohibited resolution evidence.
12. **No premature infrastructure:** A standalone service is not introduced unless a separate topology ADR supplies verified need.

---

## Concise handoff summary

The next required artifacts are: the canonical memory schema, `MemoryPort` contract, identity/alias and manual-resolution specification, room-binding and authorization specification, delivery/reconciliation state machine, privacy/deletion specification, migration tooling runbook, and acceptance-test fixture pack. The blocking decisions are datastore/topology, live-state snapshot availability, deletion/retention policy, manual-resolution governance, authority fencing, delivery evidence, and rollback objectives. Coding must not begin until those decisions preserve the non-negotiable rule that historical identities are never merged by display-name equality alone.
