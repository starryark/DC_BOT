# Persistence, Sequencing, Concurrency, and Idempotency

**Artifact filename:** `08-persistence-concurrency-spec.md`  
**Status:** Transactional specification for implementation review  
**Primary repository:** `starryark/DC_BOT`  
**Comparison repositories:** `moeru-ai/airi`, `AstrBotDevs/AstrBot`  
**Prepared:** 2026-08-02

## 1. Executive conclusion

**Recommendation.** Implement the first shared-memory milestone as a transport-neutral application/domain layer backed by one relational database, with **SQLite in WAL mode for a single-host/single-deployment profile** and **PostgreSQL for multi-process, multi-host, or sustained concurrent-writer deployments**. Do not require an HTTP memory microservice in milestone one. Keep the `MemoryPort` transaction contract independent of both database and transport so a standalone runtime can be introduced later without changing persistence semantics.

The event ledger is append-oriented. Each accepted durable event receives a monotonically increasing **room sequence** allocated inside the same database transaction that inserts the event. Sequence is deterministic database order, not proof of causality. Causality is represented separately by an explicit many-to-many `event_causes` relation, plus each assistant event's `context_snapshot_version`, generation timestamps, and context-eligibility state.

`expectedRoomVersion` is **not** a universal append precondition. It is appropriate for compare-and-swap updates to mutable state such as room bindings, alias preferences, configuration documents, and summary replacement. It is inappropriate for rejecting an append-only assistant result merely because a different event arrived during generation. That assistant event must instead be appended with the snapshot version it actually saw and an explicit eligibility classification such as `eligible`, `stale_but_valid`, `superseded`, or `ineligible`.

Discord delivery and database commit cannot be exactly atomic. Generation, persistence, delivery attempts, and delivery outcomes are separate durable records. Text delivery uses an idempotency key and reconciliation against the Discord message ID where available. Voice delivery is modeled as ordered drains/chunks with heard-state estimates; interruption or partial playback never upgrades the assistant event to a normal completed turn.

The specification requires: idempotent source keys; uniqueness constraints for Discord events and ASR finalizations; short database transactions; explicit retries; a transactional worker outbox; dead-letter handling; migration locking; deletion/redaction semantics; and engine-specific behavior tests. Privacy, identity attribution, delivery recovery, and forget completeness are release blockers.

## 2. Scope

This document specifies transactional behavior for:

- event sequence allocation;
- idempotent append and duplicate suppression;
- concurrent text and voice writers;
- context snapshots and causal visibility;
- optimistic concurrency for mutable records;
- assistant generation and Discord delivery lifecycle;
- worker outbox, retries, poison jobs, and recovery;
- schema migration;
- SQLite/PostgreSQL differences;
- required indexes, uniqueness constraints, and locks;
- pseudocode for all operations named in the specialist assignment.

It does not define ranking algorithms, prompt content, embedding models, final retention durations, user-facing privacy UX, or a mandatory network service boundary.

## 3. Sources inspected

### 3.1 Primary repository

- `starryark/DC_BOT`, branch `main`, repository page and README: https://github.com/starryark/DC_BOT
- `start-bot.ps1`: https://github.com/starryark/DC_BOT/blob/main/start-bot.ps1
- `Plan.md`: https://github.com/starryark/DC_BOT/blob/main/Plan.md
- Embedded AIRI tree used by DC_BOT: https://github.com/starryark/DC_BOT/tree/main/airi

**Repository-access limitation.** GitHub web pages were inspected. The GitHub API commit endpoint was not accessible through the available browser path, so a reliable commit SHA could not be established. This artifact therefore records branch `main` and retrieval date but does not invent a SHA.

### 3.2 Comparison repositories

- AIRI repository, branch shown as `main`: https://github.com/moeru-ai/airi
- AIRI memory architecture issue #387: https://github.com/moeru-ai/airi/issues/387
- AIRI Alaya proposal issue #879: https://github.com/moeru-ai/airi/issues/879
- AstrBot repository: https://github.com/AstrBotDevs/AstrBot
- AstrBot conversation manager developer wiki: https://github.com/AstrBotDevs/AstrBot/wiki/en-dev-star-guides-ai
- AstrBot issue showing `conversation.history` is JSON-decoded: https://github.com/AstrBotDevs/AstrBot/issues/5752

**Comparison limitation.** AIRI's repository README marks Memory Alaya as WIP and its relevant issues describe alternatives/proposals, not a verified complete production memory runtime. AstrBot demonstrates persisted conversation management and JSON history handling, but this review did not verify a concurrency-safe append ledger in AstrBot.

### 3.3 External primary documentation

- SQLite WAL: https://www.sqlite.org/wal.html
- SQLite transactions: https://www.sqlite.org/lang_transaction.html
- PostgreSQL transaction isolation: https://www.postgresql.org/docs/current/transaction-iso.html
- PostgreSQL explicit locking: https://www.postgresql.org/docs/current/explicit-locking.html
- PostgreSQL advisory locks: https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS
- PostgreSQL `SKIP LOCKED`: https://www.postgresql.org/docs/current/sql-select.html
- Discord Gateway events: https://docs.discord.com/developers/events/gateway-events
- Discord messages: https://docs.discord.com/developers/resources/message
- Discord voice connections: https://docs.discord.com/developers/topics/voice-connections

## 4. Evidence table

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| EVID-001 | DC_BOT currently implements a Discord voice pipeline under `airi/services/discord-bot`. | Confirmed repository fact | https://github.com/starryark/DC_BOT#discord-voice-bot | High |
| EVID-002 | Current DC_BOT voice behavior is half-duplex by default; finalized speech while busy is discarded, with optional `latest_wins` and `barge_in` policies. | Confirmed repository fact | https://github.com/starryark/DC_BOT#conversation-behavior | High |
| EVID-003 | Current voice transcript duplicate filtering includes same-user repetition inside `VOICE_DUPLICATE_WINDOW_MS`. | Confirmed repository fact | https://github.com/starryark/DC_BOT#conversation-behavior | High |
| EVID-004 | Current DC_BOT configuration exposes a retained per-server conversation message count. | Confirmed repository fact | https://github.com/starryark/DC_BOT#useful-configuration | High |
| EVID-005 | AIRI describes Memory Alaya as WIP. | Confirmed repository fact | https://github.com/moeru-ai/airi#current-progress--roadmap | High |
| EVID-006 | AIRI issue #387 explicitly compares an embedded/library approach with a Docker memory service and mentions SQLite/PostgreSQL-style deployment alternatives. | Confirmed proposal fact | https://github.com/moeru-ai/airi/issues/387 | High |
| EVID-007 | AIRI issue #879 proposes a `memory-alaya` abstraction layer; it is a proposal, not proof of completed production behavior. | Confirmed proposal fact | https://github.com/moeru-ai/airi/issues/879 | High |
| EVID-008 | AstrBot exposes a conversation manager API and conversation history to plugins. | Confirmed repository documentation fact | https://github.com/AstrBotDevs/AstrBot/wiki/en-dev-star-guides-ai | Medium-High |
| EVID-009 | AstrBot issue #5752 reports parsing `conversation.history` as JSON, supporting the conclusion that at least some history is represented as mutable serialized JSON. | Confirmed repository issue fact | https://github.com/AstrBotDevs/AstrBot/issues/5752 | Medium |
| EVID-010 | SQLite WAL allows readers and a writer concurrently, but only one writer at a time per database file. | External research finding | https://www.sqlite.org/wal.html | High |
| EVID-011 | SQLite `BEGIN IMMEDIATE` may fail with `SQLITE_BUSY` when another write transaction is active. | External research finding | https://www.sqlite.org/lang_transaction.html | High |
| EVID-012 | PostgreSQL `READ COMMITTED` gives each statement a new committed snapshot; `SERIALIZABLE` can abort a transaction with serialization failure and requires whole-transaction retry. | External research finding | https://www.postgresql.org/docs/current/transaction-iso.html | High |
| EVID-013 | PostgreSQL row locks and `FOR UPDATE` can serialize updates to selected rows. | External research finding | https://www.postgresql.org/docs/current/explicit-locking.html | High |
| EVID-014 | Discord Gateway receive events are delivered over a persistent Gateway connection; reconnect/resume behavior means applications must tolerate repeated processing. | External research finding | https://docs.discord.com/developers/events/gateway-events | High |
| EVID-015 | Discord text message creation returns a message object containing a durable message ID usable as a delivery receipt. | External research finding | https://docs.discord.com/developers/resources/message | High |
| EVID-016 | Discord voice uses a separate voice connection and UDP media path, so database and audible playback cannot be one atomic transaction. | External research finding | https://docs.discord.com/developers/topics/voice-connections | High |
| EVID-017 | A room snapshot version is evidence of what generation saw, not a reason to reject unrelated append-only events. | Source-plan requirement / inference | User-provided source plan | High |
| EVID-018 | A single `user_event_id` on an exchange cannot represent a response triggered by multiple speakers. | Source-plan requirement | User-provided source plan | High |

