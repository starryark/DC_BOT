# COMPILED_SPEC — IMP-606 lexical/full-text retrieval

## Identity

- **Repository:** `starryark/DC_BOT`
- **Requested ref:** `main`
- **Plan/reference identity:** runtime attachment `Plan(20260808-130243).md`, SHA-256 `752c4234fba26c1015d6bbdf4dc448718fc81c8a7e36040cedb538320c783ddd`. `ARTIFACT_FACTORY_REQUEST.md` describes this same runtime plan as `Pasted markdown(9).md` staged as `Plan.md`.
- **Embedded source-plan identity:** `Pasted markdown(8).md`, SHA-256 `dc185ec77bc1b6e8346ed46f58b3b1c09d428a6072a93cc82ac2133f9e96dd12`.
- **Analysis/pinned revision in plan:** `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`.
- **Fresh factory remote pin:** `1b0d3b50dd576dab8e09b624cd5dcf2677e77490` (`main`; no remote drift observed).
- **Historical performance-v2 measured-code revision:** `9afc7207f006ac327ff12e31e76633ee9f9c2606`.
- **Current candidate revision:** `UNRESOLVED` — no modifying checkout/candidate exists in this factory runtime.
- **Publication authority:** **local-only**. No branch creation, push, PR, issue/comment, label, merge, release, or other remote GitHub mutation is authorized.

## Objective

Implement the smallest correct SQLite-backed lexical retrieval path behind the existing `MemoryPort.searchMemory` contract such that authorization/scope/temporal eligibility is enforced before content-bearing lexical candidate generation, authoritative provenance and lifecycle semantics survive indexing, analyzer behavior is explicit/versioned, English/Japanese/Chinese/mixed-script retrieval is reproducibly measured, unsupported language capabilities fail explicitly, and vector/graph/on-demand/remote features remain outside IMP-606.

## Fact classes

