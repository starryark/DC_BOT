# Shared-Memory Implementation Status

**Task:** IMP-001 · **Frozen:** 2026-08-02 · **Repository:** DC_BOT `main` @ `0ea3cbf5ec92f719e2b48066c3ada45aa50122ad`
**Access mode:** **A — writable local checkout** (`C:\Users\lyang\Code\DC_BOT`).

**Current implementation increment:** IMP-201 · **Inspected base:** `main` @
`50d81100cfda083feefe83fe542880b8bc29bcbd` · initial working tree clean.

This is the live status page for the shared-memory program. It answers three
questions: which approved artifacts exist, what is blocked, and what is
therefore authorized to be coded right now.

---

## 1. Artifact compliance table

| # | Artifact | Present | Verdict / role | Usable as a gate input |
|---|---|---|---|---|
| 00 | `00-program-charter.md` | ✅ | Program framing | ✅ |
| 01 | `01-repository-evidence-audit.md` | ✅ | Evidence | ✅ |
| 02 | `02-comparative-research.md` | ✅ | Comparison (inspiration only) | ⚠️ inspiration only |
| 03 | `03-topology-storage-adr.md` | ✅ | Topology/storage ADR | ✅ |
| 04 | `04-requirements-baseline.md` | ✅ | Requirements | ✅ |
| 05 | `05-identity-alias-spec.md` | ✅ | Identity/alias | ✅ |
| 06 | `06-room-scope-authorization-spec.md` | ✅ | Room/scope/authz | ✅ |
| 07 | `07-event-causality-delivery-spec.md` | ✅ | Event/causality/delivery | ✅ |
| 08 | `08-persistence-concurrency-spec.md` | ✅ | Persistence/concurrency | ✅ |
| 09 | `09-memory-port-api-spec.md` | ✅ | **MemoryPort contract (13 ops)** | ✅ |
| 10 | `10-context-prompt-security-spec.md` | ✅ | Context/prompt security | ✅ |
| 11 | `11-memory-lifecycle-spec.md` | ✅ | Memory lifecycle | ✅ |
| 12 | `12-retrieval-spec.md` | ✅ | Retrieval | ✅ |
| 13 | `13-security-threat-model.md` | ✅ | Threat model | ✅ |
| 14 | `14-data-governance-retention-deletion.md` | ✅ | Governance/deletion | ✅ |
| 15 | `15-migration-backward-compatibility-plan.md` | ✅ | Migration | ✅ |
| 16 | `16-observability-resilience-runbooks.md` | ✅ | Observability/runbooks | ✅ |
| 17 | `17-evaluation-benchmark.md` | ✅ | Evaluation | ✅ |
| 18 | `18-failure-injection-concurrency-plan.md` | ✅ | Failure injection | ✅ |
| 19 | `19-rollout-feature-flags-rollback.md` | ✅ | **Feature flags / rollback** | ✅ |
| 20 | `20-coding-agent-skill-pack.md` | ✅ | Coding-agent skills | ✅ |
| 21 | `21-implementation-backlog.md` | ✅ | **Backlog IMP-001…IMP-807, gates G1–G8** | ✅ |
| 22 | `22-integrated-specification.md` | ✅ | **Integrated spec — verdict CONDITIONAL GO** | ✅ |
| 23 | `23-requirements-traceability-matrix.md` | ✅ | Traceability | ⚠️ 2 flagged MUSTs (§3) |
| 24 | `24-decision-register.md` | ✅ | **Canonical ADR-001…ADR-016 (all Approved)** | ✅ |
| 25 | `25-risk-register.md` | ✅ | Risk register | ✅ |
| 26 | `26-red-team-readiness-review.md` | ✅ | **Independent red team — verdict NO-GO** | ✅ |

No approved artifact is missing.

---

## 2. Gate precondition check (master orchestrator §PRECONDITIONS)

| # | Precondition | Status | Evidence |
|---|---|---|---|
| 1 | Integrated specification verdict is GO or CONDITIONAL GO | ✅ **CONDITIONAL GO** | Artifact 22 §2, §19 |
| 2 | All critical red-team findings closed or explicitly conditioned | ⚠️ **PARTIAL** — see §4 | Artifact 26 §6.6 |
| 3 | Topology and storage ADR confirmed | ✅ | ADR-001 (Approved); artifact 03 |
| 4 | Identity, room-scope, event, delivery, persistence, deletion, degraded-mode semantics confirmed | ✅ | ADR-003…ADR-016; artifacts 05–08, 11, 14 |
| 5 | Every first-increment MUST maps to a test | ✅ **for this increment** | §6 below |
| 6 | Vector/graph gated and out of the first increment | ✅ | ADR-011; capabilities are hard-disabled in code |
| 7 | Writable repository available | ✅ | Local checkout, Mode A |

