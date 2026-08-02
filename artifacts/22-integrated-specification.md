### 1. Title
Integrated Pre-Coding Specification for DC_BOT Shared-Memory Implementation (v0.1)

### 2. Executive conclusion

The source-plan baseline directs DC_BOT toward a single coherent memory authority accessed through a transport-neutral `MemoryPort`, with text and voice ceasing to own unrelated process-local histories. The minimal architecture that preserves a clean migration path is:

- An **in-process domain/application memory layer** behind `MemoryPort`, persisting to SQLite (default) or PostgreSQL (operator-configured), as milestone M1.
- A **standalone HTTP Memory Runtime** is *not* approved for M1. It is deferred to a later milestone gated on demonstrated deployment needs (multi-process workers, separate memory lifecycle, cross-bot sharing). This is **RISK-A** and **ADR-001**.
- Identity is anchored on **Discord user ID** as the durable Discord identity key; all other presentation fields are mutable attributes. Cross-platform human identity is *not* asserted by `discord:user:<id>` (**RISK-F**, **ADR-003**).
- Events, generation, delivery, and persistence are **four separate state machines** that must not be merged into one atomic transaction (**RISK-C**, **ADR-007**).
- The retrieval stack is **authorization → exact structured → temporal → lexical/full-text → (vector/rerank only with benchmark evidence)**. Multilingual/CJK behavior is treated as a first-class requirement, not absorbed into a generic PostgreSQL full-text claim (**RISK-M**, **ADR-011**).
- A **memory lifecycle model** distinguishes raw append-only events, lifecycle state mutations, recent-context windows, summaries, semantic facts, episodic records, and procedural memory. Forget/correction/export/retention are first-class operations with explicit cache and embedding invalidation (**RISK-I**, **ADR-012**).

Coding-start recommendation: **CONDITIONAL GO** (see section 19 and the closing summary). The conditional gate is that the four blocking decisions in section 17 must be resolved, and the traceability matrix must show no untested MUST.

### 3. Scope

In scope:
- Internal memory authority for DC_BOT text and voice.
- `MemoryPort` interface, in-process adapter, SQLite/PostgreSQL persistence schemas.
- Identity, alias scoping, actor snapshots, person references.
- Event capture, recent context, summarization, semantic/episodic/procedural memory, retrieval, prompt serialization.
- Delivery state machine for Discord send and voice playback, including partial-failure reconciliation.
- Data governance: forget, correction, export, retention, backup, cache/summary/embedding invalidation.
- Migration from current DC_BOT process-local histories.
- Evaluation harness covering identity continuity, attribution, temporal updates, abstention, privacy leakage, deletion completeness, concurrency, delivery recovery, multilingual retrieval, cost, latency.

