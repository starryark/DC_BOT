# A8 active-memory soak — qualification record

**Qualified commit:** `86ca5cfc674997820fe4d1f235d1d16f30ce1470`
**Run:** `t002-86ca5cfc-20260805b` · **Date:** 2026-08-05
**Result:** twelve of twelve scenarios observed pass; all seven machine
assertions pass; `report` and `verify` both exit zero at that exact commit.

**This is an operator-qualified result, not a reviewed one.** The
independent-review gate was removed in `7a3fd5e` because its
`v.literal(true)` field made a single-operator attestation unparsable, leaving
every run *unqualifiable* rather than merely unreviewed. The field was deleted
rather than defaulted, so no report asserts a review that did not happen. Cite
this result as **operator-qualified**; never as "reviewed" or "independently
verified".

This document and `t002-86ca5cfc-20260805b.report.json` are the only artifacts
promoted into the repository. Raw evidence — run state and redaction key,
attestation with operator notes, backups, the live authority, binding file and
process logs — stays in the private run tree outside the checkout and is never
committed.

## Ledger

| # | Scenario | Observed | Generations | Deliveries |
|---|---|---|---|---|
| 1 | `startup-binding-reconciliation` | pass | 0 | 0 |
| 2 | `empty-history-text` | pass | 1 | 1 |
| 3 | `bound-text-voice-recall` | pass | 3 | 7 |
| 4 | `bound-thread` | pass | 1 | 1 |
| 5 | `unbound-guild-isolation` | pass | 1 | 1 |
| 6 | `restart-continuity` | pass | 1 | 1 |
| 7 | `multi-segment-text-delivery` | pass | 1 | 3 |
| 8 | `voice-playback-complete-cancel` | pass | 3 | 9 |
| 9 | `privacy-status-show-export` | pass | 1 | 1 |
| 10 | `disabled-remember-correct` | pass | 0 | 0 |
| 11 | `forget-deletion-migration-replay` | pass | 1 | 1 |
| 12 | `active-to-off-rollback` | pass | 0 | 0 |

Twelve unique, strictly increasing, non-overlapping, non-touching windows
spanning `12:23:30Z → 12:55:46Z`. Schema v8, memory mode active.

Totals: 13 inbound events, 13 generations (**0 failed**), 13 manifests, 150
manifest items, 25 output segments, 25 deliveries (**0 unresolved**), 3 room
bindings, **0 semantic memories**, 6 privacy operations, 1 forget request, 34
deletion tombstones.

Scenarios 1, 10 and 12 are the three the policy permits to produce no
generation.

## What the run establishes

**Voice output is durably complete.** Scenario 8's completed reply persisted
with six chunks, every one carrying `localPlaybackCompleted` evidence totalling
22.4 s of audio, while the operator confirmed hearing it end to end. Two
deliberately interrupted replies recorded terminal `cancelled` with their played
chunks intact. No generation in the run recorded `failed`.

**Room isolation holds, established twice through independent code paths.**
Scenario 5's unbound-channel generation ran in its own logical room with
`manifest_items = 0` — it did not decline to disclose bound-room content, it
never received any. Scenario 9's privacy status independently counted the bound
room's ten requester events while excluding the unbound room's event entirely.

**Continuity comes from the durable authority, not process state.** Scenario 6
stopped the bot and restarted it through the production launcher; the
post-restart generation drew fourteen manifest items, all fourteen resolving to
records written before the restart, spanning text, voice and thread.

**Deletion is real, verified and bounded by the same room boundary as recall.**
Scenario 11's live forget produced one completed forget request and 34 verified
tombstones — 11 inbound events and 23 output segments. Payloads were replaced
with exactly `{"redacted":true}` while rows and thirteen causal edges survived,
preserving the graph. The unbound room's payload was untouched. The next turn
ran with `manifest_items = 0`, down from 24.

**Rollback is clean and complete.** Scenario 12 stopped the bot, proved writer
ownership released by taking a verified backup, atomically replaced the active
memory environment file with the pre-hashed off file (only `MEMORY_MODE`
differing, both hashes matching their frozen values), restarted through the
normal launcher, and produced zero generations, events, deliveries and segments.
The authority was never opened — no WAL, no shared-memory file, no lease
journal.

## Scope of the claim

This qualifies **one commit and one configuration**.

- `BOT_INPUT_POLICY=half_duplex` is part of what passed. Under it, speech
  arriving while the character is thinking or speaking is dropped before ASR, so
  talking over the character does not interrupt playback. That is designed
  behaviour, confirmed during scenario 8. The `barge_in` policy is **untested**
  and would require its own qualification cycle.
- `dm-isolation` is not in the matrix. It was removed in `6694c5a`: a
  user-installed application never receives `MESSAGE_CREATE` for direct
  messages, so the scenario cannot execute in this deployment. DM isolation is
  therefore **neither confirmed nor refuted** by this run.
- Any source, test, dependency, migration, runbook or configuration-source
  change after `86ca5cfc` invalidates this qualification and requires a new
  candidate, a new run identity and a fresh private evidence tree.

## Defects found and fixed on the path to this commit

- **DEFECT-004** (`519583a`) — the durable output repository takes a whole-set
  declaration, not an append log. The voice adapter declared one segment per
  played chunk, so every reply past its first chunk was refused as a mismatched
  retry. This both recorded `failed` for correct-sounding replies and truncated
  audio mid-sentence, because the escaping error discarded chunks already
  synthesized. An earlier fix (`6694c5a`) addressed a genuine upstream
  backpressure problem but not this one.
- **DEFECT-005** (`86ca5cfc`) — a transient upstream 503 killed the bot process
  during the preceding run. The failure-recording path re-raised the error it
  was handed, rejecting the very catch block that was handling it; with no
  `error` listener on the gateway client, the rejection ended the process. Write
  paths keep their fail-closed rethrow, the reporting path no longer re-raises,
  the client now has an error sink, and a 503 is retried under bounded backoff
  before the first token only.

## Known gap in the policy

The `privacy-status-show-export` scenario is subject to `verify`'s
"attested scenario produced no durable generation" rule, but the privacy
commands are non-generative and cannot satisfy it. The run included one ordinary
mention turn inside that window solely to meet the rule, recorded as such in the
attestation. The scenario arguably belongs in the exempt list alongside
`disabled-remember-correct`; changing that is a tooling change and would require
a new qualification cycle.