### The verdict conflict, resolved explicitly

Artifact 22 says **CONDITIONAL GO**. Artifact 26 says **NO-GO**. That is not a
tie: artifact 26 §3.2 states its own primary blocker was that *"the integrated
specification and all supporting artifacts referenced by the assignment were
not provided"* (`FIND-001`, severity High, coding-blocking **Yes**), and §19
lists *"The integrated specification and all supporting artifacts are available
and versioned"* as the **first** condition for moving NO-GO → CONDITIONAL GO.

That condition is now satisfied (§1). The remaining §19 conditions are
substantive and are **not** all satisfied — most require passing tests that do
not exist yet. Therefore:

> **Program disposition: CONDITIONAL GO, limited to rollout stages R0 and R1.**
>
> - **R0** (documentation, contracts, tests only) — **authorized**.
> - **R1** (code merged, runtime disabled, no production behavior change) — **authorized**.
> - **R2 and above** (shadow writes, prompt use, canary, rollout) — **BLOCKED** until the gates in §4 close with passing tests.
>
> This matches artifact 26 §2 verbatim: *"Documentation, evidence collection,
> and benchmark design may continue"*, and artifact 21 §Concise-handoff:
> *"Begin only IMP-001–003, then IMP-101–108."*

No production code path is modified by any R0/R1 increment. `pnpm start`
behavior at this SHA is byte-for-byte unchanged until an `IMP-3xx`+ increment
is authorized.

---

## 3. Flagged MUST requirements (artifact 23)

| Req | Flag | Disposition for R0/R1 |
|---|---|---|
| REQ-EVAL-001 | `‼ MISSING` — full benchmark is M2-bound; M1 needs a harness skeleton | Not required for R0/R1. Blocks G8, tracked at IMP-802. |
| REQ-OPS-004 | `‼ MISSING` — guild-member-update intent availability unverified (`OQ-BLOCK-004`) | Not required for R0/R1: no gateway intent is added, and no contract in this increment *assumes* member state is fresh. The contract represents missing presentation fields as **absent**, never synthesized. Blocks G3, tracked at IMP-305. |

No other MUST is untested. R0/R1 introduces no new untested MUST.

---

## 4. Red-team blocker table (artifact 26 §6.6)

`Closed` = an approved decision record exists **and** this increment adds a test
that fails if the decision is violated. `Conditioned` = an approved decision
record exists, the test belongs to a later increment, and nothing in R0/R1 can
violate it. `Open` = neither.

