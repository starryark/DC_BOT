# DC_BOT Local Shared-Memory Implementation Plan — Revised

## 1. Objective

Implement and locally activate a safe milestone-one shared-memory path for the existing Discord bot.

This plan is intentionally narrow. It is an execution guide, not a replacement for the domain specification, test catalog, or operational runbooks.

The local checkout, including uncommitted changes, is the source of truth.

---

## 2. Coding-agent contract

### Preserve existing work

- Inspect the current checkout before editing.
- Never reset, clean, revert, overwrite, or discard existing work.
- Do not clone a second checkout as a substitute for understanding the current one.
- Do not push to a remote repository.
- Local checkpoint commits are optional, but never commit secrets or runtime artifacts.
- Never claim a command or test passed unless it was actually run.

### Reuse before creating

Reuse and extend the repository’s existing:

- `MemoryPort` and domain contracts.
- `memory-domain` models and policies.
- `memory-sqlite` migrations, repositories, unit-of-work APIs, backup APIs, connection profile, and writer guard.
- Discord actor-evidence capture.
- `MemoryFeatureFlags`, `validateMemoryFlags`, `memoryPosture`, and `validateRollback`.
- Voice cancellation, response-epoch, playback-order, and delivery behavior.
- Existing tests and benchmarks.

Do not create a competing identity model, room model, rollout state machine, writer lease, delivery state machine, or SQLite access layer.

### Non-negotiable invariants

1. Discord user ID is the durable external identity anchor.
2. Names and aliases are presentation evidence, never identity keys.
3. Two users are never merged by name.
4. Authorization runs before repository access.
5. Discord locations are isolated by default.
6. Cross-location continuity requires an explicit validated binding.
7. DM, guild, channel, thread, room, character, and person scopes must not leak.
8. One guarded write-capable authority is allowed.
9. Generated output is not the same as delivered output.
10. Only delivered text and played voice may become completed conversational context.
11. Retrieved memory is untrusted data, not an instruction source.
12. Database failure must not silently create a second context authority.
13. Correction and deletion must cover primary and derived data.
14. Off mode must preserve existing bot behavior.
15. Vector retrieval, graph storage, relationship hypotheses, and remote memory transport remain out of scope.
16. No new privileged Discord intent is enabled without a separate technical justification.

### Local deployment decision

The repository owner authorizes private local implementation and activation.

Missing formal approval or reviewer sign-off does not block this local deployment, but it must be recorded as **owner risk accepted**, not as a passed technical or governance gate. Technical safety requirements remain binding.

### Stop only for material risk

Continue through the active work item without requesting approval after every sub-step.

Stop only when continuing could cause data loss, identity merging, cross-scope disclosure, an unrecoverable migration, or destructive conflict with existing user changes.

---

## 3. Keep the execution surface small

Maintain these documents:

```text
docs/memory/EXECUTION_CONTRACT.md
docs/memory/CURRENT.md
docs/memory/work/
docs/memory/runbooks/
docs/memory/tests/
```

### `CURRENT.md`

Keep it concise:

- Confirmed completed capabilities.
- Active work item.
- Next work item.
- Current schema and rollout state.
- Known local constraints.
- Open risks.
- Last commands actually run and their results.

### Work-item files

Only one work item should normally be active.

Each file under `docs/memory/work/` contains:

1. Outcome.
2. Existing code to reuse.
3. Files likely to change.
4. Out-of-scope work.
5. Acceptance tests.
6. Completion record.

The coding agent should normally read only:

- The execution contract.
- `CURRENT.md`.
- The active work item.
- Directly linked references.

Do not require a full reread of all historical artifacts before every increment.

---

## 4. Baseline rule

Public `main` indicates that substantial memory-domain and SQLite foundations already exist. The local checkout may be ahead of it.

Before implementation, reconcile the actual checkout and remove already-completed work from later work items. Never recreate an existing capability merely because this plan names it.

---

## 5. Configuration and rollout states

`MEMORY_MODE` is an operator-facing profile over the existing canonical feature flags.

```text
MEMORY_MODE
  -> MemoryFeatureFlags
  -> validateMemoryFlags()
  -> memoryPosture()
  -> runtime construction
```

No module outside centralized configuration may read memory environment variables directly.

### Modes

