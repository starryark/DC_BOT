---
name: imp-606-lexical-fulltext-retrieval
description: Execute and verify DC_BOT IMP-606 lexical/full-text retrieval with multilingual measurement under authorization, lifecycle, evidence, and local-only publication gates.
---
# Goal

Implement **IMP-606 — lexical/full-text retrieval with multilingual measurement** for `starryark/DC_BOT` as the smallest correct SQLite-backed path behind the existing transport-neutral `MemoryPort.searchMemory` contract. The path must be authorization-first, provenance-preserving, lifecycle-correct, analyzer-versioned, reproducibly measured for English/Japanese/Chinese/mixed-script cases, and truthful about unsupported capabilities.

This is a thin task skill, not another orchestration hierarchy. It must not spawn agents.

# Inputs

- Repository: `starryark/DC_BOT`; requested ref `main`.
- Factory fresh pin: `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`.
- Runtime plan attachment: `Plan(20260808-130243).md`, SHA-256 `752c4234fba26c1015d6bbdf4dc448718fc81c8a7e36040cedb538320c783ddd`. The factory request describes the same runtime plan as `Pasted markdown(9).md` staged as `Plan.md`.
- Embedded source-plan identity: `Pasted markdown(8).md`, SHA-256 `dc185ec77bc1b6e8346ed46f58b3b1c09d428a6072a93cc82ac2133f9e96dd12`.
- `COMPILED_SPEC.md`, `REPO_CONTEXT.md`, `SUBAGENT_BRIEFS.md`, `EVALUATION_RUBRIC.md`.
- External IMP-606 analyzer/retrieval artifacts when produced later. None were supplied to this factory.

# Source-of-truth order

1. Explicit user instruction and publication authority.
2. Runtime IMP-606 `Plan.md`.
3. Fresh direct repository/local checkout reads at the exact candidate. Known-path/directory reads are authoritative for existence/ownership.
4. Repository-owned contracts, policy, tests, status and evidence at their stated identities.
5. This generated packet.
6. Historical seed context and `DECISION_LOG.md` only as earlier evidence.
7. Code search only for discovery; a miss is never negative proof.

When fresh repository evidence corrects a plan fact, record the plan statement, exact source evidence, and resulting correction before proceeding.

# Invariants

- **INV-001 Authorization before retrieval:** authorization/scope/temporal eligibility constrain the searchable candidate universe before content-bearing lexical lookup/ranking; broad search then post-filter is forbidden.
- **INV-002 Original evidence immutable:** authoritative text is unchanged; NFC is canonical, while NFKC/case-folding may exist only as derived search keys.
- **INV-003 CJK measured, not assumed:** whitespace tokenization is not CJK evidence; analyzer/tokenizer identity is versioned.
- **INV-004 Incomparable scores are not added:** raw BM25/engine scores from distinct profiles are never directly summed without measured calibration/fusion.
- **INV-005 Provenance survives retrieval:** every hit resolves to an authoritative source record.
- **INV-006 Index lifecycle follows authority:** deletion, redaction, correction, supersession, temporal invalidation, rollback and rebuild cannot leave stale protected content searchable as current.
- **INV-007 Migration history immutable:** v1-v8 and their checksums remain unchanged; only an additive next migration may extend schema.
- **INV-008 Capability advertisement is evidence-backed:** Latin/CJK claims require composed implementation plus matching evidence; unsupported requests fail explicitly.
- **INV-009 Measurements are not policy thresholds:** do not invent retrieval quality/latency bounds or convert performance-v2 measurements into IMP-606 policy.
- **INV-010 Scope isolation:** `fulltextRetrieval` remains default-off; vector, graph, learned reranking, on-demand recall, relationship hypotheses and remote transport remain out of scope.

# State machine / gates

`DISCOVERED -> PREFLIGHTED -> CONTRACT_FROZEN -> STORAGE_READY -> RETRIEVAL_READY -> ANALYZER_MEASURED -> RUNTIME_WIRED -> CANDIDATE_FROZEN -> INDEPENDENTLY_VERIFIED -> EVIDENCE_PROMOTED`

Transition only with recorded `PASS` evidence. `FAIL` blocks until corrected. `INCOMPLETE` blocks downstream modifying/promotion work because required evidence or execution did not occur.

