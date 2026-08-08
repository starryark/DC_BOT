# REPO_CONTEXT — DC_BOT IMP-606

## Repository identity

- **Owner/name:** `starryark/DC_BOT`
- **Default branch:** `main`
- **Requested ref:** `main`
- **Pinned head SHA:** `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`
- **Pinned commit message:** `docs(memory): record IMP-803 performance-v2 baseline evidence`
- **Acquisition method:** fresh GitHub connector repository/commit/file/directory reads at the exact SHA. No local checkout is available in this factory runtime.
- **Verification date:** 2026-08-08 America/Los_Angeles.
- **Plan pin comparison:** exact match; no remote drift from Plan.md.
- **Publication authority:** local-only; GitHub write routes exist but are forbidden for this task.

## Drift rule

Immediately before any modifying work, resolve remote `main`, local checkout HEAD and `git status`. If any differ from this pinned snapshot or the candidate changes during work, re-read every affected contract, authorization/capability surface, migration/schema/repository ownership surface, Discord composition/feature/advertisement surface, evaluation contract/dataset/report/CLI surface, and status/evidence document before relying on this map. Preserve unrelated local changes.

Historical evidence remains tied to the commit where it was generated. Do not rewrite measured-code identity merely because documentation or the implementation candidate is newer.

Repository lookup rule: **direct known-path/directory reads are authoritative for existence and ownership; code search is discovery-only and a miss is never negative proof.**

## Relevant file map

