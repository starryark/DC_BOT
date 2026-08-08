# Plan — IMP-606 Lexical / Full-Text Retrieval with Multilingual Measurement

## 1. Task identity

- **Repository:** `starryark/DC_BOT`
- **Requested ref:** `main`
- **Analysis/pinned revision:** `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`
- **Source plan:** supplied `Pasted markdown(8).md`
- **Source-plan SHA-256:** `dc185ec77bc1b6e8346ed46f58b3b1c09d428a6072a93cc82ac2133f9e96dd12`
- **Bundle architecture:** single-layer, evidence-gated orchestration
- **Publication authority:** local-only. No branch creation, push, PR, issue/comment, label, merge, or other GitHub mutation is authorized by this plan.

The attached reusable bundle was validated against `BUNDLE_MANIFEST.json`; its canonical file hashes and byte counts match the uploaded files.

The bundle's DC\_BOT repository seed at `1131327cdb7b0878a32127424a7b4723ca92b0e8` is historical context only. This plan is re-grounded at `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`.

## 2. Decision

The next retrieval implementation increment should be:

**IMP-606 — Implement lexical/full-text retrieval with multilingual measurement.**

The dependency sequence is:

**current durable-memory/context foundation → IMP-606 lexical retrieval → IMP-804 multilingual/CJK benchmark → optional IMP-607 vector experiment only if lexical evidence justifies it.**

Do **not** describe the preceding state as simply "`IMP-803 complete`."

The accurate performance state is:

- the original `performance-v1` IMP-803 measurement is superseded;
- a `performance-v2` baseline was measured at `9afc7207f006ac327ff12e31e76633ee9f9c2606`;
- the evidence was recorded at `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`;
- its disposition is `correctness_clean_measured_not_evaluated`;
- therefore it is a valid measurement baseline, not an approved threshold-policy result.

That unresolved performance-policy status is a separate evaluation/governance track. The approved backlog does not list an IMP-803 threshold-policy pass as an IMP-606 prerequisite.

## 3. Source-of-truth corrections

### OBSERVED

**OBS-001 — Existing retrieval contract**

`airi/packages/memory-domain/src/port.ts` already publishes a transport-neutral `MemoryPort.searchMemory` contract with:

- query;
- authorization scope;
- memory layers;
- requested retrieval modes;
- temporal bounds;
- pagination;
- deterministic rank features;
- explicit abstention states.

Every `MemoryPort` operation takes an `AuthorizationContext`.

IMP-606 must implement this contract rather than introduce a second retrieval API.

**OBS-002 — Capability model**

`airi/packages/memory-domain/src/capabilities.ts` already separates:

- `fulltext_latin`;
- `fulltext_cjk`;
- `vector_search`;
- `graph_search`.

CJK-aware queries are detected separately, and `fulltext_cjk` is absent from the M1 SQLite capability set until an analyzer/tokenizer has evidence.

`vector_search` and `graph_search` remain gated.

**OBS-003 — Capability inconsistency to audit**

The domain-level `M1_SQLITE_CAPABILITIES` constant currently includes `fulltext_latin`, but the running Discord memory composition has no lexical-search authority or `searchMemory` implementation.

Do not assume this constant is necessarily the runtime advertisement path. Trace the real advertisement/composition path before changing it.

The invariant is:

> A backend may advertise a capability only when the composed implementation actually satisfies it.

**OBS-004 — SQLite state**

The migration registry currently ends at schema **v8**, `generation_context_manifests`.

No v9 migration exists at the pinned revision.

**OBS-005 — Runtime state**

`airi/services/discord-bot/src/memory/runtime.ts` currently composes durable authorities/repositories for identity, rooms, bindings, events, generations, causality, outputs/deliveries, recent context, privacy and related policy data.

It does not expose a lexical/full-text search authority.

**OBS-006 — Rollout flag**

`fulltextRetrieval` already exists as a rollout flag and defaults to `false`.

IMP-606 does not need a new top-level feature concept. It needs a truthful implementation behind the existing concept.

**OBS-007 — Evaluation infrastructure**

`airi/services/discord-bot/evals/memory/` already contains dataset, contract, oracle, report, runtime and performance infrastructure.

IMP-606 should extend that evaluation family rather than create an unrelated benchmark framework.

### INFERRED

**INF-001 — IMP-601 precondition**

The repository contains the required transport-neutral query shape and an authorization-aware current context implementation. That is strong evidence that the IMP-601 query-contract prerequisite exists in code.

