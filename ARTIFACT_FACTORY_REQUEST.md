# ARTIFACT_FACTORY_REQUEST — DC_BOT IMP-606 lexical/full-text retrieval

Run `INDEPENDENT_ARTIFACT_FACTORY_PROMPT.md` as a **separate LLM/process with genuinely fresh context**. The originating host cannot launch that process directly, so this file is the required handoff payload. Do not execute the factory in the same reasoning context and call it independent.

## Inputs to provide that process

- `Plan.md` — the supplied IMP-606 plan.
  - Runtime attachment identity: `Pasted markdown(9).md`, staged as `Plan.md`.
  - Runtime Plan.md SHA-256: `752c4234fba26c1015d6bbdf4dc448718fc81c8a7e36040cedb538320c783ddd`.
  - The plan itself records an earlier source-plan identity `Pasted markdown(8).md` with SHA-256 `dc185ec77bc1b6e8346ed46f58b3b1c09d428a6072a93cc82ac2133f9e96dd12`; preserve the distinction.
- `ARTIFACT_CONTRACT.md` — schema authority for the five flat packet files.
- `INDEPENDENT_ARTIFACT_FACTORY_PROMPT.md` — governing factory prompt.
- `DC_BOT_REPO_CONTEXT.md` — historical seed only; it was built at `1131327cdb7b0878a32127424a7b4723ca92b0e8` and must not override fresh reads.
- Repository read access to `starryark/DC_BOT`.
- Target ref: `main`.
- Current remote pin observed by the originating host: `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`.
- `DECISION_LOG.md` from the originating host as capability/re-pin evidence only; independently verify repository facts and do not inherit implementation preferences.
- Any separately supplied IMP-606 retrieval/analyzer evidence if it exists in the fresh runtime. None was supplied to the originating host.

## Task identity and source boundaries

- Task: **IMP-606 — Implement lexical/full-text retrieval with multilingual measurement.**
- Repository: `starryark/DC_BOT`.
- Requested ref: `main`.
- Analysis/pinned revision in Plan.md: `1b0d3b50dd576dab8e09b624cd5dcf2677e77490`.
- Publication authority: local-only. No branch creation, push, PR, issue/comment, label, merge, or other remote GitHub mutation is authorized.
- Do not reuse the bundled `ORCHESTRATOR_PLAN.md` or bundled `ARTIFACT_FACTORY_REQUEST.md` as task truth; those instantiate an older IMP-803 follow-on. This request and the runtime `Plan.md` are the IMP-606 task inputs.

## Fresh repository verification required

First resolve current `main`. If it differs from `1b0d3b50...`, re-read every affected surface and record drift rather than copying the originating host's pin.

Direct-fetch/read the known paths below at the freshly pinned revision. Use direct directory/tree reads for inventories. Code search is discovery-only; a miss is never negative proof.

### Program/status and source requirements

- `docs/memory/CURRENT.md`
- `docs/memory/evidence/evidence-index.md`
- `artifacts/12-retrieval-spec.md`
- `artifacts/21-implementation-backlog.md`

### Workspace/command ownership

- `airi/package.json`
- `airi/pnpm-workspace.yaml`
- `airi/packages/memory-domain/package.json`
- `airi/packages/memory-sqlite/package.json`
- `airi/services/discord-bot/package.json`

### Retrieval/domain contract

- `airi/packages/memory-domain/src/port.ts`
- `airi/packages/memory-domain/src/capabilities.ts`
- authorization/scope, memory-record/provenance, correction/lifecycle, and error files reached by direct imports from the retrieval contract
- focused domain boundary/contract tests reached from those files

### SQLite ownership and lifecycle

- `airi/packages/memory-sqlite/src/migrations/index.ts`
- `airi/packages/memory-sqlite/src/schema/` inventory (verify current highest version; do not assume v9 remains absent if head moved)
- `airi/packages/memory-sqlite/src/repositories/` inventory
- migration runner and migration tests
- repository/index exports/composition surfaces
- event, delivery/output, layered-memory, correction, deletion/privacy, policy/scope, transaction/unit-of-work, and provenance repositories/tests needed to determine the authoritative index-eligibility and lifecycle model
- SQLite connection/runtime code needed to establish the actual Node SQLite API and FTS feature path

### Discord runtime/composition and feature truth

- `airi/services/discord-bot/src/memory/runtime.ts`
- `airi/services/discord-bot/src/memory/feature-flags.ts`
- memory profile/config/composition imports/call sites reached from those files
- the actual capability advertisement/health path; do not assume `M1_SQLITE_CAPABILITIES` is the runtime advertisement path
- focused runtime/context/feature-flag tests

### Evaluation family