| Path | Role | Why relevant | Verified at | Notes |
|---|---|---|---|---|
| `docs/memory/CURRENT.md` | Current program/status document | Names current memory capabilities and gated future retrieval work | `1b0d3b50...` | Contains stale performance-v1 IMP-803 wording relative to current evidence-index/HEAD; do not let it override exact evidence identities. |
| `docs/memory/evidence/evidence-index.md` | Evidence index/promotion record | Distinguishes frozen baseline from implementation evidence and now records performance-v2 | `1b0d3b50...` | Current HEAD adds IEV-803-002 for measured commit `9afc7207...`. No formal IMP-601 acceptance row was established by this factory. |
| `artifacts/12-retrieval-spec.md` | Normative retrieval design source | Authorization-first, multilingual lexical retrieval, evidence-gated advanced retrieval | `1b0d3b50...` | Artifact's internal repository observation is historical; use current source for implementation facts. |
| `artifacts/21-implementation-backlog.md` | Backlog/dependency authority | IMP-606 definition, formal preconditions, output/test expectations | `1b0d3b50...` | IMP-606 precondition: `IMP-201, IMP-601 query contract`. |
| `airi/package.json` | AIRI workspace/package-manager declaration | Declares `pnpm@10.33.0`, workspace scripts and root lint command | `1b0d3b50...` | Authoritative command cwd is `<repo>/airi`. |
| `airi/pnpm-workspace.yaml` | pnpm workspace membership | Confirms `packages/**` and `services/**` are workspace packages | `1b0d3b50...` | Direct fresh read. |
| `airi/packages/memory-domain/package.json` | Domain package commands | Owns domain `test` and `typecheck` scripts | `1b0d3b50...` | `vitest run`; `tsc --noEmit`. |
| `airi/packages/memory-sqlite/package.json` | SQLite package commands | Owns SQLite `test`/`typecheck` and existing benchmark scripts | `1b0d3b50...` | Retrieval benchmark command does not yet exist at pin. |
| `airi/services/discord-bot/package.json` | Discord runtime/eval commands | Owns `memory:evaluate`, `memory:benchmark`, `memory:baseline`, test/typecheck | `1b0d3b50...` | Existing performance commands are not retrieval-quality policy. |
| `airi/packages/memory-domain/src/port.ts` | Public MemoryPort/retrieval contract | Exact `SearchMemoryInput`, `MemoryHit`, `SearchMemoryOutput`, `searchMemory`, retrieval stage order | `1b0d3b50...` | Every port operation takes `AuthorizationContext`; no new retrieval API should be created. |
| `airi/packages/memory-domain/src/authorization.ts` | Authorization lattice | Deny-by-default and explicitly authorization-before-candidates; `memory:search` operation | `1b0d3b50...` | Critical for pre-candidate scope restriction. |
| `airi/packages/memory-domain/src/capabilities.ts` | Retrieval capability contract | Separates Latin/CJK/vector/graph and query-specific CJK capability | `1b0d3b50...` | `M1_SQLITE_CAPABILITIES` contains Latin but not CJK; do not assume this constant is the runtime advertisement. |
| `airi/packages/memory-domain/src/memory-records.ts` | Layer/lifecycle/provenance model | Defines summary/semantic/episodic/procedural records, temporal validity, tombstones, derived layers | `1b0d3b50...` | Raw/recent are layer names but `MemoryRecord` union contains non-raw durable derived records; index eligibility must be source-backed. |
| `airi/packages/memory-sqlite/src/migrations/index.ts` | Migration registry | Current versions/checksums and latest schema | `1b0d3b50...` | Ends at v8 `generation_context_manifests`. |
| `airi/packages/memory-sqlite/src/schema/` | Schema inventory | Proves current highest schema and existing tests | `1b0d3b50...` | Direct inventory contains v1–v8; no v9. Future v9 is `PROPOSED/UNRESOLVED`. |
| `airi/packages/memory-sqlite/src/migration-runner.ts` | Migration execution | Forward migration/rollback ownership | `1b0d3b50...` context inventory/exports | Re-read directly in modifying checkout before schema work and run its focused tests. |
| `airi/packages/memory-sqlite/src/connection-profile.ts` | SQLite runtime/profile | Uses Node `node:sqlite`, WAL/FULL/FK and migration call | `1b0d3b50...` | Selected FTS features must be reprobed in supported candidate runtime. |
| `airi/packages/memory-sqlite/src/writer-ownership.ts` | Authoritative SQLite composition | Owns process-level writer guard and `openAuthoritativeSqliteDatabase` | `1b0d3b50...` | Exact runtime path used by Discord composition. |
| `airi/packages/memory-sqlite/src/index.ts` | Package export surface | Exports migrations, repositories, UoW, ownership | `1b0d3b50...` | Any new lexical implementation must follow verified export conventions. |
| `airi/packages/memory-sqlite/src/repositories/index.ts` | Repository export surface | Current repository owners | `1b0d3b50...` | Exports alias/bindings/causal/corrections/deliveries/events/generations/identity/memories/outputs/policy/privacy/rooms/summaries; no lexical export at pin. |
| `airi/packages/memory-sqlite/src/repositories/events.ts` | Raw inbound event authority | Potential evidentiary source and redaction lifecycle | `1b0d3b50...` directory/read chain | Re-read directly before eligibility design. |
| `airi/packages/memory-sqlite/src/repositories/deliveries.ts` | Delivery eligibility authority | Determines assistant output eligibility/current lifecycle | `1b0d3b50...` directory/read chain | Must constrain whether assistant output is indexable. |
| `airi/packages/memory-sqlite/src/repositories/outputs.ts` | Assistant output text authority | Authoritative output segment text/lifecycle source | `1b0d3b50...` directory/read chain | Deletion target clears exact text. |
| `airi/packages/memory-sqlite/src/repositories/memories.ts` | Semantic/episodic/procedural authority | Current/as-of fact queries, tombstones, provenance | `1b0d3b50...` | Exact scope and temporal predicates matter for indexing/search. |
| `airi/packages/memory-sqlite/src/repositories/summaries.ts` | Summary authority | Derived summary provenance/stale/tombstone lifecycle | `1b0d3b50...` repository inventory | Re-read before eligibility/lifecycle design. |
| `airi/packages/memory-sqlite/src/repositories/corrections.ts` | Fact correction/supersession authority | Atomically closes prior fact and appends replacement | `1b0d3b50...` | Search current/historical semantics must track this chain. |
| `airi/packages/memory-sqlite/src/deletion-targets.ts` | Registered deletion targets | Defines content-removal/verification targets | `1b0d3b50...` | Targets inbound events, semantic/episodic, summaries, output segments. Derived lexical store must be integrated into deletion obligations/rebuild policy. |
| `airi/services/discord-bot/src/memory/runtime.ts` | Discord memory composition root | Current production-shaped SQLite imports and ingress/trace/context/privacy authorities | `1b0d3b50...` | No lexical authority visible at pin; exact future wiring name unresolved. |
| `airi/services/discord-bot/src/memory/feature-flags.ts` | Rollout policy | Existing `fulltextRetrieval` and defaults/prerequisites | `1b0d3b50...` | Defaults false; forbidden neighboring features remain separately gated. |
| `airi/services/discord-bot/evals/memory/` | Evaluation family | Existing contracts/dataset/oracles/report/runtime/performance infrastructure | `1b0d3b50...` | Extend this family; do not replace it. |
| `airi/services/discord-bot/evals/memory/contracts.ts` | Evaluation schemas | Existing evaluator contract surface | `1b0d3b50...` inventory | Direct-read current content when designing retrieval artifacts. |
| `airi/services/discord-bot/evals/memory/dataset.ts` | Frozen evaluator dataset logic | Version/digest/fixture precedent | `1b0d3b50...` inventory | Extend or follow ownership after direct read. |
| `airi/services/discord-bot/evals/memory/oracles/` | Evaluation oracle ownership | Behavioral expectations | `1b0d3b50...` inventory | Retrieval-specific oracle path unresolved. |
| `airi/services/discord-bot/evals/memory/runtime-adapter.ts` | Production-runtime evaluator bridge | Isolated external roots, typed auth/runtime operations, content-minimized evidence | `1b0d3b50...` | Reuse production-shaped evidence discipline. |
| `airi/services/discord-bot/evals/memory/performance/` | Performance evidence discipline | Reproducibility/manifest/report precedent | `1b0d3b50...` inventory | Do **not** reuse performance-v2 metric/threshold semantics as retrieval policy. |

