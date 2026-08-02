# 09-memory-port-api-spec.md

**Artifact filename:** `09-memory-port-api-spec.md`
**Role:** Domain-contract and API architect
**Primary repository inspected:** `starryark/DC_BOT` (branch `main`, latest commit `0ea3cbf`, "added reference audio profile", 2026-08-01, 10 commits, 2 branches) 【turn2fetch0】
**Comparison repositories inspected:** `moeru-ai/airi` (branch `main`) 【turn28fetch0】, `AstrBotDevs/AstrBot` (branch `master`) 【turn0fetch0†L150-L191】

---

## 2. Executive conclusion

The MemoryPort is specified as a **transport-neutral domain port** with one in-process application service implementation backed by SQLite (default) or PostgreSQL, plus a deterministic test fake and an optional HTTP-bridged remote transport that reuses identical domain DTOs. The first milestone must ship the in-process implementation only; a standalone HTTP microservice is **not justified** by the current DC_BOT topology (a single Node process running `airi/services/discord-bot` with three local helper processes: Qwen3-ASR, GPT-SoVITS, and the external Gemini API) 【turn5fetch0】. This directly addresses RISK-A and source-plan requirement #2.

The contract defines **13 operations** (resolve room, observe actor, append event, create draft, record delivery, assemble context, search, remember/correct/forget, resolve address, bind/unbind rooms, export, govern deletion, health/schema/capabilities), each with a fixed field set: domain input, domain output, transport DTO, validation, authorization, idempotency, transaction boundary, timeout, retryability, error taxonomy, version compatibility, audit fields, privacy-sensitive fields, and degraded behavior. Capability negotiation is mandatory on every session so callers never assume vector/graph/summary features the backend lacks.