Because repository status documents have historically lagged the implementation, the executor must confirm the exact formal acceptance evidence before declaring the backlog prerequisite satisfied.

### PROPOSED

**PROP-001 — Schema v9**

The lexical index will probably require an additive schema **v9**.

`schema/v9.ts` is a proposed path, not an observed repository fact.

**PROP-002 — New retrieval adapter/repository**

A SQLite lexical search repository/indexer and Discord/runtime search authority will probably be required.

Exact filenames and ownership must be established from current package conventions before creation.

## 4. Objective

Implement the smallest correct SQLite-backed lexical retrieval path that:

1. satisfies the existing `MemoryPort.searchMemory` contract;
2. applies authorization and temporal/scope restrictions before protected content becomes searchable;
3. preserves source provenance;
4. provides explicit, versioned analyzer behavior;
5. measures English, Japanese, Chinese and mixed-script retrieval;
6. truthfully advertises only analyzer capabilities supported by evidence;
7. keeps vector, graph and automatic/on-demand recall outside this increment.

IMP-606 is complete only when its implementation and multilingual measurements are reproducible from a pinned candidate.

It does **not** need to claim that every language is supported. A measured unsupported language is an acceptable result; a falsely advertised language is not.

## 5. Non-goals

IMP-606 SHALL NOT:

- add vector retrieval;
- add learned reranking;
- add graph retrieval;
- enable relationship hypotheses;
- enable on-demand recall;
- introduce a standalone Memory Runtime;
- change the topology decision owned by IMP-806;
- enable `fulltextRetrieval` by default;
- fabricate retrieval-quality or latency thresholds;
- rewrite migrations v1-v8 or their checksums;
- weaken deletion, correction, authorization or temporal semantics;
- treat a benchmark result as deployment approval;
- modify unrelated provider, voice, generation or delivery behavior.

## 6. Invariants

### INV-001 — Authorization before retrieval

Authorization/scope restriction must execute before any content-bearing lexical lookup that could expose protected terms.

Fetching broad results and filtering unauthorized hits in application code is forbidden.

This protects against leakage through:

- hit existence;
- result counts;
- snippets;
- ranks;
- timing;
- logs;
- caches.

### INV-002 — Original evidence is immutable

Original stored text remains unchanged.

Search normalization is derived data.

- NFC is the canonical search/display normalization.
- NFKC and case folding may only produce derived search keys.
- Search processing must never silently rewrite the authoritative evidence shown to a user.

### INV-003 — CJK is measured, not assumed

Whitespace tokenization alone is unacceptable for CJK.

At minimum the implementation/evaluation must compare appropriate candidates such as:

- word-aware segmentation where available;
- character bi/trigrams;
- SQLite FTS5 trigram;
- exact/substring alias paths where appropriate.

Tokenizer/analyzer identity is versioned.

### INV-004 — Scores from different profiles are not directly additive

If more than one FTS/index profile produces candidates, do not add raw BM25 or other engine-specific scores.

Use deterministic tiers or a measured rank-fusion/calibrated approach.

### INV-005 — Provenance survives retrieval

Every hit must identify the authoritative source record from which it was indexed.

A search result with no reconstructable source evidence is invalid.

### INV-006 — Index lifecycle follows source lifecycle

Deletion, redaction, correction, supersession and temporal invalidation must prevent stale/currently unauthorized evidence from continuing to appear as current search results.

### INV-007 — Existing migration history is immutable

Migrations v1-v8 and their checksums remain byte/logically unchanged.

Only an additive migration may introduce new durable schema.

### INV-008 — Capability advertisement is evidence-backed

- Latin capability requires a passing Latin-capable implementation.
- CJK capability requires passing analyzer evidence for the claimed scope.
- A failed CJK benchmark means `fulltext_cjk` remains unsupported.
- Unsupported capability requests must fail explicitly rather than masquerade as empty search results.

### INV-009 — Retrieval measurements are not policy thresholds

If no approved retrieval-quality/latency policy supplies bounds, report measurements only.

Do not invent pass/fail thresholds from:

- the existing performance-v2 benchmark;
- baseline values;
- workload digests;
- implementation convenience.

## 7. Execution gates

### GATE-000 — Execution capability preflight

Before any repository modification, record whether the execution host actually has:

- a local checkout of `starryark/DC_BOT`;
- shell/process execution;
- `git`;
- the repository-declared package manager;
- compatible Node/runtime;
- writable output outside the repository checkout;
- fresh-context/direct-child execution needed by the attached orchestration bundle.

Missing required execution capability yields `INCOMPLETE/BLOCKED`.

