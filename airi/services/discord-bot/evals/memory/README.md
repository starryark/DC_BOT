# G8-1 functional memory evaluator (IMP-802)

A deterministic, content-free evaluator for the shared-memory **active profile**.
It exercises the production memory runtime boundary (`createMemoryRuntime`) over
synthetic fixtures and isolated temporary storage, and produces a machine-
readable summary, scenario JSON Lines, and a Markdown report. No provider,
Discord client, or operational configuration is touched.

This is a **functional baseline**, not a G8 pass. It establishes that the
identity, authorization, attribution, context, delivery, idempotency, restart,
prompt-safety, and privacy properties of the active profile hold under a fixed
synthetic dataset. Unsupported future capabilities and live-transport checks
remain explicit and are never passed by omission.

## Run

```bash
# smoke suite (default; uses a temp output directory)
pnpm -F @proj-airi/discord-bot memory:evaluate -- --suite smoke --seed 20260802

# full active-v1 suite (requires an explicit output directory outside the checkout)
pnpm -F @proj-airi/discord-bot memory:evaluate -- \
  --suite active-v1 \
  --seed 20260802 \
  --output <safe-external-output-directory>
```

Options:

| Flag | Description |
|---|---|
| `--suite smoke\|active-v1` | Scenario suite (default: `smoke`) |
| `--seed <integer>` | Deterministic seed (default: `20260802`) |
| `--output <directory>` | Output directory for machine artifacts (required for `active-v1`) |
| `--thresholds <file>` | Approved threshold document (optional) |
| `--keep-run-root` | Retain scenario runtime roots for debugging |

Exit codes: `0` all applicable pass; `2` invalid config/dataset/threshold; `3`
assertion or zero-tolerance failure; `4` unsafe path/cleanup/redaction failure;
`5` unexpected runtime exception.

## Layout

| Path | Purpose |
|---|---|
| `contracts.ts` | Strict schemas (dataset, operations, assertions, results, thresholds) and the outcome/capability taxonomy |
| `dataset.ts` | Deterministic synthetic-value generation and the active-v1 scenario matrix |
| `datasets/active-v1.json` | The frozen dataset artifact (digests identically to the in-code matrix) |
| `runtime-adapter.ts` | Isolated production-runtime adapter over `createMemoryRuntime` |
| `runner.ts` | Scenario dispatch, fixture drivers, oracle wiring, scoring |
| `oracles/` | Pure rule-based verdicts (identity, authorization, context, delivery, privacy) |
| `thresholds.ts` | Threshold evaluation; `measured_not_evaluated` when no document is supplied |
| `redaction.ts` | Run-scoped HMAC redaction and the prohibited-content scan |
| `report.ts` | Summary, scenario JSONL, Markdown report, normalized digest |
| `scripts/memory/evaluate.ts` (in `src/..`) | The CLI entry point |

## Properties

- **Deterministic**: every generated value derives from
  `(datasetVersion, seed, scenarioId, role)`; two runs of the same seed produce
  the same normalized result digest. Volatile fields (paths, wall-clock
  timestamps, elapsed time, process ids) are excluded from the digest.
- **Content-free**: every raw identifier is replaced by a run-scoped HMAC before
  it reaches a report; a redaction scan rejects any artifact carrying a
  snowflake, canary, fixture payload, path, or the redaction key.
- **Production boundary only**: the adapter wraps `createMemoryRuntime` with an
  explicit isolated root, never opens the operational authority, and closes the
  runtime on every path.
- **Explicit classification**: every deferred category (CAP-002, LIVE-*) has an
  explicit `unsupported` or `unverified` outcome; none is passed by omission.

See `docs/memory/evidence/g8-functional-baseline-template.md` for the evidence
format and `docs/memory/CURRENT.md` for the current status claim.

---

# IMP-803 deterministic performance benchmark

A credential-free, deterministic performance benchmark that measures
production-shaped memory operations and controller boundaries. It is separate
from the functional evaluator: volatile performance evidence never contaminates
the IMP-802 functional result digest.

This is a **deterministic benchmark**, not a G8 pass. It establishes code-path
latency, throughput, and cancellation behaviour through deterministic fakes. It
does not establish live Discord transport performance, room-acoustic barge-in
qualification, production provider availability, billed cost, or deployment
approval.

