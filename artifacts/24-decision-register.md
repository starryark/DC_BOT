| ADR | Title | Status | Decision | Alternatives considered | Supersedes | Date |
|---|---|---|---|---|---|---|
| ADR-001 | M1 topology | Approved | In-process MemoryPort + SQLite/PostgreSQL; no standalone service in M1 | Standalone HTTP Memory Runtime | — | v0.1 |
| ADR-002 | Single memory authority | Approved | MemoryPort is the only memory authority; text/voice must not own process-local histories | Per-path storage | — | v0.1 |
| ADR-003 | Identity anchor | Approved | Discord user ID is durable Discord identity key; cross-platform human identity out of scope | Discord ID = human | — | v0.1 |
| ADR-004 | Actor snapshots and historical presentation | Approved | Every event carries an actor snapshot; current identity and historical presentation distinct | Live lookup at read time | — | v0.1 |
| ADR-005 | Alias scoping | Approved | Five scopes; private never leaks; precedence rules | Global nickname only | — | v0.1 |
| ADR-006 | Group voice attribution | Approved | One attributable event per speaker; never synthetic author | "Discord group" author | — | v0.1 |
| ADR-007 | Separation of generation/persistence/delivery | Approved | Separate state machines; no atomic cross-system transactions | Two-phase commit | — | v0.1 |
| ADR-008 | Layered memory | Approved | Separate tables for raw/recent/summary/semantic/episodic/procedural | Single god-table | — | v0.1 |
| ADR-009 | Durable fact metadata | Approved | Provenance, confidence, temporal validity, supersession chain | Free-form JSON | — | v0.1 |
| ADR-010 | Prompt security | Approved | Envelope, UNTRUSTED_DATA tagging, neutralization, opaque handles | String concatenation | — | v0.1 |
| ADR-011 | Retrieval pipeline | Approved | Auth→exact→temporal→lexical→(vector gated); multilingual first-class | Vector-first | — | v0.1 |
| ADR-012 | Forget model | Approved | Redaction + tombstone + cache/embedding/summary invalidation + forget-log replay | Hard delete only | — | v0.1 |
| ADR-013 | Concurrency model | Approved | Row-level versioning, optimistic concurrency; no whole-history mutable JSON | Whole-history JSON (AstrBot-style) | — | v0.1 |
| ADR-014 | Causal relations | Approved | Many-to-many response_cause | Single user_event_id per exchange | — | v0.1 |
| ADR-015 | Snapshot version semantics | Approved | Evidence of what generation saw; concurrent append does not auto-reject | Pessimistic lock | — | v0.1 |
| ADR-016 | No silent fallback | Approved | MemoryPort must surface failures; no ephemeral fallback pretending success | Silent fallback | — | v0.1 |

### Deferred decisions
- D-DEF-001: Standalone HTTP Memory Runtime (deferred to M3, gated on demonstrated need).
- D-DEF-002: Vector store product choice (M2/M3).
- D-DEF-003: Specific CJK tokenizer library (M1 implementation detail).
- D-DEF-004: Summary regeneration cadence (M2).

### Blocking decisions (must resolve before coding)
- D-BLOCK-001: Confirm current DC_BOT text/voice history file structure (OQ-BLOCK-001).
- D-BLOCK-002: Confirm existing delivery-state tracking in DC_BOT (OQ-BLOCK-002).
- D-BLOCK-003: Confirm M1 default DB (OQ-BLOCK-003).
- D-BLOCK-004: Confirm Discord gateway intents (OQ-BLOCK-004); affects REQ-OPS-004.

### Approved decisions summary
ADR-001 through ADR-016 are approved. They constitute the normative baseline for M1.

---
