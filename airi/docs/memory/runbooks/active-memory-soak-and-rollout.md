# Active memory private soak and rollback

This procedure qualifies one exact commit and configuration for deliberate active opt-in. It does not change the default `off` mode, the ordinary shadow rollout, or any semantic-memory gate.

Active-ready means eligible for deliberate opt-in deployment. It never changes the default rollout state.

## Prerequisites

Use a dedicated credential installed only in a private guild, an absolute isolated memory root, private text/thread/voice locations, working ASR/model/TTS/playback, a human observer, and a reviewer who did not implement the report tooling.

### The memory character id

`binding.characterId` must be the runtime's **memory** character id, which is derived from the configured `CHARACTER_ID` by replacing spaces with hyphens — not the character card's folder or display name. The bundled persona is configured as `CHARACTER_ID=Makise Kurisu`, so its bindings must say `"characterId": "Makise-Kurisu"`. Domain ids reject whitespace, so the folder spelling is refused by the binding schema, and a binding naming any other character is refused as `UNAUTHORIZED_BIND` at reconciliation.

Confirm the id before `prepare`, from `services/discord-bot`, without opening Discord or the authority:

```
pnpm exec tsx --env-file=.env --env-file-if-exists=.config --env-file-if-exists=.env.local \
  -e "import { config } from './src/config.ts'; import { memoryCharacterIdOf } from './src/memory/runtime.ts'; process.stdout.write(memoryCharacterIdOf(config().character.id) + '\n');"
```

Never commit credentials, raw logs, the private binding specification, raw identifier mappings, the pre-soak backup, the run-state file, or the report HMAC key. Only three artifacts are committed: the redacted JSON report, the reviewer's Markdown decision, and any defect/rerun record.

`--out` must therefore be an absolute directory **outside** the repository checkout; `prepare` and `report` both refuse an output location inside it, because a run state, backup, or manifest under the checkout can be staged by an ordinary `git add`.

On Linux and macOS the tool publishes the output directory as `0700` and the run state, pre-soak backup, and backup manifest as `0600`, and fails closed if any of them is group- or world-accessible. Windows honours no POSIX permission bit except read-only, so those modes are advisory there: on Windows the operator must place the evidence directory on a path whose ACL grants the operator account only. `prepare` reports which regime applied as `privateArtifactProtection`.

Forget operations redact source content in place but retain content-free manifest identifiers. Consequently, a post-deletion database can prove which durable records were selected, but cannot reproduce their deleted text. This is intentional topology evidence, not a claim that deleted content remains recoverable.

## Commands

The workflow ships as three stages of one operator command, run from `services/discord-bot`:

```
pnpm memory:active-soak -- prepare --run-id <slug> --commit <full-sha> \
  --root <absolute-runtime-root> --binding-file <absolute-path> --out <absolute-output-dir>

pnpm memory:active-soak -- report --state <run-state.json> --attestation <attestation.json>

pnpm memory:active-soak -- verify --report <report.json> --commit <full-sha>
```

### prepare

Run before starting the bot. It refuses to arm a run unless every one of the following holds, so that the resulting evidence can be attributed to a single commit, runtime, and guild:

- the git worktree is clean and `HEAD` equals the exact 40-character `--commit`;
- `--root` is absolute and outside the repository checkout, and its authority database exists;
- `--out` is absolute and outside the repository checkout;
- the binding specification parses, declares at least one binding, is confined to exactly one guild, and binds no DMs;
- `--run-id` is an unused slug and no run state or pre-soak backup already exists in `--out`;
- authoritative write ownership can be acquired, which proves no bot process is still running;
- `verifyDatabase` integrity passes;
- a verified pre-soak backup is created, and it, its manifest, and the run state are owner-only where POSIX modes are authoritative.

It then writes `<run-id>.run-state.json` (mode `0600`) containing the commit, runtime root, binding-file digest, schema version, pre-soak backup path and digest, the scenario list, and a freshly generated report-redaction key. **This file is private**: it is the only thing that can link a redacted report back to real records.

