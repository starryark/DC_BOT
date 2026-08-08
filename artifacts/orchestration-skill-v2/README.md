# Orchestration Skill v2

This directory contains the tool-compatible revision of the reusable implementation/evaluation orchestration bundle.

## Design goals

- Preserve the original evidence discipline: no fabricated PASS, explicit PASS/FAIL/INCOMPLETE, exact repository/candidate identities, no policy or benchmark gaming.
- Model execution as **phases with different capability requirements** instead of one global all-or-nothing preflight.
- Treat auditor/cartographer/gatekeeper/implementer/verifier/falsifier as **logical roles**. A direct-child agent primitive is never assumed.
- Require genuine context separation only where independence is material: independent verification/falsification.
- Allow useful degradation: a patch may be produced when repository-native tooling is unavailable, but it must remain `PATCH_CREATED_UNVERIFIED` until authoritative checks run.
- Make local-only independent verification possible through a portable `CANDIDATE_HANDOFF` rather than assuming fresh contexts share a worktree.
- Make content hashes and logical roles authoritative; attachment filenames are display metadata only.

## Files

- `SKILL.md` — phase-aware execution skill and capability/status model.
- `MASTER_ORCHESTRATOR_PROMPT.md` — orchestration procedure with logical roles and graceful degradation.
- `INDEPENDENT_EVALUATOR_PROMPT.md` — independent evaluator contract for a candidate handoff.
- `CANDIDATE_HANDOFF_CONTRACT.md` — portable exact-candidate transport contract.
- `ARTIFACT_CONTRACT.md` — generated packet schema and evidence identity rules.
- `USAGE.md` — host-specific execution modes and examples.

## Non-goals

This bundle is reusable orchestration infrastructure. It does not contain a live task plan, task-specific factory request, implementation patch, policy threshold, or stale example that can be mistaken for current task truth. Task instances belong outside this directory or under an explicitly labeled `examples/` location.