- `GATE-000`: execution capability preflight.
- `GATE-001`: fresh remote/local pin and local worktree status immediately before edits.
- `GATE-002`: retrieval contract, formal IMP-601 prerequisite evidence and source-backed index eligibility frozen.
- `GATE-003`: actual supported candidate runtime proves required SQLite FTS5/tokenizer features.
- `GATE-004`: lifecycle design/test evidence covers deletion/redaction/correction/supersession/temporal/rollback/rebuild/provenance.
- `GATE-005`: analyzer evidence supports every advertised language capability.
- `GATE-006`: exact candidate frozen and independently verified/falsified.
- `GATE-007`: evidence/docs match the exact candidate and publication authority.

Factory-time readiness is **BLOCKED**: remote re-pin passed, but there is no local checkout, `pnpm@10.33.0` is unavailable, edit-time worktree state cannot be recorded, formal IMP-601 acceptance evidence is unresolved, and no IMP-606 analyzer evidence exists.

# Tool routing

- GitHub connector: remote identity, exact files/directories/commits/history.
- Local filesystem/git: authoritative edit-time checkout HEAD/status/diff and changed source when a checkout exists.
- Shell/process: only commands actually executed; record `cwd`, argv, exit code, candidate SHA, runtime/tool versions and concise result.
- Repository-native `pnpm` commands: only from `<repo>/airi` after verifying declared version.
- Code search: discovery only, followed by direct read.
- Benchmark/evidence output: outside repository worktree whenever clean-worktree evidence matters.
- GitHub write actions: available in principle but **forbidden** under current local-only publication authority.

# Capability requirements / fallback

| Capability | Requirement | Factory observation | Fallback/result |
|---|---|---|---|
| Fresh-context artifact factory | Required for packet | AVAILABLE in this handoff | If unavailable, stop; same-context simulation is forbidden. |
| Local checkout | Required before edits/tests | UNAVAILABLE | `INCOMPLETE/BLOCKED`. |
| Shell/process | Required | AVAILABLE | If absent, `INCOMPLETE/BLOCKED`. |
| `git` | Required | AVAILABLE (`2.47.3`) | If absent, `INCOMPLETE/BLOCKED`. |
| Repository package manager | Required | UNAVAILABLE (`pnpm` absent; Corepack cannot reach npm) | `INCOMPLETE/BLOCKED`; do not simulate commands. |
| Node/runtime | Required | DEGRADED (`v22.16.0`; repo-authoritative compatibility unverified) | Verify candidate runtime before authoritative run. |
| SQLite/FTS5 | Required for selected design | Factory Node SQLite `3.49.1`; FTS5 `unicode61` and `trigram` table creation PASS | Repeat under candidate-supported runtime before GATE-003 PASS. |
| External writable output | Required | AVAILABLE: `/mnt/data/dc_bot_imp606_artifacts` | Use an external path for real run evidence. |
| Direct-child/fresh evaluator invocation | Required for independent final verdict | Direct-child launcher UNAVAILABLE here | Use separate fresh-context handoffs; otherwise STOP-013. |
| IMP-606 analyzer/retrieval evidence | Required for capability claims | UNAVAILABLE | Keep unsupported claims disabled; GATE-005 `INCOMPLETE`. |

# Required repository reads

At the latest re-pinned candidate, direct-read at minimum:

- `docs/memory/CURRENT.md`, `docs/memory/evidence/evidence-index.md`, `artifacts/12-retrieval-spec.md`, `artifacts/21-implementation-backlog.md`.
- `airi/package.json`, `airi/pnpm-workspace.yaml`, memory-domain/sqlite/discord package manifests.
- `airi/packages/memory-domain/src/port.ts`, `capabilities.ts`, `authorization.ts`, `memory-records.ts`, imported lifecycle/provenance/error/correction contracts and focused tests.
- `airi/packages/memory-sqlite/src/migrations/index.ts`, full `src/schema/` inventory, migration runner/tests, `connection-profile.ts`, `writer-ownership.ts`, package/repository exports, full `src/repositories/` inventory, events/deliveries/outputs/memories/summaries/corrections/privacy/policy/provenance/deletion/UoW paths and tests.
- `airi/services/discord-bot/src/memory/runtime.ts`, `feature-flags.ts`, profile/config/composition call sites, actual health/capability advertisement path and focused tests.
- Complete `airi/services/discord-bot/evals/memory/` inventory and current contracts/dataset/oracles/report/runtime adapter/tests. Use `evals/memory/performance/` only as evidence-discipline precedent.

