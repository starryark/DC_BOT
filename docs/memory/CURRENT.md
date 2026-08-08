# Current shared-memory implementation

## Confirmed capabilities

- `memory-domain` owns identity, aliases, rooms, authorization, events,
  causality, generation, delivery, correction, provenance, and `MemoryPort`.
- `memory-sqlite` owns schema migrations through v8, repositories,
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

Active-memory stabilization tasks A1-A7 are implemented. The active-soak
evidence programme T001-T004 is committed on `main`: schema v8 generation-context
manifests, persisted privacy operations, the `pnpm memory:active-soak`
prepare/report/verify tool, its policy module and tests, and the private-soak
runbook.

**A8 is closed.** The private Discord soak was executed on 2026-08-05 as run
`t002-86ca5cfc-20260805b` and **qualified commit
`86ca5cfc674997820fe4d1f235d1d16f30ce1470`**: twelve of twelve scenarios
observed pass, all seven machine assertions pass, and `report` and `verify` both
exit zero at that exact commit. The redacted report and the qualification record
are in `docs/memory/evidence/`.

The result is **operator-qualified**. The independent-review gate was removed in
`7a3fd5e`, so no reviewer decision exists and none is required. Cite it with
that term only — attributing the result to a reviewer would assert something
that did not happen.

The qualification binds one commit **and one configuration**. It neither
confirms nor refutes DM isolation — that scenario was removed from the matrix in
`6694c5a` because a user-installed application never receives `MESSAGE_CREATE`
for direct messages. Any source, test, dependency, migration, runbook or
configuration-source change after `86ca5cfc` invalidates it and requires a new
candidate and a fresh run.

### Shipped configuration has diverged from the qualified one

The soak ran with `BOT_INPUT_POLICY=half_duplex` and `BARGE_IN_ENABLED=false`.
`.config` now ships **`BOT_INPUT_POLICY=barge_in` with `BARGE_IN_ENABLED=true`**
so that talking over the character interrupts it, which was a deliberate
product decision taken after the run.

**The voice-interruption path is therefore not covered by the A8 qualification.**
Everything the soak established about memory — room isolation, restart
continuity, deletion, rollback, durable output completeness — still holds,
because none of it depends on the input policy. What is no longer covered is
scenario 8's cancellation behaviour, which the soak exercised through an
explicit command rather than acoustically.

Re-qualifying requires a fresh candidate and a new twelve-scenario run under
the new configuration. Until then, describe active memory as operator-qualified
at `86ca5cfc` and the barge-in configuration as **unqualified**.

Two practical constraints on barge-in, both recorded in `.config`: it needs
headphones, because an open microphone near loudspeakers feeds the character's
own audio back into the detector and reads as a speaker; and
`BARGE_IN_THRESHOLD` is untuned for any particular room.

### G8 functional baseline (IMP-802)

G8 functional baseline established for the active profile at
`40874091d9ed39337e2db6f4de30d1b7b969b186` using dataset
`1.0.0/c9ddd85a33208f857dd2b4516a5b0e733ef92c43c00b9c4fec169dd12204f1cc` and
seed `20260802`. All applicable zero-tolerance assertions passed. Unsupported
future capabilities and live transport checks remain explicit. **G8 is not passed
and no deployment approval is implied.**

The baseline is a deterministic, content-free evaluator over synthetic fixtures
(`airi/services/discord-bot/evals/memory/`) that exercises the production memory
runtime boundary in active mode with isolated temporary storage. It does not
re-qualify A8; the A8 qualification remains bound to commit
`86ca5cfc674997820fe4d1f235d1d16f30ce1470` and its configuration. It does not
claim live Discord DM transport behavior, acoustic barge-in cancellation under
the shipped configuration (which remains unqualified), or any production SLO,
retrieval-quality threshold, or deployment approval. Vector, graph, remote,
degraded, spool, summary, extraction, lexical, and semantic capabilities remain
gated and are not advertised as operational. Evidence is recorded in
`docs/memory/evidence/g8-functional-baseline-2026-08-06.md`.

### G8 deterministic performance baseline (IMP-803)

IMP-803 deterministic performance baseline recorded for the active profile at
`a215840bfc366d4ae68f8dc4c09fb86c34dded19` using contract digest
`c403dd7781fdd28c214c65010d1f36fcbb4a68c9aa849d6b7dfb2b8624e959c6` and
seed `20260802` (run `bench-2026-08-07T1903-a215840b`). The host environment was `win32 x64` running Node `v24.14.0`.
The disposition was `correctness_clean_measured_not_evaluated`. **This result does not mean G8 passed or deployment approved.**

## Schema and rollout

- Latest SQLite schema: v8.
- Runtime rollout: off by default; production and ordinary local use remain in
  shadow. Active has **passed the A8 soak gate** at `86ca5cfc` and is available
  as a deliberate per-deployment opt-in; qualifying it did not change the
  default, and nothing enables it automatically.
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

## Active-soak evidence boundary hardening (2026-08-04)

Pre-soak hardening of the A8 evidence tooling. No runtime behaviour, migration
SQL, migration checksum, or default flag changed.

- `prepare` and `report` refuse an output directory inside the repository
  checkout, so the run state, pre-soak backup, and backup manifest cannot be
  staged.
- Private artifacts are published owner-only where POSIX modes are
  authoritative, and `prepare` fails closed if they are not. Windows requires an
  ACL-protected evidence directory instead; the runbook records that and
  `prepare` reports which regime applied.
- `report` opens only the authority bound during `prepare`; `--root` may restate
  the bound root but may not redirect to another database.
- Each of the thirteen scenarios must be attested exactly once, with
  `from` strictly before `to` and no overlapping or touching windows.
- The deletion gate requires the `forget-deletion-migration-replay` window to
  contain at least one durable forget request and at least one tombstone; an
  empty database no longer satisfies it by absence.
- The redacted report carries the pre-soak backup digest but never its path.
- The attestation's reviewer-independence flag is documented as an operator
  self-report; the dated reviewer decision remains authoritative.
- Operator-level tests cover dirty worktree, wrong commit, in-repository output,
  in-repository runtime root, missing authority, unparsable and multi-guild
  bindings, reused run identity, backup and digest creation, report authority
  mismatch, and nonzero `verify` exit status.
