# Shared-Memory ADR Registry

**Task:** IMP-001 · **Rollout stage:** R0 (documentation only) · **Frozen:** 2026-08-02

## 1. Canonical numbering

Four approved artifacts each define an `ADR-00n` series, and **the numbers do
not agree**. Artifact 09 `ADR-001` ("in-process first") is artifact 24
`ADR-001` ("M1 topology") but artifact 21 `ADR-001` ("one canonical
MemoryPort") is artifact 24 `ADR-002`, and artifact 26 `ADR-005` ("Discord user
ID is the only durable key") is artifact 24 `ADR-003`.

Per the source-of-truth precedence (integrated specification → **decision
register** → requirements baseline → …), the canonical program ADR identifiers
are the **`ADR-001` … `ADR-016` series of `artifacts/24-decision-register.md`**,
which matches `artifacts/22-integrated-specification.md` §7.

Every other artifact's ADR series is treated as a *specialist proposal* and is
cited with its artifact number, e.g. `A21-ADR-003`, `A26-ADR-005`,
`A09-ADR-004`. Downstream code and docs MUST use the canonical form. This
resolution is recorded as `CON-101` below.

## 2. Canonical register (status as frozen)

| ADR | Title | Status | Normative content |
|---|---|---|---|
| ADR-001 | M1 topology | Approved | In-process MemoryPort + SQLite (default) / PostgreSQL. **No standalone service in M1.** |
| ADR-002 | Single memory authority | Approved | MemoryPort is the only durable memory authority; text and voice must not own process-local durable histories. |
| ADR-003 | Identity anchor | Approved | `discord:user:<snowflake>` is the durable Discord identity key. Cross-platform human identity is out of scope. |
| ADR-004 | Actor snapshots vs current presentation | Approved | Every event carries an actor snapshot; historical presentation and current addressing are distinct. |
| ADR-005 | Alias scoping | Approved | Five scopes (`platform`, `character-global`, `guild`, `logical-room`, `private`); private never leaks; explicit precedence. |
| ADR-006 | Group voice attribution | Approved | One attributable event per speaker; the durable author is never synthetic. |
| ADR-007 | Generation / persistence / delivery separation | Approved | Separate state machines; no atomic cross-system transaction with Discord. |
| ADR-008 | Layered memory | Approved | Separate records for raw / recent / summary / semantic / episodic / procedural. |
| ADR-009 | Durable fact metadata | Approved | Provenance, confidence, temporal validity, supersession chain are mandatory. |
| ADR-010 | Prompt security | Approved | Structured envelope, `UNTRUSTED_DATA` tagging, neutralization, opaque person handles. |
| ADR-011 | Retrieval pipeline | Approved | auth → exact structured → temporal → lexical → (vector, gated). Multilingual/CJK is first-class. |
| ADR-012 | Forget model | Approved | Redaction + tombstone + cache/embedding/summary invalidation + forget-log replay. |
| ADR-013 | Concurrency model | Approved | Append-only events; row-level versioning + optimistic concurrency for *mutable projections only*. No whole-history mutable JSON. |
| ADR-014 | Causal relations | Approved | Many-to-many `response_cause` / `generation_cause`. No single `user_event_id` per exchange. |
| ADR-015 | Snapshot version semantics | Approved | Snapshot version is **evidence of what generation saw**, not an append lock. |
| ADR-016 | No silent fallback | Approved | MemoryPort surfaces failures; no ephemeral fallback that pretends a write succeeded. |

## 3. Cross-artifact ADR concordance

| Canonical | Artifact 21 §6 | Artifact 26 §7 | Artifact 09 §7 |
|---|---|---|---|
| ADR-001 M1 topology | A21-ADR-002, A21-ADR-009 | A26-ADR-001 | A09-ADR-001 |
| ADR-002 single authority | A21-ADR-001 | A26-ADR-001 | A09-ADR-002 |
| ADR-003 identity anchor | — | A26-ADR-005, A26-ADR-006 | A09-ADR-006 |
| ADR-004 actor snapshots | — | A26-ADR-005 | — |
| ADR-005 alias scoping | — | A26-ADR-007 | — |
| ADR-006 group attribution | A21-ADR-005 | A26-ADR-008 | — |
| ADR-007 delivery separation | A21-ADR-007 | A26-ADR-009 | A09-ADR-005 |
| ADR-008 layered memory | A21-ADR-004 | — | A09-ADR-003 |
| ADR-009 fact metadata | — | — | — |
| ADR-010 prompt security | — | A26-ADR-007 (prompt-safety item) | — |
| ADR-011 retrieval pipeline | A21-ADR-008 | A26-ADR-003 | A09-Alt-4 |
| ADR-012 forget model | A21-ADR-010 | A26-ADR-011 | A09-ADR-003 |
| ADR-013 concurrency | A21-ADR-004 | A26-ADR-004 | A09-Alt-3 |
| ADR-014 causality | A21-ADR-005 | A26-ADR-008 | A09 §10.2 |
| ADR-015 snapshot evidence | A21-ADR-006 | A26-ADR-010 | A09-Alt-5 |
| ADR-016 no silent fallback | — | A26-ADR-012 | A09 F-1 |

Storage backend (`SQLite WAL first`) is stated by `A21-ADR-003`, `A26-ADR-002`
and `A09-ADR-001`; it is folded into canonical **ADR-001** and is *not* given a
separate canonical number.

Capability negotiation (`A09-ADR-004`) has **no canonical counterpart**. It is
adopted as an implementation obligation of ADR-002 (a single authority must
advertise what it can actually do rather than degrade silently) and is
implemented in `packages/memory-domain/src/capabilities.ts`. Recorded as
`CON-102`.

## 4. Local contradiction log (ADR layer)

| ID | Contradiction | Resolution |
|---|---|---|
| CON-101 | Four conflicting `ADR-00n` series. | Artifact 24 series is canonical; others are namespaced `A<artifact>-ADR-<n>`. |
| CON-102 | `A09-ADR-004` (capability negotiation) is normative in artifact 09 but absent from the canonical register. | Adopted as an obligation of ADR-002. No new canonical ADR is minted in R0; if a future increment needs it standalone it becomes ADR-017. |
| CON-103 | Artifact 22 §10.4 names the causal table `response_cause`; artifact 21 §13.2 names it `generation_cause`; artifact 26 §11.2 names the entity `GenerationCause`. | The **domain** name is `CausalEdge` linking `generationId → inboundEventId` with a `role`. Physical table naming is deferred to IMP-201 and is not a contract concern. |
| CON-104 | Artifact 22 §10.4 delivery states (`delivered/partial/failed/interrupted/unheard/…`) omit `unknown_after_crash`, which artifact 26 REQ-DELIVERY-004 makes mandatory. | The union is normative: artifact 26 is the stricter, safety-relevant specification and artifact 22 §12 explicitly lists the crash window as a failure mode. `unknownAfterCrash` is included. Recorded as deviation DEV-001 in `../implementation-status.md`. |
| CON-105 | Artifact 19 §10.1 draws `durableActive → durableShadow` as a "Safe Revert"; §10.2 and TEST-OPS-001 both require degraded mode or a full revert in that situation, and §11 RISK-001 names shadow-mode reads as the split-brain hazard. | The testable acceptance criterion binds over the diagram. `validateRollback` rejects that edge. Recorded as deviation DEV-005. |
| CON-106 | Artifact 09 §10.4 OP-05 records `delivered` for `discord_voice`; artifact 26 REQ-DELIVERY-007 forbids treating playback completion as proof the user heard the output. | Voice never reaches `delivered`. Completed playback is `unheard` carrying `localPlaybackCompleted` evidence, and `provesAudibility()` returns `false` for every evidence kind. |
| CON-107 | Alias scope spelling: artifact 22 §10.2 uses `character_global` / `logical_room` / `private`; artifact 09 §10.2 uses `character-global` / `logical-room` / `private-conversation`. | The integrated specification's SQL enum wins by precedence. `AliasScope` uses the artifact 22 spelling. |

## 5. Adding an ADR

Copy `0000-template.md` to `NNNN-kebab-title.md`, starting at `0017`. A new ADR
requires: affected `REQ-*` ids, the `IMP-*` task that implements it, the tests
that can fail if it is violated, and reviewers per the ownership table in
`artifacts/21-implementation-backlog.md` §10.2.