## 5. Current-state findings

### 5.1 DC_BOT

**Confirmed repository fact.** DC_BOT's README describes a working local voice path: Discord voice → Qwen3-ASR → Gemini → GPT-SoVITS → Discord voice. It currently serializes conversational activity at the bot-policy layer: half-duplex is the default; busy-state finalized speech can be discarded; and a turn is not considered complete until its final audio chunk has played. See https://github.com/starryark/DC_BOT#conversation-behavior.

**Inference.** This policy reduces concurrency inside the existing voice loop but does not solve shared persistence once text, voice, background summarizers, forget processing, and multiple processes write concurrently. The persistence model must therefore be correct independently of half-duplex behavior.

**Confirmed repository fact.** Current duplicate handling is content/time-window filtering for voice transcripts, not a durable idempotency protocol. A repeated transcript inside `VOICE_DUPLICATE_WINDOW_MS` can be dropped, but a restart or duplicate ASR callback requires a stable source/finalization key to prevent duplicate durable events.

### 5.2 AIRI

**Confirmed repository fact.** AIRI's README marks Memory Alaya as WIP. Issues #387 and #879 discuss alternative architectures and an abstraction layer. These are valuable design inputs but do not establish a completed, audited transaction model.

**Recommendation.** Reuse the architectural lesson—clean memory abstraction and deployment flexibility—not unverified assumptions about upstream completion.

### 5.3 AstrBot

**Confirmed repository documentation fact.** AstrBot provides persisted conversation management APIs. An issue demonstrates JSON decoding of `conversation.history`.

**Inference.** Mutable whole-history JSON is a useful product baseline but is not an appropriate concurrency primitive for DC_BOT's shared event ledger: independent writers can overwrite one another unless the entire document is protected by compare-and-swap or row locks, and deletion/provenance are coarse.

## 6. Proposed decisions

### ADR-008-001 — Storage architecture

**Decision.** Define a transport-neutral `MemoryPort` implemented by a relational persistence module in-process for milestone one. Support:

1. **SQLite profile:** one machine, local filesystem, bounded write volume, WAL mode, one application-managed write queue or disciplined short transactions.
2. **PostgreSQL profile:** multiple worker processes, multiple bot instances, multi-host access, or higher concurrent write pressure.

A standalone service is optional later and must expose the same transaction semantics.

### ADR-008-002 — Append ledger plus mutable projections

**Decision.** Store attributable conversational facts as append-oriented rows. Store mutable configuration/current-state projections separately with version columns. Lifecycle changes are represented either as append-only state-transition rows or as tightly controlled mutable projection fields whose audit history is append-only.

### ADR-008-003 — Room sequence and room version

**Decision.** Each room has a `next_sequence` counter. In one transaction, the writer locks/claims the room counter, increments it, and inserts the event using the allocated value. `room_version` is the highest committed room sequence visible after that transaction.

`room_sequence` answers “what committed first in this room?” It does not answer “what caused what?”

### ADR-008-004 — Explicit causality

**Decision.** Use `event_causes(assistant_event_id, triggering_event_id, ordinal, contribution_kind)`. One assistant event may have zero, one, or many triggers; one user event may contribute to multiple assistant events.

### ADR-008-005 — `expectedRoomVersion`

**Decision.** Replace the ambiguous universal parameter with operation-specific expected versions:

- `expected_binding_version`
- `expected_alias_version`
- `expected_config_version`
- `expected_summary_base_version` and/or `expected_summary_record_version`

An API may still expose a generic `expectedVersion` wrapper, but the persisted invariant is per mutable aggregate. Ordinary event append never fails solely because the room advanced after generation began.

### ADR-008-006 — Delivery separation

**Decision.** Persist assistant content before or independently of delivery. Persist every delivery attempt and outcome. Do not mark an assistant event `completed` merely because generation completed.

### ADR-008-007 — Transactional outbox

**Decision.** Every asynchronous derivative operation—summary, extraction, embedding, deletion propagation, cache invalidation—is enqueued in the same transaction as the state change that requires it.

### ADR-008-008 — Isolation policy

**Decision.** Use the weakest isolation that preserves each invariant, plus explicit row/CAS constraints:

- append operations: `READ COMMITTED` in PostgreSQL with row lock on room counter; `BEGIN IMMEDIATE` in SQLite;
- mutable CAS updates: `READ COMMITTED` + `WHERE version = expected`, or `SERIALIZABLE` for multi-row invariants;
- forget processing and room-binding swaps: `SERIALIZABLE` in PostgreSQL or explicit locked critical section; `BEGIN IMMEDIATE` in SQLite;
- read-only context assembly: PostgreSQL `REPEATABLE READ READ ONLY` when one stable multi-query snapshot is required; SQLite read transaction in WAL mode.

## 7. Alternatives considered

### 7.1 Mandatory HTTP memory service

**Alternative.** Put all storage behind a standalone service immediately.

**Reason not chosen.** DC_BOT currently runs a local multi-process voice stack, but verified repository evidence does not show a deployment requirement that forces a network boundary. A service adds deployment, authentication, availability, retry, and versioning complexity without changing database atomicity with Discord.

### 7.2 Mutable conversation JSON per room

**Alternative.** Store the entire room history as one JSON field and rewrite it on every turn.

**Reason not chosen.** It creates a hot row/document, increases write amplification, makes provenance and partial deletion difficult, and requires coarse conflict control. AstrBot is useful as a product baseline but does not establish that whole-history JSON is safe for this workload.

### 7.3 Global event sequence only

**Alternative.** Allocate one global sequence across all rooms.

**Reason not chosen.** It creates unnecessary contention and leaks cross-tenant activity ordering. Room-local sequence is sufficient for context ordering; globally unique event IDs provide identity.

### 7.4 `MAX(sequence)+1`

**Alternative.** Compute the next room sequence from the event table.

**Reason not chosen.** Concurrent writers can allocate the same value unless the range is locked; scanning/index lookup is unnecessary. A room counter row is explicit and portable.

### 7.5 Reject assistant append when room version changed

**Alternative.** Generation starts at version N and append requires the room still be N.

**Reason not chosen.** It converts harmless concurrent arrival into lost output and retry storms. The generated output may remain valid. Staleness is a policy classification, not a storage conflict.

### 7.6 Exactly-once Discord delivery

