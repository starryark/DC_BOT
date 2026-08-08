# Shared-Memory Evidence Index (frozen baseline)

**Task:** IMP-001 · **Rollout stage:** R0 (documentation only) · **Frozen:** 2026-08-02

This file is the single place where the shared-memory program records *what was
actually observed* in source, separately from what an artifact asserts. Nothing
downstream may promote a claim to "confirmed" without a row here.

## 1. Frozen revisions

| Repository | Branch | Commit | Access this session |
|---|---|---|---|
| DC_BOT (primary, **writable local checkout**) | `main` | `0ea3cbf5ec92f719e2b48066c3ada45aa50122ad` — "added reference audio profile", 2026-08-01 | Local working tree read directly |
| AIRI (comparison) | `main` | `4d6e61f77dc99ec76c7cf352df62abb4282386c5` (per artifacts 21/26) | **Not re-verified this session** |
| AstrBot (comparison) | `master` | `49095d3ba3fca9272a67aa5eeab2f6c0719c5091` (per artifacts 21/26) | **Not re-verified this session** |

The local checkout HEAD equals the artifact baseline commit, so every artifact
"Confirmed repository fact" is testable against the files on disk. Where the
artifact and the working tree disagree, the working tree wins and the
divergence is recorded in §3.

Local paths below are relative to the DC_BOT repository root.

## IMP-202 completion evidence (2026-08-02)

- Repository conformance: `airi/packages/memory-sqlite/src/repositories/identity.test.ts`
  and `alias.test.ts` use real migrated in-memory SQLite databases and cover
  snowflake continuity, same-name separation, rename history, partial/null
  completeness, observation idempotency, exact scope/privacy predicates,
  inactive validity filtering, ambiguity preservation, foreign keys, and
  transactional rollback.
- Write-count benchmark: 10,000 equal-presentation observations produced
  exactly 10,000 snapshots, 1 platform current row (revision 1), 1 guild current
  row, 3 aliases, 3 normalized evidence rows, person alias revision 1, and no
  post-initial `last_seen_at` write inside the 24-hour window.
- Migration evidence: additive version 2 checksum
  `259421eed89d09f73a66083737b009b7ec21602257591e93e69a4a7326c054d7`;
  version 1 checksum remains unchanged.
- Runtime evidence: package boundary tests remain green; no production database
  composition, Discord imports, gateway intents, WAL/busy-timeout policy, or
  feature-flag changes were added.

## 2. Confirmed repository facts (verified against the local checkout)

| ID | Claim | File · line | Verified |
|---|---|---|---|
| LEV-001 | The Discord service lives at `airi/services/discord-bot`, with `src/orchestration/**` and `src/voice/**` subtrees. | `airi/services/discord-bot/src/` | ✅ |
| LEV-002 | The normalized inbound event contract carries `userId` + a single `displayName`; there is no actor snapshot separating event-time presentation from current addressing. | `airi/services/discord-bot/src/orchestration/events.ts:20-32` | ✅ |
| LEV-003 | `buildGroupTurn` preserves one `GroupMessage` per speaker and keeps every source `TranscribedUtterance`; PCM is never concatenated. | `airi/services/discord-bot/src/orchestration/group-turn-builder.ts:44-89` | ✅ |
| LEV-004 | `onConversationGroup` collapses the group turn into the **first** utterance's event and the synthetic display name `'Discord group'`. | `airi/services/discord-bot/src/orchestration/conversation-controller.ts:268-278` | ✅ |
| LEV-005 | Voice history is process-local and guild-scoped: `GuildSession` holds a bounded `ConversationTurn[]` with no durable actor ID on the turn (`speaker` is a display string). | `airi/services/discord-bot/src/orchestration/guild-session.ts:29-123` | ✅ |
| LEV-006 | `GuildSession.commitExchange` writes exactly one user turn + one assistant turn — a fixed one-user-event exchange model. | `airi/services/discord-bot/src/orchestration/guild-session.ts:48-70` | ✅ |
| LEV-007 | `GuildSession.asRoom` projects the whole guild onto `voiceRoom(guildId, guildId)`, i.e. the room id does **not** carry the real voice-channel id. | `airi/services/discord-bot/src/orchestration/guild-session.ts:78-87` | ✅ |
| LEV-008 | Text history is a second, unrelated authority: `MentionResponder` owns a private `InMemoryRoomStore`. | `airi/services/discord-bot/src/orchestration/mention-responder.ts:61` | ✅ |
| LEV-009 | `MentionResponder` appends both the user and the assistant turn to its room store **before returning the text to the caller that performs the Discord send**. | `airi/services/discord-bot/src/orchestration/mention-responder.ts:161-176` | ✅ |
| LEV-010 | Room ids are deterministic `guild:<guildId>:<medium>:<channelId>` strings with no logical-room indirection and no binding records. | `airi/services/discord-bot/src/orchestration/room-id.ts:24-39` | ✅ |
| LEV-011 | `InMemoryRoomStore` is bounded, in-process, and writes nothing to disk; there is no durable store of any kind in the service. | `airi/services/discord-bot/src/orchestration/room.ts:81-143` | ✅ |
| LEV-012 | The checked-in `memory-pgvector` package has no schema, store, or memory operation — it is not a usable backend. | `airi/packages/memory-pgvector/` | ✅ |
| LEV-013 | The repository has a working Vitest harness for the Discord service (`vitest run`, `include: src/**/*.test.ts`). | `airi/services/discord-bot/vitest.config.ts` | ✅ (`vitest run src/config.test.ts` → 4 passed) |
| LEV-014 | All runtime configuration is funnelled through `config()`; nothing else in `src/` reads `process.env` for runtime config. | `airi/services/discord-bot/src/config.ts:1-14` | ✅ |