Do not simulate a command that was not run.

### GATE-001 — Re-pin repository state

Immediately before edits:

1. resolve `main`;
2. record current HEAD;
3. record worktree status;
4. preserve unrelated user changes;
5. compare HEAD with this plan's pinned `1b0d3b50...`.

If HEAD moved, re-read every affected contract/runtime/migration/evaluation surface and record the drift before proceeding.

### GATE-002 — Freeze contract and index eligibility

Before writing the index schema:

- verify the current `SearchMemoryInput`, `MemoryHit`, `SearchMemoryOutput` and retrieval-mode contracts;
- verify authorization/scope semantics;
- determine exactly which authoritative source record types are eligible for lexical indexing;
- determine treatment of assistant outputs, summaries, facts and historical/superseded records from repository-owned contracts.

Do not invent an index-eligibility policy merely to make FTS convenient.

### GATE-003 — Verify SQLite FTS capability

Before committing to an FTS5 schema, verify the actual Node/SQLite runtime used by this repository supports the selected FTS5 features/tokenizers.

If the required SQLite capability is unavailable, stop and record the evidence rather than creating a fake compatibility layer.

### GATE-004 — Lifecycle design review

Before activation/wiring, prove the design can correctly handle:

- deletion/redaction;
- correction/supersession;
- temporal validity;
- transaction rollback;
- rebuild/reindex;
- source-provenance reconstruction.

Failure here blocks capability advertisement.

### GATE-005 — Analyzer evidence

CJK capability remains disabled until measured analyzer results exist.

A Latin-only successful implementation may proceed with `fulltext_cjk` explicitly unsupported if the IMP-606 completion evidence truthfully records the limitation.

## 8. Task DAG

### TASK-001 — Freeze retrieval conformance

**Depends on:** GATE-001, GATE-002

Reuse the existing domain retrieval contract.

Add or extend focused tests covering:

- authorization;
- exact scope;
- logical/physical room rules as applicable;
- layer selection;
- temporal `since`/`until`;
- retrieval modes;
- deterministic rank features;
- cursor/pagination behavior;
- explicit unsupported capabilities;
- abstention behavior.

**Acceptance:**

- no Discord or SQLite types leak into `memory-domain`;
- adapter semantics match the existing port;
- unauthorized scope has no alternate overload/path.

### TASK-002 — Add additive lexical-index schema

**Depends on:** TASK-001, GATE-003

Add the next migration after v8; expected version is **v9** if no intervening migration appears after re-pin.

Requirements:

- leave v1-v8 untouched;
- version analyzer/index metadata;
- index evidentiary units rather than one mutable monolithic transcript;
- retain stable source identifiers;
- make index reconstruction deterministic;
- define rebuild/version-migration behavior.

**Acceptance:**

- clean install succeeds;
- v8→new-version upgrade succeeds;
- old migration checksums are unchanged;
- index reconstruction from authoritative records is deterministic;
- failed migration/index transaction leaves no partial durable state.

### TASK-003 — Implement authorization-safe SQLite lexical retrieval

**Depends on:** TASK-002

Implement the SQLite repository/adapter that populates and queries authorized lexical documents.

Authorization, character/room scope, temporal state, deletion state and other required predicates must constrain the searchable candidate universe at the database/query construction layer.

Do not implement:

`search everything → rank → remove unauthorized rows`.

Preserve source IDs and sufficient metadata to reconstruct each result.

**Acceptance:**

- cross-guild probes return zero protected information;
- cross-room probes return zero protected information;
- private/public scope probes return zero protected information;
- temporal filtering is enforced before ranking;
- returned provenance resolves to authoritative source records.

### TASK-004 — Implement explicit analyzer profiles

**Depends on:** TASK-003

Implement versioned search normalization/analyzer profiles.

Requirements:

- preserve original text exactly;
- NFC canonical normalization;
- optional derived NFKC/case-folded keys only where justified;
- benchmark a `unicode61`-style profile for word-tokenized text;
- benchmark trigram/character-n-gram approaches for Japanese/Chinese/mixed/no-space text;
- preserve full original mixed-script query;
- record analyzer/tokenizer version;
- never combine incomparable raw scores.

**Acceptance:**

- English cases work under their claimed profile;
- Japanese/Chinese/mixed queries use a capable candidate or return explicit unsupported capability;
- no silent CJK fallback to an incapable tokenizer;
- analyzer version is visible in evaluation evidence.

### TASK-005 — Make index lifecycle correct

**Depends on:** TASK-003, TASK-004, GATE-004