### Proposed/unresolved future paths

The following are not current repository facts and must not be called as existing paths until created after ownership verification:

- next schema file, expected `airi/packages/memory-sqlite/src/schema/v9.ts` only if v8 is still highest;
- lexical search/index repository/module;
- Discord retrieval/search authority module or `MemoryRuntime` field;
- retrieval-specific evaluation subdirectory/CLI/script/package command.

## Command map

All `pnpm` package commands below require `cwd=<repo>/airi` because `airi/package.json` is the pnpm workspace root and declares `pnpm@10.33.0`.

| Command | cwd | What it proves | Factory execution status |
|---|---|---|---|
| `pnpm -F @proj-airi/memory-domain typecheck` | `<repo>/airi` | Domain contract types compile | NOT RUN — no checkout/pnpm |
| `pnpm -F @proj-airi/memory-domain test` | `<repo>/airi` | Domain contract/boundary tests | NOT RUN |
| `pnpm -F @proj-airi/memory-sqlite typecheck` | `<repo>/airi` | SQLite adapter types compile | NOT RUN |
| `pnpm -F @proj-airi/memory-sqlite test` | `<repo>/airi` | Migrations/repositories/runtime-profile tests | NOT RUN |
| `pnpm -F @proj-airi/discord-bot typecheck` | `<repo>/airi` | Discord composition/evaluator types compile | NOT RUN |
| `pnpm -F @proj-airi/discord-bot test` | `<repo>/airi` | Discord runtime/evaluation regression suite | NOT RUN |
| `pnpm -F @proj-airi/discord-bot memory:evaluate -- --help` | `<repo>/airi` | Current functional-evaluator CLI ownership/argv | NOT RUN |
| `pnpm -F @proj-airi/discord-bot memory:benchmark -- --help` | `<repo>/airi` | Current performance benchmark CLI ownership/argv | NOT RUN |
| `pnpm -F @proj-airi/discord-bot memory:baseline -- --help` | `<repo>/airi` | Current performance comparison CLI ownership/argv | NOT RUN |
| `pnpm lint` | `<repo>/airi` | Root repository lint command (`moeru-lint .`) | NOT RUN; full lint is verified as a script but targeted lint argv must be established before use |
| `git diff --check` | `<repo>` | Patch whitespace/conflict hygiene | NOT RUN — no checkout |
| focused retrieval/migration/runtime/eval tests | `<repo>/airi` | Task-specific behavior | **UNRESOLVED command paths** until files/tests exist and current test invocation is verified |
| retrieval multilingual benchmark | `<repo>/airi` | IMP-606 quality/latency/analyzer evidence | **UNRESOLVED command**; must be added within verified eval ownership, not confused with `memory:benchmark` performance-v2 |

Do not invent commands from package-manager conventions. Before authoritative execution, direct-read manifests at the candidate and run `--help`/focused commands where applicable.

## Environment/evidence dependencies

### Factory runtime observations

| Capability/dependency | Status | Evidence / consequence |
|---|---|---|
| GitHub repository read | AVAILABLE | Fresh exact commit/file/directory reads succeeded. |
| GitHub write routes | AVAILABLE but FORBIDDEN | Repository permissions include write/admin, but task authority is local-only. No write route was used. |
| Local DC_BOT checkout | UNAVAILABLE | No `.git` checkout found under accessible workspace. Modifying work is blocked. |
| Shell/process execution | AVAILABLE | Local probes executed. |
| `git` | AVAILABLE | `git version 2.47.3`. |
| Shell network clone | UNAVAILABLE | Git clone from GitHub failed with DNS/host-resolution error. Connector remains read-capable. |
| Repository package manager | UNAVAILABLE | `pnpm` not installed; Corepack cannot fetch because registry network/DNS is unavailable. |
| Node | DEGRADED | `v22.16.0` installed; exact repository-supported candidate compatibility is unverified. |
| Factory Node SQLite | AVAILABLE for non-authoritative probe | SQLite `3.49.1`; FTS5 table creation using `unicode61` and `trigram` passed. Must be repeated in authoritative candidate runtime. |
| External writable output | AVAILABLE | `/mnt/data/dc_bot_imp606_artifacts`; outside a repository worktree in this factory runtime. |
| Fresh-context artifact-factory handoff | AVAILABLE | This turn is the fresh handoff requested by the originating process. |
| Direct-child agent invocation | UNAVAILABLE | Downstream independent roles must be separate fresh-context handoffs; cannot be simulated by master/implementer context. |
| IMP-606 analyzer/retrieval evidence | UNAVAILABLE | None supplied; CJK and final capability claims remain gated. |