**Alternative.** Treat database commit and Discord send/playback as exactly atomic.

**Reason not chosen.** No distributed transaction exists across the relational database and Discord APIs/UDP playback. The implementable guarantee is at-least-once attempt with idempotent reconciliation and explicit uncertainty.

## 8. Normative data model

The SQL below is conceptual and must be adapted to engine types. UUIDv7/ULID-style IDs are recommended for sortable opaque identifiers, but correctness must not depend on timestamp ordering inside IDs.

### 8.1 Rooms and counters

```sql
CREATE TABLE rooms (
  room_id                 TEXT PRIMARY KEY,
  isolation_scope_id      TEXT NOT NULL,
  room_kind               TEXT NOT NULL,
  next_sequence           BIGINT NOT NULL DEFAULT 1,
  current_version         BIGINT NOT NULL DEFAULT 0,
  created_at              TIMESTAMP NOT NULL,
  CHECK (next_sequence = current_version + 1)
);
```

**REQ-EVENT-801.** `current_version` MUST equal the highest committed `room_sequence` for ordinary event appends. Administrative redaction must not reuse sequence values.

### 8.2 Events

```sql
CREATE TABLE events (
  event_id                    TEXT PRIMARY KEY,
  room_id                     TEXT NOT NULL REFERENCES rooms(room_id),
  room_sequence               BIGINT NOT NULL,
  event_kind                  TEXT NOT NULL,
  author_person_id            TEXT NULL,
  author_platform_identity_id TEXT NULL,
  actor_snapshot_json         TEXT NULL,
  content_json                TEXT NOT NULL,
  source_system               TEXT NOT NULL,
  source_event_key            TEXT NULL,
  occurred_at                 TIMESTAMP NOT NULL,
  received_at                 TIMESTAMP NOT NULL,
  committed_at                TIMESTAMP NOT NULL,
  redaction_state             TEXT NOT NULL DEFAULT 'active',
  context_eligibility         TEXT NOT NULL DEFAULT 'eligible',
  UNIQUE (room_id, room_sequence),
  UNIQUE (source_system, source_event_key)
);
```

`source_event_key` is nullable only for internally generated events that have a separate idempotency key. Null uniqueness behavior differs by engine; do not rely on it for internal events.

### 8.3 Assistant generation metadata

```sql
CREATE TABLE assistant_generations (
  assistant_event_id          TEXT PRIMARY KEY REFERENCES events(event_id),
  generation_id               TEXT NOT NULL UNIQUE,
  generation_idempotency_key  TEXT NOT NULL UNIQUE,
  context_snapshot_version    BIGINT NOT NULL,
  generation_started_at       TIMESTAMP NOT NULL,
  generation_completed_at     TIMESTAMP NULL,
  generation_status           TEXT NOT NULL,
  model_provider              TEXT NULL,
  model_name                  TEXT NULL,
  context_eligibility         TEXT NOT NULL,
  eligibility_reason          TEXT NULL,
  failure_code                TEXT NULL
);
```

Allowed `generation_status`: `drafting`, `generated`, `failed`, `cancelled`, `superseded`.

Allowed `context_eligibility`: `eligible`, `stale_but_valid`, `superseded`, `ineligible`, `unknown_pending_review`.

### 8.4 Causal edges

```sql
CREATE TABLE event_causes (
  assistant_event_id  TEXT NOT NULL REFERENCES events(event_id),
  triggering_event_id TEXT NOT NULL REFERENCES events(event_id),
  ordinal             INTEGER NOT NULL,
  contribution_kind   TEXT NOT NULL DEFAULT 'direct',
  PRIMARY KEY (assistant_event_id, triggering_event_id),
  UNIQUE (assistant_event_id, ordinal)
);
```

### 8.5 Delivery attempts

```sql
CREATE TABLE delivery_attempts (
  delivery_attempt_id     TEXT PRIMARY KEY,
  assistant_event_id      TEXT NOT NULL REFERENCES events(event_id),
  medium                  TEXT NOT NULL,
  destination_key         TEXT NOT NULL,
  attempt_no              INTEGER NOT NULL,
  idempotency_key         TEXT NOT NULL,
  started_at              TIMESTAMP NOT NULL,
  completed_at            TIMESTAMP NULL,
  result                   TEXT NOT NULL,
  external_message_id     TEXT NULL,
  bytes_or_frames_planned BIGINT NULL,
  bytes_or_frames_sent    BIGINT NULL,
  audible_started_at      TIMESTAMP NULL,
  audible_ended_at        TIMESTAMP NULL,
  interruption_reason     TEXT NULL,
  error_code              TEXT NULL,
  error_detail_redacted   TEXT NULL,
  UNIQUE (assistant_event_id, medium, destination_key, attempt_no),
  UNIQUE (idempotency_key)
);
```

Allowed `result`: `pending`, `sent`, `confirmed`, `failed_retryable`, `failed_terminal`, `uncertain`, `partial`, `interrupted`, `cancelled`, `unheard`.

### 8.6 Voice drains

```sql
CREATE TABLE voice_drains (
  delivery_attempt_id TEXT NOT NULL REFERENCES delivery_attempts(delivery_attempt_id),
  chunk_ordinal       INTEGER NOT NULL,
  chunk_hash          TEXT NOT NULL,
  planned_duration_ms INTEGER NOT NULL,
  drain_started_at    TIMESTAMP NULL,
  drain_completed_at  TIMESTAMP NULL,
  result              TEXT NOT NULL,
  PRIMARY KEY (delivery_attempt_id, chunk_ordinal)
);
```

### 8.7 Mutable versioned records

```sql
CREATE TABLE alias_preferences (
  alias_preference_id TEXT PRIMARY KEY,
  person_id           TEXT NOT NULL,
  scope_type          TEXT NOT NULL,
  scope_id            TEXT NOT NULL,
  preferred_alias     TEXT NOT NULL,
  version             BIGINT NOT NULL,
  valid_from          TIMESTAMP NOT NULL,
  valid_to            TIMESTAMP NULL,
  superseded_by_id    TEXT NULL,
  UNIQUE (person_id, scope_type, scope_id, version)
);

CREATE UNIQUE INDEX uq_alias_current
ON alias_preferences(person_id, scope_type, scope_id)
WHERE valid_to IS NULL;
```

SQLite supports partial indexes; PostgreSQL does as well. Equivalent constraints may be implemented with a generated current flag if an ORM cannot express partial indexes.

```sql
CREATE TABLE room_bindings (
  binding_id           TEXT PRIMARY KEY,
  physical_channel_key TEXT NOT NULL,
  logical_room_id      TEXT NOT NULL REFERENCES rooms(room_id),
  version              BIGINT NOT NULL,
  valid_from           TIMESTAMP NOT NULL,
  valid_to             TIMESTAMP NULL,
  superseded_by_id     TEXT NULL
);

CREATE UNIQUE INDEX uq_binding_current
ON room_bindings(physical_channel_key)
WHERE valid_to IS NULL;
```

### 8.8 Summaries

```sql
CREATE TABLE summaries (
  summary_id              TEXT PRIMARY KEY,
  room_id                 TEXT NOT NULL REFERENCES rooms(room_id),
  summary_kind            TEXT NOT NULL,
  coverage_start_sequence BIGINT NOT NULL,
  coverage_end_sequence   BIGINT NOT NULL,
  based_on_room_version   BIGINT NOT NULL,
  summary_text            TEXT NOT NULL,
  content_hash            TEXT NOT NULL,
  record_version          BIGINT NOT NULL,
  status                  TEXT NOT NULL,
  replaced_by_id          TEXT NULL,
  created_at              TIMESTAMP NOT NULL,
  UNIQUE (room_id, summary_kind, coverage_start_sequence, coverage_end_sequence, record_version)
);
```