| ID | Class | Statement | Source | Confidence |
|---|---|---|---|---|
| FACT-001 | OBSERVED | Fresh `main` resolves to `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`, matching the plan pin. | GitHub commit `main`, fresh factory read | High |
| FACT-002 | OBSERVED | `MemoryPort.searchMemory(auth, input)` already exists; `SearchMemoryInput`, `MemoryHit`, and `SearchMemoryOutput` are transport-neutral domain types and every port operation requires `AuthorizationContext`. | `airi/packages/memory-domain/src/port.ts` | High |
| FACT-003 | OBSERVED | Authorization is deny-by-default and explicitly requires authorization before candidates; `memory:search` is a named authorized operation. | `airi/packages/memory-domain/src/authorization.ts` | High |
| FACT-004 | OBSERVED | Retrieval capabilities distinguish `fulltext_latin`, `fulltext_cjk`, `vector_search`, and `graph_search`; `M1_SQLITE_CAPABILITIES` includes Latin but omits CJK. | `airi/packages/memory-domain/src/capabilities.ts` | High |
| FACT-005 | OBSERVED | SQLite migration registry contains versions 1–8 and ends at `generation_context_manifests`; direct schema inventory shows v1–v8 and no v9 at the factory pin. | `airi/packages/memory-sqlite/src/migrations/index.ts`; `src/schema/` inventory | High |
| FACT-006 | OBSERVED | Current SQLite implementation uses Node `node:sqlite`, WAL, `synchronous=FULL`, FKs, migrations, and a process-level writer ownership guard. | `connection-profile.ts`; `writer-ownership.ts` | High |
| FACT-007 | OBSERVED | Existing repository ownership includes events, deliveries/outputs, summaries, semantic/episodic/procedural memories, corrections, privacy/policy, and deletion targets; no lexical repository is exported at the pinned snapshot. | `src/repositories/index.ts`; direct repository inventory | High |
| FACT-008 | OBSERVED | Current Discord memory composition exposes ingress/trace/context/privacy authorities and current SQLite repositories but no lexical/search authority in the verified composition surface. | `airi/services/discord-bot/src/memory/runtime.ts` | High |
| FACT-009 | OBSERVED | `fulltextRetrieval` exists and defaults to `false`; vector, on-demand, relationship, and remote flags are separate and gated. | `feature-flags.ts` | High |
| FACT-010 | OBSERVED | Existing memory evaluation infrastructure includes contracts, dataset/tests, datasets, oracles, reports/redaction, runtime adapter, and performance family. | direct `airi/services/discord-bot/evals/memory/` inventory | High |
| FACT-011 | OBSERVED | Backlog IMP-606 formally names `IMP-201, IMP-601 query contract` as preconditions. | `artifacts/21-implementation-backlog.md` | High |
| FACT-012 | UNVERIFIED | Formal repository-owned acceptance evidence proving the IMP-601 prerequisite is satisfied at the candidate has not been established by this factory. The current evidence-index read did not expose an `IEV-601` row; that search miss alone is not proof of absence. | backlog + evidence-index investigation | High that it is unresolved |
| FACT-013 | OBSERVED | `docs/memory/CURRENT.md` still contains older performance-v1 IMP-803 wording, while the current HEAD/evidence-index records performance-v2 at `9afc7207...`; the status document is therefore not authoritative for that performance identity. | `CURRENT.md`; `evidence-index.md`; current HEAD patch | High |
| FACT-014 | OBSERVED | Factory host has `git 2.47.3`, Node `v22.16.0`, writable external output, and its bundled SQLite `3.49.1` can create FTS5 `unicode61` and `trigram` tables. | fresh local factory probe | High for factory host only |
| FACT-015 | OBSERVED | Factory host has no local DC_BOT checkout and no `pnpm`; Corepack cannot fetch pnpm and shell GitHub clone fails because network/DNS is unavailable. | fresh local factory probe | High |
| FACT-016 | UNVERIFIED | The Node/runtime version officially supported by the exact future IMP-606 candidate and its complete SQLite FTS feature set have not been proven in a runnable repository checkout. | execution gate | High that it is unresolved |
| FACT-017 | PROPOSED | If v8 remains highest immediately before implementation, the next additive migration is expected to be v9. The exact path `schema/v9.ts` is not an observed current file. | Plan TASK-002 | High as proposal |
| FACT-018 | PROPOSED | A SQLite lexical index/search repository, Discord retrieval authority, and retrieval-evaluation subdirectory are likely required; exact filenames remain `PROPOSED/UNRESOLVED` until ownership is proven. | Plan + fresh package inventories | High as proposal |
| FACT-019 | INFERRED | The current domain `M1_SQLITE_CAPABILITIES` constant cannot by itself be treated as the runtime capability advertisement because the composed Discord runtime has no lexical authority. | FACT-004 + FACT-008 | High |
| FACT-020 | INFERRED | IMP-606 can extend the existing evaluation family rather than introduce a separate framework because the repository already has a production-shaped memory evaluator/runtime adapter. | FACT-010 | High |

## Requirements

### REQ-001 — Reuse the existing retrieval contract
- **Behavior/deliverable:** implement lexical retrieval through existing `MemoryPort.searchMemory`; do not create a competing API or leak Discord/SQLite types into `memory-domain`.
- **Source:** Plan OBS-001, TASK-001; `port.ts`.
- **Acceptance evidence:** domain boundary/conformance tests; direct diff proving no second public retrieval API.

### REQ-002 — Enforce authorization before candidate generation
- **Behavior/deliverable:** authorization, exact scope, character/room eligibility, temporal state, deletion state, and other required policy predicates constrain the searchable universe at database/query construction time before content-bearing lexical lookup/ranking.
- **Source:** Plan INV-001/TASK-003; `authorization.ts`.
- **Acceptance evidence:** SQL/query-construction review plus negative cross-guild/cross-room/private probes showing no protected hit/count/snippet/rank leakage; no broad-search-then-filter path.

### REQ-003 — Freeze source/index eligibility before schema design
- **Behavior/deliverable:** resolve from repository-owned contracts which authoritative source record types and lifecycle states are index-eligible, including inbound events, eligible assistant output, summaries, facts, episodic/procedural data, historical/superseded state, and layer semantics.
- **Source:** Plan GATE-002; existing event/delivery/memory/lifecycle repositories.
- **Acceptance evidence:** source-backed eligibility matrix in implementation evidence; no unresolved eligibility assumption at schema commit.

### REQ-004 — Preserve migration history and use one additive migration
- **Behavior/deliverable:** v1-v8 and checksums remain unchanged; after re-pin, add only the next migration version required for lexical derived state.
- **Source:** Plan INV-007/TASK-002; current migration registry.
- **Acceptance evidence:** byte/logical checksum comparison; migration tests for clean install, v8→new upgrade, failed migration rollback.

