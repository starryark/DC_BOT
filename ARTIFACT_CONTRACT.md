# Flat Run-Packet Artifact Contract

All generated task artifacts are sibling Markdown files in one directory. Do not create nested agent folders, nested skills, or subagent-specific directories.

## 1. `TASK_SKILL.md`

Purpose: task-specific operational skill distilled from `Plan.md` and verified repository context.

Required sections:

```text
---
name: <task-specific-kebab-name>
description: <when this task skill applies>
---
# Goal
# Inputs
# Source-of-truth order
# Invariants
# State machine / gates
# Tool routing
# Capability requirements / fallback
# Required repository reads
# Allowed modifications
# Forbidden modifications
# Verification ladder
# Stop conditions
# Evidence outputs
# Publication contract
```

Rules:

- It is a thin task skill, not a second orchestration hierarchy.
- It may not spawn agents.
- It may not contradict `Plan.md` without documenting the verified source evidence that caused the correction.
- Every hard-coded repository path must exist in the verified snapshot or be marked `UNRESOLVED`.

## 2. `COMPILED_SPEC.md`

Purpose: normalized, testable specification.

Required sections:

### Identity
- repository
- requested ref
- plan/reference identity (attachment/reference and SHA-256 when deterministically available)
- analysis/pinned revision
- current candidate revision if known
- publication authority

### Objective
One precise outcome statement.

### Fact classes
Use a table with:

| ID | Class | Statement | Source | Confidence |
|---|---|---|---|---|

`Class` must be one of:
- `OBSERVED`
- `INFERRED`
- `PROPOSED`
- `UNVERIFIED`

### Requirements
Each `REQ-###` must include:
- behavior/deliverable;
- source;
- acceptance evidence.

### Invariants
Each `INV-###` must include:
- invariant;
- why it matters;
- how violation is detected.

### Task DAG
Each `TASK-###` must include:
- `depends_on`;
- exact path/symbol if verified;
- allowed modifications;
- forbidden modifications;
- acceptance criteria;
- verification;
- output evidence.

### Gates
Each `GATE-###` must include:
- precondition;
- required evidence;
- `PASS`, `FAIL`, and `INCOMPLETE` meaning;
- downstream tasks blocked.

### Stop conditions
Each `STOP-###` must name the exact condition and the required report behavior.

### Definition of done
Must be reconstructable from the requirements and evidence, not a vague success statement.

## 3. `REPO_CONTEXT.md`

Purpose: independently verified repository map used by all agents.

Required sections:

### Repository identity
- owner/name
- default branch
- requested ref
- pinned head SHA
- acquisition method
- timestamp/date of verification

### Drift rule
Explain what must be re-read if head or local worktree differs from the pinned snapshot.

### Relevant file map

| Path | Role | Why relevant | Verified at | Notes |
|---|---|---|---|---|

Include exact paths for:
- entry points/commands;
- contracts/schemas/policy;
- core implementation path;
- adapters/runners;
- reports/evidence;
- focused tests;
- package scripts/build/test config.

### Command map
List repository-native commands, the exact working directory (`cwd`) each requires, and what each proves. Do not invent commands from package-manager conventions; verify the workspace/package-manager declaration and command location.

### Environment/evidence dependencies
- OS/runtime expectations;
- external artifact locations/identities if known;
- secrets/credentials if genuinely required (never include secret values);
- clean/dirty worktree requirements;
- output-location safety requirements;
- required host capabilities (fresh-context/direct-child invocation, local checkout, shell/process execution, `git`, package manager, runtime, external writable output, GitHub read/write actions as applicable);
- capability fallback (`fresh-context handoff`) or `INCOMPLETE/BLOCKED` behavior for each required unavailable capability;
- repository lookup rule: direct known-path/directory reads are authoritative for existence/ownership; code search is discovery-only and a miss is not negative proof.

### Historical identity map
When evidence was generated at one commit and documented at another, name both and explain their roles.

### Unresolved context
List missing artifacts, ambiguous ownership, or paths not yet traced.

## 4. `SUBAGENT_BRIEFS.md`

Purpose: prompts/scopes for direct children of the master orchestrator.

Must define these roles:

### Spec Auditor
Inputs: Plan.md, COMPILED_SPEC.md, TASK_SKILL.md.
Output: `SPEC_AUDIT` with PASS/FAIL/INCOMPLETE, contradictions, missing requirements, and exact source references.
Forbidden: code edits, repository writes, accepting unverified assumptions.

### Repo Cartographer
Inputs: Plan.md, REPO_CONTEXT.md, current repository read access.
Output: `REPO_AUDIT` with pinned head, verified paths/symbols, test surfaces, call/import map, drift findings.
Forbidden: code edits, relying on stale repo context without checking head.

### Evidence / Runtime Gatekeeper
Inputs: COMPILED_SPEC.md, REPO_CONTEXT.md, external artifacts/logs/manifests, runtime/tool access.
Output: `EVIDENCE_GATE` with verified hashes/identities/environment/policy and READY/BLOCKED.
Forbidden: optimizing code, manufacturing missing policy/artifacts, converting missing evidence into pass.

### Implementation Agent
Inputs: only after gate READY; TASK_SKILL.md, COMPILED_SPEC.md, REPO_CONTEXT.md, concrete gate findings.
Output: patch + focused tests + `IMPLEMENTATION_REPORT` describing invariant, files changed, commands executed, local candidate SHA if frozen.
Forbidden: threshold/policy/workload/test weakening, unrelated refactors, remote publication unless explicitly authorized.

### Verification Agent
Inputs: source spec, repository state/diff, candidate SHA, required runtime artifacts; no implementer reasoning transcript.
Output: `VERIFICATION_REPORT` with exact commands/results and PASS/FAIL/INCOMPLETE per rubric criterion.
Forbidden: editing the implementation to make tests pass during the same evaluation pass.

### Independent Falsifier
Inputs: same evidence class as Verification Agent plus EVALUATION_RUBRIC.md; no implementer reasoning transcript.
Output: `FALSIFICATION_REPORT` listing attempted counterexamples, policy gaming checks, semantic regressions, missing cases, and final PASS/FAIL/INCOMPLETE.
Forbidden: assuming the implementation is correct because tests pass.

### Evidence / Documentation Agent
Inputs: only after both independent evaluation paths pass; final artifacts and exact candidate identity.
Output: evidence/docs patch + `PROMOTION_AUDIT`.
Forbidden: promoting claims beyond evidence, changing product code, remote publication without authority.

Every role reports directly to the orchestrator and must not spawn another agent. If the host lacks a direct-child invocation primitive, the same role may be executed through a separate fresh-context handoff. That is a transport fallback only; the master may not impersonate the role in the same context when independence is required.

## 5. `EVALUATION_RUBRIC.md`

Purpose: a source-derived acceptance rubric that an independent evaluator can use without the implementation conversation.

Required table:

| Criterion | Requirement | Evidence required | PASS | FAIL | INCOMPLETE |
|---|---|---|---|---|---|

At minimum cover:

- scope fidelity;
- required behavior;
- invariants;
- path/ownership correctness;
- static/type checks;
- focused tests;
- integration/contract checks;
- regression suite;
- data/evidence compatibility;
- environment compatibility where relevant;
- no policy/benchmark/test gaming;
- no unrelated behavioral changes;
- reproducibility/repeatability when the plan requires it;
- documentation/evidence correctness if applicable;
- publication compliance.

Also include:

### Adversarial checks
A list of ways the implementation could appear to pass while violating the plan.

### Evidence hierarchy
Order the trusted sources for resolving disagreement.

### Final decision rule
- `PASS`: every required criterion passes.
- `FAIL`: one or more required criteria fail.
- `INCOMPLETE`: no failure is proven, but required evidence is missing/unexecuted/incompatible.

No majority vote and no averaging away a required failure.

## 6. Orchestrator run-time evidence files

The master may create the following optional flat files while executing. Place the task run-packet/evidence directory **outside the repository worktree** whenever clean-worktree state is part of authoritative execution evidence:

- `DECISION_LOG.md` — capability matrix, gate transitions, and source-backed decisions.
- `TEST_EVIDENCE.md` — commands, exit codes, environment, relevant output summaries.
- `FINAL_EVALUATION.md` — integrated final verdict from independent reports.

These files must contain evidence, not hidden chain-of-thought. Record concise rationale, sources, commands, and decisions.