### report

Run only after the bot is stopped. It opens the authority read-only, so reporting can never mutate evidence.

It reads **only** the authority path recorded in the run state. `--root` may be supplied but may only restate the runtime root `prepare` bound; any other value is refused. Reporting a different database under this run's identity and redaction key would produce evidence that looks attributable to the candidate but is not.

It correlates the operator attestation with durable events, generations, manifests, segments, and deliveries, and writes `<run-id>.report.json`. The report contains counts, per-scenario windows and observations, machine assertions, unresolved deliveries, deletion evidence, restore evidence, and rollback results — plus the commit SHA, schema version, memory profile, binding-file digest, pre-soak backup digest, and run window.

The pre-soak backup digest is published so the reviewer can confirm which snapshot the run started from. The backup's path is never published, because it would disclose the operator's private evidence layout.

No message text, transcript, display name, credential, or provider payload is read from the database at all. Every identifier is replaced by a run-scoped HMAC-SHA-256 rather than an unsalted hash, because Discord snowflakes come from a space small enough to enumerate against a plain digest.

The machine assertions are:

| Assertion | Fails when |
| --- | --- |
| `every-generation-has-pre-model-manifest` | a model call ran without durable pre-model evidence |
| `evidence-captured-before-model-start` | evidence was backfilled after the model started |
| `manifest-digest-reconstructs` | a persisted manifest no longer recomputes its stored digest |
| `manifest-items-stay-in-room` | a selected record belongs to another logical room |
| `no-unresolved-deliveries` | a delivery is still `pending`, `delivering`, or `unknownAfterCrash` |
| `zero-semantic-writes` | explicit semantic memory was written while disabled |
| `tombstones-verified` | a deletion tombstone is not in the `verified` state |

### The attestation file

`report` requires an operator-authored JSON file supplying what no durable record can prove — audible playback and semantic recall:

```json
{
  "format": 1,
  "runId": "<matches run state>",
  "commitSha": "<full 40-character sha>",
  "reviewerIndependenceDeclared": true,
  "scenarios": [
    { "id": "empty-history-text", "from": "<iso>", "to": "<iso>", "observed": "pass", "note": "optional, max 280 chars" }
  ],
  "rollbackDrillPassed": true,
  "deletionVerified": true,
  "oldBackupRestoreVerified": true
}
```

`reviewerIndependenceDeclared` is the operator's self-report that an independent reviewer was identified before execution. It is not machine proof of anything: no durable record can show who reviewed a run. The dated reviewer decision produced in "Review and promotion" remains the authoritative record of independence, and acceptance depends on it, not on this flag.

Each of the thirteen scenario ids must appear **exactly once**, with `from` strictly before `to`. No two windows may overlap or touch. Scenario presence is decided by inclusive timestamp range, so overlapping windows would let one generation satisfy several scenarios' evidence checks and collapse thirteen required executions into one; touching windows would double-count a record landing on the shared boundary. This runbook identifies no permitted overlap. In particular the `active-to-off-rollback` window must sit wholly after the active period, or active generations would be miscounted as post-rollback prompt use.

### verify

Exits nonzero when the report does not match its schema; the commit or schema version differs from the checkout under review; the run was not active-mode; a scenario attestation is missing, duplicated, reversed, or overlapping; a scenario was observed as failed; any machine assertion failed; an attested scenario produced no durable generation; the rollback window contains generation evidence; deliveries remain unresolved; the deletion scenario window contains no forget request or no tombstone; deletion, old-backup restore, or the rollback drill was not verified; or the report publishes an identifier that is not a run-scoped redaction.

Deletion evidence is counted **inside the `forget-deletion-migration-replay` window only**. An empty database has no unverified tombstone, so absence alone cannot satisfy the deletion gate: scenario 12 must produce at least one durable forget request and at least one durable tombstone of its own, and a leftover record from an earlier run cannot stand in for it. The whole-database totals are reported separately under `counts`.