### REQ-005 — Make derived index reconstruction deterministic
- **Behavior/deliverable:** lexical documents retain stable source IDs and versioned index/analyzer metadata and can be rebuilt deterministically from authoritative records.
- **Source:** Plan TASK-002/TASK-005.
- **Acceptance evidence:** repeat rebuild produces the same eligible-document identity set and version metadata from the same pinned authority.

### REQ-006 — Keep authoritative evidence text immutable
- **Behavior/deliverable:** original stored/display evidence remains unchanged; NFC is canonical; any NFKC/case-folding or other search normalization is derived data only.
- **Source:** Plan INV-002/TASK-004.
- **Acceptance evidence:** before/after source-record equality tests; analyzer tests showing derived keys do not alter returned authoritative evidence.

### REQ-007 — Use explicit, versioned analyzer profiles
- **Behavior/deliverable:** record analyzer/tokenizer identity/version; measure a Latin/word-tokenized candidate and CJK-capable no-space candidates such as trigram/character n-gram; preserve complete mixed-script queries.
- **Source:** Plan INV-003/TASK-004.
- **Acceptance evidence:** analyzer contract/tests plus benchmark manifest recording analyzer identity and language behavior.

### REQ-008 — Do not combine incomparable raw profile scores
- **Behavior/deliverable:** raw BM25/engine scores from distinct index/analyzer profiles are not directly summed; use deterministic tiers or a separately measured/calibrated rank-fusion method if multiple generators are combined.
- **Source:** Plan INV-004; retrieval specification.
- **Acceptance evidence:** ranking implementation review, tests, and benchmark metadata identifying any fusion method.

### REQ-009 — Preserve reconstructable provenance for every hit
- **Behavior/deliverable:** each returned hit can resolve to its authoritative source record and valid lineage.
- **Source:** Plan INV-005/TASK-003.
- **Acceptance evidence:** hit→source reconstruction tests across indexed record classes and deletion/correction states.

### REQ-010 — Synchronize lexical state with authoritative lifecycle
- **Behavior/deliverable:** create, redaction, deletion, correction, supersession, temporal expiration/current-state change, transaction rollback, and rebuild maintain derived lexical consistency.
- **Source:** Plan INV-006/TASK-005.
- **Acceptance evidence:** focused lifecycle matrix; immediate post-delete search; correction/current-state tests; rollback/orphan checks; deterministic rebuild.

### REQ-011 — Wire the runtime minimally and truthfully
- **Behavior/deliverable:** trace the existing authority/composition style and add only the minimal retrieval authority/adapter required to make the port reachable.
- **Source:** Plan TASK-006; current `runtime.ts`.
- **Acceptance evidence:** composition tests; diff limited to verified ownership; feature-disabled behavior equals prior runtime behavior.

### REQ-012 — Advertise only composed, evidenced capabilities
- **Behavior/deliverable:** runtime startup/health capability advertisement matches what the composed implementation can satisfy; unsupported CJK is typed/explicit rather than an empty-result masquerade.
- **Source:** Plan INV-008/TASK-006; `capabilities.ts`.
- **Acceptance evidence:** runtime advertisement tests and negative unsupported-capability tests tied to analyzer evidence.

### REQ-013 — Keep rollout default-off and non-goals disabled
- **Behavior/deliverable:** `fulltextRetrieval` remains false by default; vector, graph, learned reranking, on-demand recall, relationship hypotheses, and remote transport remain disabled/unmodified except where tests assert they remain out of scope.
- **Source:** Plan non-goals/INV-010/TASK-006.
- **Acceptance evidence:** feature-flag/default tests and diff audit.

### REQ-014 — Extend the existing memory evaluation family
- **Behavior/deliverable:** add retrieval-quality measurement within `airi/services/discord-bot/evals/memory/` ownership instead of a disconnected framework, using production-shaped runtime boundaries where appropriate.
- **Source:** Plan OBS-007/TASK-007; fresh eval inventory.
- **Acceptance evidence:** direct path ownership review, evaluator tests, package script/CLI placement verified before creation.