## 3. Contradiction log

| ID | Contradiction | Resolution |
|---|---|---|
| CON-001 | Artifact 26 cites the orchestration files under `airi/services/discord-bot/src/core/…`; artifact 21 cites `…/src/orchestration/…`. The working tree has `src/orchestration/`. | `src/orchestration/` is authoritative. Artifact 26's paths are stale; its **findings** still hold because the same symbols exist (`conversation-controller.ts`, `group-turn-builder.ts`, `guild-session.ts`, `mention-responder.ts`). |
| CON-002 | Artifact 26 places `prompt-compiler.ts` under `src/core/`; the working tree has `src/character/prompt-compiler.ts`. | Working tree wins. |
| CON-003 | Artifact 26 places the Discord adapter at `src/adapters/discord/airi-adapter.ts`; the working tree has `src/adapters/airi-adapter.ts`. | Working tree wins. |
| CON-004 | Artifact 09 §5 E-04 states "DC_BOT has no memory layer" and E-05 states the Discord service has "no memory module"; artifacts 21/26 state text and voice own *separate process-local histories*. | Both are true at different granularity: there is no **durable** memory layer (E-04/E-05 correct), and there are two **ephemeral** in-process histories (LEV-005, LEV-008). The program targets the durable gap without inventing a third ephemeral store. |
| CON-005 | Artifact 09 §17 OQ-B2 could not locate `ConversationController.generateAndSpeak()`. | **Resolved.** It exists at `airi/services/discord-bot/src/orchestration/conversation-controller.ts`. OQ-B2 is closed. |
| CON-006 | Artifact 09 E-03 asserts DC_BOT requests only Guilds + Guild Voice States intents. Not verified in this increment; the adapter file was not opened for intent flags. | Open. Tracked as `OQ-BLOCK-004` / `OQ-B1` in `../implementation-status.md`. No code in this increment depends on the answer. |

## 4. Evidence classification rules

Every downstream claim MUST carry one of:

- **Confirmed repository fact** — a row in §2 with a file·line reference in this checkout at the frozen SHA.
- **Baseline-supplied claim (unverified)** — asserted by an approved artifact, not re-verified here.
- **External research finding** — sourced outside the repositories.
- **Inference** — derived; must name the facts it derives from.
- **Recommendation** — a proposal; must be backed by an ADR or an `IMP-*` task.

A claim with no classification is not usable as a gate input.

## 5. Implementation evidence after the frozen baseline

These rows record directly inspected implementation facts without changing the
frozen repository-fact baseline in §1.