## Scenario matrix

For every scenario, record the operator action, expected durable records, exact expected manifest, delivery assertion, human observation, and failure/cleanup action. A visible success without matching durable evidence fails; durable evidence without visible or audible delivery also fails.

| # | Scenario id | Operator action and expectation |
| --- | --- | --- |
| 1 | `startup-binding-reconciliation` | Start active with the isolated root and reconcile the private guild-only bindings. Expect current schema and binding revisions to match; stop and preserve evidence on mismatch. |
| 2 | `empty-history-text` | Send an empty-history text mention. Expect one inbound event and a running generation with a valid empty manifest persisted before the model call; attest that a reply appears. |
| 3 | `bound-text-voice-recall` | Exercise bound text-to-voice and voice-to-text recall. Expect same-room manifests with the selected delivered segments and no unrelated locations; attest semantic recall and audible playback. |
| 4 | `bound-thread` | Exercise the bound parent channel and thread. Expect only policy-authorized cross-location items; stop on parent/thread leakage. |
| 5 | `unbound-guild-isolation` | Send canaries in an unbound guild channel. Expect an isolated logical room and no bound-room canary in its manifest. |
| 6 | `dm-isolation` | Send DM canaries. Expect participant-scoped isolation and no guild identifiers or content. |
| 7 | `restart-continuity` | Stop and restart, then recall a delivered canary. Expect the manifest and generation chain to survive restart. |
| 8 | `multi-segment-text-delivery` | Produce a multi-segment text reply. Expect one segment and delivery attempt per chunk; only delivered attempts may enter later context. |
| 9 | `voice-playback-complete-cancel` | Complete one voice playback and cancel another. Expect completed local playback evidence for the first and terminal cancellation/interruption for the second; attest what was audible. |
| 10 | `privacy-status-show-export` | Run privacy status, show, and export. Expect requester-scoped results and no provider payloads in evidence. |
| 11 | `disabled-remember-correct` | Run disabled `remember` and `correct`. Expect zero semantic writes. |
| 12 | `forget-deletion-migration-replay` | Forget a canary, verify deletion, restore a verified v7 backup into an isolated candidate, migrate it forward, replay obligations, and verify again. Expect identifiers in manifests to remain while source content is redacted. |
| 13 | `active-to-off-rollback` | With the process stopped, drill active-to-off rollback. Expect no durable prompt read or generation evidence after restart. |

For any failed scenario: stop the bot, preserve redacted evidence, record the defect and cleanup, correct it, and rerun the full affected matrix. If the candidate SHA changes, the prior soak cannot qualify the new commit.

## Rollback

The only documented rollback is:

`stop → verified backup → configure full off → restart → prove no durable prompt use`

Do not roll directly from active to shadow; current policy rejects that transition as split-brain. A later off-to-shadow start is a separate rollout transition.

## Review and promotion

The reviewer must confirm exact pre-model manifests, delivery observations, deletion and old-backup restore, and the active-to-off drill at the same full commit, and must run `verify` themselves against the checkout being promoted. The reviewer must not be the implementer of the report tooling or the primary observer, and their decision must be dated and must name the reviewer and observer roles.

Only then may the promotion targets state that recent active memory is evidence-qualified for deliberate opt-in use at the reviewed commit and configuration. The promotion targets are exactly:

- `docs/memory/CURRENT.md`
- `docs/memory/evidence/evidence-index.md`
- the dated reviewer decision document

A documentation-only promotion commit does not become the qualified runtime SHA; the record must say that the live soak qualified the candidate SHA, not the commit that writes the record down.

Promotion changes no defaults: `off` remains the default, ordinary shadow rollout is unchanged, and the explicit semantic-memory, summary, extraction, vector, graph, remote, and degraded gates all remain closed. A failure receives no partial active-ready designation; record the failure and the corrective task instead.