### REQ-015 — Freeze a multilingual retrieval dataset
- **Behavior/deliverable:** versioned dataset includes English, Japanese, Simplified Chinese, Traditional Chinese, mixed/code-switched, names/aliases, no-space text, temporal constraints, authorization-negative cases, and deletion/correction cases. Each judged query reconstructs authorized universe, expected evidence IDs, temporal state, and abstention/conflict state.
- **Source:** Plan TASK-007.
- **Acceptance evidence:** dataset schema tests, immutable identity/version/digest, slice inventory.

### REQ-016 — Report measurements without inventing policy
- **Behavior/deliverable:** report at least per-language recall, precision, latency, analyzer/index version, dataset identity/digest, and unsupported-language behavior; MRR/nDCG only where appropriate. Do not fabricate quality/latency thresholds or call measurements deployment approval/G8 pass.
- **Source:** Plan INV-009/TASK-007/TASK-008.
- **Acceptance evidence:** report schema/output review; no unapproved threshold use; explicit measured-not-policy language.

### REQ-017 — Produce reproducible candidate evidence
- **Behavior/deliverable:** freeze exact implementation candidate, migration/index/analyzer versions, dataset digest, commands/cwd/exit codes/tool versions, test and benchmark results, supported/unsupported capability claims, and limitations.
- **Source:** Plan TASK-008/verification ladder.
- **Acceptance evidence:** content-addressable evidence bundle from a clean pinned candidate outside worktree where required.

### REQ-018 — Require independent verification and falsification
- **Behavior/deliverable:** candidate is evaluated by separate fresh-context verification and falsification paths that do not receive implementer reasoning transcript.
- **Source:** artifact contract; Plan STOP-013.
- **Acceptance evidence:** independent `VERIFICATION_REPORT` and `FALSIFICATION_REPORT` both PASS every required criterion; otherwise final verdict is FAIL/INCOMPLETE.

### REQ-019 — Preserve publication authority
- **Behavior/deliverable:** no remote GitHub mutation under this task; a local commit may be created only when needed to freeze reproducible evidence.
- **Source:** Plan task identity/publication authority; factory request.
- **Acceptance evidence:** git/GitHub audit; no remote branch/PR/issue/comment/label/merge/release created.

## Invariants

### INV-001 — Authorization precedes content-bearing retrieval
- **Invariant:** no unauthorized row may become a lexical candidate, rank feature, snippet, count, cache item, or log record.
- **Why it matters:** late filtering leaks protected information through existence, rank/count/timing/log side channels.
- **Violation detection:** query-plan/code inspection plus negative scope probes and telemetry/log assertions.

### INV-002 — Authoritative evidence is immutable
- **Invariant:** indexing never rewrites source evidence; normalization is derived.
- **Why it matters:** retrieved evidence must remain auditable and faithfully reconstructable.
- **Violation detection:** source-row digests before/after index build/query/rebuild; display-hit equality tests.

### INV-003 — CJK support is measured, not inferred
- **Invariant:** no `fulltext_cjk` claim without analyzer evidence for the claimed scope; whitespace-only tokenization is insufficient evidence.
- **Why it matters:** a false empty result is indistinguishable from “the user never said this.”
- **Violation detection:** language-sliced no-space tests and runtime capability/evidence cross-check.

### INV-004 — Cross-profile score scales remain incomparable unless calibrated
- **Invariant:** raw scores from distinct index/analyzer profiles are never directly added.
- **Why it matters:** raw BM25/engine scales have no guaranteed common magnitude.
- **Violation detection:** ranking-code review and adversarial result-order tests under score rescaling.

### INV-005 — Provenance is reconstructable
- **Invariant:** every hit maps to an authoritative source record and lineage.
- **Why it matters:** retrieval without source evidence cannot support correction/deletion/audit.
- **Violation detection:** hit-source reconstruction tests and orphan-index integrity checks.

### INV-006 — Derived lexical state follows source lifecycle atomically
- **Invariant:** deletion/redaction/correction/supersession/temporal changes/rollback/rebuild cannot expose stale protected content as current.
- **Why it matters:** stale indexes bypass authoritative governance and semantics.
- **Violation detection:** lifecycle matrix including failure injection and immediate post-change search.

### INV-007 — Migration history is immutable
- **Invariant:** v1-v8 SQL/checksums remain unchanged.
- **Why it matters:** deployed migration identity must remain reproducible.
- **Violation detection:** git diff/hash comparison and migration-runner tests.