| Mode | Behavior |
|---|---|
| `off` | No database or spool opens; no runtime directories are created; existing behavior is unchanged. Default. |
| `shadow` | Persist durable traces, but legacy context remains the model prompt source. |
| `active` | Authorized durable memory becomes the prompt-context authority. No silent fallback to unrelated ephemeral history. |
| `degraded` | Durable reads are off; new writes are durably spooled and reported as spooled, not committed. Database open is not required. |

Rules:

- Invalid or misspelled modes fail startup.
- A low-level flag that contradicts the selected profile fails startup.
- Internally, only canonical flags and derived posture are used.
- Vector, graph, relationship, and remote-transport features remain false.
- Startup logs one redacted structured memory-status record.

---

## 6. Local runtime layout

Default development layout:

```text
<repo>/
  .local/
    memory/
      authority/
      backups/
      spool/
      reports/
      exports/
      logs/
      room-bindings.json
```

Add:

```gitignore
/.local/
```

Do not globally ignore `*.sqlite`, `*.lock`, or `*.lease`.

Requirements:

- Resolve paths once through one tested resolver.
- Display resolved authority and backup paths at startup.
- Permit an explicit absolute runtime path outside the repository.
- Reject ambiguous or unsafe paths.
- Record that repository deletion or destructive Git cleanup can destroy repo-local memory.
- Record that same-disk backups do not protect against full-disk loss.
- Treat database, spool, reports, and exports as sensitive plaintext unless encryption is separately implemented.

---

## 7. Runtime boundary

Only one approved Discord-bot composition root may import `@proj-airi/memory-sqlite`.

Handlers, commands, prompt code, orchestration code, and voice code depend on:

- `MemoryPort`.
- Discord-specific application adapters.
- A small runtime-health interface.
- Explicit operational services where needed.

No handler or voice controller may import a SQLite repository directly.

### Construction paths

**Off**

- Return an inert runtime.
- Do not create paths or open storage.

**Shadow and active**

1. Resolve and validate configuration.
2. Create required directories.
3. Acquire the existing guarded writer ownership.
4. Refuse a second writer.
5. Open the authority through the existing guarded API.
6. Create a verified pre-migration backup when required.
7. Run forward migrations.
8. Construct existing repositories and application services.
9. Construct or complete the concrete `MemoryPort`.
10. Run lightweight schema and integrity checks.

**Degraded**

1. Validate spool configuration.
2. Open the durable spool without requiring the database.
3. Disable prompt reads.
4. Report degraded health.
5. Replay only through an explicit guarded idempotent recovery operation.

Before degraded mode is enabled, define and test the spool’s versioning, idempotency keys, atomic write protocol, ordering, flush behavior, corrupt-record handling, replay ownership, partial replay recovery, and deletion behavior.

### Shutdown

Shutdown should stop new work, wait a bounded time for in-flight operations, flush spool writes, perform enabled backup work, close storage, release ownership, and then continue normal bot shutdown.

Do not call `process.exit` before cleanup completes or reaches a logged timeout.

---

# 8. Implementation increments

Execute in order unless `CURRENT.md` proves an increment is already complete.

## Increment 0 — Reconcile the local checkout

### Outcome

Establish the exact baseline without changing runtime behavior.

### Actions

Run and record:

```powershell
git status --short
git diff --stat
git diff --check
git rev-parse HEAD
Get-ChildItem -Path . -Filter AGENTS.md -Recurse
```

Inspect:

```text
airi/services/discord-bot/src/memory/
airi/services/discord-bot/src/config.ts
airi/services/discord-bot/src/index.ts
airi/services/discord-bot/src/services.ts
airi/services/discord-bot/src/orchestration/
airi/services/discord-bot/src/voice/
airi/packages/memory-domain/src/
airi/packages/memory-sqlite/src/
docs/memory/
```

Inventory:

- Existing `MemoryPort` operations and implementations.
- Actor evidence, room models, authorization, and delivery contracts.
- SQLite openers, repositories, migrations, backup, and writer ownership.
- Legacy conversation-history reads and writes.
- Direct SQLite or repository imports in Discord runtime code.
- Current flags, tests, and benchmarks.

Run current relevant tests before editing.

### Deliverables

Create or update:

```text
docs/memory/CURRENT.md
docs/memory/local-owner-runtime-scope.md
```

The owner-scope document records the local deployment decision, selected paths, one-writer assumption, backup limitation, prohibited features, Discord-intent decision status, and binding safety invariants.

### Acceptance

- Existing work is preserved.
- Baseline results are recorded honestly.
- Already-completed tasks are removed from later work items.
- Increment 1 exists as one narrow active work-item file.

---