- `airi/services/discord-bot/evals/memory/` directory inventory
- current dataset/contracts/oracles/report/runtime adapter and tests
- `airi/services/discord-bot/evals/memory/performance/` only as evidence-discipline precedent; do not reuse performance-v2 metric semantics as retrieval-quality policy
- memory evaluation/benchmark CLI scripts and package scripts that would own a retrieval-specific benchmark if source ownership supports that placement

## Source facts to preserve unless fresh evidence corrects them

Treat these as claims to verify, not permission to assume:

1. `MemoryPort.searchMemory` already exists and every port method requires `AuthorizationContext`.
2. Retrieval capabilities distinguish `fulltext_latin`, `fulltext_cjk`, `vector_search`, and `graph_search`.
3. `M1_SQLITE_CAPABILITIES` includes `fulltext_latin` but not `fulltext_cjk`, while the current Discord runtime has no lexical search authority; trace the real advertisement path before specifying an edit.
4. Migration registry ends at v8 at the analysis pin; any v9 path is `PROPOSED/UNRESOLVED` until fresh verification.
5. `fulltextRetrieval` already exists and defaults false.
6. Existing evaluation infrastructure should be extended rather than replaced by an unrelated framework.
7. The formal IMP-601 precondition must be verified from repository-owned acceptance evidence before declaring it satisfied. Code shape alone is not enough if the backlog's formal gate requires more.
8. Performance-v2 measurement/governance is a separate track and is not an IMP-606 prerequisite unless fresh repository-owned policy proves otherwise.
9. Retrieval measurements are not policy thresholds. Missing retrieval-quality/latency bounds stay measurement-only; do not fabricate thresholds.

## IMP-606 invariants that the packet must encode

- Authorization/scope/temporal eligibility must constrain the searchable candidate universe before content-bearing lexical lookup/ranking; application-side post-filtering of broad unauthorized results is forbidden.
- Original evidence text is immutable; search normalization is derived data.
- CJK is measured, not assumed; whitespace tokenization alone is not sufficient evidence.
- Do not add incomparable raw scores across analyzer/index profiles.
- Every hit preserves reconstructable authoritative-source provenance.
- Deletion, redaction, correction, supersession, temporal invalidation, rollback, and rebuild must keep derived lexical state consistent with authoritative lifecycle.
- Existing migrations v1-v8 and their checksums remain unchanged; only an additive migration may extend durable schema.
- Capability advertisement must match composed implementation and analyzer evidence.
- `fulltextRetrieval` remains default-off; vector, graph, on-demand recall, relationship hypotheses, and remote transport stay out of scope.
- No retrieval benchmark result implies G8 pass, deployment approval, or unrelated policy approval.

## Host-capability requirements to record, not assume

The generated `REPO_CONTEXT.md` must explicitly record whether authoritative downstream execution has:

- a real local checkout and its current HEAD/status;
- shell/process execution;
- `git`;
- repository-declared `pnpm@10.33.0` or the freshly verified replacement;
- a compatible Node/runtime and actual SQLite/FTS feature support;
- an external writable run/evidence directory outside the worktree;
- fresh-context/direct-child invocation;
- required external artifacts/evidence;
- GitHub read/write routes, while preserving local-only publication authority.

The originating host observed: GitHub reads available; shell and `git` available; no local checkout; shell network cannot clone GitHub; `pnpm` unavailable and Corepack cannot reach npm; Node `v22.16.0`; safe external output available; no fresh-context/direct-child launcher. Re-probe in the fresh runtime rather than copying these as universal facts.

## Required outputs

Produce exactly these five flat sibling files, with no nested agent directories:

1. `TASK_SKILL.md`
2. `COMPILED_SPEC.md`
3. `REPO_CONTEXT.md`
4. `SUBAGENT_BRIEFS.md`
5. `EVALUATION_RUBRIC.md`

Conform exactly to `ARTIFACT_CONTRACT.md`.

## Factory restrictions

- **No implementation.**
- **No production/test edits.**
- **No threshold/policy/workload weakening.**
- **No commit, push, branch, PR, issue, comment, label, merge, or other GitHub mutation.**
- Do not choose an exact lexical repository/indexer/runtime filename until current package conventions and ownership prove it.
- Do not call a proposed `schema/v9.ts` path observed until it actually exists; when specifying a future path, label it `PROPOSED/UNRESOLVED`.
- Do not declare CJK support without analyzer evidence.
- Do not convert missing execution capability/evidence into PASS.

## End-of-factory report

Report:

- freshly pinned repository SHA;
- generated file list;
- plan-vs-repository corrections;
- unresolved blocker count;
- whether the first modifying task is `READY` or `BLOCKED`;
- for every gate criterion, use `PASS`, `FAIL`, or `INCOMPLETE` exactly as defined by the bundle.
