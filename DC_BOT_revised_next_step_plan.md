# DC_BOT Revised Next-Step Plan — Evidence Hardening, Private Active Soak, and Independent Promotion

## 1. Revision basis

- **Repository:** `starryark/DC_BOT`
- **Previously inspected commit:** `7f5468f332f5b2da4e19b418d9fc3a4d640f3136`
- **Current observed `main`:** `ebaee2269dffc64013128bbd24f65691dece61bc` (`T001-T004`, committed 2026-08-04)
- **Scope:** AIRI shared-memory implementation, Discord active-soak tooling, private-guild runtime qualification, and A8 promotion evidence.
- **Current posture:** Runtime defaults remain all-off. Active memory is implemented but is not active-ready until the private soak and independent review pass at one exact candidate SHA.

The previous plan assumed the T001-T004 implementation existed only as an uncommitted local overlay. That premise is now obsolete: the implementation is committed on `main`. The active-soak package script, policy module, CLI, schema v8, privacy operations, tests, and private-soak runbook are present.

The remaining work is not feature development. It is evidence-tool hardening, candidate qualification, live execution, and independent promotion.

## 2. Current findings that change the plan

### Confirmed implementation

- `pnpm memory:active-soak` exposes `prepare`, `report`, and `verify` stages.
- `prepare` requires a clean worktree, exact 40-character commit match, an isolated runtime root, a private single-guild binding file, database integrity, exclusive write ownership, and a verified pre-soak backup.
- The runbook defines thirteen mandatory scenarios and requires both machine evidence and human observation.
- Reports replace published identifiers with run-scoped HMAC values and reject raw Discord snowflakes, UUIDs, and durable identifier prefixes.
- The verifier checks commit and schema identity, required scenarios, machine assertions, unresolved deliveries, deletion, old-backup restore, rollback, and redaction.
- SQLite schema v8 adds persisted generation-context manifests.
- Memory feature defaults remain all false.

### Pre-soak blockers and hardening gaps

1. **Status documentation is stale.** `docs/memory/CURRENT.md` still states schema v7 and references the prior validation totals, although the candidate ships schema v8 and the active-soak tooling.
2. **The new soak runbook is not governed by the existing program-document test.** `program-docs.test.ts` checks the older status, evidence-index, ADR, and rollout documents but does not include `airi/docs/memory/runbooks/active-memory-soak-and-rollout.md`.
3. **Sensitive output location is not fail-closed.** `prepare` requires `--out` to be absolute but does not reject an output directory inside the repository. The run state, backup, and backup manifest can therefore be created under the checkout and accidentally staged.
4. **Evidence authority can be overridden during reporting.** `report` may accept a runtime root different from the one recorded by `prepare`; it should read the exact authority path bound into the private run state or reject any mismatch.
5. **Scenario evidence can be over-counted.** The attestation and verifier do not require exactly one unique entry for each scenario or non-overlapping scenario windows. Overlapping windows could allow one generation to satisfy several scenario-presence checks.
6. **Deletion proof is too permissive.** Verification accepts the deletion attestation when no tombstone is unverified, but does not require that the deletion scenario actually produced a forget request and tombstone.
7. **Backup binding is private-only.** The run state records the pre-soak backup digest, but the redacted report does not carry a non-sensitive digest that lets the reviewer confirm which backup was bound to the run.
8. **CLI behavior lacks direct integration coverage.** The policy module has focused unit tests, but candidate qualification should add tests for the filesystem, git, output-location, authority-path, and repeated-run guards.
9. **No GitHub status checks are attached to the current commit.** Repository-native verification must therefore be reproduced and recorded before the live run.

These issues do not justify redesigning the memory system. They justify one narrow pre-soak hardening increment and a new immutable candidate SHA.

## 3. Desired outcome

Produce one evidence-qualified candidate whose full SHA binds all of the following:

1. source and tests;
2. schema version and migration checksums;
3. private runtime root and authority database;
4. private guild binding digest;
5. pre-soak backup digest;
6. thirteen scenario windows and human observations;
7. redacted machine report;
8. independent reviewer decision.

