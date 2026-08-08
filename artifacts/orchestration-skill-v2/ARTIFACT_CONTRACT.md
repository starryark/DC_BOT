# Artifact Contract v2

This contract defines reusable orchestration artifacts. It deliberately separates reusable infrastructure from live task instances.

## Identity rule

Every supplied/generated artifact has:

- logical role;
- content SHA-256 when deterministic access permits it;
- display/attachment filename as non-authoritative metadata;
- source class: `OBSERVED`, `INFERRED`, `PROPOSED`, or `UNVERIFIED` where applicable.

When filename and hash/history disagree, preserve both identities and use the source-of-truth order; never silently treat a renamed attachment as a different task.

## Reusable vs task-instance files

Reusable bundle files may include:

- `SKILL.md`;
- `MASTER_ORCHESTRATOR_PROMPT.md`;
- `INDEPENDENT_EVALUATOR_PROMPT.md`;
- `CANDIDATE_HANDOFF_CONTRACT.md`;
- this contract;
- `USAGE.md`.

Do **not** place live-looking task-specific `Plan.md`, factory requests, candidate reports, benchmark outputs, or stale task instantiations beside reusable files. Put examples under a clearly labeled `examples/` path and mark them non-authoritative.

## Generated task packet

When a plan requires a normalized task packet, prefer these flat artifacts unless the task source requires another shape:

1. `TASK_SKILL.md` — task-specific invariants, scope, allowed/forbidden changes, phase transitions and publication contract.
2. `COMPILED_SPEC.md` — normalized requirements/invariants/tasks/gates/stops with source references and acceptance evidence.
3. `REPO_CONTEXT.md` — repository identity, relevant file/command map, environment facts, unresolved ownership, drift rule.
4. `EVALUATION_RUBRIC.md` — criterion-by-criterion PASS/FAIL/INCOMPLETE rules and adversarial checks.

`SUBAGENT_BRIEFS.md` is optional. Generate it only when the chosen host/workflow will actually use separately transported roles. Do not manufacture a multi-agent hierarchy when one preflight context plus an independent evaluator is sufficient.

## Phase-aware gate requirement

Every gate must identify:

- the transition it blocks;
- required evidence;
- PASS/FAIL/INCOMPLETE meaning;
- what work may still continue if the gate is INCOMPLETE;
- fallback transport/capability when one exists.

Do not make a later-phase capability a prerequisite for an earlier phase without a source-backed reason.

Examples:

- missing repository package manager blocks authoritative package-manager verification, not automatically patch construction;
- missing independent evaluator blocks independent PASS, not implementation;
- missing remote publication authority blocks push/PR, not local verification.

## Capability table

Use statuses:

`AVAILABLE`, `AVAILABLE_VIA_FALLBACK`, `DEGRADED`, `UNAVAILABLE`, `NOT_REQUIRED_THIS_PHASE`.

For package managers/runtimes, record the repository declaration separately from host availability. A declaration such as `pnpm@10.33.0` means that tool/version is required for claims that depend on the repository's pnpm execution route; it is not proof the current host can install or run it.

## Candidate transport artifact

When independent evaluation cannot directly access the exact candidate, the task packet/run evidence must include or reference a `CANDIDATE_HANDOFF` conforming to `CANDIDATE_HANDOFF_CONTRACT.md`.

Independent verification is `INCOMPLETE` until candidate identity/reconstruction succeeds.

## Drift rule

Separate:

- base/external drift: upstream ref movement or unrelated user changes; re-read affected ownership/contract surfaces before continuing;
- controlled candidate edits: task-produced changes; review the diff and update candidate identity, but do not require full repository rediscovery after each edit.

## Evidence outputs

Evidence contains concise facts, not hidden reasoning:

- source/hash identities;
- base/candidate/handoff identity;
- changed-file inventory;
- capability state by phase;
- exact commands/cwd/exit status/tool versions;
- test/benchmark summaries and artifact hashes;
- criterion verdicts;
- unresolved blockers and next blocked transition;
- publication actions actually taken.

## Final decision rule

A final `PASS` applies only to the highest transition whose required criteria were actually exercised.

A run may validly report:

- implementation state `PATCH_CREATED_UNVERIFIED`;
- local-verification state `INCOMPLETE`;
- independent-verification state `INCOMPLETE`;

without describing the patch itself as a failed implementation.