Do not call a future `schema/v9.ts`, lexical repository, search authority or retrieval-eval path observed until it actually exists. Future exact paths remain `PROPOSED/UNRESOLVED` until ownership is proven.

# Allowed modifications

Only after prerequisites pass:

- Focused conformance tests locking the existing retrieval contract.
- One additive next migration after freshly verifying the highest schema version.
- Minimal SQLite lexical index/search implementation and lifecycle hooks in verified package ownership.
- Minimal Discord composition/authority wiring behind existing `fulltextRetrieval`.
- Existing memory evaluation-family extensions for frozen multilingual dataset/analyzer metadata/measurements/reports.
- Evidence/docs updates only after independent verification/falsification pass.

# Forbidden modifications

- No competing retrieval API or bypass of `MemoryPort.searchMemory`.
- No changes to migrations v1-v8/checksums.
- No late authorization filtering of broad unauthorized search results.
- No mutation of authoritative evidence text for normalization.
- No fabricated thresholds/policy/workload approval.
- No vector/graph/learned-reranking/on-demand/relationship/remote enablement.
- No default enablement of `fulltextRetrieval`.
- No unrelated provider/voice/generation/delivery/topology/refactor changes.
- No test/fixture/policy weakening to obtain a pass.
- No remote GitHub branch/push/PR/issue/comment/label/merge/release mutation.

# Verification ladder

After verifying current scripts, run from `<repo>/airi`:

1. focused retrieval/index/migration tests;
2. `pnpm -F @proj-airi/memory-sqlite typecheck`;
3. `pnpm -F @proj-airi/memory-sqlite test`;
4. `pnpm -F @proj-airi/memory-domain typecheck`;
5. `pnpm -F @proj-airi/memory-domain test`;
6. focused Discord retrieval/runtime/evaluation tests;
7. `pnpm -F @proj-airi/discord-bot typecheck`;
8. `pnpm -F @proj-airi/discord-bot test`;
9. repository-native targeted lint only after verifying supported targeted `moeru-lint` argv;
10. `git diff --check`;
11. freeze final benchmark candidate in a **local** commit if clean-worktree evidence requires it; this does not authorize push;
12. run retrieval-specific multilingual benchmark from the clean pinned candidate with external output;
13. run independent verification and independent falsification in fresh contexts.

Existing `memory:benchmark`/performance-v2 is not the retrieval-quality benchmark; reuse evidence discipline only.

# Stop conditions

- `STOP-001`: current `main` moves and affected source is not re-read.
- `STOP-002`: required local execution capability unavailable.
- `STOP-003`: formal IMP-601 query-contract precondition cannot be verified.
- `STOP-004`: source/index eligibility remains ambiguous.
- `STOP-005`: authorization would require retrieving unauthorized material then filtering.
- `STOP-006`: selected SQLite FTS functionality unavailable in actual supported runtime.
- `STOP-007`: implementation requires changing migrations v1-v8.
- `STOP-008`: deletion/correction can leave stale protected text searchable.
- `STOP-009`: CJK would be advertised without passing analyzer evidence.
- `STOP-010`: benchmark requires invented threshold/policy to obtain a pass.
- `STOP-011`: vector/graph/on-demand/relationship/remote feature is enabled as side effect.
- `STOP-012`: unrelated user work must be discarded/overwritten.
- `STOP-013`: independent verification cannot actually run; final verdict cannot exceed `INCOMPLETE`.

# Evidence outputs

Preserve concise, non-chain-of-thought evidence:

- exact remote/local/candidate SHA and worktree status;
- migration/index/analyzer versions;
- dataset identity/digest;
- exact commands, `cwd`, exit codes, tool/runtime versions;
- focused/full test results;
- multilingual retrieval measurements and unsupported behavior;
- authorization-negative/temporal/deletion/correction/rollback/rebuild/provenance evidence;
- composed runtime capability advertisement;
- independent verification/falsification reports;
- limitations and unresolved blockers.

Optional run-time evidence files are flat siblings and should live outside the worktree when clean state matters: `DECISION_LOG.md`, `TEST_EVIDENCE.md`, `FINAL_EVALUATION.md`.

# Publication contract

Publication authority is **local-only**. Local artifacts and local candidate commits needed for reproducible measurement are permitted when supported. No remote branch creation, push, PR, issue/comment, label, merge, release or other GitHub mutation is authorized. Any later publication requires a new explicit user authorization and must preserve exact verified candidate/evidence identity.