## Increment 1 — Runtime profile and composition root

### Outcome

The bot starts and stops safely in `off` and `shadow`.

### Implement

- Centralized `MEMORY_MODE` profile expansion.
- Conflict detection with existing low-level flags.
- One tested path resolver.
- One composition root.
- Inert off runtime.
- Guarded shadow runtime.
- Structured redacted health/status.
- Graceful memory shutdown.
- Boundary tests that prevent direct SQLite access outside approved modules.

### Out of scope

Ingress persistence, prompt reads, room bindings, commands, FTS, summaries, extraction, and degraded replay.

### Acceptance

- No memory variables produces `off`.
- Invalid or conflicting configuration fails startup.
- `off` creates no database or runtime directory.
- `shadow` opens the configured authority.
- A second writer is refused.
- Paths resolve predictably.
- Status logs contain no secret.
- Existing off-mode text and voice tests remain green.

---

## Increment 2 — Identity, rooms, and authorization

### Outcome

All supported ingress paths resolve stable actors and isolated rooms through one deny-by-default authorization boundary.

Use existing canonical backlog IDs, including IMP-301 through IMP-305 where applicable.

### Implement

**Actor integration**

- Use existing frozen Discord actor evidence.
- Preserve Discord user ID even when member data is missing.
- Preserve event-local presentation snapshots.
- Observe aliases without merging people.
- Throttle unchanged projection writes.

**Ingress coverage**

- Text messages handled by the bot.
- Mention-based interactions.
- Slash commands.
- Voice evidence frozen at speaking start and propagated with the finalized utterance.

**Rooms**

Represent underlying locations:

- DM conversation.
- Guild text channel.
- Guild thread.
- Guild voice channel.
- Character scope.

A slash command resolves to its underlying DM, channel, or thread; it is not a separate room merely because it is a slash command.

Default policy:

- No guild-wide implicit sharing.
- No cross-channel sharing.
- No DM-to-guild sharing.
- No cross-guild sharing.
- No character mixing.

**Bindings**

Use a versioned local binding file for deliberate text/voice continuity.

Reject invalid snowflakes, duplicate or overlapping bindings, cross-guild bindings, DM/guild mixing, character mismatch, and unknown schema versions.

**Authorization**

All memory operations pass through one authorization facade before repository access.

Inputs include requester, logical scope, physical location, character, operation, and memory layer.

**Discord intent decision**

Default to no new privileged intent. Accept event-local or throttled alias freshness when complete member-cache data is unavailable, and document the limitation.

### Acceptance

- Same Discord ID in text and voice resolves to one person.
- Same-name users remain separate.
- Rename history is preserved.
- Missing member cache does not lose identity.
- DM and guild data do not mix.
- Guilds do not mix.
- Unbound locations remain isolated.
- Explicitly bound text and voice share one room.
- Invalid bindings fail closed.
- Authorization occurs before repository access.

---

## Increment 3 — Events, causality, and delivery

### Outcome

Shadow mode contains a faithful durable trace while prompts remain unchanged.

### Implement

**Inbound events**

Persist one event for each admitted Discord message, slash command, and finalized voice utterance.

Use stable idempotency keys:

- Message ID.
- Interaction ID.
- Voice session/capture ID plus participant and utterance sequence.

Never use display text as an idempotency key.

**Application layer**

Implement or complete the concrete service behind `MemoryPort`.

Define and test transaction boundaries, idempotency, authorization-before-query, failure mapping, commit-versus-spool results, delivery transitions, and deletion hooks. Do not hide this work inside the composition root.

**Generation and causality**

Create a generation attempt and link every contributing user event. Preserve multi-speaker contributions as multiple causal edges.

**Delivery**

For text, record generated, send attempt, delivered, failed, or unknown-after-interruption.

For voice, observe the existing segment lifecycle without redefining cancellation, response epochs, ordering, or playback semantics.

Only delivered text and played voice are context-eligible.

**Reconciliation**

Reconcile unknown outcomes only where evidence permits. Never guess delivery.

### Acceptance

- Duplicate callbacks are idempotent.
- Multi-speaker causality is preserved.
- Text success, failure, and unknown states are accurate.
- Cancelled, failed, and unplayed voice is excluded.
- Partial playback is represented accurately.
- Restart reconciliation never guesses.
- Shadow failures are observable and never reported as durable success.

---

## Increment 4 — Shared text/voice adapters and shadow soak

### Outcome