| Finding | Severity | Blocking | Disposition after artifact delivery | Gate that closes it |
|---|---|---|---|---|
| FIND-001 missing integrated spec | High | Yes | **Closed** — all 27 artifacts present (§1) | — |
| FIND-002 mandatory microservice unjustified | High | Yes (service impl) | **Closed** — ADR-001; no service exists; `remoteTransport` capability is hard-disabled | G1 |
| FIND-003 PostgreSQL premature | High | Yes (mandatory PG) | **Closed** — ADR-001 SQLite-first; contract is backend-neutral | G2 |
| FIND-004 vector/graph premature | High | Yes | **Closed** — ADR-011; `vectorSearch`/`graphSearch` capabilities are hard-disabled and rejected with `UNSUPPORTED_CAPABILITY` | G6 |
| FIND-005 text and voice have unrelated authorities | **Critical** | Yes | **Conditioned** — ADR-002; contract exists in R1 but the two legacy stores (LEV-005, LEV-008) are untouched until IMP-501/502 | G5 |
| FIND-006 group attribution destroyed at commit | **Critical** | Yes | **Conditioned** — ADR-006/ADR-014; domain forbids synthetic authors and requires ≥1 cause edge; the live `'Discord group'` path (LEV-004) is untouched until IMP-402 | G4 |
| FIND-007 identity can fall back to presentation | **Critical** | Yes | **Conditioned** — ADR-003; domain rejects person-scoped writes without a snowflake and offers an explicit anonymous actor | G3 |
| FIND-008 cross-platform identity unverified | **Critical** | Yes (any merge) | **Closed** — ADR-003; the domain has no cross-platform link type at all, so no merge is expressible | G1 |
| FIND-009 alias scope/update policy incomplete | **Critical** | Yes | **Conditioned** — ADR-005; five scopes + precedence + visibility are contractual; observation throttling lands at IMP-202 | G3 |
| FIND-010 Discord intent assumptions not closed | High | Yes (where alias authz needs member state) | **Open** — `OQ-BLOCK-004`. R0/R1 is unaffected: nothing added assumes member state. | G3 / IMP-305 |
| FIND-011 DM/guild/person/character/room isolation loose | **Critical** | Yes | **Conditioned** — ADR-005; scope lattice + deny-by-default authorization are contractual; enforcement at the facade lands at IMP-304 | G3 |
| FIND-012 text history recorded before delivery | **Critical** | Yes | **Conditioned** — ADR-007; delivery states + context eligibility are contractual; the live pre-send append (LEV-009) is untouched until IMP-404 | G4 |
| FIND-013 voice commits possibly-undelivered content | **Critical** | Yes | **Conditioned** — ADR-007; per-segment states are contractual; live path untouched until IMP-405 | G4 |
| FIND-014 no explicit crash-window contract | **Critical** | Yes | **Conditioned** — `unknownAfterCrash` is in the contract (see deviation DEV-001); reconciliation lands at IMP-207/406 | G4 |
| FIND-015 delivery recovery states incomplete | **Critical** | Yes | **Conditioned** — full state machine is contractual | G4 |
| FIND-016 one-user-event exchange cannot model group causality | **Critical** | Yes | **Closed** — ADR-014; the domain has no single-cause field; `causes` is a non-empty list | G1 |
| FIND-017 optimistic concurrency misapplied to appends | High | Yes | **Closed** — ADR-015; snapshot version is typed as evidence and no append API accepts an expected-version argument | G1 |
| FIND-018 immutable events vs mutable lifecycle | High | Yes | **Closed** — ADR-008/ADR-012; payload envelope and lifecycle transitions are separate types | G1 |
| FIND-019 mutable whole-history writes | High | Yes | **Closed** — ADR-013; no whole-history value exists in the contract | G1 |
| FIND-020 deletion incomplete without derived/backup model | **Critical** | Yes | **Conditioned** — ADR-012; deletion selector, action, manifest and derived-artifact classes are contractual; execution lands at IMP-702/703 | G7 |
| FIND-021 retrieved memory/names/mentions attack the prompt | **Critical** | Yes | **Conditioned** — ADR-010; untrusted tagging and opaque refs are contractual; serializer lands at IMP-602 | G6 |
| FIND-022 multilingual retrieval unsupported | High | Yes (for readiness claims) | **Closed for R1** — `fulltextCjk` is not advertised and CJK queries must return `UNSUPPORTED_CAPABILITY` rather than silently empty | G6/G8 |
| FIND-023 ranking constants / abstention unvalidated | High | Yes (semantic retrieval) | **Conditioned** — no ranking constants exist in R1 | G6 |
| FIND-024 latency/cost targets are hypotheses | High | Yes (hard targets) | **Conditioned** — R1 adds no runtime work to any path | G8 |
| FIND-025 silent degraded mode / migration falsehoods | **Critical** | Yes | **Conditioned** — ADR-016 + artifact 09 F-1; `spooled` is a distinct, non-durable result and degraded reads return a `noDurableContext` sentinel | G5 |
| FIND-026 test/incrementality/ops plans insufficient | **Critical** | Yes | **Conditioned** — this program *is* the remediation; the staged plan is artifact 21 §11 | G8 |

**Open blockers: 1** (FIND-010). It does not block R0/R1.

---

## 5. Deviation register

| ID | Deviation | Rationale | Approved by |
|---|---|---|---|
| DEV-001 | Delivery state union includes `unknownAfterCrash`, which artifact 22 §10.4 omits. | Artifact 26 REQ-DELIVERY-004 makes it mandatory, and artifact 22 §12/§10.15 both list the crash window as a required failure mode. Taking the stricter union is the only reading that satisfies both. | Recorded at CON-104 |
| DEV-002 | Canonical ADR numbering follows artifact 24; other artifacts' ADR series are namespaced `A<nn>-ADR-<n>`. | Four conflicting series; source-of-truth precedence puts the decision register above specialist artifacts. | Recorded at CON-101 |
| DEV-003 | Capability negotiation (`A09-ADR-004`) is implemented without a canonical ADR number. | Adopted as an obligation of ADR-002 rather than minting ADR-017 during R0. | Recorded at CON-102 |
| DEV-004 | The domain package is `@proj-airi/memory-domain` under `airi/packages/`, resolving `BQ-002` in favour of a new package over `core-agent`. | Artifact 21 §7 marks the new-package split *Recommended* and `core-agent` only a fallback; `core-agent` mixes runtime + provider concerns and would violate AC-003 (zero provider imports). | This increment |
| DEV-005 | The rollback transition `durableActive → durableShadow`, drawn as a "Safe Revert" in artifact 19 §10.1, is **rejected** by `validateRollback`. | Artifact 19 §10.2 and its testable acceptance criterion TEST-OPS-001 both require degraded mode or a full revert in exactly that situation, and §11 RISK-001 names the shadow configuration as the split-brain hazard. The acceptance criterion binds over the diagram. | This increment |
| DEV-006 | `sharedRecentContext` may not be promoted to source of truth without `deliveryLifecycle`. | Not stated as a flag prerequisite in artifact 19, but promoting durable context without delivery states re-creates FIND-012/FIND-013 (undelivered output entering context as a completed turn), which ADR-007 forbids. | This increment |