### OS/runtime expectations

- Implementation uses Node `node:sqlite` in the verified repository source. The supported Node version and SQLite/FTS build for the actual candidate must be recorded before GATE-003 can PASS.
- Authoritative SQLite writes use WAL, `synchronous=FULL`, FKs, migration execution, and a writer-ownership guard; retrieval schema/query work must coexist with this profile.
- Clean worktree and exact candidate identity are required when a retrieval/evidence run uses clean-state reproducibility; freeze a local commit if needed. A local evidence commit does not authorize push.

### External artifact locations/identities

- Runtime Plan attachment SHA: `752c4234fba26c1015d6bbdf4dc448718fc81c8a7e36040cedb538320c783ddd`.
- Embedded source-plan SHA: `dc185ec77bc1b6e8346ed46f58b3b1c09d428a6072a93cc82ac2133f9e96dd12`.
- No separate IMP-606 retrieval/analyzer benchmark artifact is currently available.
- Historical performance-v2 measured-code commit: `9afc7207f006ac327ff12e31e76633ee9f9c2606`; evidence documentation commit/pin: `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`. These do not establish retrieval quality thresholds.

### Secrets/credentials

- No secret values are required in the packet and none may be recorded.
- Any live Discord/private deployment credentials or private evaluation material, if later required, must stay outside published/content-minimized evidence according to repository policy.

### Output-location safety

- Run/evidence output should live outside the repository worktree whenever clean-worktree state is authoritative evidence.
- Never place private runtime authorities, benchmark run roots, or content-bearing evidence in the repository merely to make them easy to stage.

### Capability fallback rules

- No local checkout / package manager / compatible runtime: `INCOMPLETE/BLOCKED`; do not simulate execution.
- No direct-child invocation: transport each independent role to a separate fresh context; if this cannot happen, STOP-013 and final verdict at most `INCOMPLETE`.
- No FTS feature in supported candidate runtime: STOP-006; report evidence rather than fake a compatibility layer.
- No formal prerequisite/index eligibility evidence: STOP-003/STOP-004 before modifications.
- No analyzer evidence: keep unsupported language capability disabled; GATE-005 remains `INCOMPLETE`.

## Historical identity map

| Identity | Role | Do not conflate with |
|---|---|---|
| `0ea3cbf5...` | Older baseline embedded in backlog/retrieval artifacts | Current implementation pin |
| `1131327cdb7b0878a32127424a7b4723ca92b0e8` | Historical seed-context repository verification | Current task pin; seed only |
| `a215840bfc366d4ae68f8dc4c09fb86c34dded19` | Superseded performance-v1 measured-code identity | performance-v2 or IMP-606 candidate |
| `9afc7207f006ac327ff12e31e76633ee9f9c2606` | Current recorded performance-v2 measured-code identity | Current docs/evidence pin or future retrieval candidate |
| `1b0d3b50dd576dab8e09b624cd5dcf2677e77490` | Plan analysis pin, fresh current `main`, and later performance-v2 evidence/documentation state | Future IMP-606 implementation/benchmark candidate |
| `UNRESOLVED` | Future IMP-606 implementation candidate | Any historical baseline |

`docs/memory/CURRENT.md` at the current pin still describes the older performance-v1 baseline, while the current evidence index/HEAD records the superseding performance-v2 row. For performance identity, use the evidence record tied to its exact commit rather than promoting stale status text.

## Unresolved context

1. Formal repository-owned acceptance evidence that satisfies the backlog's **IMP-601 query contract** prerequisite.
2. Complete authoritative lexical index-eligibility matrix by source record/layer/lifecycle state, including assistant-output eligibility and historical/superseded semantics.
3. A real local checkout with HEAD/status and unrelated-work inventory.
4. Working repository-declared `pnpm@10.33.0` (or an explicitly repository-approved compatible route) and installed dependencies.
5. Exact supported Node version/runtime and authoritative SQLite/FTS feature probe for the future candidate.
6. Exact next migration path/version at edit time; v9 is only expected if no intervening migration appears.
7. Exact lexical repository/indexer/analyzer/runtime-authority filenames and export/composition symbols.
8. Exact retrieval-evaluation subpath, CLI/package script, dataset/oracle/report ownership after direct reads of current eval contracts.
9. IMP-606 analyzer/retrieval measurement artifacts and dataset digest.
10. Actual runtime capability-advertisement/health path to edit, distinct from merely reading the domain capability constant.
11. Downstream independent direct-child execution primitive; separate fresh-context handoff is required if direct child remains unavailable.

**Unresolved blocker count: 11.** The first modifying task is currently **BLOCKED**.