### INV-008 — Advertisement equals composed evidence
- **Invariant:** a capability is advertised only when the active composed adapter and analyzer evidence satisfy it.
- **Why it matters:** capability negotiation must fail loudly rather than misrepresent semantics.
- **Violation detection:** startup/health advertisement tests against actual adapter configuration and benchmark evidence.

### INV-009 — Measurement is not policy
- **Invariant:** no retrieval measurement is converted into a policy threshold, G8 pass, deployment approval, or unrelated performance approval without an approved policy artifact.
- **Why it matters:** evidence identity and governance must not be conflated.
- **Violation detection:** report/evidence audit and absence of fabricated threshold documents/bounds.

### INV-010 — IMP-606 scope remains lexical-only and default-off
- **Invariant:** vector/graph/learned reranking/on-demand/relationship/remote features are not activated and `fulltextRetrieval` remains default false.
- **Why it matters:** prevents hidden scope expansion and bypass of separately gated work.
- **Violation detection:** diff/flag/config tests and runtime posture comparison.

## Task DAG

### TASK-001 — Freeze retrieval conformance
- **depends_on:** `GATE-001`, `GATE-002`.
- **Exact path/symbol if verified:** `airi/packages/memory-domain/src/port.ts::{SearchMemoryInput,MemoryHit,SearchMemoryOutput,MemoryPort.searchMemory}`; `capabilities.ts`; `authorization.ts`; focused domain tests reached from these files.
- **Allowed modifications:** focused conformance tests and minimal contract clarifications only if repository evidence requires them; existing public contract is to be reused.
- **Forbidden modifications:** second retrieval API; Discord/SQLite type leakage; unauthorized overload.
- **Acceptance criteria:** authorization, exact scope, room semantics, layers, `since`/`until`, modes, deterministic rank features, pagination/cursor, unsupported capability, abstention behavior are locked by tests.
- **Verification:** focused domain tests + domain typecheck/test + boundary tests.
- **Output evidence:** conformance-test list, command results, exact contract diff.

### TASK-002 — Add additive lexical-index schema
- **depends_on:** `TASK-001`, `GATE-003`.
- **Exact path/symbol if verified:** migration registry `airi/packages/memory-sqlite/src/migrations/index.ts`; current `src/schema/` ends at v8. Future migration path is **PROPOSED/UNRESOLVED** until re-pin; `schema/v9.ts` is only an expected candidate if v8 is still highest.
- **Allowed modifications:** one additive migration; versioned analyzer/index metadata; deterministic derived lexical storage.
- **Forbidden modifications:** any v1-v8 SQL/checksum rewrite; monolithic mutable transcript index that loses source identity.
- **Acceptance criteria:** clean install, prior→new upgrade, unchanged old checksums, deterministic rebuild, failure leaves no partial state.
- **Verification:** migration-runner/focused schema tests; SQLite full package tests.
- **Output evidence:** migration number/name/checksum, upgrade matrix, rollback/rebuild results.

### TASK-003 — Implement authorization-safe SQLite lexical retrieval
- **depends_on:** `TASK-002`.
- **Exact path/symbol if verified:** existing repository ownership under `airi/packages/memory-sqlite/src/repositories/`; exact new lexical repository/query filename **PROPOSED/UNRESOLVED**.
- **Allowed modifications:** minimal repository/query/index population code in proven SQLite ownership plus necessary exports.
- **Forbidden modifications:** broad lexical search followed by application-side authorization filtering; provenance loss.
- **Acceptance criteria:** cross-guild/room/private probes leak zero protected information; temporal/deletion predicates apply before ranking; every hit resolves to source.
- **Verification:** real-SQLite focused negative/positive tests; query/design review; package typecheck/test.
- **Output evidence:** query predicate map, scope-negative test matrix, source-resolution evidence.

### TASK-004 — Implement explicit analyzer profiles
- **depends_on:** `TASK-003`.
- **Exact path/symbol if verified:** exact analyzer module filename **PROPOSED/UNRESOLVED**; SQLite runtime currently uses `node:sqlite` through `connection-profile.ts`/`writer-ownership.ts`.
- **Allowed modifications:** derived normalization/tokenization profiles and version metadata; benchmark candidate analyzers.
- **Forbidden modifications:** source-text mutation; silent CJK fallback; raw cross-profile score sum.
- **Acceptance criteria:** claimed Latin cases work; Japanese/Chinese/mixed use a capable measured profile or explicit unsupported failure; analyzer version visible.
- **Verification:** Unicode/analyzer unit tests and multilingual benchmark slices under candidate runtime.
- **Output evidence:** analyzer IDs/configs, FTS feature probe, per-slice behavior.