| ID | Increment | Observed implementation fact | Evidence |
|---|---|---|---|
| IEV-201-001 | IMP-201 | SQLite schema version 1 is represented by one checksummed forward migration; the runner rejects duplicate, altered, unknown, and future migration states and rolls back failed migrations. | `airi/packages/memory-sqlite/src/{migration-runner,migrations/index}.ts`; SQLite-backed `migration-runner.test.ts` |
| IEV-201-002 | IMP-201 | Schema v1 keeps Discord ID identity distinct from historical snapshots and aliases, represents scoped rooms, explicit causality, generation/delivery separation including `unknown_after_crash`, provenance/supersession, and deletion tombstones. | `airi/packages/memory-sqlite/src/schema/v1.ts`; SQLite-backed `schema/v1.test.ts` |
| IEV-201-003 | IMP-201 | The persistence package has no Discord, provider, transport, or service-runtime imports and is not composed into the running bot. | `airi/packages/memory-sqlite/src/boundaries.test.ts`; no running-path changes in IMP-201 |
| IEV-203-001 | IMP-203 | Exact physical locators, character-singleton fallback, temporal bindings, lifecycle invalidation, and privacy-domain denial execute against migrated SQLite. | `airi/packages/memory-sqlite/src/repositories/rooms.test.ts` |
| IEV-203-002 | IMP-203 | Binding history is append-only; stale updates and forced failures roll back, while authorization revisions change on update, removal, and deleted-room invalidation. | `airi/packages/memory-sqlite/src/repositories/{bindings,rooms}.ts`; real-SQLite scope matrix |
| IEV-203-003 | IMP-203 | Additive migration 3 preserves v2 identity/alias rows and has checksum `c4bac88f79afa93560b3f8a9ca165d075dd5b3aa03350538a006d4dad7ef3ca4`. No runtime composition changed. | `airi/packages/memory-sqlite/src/schema/v3.ts`; `migration-runner.test.ts` |
| IEV-204-001 | IMP-204 | Attributed text/voice envelopes, exact snowflakes, SQL-scoped deterministic reads, explicit retry conflicts, lifecycle history, terminal state, redaction, and append/redaction rollback execute against real SQLite. | `airi/packages/memory-sqlite/src/repositories/events.test.ts` |
| IEV-204-002 | IMP-204 | Many-to-many generation/event/role edges retain distinct roles, require triggers, deduplicate retries, traverse both directions, survive payload redaction, and roll back partial sets. | `airi/packages/memory-sqlite/src/repositories/{causal-edges,events}.ts`; `events.test.ts` |
| IEV-204-003 | IMP-204 | Additive migration 4 clean-installs, upgrades v3 without rewriting migrations 1–3, preserves prior repository data, keeps foreign keys enabled, and has checksum `cbe385b24720f051a3389fbeb2b1663564ff9beb43c68fe86b41c4ba875512f7`. | `airi/packages/memory-sqlite/src/schema/v4.ts`; `migration-runner.test.ts` |
| IEV-205-001 | IMP-205 | Canonical generation attempts retain exact snapshot evidence and append-only validated lifecycle history; ordinary concurrent room advancement does not act as a generation CAS. | `airi/packages/memory-sqlite/src/repositories/generations.ts`; real-SQLite `generation-delivery.test.ts` |
| IEV-205-002 | IMP-205 | Immutable ordered output sets and physical delivery attempts retain retry identity, receipt/playback/crash evidence, append-only transitions, unresolved-state queries, and domain-policy context admission. | `airi/packages/memory-sqlite/src/repositories/{outputs,deliveries}.ts`; real-SQLite `generation-delivery.test.ts` |
| IEV-205-003 | IMP-205 | Migration 5 preserves legacy generation rows and v4 causal edges through a shared identifier registry; checksum is `83d7b755d62a8a09b109598503dce8c1594ca3f11b9713fe73341db74982c4a0`. Migrations 1–4 remain unchanged. | `airi/packages/memory-sqlite/src/schema/v5.ts`; `migration-runner.test.ts` |
| IEV-206-001 | IMP-206 | Separate summary, semantic, episodic, and procedural repositories reconstruct full temporal and provenance state; procedure writes are operator-only and durable asserted facts reject assistant speculation. | `airi/packages/memory-sqlite/src/repositories/{summaries,memories,provenance}.ts`; `layered-memory.test.ts` |
| IEV-206-002 | IMP-206 | Half-open as-of reads and atomic corrections preserve old validity, append replacements and edges, deduplicate exact retries, reject stale/conflicting writes, and reconstruct deterministic multi-step chains. | `airi/packages/memory-sqlite/src/repositories/corrections.ts`; `layered-memory.test.ts` |
| IEV-206-003 | IMP-206 | Migration 6 preserves migrations 1–5, legacy memory, and IMP-205 generation rows; checksum is `339ad95d51c276186ac42487ea8e863c0b0721199c89a0b7661a4f4c10df2b80`. | `airi/packages/memory-sqlite/src/schema/v6.ts`; `migration-runner.test.ts` |
| IEV-207-001 | IMP-207 | Database-only composition atomically commits a source row, stable idempotency result, durable job, and reconciliation evidence; injected failures leave direct row counts at zero. | `airi/packages/memory-sqlite/src/{unit-of-work,idempotency,reconciliation-queue}.ts`; `reconciliation-queue.test.ts` |
| IEV-207-002 | IMP-207 | Atomic deterministic claims use finite unique lease tokens; expired leases are reclaimable and stale success/retry/dead-letter transitions fail even for a reused worker name. | `airi/packages/memory-sqlite/src/reconciliation-queue.ts`; real-SQLite lease tests |
| IEV-207-003 | IMP-207 | Migration 7 preserves v6 data/history, adds append-only policy/actor reconciliation evidence, and has checksum `2c6d9647b4d404f7eab1363ea8a97c0df536cf3837dd9accaa1933ce929f880d`. | `airi/packages/memory-sqlite/src/schema/v7.ts`; `migration-runner.test.ts` |
| IEV-208-001 | IMP-208 | File-backed WAL tests cover room writers, reader snapshots, bounded lock exhaustion, and token-fenced queue contention. | `airi/packages/memory-sqlite/src/imp208.integration.test.ts`; `docs/memory/evidence/imp-208-validation-report.md` |
| IEV-208-002 | IMP-208 | Six OS-process-kill schedules reopen with atomic visibility, valid integrity/FKs/history, and checkpoint recovery. | `airi/packages/memory-sqlite/src/fixtures/crash-child.mjs`; `imp208.integration.test.ts` |
| IEV-208-003 | IMP-208 | Online backup, isolated restore, SQLite tombstone replay, v0–v7 compatibility, and a reproducible benchmark pass without runtime activation. | `airi/packages/memory-sqlite/src/{backup,connection-profile}.ts`; `docs/memory/{sqlite-backup-restore.md,evidence/imp-208-validation-report.md}` |
| IEV-A8-001 | A8 | The private active-soak evidence tool exists as three fail-closed stages (`prepare`, `report`, `verify`) whose guards are exercised against a throwaway checkout: dirty worktree, non-HEAD commit, in-repository output directory, in-repository runtime root, missing authority, unparsable and multi-guild binding specifications, reused run identity, verified-backup creation, report authority mismatch, and nonzero verify exit status. | `airi/services/discord-bot/scripts/memory/{active-soak,active-soak-stages}.ts`; `airi/services/discord-bot/src/memory/active-soak-cli.test.ts` |
| IEV-A8-002 | A8 | The report is content-free by construction and bound to one candidate: run-scoped HMAC identifiers, no text-bearing column read, exactly one non-overlapping window per scenario, deletion evidence scoped to the deletion window, and the commit, schema version, binding digest, and pre-soak backup digest carried in the report. | `airi/services/discord-bot/src/memory/{active-soak,active-soak.test}.ts`; `airi/docs/memory/runbooks/active-memory-soak-and-rollout.md` |
| IEV-A8-003 | A8 | ~~No live soak has been executed.~~ **Superseded 2026-08-05 by IEV-A8-004.** | `docs/memory/CURRENT.md` |
| IEV-A8-004 | A8 | **The live private-guild soak was executed and passed**, qualifying commit `86ca5cfc674997820fe4d1f235d1d16f30ce1470` as run `t002-86ca5cfc-20260805b`: twelve of twelve scenarios observed pass, all seven machine assertions pass, `report` and `verify` both exit zero at that commit, with 13 generations (0 failed), 25 deliveries (0 unresolved), 0 semantic writes, 1 forget request and 34 verified tombstones. **Operator-qualified, not reviewed** — the independent-review gate was removed in `7a3fd5e`, so no reviewer decision exists or is required. Qualifies one commit *and* `BOT_INPUT_POLICY=half_duplex`; does not cover `barge_in`, and neither confirms nor refutes DM isolation. | `docs/memory/evidence/{a8-active-soak-qualification-2026-08-05.md,t002-86ca5cfc-20260805b.report.json}` |
| IEV-A8-005 | A8 | Two defects were found by live execution that no committed test had caught. **DEFECT-004**: the durable output repository takes a whole-set declaration, not an append log, so a voice reply past its first chunk was refused as a mismatched retry — recording `failed` for replies the operator heard correctly, and truncating audio because the escaping error discarded already-synthesized chunks. **DEFECT-005**: a transient upstream 503 killed the bot process, because the failure-recording path re-raised the error it was handed — rejecting the catch block that was handling it — and the gateway client had no `error` listener. Both are fixed and covered by regression tests. | `airi/services/discord-bot/src/memory/{voice-memory-adapter,text-memory-adapter}.ts`; `airi/services/discord-bot/src/providers/brain/{gemini,errors}.ts`; commits `519583a`, `86ca5cfc` |
| IEV-803-001 | IMP-803 | ~~Deterministic performance baseline `performance-v1` recorded at commit `a215840bfc366d4ae68f8dc4c09fb86c34dded19` for contract digest `c403dd7781fdd28c214c65010d1f36fcbb4a68c9aa849d6b7dfb2b8624e959c6`. Run ID `bench-2026-08-07T1903-a215840b`, seed `20260802`, on `win32 x64` with Node `v24.14.0`. Disposition is `correctness_clean_measured_not_evaluated`. Online/offline comparison parity was successfully verified. Artifacts generated securely outside checkout.~~ **Superseded 2026-08-08 by IEV-803-002.** | Artifact SHA-256 hashes: run-manifest.json (`fa1ba9605c731b80d7a2423c2cb7df9efba9f3035271eb4c99fee7ea6df0e2c9`), measurements.jsonl (`ae14c23bc527296efce159f2bc09b3c838cfec0d68771952c6060c4769211501`), summary.json (`d87c46ad1b767859884405d6fceec23cecd59cbcc93923cb7831d302e7b0fbad`), report.md (`2e1cf969c8d2c6ed46972bf24b41abe205a9437230352756d1a85dc2c5aae1da`). Retained locally outside worktree. |
| IEV-803-002 | IMP-803 | Deterministic performance baseline `performance-v2` recorded at commit `9afc7207f006ac327ff12e31e76633ee9f9c2606` for contract digest `03516345e6e1ab8355373135901cd47eb64ef4a2d275da6ff52204617400a10f`. Run ID `bench-2026-08-08T0726-9afc7207`, seed `20260802`, on `win32 x64` with Node `v24.14.0`. Disposition is `correctness_clean_measured_not_evaluated`. Identical-seed reproducibility confirmed across 3 runs. Artifacts generated securely outside checkout. | Artifact SHA-256 hashes: run-manifest.json (`4ad01411258cb36d53b4a3178082591f361f2e92904332c1e6dc5f86bcdd094f`), attempts.jsonl (`0fbc8c3e5e897b03bda11b0ed44568a15d7e600acaf4cab6555ae9883d0759ba`), run-findings.jsonl (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`), measurements.jsonl (`2516f5c897b5073166c61f3941d4d8aee107425af0922dcce323e5023f4493e5`), summary.json (`3359e239cb25b78022eb944f22d3699cbab0ec8333142462b7dab54b7c927302`), report.md (`eb4866615c0a3ec59cdc494a2759f6529cba7433ffa3eef95e9e571b4a65039b`). Retained locally outside worktree. |
