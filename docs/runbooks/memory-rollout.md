# Runbook — Shared-Memory Rollout and Rollback

**Task:** IMP-002 · **Rollout stage:** R0–R1 · **Owner:** Operations Agent
**Policy source:** `artifacts/19-rollout-feature-flags-rollback.md`
**Implementation:** `airi/services/discord-bot/src/memory/feature-flags.ts`

## 1. Current position

Rollout stage **R1** — the flag envelope and the domain contracts are merged
and the runtime is disabled. Every flag defaults to `false`, so a deployment
that sets nothing behaves exactly as it did at `0ea3cbf`.

R2 and above are **blocked**; see `../memory/implementation-status.md` §2.

## 2. Flags

All flags are read once by `config()` from the process environment
(`.env` / `.config`), named `MEMORY_FF_<FLAG>`:

| Env var | Flag | Stage it belongs to |
|---|---|---|
| `MEMORY_FF_DURABLE_EVENTS` | `durableEvents` | 1 |
| `MEMORY_FF_ACTOR_SNAPSHOTS` | `actorSnapshots` | 2 |
| `MEMORY_FF_PREFERRED_ALIASES` | `preferredAliases` | 2 |
| `MEMORY_FF_ROOM_BINDINGS` | `roomBindings` | 3 |
| `MEMORY_FF_SHARED_RECENT_CONTEXT` | `sharedRecentContext` | 4–6 |
| `MEMORY_FF_DELIVERY_LIFECYCLE` | `deliveryLifecycle` | 4–6 |
| `MEMORY_FF_EXPLICIT_SEMANTIC_MEMORY` | `explicitSemanticMemory` | 7 |
| `MEMORY_FF_SUMMARIES` | `summaries` | 8 |
| `MEMORY_FF_AUTO_EXTRACTION` | `autoExtraction` | 9 |
| `MEMORY_FF_FULLTEXT_RETRIEVAL` | `fulltextRetrieval` | 10 |
| `MEMORY_FF_ON_DEMAND_RECALL` | `onDemandRecall` | 10 |
| `MEMORY_FF_VECTOR_RETRIEVAL` | `vectorRetrieval` | 11 — **gate unmet, refused** |
| `MEMORY_FF_RELATIONSHIP_HYPOTHESES` | `relationshipHypotheses` | 12 — **gate unmet, refused** |
| `MEMORY_FF_REMOTE_TRANSPORT` | `remoteTransport` | 13 — **gate unmet, refused** |
| `MEMORY_FF_DEGRADED_STATELESS_MODE` | `degradedStatelessMode` | any |
| `MEMORY_FF_DURABLE_WRITE_SPOOL` | `durableWriteSpool` | any |

Accepted values are `1`/`true` and `0`/`false`; anything else falls back to the
default (`false`).

## 3. States

```
 ephemeral ──enable durableEvents──▶ durableShadow ──enable sharedRecentContext──▶ durableActive
     ▲                                    │  ▲                                          │
     └────disable durableEvents───────────┘  └──────────── recovery ────────────────────┤
                                                                                        │
                              degradedStateless ◀── enable degradedStatelessMode ────────┘
```

- `ephemeral` — today's behavior. Legacy process-local histories are authoritative.
- `durableShadow` — durable writes happen; the bot still reads legacy history. No prompt use.
- `durableActive` — the durable store is the source of truth. Prompt use enabled.
- `degradedStateless` — memory reads halted, writes spooled. **The bot must not claim to remember anything in this state.**

## 4. Enabling a stage

1. Confirm the gate for that stage in `../memory/implementation-status.md` §8 is green.
2. Set the flag in `.config`.
3. Restart the bot. Startup logs the `MemoryPosture`; if `violations` is
   non-empty the configuration is **refused** and both `durableWritesEnabled`
   and `promptUseEnabled` stay `false`. Fix the flags — do not override.
4. Watch the metrics named for that stage in `artifacts/19-…` §9.2.

## 5. Rolling back

Pick the row that matches what you are turning off.

| You are disabling | Do this |
|---|---|
| A higher tier (`summaries`, `autoExtraction`, `fulltextRetrieval`, `onDemandRecall`, `explicitSemanticMemory`) | Just unset the flag. The retrieval path omits that tier. Lower tiers are unaffected. |
| `sharedRecentContext` while `durableEvents` is on | **Do not** simply unset it — that resumes ephemeral reads under durable writes (split brain). Either (a) set `MEMORY_FF_DEGRADED_STATELESS_MODE=1` **and** `MEMORY_FF_DURABLE_WRITE_SPOOL=1`, or (b) unset `MEMORY_FF_DURABLE_EVENTS` in the same change for a full revert, accepting the loss of writes for the rollback window. |
| `durableEvents` from `durableShadow` | Unset it. Safe — no read tier depends on it yet. |
| Everything, in an incident | Unset every `MEMORY_FF_*`. This is the `ephemeral` state and is always reachable. |

`validateRollback(current, next)` encodes exactly this table; the startup check
refuses an illegal transition rather than applying it.

## 6. Degraded mode

Enter it when the durable authority is unreadable or unwritable but you do not
want to lose events.

1. `MEMORY_FF_DEGRADED_STATELESS_MODE=1` and `MEMORY_FF_DURABLE_WRITE_SPOOL=1`.
2. Restart. `memoryPosture().spoolRequired` is now `true`.
3. The bot answers from the current turn only. It must never emit text claiming
   it remembers something (artifact 09 §10.6).
4. After the store is repaired, drain the spool, then unset
   `MEMORY_FF_DEGRADED_STATELESS_MODE`.

Enabling degraded mode with `durableEvents` on but **without** a spool is
refused: deferred writes would be silently dropped (ADR-016).

## 7. Refusal codes

| Code | Meaning | Fix |
|---|---|---|
| `missingPrerequisite` | A tier was enabled before the tier it reads from. | Enable the named prerequisite, or disable the named flag. |
| `gateNotMet` | The flag's evidence gate (benchmark / topology ADR) has not been met. | Do not enable it. The gate closes at the named `IMP-*` task, not in configuration. |
| `splitBrain` | Durable writes would continue under ephemeral reads. | Use §5 row 2. |
| `unspooledDegradedMode` | Degraded mode with nowhere to defer writes. | Enable `durableWriteSpool`. |
| `illegalTransition` | Not an edge of the state machine. | Route through an intermediate state per §3. |