### TASK-005 — Make index lifecycle correct
- **depends_on:** `TASK-003`, `TASK-004`, `GATE-004`.
- **Exact path/symbol if verified:** existing lifecycle owners include `repositories/{events,deliveries,outputs,memories,summaries,corrections,privacy}.ts`, `deletion-targets.ts`, provenance/UoW paths; exact lexical hooks **PROPOSED/UNRESOLVED**.
- **Allowed modifications:** lifecycle hooks/transactions/rebuild logic required to keep derived lexical state synchronized.
- **Forbidden modifications:** weakening deletion/correction/temporal rules; asynchronous stale window that violates immediate current-search semantics unless source policy explicitly permits it.
- **Acceptance criteria:** delete cannot return deleted text; current search omits superseded text; historical semantics remain correct where permitted; failed writes create no orphan docs; rebuild reproduces eligible set.
- **Verification:** lifecycle matrix with failure injection, rollback, rebuild, and source integrity checks.
- **Output evidence:** lifecycle coverage table and orphan/rebuild integrity results.

### TASK-006 — Wire runtime retrieval truthfully
- **depends_on:** `TASK-001` through `TASK-005`.
- **Exact path/symbol if verified:** current composition root `airi/services/discord-bot/src/memory/runtime.ts`; rollout policy `feature-flags.ts`; exact future search-authority field/file and actual capability advertisement path **UNRESOLVED until traced**.
- **Allowed modifications:** smallest composition wiring/health advertisement needed for lexical retrieval behind existing flag.
- **Forbidden modifications:** default flag enablement; vector/graph/on-demand/relationship/remote activation; unrelated active-memory behavior changes.
- **Acceptance criteria:** advertisement matches implementation; unsupported CJK is typed; flag-off restores prior behavior.
- **Verification:** focused runtime/feature/config tests + Discord typecheck/test.
- **Output evidence:** call/composition map, advertisement snapshot, flag-on/off comparison.

### TASK-007 — Produce IMP-606 multilingual baseline
- **depends_on:** `TASK-004` through `TASK-006`.
- **Exact path/symbol if verified:** extend `airi/services/discord-bot/evals/memory/`; existing `contracts.ts`, `dataset.ts`, `oracles/`, `report*`, `runtime-adapter.ts`; exact new retrieval-eval subpath/CLI **PROPOSED/UNRESOLVED** until package conventions prove it.
- **Allowed modifications:** versioned retrieval dataset, evaluator/oracle/report/CLI tests and minimal package script after ownership verification.
- **Forbidden modifications:** replacing existing evaluation family; borrowing performance-v2 thresholds/metric semantics; fixtures designed to favor patch.
- **Acceptance criteria:** required language/scope/lifecycle slices; per-language recall/precision/latency plus metadata and explicit unsupported behavior; MRR/nDCG only where suitable.
- **Verification:** dataset/contracts/report/CLI tests; deterministic rerun at fixed seed/input/candidate; independent evaluation.
- **Output evidence:** dataset digest/version, analyzer/index version, content-minimized measurements/report.

### TASK-008 — Evidence and handoff
- **depends_on:** `TASK-001` through `TASK-007`, `GATE-006`.
- **Exact path/symbol if verified:** evidence/docs targets must be selected from repository-owned evidence conventions after candidate verification; do not overstate `docs/memory/CURRENT.md`.
- **Allowed modifications:** local evidence/docs only after independent PASS.
- **Forbidden modifications:** product code; remote publication; CJK/G8/deployment/vector claims beyond evidence.
- **Acceptance criteria:** exact candidate SHA, versions, dataset digest, commands/cwd/results, benchmark output, capabilities/limitations recorded; IMP-804 may then be described as unblocked.
- **Verification:** independent reports + promotion audit + documentation identity check.
- **Output evidence:** final run manifest/evidence hashes and `PROMOTION_AUDIT`.

## Gates

