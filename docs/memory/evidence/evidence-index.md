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