Out of scope (non-goals, see section 15):
- Cross-platform human identity verification (e.g., linking Discord to other platforms' verified humans).
- Standalone HTTP Memory Runtime service in M1.
- Vector/learned reranker/graph storage unless benchmark evidence justifies.
- Replacing Discord as the identity provider.
- Whole-history mutable JSON as a concurrent-write model (rejected; see ADR-013).

### 4. Sources inspected

| Source | Access this session | Notes |
|---|---|---|
| DC_BOT primary repo (github.com/starryark/DC_BOT) | Not re-verified | URL provided in assignment; baseline asserts current process-local text/voice histories. Treated as **baseline-supplied claim**. |
| Example file: `start-bot.ps1` (github.com/starryark/DC_BOT/blob/main/start-bot.ps1) | Not re-verified | URL provided as access-method example only. No architectural inference drawn from it in this session. |
| Airi (github.com/moeru-ai/airi) | Not re-verified | Baseline risk K: Airi memory work may include proposals/skeletons rather than complete production implementation. Treated as **baseline-supplied claim (unverified)**. |
| AstrBot (github.com/astrbotdevs/astrbot) | Not re-verified | Baseline risk L: AstrBot is a product baseline for persisted conversations/compression; mutable whole-history JSON is not a safe concurrent-write model. Treated as **baseline-supplied claim (unverified)**. |
| Source-plan baseline (22 numbered items + risks A–M) | Provided in prompt | Primary input. Treated as **source-plan requirement** for items 1–22 and as **baseline-supplied claim** for risks A–M. |

Honesty note: I am not claiming to have opened any of the above files in this session. Items above marked "Not re-verified" must be re-opened by a downstream agent with live web access before any external-research finding is promoted to "Confirmed repository fact."

### 5. Evidence table

| ID | Claim | Classification | Source URL | Confidence |
|---|---|---|---|---|
| EV-001 | Text and voice currently own unrelated process-local histories in DC_BOT. | Baseline-supplied claim (unverified) | https://github.com/starryark/DC_BOT (specific files not opened this session) | Medium — depends on actual repo structure |
| EV-002 | Discord user ID is the durable Discord identity key. | Source-plan requirement | Baseline item 3 | High |
| EV-003 | `discord:user:<id>` is not automatically a verified cross-platform human identity. | Source-plan requirement / risk | Baseline risk F | High |
| EV-004 | Airi memory work may include proposals and skeletons rather than a complete production implementation. | Baseline-supplied claim (unverified) | https://github.com/moeru-ai/airi | Medium |
| EV-005 | AstrBot persisted conversations/compression use mutable whole-history JSON, which is not a safe concurrent-write model. | Baseline-supplied claim (unverified) | https://github.com/astrbotdevs/astrbot | Medium |
| EV-006 | Database commit and Discord delivery cannot be made exactly atomic. | Source-plan requirement / risk | Baseline items 13, 15; risk C | High |
| EV-007 | PostgreSQL generic full-text search is insufficient for multilingual/CJK retrieval without explicit configuration. | External research finding (general knowledge, unverified this session) | PostgreSQL docs (not opened this session) | High as a general claim; specific config TBD |
| EV-008 | One `user_event_id` per exchange conflicts with multi-speaker group responses. | Source-plan requirement / risk | Baseline item 14; risk D | High |
| EV-009 | Append-only history and privacy deletion are in tension and require an explicit erasure/redaction model. | Source-plan requirement / risk | Baseline items 11, 20; risk I | High |
| EV-010 | A fixed exchange schema containing one user_event_id conflicts with multi-speaker group responses. | Source-plan requirement / risk | Baseline risk D | High |
| EV-011 | Comprehensive guild member update handling may require additional Discord gateway intents. | Source-plan requirement / risk | Baseline risk H | Medium |
| EV-012 | Vectors, learned rerankers, or graph storage require benchmark evidence before adoption. | Source-plan requirement | Baseline item 17 | High |

### 6. Current-state findings

| ID | Finding | Classification |
|---|---|---|
| CSF-001 | DC_BOT currently has no single memory authority; text and voice maintain separate process-local histories. | Baseline-supplied claim (unverified) |
| CSF-002 | There is no transport-neutral `MemoryPort`; transport-specific code paths presumably call storage directly. | Inference from baseline |
| CSF-003 | Discord user ID is used informally as identity; presentation fields are likely captured ad hoc per event. | Inference from baseline |
| CSF-004 | Delivery and persistence are not separated; a successful DB write may be assumed to imply a successful Discord send. | Inference from baseline (must be verified) |
| CSF-005 | No explicit delivery state machine exists for partial/failed/interrupted sends or voice playback. | Inference from baseline |
| CSF-006 | Retrieval, if any, is not gated by authorization-first rules across DM/guild/person/character/room scopes. | Inference from baseline |
| CSF-007 | No provenance/confidence/temporal-validity/supersession model exists for durable facts. | Inference from baseline |
| CSF-008 | No formal erasure/redaction pipeline exists for append-oriented history. | Inference from baseline |

### 7. Proposed decisions (Approved ADRs — see Artifact 3 for full text)

- **ADR-001**: M1 = in-process `MemoryPort` adapter with SQLite/PostgreSQL. No standalone service.
- **ADR-002**: `MemoryPort` is the only memory authority; text and voice must not own process-local histories.
- **ADR-003**: Discord user ID is the durable Discord identity key; cross-platform human identity is out of scope.
- **ADR-004**: Every inbound event carries an actor snapshot; current identity and historical presentation are distinct.
- **ADR-005**: Aliases are scoped (platform / character-global / guild / logical room / private). Private aliases never leak.
- **ADR-006**: Group voice preserves one attributable user event per speaker; durable author is never synthetic.
- **ADR-007**: Generation, persistence, and delivery are separate state machines; no atomic cross-system transactions.
- **ADR-008**: Memory layers (raw, recent, summary, semantic, episodic, procedural) are separate tables/objects.
- **ADR-009**: Durable facts require provenance, confidence, temporal validity, and supersession chain.
- **ADR-010**: Retrieved memory is untrusted data; prompt serialization is hardened against delimiter/role/mention/Unicode/internal-ID injection.
- **ADR-011**: Retrieval pipeline order is auth → exact structured → temporal → lexical → vector (gated). Multilingual/CJK is first-class.
- **ADR-012**: Forget is redaction + tombstone + cache/embedding/summary invalidation, not raw-row deletion only.
- **ADR-013**: Whole-history mutable JSON is rejected as the concurrent-write model (cf. AstrBot baseline).
- **ADR-014**: Many-to-many causal relation between user events and assistant responses; no single `user_event_id` per exchange.
- **ADR-015**: Room snapshot versions are evidence of what generation saw; concurrent appends do not automatically reject commits but are recorded.
- **ADR-016**: No silent fallback to ephemeral memory while pretending writes succeeded.

### 8. Alternatives considered

- **Standalone HTTP Memory Runtime in M1.** Rejected (ADR-001); insufficient demonstrated need; adds operational surface; migration path retained for later.
- **Single mutable JSON history file (AstrBot-style).** Rejected (ADR-013); unsafe under concurrent writers; erasure is destructive.
- **Vector-first retrieval.** Rejected as default (ADR-011); benchmark evidence required; lexical/temporal/structured first.
- **Atomic DB+Discord transaction via two-phase commit.** Rejected; Discord is not a transactional participant; instead explicit reconciliation states (ADR-007).
- **Synthetic "Discord group" author for group voice.** Rejected (ADR-006); violates attribution.
- **Discord user ID as cross-platform human identity.** Rejected (ADR-003).
- **One `user_event_id` per assistant exchange.** Rejected (ADR-014).
- **Raw append-only with no lifecycle state.** Rejected (ADR-008); conflicts with delivery/lifecycle needs.
- **Silent ephemeral fallback.** Rejected (ADR-016).

### 9. Rejected alternatives and reasons

See section 8. Each rejected alternative is recorded with rationale; downstream agents must not reintroduce them without a new ADR superseding the rejection.

### 10. Normative specification (detailed plan)

#### 10.1 Domain glossary

| Term | Definition |
|---|---|
| **Discord user ID** | The durable numeric Discord identity. Not a verified human identity. |
| **Actor snapshot** | Frozen presentation fields (username, global name, guild nick, avatar, voice characteristics) captured on an event. |
| **Person** | The Discord-side identity record keyed by Discord user ID. |
| **Character** | The bot's persona. Separate from persons. |
| **Alias** | A name used to address or refer to a person. Scoped. |
| **Physical room** | A Discord channel (text or voice). |
| **Logical room** | A conversation context that may bind one or more physical rooms or be ephemeral. |
| **Raw event** | An immutable attributable inbound or outbound occurrence with payload and lifecycle state. |
| **Recent context** | A bounded window of recent events per logical room. |
| **Summary** | A compressed representation of a context window, generated off the voice-critical path. |
| **Semantic memory** | A durable fact with provenance, confidence, temporal validity, and supersession. |
| **Episodic memory** | A structured recollection of a specific past occurrence tied to persons/time/scope. |
| **Procedural memory** | Operator-authored rules/scripts. |
| **Generation** | Producing assistant content. |
| **Delivery** | Causing assistant content to appear in Discord (text send or voice playback). |
| **MemoryPort** | The transport-neutral interface that is the only memory authority. |
| **Snapshot version** | A versioned view of logical-room state at generation time. |

#### 10.2 Identity and aliases (REQ-EVENT-001..003, REQ-SCOPE-001, REQ-PRIV-001)

- `Person.person_id` is a stable internal surrogate. `Person.discord_user_id` is unique and is the durable Discord identity.
- Aliases are stored in `Alias(person_id, scope, scope_id, value, precedence, valid_from, valid_until, source)`.
- Scope enum: `platform`, `character_global`, `guild`, `logical_room`, `private`.
- Resolution precedence for current addressing: `private` > `logical_room` > `guild` > `character_global` > `platform`, scoped by authorization.
- Private aliases are tagged `visibility = private` and are excluded from any retrieval path whose authorization context is not the private conversation.
- Two persons with the same alias value never merge: alias uniqueness is `(scope, scope_id, value)` only as a *display* hint; identity remains `person_id`.
- Prompt-local opaque references: persons are referenced in prompts by an opaque handle (e.g., `P_017`) bound to a generation-scoped table. The handle is never printed or spoken; only the chosen display alias is emitted.

#### 10.3 Scope and authorization (REQ-SCOPE-002, REQ-SCOPE-003)

- Authorization dimensions: `dm`, `guild`, `person`, `character`, `logical_room`, `unbound_channel`.
- Every retrieval and write specifies an authorization context. Missing context denies by default.
- Cross-channel recent-history reads require an explicit binding record `RoomBinding(from_room, to_room, type, authorized_by, valid_from, valid_until)`.
- `unbound_channel` is treated as isolated: no cross-room reads.

#### 10.4 Event and delivery model (REQ-EVENT-002, REQ-EVENT-004, REQ-DELIVERY-001..003, ADR-007, ADR-014, ADR-015)

Inbound event state machine:
```
captured -> normalized -> attributed -> persisted_raw -> enrichment_scheduled
                                                              |
                                                              v
                                                       enrichment_done
```
- `captured`: gateway event received.
- `normalized`: payload canonicalized; actor snapshot frozen.
- `attributed`: durable `person_id` resolved; for group voice, one event per speaker.
- `persisted_raw`: raw event row committed with immutable payload and lifecycle state.
- `enrichment_scheduled`/`enrichment_done`: optional off-critical-path enrichment.

Generation state machine:
```
requested -> context_assembled (snapshot_version) -> generated -> pending_delivery
```

Delivery state machine:
```
pending -> sent_attempted -> {delivered | partial | failed | interrupted | unheard}
partial|interrupted|unheard -> reconciliation_evaluated -> {redelivered | superseded | marked_artifact}
```
- A response in `partial`, `failed`, `interrupted`, or `unheard` is **not** a normal completed conversational turn.
- Causal relation table `ResponseCause(response_id, user_event_id, role)` is many-to-many.
- Snapshot version is recorded on `context_assembled` but does not automatically reject a commit if another event arrived meanwhile; the version is evidence, not a lock.

#### 10.5 Persistence and concurrency (ADR-008, ADR-013, REQ-MEM-003)

- SQLite (default) or PostgreSQL (operator-configured). Both must support the same schema.
- Append-mostly `raw_events` table; lifecycle state changes go to `event_lifecycle` (append-only transitions).
- Summaries, semantic facts, episodic records, and procedural memory are separate tables; no god-table.
- Concurrency: row-level versioning (`version`, `updated_at`) on mutable records; optimistic concurrency via `version` check; conflicts trigger explicit reconciliation, not last-write-wins.
- No whole-history mutable JSON object as the unit of write.

#### 10.6 MemoryPort interface (REQ-MEM-001, ADR-002)

```python
# Pseudocode interface (specification only; not production code)
class MemoryPort(Protocol):
    # Writes
    def ingest_event(self, ctx: AuthContext, event: InboundEvent) -> EventId: ...
    def write_semantic_fact(self, ctx: AuthContext, fact: SemanticFact) -> FactId: ...
    def write_procedural(self, ctx: AuthContext, proc: ProceduralMemory) -> ProcId: ...

    # Reads (authorization-first)
    def fetch_recent_context(self, ctx: AuthContext, room: RoomRef, limit: int) -> ContextWindow: ...
    def lookup_exact(self, ctx: AuthContext, key: StructuredKey) -> list[MemoryRecord]: ...
    def search_lexical(self, ctx: AuthContext, query: str, opts: SearchOpts) -> list[MemoryRecord]: ...
    def search_temporal(self, ctx: AuthContext, t: TemporalFilter) -> list[MemoryRecord]: ...
    def search_vector(self, ctx: AuthContext, v: Vector, opts: VectorOpts) -> list[MemoryRecord]: ...  # gated

    # Lifecycle
    def forget(self, ctx: AuthContext, target: ForgetTarget) -> ForgetReport: ...
    def correct(self, ctx: AuthContext, fact_id: FactId, correction: FactCorrection) -> FactId: ...
    def export(self, ctx: AuthContext, person_id: PersonId) -> ExportBundle: ...
    def invalidate_caches(self, ctx: AuthContext, scope: InvalidationScope) -> None: ...

    # Delivery
    def begin_response(self, ctx: AuthContext, cause: list[EventId]) -> ResponseId: ...
    def record_delivery(self, ctx: AuthContext, response_id: ResponseId, state: DeliveryState) -> None: ...
```

#### 10.7 Context and prompt security (ADR-010, REQ-RETRIEVAL-001)

- Prompt serialization uses a structured envelope, not a delimiter-joined string.
- Retrieved memory records are tagged `UNTRUSTED_DATA` and cannot appear in instruction/role positions.
- Opaque person handles are emitted; raw Discord IDs and internal UUIDs are not exposed to the model.
- Mention syntax (`<@!123>`) is neutralized before insertion.
- Unicode normalization (NFKC) + bidi/zero-width stripping on all retrieved text.
- A prompt-injection test vector suite is mandatory (see TEST-SEC-001…006).

#### 10.8 Memory lifecycle (ADR-012, REQ-MEM-004, REQ-PRIV-002)

- Layers: raw events → recent context → summaries → semantic → episodic → procedural.
- Forget target specifiers: `person`, `room`, `guild`, `dm`, `character`, `time_range`, `fact_id`.
- Forget is redaction + tombstone + cascade:
  - Redact payload fields in `raw_events` (keep lifecycle metadata).
  - Tombstone in `semantic_facts`, `episodic`, `summaries`.
  - Invalidate caches: recent-context, prompt-context, embeddings, summaries.
  - Re-derive dependent summaries; if source is gone, summary is tombstoned.
  - Embedding deletion: vector store deletion confirmed before forget is reported complete.
- Export produces a portable bundle of all personal data with provenance.

#### 10.9 Retrieval (ADR-011, REQ-RETRIEVAL-002)

Pipeline (in order):
1. **Authorization**: filter by AuthContext.
2. **Exact structured lookup**: keyed facts, procedural rules.
3. **Temporal filter**: validity windows.
4. **Lexical/full-text**: language-aware tokenizer; CJK bigram tokenizer; per-language stopword lists; explicit `pg_trgm`/ICU configuration for PostgreSQL.
5. **Vector/rerank**: only enabled if benchmark (REQ-EVAL-001) shows net benefit on recall/latency/cost.

#### 10.10 Threat model

| Threat | Vector | Mitigation |
|---|---|---|
| Prompt injection via retrieved memory | Adversarial stored text | UNTRUSTED_DATA tagging, envelope, neutralization (ADR-010) |
| Alias collision merge | Same display name | Identity keyed on person_id (ADR-003) |
| Private alias leakage | Cross-scope retrieval | Scope-tagged aliases, auth-first retrieval |
| Synthetic-author attribution | Group voice shortcut | One event per speaker (ADR-006) |
| Silent ephemeral fallback | Write failure | ADR-016; explicit error surfacing |
| Cross-room data leak | Recent-context bleed | RoomBinding + auth (REQ-SCOPE-002) |
| Partial delivery treated as turn | Race/crash | Delivery state machine (ADR-007) |
| Erasure incompleteness | Cache/embedding residue | Cascade forget (ADR-012) |
| Unicode/mention abuse | Crafted input | Normalization + neutralization |
| Internal ID exposure | Logs/prompts | Opaque handles in prompts; log redaction |

#### 10.11 Data governance

- Retention policy per scope (configurable).
- Backup handling: forget must be replayable against restored backups via a forget-log.
- Cache invalidation is transactional with forget where the cache is local; for distributed caches, a tombstone propagation contract.
- Operator audit log for all forget/correct/export operations.

#### 10.12 Migration

- Phase 0: instrument current text/voice histories with read-only exporters.
- Phase 1: deploy `MemoryPort` with SQLite adapter; backfill persons from current histories; reconcile Discord user IDs.
- Phase 2: cut over text path to `MemoryPort` reads/writes; keep legacy as shadow.
- Phase 3: cut over voice path.
- Phase 4: retire legacy histories; enable PostgreSQL option.

#### 10.13 Observability/runbooks

- Metrics: write latency, retrieval latency by stage, forget cascade duration, delivery state histogram, partial-failure rate, fallback-to-ephemeral count (must be zero).
- Runbooks: partial delivery reconciliation, forget cascade retry, snapshot-version conflict, embedding-store divergence.

#### 10.14 Evaluation (REQ-EVAL-001)

Benchmark dimensions: identity continuity, attribution, temporal updates, abstention, privacy leakage, deletion completeness, concurrency, delivery recovery, multilingual retrieval (incl. CJK), cost, latency.

#### 10.15 Failure injection

- Crash between DB commit and Discord send.
- Discord send returns 200 but message not visible.
- Voice playback interrupted mid-utterance.
- Concurrent append during generation.
- Forget during active retrieval.
- Embedding store unreachable during forget.
- Gateway partial outage during group voice.

#### 10.16 Rollout

- M1 (this spec): in-process MemoryPort, SQLite default, text + voice cutover.
- M2: PostgreSQL option, full export/forget tooling, multilingual retrieval benchmarks.
- M3 (conditional): standalone HTTP Memory Runtime if demonstrated need.

#### 10.17 Coding-agent skills

Implementers must demonstrate:
- Reading the spec's ADRs before writing code.
- Adding tests for every MUST requirement touched.
- Never introducing a silent fallback (ADR-016).
- Using `MemoryPort` exclusively (ADR-002).
- Tagging retrieved memory as untrusted in prompts (ADR-010).

#### 10.18 Implementation backlog

(See Artifact 3 backlog entries BL-001…BL-040; summarized here.)

- BL-001 Define `MemoryPort` interface
- BL-002 SQLite schema migration v1
- BL-003 PostgreSQL schema migration v1
- BL-004 Person/identity resolver
- BL-005 Alias scoping service
- BL-006 Actor snapshot capture
- BL-007 Inbound event state machine
- BL-008 Group voice per-speaker attribution
- BL-009 Raw event persistence
- BL-010 Lifecycle transitions table
- BL-011 Snapshot versioning
- BL-012 Response causal relation table
- BL-013 Generation state machine
- BL-014 Delivery state machine (text)
- BL-015 Delivery state machine (voice)
- BL-016 Reconciliation worker
- BL-017 Recent context window service
- BL-018 Summarization worker (off voice path)
- BL-019 Semantic fact store
- BL-020 Episodic memory store
- BL-021 Procedural memory store
- BL-022 Authorization context service
- BL-023 RoomBinding service
- BL-024 Retrieval pipeline (auth→structured→temporal→lexical)
- BL-025 Multilingual/CJK tokenizer config
- BL-026 Vector store adapter (gated, disabled by default)
- BL-027 Prompt envelope serializer
- BL-028 Prompt-injection test vectors
- BL-029 Forget cascade
- BL-030 Correction/supersession
- BL-031 Export bundle
- BL-032 Retention policy engine
- BL-033 Backup forget-log replay
- BL-034 Cache invalidation contract
- BL-035 Embedding deletion verifier
- BL-036 Observability metrics
- BL-037 Runbooks
- BL-038 Evaluation harness
- BL-039 Failure injection harness
- BL-040 Migration tooling (Phase 0–4)

### 11. Interfaces, schemas, diagrams, state machines, test vectors

#### 11.1 Core schema (SQL DDL, illustrative)

```sql
-- Persons and identity
CREATE TABLE person (
  person_id          TEXT PRIMARY KEY,
  discord_user_id    TEXT NOT NULL UNIQUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE actor_snapshot (
  snapshot_id        TEXT PRIMARY KEY,
  person_id          TEXT NOT NULL REFERENCES person(person_id),
  username           TEXT,
  global_name        TEXT,
  guild_nick         TEXT,
  avatar_url         TEXT,
  voice_characteristics JSONB,
  captured_at        TIMESTAMPTZ NOT NULL
);

CREATE TABLE alias (
  alias_id           TEXT PRIMARY KEY,
  person_id          TEXT NOT NULL REFERENCES person(person_id),
  scope              TEXT NOT NULL CHECK (scope IN
                       ('platform','character_global','guild','logical_room','private')),
  scope_id           TEXT,
  value              TEXT NOT NULL,
  precedence         INT NOT NULL,
  visibility         TEXT NOT NULL CHECK (visibility IN ('public','private')),
  valid_from         TIMESTAMPTZ,
  valid_until        TIMESTAMPTZ,
  source             TEXT,
  UNIQUE (scope, scope_id, value, valid_from)
);

-- Rooms and bindings
CREATE TABLE logical_room (
  room_id            TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN
                       ('dm','guild','person','character','unbound_channel','logical')),
  discord_channel_id TEXT,
  metadata           JSONB
);

CREATE TABLE room_binding (
  binding_id         TEXT PRIMARY KEY,
  from_room          TEXT NOT NULL REFERENCES logical_room(room_id),
  to_room            TEXT NOT NULL REFERENCES logical_room(room_id),
  binding_type       TEXT NOT NULL,
  authorized_by      TEXT NOT NULL,
  valid_from         TIMESTAMPTZ NOT NULL,
  valid_until        TIMESTAMPTZ
);

-- Raw events (append-only payload; lifecycle separate)
CREATE TABLE raw_event (
  event_id           TEXT PRIMARY KEY,
  person_id          TEXT REFERENCES person(person_id),
  room_id            TEXT NOT NULL REFERENCES logical_room(room_id),
  direction          TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  modality           TEXT NOT NULL CHECK (modality IN ('text','voice')),
  payload            JSONB NOT NULL,
  actor_snapshot_id  TEXT REFERENCES actor_snapshot(snapshot_id),
  received_at        TIMESTAMPTZ NOT NULL,
  immutability_hash  TEXT NOT NULL
);

CREATE TABLE event_lifecycle (
  transition_id      TEXT PRIMARY KEY,
  event_id           TEXT NOT NULL REFERENCES raw_event(event_id),
  from_state         TEXT NOT NULL,
  to_state           TEXT NOT NULL,
  transitioned_at    TIMESTAMPTZ NOT NULL,
  reason             TEXT
);

-- Responses and delivery
CREATE TABLE response (
  response_id        TEXT PRIMARY KEY,
  room_id            TEXT NOT NULL REFERENCES logical_room(room_id),
  generated_at       TIMESTAMPTZ NOT NULL,
  snapshot_version   BIGINT NOT NULL,
  payload            JSONB NOT NULL,
  state              TEXT NOT NULL CHECK (state IN
                       ('requested','context_assembled','generated',
                        'pending','sent_attempted','delivered',
                        'partial','failed','interrupted','unheard',
                        'redelivered','superseded','marked_artifact'))
);

CREATE TABLE response_cause (
  response_id        TEXT NOT NULL REFERENCES response(response_id),
  user_event_id      TEXT NOT NULL REFERENCES raw_event(event_id),
  role               TEXT NOT NULL,
  PRIMARY KEY (response_id, user_event_id)
);

-- Memory layers
CREATE TABLE summary (
  summary_id         TEXT PRIMARY KEY,
  room_id            TEXT REFERENCES logical_room(room_id),
  source_event_ids   JSONB NOT NULL,
  summary_text       TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  superseded_by      TEXT REFERENCES summary(summary_id),
  tombstone          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE semantic_fact (
  fact_id            TEXT PRIMARY KEY,
  person_id          TEXT REFERENCES person(person_id),
  scope              TEXT NOT NULL,
  scope_id           TEXT,
  predicate          TEXT NOT NULL,
  object             JSONB NOT NULL,
  provenance         JSONB NOT NULL,
  confidence         REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  valid_from         TIMESTAMPTZ,
  valid_until        TIMESTAMPTZ,
  superseded_by      TEXT REFERENCES semantic_fact(fact_id),
  tombstone          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE episodic_memory (
  episodic_id        TEXT PRIMARY KEY,
  person_id          TEXT REFERENCES person(person_id),
  room_id            TEXT REFERENCES logical_room(room_id),
  occurred_at        TIMESTAMPTZ NOT NULL,
  payload            JSONB NOT NULL,
  tombstone          BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE procedural_memory (
  proc_id            TEXT PRIMARY KEY,
  author             TEXT NOT NULL,
  rule               TEXT NOT NULL,
  valid_from         TIMESTAMPTZ NOT NULL,
  valid_until        TIMESTAMPTZ
);

-- Erasure log (replayable against backups)
CREATE TABLE forget_log (
  forget_id          TEXT PRIMARY KEY,
  target_spec        JSONB NOT NULL,
  cascades           JSONB NOT NULL,
  completed          BOOLEAN NOT NULL,
  initiated_at       TIMESTAMPTZ NOT NULL,
  completed_at       TIMESTAMPTZ
);
```

#### 11.2 State machines (textual)

Inbound event: see 10.4.
Generation: see 10.4.
Delivery: see 10.4.
Forget cascade:
```
requested -> scope_resolved -> raw_redacted -> facts_tombstoned
  -> summaries_tombstoned -> caches_invalidated -> embeddings_deleted
  -> forget_log_completed
```
Any sub-step failure → `forget_log_failed` with retry policy and operator alert.

#### 11.3 Test vectors (illustrative)

- TEST-SEC-001: retrieved memory containing `</system>` is rendered as data, not interpreted.
- TEST-SEC-002: mention `<@!999>` is neutralized to a non-mention token.
- TEST-SEC-003: zero-width Unicode in retrieved text is stripped.
- TEST-SEC-004: internal UUID in retrieved text is replaced by opaque handle.
- TEST-ID-001: two persons with alias "Alex" remain distinct.
- TEST-DEL-001: crash between DB commit and Discord send leaves response in `sent_attempted` not `delivered`.
- TEST-DEL-002: voice playback interruption marks `interrupted`, not `delivered`.
- TEST-PRIV-001: private alias does not appear in guild-scope retrieval.
- TEST-FORGET-001: after forget, no retrieval path returns the redacted content; embeddings deleted.
- TEST-MULTI-001: CJK query retrieves CJK-stored fact; Latin-only tokenizer fails this baseline.

### 12. Failure modes

- Crash windows between DB and Discord (RISK-C).
- Concurrent appends during generation (RISK-B).
- Group voice speaker attribution loss (RISK-D, mitigated ADR-006).
- Erasure residue in caches/embeddings/backups (RISK-I).
- Silent ephemeral fallback (RISK-22; ADR-016 forbids).
- Multilingual retrieval regression (RISK-M).
- Guild member update intents missing (RISK-H).
- Airi/AstrBot assumption misapplied to DC_BOT (RISKS K, L).

### 13. Security and privacy implications

- Privacy is release-blocking. No M1 release without passing TEST-PRIV-* and TEST-FORGET-*.
- Identity is release-blocking. No M1 release without TEST-ID-*.
- Attribution is release-blocking. No M1 release without TEST-DEL-* and per-speaker attribution tests.
- Deletion completeness is release-blocking. No M1 release without forget-cascade verification and backup replay.

### 14. Testable acceptance criteria

Every MUST requirement in the traceability matrix (Artifact 2) must map to at least one TEST-* and at least one metric. Acceptance for M1: 100% of MUST requirements have a test, 0 silent fallbacks in any path, forget cascade verified end-to-end, delivery state machine covers all listed terminal states, multilingual retrieval passes baseline CJK and Latin test sets.

### 15. Non-goals

- Cross-platform human identity verification.
- Standalone HTTP Memory Runtime in M1.
- Vector/learned reranker/graph as default retrieval.
- Whole-history mutable JSON as concurrency model.
- Replacing Discord as identity provider.

### 16. Dependencies on other artifacts

- None external in this session. The downstream artifacts (Artifacts 2–4 below) are part of this same response and must be read together.

### 17. Open questions

#### Blocking
- **OQ-BLOCK-001**: Exact current DC_BOT file structure for text/voice histories is unverified this session. Must be confirmed by an agent with live web access before migration Phase 0.
- **OQ-BLOCK-002**: Confirm whether DC_BOT already has any delivery state tracking that must be preserved or migrated.
- **OQ-BLOCK-003**: Confirm operator's chosen DB (SQLite vs PostgreSQL) for M1 default; affects default tokenizer config.
- **OQ-BLOCK-004**: Confirm Discord gateway intents currently enabled; guild member update handling depends on this (RISK-H).

#### Non-blocking
- OQ-NB-001: Vector store choice for M3.
- OQ-NB-002: Specific CJK tokenizer library.
- OQ-NB-003: Summary regeneration cadence.

### 18. Handoff instructions for downstream agents

- Implementers: read ADRs (Artifact 3) before writing code. Use `MemoryPort` exclusively. Add tests for every MUST touched.
- Verification agent: re-open the four GitHub URLs listed in section 4 and confirm or correct every `(unverified this session)` item.
- QA agent: implement the TEST-* suite; no MUST ships without a test.
- Operations agent: write runbooks for the failure modes in section 12.

### 19. What must be true before coding starts

- OQ-BLOCK-001 through OQ-BLOCK-004 resolved.
- Traceability matrix shows zero untested MUST requirements.
- ADR-001 through ADR-016 approved (Artifact 3).
- Risk register (Artifact 4) shows RISK-A, C, D, F, I, M mitigated or accepted with explicit owner.
- Coding-start recommendation: **CONDITIONAL GO**.

---