Only one `status='active'` summary may occupy the same summary slot. Implement with a partial unique index on the slot or a separate `summary_heads` table.

### 8.9 Semantic memories and supersession

```sql
CREATE TABLE semantic_memories (
  memory_id             TEXT PRIMARY KEY,
  person_id             TEXT NULL,
  scope_type            TEXT NOT NULL,
  scope_id              TEXT NOT NULL,
  predicate_key         TEXT NOT NULL,
  value_json            TEXT NOT NULL,
  confidence            REAL NOT NULL,
  valid_from            TIMESTAMP NULL,
  valid_to              TIMESTAMP NULL,
  status                TEXT NOT NULL,
  superseded_by_id      TEXT NULL,
  created_at            TIMESTAMP NOT NULL
);

CREATE TABLE memory_provenance (
  memory_id       TEXT NOT NULL REFERENCES semantic_memories(memory_id),
  source_event_id TEXT NOT NULL REFERENCES events(event_id),
  role            TEXT NOT NULL,
  PRIMARY KEY (memory_id, source_event_id, role)
);
```

### 8.10 Worker outbox

```sql
CREATE TABLE worker_jobs (
  job_id               TEXT PRIMARY KEY,
  job_type             TEXT NOT NULL,
  dedupe_key           TEXT NOT NULL,
  payload_json         TEXT NOT NULL,
  status               TEXT NOT NULL,
  priority             INTEGER NOT NULL DEFAULT 0,
  available_at         TIMESTAMP NOT NULL,
  lease_owner          TEXT NULL,
  lease_expires_at     TIMESTAMP NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  max_attempts         INTEGER NOT NULL,
  last_error_code      TEXT NULL,
  last_error_redacted  TEXT NULL,
  created_at           TIMESTAMP NOT NULL,
  completed_at         TIMESTAMP NULL,
  UNIQUE (job_type, dedupe_key)
);
```

Allowed status: `ready`, `leased`, `succeeded`, `dead_letter`, `cancelled`.

### 8.11 Forget requests

```sql
CREATE TABLE forget_requests (
  forget_request_id TEXT PRIMARY KEY,
  subject_type      TEXT NOT NULL,
  subject_id        TEXT NOT NULL,
  scope_json        TEXT NOT NULL,
  requested_at      TIMESTAMP NOT NULL,
  status            TEXT NOT NULL,
  version           BIGINT NOT NULL,
  completed_at      TIMESTAMP NULL,
  verification_json TEXT NULL,
  UNIQUE (subject_type, subject_id, forget_request_id)
);
```

## 9. Normative transactional requirements

### 9.1 Event sequence allocation

**REQ-EVENT-802.** Allocation and event insert MUST occur in one transaction.

**REQ-EVENT-803.** Sequence values MUST NOT be allocated by reading `MAX(room_sequence)` without a lock.

**REQ-EVENT-804.** Rollback may leave no externally visible sequence. Gaps are permitted only if the chosen engine's allocation mechanism inherently creates them; consumers MUST NOT require gaplessness. The recommended room-counter method is gapless for committed events but tests must not depend on it.

**PostgreSQL algorithm.** `SELECT ... FOR UPDATE` the room row, read `next_sequence`, update counter/version, insert event, commit.

**SQLite algorithm.** `BEGIN IMMEDIATE`; read/update room counter; insert event; commit. Busy errors are retried with bounded jitter.

### 9.2 Idempotent append

**REQ-EVENT-805.** Every ingress adapter MUST compute a stable `source_event_key` before append.

Examples:

- Discord message: `discord:message:<message_id>`.
- Discord interaction: `discord:interaction:<interaction_id>`.
- Voice utterance capture: `discord:voice:<guild_id>:<voice_session_id>:<speaker_user_id>:<utterance_id>`.
- ASR final: `asr-final:<utterance_id>:<finalization_revision_or_hash>`.
- Internal generation: `assistant-generation:<generation_idempotency_key>`.

**REQ-EVENT-806.** Duplicate append MUST return the existing event ID and sequence when the key and canonical payload hash match.

**REQ-EVENT-807.** If the same idempotency key is reused with a different canonical payload hash, the operation MUST fail with `IDEMPOTENCY_KEY_REUSE_MISMATCH`; it MUST NOT silently overwrite.

### 9.3 Duplicate Discord events

Discord reconnect/resume and application retries can cause repeated processing. The durable uniqueness key is the platform object ID, not receipt time. For message edits, use a distinct event key including edit version or observed edit timestamp, and append an edit event rather than mutate the original raw snapshot.

### 9.4 Duplicate ASR finalization

ASR may emit more than one “final” callback or a caller may retry after timeout.

**REQ-EVENT-808.** The voice ingress layer MUST create one durable `utterance_id` before calling ASR.

**REQ-EVENT-809.** ASR finalization MUST be unique on `(utterance_id, finalization_revision)` or, when the engine lacks revisions, `(utterance_id, normalized_transcript_hash, model_run_id)`.

**REQ-EVENT-810.** Repeated identical finalization returns the same transcript event. A corrected finalization is a new revision linked by `supersedes_event_id`; it does not mutate the first transcript event.

### 9.5 Multiple writers and simultaneous text/voice turns

**REQ-EVENT-811.** Text and voice adapters may append concurrently. The database decides deterministic commit order through room sequence allocation.

**REQ-EVENT-812.** No writer may hold the room counter lock while performing network I/O, ASR, LLM generation, TTS, or Discord delivery.

**REQ-EVENT-813.** A voice policy such as half-duplex may reject input before durable append only when product policy explicitly defines that input as not accepted. Once accepted/finalized for memory, it must use the same append transaction as text.

### 9.6 Context snapshot versions

A context snapshot consists of:

- `room_id`;
- `snapshot_version` = highest room sequence included/visible;
- selected event IDs and summary IDs;
- applicable person-memory IDs;
- configuration/alias/binding versions used;
- authorization scope;
- serializer version and prompt hash.

**REQ-MEM-801.** Generation MUST record `context_snapshot_version` even when the exact selected event IDs are also recorded.

**REQ-MEM-802.** Context assembly requiring several queries MUST use one consistent database snapshot.

**REQ-MEM-803.** An event committed after snapshot N is not causally visible to that generation unless explicitly injected through a later mechanism.

### 9.7 Causal visibility

Sequence gives a total order of commits per room. Causal visibility is explicit:

- a triggering event is causally visible if it is in `event_causes` and was present in the generation context;
- other events with sequence `<= snapshot_version` may be context-visible but not direct triggers;
- events with sequence `> snapshot_version` were not visible;
- an event with lower sequence can still be unrelated to the generation.

**REQ-EVENT-814.** APIs MUST NOT infer direct causality solely from adjacent sequence numbers.

### 9.8 Append conflicts

Ordinary append conflicts are limited to:

- duplicate source/idempotency key;
- invalid room/isolation scope;
- authorization failure;
- room deleted/frozen;
- sequence counter contention or transient database failure;
- schema/invariant violation.

A changed room version is not an append conflict.

### 9.9 Mutable configuration conflicts

Mutable configuration uses compare-and-swap:

```sql
UPDATE configuration_heads
SET document_json = :new_doc,
    version = version + 1,
    updated_at = :now
WHERE config_key = :key
  AND version = :expected_version;
```

Zero rows means `VERSION_CONFLICT`; return current version and a redacted diff basis.

### 9.10 Alias preference conflicts

Alias corrections are scoped and versioned. Two operators/users editing the same `(person, scope_type, scope_id)` from the same base version conflict. The loser must re-read and decide; last-write-wins is prohibited for privacy-sensitive alias scopes.