---

## 6. Increment-to-requirement-to-test matrix (R0/R1, this wave)

| Task | Requirements | Implementation | Test |
|---|---|---|---|
| IMP-001 | REQ-OPS-001, REQ-OPS-003 | `docs/memory/**` | `airi/services/discord-bot/src/memory/program-docs.test.ts` |
| IMP-002 | REQ-MEM-001, REQ-OPS-001, REQ-OPS-002 | `airi/services/discord-bot/src/memory/feature-flags.ts` | `…/feature-flags.test.ts` |
| IMP-003 | REQ-MEM-001, REQ-OPS-001 | `CODEOWNERS`, boundary test | `airi/packages/memory-domain/src/boundaries.test.ts` |
| IMP-101 | REQ-ID-001, REQ-MEM-001, REQ-OPS-003 | `memory-domain/src/{ids,errors,capabilities,port}.ts` | `…/{ids,capabilities,port}.test.ts` |
| IMP-102 | REQ-ID-001…003 | `memory-domain/src/identity.ts` | `…/identity.test.ts` |
| IMP-103 | REQ-ID-004, REQ-PRIV-001, REQ-SCOPE-002 | `memory-domain/src/{aliases,addressing}.ts` | `…/{aliases,addressing}.test.ts` |
| IMP-104 | REQ-SCOPE-001, REQ-SCOPE-002 | `memory-domain/src/rooms.ts` | `…/rooms.test.ts` |
| IMP-105 | REQ-SCOPE-002, REQ-RETRIEVAL-001, REQ-PRIV-001 | `memory-domain/src/authorization.ts` | `…/authorization.test.ts` |
| IMP-106 | REQ-EVENT-001…003 | `memory-domain/src/{events,causality}.ts` | `…/{events,causality}.test.ts` |
| IMP-107 | REQ-DELIVERY-001…003 | `memory-domain/src/{generation,delivery}.ts` | `…/{generation,delivery}.test.ts` |
| IMP-108 | REQ-MEM-002, REQ-MEM-003, REQ-PRIV-002 | `memory-domain/src/{memory-records,provenance,corrections}.ts` | `…/{memory-records,corrections}.test.ts` |
| IMP-201 | REQ-EVENT-001, REQ-MEM-002, REQ-OPS-001 | `memory-sqlite/src/{schema,migrations,migration-runner}.ts` | `…/{migration-runner,schema/v1,boundaries}.test.ts` |

---

## 7. Open questions still owned by this program

| ID | Question | Owner role | Blocks |
|---|---|---|---|
| OQ-BLOCK-004 / OQ-B1 / FIND-010 | Which Discord gateway intents are approved and available (Message Content, Server Members)? | Discord Operations Agent | G3 / IMP-305 |
| OQ-BLOCK-003 / BQ-003 | Confirm SQLite as the M1 default and the process topology (one bot process vs workers). | Operations Agent | G2 / IMP-208 |
| OQ-B3 | CJK tokenizer decision, or keep `fulltextCjk` unadvertised for M1. | Retrieval Agent | G6 / IMP-606 |
| OQ-B4 / BQ-004 | Operator privilege model and legal-basis vocabulary before `purge` is enabled. | Privacy & Security Agent | G7 / IMP-702 |
| BQ-006 | Which delivery outcomes make *partial* voice output context-eligible. | Generation/Delivery Agent | G4 / IMP-405 |

