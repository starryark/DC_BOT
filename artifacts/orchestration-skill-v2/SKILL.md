---
name: tool-compatible-implementation-orchestrator
description: Execute repository implementation work with phase-aware capability gates, portable candidate handoff, evidence-based verification, and graceful degradation when local tooling or independent-agent primitives are unavailable.
---

# Goal

Turn a user-supplied implementation plan into the strongest result the current host can actually produce without pretending unavailable capabilities were exercised.

# Core rules

1. Never simulate a command, checkout, runtime, agent, CI result, or independent verification that did not occur.
2. Use repository-declared commands and versions for authoritative verification, but do not confuse inability to run them with inability to produce a useful patch.
3. Treat direct-child agents as optional transport. Roles are logical responsibilities, not assumed tool primitives.
4. Require separated context only for evaluation steps whose independence matters. Record `SEPARATE_HANDOFF_OBSERVED` when that is all the host can establish; do not claim cryptographic freshness.
5. A fresh context never implicitly shares another context's local worktree. Independent verification of a local-only candidate requires a `CANDIDATE_HANDOFF` conforming to `CANDIDATE_HANDOFF_CONTRACT.md`.
6. Content hash + logical role are authoritative for task inputs. Attachment/display filenames are non-authoritative metadata.
7. A search miss is discovery evidence only; direct known-path/directory reads or executable behavior are required for absence/ownership claims.

# Status model

Capability status values:

- `AVAILABLE` — exercised or directly proven in this host.
- `AVAILABLE_VIA_FALLBACK` — required outcome is possible through a specified alternate route.
- `DEGRADED` — partially usable but insufficient for an authoritative claim.
- `UNAVAILABLE` — cannot be exercised here.
- `NOT_REQUIRED_THIS_PHASE` — intentionally irrelevant to the current phase.

Execution state values:

`SPEC_READY -> READY_TO_PATCH -> PATCH_CREATED_UNVERIFIED -> LOCALLY_VERIFIED -> CANDIDATE_PACKAGED -> INDEPENDENTLY_VERIFIED -> PUBLISHABLE`

A task may stop at any intermediate state with `INCOMPLETE` while still returning all useful artifacts produced so far.

# Phase capability gates

## Phase A — Compile/spec

Required: task inputs, repository read route, local artifact-write route if artifacts are requested.

Not required: local checkout, package manager, runtime, `gh`, direct-child agents, independent evaluator, GitHub write authority.

Output: source map, normalized requirements, unresolved facts, intended modification scope.

## Phase B — Implement

Preferred: writable local checkout, shell, `git`.

Repository-native package manager/runtime are **not mandatory to create a patch**. If absent, implementation may continue only when the edit target and semantics can be established from repository evidence. The result is `PATCH_CREATED_UNVERIFIED`; never claim compile/test success.

If no writable checkout exists, an implementation may still produce a reviewable connector-derived patch/artifact when the available repository tools support exact-file reads and writes. Mark all unexecuted local checks `INCOMPLETE`.

Before edits, record base ref/SHA and preserve unrelated work. Distinguish:

- **external/base drift** — repository or user work changed outside the controlled candidate; requires affected-source refresh;
- **controlled candidate mutation** — edits made by this task; requires diff/evidence review, not full re-cartography after every edit.

## Phase C — Local verification

Required for `LOCALLY_VERIFIED`: runnable exact candidate plus repository-approved package-manager/runtime route and all mandatory checks relevant to the changed scope.

Example: if a repository declares `pnpm@10.33.0`, that version or a freshly repository-approved compatible route is required for an authoritative pnpm-based PASS. Its absence does **not** retroactively invalidate a source patch; it leaves the patch unverified.

Record exact commands, cwd, exit status, tool/runtime versions, candidate identity, and relevant output summaries.

## Phase D — Independent verification

Required for `INDEPENDENTLY_VERIFIED`: evaluator context separated from implementer reasoning plus exact candidate transport.

Accepted transport:

- shared immutable checkout/candidate reachable by both contexts;
- remote branch/commit if publication of that branch is explicitly authorized;
- portable `CANDIDATE_HANDOFF` when publication is local-only or filesystems are not shared.

A direct-child launcher is optional. Separate manual/new-context handoff is acceptable. If no independent transport can be executed, final verdict is at most `INCOMPLETE`; implementation artifacts remain usable.

## Phase E — Publication

Required only when the user authorizes publication. Determine the allowed mutation surface explicitly: local commit only, remote branch, draft PR, ready PR, merge, issue/comment, or other action.

Never infer publication authority from connector permissions alone.

# Logical roles

Hosts may combine roles in one context unless independence would be compromised:

- **Preflight Analyst**: combines spec audit, repo cartography, and runtime/evidence gatekeeping.
- **Implementation Role**: edits only after required implementation facts are resolved.
- **Independent Verifier**: separated from implementer reasoning and evaluates the transported exact candidate.
- **Independent Falsifier**: optional by default; required only when the task plan/risk model explicitly requires a second independent path.
- **Evidence/Publication Role**: records final evidence and publishes only within user authority.

Do not create a seven-context workflow merely because seven logical concerns exist.

# Package-manager and runtime rule

Repository declarations establish the command needed to claim authoritative test/typecheck/lint results. They are not universal prerequisites for analysis or patch construction.

For every unavailable tool, state:

- which transition it blocks;
- which work can still proceed;
- the fallback, if any;
- which claims remain forbidden.

# Candidate handoff rule

Before independent verification of a candidate not reachable by immutable shared commit, create a candidate handoff containing at least:

- repository identity and base SHA;
- candidate SHA when available;
- complete patch or source archive representing tracked and untracked candidate files;
- changed/untracked file manifest;
- SHA-256 for every transported artifact;
- worktree status at packaging time;
- dependency/lockfile identity where relevant;
- commands already run and their results;
- explicit known-unexecuted checks.

The evaluator must reconstruct or inspect exactly this candidate, not a nearby branch or regenerated approximation.

# Evidence semantics

Use `PASS`, `FAIL`, `INCOMPLETE` per criterion:

- `PASS`: required evidence was actually exercised and satisfied.
- `FAIL`: required behavior was exercised or inspected and violated.
- `INCOMPLETE`: no failure is proven but required evidence/capability is absent, incompatible, or unexecuted.

Do not turn an environmental limitation into a product-code failure.

# Stop conditions

Hard-stop only the transition that actually depends on the missing condition. Examples:

- no package manager: block `LOCALLY_VERIFIED`, not necessarily `READY_TO_PATCH`;
- no independent context/candidate transport: block `INDEPENDENTLY_VERIFIED`, not implementation;
- no publication authority: block remote publication, not local verification;
- ambiguous safety/policy/authorization semantics: block the modifying task that depends on them;
- external/base drift not reconciled: block further edits until affected source is refreshed.

# Required end report

Report:

- base and candidate identity;
- highest execution state reached;
- files/artifacts changed or produced;
- checks actually run;
- checks not run and why;
- independent-verification transport/status;
- publication actions actually taken;
- remaining blockers mapped to the next blocked transition.