### 9.11 Room-binding conflicts

Room bindings affect authorization and history crossover. Update under serializable/CAS protection. A physical channel may have at most one current logical-room binding unless an explicit multi-binding mode is later specified.

### 9.12 Summary replacement

Summary generation may run concurrently with new events. A summary covers an explicit sequence interval and records `based_on_room_version`.

A summary may be committed after the room advances if its declared coverage remains valid. Replacement conflicts only with another writer replacing the same summary head or when source events in its coverage were redacted/corrected after generation.

`expectedRoomVersion` must not require the entire room to remain unchanged. Use:

- expected current summary head/version;
- expected coverage end sequence;
- source-set/content hash;
- redaction epoch or source validity epoch.

### 9.13 Worker outbox

Jobs are inserted in the same transaction as the event/configuration change that necessitates them. A worker claims with a lease. Handlers are idempotent on `dedupe_key` and output uniqueness constraints.

### 9.14 Retry semantics

Retry the whole transaction for:

- PostgreSQL serialization failure/deadlock;
- SQLite `BUSY`/`LOCKED` under the bounded policy;
- transient connection loss where commit is known not to have occurred.

When commit outcome is uncertain, reissue using the same idempotency key; never generate a new key.

Use exponential backoff with full jitter, bounded attempts for synchronous calls, and durable scheduling for background jobs. Do not retry validation, authorization, idempotency mismatch, or terminal Discord permission errors.

### 9.15 Poison jobs

A job becomes dead-letter when:

- `attempt_count >= max_attempts`;
- error is classified terminal;
- payload validation fails;
- repeated deterministic handler failure occurs.

Dead-letter records retain redacted error metadata and correlation IDs. They must not contain raw private prompt/memory content unless explicitly required and access controlled.

### 9.16 Crash recovery

At startup and periodically:

1. reclaim expired job leases;
2. find assistant generations stuck in `drafting` beyond timeout and mark `failed` or `cancelled` after checking provider state where possible;
3. find delivery attempts in `pending` or `uncertain` beyond timeout;
4. reconcile text sends using stored Discord message IDs or application nonce/idempotency metadata where supported;
5. never assume voice was heard after process death; mark `uncertain`, `partial`, or `interrupted` based on drain records;
6. ensure derived jobs exist for committed source changes using outbox uniqueness checks.

### 9.17 Schema migration

**REQ-OPS-801.** Every migration has a unique ordered ID and checksum.

**REQ-OPS-802.** Only one migrator may apply schema changes.

- PostgreSQL: transaction-level advisory lock keyed to application/schema, then migration transaction where supported.
- SQLite: exclusive deployment migration phase; acquire `BEGIN EXCLUSIVE` or process lock before migration; no live multi-process migration.

**REQ-OPS-803.** Expand/contract changes must be used for rolling PostgreSQL deployments: add nullable columns/tables, deploy dual-read/write where required, backfill, validate, then remove old structures in a later release.

**REQ-OPS-804.** Destructive migrations require backup verification and rollback/restore instructions.

## 10. Assistant event lifecycle

Each assistant event MUST record:

| Field | Requirement |
|---|---|
| Triggering event IDs | Many-to-many rows in `event_causes`; preserve ordinal and contribution kind. |
| Context snapshot version | Highest room sequence visible to generation; not a write precondition. |
| Generation start time | Set before provider call, persisted in draft transaction. |
| Generation completion time | Set when final generated content is durably stored. |
| Delivery attempt | One or more durable `delivery_attempts`; attempts are never overwritten. |
| Delivery result | Explicit result with external receipt or uncertainty. |
| Context eligibility | Persisted on generation/event and recomputable after corrections/forget. |

Recommended high-level states:

```text
DRAFTING
  -> GENERATED
  -> FAILED | CANCELLED

GENERATED
  -> DELIVERY_PENDING
  -> SUPERSEDED

DELIVERY_PENDING
  -> DELIVERED_CONFIRMED
  -> DELIVERED_PARTIAL
  -> DELIVERY_UNCERTAIN
  -> DELIVERY_FAILED
  -> INTERRUPTED
```

Generation state and delivery state are orthogonal in storage even if an API exposes a composite state.

## 11. Transaction pseudocode

### 11.1 Append user event

```text
function appendUserEvent(input):
  validate authorization, identity, room, payload
  key = stableSourceEventKey(input)
  hash = canonicalPayloadHash(input)

  retry transient transaction failures:
    beginWriteTransaction()

    existing = select event by (source_system, source_event_key)
    if existing:
      if existing.payload_hash != hash:
        rollback
        raise IDEMPOTENCY_KEY_REUSE_MISMATCH
      commit/rollback read transaction
      return existing

    room = lock room counter row(input.room_id)
    assert room is active and authorized
    seq = room.next_sequence

    insert event(event_id, room_id, seq, kind='user', actor snapshot,
                 content, source key, timestamps, payload_hash)
    update rooms
      set current_version = seq, next_sequence = seq + 1
      where room_id = input.room_id

    insert worker jobs required by policy using unique dedupe keys
    commit
    return event
```

**PostgreSQL:** `READ COMMITTED`, `SELECT ... FOR UPDATE` on room row.  
**SQLite:** `BEGIN IMMEDIATE`.

### 11.2 Create assistant draft

```text
function createAssistantDraft(roomId, triggerEventIds, generationKey):
  context = buildAuthorizedContextInConsistentReadSnapshot(roomId)
  validate every trigger is visible and authorized

  beginWriteTransaction()
  existing = select generation by generation_idempotency_key
  if existing: return existing

  draftEventId = newOpaqueId()
  insert assistant event shell or assistant_drafts row
  insert assistant_generations(
      generation_status='drafting',
      context_snapshot_version=context.roomVersion,
      generation_started_at=now,
      context_eligibility='eligible')
  insert event_causes for all triggerEventIds in deterministic ordinal order
  persist context manifest/hash and used alias/config/binding versions
  commit

  perform LLM call outside transaction

  beginWriteTransaction()
  lock generation row
  if status is cancelled/superseded:
      record provider completion metadata if needed; do not revive
      commit; return
  store generated content
  set generation_status='generated', generation_completed_at=now
  classify staleness against current room/config state without rejecting append
  enqueue delivery job transactionally
  commit
```

If assistant content itself is represented in the main event ledger only after completion, allocate its room sequence in the completion transaction. If a durable draft event is required, allocate at draft creation and append later state transitions; do not mutate raw content provenance silently. The implementation must choose one convention and test it. This specification recommends **allocate the conversational assistant event sequence when generated content becomes durable**, while keeping `assistant_drafts` outside the room event order.

### 11.3 Record text delivery

```text
function deliverText(assistantEventId, destination):
  begin transaction
  attempt = getOrCreateAttempt(
      idempotencyKey = hash(assistantEventId, 'text', destination),
      result='pending')
  commit

  if attempt.external_message_id exists and result confirmed:
      return attempt

  try:
      response = discordCreateMessage(destination, content,
                   applicationNonce=attempt.idempotency_key where supported)
  catch definiteNoSend retryable:
      mark failed_retryable; enqueue retry; return
  catch outcomeUnknown:
      mark uncertain; enqueue reconciliation; return
  catch terminal:
      mark failed_terminal; return

  begin transaction
  update attempt set result='confirmed',
      external_message_id=response.id,
      completed_at=now
  commit
```

Never hold a transaction during the Discord HTTP request.

### 11.4 Record voice drain