Text and voice use the same authorized `MemoryPort`; legacy prompt behavior remains unchanged.

### Implement

- Text adapter: actor, room, authorization, inbound event, generation, causality, delivery.
- Voice adapter: frozen actor evidence, one event per speaker, group causality, segment delivery.
- No repository access from handlers or voice controllers.
- Keep summaries, extraction, backups, reconciliation, and broad retrieval off the voice-critical path.
- Measure actor/room resolution, append, serialization, delivery writes, and voice pre-generation overhead.

### Acceptance

- Text-only and voice-only traces are correct.
- Same user is stable across modalities.
- Same-name users remain separate.
- Bound text-to-voice and voice-to-text continuity works.
- Unbound and DM scopes remain isolated.
- Restart continuity works.
- Shadow database failure does not create false durability.
- Existing voice latency, cancellation, epochs, and playback order do not regress.

Complete a local shadow soak before proceeding.

---

## Increment 5 — Privacy core

### Outcome

Authorized users can remember, correct, forget, inspect, and export memory before derived retrieval is added.

### Implement

Provide slash-command or equivalent application operations for:

- Remember.
- Correct.
- Forget.
- Show memory.
- Export memory.
- Memory status.

Rules:

- Default to requester and current room.
- Require explicit authorization for broader scope.
- Never guess ambiguous aliases.
- Record provenance.
- Corrections supersede stale facts.
- A spooled write is never reported as committed.

Implement one deletion pathway covering:

- Primary records.
- Current projections.
- Existing derived records.
- Cached context.
- Unreplayed spool entries.
- Future exports.
- Minimal required tombstone or audit evidence.

Restore must use a candidate database, validate it, replay deletion obligations, verify absence, and promote only while the live writer is stopped.

### Acceptance

- Remember and correct preserve provenance.
- Forget removes authorized primary and existing derived data.
- Forget handles unreplayed spool entries.
- Export contains no unrelated user or room data.
- Restore of an old backup reapplies later deletion obligations.
- Private alias evidence never crosses scope.

---

## Increment 6 — Active recent context

### Outcome

Active mode uses authorized durable recent delivered context as the prompt-context authority.

This is the milestone-one active-memory target.

### Context selection

Initial order:

1. Current contributing user events.
2. Authorized recent delivered conversation.
3. Explicit currently valid facts, when enabled.

FTS, vectors, summaries, and automatic extraction are not required.

Each selected item carries diagnostic source, scope, provenance, delivery eligibility, selection reason, ordering evidence, and truncation status. Raw private content is not logged by default.

### Prompt serialization

Use one serializer that:

- Treats memory as untrusted data.
- Keeps it outside system/control instruction fields.
- Escapes delimiters and fake role markers.
- Neutralizes mass mentions.
- Handles bidi and zero-width controls.
- Prevents structure breakout.
- Uses prompt-local opaque person references.
- Never exposes internal database, room, person, event, or generation IDs.
- Enforces a strict size budget.
- Preserves the existing persona/system prefix.

### Deadline and failure behavior

On deadline, return explicit bounded no-durable-context behavior. Do not query broader scopes or block voice indefinitely.

On required durable-access failure, fail startup, fail the turn, or explicitly degrade. Never silently resume unrelated legacy context while claiming active memory.

### Acceptance

- Authorized delivered context appears after restart.
- Failed text and unplayed voice do not appear.
- DM, guild, room, and character isolation hold.
- Bound text and voice share recent context.
- Hostile remembered content remains data.
- Delimiter, role-marker, mention, bidi, and zero-width attacks are contained.
- Internal IDs do not leak.
- Deadline behavior is bounded.
- Returning to `off` restores existing behavior without deleting the database.

---

## Increment 7 — Optional capabilities

Each is a separate work item and activation flag. None is required for milestone one.

### Lexical retrieval

Add only after deletion is proven. Require authorization-scoped indexing, deterministic ranking, deletion propagation, recorded tokenizer configuration, and separate English/Japanese/Chinese/mixed-script measurements. Keep disabled until behavior is documented.

### Summaries

Keep asynchronous and off the voice-critical path. Record source coverage and model/prompt/version metadata. Include only delivery-eligible sources. Mark stale after correction or deletion. Register summaries with the deletion pathway.

### Automatic extraction

Keep disabled by default. Require provenance, abstention under uncertainty, contradiction handling, asynchronous execution, and deletion/correction invalidation. Assistant statements must not automatically become user facts.

---

## 9. Operational tools

Add tools only when their required runtime capability exists:

```text
memory:status
memory:inspect
memory:backup
memory:restore
memory:integrity
memory:smoke
memory:spool:replay
memory:deletion:verify
memory:export
```

Rules:

- Write tools use the same writer guard.
- Read-only tools use the read-only opener.
- Restore refuses to run while the bot owns the authority.
- Raw content requires an explicit option.
- Tools never print secrets.
- Use the supported SQLite backup API, not a raw copy of the live file.
- Do not copy writer-lease sidecars.
- Keep existing benchmark path-safety behavior unchanged.
- Add a separate repo-local smoke command rather than weakening the benchmark harness.

---

## 10. Validation

Run focused checks after each increment and the full relevant matrix before activation.

At minimum, run affected package typechecks and tests, targeted lint, and:

```powershell
git diff --check
```

Run existing persistence benchmarks after persistence changes.

Required milestone-one scenarios:

1. Off mode creates no storage and preserves prompt behavior.
2. Shadow text and voice persist faithful traces.
3. Restart preserves identity and events.
4. Same Discord ID is stable across modalities.
5. Same-name users remain separate.
6. Renames preserve historical snapshots.
7. Unbound scopes remain isolated.
8. Explicit bindings permit intended continuity.
9. DM and guild data never mix.
10. Guilds never mix.
11. Failed text and unplayed voice are excluded.
12. Active authorized recall works after restart.
13. A second writer is refused.
14. Shadow outage never produces false durable success.
15. Active outage fails closed or explicitly degrades.
16. Spool replay is durable and idempotent before degraded activation.
17. Backup restore validates and reapplies deletion obligations.
18. Prompt-injection content remains untrusted.
19. Existing voice performance, cancellation, epochs, and ordering remain green.

---

## 11. Activation and rollback

### Activation

1. **Off:** confirm parity and no runtime artifacts.
2. **Shadow core:** persist traces with prompt use disabled.
3. **Shadow privacy:** validate remember, correct, forget, export, backup, restore, and restart.
4. **Active recent context:** enable only recent delivered context and optional explicit facts.
5. **Optional layers:** enable FTS, summaries, and extraction independently after their own gates pass.

### Rollback

From shadow, switch to `off`.

From active, switch to:

- `off`, disabling durable reads and writes; or
- `degraded`, disabling reads and spooling writes.

Do not roll active into a split state where durable writes continue while unrelated legacy context becomes the prompt authority.

For database rollback:

- Create a verified backup before schema changes.
- Record schema version and migration checksums.
- Do not reverse migrations destructively.
- Restore to a candidate.
- Validate and reapply deletion obligations.
- Promote only while the writer is stopped.

---

## 12. Completion reporting

After each increment, record only:

1. Starting commit and working-tree state.
2. Existing user changes preserved.
3. Files changed.
4. Schema/configuration/runtime changes.
5. Tests and commands actually run.
6. Exact pass, fail, or skipped results.
7. Relevant identity, scope, delivery, privacy, and voice-latency risks.
8. Activation or rollback instructions introduced.
9. Next active work item.

Do not repeat the entire architecture review after every increment.

---

## 13. Milestone-one completion criteria

Milestone one is complete when:

- Off mode remains behaviorally compatible.
- Runtime paths are explicit and safely ignored.
- Only the approved composition boundary imports SQLite.
- One guarded writer is enforced.
- Text, slash, and voice use one stable Discord identity model.
- Names never merge identities.
- Event-local presentation evidence is preserved.
- Rooms are isolated by default.
- Explicit text/voice bindings work.
- Authorization precedes repository access.
- Every admitted input has a durable event identity.
- Multi-speaker causality is preserved.
- Text and voice delivery states are accurate.
- Undelivered output is excluded.
- Restart continuity works.
- Remember, correct, forget, inspect, status, and export work.
- Backup restore validates and reapplies deletion obligations.
- Active prompts use authorized recent delivered context.
- Retrieved memory is bounded untrusted data.
- Shadow, active, degraded, and off failure behavior is explicit.
- A second writer is refused.
- Existing voice behavior remains green.
- FTS, summaries, extraction, vectors, graph storage, relationships, and remote transport are not required for initial activation.

---

## 14. First active work item

Unless the local checkout proves otherwise, begin with:

```text
Increment 0 — Reconcile the local checkout
```

Do not recreate the domain or SQLite foundations. Confirm what already exists, update `CURRENT.md`, and create one narrow Increment 1 work-item file.