A8 closes only when the private soak passes and an independent reviewer accepts the same candidate SHA. Closure makes that exact commit and configuration eligible for deliberate opt-in; it does not enable memory by default or authorize general production rollout.

## 4. Non-goals

- Do not add another memory abstraction, report database, redaction engine, or reviewer schema.
- Do not modify applied migration SQL or checksums.
- Do not weaken integrity, foreign-key, delivery-lifecycle, room-isolation, deletion, or rollback checks.
- Do not change ASR, model, TTS, playback, or Discord providers.
- Do not enable semantic memory, summaries, extraction, vector, graph, remote transport, or degraded mode.
- Do not commit credentials, binding specifications, raw logs, raw observer notes, raw identifier mappings, run-state files, HMAC keys, authority databases, or backups.
- Do not treat an environmental abort, partial scenario matrix, or reviewer discrepancy as a pass.

## 5. Execution plan

### T001 — Harden the active-soak evidence boundary and freeze a new candidate

**Depends on:** None.

**Primary paths:**

- `airi/services/discord-bot/scripts/memory/active-soak.ts`
- `airi/services/discord-bot/src/memory/active-soak.ts`
- `airi/services/discord-bot/src/memory/active-soak.test.ts`
- `airi/services/discord-bot/package.json`
- `airi/packages/memory-sqlite/src/backup.ts`
- `airi/docs/memory/runbooks/active-memory-soak-and-rollout.md`
- `docs/memory/CURRENT.md`
- `docs/memory/evidence/evidence-index.md`
- `airi/services/discord-bot/src/memory/program-docs.test.ts`

**Required changes:**

1. Reject `--out` when it resolves inside the repository. Require a private absolute output directory outside the checkout.
2. Create the output directory and all private artifacts with restrictive permissions where the platform supports them. At minimum, explicitly protect the run state, backup, and backup manifest; document the Windows ACL requirement where POSIX modes are not authoritative.
3. Make `report` open only the authority recorded in the run state. Remove the runtime-root override or require exact equality with the bound root and authority path.
4. Require exactly thirteen attestation entries, one for each scenario ID, with no duplicates. Require `from < to` and reject overlapping scenario windows unless the runbook explicitly identifies an allowed overlap.
5. Require affirmative durable deletion evidence for `forget-deletion-migration-replay`: at least one forget request, at least one tombstone, no unverified tombstones, and successful old-backup restore attestation.
6. Add the pre-soak backup digest to the redacted report. Do not publish its path.
7. Keep reviewer independence as an external review fact. Do not describe the operator-authored boolean as machine proof of independence; the dated reviewer decision remains authoritative.
8. Add CLI-level tests covering dirty worktree refusal, wrong commit, output inside the repository, reused run ID, missing authority, invalid/multi-guild binding, report authority mismatch, backup creation, and nonzero verification failures.
9. Update `docs/memory/CURRENT.md` to schema v8 and record that T001-T004 are committed while A8 remains open.
10. Add the active-soak runbook and its promotion targets to program-document governance tests. Add an evidence-index row for the active-soak implementation without claiming a successful live soak.

**Candidate freeze:**

After the hardening changes and documentation alignment pass verification, commit once. Record the resulting full SHA as `CANDIDATE_SHA`. No code, dependency, runbook, test, or configuration-source change is permitted after this point. Any such change invalidates all later evidence and restarts T001.

**Acceptance criteria:**

- Clean worktree after commit.
- `prepare` rejects an in-repository output path.
- `report` cannot inspect a different authority from the one bound during preparation.
- Duplicate, missing, reversed, or impermissibly overlapping scenario windows fail.
- A deletion scenario with zero forget requests or tombstones fails.
- The report contains the backup digest but no private path or raw identifier.
- Status documentation says schema v8 and A8 open.
- The new runbook is covered by governance tests.
- No sensitive artifact is tracked.

**Verification:**

From `airi` or the relevant package directory, record exact versions, commands, totals, and exits for:

```text
pnpm -F @proj-airi/memory-domain typecheck
pnpm -F @proj-airi/memory-domain test
pnpm -F @proj-airi/memory-sqlite typecheck
pnpm -F @proj-airi/memory-sqlite test
pnpm -F @proj-airi/discord-bot typecheck
pnpm -F @proj-airi/discord-bot test
pnpm -F @proj-airi/memory-sqlite benchmark:imp208
pnpm eslint <all changed TypeScript paths>
git diff --check
git status --porcelain
```

Also run a tracked-file and staged-file scan for credentials, Discord snowflakes, UUID-shaped private identifiers, run-state names, SQLite databases, backup manifests, binding files, and HMAC keys.

### T002 — Prepare and execute the private active soak

**Depends on:** T001 and the immutable `CANDIDATE_SHA`.

**External prerequisites:**

- Dedicated Discord credential installed only in a private guild.
- Private text, thread, and voice locations.
- Working ASR, model generation, TTS, and Discord playback.
- Absolute isolated runtime root outside the checkout.
- Absolute private evidence directory outside the checkout.
- Private single-guild binding file with no DM bindings.
- Human observer available for visible and audible results.
- Verified v7 backup for the migration/restore scenario.
- Independent reviewer identified before execution but not acting as implementer or primary observer.

**Preparation:**

Run from `airi/services/discord-bot`:

```text
pnpm memory:active-soak -- prepare \
  --run-id <unique-slug> \
  --commit <CANDIDATE_SHA> \
  --root <absolute-isolated-runtime-root> \
  --binding-file <absolute-private-binding-file> \
  --out <absolute-private-evidence-directory>
```

Before starting the bot, independently confirm:

- `git rev-parse HEAD` equals `CANDIDATE_SHA`;
- `git status --porcelain` is empty;
- the run state is private and records schema v8, binding digest, backup digest, and all thirteen scenarios;
- the pre-soak backup and manifest exist and pass integrity/readability checks;
- the evidence directory is not under the repository;
- no other bot process owns the authority database.

**Live execution:**

Execute the thirteen runbook scenarios in distinct recorded windows:

1. startup binding reconciliation;
2. empty-history text;
3. bound text/voice recall;
4. bound parent/thread behavior;
5. unbound guild isolation;
6. DM isolation;
7. restart continuity;
8. multi-segment text delivery;
9. completed and cancelled voice playback;
10. privacy status/show/export;
11. disabled remember/correct;
12. forget, deletion verification, v7 restore, migration, and obligation replay;
13. stopped-process active-to-off rollback.

For every scenario, record the operator action, expected durable records, expected manifest, delivery state, human observation, start/end timestamps, and cleanup action. Visible or audible success without matching durable evidence fails. Durable evidence without visible or audible delivery also fails.

Stop immediately on:

- wrong SHA, dirty tree, or changed configuration source;
- ASR/model/TTS/playback unavailability that prevents completion;
- cross-room, cross-thread, guild, or DM leakage;
- missing or late manifest evidence;
- manifest digest mismatch;
- unresolved delivery state;
- semantic write while disabled;
- unverified deletion tombstone;
- failed old-backup migration or obligation replay;
- raw identifier leakage;
- machine/human disagreement;
- unsafe rollback attempt.

An environmental abort is recorded as incomplete, not failed or passed. A code or runbook correction creates a new candidate SHA and restarts T001. A pure rerun at the unchanged SHA uses a new run ID and retains the prior defect/rerun record.

**Report and local verification:**

After stopping the bot:

```text
pnpm memory:active-soak -- report \
  --state <private-run-state.json> \
  --attestation <operator-attestation.json>

pnpm memory:active-soak -- verify \
  --report <redacted-report.json> \
  --commit <CANDIDATE_SHA>
```

**Acceptance criteria:**

- All thirteen unique scenarios are present and observed as pass.
- Every required scenario has scenario-specific durable evidence.
- Every machine assertion passes.
- No delivery remains pending, delivering, or unknown after crash.
- Deletion generated and verified real forget/tombstone evidence.
- The v7 backup restore, migration to v8, and obligation replay pass.
- The active-to-off window contains no durable generation evidence.
- The report matches `CANDIDATE_SHA`, schema v8, binding digest, and backup digest.
- Every published identifier has the run-scoped HMAC shape; no raw content or identifier appears.
- The repository remains clean and unchanged.