```text
function recordVoiceDrain(attemptId, chunkOrdinal, observed):
  begin transaction
  insert voice_drains row if absent
  update row only from pending -> draining -> completed using state guard
  update aggregate sent frames/durations on delivery attempt
  if all planned chunks completed:
      set attempt.result='confirmed', audible_ended_at=now
  commit
```

A drain completion means frames were handed to/played by the local voice pipeline according to the adapter. It is not cryptographic proof every listener heard them.

### 11.5 Record partial/interrupted voice delivery

```text
function interruptVoice(attemptId, reason, lastCompletedChunk, framesSent):
  begin transaction
  lock attempt
  if attempt already terminal: return existing
  mark remaining chunks cancelled/not_drained
  set result = ('partial' if framesSent > 0 else 'interrupted')
  set interruption_reason, bytes_or_frames_sent, completed_at
  update assistant context eligibility for future context:
      delivered_text_context = false unless policy explicitly allows partial transcript
  enqueue optional recovery/repair job
  commit
```

The generated assistant event remains durable, but default recent-context retrieval excludes it as a normal completed assistant turn. A separate operator/audit view can include it.

### 11.6 Append a multi-speaker response

```text
function appendMultiSpeakerAssistantResponse(roomId, triggerIds, generation):
  assert triggerIds.length >= 2
  assert each trigger event belongs to authorized causal scope

  begin write transaction
  idempotency check generation key
  lock room counter
  allocate one assistant event sequence
  insert assistant event with author=character/bot
  insert assistant generation metadata
  for each triggerId in deterministic order:
      insert event_causes(assistantEventId, triggerId, ordinal, 'direct')
  enqueue delivery
  commit
```

No synthetic “Discord group” person is created. Each triggering user event retains its own author identity and actor snapshot.

### 11.7 Correct an alias

```text
function correctAlias(person, scope, newAlias, expectedAliasVersion, actor):
  validate actor may edit this scope
  validate alias presentation and privacy rules

  begin serializable-or-CAS transaction
  current = select current alias head for update
  if current.version != expectedAliasVersion:
      rollback; raise VERSION_CONFLICT(current.version)

  insert new alias row version=current.version+1, valid_from=now
  update old row set valid_to=now, superseded_by_id=new.id
      where id=current.id and valid_to is null
  append alias_audit event with actor/reason, excluding unnecessary private data
  enqueue cache invalidation
  commit
```

Historical events keep their actor snapshots; they are not rewritten to the new alias.

### 11.8 Supersede a semantic memory

```text
function supersedeSemanticMemory(oldMemoryId, replacement, evidenceIds):
  begin transaction
  old = select memory for update
  assert old.status='active'
  validate scope and evidence authorization
  insert replacement memory with status='active'
  insert provenance rows
  update old set status='superseded', valid_to=now,
      superseded_by_id=replacement.id
  enqueue index/embedding deletion for old and creation for replacement
  commit
```

The update is idempotent using a correction request key. If old is already superseded by the same replacement, return success; if by another replacement, raise conflict.

### 11.9 Process a forget request

```text
function processForgetRequest(requestId):
  begin serializable transaction
  request = lock request
  if completed: return verification
  set status='processing', version=version+1

  resolve all in-scope rows via identity/scope graph
  apply deletion policy:
    - hard delete content where legally/product required and safe
    - retain minimal tombstone/idempotency hash where allowed
    - redact payload while preserving non-identifying sequence shell where needed
    - invalidate summaries and semantic memories derived from deleted sources
  insert deletion ledger entries without copying deleted content
  enqueue derivative deletion jobs with unique dedupe keys
  set request status='pending_derivatives'
  commit

  workers delete embeddings/caches/backups per policy

  finalizer transaction:
    verify no active primary/derived rows remain in requested scope
    record counts/checks, not deleted content
    set status='completed', completed_at=now
```

A request is not complete merely because primary rows were redacted. Summary, embedding, cache, export, and backup handling must match the retention artifact.

### 11.10 Create or replace a summary

```text
function replaceSummary(input, expectedHeadVersion):
  generate summary outside write transaction from a consistent context snapshot
  sourceHash = hash(ordered source event IDs + source content versions/redaction epoch)

  begin transaction
  head = lock summary head for slot
  if head.version != expectedHeadVersion:
      rollback; raise VERSION_CONFLICT

  revalidate sourceHash and coverage validity
  if invalid: rollback; raise SOURCE_CHANGED

  insert new summary record with based_on_room_version=input.snapshotVersion
  mark old summary replaced
  advance summary head version
  enqueue downstream index update
  commit
```

New events after `coverage_end_sequence` do not invalidate the summary. Source correction/redaction inside coverage does.

### 11.11 Claim, retry, and dead-letter a worker job

**PostgreSQL claim:**

```text
begin
job = select * from worker_jobs
      where status='ready' and available_at <= now
      order by priority desc, available_at, job_id
      for update skip locked
      limit 1
if none: commit; return none
update job set status='leased', lease_owner=worker,
  lease_expires_at=now+lease, attempt_count=attempt_count+1
commit
return job
```

**SQLite claim:**

```text
BEGIN IMMEDIATE
job = select first ready job by deterministic order
conditional update where job_id=? and status='ready'
COMMIT
```

SQLite workers contend on the single writer; keep the claim transaction extremely short.

**Completion/retry:**

```text
handle outside transaction

begin transaction
lock job
if lease_owner != worker or lease expired and reclaimed:
    abort stale completion
if success:
    set status='succeeded', completed_at=now, clear lease
else if terminal or attempt_count >= max_attempts:
    set status='dead_letter', clear lease, store redacted error
else:
    set status='ready', available_at=backoff(attempt_count), clear lease
commit
```

## 12. Isolation-level analysis

| Operation | PostgreSQL | SQLite | Reason |
|---|---|---|---|
| Append event | `READ COMMITTED` + room row `FOR UPDATE` | `BEGIN IMMEDIATE` | One locked counter row preserves sequence uniqueness. |
| Idempotency lookup+insert | Same append transaction + unique index | Same | Unique constraint is final arbiter. |
| Context read | `REPEATABLE READ READ ONLY` when multi-query consistency needed | Explicit read transaction in WAL | Stable snapshot across events, summaries, aliases. |
| Alias update | `READ COMMITTED` CAS or `SERIALIZABLE` for cross-row invariants | `BEGIN IMMEDIATE` + CAS | Prevent lost update/current-head duplication. |
| Room binding | Prefer `SERIALIZABLE`; retry | `BEGIN IMMEDIATE`, global writer serialization | Authorization/history routing invariant. |
| Summary replacement | `READ COMMITTED` + locked head + source hash | `BEGIN IMMEDIATE` | Room may advance; only head/source validity must remain stable. |
| Forget request | `SERIALIZABLE` for primary selection/update; durable derivative jobs | `BEGIN IMMEDIATE`, chunk large work | Cross-table completeness. |
| Worker claim | `READ COMMITTED`, `FOR UPDATE SKIP LOCKED` | `BEGIN IMMEDIATE` conditional claim | Efficient multi-worker claiming. |
| Migration | Advisory lock + transactional DDL where supported | Exclusive maintenance mode | Single migrator and schema consistency. |

**Recommendation.** Do not run all PostgreSQL operations at `SERIALIZABLE`. It adds abort/retry cost and does not replace idempotency or uniqueness constraints. Use it for multi-row invariants that are difficult to protect with one locked head row.

## 13. Required uniqueness constraints