### GATE-000 — Execution capability preflight
- **Precondition:** before repository modification, required host capabilities are probed, not assumed.
- **Required evidence:** checkout + HEAD/status; shell; git; declared package manager; compatible Node/runtime; writable external evidence directory; fresh-context/direct-child routes.
- **PASS:** all capabilities required by the next task are actually available and version-compatible.
- **FAIL:** an available capability is proven incompatible with a mandatory requirement and no approved fallback exists.
- **INCOMPLETE:** required capability cannot be exercised/proven.
- **Downstream tasks blocked:** all modifying tasks.
- **Factory verdict:** **INCOMPLETE** — no checkout, no pnpm; direct-child launcher unavailable. Shell/git/Node/external output are available.

### GATE-001 — Re-pin repository/worktree state
- **Precondition:** immediately before edits.
- **Required evidence:** remote `main`, local HEAD, clean/dirty status, unrelated changes preserved, affected reads refreshed if drift.
- **PASS:** remote/local identity recorded and any drift re-read.
- **FAIL:** edits would overwrite unrelated work or proceed against known stale source.
- **INCOMPLETE:** local checkout/head/status unavailable.
- **Downstream tasks blocked:** TASK-001 onward.
- **Factory verdict:** **INCOMPLETE** overall; remote sub-check PASS at `1b0d3b50...`, local worktree component unavailable.

### GATE-002 — Freeze contract and index eligibility
- **Precondition:** before schema/index work.
- **Required evidence:** current search contract; authorization/scope semantics; formal IMP-601 prerequisite evidence; authoritative index-eligibility matrix by record/lifecycle type.
- **PASS:** all named inputs are source-backed and unambiguous.
- **FAIL:** repository policy proves the proposed index universe violates authorization/lifecycle semantics.
- **INCOMPLETE:** formal prerequisite or eligibility is not resolved.
- **Downstream tasks blocked:** TASK-001/TASK-002/TASK-003 and all dependents.
- **Factory verdict:** **INCOMPLETE** — contract/auth are verified; formal IMP-601 acceptance and complete eligibility matrix remain unresolved.

### GATE-003 — Verify SQLite FTS capability
- **Precondition:** before committing to selected FTS5 schema/analyzers.
- **Required evidence:** actual repository-supported candidate Node/SQLite runtime and selected FTS5 features/tokenizers exercised.
- **PASS:** all required features work in the authoritative candidate runtime.
- **FAIL:** required feature is unavailable/incompatible and no approved design fallback satisfies requirements.
- **INCOMPLETE:** only a non-authoritative host probe exists or candidate runtime is unavailable.
- **Downstream tasks blocked:** TASK-002 onward.
- **Factory verdict:** **INCOMPLETE** — factory host SQLite 3.49.1 passes `unicode61`/`trigram`, but no runnable candidate checkout/runtime is established.

### GATE-004 — Lifecycle design review
- **Precondition:** before activation/wiring.
- **Required evidence:** design/tests for deletion, redaction, correction, supersession, temporal validity, rollback, rebuild, provenance.
- **PASS:** no required lifecycle path can leave current derived search stale/unauthorized and failure behavior is atomic/recoverable.
- **FAIL:** a demonstrated path leaks stale/protected content or breaks authoritative lifecycle semantics.
- **INCOMPLETE:** design or execution evidence is missing.
- **Downstream tasks blocked:** TASK-005/TASK-006/TASK-007/TASK-008.
- **Factory verdict:** **INCOMPLETE** — no implementation/design candidate exists.

### GATE-005 — Analyzer evidence
- **Precondition:** before capability advertisement/promotion.
- **Required evidence:** versioned multilingual analyzer benchmark tied to exact candidate/dataset.
- **PASS:** each advertised capability/language scope has matching evidence.
- **FAIL:** advertised capability fails required semantic cases.
- **INCOMPLETE:** required language/analyzer evidence was not executed.
- **Downstream tasks blocked:** capability promotion and TASK-008; CJK claim remains disabled.
- **Factory verdict:** **INCOMPLETE** — no IMP-606 analyzer artifact supplied or generated.

### GATE-006 — Independent candidate verification
- **Precondition:** TASK-001 through TASK-007 complete and exact candidate frozen.
- **Required evidence:** clean candidate identity, verification report, falsification report, exact test/benchmark artifacts.
- **PASS:** both independent paths PASS every required rubric criterion.
- **FAIL:** any required criterion fails.
- **INCOMPLETE:** candidate/evidence/independent path missing or incompatible.
- **Downstream tasks blocked:** TASK-008 promotion.
- **Factory verdict:** **INCOMPLETE** — no candidate exists.

