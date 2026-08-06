# G8 functional baseline — 2026-08-06

G8 functional baseline established for the active profile at
`40874091d9ed39337e2db6f4de30d1b7b969b186` using dataset
`1.0.0/c9ddd85a33208f857dd2b4516a5b0e733ef92c43c00b9c4fec169dd12204f1cc` and
seed `20260802`. All applicable zero-tolerance assertions passed. Unsupported
future capabilities and live transport checks remain explicit. G8 is not passed
and no deployment approval is implied.

## Run identity

- Candidate commit: `40874091d9ed39337e2db6f4de30d1b7b969b186`
- Dataset version: `1.0.0`
- Dataset digest: `c9ddd85a33208f857dd2b4516a5b0e733ef92c43c00b9c4fec169dd12204f1cc`
- Evaluator schema version: `1`
- Seed: `20260802`
- Platform: `win32`
- Normalized result digest: `bd788e2459bdb27c944e932566fca560358a0afb1fb0014b88ae6c601c88056b`

## Whole-run result

- Applicable pass rate: `17/17`
- Zero-tolerance failures: `0`
- Cleanup failures: `0`

Counts by outcome (22 scenarios total):

| Outcome | Count |
|---|---|
| passed | 17 |
| unsupported | 1 |
| unverified | 4 |

Counts by capability disposition: 18 supported, 4 unsupported.

## Capability classification

Unsupported categories (explicit, never passed by omission): `CAP-002` — vector,
graph, remote, degraded, spool, summary, extraction, lexical, and semantic are
unsupported in the active profile.

Unverified categories (explicit, never passed by omission): `AUTH-004`
(DM authority scope exercised; live transport explicitly unverified), `LIVE-001`
(live Discord DM ingress/delivery), `LIVE-002` (acoustic barge-in cancellation),
`LIVE-003` (provider latency, cost, and deployment-host performance).

## Thresholds

- Measurement status: `measured_not_evaluated` (no approved threshold document
  was supplied).
- Thresholds approved: `false`.
- Signed decision: `false`.

## Determinism

Two runs of the smoke suite with the same seed (`20260802`) produced the same
normalized result digest (`04b9a19d813b032544dfef521c2c671c6ee0dd8899e7f0587e8f4a93644f0dd3`).
Scenario execution order does not change any scenario's normalized result. Raw
elapsed timings were excluded from the digest.

## Verification

- Dataset/parser, runtime-adapter, oracle mutation, report/threshold/redaction,
  and CLI invalid-input/unsafe-path tests: 91 tests passed.
- Oracle mutation tests: 30 tests, covering merged identities, cross-guild and
  cross-character candidates, missing cause, partial output treated as complete,
  deleted canary reappearance, internal-identifier leakage, disabled-operation
  success, and delivery-leak mutants — each produces a stable assertion failure.
- Full `active-v1` suite: 17/17 applicable assertions passed, exit 0.
- Discord-bot package regression: 51 files, 586 tests passed (1 skipped).
- memory-domain: 212 tests passed. memory-sqlite: 138 tests passed.
- Discord-bot, memory-domain, and memory-sqlite typechecks passed.
- Targeted ESLint over every changed TypeScript file passed.
- `git diff --check` passed.
- Redaction scan: no raw identifiers, canaries, paths, fixture payloads, or
  redaction-key content in any published artifact.

## Non-overclaim boundaries

This baseline does not claim live Discord DM transport behavior, acoustic
barge-in cancellation under the shipped configuration, or any production SLO,
retrieval-quality threshold, or deployment approval. It does not re-qualify or
re-state the A8 soak result; the A8 qualification remains bound to commit
`86ca5cfc674997820fe4d1f235d1d16f30ce1470` and its configuration, operator-
qualified, with the shipped barge-in configuration unqualified. Vector, graph,
remote, degraded, spool, summary, extraction, lexical, and semantic capabilities
remain gated and are not advertised as operational.

## Reproducibility

```bash
pnpm -F @proj-airi/discord-bot memory:evaluate -- \
  --suite active-v1 \
  --seed 20260802 \
  --output <safe-external-output-directory>
```

The evaluator uses the production memory runtime boundary (`createMemoryRuntime`
in active mode with an explicit isolated runtime root). No operational database
or configured runtime root is touched; no migration, feature flag, default mode,
intent, provider, prompt, or barge-in setting is changed.