1. `events(event_id)` primary key.
2. `events(room_id, room_sequence)` unique.
3. `events(source_system, source_event_key)` unique for non-null source keys.
4. Assistant `generation_id` unique.
5. Assistant `generation_idempotency_key` unique.
6. `event_causes(assistant_event_id, triggering_event_id)` primary key.
7. `event_causes(assistant_event_id, ordinal)` unique.
8. Delivery `idempotency_key` unique.
9. Delivery `(assistant_event_id, medium, destination_key, attempt_no)` unique.
10. Voice drain `(delivery_attempt_id, chunk_ordinal)` primary key.
11. ASR `(utterance_id, finalization_revision)` unique, or defined fallback composite.
12. Current alias one per `(person_id, scope_type, scope_id)`.
13. Current room binding one per physical channel key.
14. Worker `(job_type, dedupe_key)` unique.
15. Migration ID unique; checksum immutable.
16. Semantic correction request idempotency key unique.
17. Forget request external/idempotency key unique when exposed through API.

Uniqueness violation handling must map to domain outcomes; raw database error strings must not leak through public APIs.

## 14. Index and lock requirements

### 14.1 Event retrieval indexes

```sql
CREATE INDEX ix_events_room_sequence
  ON events(room_id, room_sequence);

CREATE INDEX ix_events_person_time
  ON events(author_person_id, occurred_at);

CREATE INDEX ix_events_room_kind_sequence
  ON events(room_id, event_kind, room_sequence);

CREATE INDEX ix_causes_trigger
  ON event_causes(triggering_event_id, assistant_event_id);
```

For redaction/context filtering, consider `(room_id, context_eligibility, room_sequence)` after measuring selectivity.

### 14.2 Delivery indexes

```sql
CREATE INDEX ix_delivery_reconcile
  ON delivery_attempts(result, started_at);

CREATE INDEX ix_delivery_event
  ON delivery_attempts(assistant_event_id, medium, attempt_no);
```

### 14.3 Worker indexes

```sql
CREATE INDEX ix_jobs_claim
  ON worker_jobs(status, available_at, priority, job_id);

CREATE INDEX ix_jobs_lease
  ON worker_jobs(status, lease_expires_at);
```

PostgreSQL may use a partial index for `status='ready'`. SQLite partial indexes are also available; verify query planner behavior with production-shaped data.

### 14.4 Lock order

To avoid deadlocks, operations touching multiple aggregates MUST acquire locks in this order:

1. migration/application advisory lock, if applicable;
2. forget/configuration aggregate head;
3. room rows sorted by `room_id`;
4. mutable head rows sorted by stable key;
5. event/generation rows sorted by ID;
6. delivery/job rows sorted by ID.

No transaction may perform external network or model calls while holding locks.

## 15. SQLite/PostgreSQL behavioral differences

### 15.1 SQLite

**External research finding.** WAL permits readers during a write but still has one writer at a time: https://www.sqlite.org/wal.html.

Normative profile:

- local filesystem only; do not place WAL database on unsupported network filesystems;
- enable foreign keys on every connection;
- use WAL mode and an explicit busy timeout;
- use `BEGIN IMMEDIATE` for read-then-write transactions to acquire writer intent early;
- keep write transactions short;
- manage checkpointing and monitor WAL growth;
- strongly prefer one process-level write coordinator when contention grows;
- cap worker concurrency because extra workers do not create extra write parallelism;
- migrations require maintenance/exclusive mode;
- test crash recovery with abrupt process termination and WAL replay.

SQLite is not a reduced-correctness mode. If the workload cannot meet latency under one-writer serialization, migrate to PostgreSQL rather than weakening invariants.

### 15.2 PostgreSQL

Normative profile:

- default `READ COMMITTED` with explicit row locks/CAS;
- retry deadlocks and serialization failures from transaction start;
- use `FOR UPDATE SKIP LOCKED` for worker claiming;
- use transaction-level advisory lock for migrations/rare global operations;
- set statement, lock, and idle-in-transaction timeouts;
- monitor blocked locks, dead tuples, index growth, and queue age;
- use connection pooling with bounded concurrency;
- use partial indexes and native JSON only where justified; portable core fields remain relational.

### 15.3 Behavioral conformance

Both engines MUST pass the same domain-level test suite. Engine-specific tests cover busy handling, lock timeout, serialization retry, WAL recovery, and `SKIP LOCKED` fairness.

## 16. Failure modes

| ID | Failure mode | Required behavior |
|---|---|---|
| RISK-801 | Duplicate Discord Gateway event | Unique source key returns existing event. |
| RISK-802 | ASR final callback repeated after timeout | Same utterance/final revision returns existing event. |
| RISK-803 | Two writers allocate room sequence | Counter lock + unique constraint; one deterministic order. |
| RISK-804 | Assistant generated from stale snapshot | Append succeeds; mark snapshot and eligibility. |
| RISK-805 | Crash after DB commit before Discord send | Outbox/delivery attempt remains pending and is retried/reconciled. |
| RISK-806 | Crash after Discord send before receipt commit | Mark/derive uncertain; reconcile by external ID/nonce; avoid blind duplicate where possible. |
| RISK-807 | Crash during voice playback | Completed drains remain; attempt becomes partial/uncertain, not completed turn. |
| RISK-808 | Alias concurrent edit | CAS conflict; no silent last-write-wins. |
| RISK-809 | Binding concurrent edit | Serializable/CAS conflict; authorization routing never merges silently. |
| RISK-810 | Summary generated while new events arrive | Commit if coverage/source set valid; new tail does not conflict. |
| RISK-811 | Forget request races with summarizer/embedder | Redaction epoch/source validity check plus deletion outbox; derived result rejected or deleted. |
| RISK-812 | SQLite writer starvation/lock storm | Bounded retry, short transactions, write coordinator, PostgreSQL migration threshold. |
| RISK-813 | Poison worker payload | Dead-letter with redacted diagnostic; no infinite retry. |
| RISK-814 | Migration run by two instances | Advisory/exclusive lock and migration checksum table. |
| RISK-815 | Production DB unavailable | Fail closed for durable operations; never pretend ephemeral write succeeded. |

## 17. Security and privacy implications

**REQ-PRIV-801.** Source idempotency keys may contain Discord IDs but must not contain transcript text, aliases, or prompt content.

**REQ-PRIV-802.** Private aliases are selected only after authorization and scope resolution. Event actor snapshots preserve presentation-at-time but retrieval must enforce current authorization.

**REQ-PRIV-803.** Opaque internal person/event IDs must never be serialized into user-visible text or TTS.

**REQ-PRIV-804.** Error and dead-letter fields store redacted diagnostics. Raw prompts and memory payloads are not copied into operational logs by default.

**REQ-PRIV-805.** Forget processing invalidates summaries, semantic memories, embeddings, caches, and exports derived from deleted source events.

**REQ-PRIV-806.** Append-oriented storage does not mean undeletable content. Redaction/hard-delete policy must distinguish sequence/audit shells from personal payload and comply with the retention/deletion artifact.

**REQ-PRIV-807.** Cross-platform identity linking is outside this transaction model unless separately verified. `discord:user:<id>` remains a Discord identity, not a universal human identity.

## 18. Testable acceptance criteria

### Sequence and append

- **TEST-801:** 100 concurrent append attempts to one room produce 100 unique contiguous committed room sequences or documented non-contiguous behavior, with no duplicates/lost rows.
- **TEST-802:** Concurrent appends to different rooms do not block each other materially in PostgreSQL; SQLite behavior matches one-writer expectations.
- **TEST-803:** Replaying the same Discord message 1,000 times produces one event and one stable response object.
- **TEST-804:** Same idempotency key with changed payload fails explicitly.
- **TEST-805:** Duplicate ASR finals produce one transcript event; a corrected revision produces a linked superseding event.

### Snapshot and causality