**Closed this increment:** `OQ-BLOCK-001` (file structure — §2 of the evidence
index), `OQ-BLOCK-002` (no durable delivery-state tracking exists; LEV-005,
LEV-009, LEV-011), `OQ-B2` (`ConversationController.generateAndSpeak` located),
`BQ-001` (authoritative artifact set = `artifacts/00…26` at this SHA),
`BQ-002` (package location — DEV-004).

---

## 8. Verification results (this increment)

Run from `airi/`, 2026-08-02. Exact commands and exact results:

| Command | Result |
|---|---|
| `pnpm -F @proj-airi/memory-domain typecheck` (`tsc --noEmit`) | ✅ clean |
| `pnpm -F @proj-airi/discord-bot typecheck` (`tsc --noEmit`) | ✅ clean |
| `pnpm exec moeru-lint packages/memory-domain services/discord-bot/src/memory services/discord-bot/src/config.ts` | ✅ 0 errors, 0 warnings |
| `vitest run` in `packages/memory-domain` | ✅ 10 files, **206 tests passed** |
| `vitest run` in `services/discord-bot` | ✅ 33 files, **365 tests passed** (330 pre-existing + 35 added) |
| `pnpm -F @proj-airi/memory-sqlite typecheck` | ✅ clean |
| `pnpm -F @proj-airi/memory-sqlite test` | ✅ 3 files, **20 tests passed against SQLite** |
| `pnpm exec moeru-lint packages/memory-sqlite` | ✅ 0 errors, 0 warnings |
| `git diff --check` | ✅ clean (line-ending conversion notices only) |

### IMP-201 implementation evidence

- Introduced schema version **1**, migration
  `001_initial_shared_memory_schema`, SHA-256
  `eb437ff3cf9bca1ab28719bff3d526d57e2f6bcdbb98ab48c545ec618518baf9`.
- The forward-only runner orders versions numerically, validates unique versions
  and immutable checksums, applies each migration under `BEGIN EXCLUSIVE`, and
  records history only inside the successful transaction.
- Reapplication is a no-op. Unknown future versions and altered applied
  checksums fail closed with `MemoryError(PERSISTENCE_FAILED)`.
- Foreign keys are enabled and verified per connection. WAL and busy-timeout
  policy remain deliberately unselected pending IMP-208 and OQ-BLOCK-003.
- Version 1 contains normalized identities, historical snapshots, scoped aliases
  and preferences, physical/logical rooms and bindings, ordered events and
  lifecycle transitions, context evidence and many-to-many generation causes,
  output segments and delivery attempts (including `unknown_after_crash`),
  layered memories, provenance, correction/supersession, worker jobs, forget
  requests, deletion tombstones, and quarantinable legacy migration evidence.
- Runtime composition and all 16 memory feature flags are unchanged and off.

Not run, and why:

| Command | Why not |
|---|---|
| Destructive down-migration tests | Not applicable: the approved plan is forward-only; recovery is snapshot restore, not reverse SQL. Restore rehearsal remains IMP-208. |
| Concurrency / failure-injection / crash-window suites | They exercise a persistence adapter that does not exist yet (IMP-207, IMP-208, IMP-406). |
| Deletion-propagation, backup restore-and-redelete drills | Require the repositories and the deletion executor (IMP-702, IMP-703). |
| Prompt-injection corpus, voice-interruption E2E, latency and cost benchmarks | Require the serializer and the live adapters (IMP-602, IMP-405, IMP-803). |
| Full monorepo `pnpm lint` / `pnpm test:run` | Not run: the unrelated upstream workspaces are outside this increment's blast radius and pre-existing failures there would obscure the result. The two workspaces this increment touches were linted and tested in full. |

Production behaviour at this commit is unchanged. The only edit to a file on a
running code path is `src/config.ts`, which gains a `memory` section whose 16
flags all default to `false`; no other production module reads it yet.

## 9. Gate status

| Gate | Status |
|---|---|
| Entry (IMP-001…003) | ✅ **passed this increment** |
| G1 Domain (IMP-101…108) | ✅ **passed this increment** — one contract package, no Discord/DB imports, conformance fixtures cover multi-speaker causality and partial delivery |
| G2 Persistence | 🚧 **in progress** — IMP-201 complete; IMP-202…208 remain, and OQ-BLOCK-003 still blocks IMP-208 sign-off |
| G3 Identity propagation | ⛔ not started; also blocked on FIND-010 |
| G4 Event/delivery | ⛔ not started |
| G5 Text/voice integration | ⛔ not started |
| G6 Context assembly | ⛔ not started |
| G7 Privacy controls | ⛔ not started |
| G8 Evaluation/release | ⛔ not started |