### T003 — Independent same-commit review and decision

**Depends on:** A complete T002 evidence bundle.

The reviewer receives:

- `CANDIDATE_SHA`;
- the active-soak runbook;
- the redacted report;
- operator attestation and observer record;
- report and backup digests;
- defect/rerun records, if any;
- secure access to the private run state, binding digest source, backup, and raw evidence needed for reconciliation.

The reviewer must not be the implementer of the report tooling or the primary observer. The reviewer checks out the exact candidate SHA and independently runs:

```text
pnpm memory:active-soak -- verify \
  --report <redacted-report.json> \
  --commit <CANDIDATE_SHA>
```

The reviewer also confirms:

- all required scenario IDs occur exactly once;
- windows and operator actions correspond to distinct executions;
- machine assertions correspond to the private authority records;
- playback and visible delivery observations agree with durable delivery states;
- deletion, restore, replay, and rollback evidence are complete;
- the report digest, binding digest, and backup digest match the private evidence;
- no secret or de-anonymization material is present in committed artifacts;
- the candidate was not modified after preparation.

**Decision:**

- **Accept:** Explicitly state that the exact candidate SHA and tested configuration are evidence-qualified for deliberate active opt-in.
- **Reject:** Name every unmet condition. Do not assign partial active-ready status. A requested code, test, or runbook change returns to T001.

The decision must be dated, identify reviewer and observer roles, and distinguish the reviewed candidate SHA from any later documentation-only commit.

### T004 — Record the A8 outcome without activating rollout

**Depends on:** T003 final decision.

**Commit only:**

- the redacted JSON report;
- the dated reviewer decision;
- any sanitized defect/rerun record;
- updated status and evidence-index references.

Update `docs/memory/CURRENT.md`, the stabilization evidence index, and any canonical gate table to include:

- candidate SHA;
- run ID in safe form;
- execution date;
- schema version;
- binding and backup digests;
- machine assertion summary;
- observer and reviewer roles;
- redacted report path and digest;
- explicit accepted or rejected outcome.

On acceptance, close only A8 for the reviewed candidate and configuration. State prominently that:

- default memory flags remain all false;
- ordinary rollout remains unchanged;
- active use requires separate deliberate authorization;
- semantic, summary, extraction, vector, graph, remote, and degraded gates remain closed.

On rejection, leave A8 open and record the failed condition and next corrective task.

Because this is a later documentation/evidence commit, it must clearly say that the live soak qualified `CANDIDATE_SHA`, not the documentation commit itself.

Run the complete governance, package, typecheck, lint, secret-scan, and diff-check ladder again. Directly assert that `MEMORY_FLAGS_ALL_OFF` remains unchanged.

## 6. Task order and invalidation rules

```text
T001 harden and freeze candidate
  → T002 prepare, execute, report, verify
    → T003 independent same-SHA review
      → T004 record accepted/rejected outcome
```

- The reviewer may pre-read the runbook after T001, but acceptance cannot begin before T002 finishes.
- No candidate mutation is allowed after T001.
- A source, test, dependency, migration, runbook, or configuration-source change invalidates the run and returns to T001.
- A failed or incomplete scenario at the unchanged SHA may be rerun under a new run ID only after preserving the prior record and restoring a known clean runtime state.
- A documentation-only promotion commit does not become the qualified runtime SHA.

## 7. Definition of done

The work is complete only when:

1. the evidence boundary is hardened and fully tested;
2. one clean candidate SHA passes all static, unit, integration, benchmark, lint, and repository checks;
3. a private-guild run completes all thirteen distinct scenarios with real ASR/model/TTS/playback;
4. every machine assertion and human observation passes;
5. deletion, v7 restore/migration/replay, and active-to-off rollback are verified;
6. the redacted report is bound to the candidate, schema, binding, and backup digests;
7. an independent reviewer accepts or rejects the same SHA;
8. the repository records the sanitized result without secrets;
9. A8 closes only on acceptance;
10. all defaults remain off and no rollout is automatically enabled.