- **TEST-806:** Assistant generation at snapshot N can commit after events N+1..N+k without append rejection.
- **TEST-807:** The assistant records exactly all triggering event IDs for a multi-speaker response.
- **TEST-808:** Retrieval can distinguish direct triggers, context-visible non-triggers, and events not visible at generation time.
- **TEST-809:** No code path treats adjacent sequence as sufficient proof of causality.

### Mutable conflicts

- **TEST-810:** Two alias updates with the same expected version result in one success and one version conflict.
- **TEST-811:** Two room-binding changes cannot both become current.
- **TEST-812:** A summary generated at room N commits after N+1 when coverage ends at N and source hash is unchanged.
- **TEST-813:** The same summary is rejected when a covered source event is redacted or corrected.

### Delivery

- **TEST-814:** Crash after assistant persistence and before text send recovers to one confirmed delivery or a visible uncertain state, never silent loss.
- **TEST-815:** Crash after successful Discord send but before DB receipt does not automatically create an unbounded duplicate loop.
- **TEST-816:** Interrupted voice after chunk 2 of 5 is recorded partial and excluded from normal completed-turn context.
- **TEST-817:** Failed/unheard voice output never appears as a fully delivered assistant turn.

### Outbox and jobs

- **TEST-818:** Source event and required outbox job are atomic under injected crash at every statement boundary.
- **TEST-819:** Two PostgreSQL workers cannot process the same leased job concurrently.
- **TEST-820:** Expired lease is reclaimed; stale worker completion is rejected.
- **TEST-821:** Poison job dead-letters after configured attempts and no longer blocks newer jobs.

### Forget and privacy

- **TEST-822:** Forget request removes/redacts primary content and invalidates every derived summary/memory/index/cache in scope.
- **TEST-823:** A concurrent summarizer cannot reintroduce forgotten content after deletion epoch changes.
- **TEST-824:** Private alias never appears in a public guild context under concurrent alias edits.

### Engine and migration

- **TEST-825:** SQLite WAL recovery succeeds after forced process kill during write.
- **TEST-826:** SQLite `BUSY` handling respects bounded retry and produces explicit failure after exhaustion.
- **TEST-827:** PostgreSQL serialization/deadlock injection retries the whole transaction with the same idempotency key.
- **TEST-828:** Two migrators result in one migration executor; checksum mismatch stops startup.
- **TEST-829:** Application refuses production durable mode if schema is incompatible or DB unavailable; it does not silently switch to unrelated in-memory history.

## 19. Non-goals

- Selecting a vector database or graph database.
- Defining semantic extraction prompts.
- Guaranteeing that UDP voice frames were physically heard by every listener.
- Universal cross-platform person identity.
- Global total ordering across all tenants.
- Exactly-once external delivery.
- Retaining every raw audio frame indefinitely.
- Replacing Discord's IDs with aliases as durable identity.
- Mandating an HTTP service boundary.

## 20. Dependencies on other artifacts

This specification depends on or must align with:

1. identity and alias scope specification;
2. logical-room and channel-binding authorization specification;
3. event and memory schema specification;
4. assistant delivery lifecycle specification;
5. retention, correction, forget, export, and backup specification;
6. retrieval/context eligibility specification;
7. threat model and prompt serialization specification;
8. evaluation and benchmark plan;
9. deployment topology ADR choosing SQLite and/or PostgreSQL profiles.

## 21. Open questions

### 21.1 Blocking

**OPEN-801 — Draft sequencing convention.** Will an assistant draft be represented outside the room event ledger until generation completes, or as an event plus append-only lifecycle transitions? This document recommends outside-ledger draft + sequence on durable generated event.

**OPEN-802 — Text idempotency support.** Which Discord library/API mechanism is available in the chosen implementation for nonce-based reconciliation, and can sent messages be reliably queried after an uncertain outcome?

**OPEN-803 — Voice receipt semantics.** What exact local callback constitutes “drained” in the selected Discord voice library, and what timing/byte metrics are available?

**OPEN-804 — Deletion model.** Which fields may remain as non-identifying tombstones after a forget request, and what backup expiry/crypto-erasure policy applies?

**OPEN-805 — Deployment threshold.** What measured concurrent writer rate, p95 lock wait, and worker count trigger promotion from SQLite to PostgreSQL?

**OPEN-806 — Actor snapshot schema.** The exact canonical actor snapshot fields and normalization rules must be frozen before unique payload hashing.

### 21.2 Non-blocking

**OPEN-807.** Whether to use UUIDv7, ULID, or another opaque sortable identifier.

**OPEN-808.** Whether room counters are stored on `rooms` or a dedicated `room_counters` table.

**OPEN-809.** Whether summaries use a separate head table or a partial unique active index.

**OPEN-810.** Whether high-volume voice drain details are retained as one row per chunk or compressed into interval records after delivery finalization.

**OPEN-811.** Whether PostgreSQL advisory locks are needed beyond migrations; row locks are preferred for ordinary aggregates.

## 22. Handoff instructions for downstream agents

### Schema agent

Translate this conceptual schema into engine-specific migrations for SQLite and PostgreSQL. Preserve every uniqueness constraint and partial-current invariant. Do not collapse event payload, generation lifecycle, and delivery attempts into one mutable history JSON field.

### MemoryPort/API agent

Expose operation-specific idempotency and expected-version parameters. Do not expose `expectedRoomVersion` as a mandatory append precondition. Return domain conflict types with current versions.

### Discord text agent

Define stable Discord source keys and delivery reconciliation using message IDs/nonces. Test reconnect replay and uncertain-send crash windows.

### Voice agent

Create durable utterance IDs before ASR; retain speaker Discord identity per finalized utterance; map playback callbacks to drain records; ensure partial/interrupted output is not normal history.

### Worker agent

Implement transactional outbox, leases, retries, dead-lettering, and stale-completion protection. All handlers must be idempotent.

### Privacy agent

Specify hard delete vs redaction/tombstone, derivative invalidation, backup handling, and verification evidence for forget completion.

### Evaluation agent

Build concurrency and crash-injection tests listed in Section 18 for both engines. Benchmark lock waits, append latency, job claim throughput, and recovery outcomes with simultaneous text and voice writers.

## 23. What must be true before coding starts

1. **ADR approved:** milestone-one topology and supported database profiles.
2. **Schema semantics approved:** event vs draft convention, room sequence, causal edges, delivery attempts, and context eligibility.
3. **Identity contract approved:** Discord user ID handling, actor snapshot fields, alias scopes, and private/public authorization.
4. **Deletion contract approved:** redaction, hard deletion, derivative cleanup, backups, and tombstones.
5. **Discord adapter evidence collected:** text nonce/message reconciliation and voice drain/interruption callbacks.
6. **Conflict API approved:** operation-specific expected versions; no universal append `expectedRoomVersion`.
7. **Retry policy approved:** bounded synchronous retries, durable job retries, terminal classification, and dead-letter operations.
8. **Migration procedure approved:** single migrator, checksums, expand/contract rules, backup and rollback.
9. **Failure behavior approved:** database unavailability fails closed; no silent fallback to unrelated ephemeral history.
10. **Acceptance harness ready:** concurrency, duplicate, crash-window, privacy deletion, and cross-engine tests exist before production retention is enabled.

## 24. Concise handoff summary

The next required decisions/artifacts are: the event/schema migration artifact, identity-and-alias scope specification, logical-room binding authorization specification, delivery lifecycle specification, forget/retention/backup specification, and an engine-selection ADR with measured SQLite-to-PostgreSQL promotion thresholds. The central decision to preserve is that room sequence provides deterministic commit order, explicit trigger edges provide causality, and `expectedRoomVersion` must never reject a valid append-only assistant event solely because the room advanced during generation.
