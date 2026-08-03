# Current shared-memory implementation

## Confirmed capabilities

- `memory-domain` owns identity, aliases, rooms, authorization, events,
  causality, generation, delivery, correction, provenance, and `MemoryPort`.
- `memory-sqlite` owns schema migrations through v7, repositories,
  unit-of-work, connection durability checks, backup, reconciliation, and the
  cross-process writer-ownership guard.
- Discord actor evidence is frozen from event-local data without using names as
  identity keys.
- Canonical feature flags, validation, posture, and rollback policy exist.
- `MEMORY_MODE` centrally expands validated off/shadow/active/degraded profiles;
  conflicting low-level flags fail startup.
- The Discord composition boundary provides inert off mode, guarded shadow
  mode, and an active implementation target with fail-closed turn contracts.
- Active text and voice prompts use only authorized durable logical-room
  context plus current input. Physical rooms remain provenance and ingress
  authorization boundaries.

## Active work item

Active-memory stabilization tasks A1-A7 are implemented. A8 remains open until
the private Discord soak is executed and reviewed; active-ready is not claimed.

## Schema and rollout

- Latest SQLite schema: v7.
- Runtime rollout: off by default; production and ordinary local use remain in
  shadow. Active is an implementation/test target pending the A8 soak gate.
- Default memory flags: all false (`ephemeral`).

## Local constraints and risks

- Repository-local state under `/.local/memory` is lost if the checkout is
  deleted; same-disk backups do not protect against disk loss.
- Database, spool, reports, exports, and logs are sensitive plaintext.
- Node's built-in SQLite API emits an experimental-feature warning.
- Formal approval is absent and owner risk is accepted for private local use.
- Degraded mode is not activatable until its spool protocol is implemented and tested.
- Summary, automatic-extraction, vector, graph, and remote workers remain gated;
  no unsupported capability is advertised as operational.

## Completion validation (2026-08-02)

- Discord typecheck passed.
- Discord tests: 41 files, 397 tests passed.
- SQLite tests: 14 files, 127 tests passed.
- Domain tests: 10 files, 206 tests passed.
- `git diff --check` passed (line-ending notices only).
- Shadow trace coverage includes text and voice, multi-speaker causality,
  playback eligibility, restart continuity, and observable write failure.

## Baseline (2026-08-02)

- Start commit: `42f7e82f8015e969ee8b9be47e0f7fa8613354f9`.
- Starting tree: untracked `plan_DC_bot_revised.md`; preserved.
- `git diff --stat`: empty.
- `git diff --check`: passed.
- `pnpm -F @proj-airi/memory-domain test`: 10 files, 206 tests passed.
- `pnpm -F @proj-airi/memory-sqlite test`: 14 files, 127 tests passed.
- `pnpm -F @proj-airi/discord-bot test`: 34 files, 374 tests passed.

## Increment 1 validation (2026-08-02)

- `pnpm -F @proj-airi/discord-bot typecheck`: passed.
- Focused memory tests: 8 files, 57 tests passed.
- `pnpm -F @proj-airi/memory-domain test`: 10 files, 206 tests passed.
- `pnpm -F @proj-airi/discord-bot test`: 38 files, 383 tests passed.
- Targeted ESLint over all changed TypeScript files: passed.
- One earlier full Discord run failed one timing-sensitive voice assertion; the
  immediate full rerun passed 383/383 without a production change to that path.

## Active-memory stabilization validation (2026-08-03)

- Discord tests: 41 files, 403 tests passed.
- SQLite tests: 14 files, 129 tests passed.
- Domain tests: 10 files, 206 tests passed.
- Discord, SQLite, and domain typechecks passed.
- Targeted ESLint over every changed TypeScript file passed.
- IMP-208 production-shaped benchmark completed with 2,000 operations,
  498.21 operations/second, zero busy/locked errors, verified integrity,
  online backup, and restore.
- Exact commands and limitations are recorded in
  `docs/memory/evidence/active-stabilization-2026-08-03.md`.
- A private Discord soak was not executable in this environment. Active-ready
  remains blocked; no activation documentation was promoted.