Tie derived lexical state to authoritative durable lifecycle.

Required cases:

- new eligible source record;
- redaction;
- deletion;
- correction;
- supersession;
- temporal expiration/current-state change;
- transaction rollback;
- index rebuild.

**Acceptance:**

- delete → immediate authorized search cannot return deleted material;
- corrected current-state search does not return superseded text as current;
- historical/as-of semantics remain correct where the contract permits them;
- failed writes do not create orphan FTS documents;
- rebuild reproduces the same eligible document set.

### TASK-006 — Wire runtime retrieval truthfully

**Depends on:** TASK-001 through TASK-005

Trace the actual current Discord composition path before choosing filenames.

Add the smallest search authority/adapter necessary to make the existing retrieval contract reachable.

Requirements:

- keep `fulltextRetrieval` false by default;
- do not activate `onDemandRecall`;
- do not activate vector or graph features;
- audit the actual capability advertisement path;
- advertise only capabilities the composed adapter satisfies.

Do not assume `src/memory/runtime.ts` must grow a particular field or class name. Verify the existing authority pattern first.

**Acceptance:**

- startup advertisement equals real implementation;
- unsupported CJK returns `UNSUPPORTED_CAPABILITY` or the repository's equivalent typed failure;
- disabling full-text retrieval restores the prior runtime behavior;
- current active-memory semantics are otherwise unchanged.

### TASK-007 — Produce the IMP-606 multilingual baseline

**Depends on:** TASK-004 through TASK-006

Extend the existing `airi/services/discord-bot/evals/memory/` infrastructure.

Create a frozen, versioned retrieval dataset with at least:

- English;
- Japanese;
- Simplified Chinese;
- Traditional Chinese;
- mixed-script/code-switched queries;
- names and aliases;
- no-space text;
- temporal constraints;
- authorization-negative cases;
- deletion/correction cases.

Each judged query should retain enough information to reconstruct:

- authorized universe;
- expected evidence IDs;
- expected temporal state;
- expected abstention/conflict state.

Report, at minimum:

- per-language recall;
- per-language precision;
- latency;
- analyzer/index version;
- dataset identity/digest;
- unsupported-language behavior.

Where appropriate, also calculate ranking metrics such as MRR/nDCG, but do not claim that this by itself completes IMP-804.

**Important boundary:**

IMP-606 supplies the stable lexical baseline and its multilingual evidence.

IMP-804 remains the follow-on language-sliced benchmark/evaluation increment.

### TASK-008 — Evidence and handoff

**Depends on:** TASK-001 through TASK-007

Record:

- implementation candidate SHA;
- migration/index version;
- analyzer versions/configuration;
- dataset identity/digest;
- exact executed commands and `cwd`;
- test results;
- benchmark results;
- supported and unsupported capability claims;
- limitations.

Only after this evidence is complete may the program report IMP-606 as implemented and treat IMP-804 as unblocked.

Do not report:

- G8 passed;
- deployment approved;
- CJK supported if its evidence failed;
- vector retrieval justified unless the lexical evaluation establishes the applicable gate.

## 9. Verified existing anchors

Current repository anchors include:

- `airi/packages/memory-domain/src/port.ts`
- `airi/packages/memory-domain/src/capabilities.ts`
- `airi/packages/memory-sqlite/src/migrations/index.ts`
- `airi/packages/memory-sqlite/src/schema/`
- `airi/packages/memory-sqlite/src/repositories/`
- `airi/services/discord-bot/src/memory/runtime.ts`
- `airi/services/discord-bot/src/memory/feature-flags.ts`
- `airi/services/discord-bot/evals/memory/`
- `artifacts/12-retrieval-spec.md`
- `artifacts/21-implementation-backlog.md`

Possible new paths such as:

- `airi/packages/memory-sqlite/src/schema/v9.ts`;
- a lexical-search repository;
- a retrieval runtime authority;
- a retrieval evaluation subdirectory;

are **PROPOSED / UNRESOLVED** until current package conventions and ownership are inspected.

## 10. Verification ladder

All pnpm commands must run from the verified AIRI workspace root:

`<repo>/airi`

First verify the current repository-declared package-manager version and command surfaces.

Then use this ladder:

1. focused new retrieval/index/migration tests;
2. `pnpm -F @proj-airi/memory-sqlite typecheck`;
3. `pnpm -F @proj-airi/memory-sqlite test`;
4. `pnpm -F @proj-airi/memory-domain typecheck`;
5. `pnpm -F @proj-airi/memory-domain test`;
6. focused Discord retrieval/runtime/evaluation tests;
7. `pnpm -F @proj-airi/discord-bot typecheck`;
8. `pnpm -F @proj-airi/discord-bot test`;
9. repository-native targeted lint after verifying the actual current lint command/binary;
10. `git diff --check`;
11. freeze the final benchmark candidate in a local commit if authoritative measurement requires a clean worktree;
12. run the retrieval-specific multilingual benchmark from a clean pinned candidate;
13. independently reproduce/evaluate the candidate using the attached bundle's evaluator boundary.

Do **not** use the existing performance-v2 benchmark as though it were the retrieval-quality benchmark. Reuse its evidence discipline where applicable, not its metric semantics.

Every executed command must record:

- exact `cwd`;
- argv;
- exit code;
- candidate SHA;
- relevant runtime/tool versions;
- concise result.

## 11. Stop conditions

Stop and report `INCOMPLETE`, `BLOCKED` or `FAIL` as appropriate if:

**STOP-001:** `main` moves and affected source is not re-read.

**STOP-002:** required local execution capability is unavailable.

**STOP-003:** the IMP-601 query-contract precondition cannot be verified.

**STOP-004:** source/index eligibility is ambiguous and cannot be resolved from repository-owned requirements.

**STOP-005:** authorization would require retrieving unauthorized material and filtering afterward.

**STOP-006:** selected SQLite FTS functionality is unavailable in the actual supported runtime.

**STOP-007:** implementing the index would require modifying migrations v1-v8.

**STOP-008:** deletion/correction can leave stale protected text searchable.

**STOP-009:** CJK capability would have to be advertised without passing analyzer evidence.

**STOP-010:** a benchmark requires an invented threshold/policy to obtain a pass.

**STOP-011:** the implementation would enable vector, graph, on-demand recall or remote transport as a side effect.

**STOP-012:** unrelated user work would have to be discarded or overwritten.

**STOP-013:** independent verification required by the orchestration packet cannot actually be run; final verdict may not exceed `INCOMPLETE`.

## 12. Parallel non-coding track

IMP-806 — the in-process versus standalone Memory Runtime ADR — may proceed independently as governance work when its required operational data and deployment inventory exist.

It does not block IMP-606.

The lexical retrieval contract is intentionally transport-neutral, so the implementation should remain behind the current SQLite/application boundary unless a separately approved topology decision says otherwise.

The outstanding IMP-803 threshold-policy question should likewise remain a separate performance-governance track. Do not make lexical retrieval contingent on an unrelated threshold artifact unless a repository-owned gate explicitly establishes that dependency.

## 13. Orchestration-bundle handoff

Do **not** reuse the attached task-specific:

- `ORCHESTRATOR_PLAN.md`;
- `ARTIFACT_FACTORY_REQUEST.md`;

unchanged, because those files instantiate an IMP-803 performance follow-on.

For authoritative execution of this revised IMP-606 plan:

1. use the reusable `SKILL.md` against this plan;
2. re-pin `main`;
3. generate new IMP-606-specific `ORCHESTRATOR_PLAN.md` and `ARTIFACT_FACTORY_REQUEST.md`;
4. run `INDEPENDENT_ARTIFACT_FACTORY_PROMPT.md` in a genuinely fresh context;
5. require the five flat sibling outputs:
   - `TASK_SKILL.md`
   - `COMPILED_SPEC.md`
   - `REPO_CONTEXT.md`
   - `SUBAGENT_BRIEFS.md`
   - `EVALUATION_RUBRIC.md`
6. run preflight auditors before the first modification;
7. implement only after the first modifying gate is `READY`;
8. freeze and verify the candidate;
9. run a fresh independent evaluation;
10. update evidence/docs locally only after the technical gates pass;
11. perform no remote GitHub publication without a separate explicit user authorization.

## 14. Coding-agent handoff

Start from `main` at the current re-pinned HEAD, using `1b0d3b50dd576dab8e09b624cd5dcf2677e77490` only as this plan's analysis baseline.

Implement **IMP-606 only**.

Preserve:

- migrations v1-v8;
- current active-memory text/voice/context behavior;
- strict authorization;
- original evidence text;
- deletion/correction semantics;
- default-disabled rollout behavior.

Keep out of scope:

- vectors;
- graph retrieval;
- learned reranking;
- automatic/on-demand recall;
- remote Memory Runtime extraction.

The first objective is not "make FTS return results."

It is:

> establish a reproducible, authorization-safe lexical baseline whose language capabilities and limitations are stated exactly as the evidence supports.