A production **`NullMemoryClient` that silently accepts writes without persistence is forbidden** (source-plan requirement #22; RISK-#22 in this artifact). The only permitted stateless behavior under memory failure is a read-side degraded mode that (a) returns an explicit "no durable context" sentinel to the generator, (b) logs at `ERROR` with a correlation id, (c) durably spools every write attempt to a local append-only spool that is reconciled on recovery, and (d) must **never** emit text to the user claiming anything was remembered. This artifact is the complete deliverable; no asynchronous future work is claimed.

---

## 3. Scope

**In scope.** The MemoryPort domain interface; the in-process application service; SQLite and PostgreSQL repository contracts; the deterministic test fake; the HTTP transport DTO mapping and capability negotiation protocol; the 13 operations and their full field contracts; the degraded-mode and spool/reconciliation behavior; the forbidden-`NullMemoryClient` rule; the erasure/redaction/tombstone governance model; security and privacy implications; testable acceptance criteria.

**Out of scope (non-goals, §15).** Implementing production code; choosing a specific vector index library or embedding model without benchmark evidence (RISK-J); CJK tokenizer selection beyond identifying the requirement (RISK-M); Discord gateway intent procurement; the emotion-aware speech pipeline itself (that is `Plan.md`'s scope) 【turn4fetch0】; cross-platform human identity verification beyond `discord:user:<id>` (RISK-F).

---

## 4. Sources inspected

| Source | URL | What was inspected | Branch / commit |
|---|---|---|---|
| DC_BOT repository root | https://github.com/starryark/DC_BOT | File tree, README, commit list | `main`, `0ea3cbf` (2026-08-01) 【turn2fetch0】 |
| DC_BOT `README.md` | https://github.com/starryark/DC_BOT/blob/main/README.md | Pipeline, intents, commands | `main` 【turn2fetch0†L159-L179】 |
| DC_BOT `RUNBOOK.md` | https://raw.githubusercontent.com/starryark/DC_BOT/main/RUNBOOK.md | 3-process topology, start order | `main` 【turn5fetch0】 |
| DC_BOT `Plan.md` | https://raw.githubusercontent.com/starryark/DC_BOT/main/Plan.md | Emotion-aware speech plan (not memory) | `main` 【turn4fetch0】 |
| DC_BOT `start-bot.ps1` | https://raw.githubusercontent.com/starryark/DC_BOT/main/start-bot.ps1 | Readiness probes, env requirements | `main` 【turn36fetch1】 |
| AIRI `services/discord-bot` | https://github.com/moeru-ai/airi/tree/main/services/discord-bot/src | `src` tree: adapters, bots/discord/commands, constants, pipelines/tts.ts, utils, index.ts — no memory module | `main` 【turn14fetch0】 |
| AIRI `packages` index | https://github.com/moeru-ai/airi/tree/main/packages | Workspace list incl. `memory-pgvector`, `core-agent`, `server-sdk`, `server-runtime`, `drizzle-duckdb-wasm` | `main` 【turn28fetch0】 |
| AIRI `packages/memory-pgvector/src/index.ts` | https://raw.githubusercontent.com/moeru-ai/airi/main/packages/memory-pgvector/src/index.ts | Skeleton: empty `module:configure` handler, no store/schema | `main` 【turn35fetch0】 |
| AIRI `packages/memory-pgvector/package.json` | https://raw.githubusercontent.com/moeru-ai/airi/main/packages/memory-pgvector/package.json | `@proj-airi/memory-pgvector` v0.11.3, private, deps drizzle-orm + postgres | `main` 【turn35fetch1】 |
| AIRI `packages/server-sdk/README.md` | https://raw.githubusercontent.com/moeru-ai/airi/main/packages/server-sdk/README.md | Module protocol: connect/announce/onEvent/send/sendOrThrow | `main` 【turn0fetch0†turn40find1】 |
| AIRI Alaya proposal | https://github.com/moeru-ai/airi/issues/879 | `MemoryDriver` proposal (search/save/update/forget), time-decay, emotional weighting — open proposal, not implemented | `main` 【turn36fetch0†L158-L213】 |
| AIRI memory docs | https://moeru-ai-airi.mintlify.app/configuration/memory | DuckDB/IndexedDB layers, sessions — documentation claim | n/a 【turn6search3】 |
| AIRI memory-system issue | https://github.com/moeru-ai/airi/issues/387 | Proposal: standalone `@proj-airi/memory-core`, DuckDB+PostgreSQL — proposal | `main` 【turn6search0】 |
| AstrBot conversation dev-doc | https://github.com/AstrBotDevs/AstrBot/wiki/en-dev-star-guides-ai | `Conversation` dataclass with `history: str`; `conversation_mgr` — documentation claim; directory not present on `master` 【turn0fetch0†L205-L206】 | n/a 【turn22search3】 |
| AstrBot context-compression wiki | https://github.com/AstrBotDevs/AstrBot/wiki/en-use-context-compress | Truncate or LLM-summarize at 82% of context window | n/a 【turn20search6】 |
| AstrBot PR #4886 | https://github.com/AstrBotDevs/AstrBot/pull/4886 | Conversation-history DB schema, user_name/avatar fields | `master` 【turn37search1】 |

**Repository access limitations.** The AstrBot `astrbot/core/conversation_mgr` path returned 404 on both `main` and `master` 【turn0fetch0†L205-L206】, so the `Conversation` dataclass fields are cited as a documentation claim, not a confirmed source file. GitHub code search for `ConversationController` in the airi repo did not surface a file path; `Plan.md` references `ConversationController.generateAndSpeak()` as an internal symbol 【turn4fetch0†L31-L32】 but the inspected `services/discord-bot/src` tree does not contain a file by that name, indicating it may live in a package not yet opened or be renamed in the checked-in AIRI subtree. These are recorded as open questions (§17), not asserted as facts.

---

## 5. Evidence table

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| E-01 | DC_BOT is a Discord voice bot: `Discord voice → Qwen3-ASR → Gemini → GPT-SoVITS → Discord voice`. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/README.md 【turn2fetch0†L159-L168】 | High |
| E-02 | DC_BOT topology is 3 processes + 1 external API, all local; bot process is `airi/services/discord-bot`. | Confirmed repository fact | https://raw.githubusercontent.com/starryark/DC_BOT/main/RUNBOOK.md 【turn5fetch0†L5-L11】 | High |
| E-03 | DC_BOT requests only Guilds and Guild Voice States gateway intents; it does **not** require the Message Content intent. | Confirmed repository fact | https://github.com/starryark/DC_BOT/blob/main/README.md 【turn2fetch0†L177-L179】 | High |
| E-04 | DC_BOT has no memory layer; `Plan.md` addresses emotion-aware speech, not memory. | Confirmed repository fact (absence) | https://raw.githubusercontent.com/starryark/DC_BOT/main/Plan.md 【turn4fetch0†L1-L16】 | High |
| E-05 | AIRI `services/discord-bot/src` contains no memory module (adapters, commands, constants, pipelines/tts.ts, utils, index.ts only). | Confirmed repository fact (absence) | https://github.com/moeru-ai/airi/tree/main/services/discord-bot/src 【turn14fetch0†L250-L256】 | High |
| E-06 | AIRI `packages/memory-pgvector/src/index.ts` is a skeleton: it creates a server-sdk `Client` named `memory-pgvector` with an empty `module:configure` handler and no store, schema, or memory operations. | Confirmed repository fact | https://raw.githubusercontent.com/moeru-ai/airi/main/packages/memory-pgvector/src/index.ts 【turn35fetch0】 | High |
| E-07 | `memory-pgvector` is `private: true`, v0.11.3, depends on `drizzle-orm` and `postgres`. | Confirmed repository fact | https://raw.githubusercontent.com/moeru-ai/airi/main/packages/memory-pgvector/package.json 【turn35fetch1】 | High |
| E-08 | AIRI server-sdk exposes a module protocol: `connect()`, `onEvent(type, cb)`, `send()` (returns false instead of silently dropping), `sendOrThrow()`, `isReady`, `connectionStatus`. | Confirmed repository fact | https://raw.githubusercontent.com/moeru-ai/airi/main/packages/server-sdk/README.md 【turn0fetch0†turn40find1】 | High |
| E-09 | AIRI Alaya (#879) proposes a `MemoryDriver` interface (`search/save/update/forget`) with time-decay and emotional weighting; it is an open proposal, not a merged implementation. | Confirmed repository fact (issue) | https://github.com/moeru-ai/airi/issues/879 【turn36fetch0†L158-L213】 | High |
| E-10 | AIRI memory docs describe DuckDB (web), IndexedDB, sessions, and a multi-layer memory architecture. | Documentation claim | https://moeru-ai-airi.mintlify.app/configuration/memory 【turn6search3】 | Medium |
| E-11 | AstrBot dev-docs define a `Conversation` dataclass with `history: str = ""` (mutable whole-history string). | Documentation claim (file not located on `master`) | https://github.com/AstrBotDevs/AstrBot/wiki/en-dev-star-guides-ai 【turn22search3】 | Medium |
| E-12 | AstrBot context-compression triggers at 82% of the model context window; strategies are truncation or LLM-based summarization. | Documentation claim | https://github.com/AstrBotDevs/AstrBot/wiki/en-use-context-compress 【turn20search6】 | Medium |
| E-13 | AstrBot PR #4886 adds `user_name` and `avatar` columns to a conversation-history database schema with auto-migration. | Confirmed repository fact (PR) | https://github.com/AstrBotDevs/AstrBot/pull/4886 【turn37search1】 | Medium |
| E-14 | The current DC_BOT single-process topology does not, by itself, justify a standalone memory microservice in milestone 1. | Inference | E-02, E-04, E-05 | High |
| E-15 | AIRI's memory-pgvector cannot serve as a production memory backend for DC_BOT as-is; it is a skeleton. | Inference | E-06, E-07, E-09 | High |

---

## 6. Current-state findings

### 6.1 DC_BOT has no memory authority today
The bot is a single-process voice pipeline with no persisted conversational state 【turn2fetch0†L159-L168】【turn5fetch0†L5-L11】. `Plan.md` is exclusively about emotion-aware speech conditioning for GPT-SoVITS and does not introduce any memory layer 【turn4fetch0†L1-L16】. The checked-in AIRI `services/discord-bot/src` tree contains `adapters/`, `bots/discord/commands/`, `constants/`, `pipelines/tts.ts`, `utils/`, and `index.ts` — no memory, history, or identity module 【turn14fetch0†L250-L256】. This confirms source-plan requirement #1 is currently unmet: text and voice own no histories at all, so there is nothing yet to consolidate.

### 6.2 The bot's Discord intent surface is narrow
Only Guilds and Guild Voice States are requested; Message Content is **not** required 【turn2fetch0†L177-L179】. Consequence: any text-event ingestion that depends on message content is gated on procuring the Message Content intent. Comprehensive guild-member-update handling (RISK-H) would additionally require the Server Members intent, which the upstream AIRI discord-bot README *does* instruct operators to enable 【turn10fetch0†L260-L262】 — a discrepancy with DC_BOT's narrower intent set that must be resolved before alias observation can be authoritative.

### 6.3 AIRI's memory layer is not production-ready
`@proj-airi/memory-pgvector` (v0.11.3, private) consists of a single `src/index.ts` that instantiates a server-sdk `Client` with an empty `module:configure` handler and contains no schema, store, query, or memory operations 【turn35fetch0】【turn35fetch1】. The Alaya proposal (#879) is an open issue describing a `MemoryDriver` interface with time-decay and emotional weighting; it is explicitly a proposal and references "Memory Alaya [WIP]" on the roadmap 【turn36fetch0†L158-L213】. The AIRI memory docs describe a DuckDB/IndexedDB/session model 【turn6search3】, and issue #387 proposes a standalone `@proj-airi/memory-core` 【turn6search0】 — both are proposals/documentation, not verified implementations. This confirms RISK-K: AIRI memory work is skeletons and proposals, not a reusable production backend.

### 6.4 AIRI exposes a reusable module protocol but it is not a memory contract
The server-sdk module protocol (`connect`/`announce`/`onEvent`/`send`/`sendOrThrow`, `isReady`, `connectionStatus`) 【turn0fetch0†turn40find1】 is a transport for inter-module events, not a memory API. It could later host a remote MemoryPort transport, but it does not define memory operations, capability negotiation, or delivery/durability semantics. It is therefore a candidate transport, not a substitute for the contract specified here.

### 6.5 AstrBot is a useful baseline but its history model is not concurrency-safe
AstrBot dev-docs model a `Conversation` entity whose `history` is a single `str` field 【turn22search3】, and context compression triggers at 82% of the model window via truncation or LLM summarization 【turn20search6】. PR #4886 adds `user_name`/`avatar` columns to a conversation-history database 【turn37search1】. A mutable whole-history string (or whole-history JSON blob) read-modify-written per turn is not safe under concurrent writers and does not separate raw events from lifecycle state — this confirms RISK-L and informs the append-only + lifecycle-status model in §10.

---

## 7. Proposed decisions

**ADR-001 — In-process application service first; HTTP transport is a later adapter.** The MemoryPort is a domain interface implemented by an in-process application service backed by SQLite (default) or PostgreSQL. An HTTP transport is specified as a thin DTO-mapping adapter and is enabled only when a verified deployment need exists (e.g., a second bot process sharing one memory authority). *Decision criterion:* RISK-A; current topology is one Node process 【turn5fetch0†L5-L11】. *Status: chosen.*

**ADR-002 — One MemoryPort interface, many repository implementations.** The domain interface is identical whether the backing store is SQLite, PostgreSQL, an in-memory fake, or a remote service. Repositories implement a `MemoryRepository` SPI; the application service composes the SPI with authorization, capability negotiation, and spool/reconciliation. *Status: chosen.*

**ADR-003 — Append-mostly raw events + separate lifecycle records; tombstones, not destructive deletes, for erasure.** Raw attributable events are append-only. Erasure (RISK-I) produces redaction records and tombstones rather than row deletion; physical purge is a separate, audited, governance-gated operation. Lifecycle status (delivered/failed/interrupted/superseded) is a separate state table, not a mutation of the raw payload (RISK-E). *Status: chosen.*

**ADR-004 — Capability negotiation on every session; no silent capability assumptions.** Callers call `getCapabilities()` (op 13) and must not invoke operations whose capability is absent; the port rejects unsupported operations with `UNSUPPORTED_CAPABILITY` rather than degrading silently. *Status: chosen.*

**ADR-005 — Delivery is modeled separately from generation and persistence (source-plan #13).** A draft is created (op 4), then one or more delivery attempts are recorded (op 5) with explicit terminal states. Database commit and Discord send are never in one atomic transaction (RISK-C). *Status: chosen.*

**ADR-006 — `discord:user:<id>` is the durable identity key; everything else is an attribute (source-plan #3, RISK-F).** Cross-platform human identity is out of scope. *Status: chosen.*

---

## 8. Alternatives considered

**Alt-1 — Standalone HTTP memory microservice in milestone 1.** *Rejected:* RISK-A; the topology is one bot process 【turn5fetch0†L5-L11】. Revisit when a second writer process or a separate retrieval worker is actually deployed. The HTTP DTO contract (§10.4) is specified now so the migration is mechanical.

**Alt-2 — Adopt AIRI `memory-pgvector` / Alaya as the backend.** *Rejected for milestone 1:* E-06, E-09, E-15 — it is a skeleton with an empty module handler and no schema. Revisit if/when Alaya ships a production `MemoryDriver` with provenance, erasure, and capability negotiation.

**Alt-3 — Adopt AstrBot's whole-history string/blob model.** *Rejected:* E-11, RISK-L — mutable whole-history read-modify-write is not concurrency-safe and conflates raw events with lifecycle. The append-only model (ADR-003) preserves AstrBot's compression idea (summarization) as a separate layer without inheriting its write model.

**Alt-4 — Vectors/graph as the primary retrieval path.** *Rejected for milestone 1:* RISK-J, source-plan #17. Retrieval begins with authorization → structured lookup → temporal filter → lexical/full-text. Vectors and graph require benchmark evidence before promotion.

**Alt-5 — Reject append commits when a room snapshot version diverges during generation.** *Rejected:* RISK-B. A room snapshot version is evidence of what generation saw; an ordinary append is not rejected merely because another event arrived during generation. Conflict policy is specified in §10 (op 3, op 6).

---

## 9. Rejected alternatives and reasons

| Rejected alternative | Reason | Reference |
|---|---|---|
| Production `NullMemoryClient` that accepts writes and persists nothing | Violates source-plan #22; pretends writes succeeded. Forbidden by normative rule F-1. | RISK-22 |
| Silent fallback to ephemeral memory during outages while telling the user "I remember" | Violates source-plan #16 (retrieved memory is untrusted data) and #22. Degraded mode must surface a sentinel, not a fabricated memory. | RISK-22, REQ-PRIV-001 |
| One `user_event_id` per assistant exchange (fixed exchange schema) | Conflicts with multi-speaker group responses; source-plan #14, RISK-D. Replaced by many-to-many causal link table. | REQ-EVENT-014 |
| Mutating raw event payloads to reflect lifecycle | Violates append-only raw layer; RISK-E. Lifecycle is a separate state record. | ADR-003 |
| Generic "PostgreSQL full-text search" claim covering CJK | RISK-M; CJK requires explicit tokenizer configuration (`pg_jieba`/`zhparser`/trigram). Capability advertises `fulltext_cjk` separately. | REQ-RETRIEVAL-007 |

---

## 10. Normative specification

### 10.1 Layered architecture

```
                ┌──────────────────────────────────────────┐
   Caller ────▶ │  MemoryPort  (domain interface)          │  ◀── 13 operations
 (bot text/      │  + Capability negotiation               │
  voice paths)   │  + Authorization                        │
                 └───────────────┬──────────────────────────┘
                                 │  (identical DTOs)
              ┌──────────────────┼───────────────────────────┐
              │                  │                           │
   ┌──────────▼─────────┐  ┌─────▼──────────┐  ┌────────────▼───────────┐
   │ InProcessService    │  │ HttpClient     │  │ DeterministicTestFake  │
   │ (default)           │  │ (optional)     │  │ (tests only)           │
   │ SQLite / PostgreSQL │  │ → remote svc   │  │ in-memory              │
   └──────────┬─────────┘  └────────────────┘  └────────────────────────┘
              │
   ┌──────────▼──────────────────────────────────────────────┐
   │  MemoryRepository SPI                                    │
   │  raw_events | lifecycle | drafts | delivery | identities │
   │  aliases | rooms | bindings | summaries | structured_mem │
   │  causal_links | governance | spool                       │
   └──────────────────────────────────────────────────────────┘
```

### 10.2 Identity, room, and event model (normative)

- **Durable identity key:** `discord:user:<snowflake>`. Usernames, global names, guild nicknames, aliases, avatars, voice characteristics are **attributes** (source-plan #3; ADR-006; RISK-F). `discord:user:<id>` is not a verified cross-platform human identity.
- **Actor snapshot:** every inbound event carries `{ userId, username?, globalName?, guildNickname?, avatarUrl?, voiceCharacteristics? }` — the best available presentation fields at event time (source-plan #4).
- **Historical vs. current presentation:** raw events preserve the snapshot observed at event time; current addressing uses the active permitted alias (source-plan #5).
- **Alias scopes (source-plan #6):** `platform`, `character-global`, `guild`, `logical-room`, `private-conversation`. Private aliases must not leak into public guild contexts (REQ-PRIV-006).
- **Opaque person references (source-plan #7):** prompt-local opaque IDs (e.g., `person:01HK…`) distinguish speakers; they are never printed or spoken and never merge two distinct `discord:user:<id>` values.
- **Rooms (source-plan #9):** physical Discord rooms (guild+channel) and logical conversation rooms are distinct. Recent room history crosses channels only through explicit/configured bindings (op 10).
- **Group voice (source-plan #8):** one attributable user event per speaker; the durable author is never a synthetic person such as "Discord group."
- **Causal relations (source-plan #14, RISK-D):** many-to-many. A draft may be caused by ≥1 user event; a user event may cause ≥1 draft.
- **Delivery separation (source-plan #13, RISK-C):** draft creation, persistence, and Discord send are separate; never one atomic transaction.
- **Lifecycle (RISK-E):** raw event payloads are immutable; lifecycle status is a separate record. Interrupted/failed/unheard/partially-delivered outputs are not normal completed turns (source-plan #15).
- **Retrieved memory is untrusted data (source-plan #16):** prompt serialization resists delimiter injection, fake-role injection, mentions, Unicode abuse, and internal-ID exposure.

### 10.3 Capability set

| Capability ID | Meaning | Milestone-1 default (SQLite) | PostgreSQL |
|---|---|---|---|
| `durable_events` | Append-only raw attributable events | ✅ | ✅ |
| `alias_support` | Scoped preferred-alias resolution | ✅ | ✅ |
| `summaries` | Stored summaries as a separate layer | ✅ (write/read) | ✅ |
| `structured_memory` | Durable facts with provenance/confidence/temporal validity | ✅ | ✅ |
| `fulltext_latin` | Lexical/full-text search for Latin scripts | ✅ (SQLite FTS5) | ✅ (pg `tsvector`) |
| `fulltext_cjk` | CJK-aware full-text (RISK-M) | ❌ until tokenizer chosen | ⚠️ requires `pg_jieba`/`zhparser`/trigram; advertise only when configured |
| `vector_search` | ANN vector retrieval | ❌ | ❌ until benchmark (RISK-J) |
| `graph_search` | Graph traversal retrieval | ❌ | ❌ until benchmark (RISK-J) |
| `export` | Person-data export (op 11) | ✅ | ✅ |
| `deletion` | Tombstone/redact/purge (op 12) | ✅ | ✅ |
| `remote_transport` | HTTP bridge active | ❌ (in-process) | optional |
| `degraded_read_cache` | Read-side cache usable during outage | optional | optional |

A capability is advertised **only** when the backend can satisfy it correctly. `fulltext_cjk` MUST NOT be advertised under a generic "PostgreSQL full-text" claim (RISK-M). `vector_search`/`graph_search` require benchmark evidence before advertisement (RISK-J).

### 10.4 Operation contracts

Each operation below specifies the full 14-field contract. Common conventions: timestamps are RFC 3339 UTC; IDs are ULID-ish sortable strings; all writes carry `requestId` for idempotency; `auth` is an `AuthPrincipal { botUserId, scopes[], guildId?, roomId? }`.

---

#### OP-01 `resolveRoom`

| Field | Value |
|---|---|
| Domain input | `{ physical: { guildId, channelId }?, logicalRoomId?, bindingHint? }` |
| Domain output | `{ roomId, roomKind: "physical"｜"logical"｜"bound", physicalRef?, logicalRoomId?, snapshotVersion }` |
| Transport DTO | `POST /v1/rooms:resolve` → `RoomResolutionDTO` |
| Validation | At least one of `physical` or `logicalRoomId` required; `guildId` mandatory for guild channels. |
| Authorization | Caller must have `room:read` for the resolved scope; DM channels require the caller's `botUserId` to be a participant. |
| Idempotency | Pure read; cacheable by `(guildId,channelId)`. |
| Transaction boundary | Read-only single statement. |
| Timeout | 2s (in-process), 5s (remote). |
| Retryability | Retryable on transient errors. |
| Error taxonomy | `INVALID_ROOM_REF`, `UNAUTHORIZED_ROOM`, `ROOM_NOT_FOUND`, `TIMEOUT`. |
| Version compatibility | Output is forward-compatible; unknown fields ignored by older callers. |
| Audit fields | `resolvedAt`, `resolverPrincipal`. |
| Privacy-sensitive fields | `guildId`, `channelId`, DM participant list. |
| Degraded behavior | If repository unreadable, return `ROOM_NOT_FOUND` with `degraded=true`; do not fabricate a room. |

---

#### OP-02 `observeActor`

| Field | Value |
|---|---|
| Domain input | `{ actorSnapshot, scope: "platform"｜"guild"｜"logical-room"｜"private", observedAt, source: "gateway"｜"guildMemberUpdate"｜"voiceState" }` |
| Domain output | `{ personId, identityKey: "discord:user:<id>", currentAlias?, changedFields[] }` |
| Transport DTO | `POST /v1/actors:observe` → `ActorObservationDTO` |
| Validation | `userId` required and must be a Discord snowflake as string; snapshot fields length-bounded. |
| Authorization | Caller must have `identity:observe`. Only the bot process may call. |
| Idempotency | Idempotent per `(userId, scope, hash(snapshot))` within a short window; coalesces write amplification (RISK-G). |
| Transaction boundary | Single upsert on `current_identity` + conditional append to `alias_history` only when a field actually changed. |
| Timeout | 1s (in-process), 3s (remote). |
| Retryability | Retryable; non-retryable on `INVALID_SNOWFLAKE`. |
| Error taxonomy | `INVALID_SNOWFLAKE`, `UNAUTHORIZED_OBSERVE`, `TIMEOUT`. |
| Version compatibility | New snapshot fields are additive; old readers ignore unknown fields. |
| Audit fields | `observedAt`, `source`, `observerPrincipal`. |
| Privacy-sensitive fields | username, globalName, guildNickname, avatarUrl, voiceCharacteristics. |
| Degraded behavior | If `current_identity` write fails, spool the observation (op-spool) and continue; do not block the voice path (source-plan #18: identity observation must remain off the voice-critical path where possible, but durable identity is release-blocking, so the spool is mandatory). |

**Write-amplification policy (RISK-G):** `current_identity` updates are upserts with a content hash; `alias_history` appends only when a watched field changes. Guild-member-update handling (RISK-H) requires the Server Members intent, which is **not** currently requested by DC_BOT (E-03); enabling it is a blocking operational decision (§17).

---

#### OP-03 `appendEvent`

| Field | Value |
|---|---|
| Domain input | `{ roomId, actor: { personId, identityKey, snapshotAtEventTime }, kind: "user_text"｜"user_voice"｜"system", payload: { content, lang?, mediaRef? }, occurredAt, causalParentEventIds?[] }` |
| Domain output | `{ eventId, roomId, snapshotVersion, lifecycle: "recorded" }` |
| Transport DTO | `POST /v1/events:append` → `EventAppendDTO` |
| Validation | `roomId` resolved via OP-01; `identityKey` present; payload content non-empty for user events; opaque `personId` never equals a printable string like "Discord group" (source-plan #8). |
| Authorization | Caller must have `event:write` for `roomId`; the author must be a real Discord user, never synthetic. |
| Idempotency | `requestId`-based; duplicate appends within 24h return the original `eventId`. |
| Transaction boundary | Single append to `raw_events` (+ `causal_links` if parents provided). Does **not** touch drafts or delivery. |
| Timeout | 2s (in-process), 5s (remote). |
| Retryability | Retryable on transient; non-retryable on `INVALID_PAYLOAD`. |
| Error taxonomy | `INVALID_ROOM`, `INVALID_ACTOR`, `SYNTHETIC_AUTHOR_FORBIDDEN`, `PAYLOAD_TOO_LARGE`, `UNAUTHORIZED_WRITE`, `TIMEOUT`. |
| Version compatibility | `kind` enum is open; unknown kinds rejected with `UNKNOWN_EVENT_KIND` to force explicit negotiation. |
| Audit fields | `recordedAt`, `writerPrincipal`, `requestId`. |
| Privacy-sensitive fields | content, mediaRef, voice characteristics, snapshot fields. |
| Degraded behavior | On persistent write failure, spool to local append-only spool (op-spool) and return `SPOOLED` (not `RECORDED`). The caller must treat `SPOOLED` as "not yet durable." Reconciliation (§10.6) drains the spool. RISK-B: an arriving event during generation does **not** cause `appendEvent` to reject; snapshot divergence is handled at assemble-context time. |

---

#### OP-04 `createDraft`

| Field | Value |
|---|---|
| Domain input | `{ roomId, triggeredByEventIds: string[], generatedContent: { text, segments?[] }, modelRef, generationContextSnapshot: { roomSnapshotVersion, promptHash }, createdAt }` |
| Domain output | `{ draftId, roomId, status: "draft", causedBy: string[] }` |
| Transport DTO | `POST /v1/drafts` → `DraftDTO` |
| Validation | `triggeredByEventIds` non-empty (≥1; supports multi-speaker, RISK-D); `generatedContent.text` non-empty; `roomSnapshotVersion` present. |
| Authorization | Caller must have `draft:write` for `roomId`. |
| Idempotency | `requestId`-based; duplicate creates return the original `draftId`. |
| Transaction boundary | Single insert into `drafts` + `causal_links(draftId ↔ eventId)`. Does not commit any delivery. |
| Timeout | 2s (in-process), 5s (remote). |
| Retryability | Retryable on transient. |
| Error taxonomy | `INVALID_TRIGGER_EVENTS`, `EMPTY_CONTENT`, `SNAPSHOT_STALE` (advisory, not blocking — RISK-B), `UNAUTHORIZED_WRITE`, `TIMEOUT`. |
| Version compatibility | `segments` schema is versioned; unknown segment kinds ignored by older readers. |
| Audit fields | `createdAt`, `writerPrincipal`, `modelRef`, `promptHash`. |
| Privacy-sensitive fields | generatedContent (may contain user-quoted text). |
| Degraded behavior | If persistence fails, the draft is **not** created; the caller must not send. Return `PERSISTENCE_FAILED`. No silent in-memory-only draft. |

---

#### OP-05 `recordDelivery`

| Field | Value |
|---|---|
| Domain input | `{ draftId, attempt: { transport: "discord_text"｜"discord_voice", target: { channelId?｜voiceChannelId? }, startedAt }, result?: { outcome: "delivered"｜"partial"｜"failed"｜"interrupted"｜"unheard", completedAt?, discordMessageId?, failureReason? } }` |
| Domain output | `{ deliveryId, draftId, terminalStatus }` |
| Transport DTO | `POST /v1/deliveries` → `DeliveryDTO` |
| Validation | `draftId` must exist; `outcome` required to transition to terminal; `discordMessageId` required when `outcome="delivered"` for text. |
| Authorization | Caller must have `delivery:write`. |
| Idempotency | One delivery attempt per `attemptId`; replaying the same `attemptId` updates the same row. |
| Transaction boundary | Upsert on `deliveries`; updates `drafts.status` to terminal only when a terminal outcome is recorded. **Never** in the same transaction as the Discord send (RISK-C). |
| Timeout | 2s (in-process), 5s (remote). |
| Retryability | Retryable on transient; the Discord send itself is retried by the caller, not by this op. |
| Error taxonomy | `DRAFT_NOT_FOUND`, `INVALID_OUTCOME`, `MISSING_MESSAGE_ID`, `UNAUTHORIZED_WRITE`, `TIMEOUT`. |
| Version compatibility | `outcome` enum is closed; new outcomes require schema migration. |
| Audit fields | `startedAt`, `completedAt?`, `writerPrincipal`, `discordMessageId?`. |
| Privacy-sensitive fields | target channel/voice channel, failure reason. |
| Degraded behavior | If the delivery record cannot be persisted, the caller logs a `DELIVERY_UNRECORDED` warning with `draftId` and `discordMessageId` and continues; a reconciliation sweep (§10.6) reconciles orphan Discord messages against `drafts`. Interrupted/partial/unheard outcomes never become "completed conversational turns" (source-plan #15). |

**Crash-window states (RISK-C):** `drafts.status ∈ {draft, sending, delivered, partial, failed, interrupted, unheard, superseded}`. The reconciliation sweep classifies orphans: a Discord message with no `deliveries` row → `delivered` (best-effort) or `unheard` if playback never started; a `deliveries` row with no Discord message → `failed`.

---

#### OP-06 `assembleContext`

| Field | Value |
|---|---|
| Domain input | `{ roomId, forDraftId?, maxEvents?, maxTokens?, includeLayers: ("raw"｜"summary"｜"structured")[], asOfSnapshotVersion?, personScope? }` |
| Domain output | `{ roomSnapshotVersion, events: SerializedEvent[], summaries: SerializedSummary[], structuredFacts: SerializedFact[], opaquePersonMap: { opaqueId → displayName }, promptSafeSerial }` |
| Transport DTO | `POST /v1/context:assemble` → `ContextBundleDTO` |
| Validation | `roomId` resolved; `maxTokens` > 0; layer selection non-empty. |
| Authorization | Caller must have `context:read` for `roomId`; `personScope` must not widen beyond the caller's authorized scopes (private aliases never leak — REQ-PRIV-006). |
| Idempotency | Read; cacheable by `(roomId, asOfSnapshotVersion, layerSelection)`. |
| Transaction boundary | Read-only, snapshot-isolated. |
| Timeout | 3s (in-process), 8s (remote). |
| Retryability | Retryable on transient. |
| Error taxonomy | `INVALID_ROOM`, `UNAUTHORIZED_READ`, `SCOPE_LEAK_DETECTED`, `TIMEOUT`. |
| Version compatibility | `promptSafeSerial` is a versioned serialization format. |
| Audit fields | `assembledAt`, `readerPrincipal`, `layersIncluded`. |
| Privacy-sensitive fields | event content, summaries, facts, opaquePersonMap. |
| Degraded behavior | If `summaries`/`structured` layers are unavailable (capability not advertised), omit them and set `degraded=true`; **never** substitute fabricated content. RISK-B: if `asOfSnapshotVersion` is supplied and the current version is higher, include newer events up to the limit and annotate divergence — do not reject. |

**Prompt-safe serialization (source-plan #16):** `promptSafeSerial` escapes delimiters, neutralizes role markers (`system:`/`assistant:`/`user:`), strips or quotes mentions, normalizes Unicode control characters, and never emits internal IDs (`eventId`, `personId`) — only opaque display tokens. Opaque person references are bound via `opaquePersonMap` and are never spoken or printed (source-plan #7).

---

#### OP-07 `searchMemory`

| Field | Value |
|---|---|
| Domain input | `{ query, scope: { roomId?｜guildId?｜personId? }, layers: ("raw"｜"summary"｜"structured")[], filters: { since?, until?, lang?, kinds?[] }, modes: ("structured"｜"lexical"｜"vector"｜"graph")[], limit, cursor? }` |
| Domain output | `{ results: MemoryHit[], nextCursor?, appliedModes[], deprecatedCapabilities[] }` |
| Transport DTO | `POST /v1/memory:search` → `SearchResultsDTO` |
| Validation | `query` length-bounded; at least one mode; modes must be subset of advertised capabilities (else `UNSUPPORTED_CAPABILITY`). |
| Authorization | `memory:search` for the requested scope; cross-scope search refused unless caller has both scopes. |
| Idempotency | Read; deterministic given identical input and repository state. |
| Transaction boundary | Read-only. |
| Timeout | 3s (in-process), 8s (remote). Vector/graph modes (when enabled) have separate budgets. |
| Retryability | Retryable on transient; vector mode non-retryable on `EMBEDDING_FAILED`. |
| Error taxonomy | `UNSUPPORTED_CAPABILITY`, `UNAUTHORIZED_SEARCH`, `SCOPE_LEAK_DETECTED`, `EMBEDDING_FAILED`, `TIMEOUT`. |
| Version compatibility | `modes` is open; unknown modes rejected. |
| Audit fields | `searchedAt`, `readerPrincipal`, `scopes`, `appliedModes`. |
| Privacy-sensitive fields | query content, returned snippets. |
| Degraded behavior | If `vector`/`graph` unavailable, fall back to `lexical`+`structured` only if the caller requested a fallback; otherwise return `UNSUPPORTED_CAPABILITY`. CJK queries against a backend without `fulltext_cjk` return `UNSUPPORTED_CAPABILITY` (RISK-M) rather than silently returning no matches. |

**Retrieval order (source-plan #17):** authorization → structured lookup → temporal filter → lexical/full-text → (optional, benchmarked) vector rerank → (optional, benchmarked) graph expansion. Arbitrary weights and latency thresholds are hypotheses until evaluated (RISK-J); the default weights are recorded as `appliedModes`/`weights` in the audit log for later benchmarking.

---

#### OP-08 `recordIntent` (remember / correct / forget)

| Field | Value |
|---|---|
| Domain input | `{ actor: { personId, identityKey }, roomId, intent: "remember"｜"correct"｜"forget", target: { kind: "fact"｜"alias"｜"event", ref?, value? }, provenance: { sourceEventId, statedAt }, confidence?, supersession: { supersedesId? } }` |
| Domain output | `{ intentId, appliedEffect, supersededIds: string[] }` |
| Transport DTO | `POST /v1/intents` → `IntentRecordDTO` |
| Validation | `remember` requires `value`; `correct` requires `ref` (the fact being corrected) and `value`; `forget` requires `target.ref` or a scope. Assistant speculation must not become user truth (source-plan #12): intents authored by the assistant carry `provenance.source="assistant"` and are stored as **candidate**, not **durable fact**, until an operator or the user confirms. |
| Authorization | `intent:write` for the scope; `forget` across a guild requires operator privilege. |
| Idempotency | `requestId`-based. |
| Transaction boundary | Insert `intent_records`; for `correct`/`forget`, also insert `supersession`/`tombstone` rows in the same transaction. |
| Timeout | 2s (in-process), 5s (remote). |
| Retryability | Retryable on transient. |
| Error taxonomy | `INVALID_INTENT`, `MISSING_VALUE`, `ASSISTANT_FACT_NOT_DURABLE`, `UNAUTHORIZED_INTENT`, `TIMEOUT`. |
| Version compatibility | `target.kind` is open. |
| Audit fields | `statedAt`, `authorPrincipal`, `provenance`. |
| Privacy-sensitive fields | target value, alias. |
| Degraded behavior | On persistence failure, spool; never acknowledge a remember that was not durably stored (RISK-22). |

---

#### OP-09 `resolvePreferredAddress`

| Field | Value |
|---|---|
| Domain input | `{ personId, scope: "platform"｜"character-global"｜"guild"｜"logical-room"｜"private", callingScope }` |
| Domain output | `{ preferredAlias, scope, privacyLevel, printableForm }` |
| Transport DTO | `POST /v1/actors:resolve-address` → `AddressDTO` |
| Validation | `scope` must be a permitted scope for the caller; private aliases resolve only when `callingScope` is private (REQ-PRIV-006). |
| Authorization | `alias:read` for the scope. |
| Idempotency | Read; cacheable with short TTL. |
| Transaction boundary | Read-only. |
| Timeout | 1s (in-process), 3s (remote). |
| Retryability | Retryable on transient. |
| Error taxonomy | `PERSON_NOT_FOUND`, `PRIVATE_ALIAS_IN_PUBLIC_SCOPE`, `UNAUTHORIZED_READ`, `TIMEOUT`. |
| Version compatibility | `privacyLevel` enum is closed. |
| Audit fields | `resolvedAt`, `readerPrincipal`, `callingScope`. |
| Privacy-sensitive fields | preferredAlias. |
| Degraded behavior | If unreadable, fall back to `discord:user:<id>` numeric form with `degraded=true`; never leak a private alias into a public scope (RISK — REQ-PRIV-006). |

---

#### OP-10 `bindRooms` / `unbindRooms`

| Field | Value |
|---|---|
| Domain input (bind) | `{ physicalRoomId, logicalRoomId, bindingKind: "explicit"｜"configured", policy: { crossChannelHistory: bool, direction: "bidirectional"｜"physical→logical" }, createdBy }` |
| Domain input (unbind) | `{ bindingId, reason }` |
| Domain output | `{ bindingId, effectiveAt }` / `{ unbound: true }` |
| Transport DTO | `POST /v1/bindings` / `DELETE /v1/bindings/{id}` → `BindingDTO` |
| Validation | A physical room may bind to at most one logical room per `bindingKind` unless `policy.crossChannelHistory=false`; bindings never cross DM isolation. |
| Authorization | `binding:write` requires operator privilege; bindings affecting DMs require the participant. |
| Idempotency | Re-binding the same pair returns the existing `bindingId`. |
| Transaction boundary | Single upsert; cache invalidation event emitted. |
| Timeout | 2s (in-process), 5s (remote). |
| Retryability | Retryable on transient. |
| Error taxonomy | `DUPLICATE_BINDING`, `DM_ISOLATION_VIOLATION`, `UNAUTHORIZED_BIND`, `TIMEOUT`. |
| Version compatibility | `policy` is additive. |
| Audit fields | `effectiveAt`, `createdBy`, `reason?`. |
| Privacy-sensitive fields | room references, policy. |
| Degraded behavior | On failure, no binding is created; cache invalidation is skipped (callers re-resolve). |

---

#### OP-11 `exportPerson`

| Field | Value |
|---|---|
| Domain input | `{ personId, format: "json"｜"jsonl", includeLayers: ("raw"｜"summary"｜"structured"｜"delivery")[], since?, until? }` |
| Domain output | `{ exportId, stream: AsyncIterable<ExportChunk>, manifest: { counts, redactions, checksum } }` |
| Transport DTO | `GET /v1/persons/{id}/export?…` → `application/x-ndjson` stream + `Export-Manifest` header |
| Validation | `personId` resolved; layer selection non-empty. |
| Authorization | `person:export` — operator or the data subject (source-plan #20). |
| Idempotency | Read; `exportId` is content-addressable. |
| Transaction boundary | Read-only, snapshot-isolated. |
| Timeout | Streaming; chunk deadline 10s. |
| Retryability | Retryable from the last cursor. |
| Error taxonomy | `PERSON_NOT_FOUND`, `UNAUTHORIZED_EXPORT`, `TIMEOUT`. |
| Version compatibility | `manifest.schemaVersion` recorded. |
| Audit fields | `exportedAt`, `requesterPrincipal`, `manifest`. |
| Privacy-sensitive fields | all exported content. |
| Degraded behavior | Partial export is allowed only if `manifest.redactions` documents every redacted field; otherwise fail closed. |

---

#### OP-12 `governDelete` (redact / tombstone / purge)

| Field | Value |
|---|---|
| Domain input | `{ target: { kind: "person"｜"event"｜"fact"｜"alias"｜"room", ref }, action: "redact"｜"tombstone"｜"purge", governancePolicy: { authority, legalBasis?, retentionUntil? }, reason }` |
| Domain output | `{ governanceId, action, affectedRows, cacheInvalidations: string[], summaryRegenerationRequired: bool, embeddingDeletionRequired: bool }` |
| Transport DTO | `POST /v1/governance` → `GovernanceActionDTO` |
| Validation | `purge` requires operator + legal basis; `tombstone` is the default for erasure (RISK-I); `redact` replaces payload fields with `[redacted]` but preserves the row for causal integrity. |
| Authorization | `governance:write` — operator only (source-plan #20). |
| Idempotency | `requestId`-based; replaying is a no-op once terminal. |
| Transaction boundary | Multi-statement transaction: insert `governance_records`, update target rows, enqueue `cache_invalidation`, `summary_regen`, `embedding_deletion` jobs. **Append-mostly history and privacy deletion pull in opposite directions (RISK-I):** `redact`/`tombstone` preserve causal graph; `purge` physically removes rows and is recorded in an immutable `purge_log`. |
| Timeout | 10s (in-process), 30s (remote). |
| Retryability | Retryable on transient; non-retryable on `POLICY_VIOLATION`. |
| Error taxonomy | `UNAUTHORIZED_GOVERNANCE`, `POLICY_VIOLATION`, `TARGET_NOT_FOUND`, `PURGE_REQUIRES_LEGAL_BASIS`, `TIMEOUT`. |
| Version compatibility | `action` enum is closed. |
| Audit fields | `governedAt`, `authority`, `legalBasis?`, `reason`. |
| Privacy-sensitive fields | target content. |
| Degraded behavior | If the transaction partially fails, roll back; never leave a half-redacted row. Cache invalidation and summary/embedding regen are best-effort **but** their pending state is recorded in a `reconciliation_queue` and retried (§10.6). |

---

#### OP-13 `getHealth` / `getSchemaVersion` / `getCapabilities`

| Field | Value |
|---|---|
| Domain input | `{}` |
| Domain output | `{ status: "healthy"｜"degraded"｜"unavailable", schemaVersion, capabilities: Capability[], repositoryBackend: "sqlite"｜"postgresql"｜"fake"｜"remote", pendingSpoolDepth, pendingReconciliation }` |
| Transport DTO | `GET /v1/health` → `HealthDTO` |
| Validation | None. |
| Authorization | `system:read` (any caller). |
| Idempotency | Read. |
| Transaction boundary | Read-only. |
| Timeout | 1s (in-process), 3s (remote). |
| Retryability | Retryable. |
| Error taxonomy | `UNAVAILABLE`. |
| Version compatibility | `capabilities` is additive across schema versions. |
| Audit fields | `checkedAt`. |
| Privacy-sensitive fields | none. |
| Degraded behavior | This op itself must never silently fail; if the repository is unreachable, return `status="unavailable"` with `pendingSpoolDepth` if known. |

---

### 10.5 Capability negotiation protocol

1. On startup, the caller calls `getCapabilities()` (OP-13) and caches the advertised `Capability[]` with the reported `schemaVersion`.
2. Before invoking any operation, the caller verifies the required capability is present. If absent, the caller must either degrade explicitly (read-side only) or refuse the operation.
3. The port MUST reject any operation requiring an unadvertised capability with `UNSUPPORTED_CAPABILITY` (HTTP 501 when remote).
4. Capability set is versioned. A schema migration that adds a capability MUST increment `schemaVersion`; callers log but tolerate unknown capabilities (forward compatibility).
5. For the remote transport, `GET /v1/health` is the discovery endpoint; clients reconnect on capability change.

### 10.6 Degraded behavior, spool, and reconciliation (normative)

**F-1 Forbidden.** No production `NullMemoryClient` may accept writes without persistence. A test fake is permitted only in test builds and MUST be annotated `@TestOnly`.

**Stateless response during memory failure (the only permitted degraded path):**

| Aspect | Rule |
|---|---|
| User-visible behavior | The generator receives a `NO_DURABLE_CONTEXT` sentinel from `assembleContext`. The bot may respond using only the current turn's input. It must **not** claim to remember anything. Recommended phrasing is neutral and does not reference memory. |
| Logged | `ERROR` with correlation id, operation, `requestId`, scope, and failure class. Spool depth logged at `WARN`. |
| Writes durably spooled | Yes. Every write attempt (OP-02/03/04/05/08) is appended to a local append-only spool (`spool/*.ndjson`) with its `requestId` before returning `SPOOLED`. OP-04/05 callers treat `SPOOLED` as "not durable" and must not claim success to the user. |
| Reconciliation | On recovery, a `Reconciler` drains the spool in `requestId` order, applies idempotently, and emits `reconciled` audit records. Orphan Discord messages (sent but no `deliveries` row) are matched to `drafts` by `(roomId, approxTime)` and back-filled with `outcome=delivered` or `unheard` (RISK-C). |
| What must never be claimed as remembered | Any fact, alias, or prior utterance not present in the durable store. The generator prompt is constructed only from `assembleContext` output; the `NO_DURABLE_CONTEXT` sentinel explicitly omits the memory block. |

**Read-side degraded cache (capability `degraded_read_cache`):** optional. If advertised, `assembleContext` may serve a stale snapshot annotated `degraded=true, staleSince=<ts>` for a bounded TTL. Stale reads are never used for governance or export.

---

## 11. Interfaces, schemas, diagrams, state machines, test vectors

### 11.1 Core domain interface (TypeScript-flavored pseudocode)

```ts
type Capability =
  | 'durable_events' | 'alias_support' | 'summaries' | 'structured_memory'
  | 'fulltext_latin' | 'fulltext_cjk' | 'vector_search' | 'graph_search'
  | 'export' | 'deletion' | 'remote_transport' | 'degraded_read_cache'

interface MemoryPort {
  resolveRoom(i: ResolveRoomIn): Promise<ResolveRoomOut>
  observeActor(i: ObserveActorIn): Promise<ObserveActorOut>
  appendEvent(i: AppendEventIn): Promise<AppendEventOut>
  createDraft(i: CreateDraftIn): Promise<CreateDraftOut>
  recordDelivery(i: RecordDeliveryIn): Promise<RecordDeliveryOut>
  assembleContext(i: AssembleContextIn): Promise<AssembleContextOut>
  searchMemory(i: SearchMemoryIn): Promise<SearchMemoryOut>
  recordIntent(i: RecordIntentIn): Promise<RecordIntentOut>
  resolvePreferredAddress(i: ResolveAddressIn): Promise<ResolveAddressOut>
  bindRooms(i: BindRoomsIn): Promise<BindRoomsOut>
  unbindRooms(i: UnbindRoomsIn): Promise<UnbindRoomsOut>
  exportPerson(i: ExportPersonIn): Promise<ExportPersonOut>
  governDelete(i: GovernDeleteIn): Promise<GovernDeleteOut>
  getHealth(): Promise<HealthOut>
}
```

### 11.2 Minimal repository schema (portable SQL sketch)

```sql
CREATE TABLE raw_events (
  event_id            TEXT PRIMARY KEY,          -- ULID
  room_id             TEXT NOT NULL,
  actor_person_id     TEXT NOT NULL,             -- opaque, never printed
  identity_key        TEXT NOT NULL,             -- 'discord:user:<id>'
  snapshot_at_event   TEXT NOT NULL,             -- frozen actor snapshot JSON
  kind                TEXT NOT NULL,             -- user_text|user_voice|system
  payload             TEXT NOT NULL,             -- JSON
  occurred_at         TEXT NOT NULL,
  recorded_at         TEXT NOT NULL,
  writer_principal    TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  snapshot_version    INTEGER NOT NULL
);
CREATE INDEX idx_events_room_occ ON raw_events(room_id, occurred_at);

CREATE TABLE event_lifecycle (                 -- RISK-E: status separate from payload
  event_id    TEXT PRIMARY KEY REFERENCES raw_events(event_id),
  status      TEXT NOT NULL,                   -- recorded|superseded|redacted|tombstoned
  changed_at  TEXT NOT NULL,
  reason      TEXT
);

CREATE TABLE causal_links (                    -- RISK-D: many-to-many
  draft_id   TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  PRIMARY KEY(draft_id, event_id)
);

CREATE TABLE drafts (
  draft_id              TEXT PRIMARY KEY,
  room_id               TEXT NOT NULL,
  generated_content     TEXT NOT NULL,
  model_ref             TEXT NOT NULL,
  room_snapshot_version INTEGER NOT NULL,
  prompt_hash           TEXT NOT NULL,
  status                TEXT NOT NULL,         -- draft|sending|delivered|partial|failed|interrupted|unheard|superseded
  created_at            TEXT NOT NULL,
  writer_principal      TEXT NOT NULL,
  request_id            TEXT NOT NULL
);

CREATE TABLE deliveries (
  delivery_id         TEXT PRIMARY KEY,
  draft_id            TEXT NOT NULL REFERENCES drafts(draft_id),
  attempt_id          TEXT NOT NULL UNIQUE,
  transport           TEXT NOT NULL,           -- discord_text|discord_voice
  target              TEXT NOT NULL,
  outcome             TEXT NOT NULL,           -- delivered|partial|failed|interrupted|unheard
  started_at          TEXT NOT NULL,
  completed_at        TEXT,
  discord_message_id  TEXT,
  failure_reason      TEXT
);

CREATE TABLE current_identity (                -- upsert target; RISK-G write-amplification control
  identity_key      TEXT PRIMARY KEY,          -- discord:user:<id>
  person_id         TEXT NOT NULL,
  snapshot_hash     TEXT NOT NULL,
  current_alias     TEXT,
  updated_at        TEXT NOT NULL
);

CREATE TABLE alias_history (
  alias_id    TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL,
  scope       TEXT NOT NULL,                   -- platform|character-global|guild|logical-room|private
  alias_value TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source      TEXT NOT NULL
);

CREATE TABLE rooms (
  room_id        TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,                -- physical|logical|bound
  physical_ref   TEXT,
  logical_room_id TEXT,
  snapshot_version INTEGER NOT NULL
);

CREATE TABLE bindings (
  binding_id    TEXT PRIMARY KEY,
  physical_room_id TEXT NOT NULL,
  logical_room_id  TEXT NOT NULL,
  binding_kind     TEXT NOT NULL,
  policy           TEXT NOT NULL,
  effective_at     TEXT NOT NULL,
  created_by       TEXT NOT NULL
);

CREATE TABLE summaries ( event_id_ref TEXT, room_id TEXT, summary TEXT, generated_at TEXT, model_ref TEXT );
CREATE TABLE structured_facts (
  fact_id      TEXT PRIMARY KEY,
  person_id    TEXT,
  room_id      TEXT,
  predicate    TEXT NOT NULL,
  value        TEXT NOT NULL,
  provenance   TEXT NOT NULL,                  -- sourceEventId / operator / assistant-candidate
  confidence   REAL,
  valid_from   TEXT,
  valid_until  TEXT,
  superseded_by TEXT
);

CREATE TABLE governance_records ( governance_id TEXT PRIMARY KEY, target_kind TEXT, target_ref TEXT, action TEXT, authority TEXT, legal_basis TEXT, reason TEXT, governed_at TEXT );
CREATE TABLE purge_log ( purge_id TEXT PRIMARY KEY, governance_id TEXT, affected_rows INTEGER, purged_at TEXT );  -- RISK-I
CREATE TABLE spool ( seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT, op TEXT, payload TEXT, spooled_at TEXT, drained_at TEXT );
CREATE TABLE reconciliation_queue ( item_id TEXT PRIMARY KEY, kind TEXT, ref TEXT, due_at TEXT );
```

**SQLite/PostgreSQL portability notes:** `TEXT` primary keys and `JSON`-as-text are portable; PostgreSQL may use native `JSONB`, `TIMESTAMPTZ`, and `tsvector`/`pgvector` when those capabilities are advertised. FTS5 (SQLite) and `tsvector` (PostgreSQL) cover `fulltext_latin`; `fulltext_cjk` requires an explicit tokenizer extension and is advertised only when configured (RISK-M).

### 11.3 Delivery / draft state machine (RISK-C)

```
            createDraft            send starts
 draft ──────────────────▶ draft ─────────────▶ sending
                              │                   │
                              │                   ├─ delivered ──▶ (terminal)
                              │                   ├─ partial ────▶ (terminal, retryable by caller)
                              │                   ├─ interrupted ▶ (terminal)
                              │                   ├─ unheard ────▶ (terminal)
                              │                   └─ failed ─────▶ (terminal)
                              └─ superseded (new draft replaces during generation)
```

Crash windows: (a) `draft` persisted, Discord send never started → `failed` after timeout; (b) Discord message sent, `deliveries` row missing → reconciler back-fills `delivered` or `unheard`; (c) `deliveries` row present, no Discord message → `failed`.

### 11.4 Test vectors (selection)

- **TEST-001 (identity continuity):** Two events with the same `discord:user:<id>` but different `guildNickname` must resolve to one `person_id` and preserve both snapshots on the raw events.
- **TEST-002 (alias scope leak):** `resolvePreferredAddress(scope=private)` called from `callingScope=guild` must return `PRIVATE_ALIAS_IN_PUBLIC_SCOPE`.
- **TEST-003 (synthetic author):** `appendEvent` with `actor.personId` resolving to a printable "Discord group" must return `SYNTHETIC_AUTHOR_FORBIDDEN`.
- **TEST-004 (many-to-many):** One draft with `triggeredByEventIds=[e1,e2]` from two speakers must persist two `causal_links` rows.
- **TEST-005 (snapshot divergence, RISK-B):** `assembleContext(asOfSnapshotVersion=5)` while current is 7 must return events up to the limit and annotate divergence, not reject.
- **TEST-006 (delivery atomicity, RISK-C):** A Discord send succeeding while `recordDelivery` crashes must be reconciled to `delivered` on recovery.
- **TEST-007 (forget, RISK-I):** `governDelete(action=tombstone)` on a person must tombstone their facts/events but preserve causal graph; `purge` must record `purge_log` and require `legalBasis`.
- **TEST-008 (no silent null, RISK-22):** Replacing the port with a fake that accepts writes and persists nothing must fail a production wiring test (`@TestOnly` enforcement).
- **TEST-009 (prompt safety):** `assembleContext` output containing `<|system|>` or `@everyone` in stored content must be neutralized in `promptSafeSerial`.
- **TEST-010 (CJK capability, RISK-M):** `searchMemory(modes=[lexical])` for a CJK query against a backend without `fulltext_cjk` must return `UNSUPPORTED_CAPABILITY`.
- **TEST-011 (abstention):** When `assembleContext` returns `NO_DURABLE_CONTEXT`, the generator's output must not contain "I remember" phrasing (asserted via fixture).
- **TEST-012 (idempotent append):** Replaying `appendEvent` with the same `requestId` returns the original `eventId`.

---

## 12. Failure modes

| Failure | Effect | Mitigation |
|---|---|---|
| Repository unreachable (SQLite locked / PG down) | Writes return `SPOOLED`; reads return `degraded` or `TIMEOUT` | Spool + reconciler (§10.6) |
| Crash between Discord send and `recordDelivery` (RISK-C) | Orphan Discord message or orphan draft | Reconciler matches by `(roomId, approxTime)`; classifies `delivered`/`unheard`/`failed` |
| Snapshot divergence during generation (RISK-B) | `assembleContext` sees newer events than the draft's `roomSnapshotVersion` | Annotate divergence; do not reject ordinary appends |
| Concurrent writers to whole-history (Alt-3) | Lost updates | Rejected model; append-only + lifecycle records avoid read-modify-write |
| Private alias leak (RISK — REQ-PRIV-006) | PII exposure | Scope check on every alias read; `SCOPE_LEAK_DETECTED` aborts the call |
| CJK search with no tokenizer (RISK-M) | Silent empty results | `UNSUPPORTED_CAPABILITY` |
| Vector/graph without benchmark (RISK-J) | Unjustified cost/latency | Capability not advertised until benchmark recorded |
| Assistant speculation persisted as fact (source-plan #12) | User truth corruption | `provenance.source="assistant"` facts are `candidate`, not `durable`, until confirmed |
| Member-update intent missing (RISK-H) | Stale aliases/avatars | Alias observation degrades to event-time snapshots; enabling Server Members intent is a blocking ops decision (§17) |

---

## 13. Security and privacy implications

- **Identity minimization (ADR-006, RISK-F):** only `discord:user:<id>` is durable identity; presentation fields are attributes with their own retention policy. Cross-platform human verification is a non-goal.
- **Scope isolation (source-plan #19, REQ-PRIV-006):** DM, guild, person, character, logical-room, and unbound-channel scopes have explicit authorization rules. Private aliases never resolve in public scopes.
- **Prompt injection resistance (source-plan #16):** `promptSafeSerial` neutralizes delimiters, role markers, mentions, Unicode control chars, and never emits internal IDs.
- **Erasure (RISK-I, source-plan #20):** `tombstone`/`redact` preserve causal integrity; `purge` is governance-gated and logged. Cache invalidation, summary regeneration, and embedding deletion are queued and reconciled.
- **Auditability:** every write carries `writerPrincipal`, `requestId`, and a timestamp; governance actions carry `authority` and `legalBasis`.
- **Secrets:** the MemoryPort stores no Discord tokens or LLM keys; those remain in `airi/services/discord-bot/.env` (E-02). Export streams are scoped to a single person and authorization-checked.
- **Release-blocking domains (source-plan #23):** privacy, identity, attribution, delivery correctness, and deletion are release-blocking and covered by TEST-001…TEST-007, TEST-009, TEST-012.

---

## 14. Testable acceptance criteria

- **AC-1** In-process SQLite implementation passes TEST-001…TEST-012.
- **AC-2** PostgreSQL implementation passes the same suite with `fulltext_latin` advertised and `fulltext_cjk` advertised only when a CJK tokenizer is configured.
- **AC-3** Deterministic test fake passes the suite with `durable_events`, `alias_support`, `summaries`, `structured_memory`, `fulltext_latin`, `export`, `deletion` advertised and `vector_search`/`graph_search`/`remote_transport` absent.
- **AC-4** HTTP transport adapter passes the suite against a remote in-process server with identical DTOs.
- **AC-5** Capability negotiation: invoking any operation whose capability is unadvertised returns `UNSUPPORTED_CAPABILITY`.
- **AC-6** A production wiring test fails if a `NullMemoryClient` is substituted for the real port outside `@TestOnly`.
- **AC-7** Degraded mode: under induced repository failure, no user-facing output claims memory; spool depth is non-zero; on recovery the reconciler drains the spool and back-fills deliveries.
- **AC-8** Benchmark hooks record identity-continuity, attribution, temporal-update, abstention, privacy-leakage, deletion-completeness, concurrency, delivery-recovery, multilingual-retrieval, cost, and latency metrics (source-plan #21). Specific thresholds are hypotheses (RISK-J) and are not asserted as pass/fail until evaluated.

---

## 15. Non-goals

- Implementing production code (documentation/specification only).
- Selecting an embedding model or vector index without benchmark evidence (RISK-J).
- Procuring Discord gateway intents (operational, not contractual).
- Cross-platform human identity verification beyond `discord:user:<id>` (RISK-F).
- The emotion-aware speech pipeline (scope of `Plan.md`).
- Replacing AIRI's Alaya or AstrBot's history model upstream.

---

## 16. Dependencies on other artifacts

- **Depends on:** an identity-snapshot capture artifact (defines the actor snapshot fields sourced from Discord gateway events); a governance-policy artifact (defines retention windows, legal-basis vocabulary, operator privilege model).
- **Blocks:** a retrieval-ranking artifact (vector/graph promotion requires benchmarks gathered against this port); a prompt-serialization artifact (consumes `promptSafeSerial`); a delivery-reconciliation artifact (consumes the state machine in §11.3).
- **References:** `Plan.md` (emotion-aware speech; this artifact must not constrain its TTS pipeline) 【turn4fetch0】; `RUNBOOK.md` (process topology) 【turn5fetch0】.

---

## 17. Open questions

### Blocking

- **OQ-B1** Is the Message Content intent and the Server Members intent to be procured for DC_BOT? The current intent surface is Guilds + Guild Voice States only (E-03), which blocks text-event ingestion and authoritative alias/avatar observation (RISK-H).
- **OQ-B2** The `ConversationController.generateAndSpeak()` symbol referenced in `Plan.md` 【turn4fetch0†L31-L32】 was not located in the inspected `services/discord-bot/src` tree 【turn14fetch0】. Its exact file path in the checked-in AIRI subtree must be confirmed before the in-process MemoryPort is wired into the generation path.
- **OQ-B3** CJK tokenizer choice for PostgreSQL (`pg_jieba` vs `zhparser` vs trigram) and whether SQLite FTS5 trigram is acceptable for milestone 1 (RISK-M).
- **OQ-B4** Governance authority model: who is the operator, and what legal-basis vocabulary is required before `purge` can be enabled (RISK-I, source-plan #20)?

### Non-blocking

- **OQ-N1** Whether to adopt AIRI's server-sdk WebSocket module protocol 【turn0fetch0†turn40find1】 as the remote transport instead of plain HTTP, once a remote service is justified.
- **OQ-N2** Whether Alaya's time-decay/emotional-weighting proposal 【turn36fetch0†L188-L199】 becomes a retrieval rerank layer after benchmarking (RISK-J).
- **OQ-N3** Exact opaque-person-reference scheme (ULID vs sequence) — any monotonic, unprintable, non-mergeable scheme is acceptable.
- **OQ-N4** Whether `degraded_read_cache` is enabled by default or only on explicit configuration.
- **OQ-N5** AstrBot's `Conversation` schema (E-11, E-13) could not be verified against a source file on `master` 【turn0fetch0†L205-L206】; confirm whether `astrbot.core.conversation_mgr` exists on a release branch before citing its fields as fact.

---

## 18. Handoff instructions for downstream agents

1. **Identity-snapshot artifact** must define the exact actor-snapshot fields and the Discord gateway events that populate them, resolving OQ-B1/OQ-B2.
2. **Governance-policy artifact** must define operator privilege, retention windows, and legal-basis vocabulary, resolving OQ-B4.
3. **Retrieval-ranking artifact** must gather benchmarks for lexical vs vector vs graph before any capability beyond `fulltext_latin`/`fulltext_cjk` is advertised (RISK-J).
4. **Implementation agents** must implement the in-process SQLite `MemoryRepository` first, then the deterministic fake, then the PostgreSQL repository, then the optional HTTP adapter — in that order. No `NullMemoryClient` in production wiring (F-1).
5. **Test agents** must implement TEST-001…TEST-012 as the gating suite (AC-1…AC-7) plus the benchmark hooks (AC-8) without asserting pass/fail thresholds until evaluated.

---

## 19. What must be true before coding starts

- OQ-B1 resolved: the intent set (Message Content, Server Members) is procured or explicitly deferred with a documented degradation.
- OQ-B2 resolved: the exact generation-path symbol (`ConversationController` or successor) is located in the checked-in AIRI subtree, so the in-process port can be wired without guessing.
- OQ-B3 resolved: a CJK tokenizer decision is recorded, or `fulltext_cjk` is explicitly unadvertised for milestone 1.
- OQ-B4 resolved: operator privilege and legal-basis vocabulary exist, or `governDelete(action=purge)` is disabled by configuration.
- The 13-operation contract in §10.4 and the capability set in §10.3 are accepted unchanged, or changes are recorded as ADRs.
- The forbidden-`NullMemoryClient` rule (F-1) and the degraded-mode contract (§10.6) are accepted as release-blocking.

---

### Handoff summary

The next required artifacts are: (1) an **identity-snapshot capture spec** defining actor-snapshot fields and Discord gateway sources (resolves OQ-B1/OQ-B2); (2) a **governance-policy spec** defining operator privilege and legal-basis vocabulary (resolves OQ-B4); (3) a **retrieval-ranking benchmark plan** that must produce evidence before `vector_search`/`graph_search`/`fulltext_cjk` capabilities are advertised (resolves OQ-B3, RISK-J, RISK-M). Implementation may proceed in parallel against the in-process SQLite `MemoryRepository` and the deterministic fake using the §10.4 contract and §11.2 schema, provided OQ-B1 and OQ-B2 are resolved first. The decisions that must be confirmed before coding: ADR-001 (in-process first), ADR-003 (append-mostly + tombstones), ADR-004 (capability negotiation), and F-1 (no silent `NullMemoryClient`).