## Run

```bash
# smoke suite (credential-free; uses a temp output directory)
pnpm -F @proj-airi/discord-bot memory:benchmark -- --suite smoke --seed 20260802

# full performance-v2 suite (requires an explicit output directory outside the checkout)
pnpm -F @proj-airi/discord-bot memory:benchmark -- \
  --suite performance-v2 \
  --seed 20260802 \
  --output <safe-external-output-directory>
```

Options:

| Flag | Description |
|---|---|
| `--suite smoke\|performance-v2` | Workload suite (default: `smoke`) |
| `--seed <integer>` | Deterministic seed (default: `20260802`) |
| `--warmup <integer>` | Override warmup count for every workload |
| `--samples <integer>` | Override measured sample count for every workload |
| `--sample-capacity <integer>` | Override reservoir sample capacity |
| `--output <directory>` | Output directory (required for `performance-v2`) |
| `--thresholds <file>` | Approved threshold document (provenance validated before runtime start) |
| `--price-document <file>` | Approved price document (provenance validated before runtime start) |
| `--import-live <file>` | Import a live artifact (repeatable) |
| `--baseline <directory>` | Compare against a complete, correctness-clean `performance-v2` run |
| `--keep-run-root` | Retain run roots for debugging |

A run publishes six artifacts: `run-manifest.json`, `attempts.jsonl`,
`run-findings.jsonl`, `measurements.jsonl`, `summary.json`, and `report.md`.
`attempts.jsonl` carries one row per measured ordinal, so the published latency
denominator can be reconciled with the configured sample count; together with
`run-findings.jsonl` it makes the whole-run disposition recomputable from
artifacts alone. See the runbook for the verification procedure.

Exit codes: `0` complete, correctness-clean; `2` invalid CLI/contract/threshold/
price/provenance; `3` correctness or approved-threshold failure; `4` unsafe
output, cleanup, redaction, or artifact-write failure; `5` unexpected exception.

## Functional evaluator vs performance benchmark

| Property | Functional evaluator (IMP-802) | Performance benchmark (IMP-803) |
|---|---|---|
| What it measures | Assertion outcomes against a dataset | Latency, throughput, cancellation, usage |
| Deterministic digest | Normalized result digest | Contract digest (workload catalog) |
| Timings | Excluded from the digest | Environment-bound; reported but not digested |
| Thresholds | Functional pass-rate gate | Latency/throughput envelope |
| Live providers | Never | Optional controlled samples via `--import-live` |

## Artifact schemas

The benchmark writes four artifacts atomically:

- `run-manifest.json` — commit, dirty-worktree, environment fingerprint, provenance digests.
- `measurements.jsonl` — one measurement record per line; sufficient to recompute the summary.
- `summary.json` — workload counts, metric status, active/control deltas, cost availability, disposition.
- `report.md` — human-readable Markdown report.

## Threshold and price approval semantics

A threshold document may be proposed separately and approved by an authorized
approver; the benchmark validates its provenance before runtime start. An
approved threshold that a measurement breaches makes the run gate-invalid.

A price document may be proposed and approved separately. Cost is calculated
only when the model/provider matches, the window is effective, and every
required dimension has a price. Otherwise the result is absent with a reason;
zero is never emitted as a cost.

## Active/control interpretation

Every memory-overhead claim runs a matched active/inert pair: the inert control
resolves every context as disabled while the active half wires the real memory
adapter to an isolated runtime. The active-minus-inert mean delta isolates
memory cost from orchestration cost. Never compare unrelated workload ids.

## Live-artifact import

Optional controlled live samples (ASR, TTS, brain usage) may be imported via
`--import-live` as separately-digested evidence. Their values are never merged
into the deterministic contract digest. Prompt text, transcript, audio, provider
secrets, and private paths must never appear in an imported artifact's summary.

## Limitations

- Deterministic stub benchmark; does not establish live Discord transport performance.
- Barge-in results are controller cancellation path, not acoustic barge-in qualification.
- Cost is unavailable without a matching approved price document.
- Timings are environment-bound; only the contract digest must be identical between matched runs.

See `docs/memory/runbooks/g8-performance-benchmark.md` for the operator runbook.