### GATE-007 — Evidence/documentation promotion compliance
- **Precondition:** GATE-006 PASS.
- **Required evidence:** candidate/evidence hashes, docs/evidence diff, publication audit.
- **PASS:** claims exactly match evidence and local-only authority is respected.
- **FAIL:** docs overclaim, identity is wrong, or unauthorized publication occurs.
- **INCOMPLETE:** promotion evidence not yet produced.
- **Downstream tasks blocked:** final IMP-606 completion claim.
- **Factory verdict:** **INCOMPLETE** for promotion; **PASS** for current no-remote-mutation compliance.

## Stop conditions

### STOP-001 — Unreconciled repository drift
If `main`/candidate moves and affected sources are not re-read, stop `INCOMPLETE`; report old/new SHA and required refresh set.

### STOP-002 — Missing local execution capability
If checkout/shell/git/package manager/runtime required for the next modifying/verification task is unavailable, stop `INCOMPLETE/BLOCKED`; never simulate commands.

### STOP-003 — IMP-601 prerequisite unverifiable
If formal IMP-601 query-contract acceptance cannot be established from repository-owned evidence, stop before modification and report the exact missing evidence.

### STOP-004 — Index eligibility unresolved
If authoritative source/lifecycle eligibility cannot be resolved, stop before schema/index design; do not invent policy.

### STOP-005 — Authorization would be post-filtered
If design requires broad unauthorized retrieval followed by application filtering, stop `FAIL` and redesign.

### STOP-006 — Required FTS unavailable
If selected FTS/tokenizer capability is unavailable in the supported candidate runtime, stop and report evidence; do not fake compatibility.

### STOP-007 — Existing migrations would need rewriting
If implementation requires changing v1-v8 or their checksums, stop `FAIL`.

### STOP-008 — Lifecycle can expose stale protected text
If deletion/redaction/correction/supersession/temporal changes can leave stale current results, stop `FAIL` before advertisement.

### STOP-009 — Unevidenced CJK advertisement
If CJK capability would be advertised without passing analyzer evidence, stop `FAIL`; keep it unsupported.

### STOP-010 — Invented benchmark policy
If a pass requires fabricating a retrieval threshold/policy bound, stop `FAIL/INCOMPLETE` as appropriate and report measurements only.

### STOP-011 — Forbidden feature side effect
If vector/graph/on-demand/relationship/remote behavior is activated by the change, stop `FAIL` and remove the side effect.

### STOP-012 — Unrelated user work at risk
If implementation requires discarding/overwriting unrelated local changes, stop `BLOCKED` and preserve them.

### STOP-013 — Independent verification unavailable
If required independent verification/falsification cannot actually run, final decision is at most `INCOMPLETE`; do not impersonate an independent evaluator in the implementer context.

## Definition of done

IMP-606 is done only when all of the following are reconstructable from source and evidence:

1. exact `main`/local/candidate identities are pinned and worktree state is recorded;
2. formal IMP-601 prerequisite and authoritative index eligibility are proven;
3. existing `MemoryPort.searchMemory` semantics are covered by focused conformance tests;
4. one additive post-v8 migration (or the then-current next version) installs/upgrades/rolls back without altering prior migration identity;
5. SQLite lexical candidate generation is authorization/scope/temporal/lifecycle constrained before ranking and returns reconstructable provenance;
6. source evidence remains immutable and analyzer/index versions are explicit;
7. lifecycle tests cover create/redact/delete/correct/supersede/time/rollback/rebuild with no stale current results;
8. runtime composition is reachable behind default-off `fulltextRetrieval`, advertises only evidenced capabilities, and leaves forbidden features disabled;
9. a frozen multilingual dataset and exact candidate produce reproducible per-language retrieval measurements and explicit unsupported behavior without fabricated policy thresholds;
10. memory-domain, memory-sqlite, Discord focused/full tests, typechecks, verified lint route, and `git diff --check` pass at the exact candidate;
11. independent verification and independent falsification both PASS the complete rubric;
12. evidence/docs name the correct candidate, versions, dataset/analyzer identities, limitations, and do not claim G8/deployment/vector/CJK outcomes beyond evidence;
13. no remote GitHub mutation occurs under the present local-only authority.

**Factory readiness:** the first modifying task is **BLOCKED** because GATE-000, GATE-001, and GATE-002 are currently `INCOMPLETE`.
