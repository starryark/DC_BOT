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
pnpm memory:evaluate -- --suite smoke --seed 20260802

# full active-v1 suite (requires an explicit output directory outside the checkout)
pnpm memory:evaluate -- \
  --suite active-v1 \
  --seed 20260802 \
  --output <safe-external-output-directory>

# IMP-607 lexical retrieval qualification
pnpm memory:evaluate -- \
  --suite multilingual-v1 \
  --retrieval-mode lexical \
  --seed 20260802 \
  --output <safe-external-output-directory>
```

Options:

| Flag | Description |
|---|---|
| `--suite smoke\|active-v1\|multilingual-v1` | Scenario suite (default: `smoke`) |
| `--retrieval-mode lexical\|vector\|graph` | Retrieval candidate; vector and graph are explicitly unsupported |
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
| `retrieval/metrics.ts` | Pure rank/relevance metrics independent of native score scales |
| `retrieval/report.ts` | Per-query completeness, aggregate recomputation, experiment comparison |
| `g8/qualification.ts` | Aggregate G8 qualification: consumes evidence, enumerates blockers, never evaluates |
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
- **Measurement is not acceptance**: retrieval results remain
  `measured_not_evaluated` without an approved provenance-matching policy and
  never activate vector or graph capability.

See `docs/memory/evidence/g8-functional-baseline-template.md` for the evidence
format and `docs/memory/CURRENT.md` for the current status claim.

---

## IMP-803 deterministic performance benchmark

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
pnpm memory:benchmark -- --suite smoke --seed 20260802

# full performance-v2 suite (requires an explicit output directory outside the checkout)
pnpm memory:benchmark -- \
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
| `--import-live <file>` | Import a live artifact (repeatable); one cost-eligible `brain-usage-sample` plus a matching price document derives calculated cost |
| `--baseline <directory>` | Compare against a complete, correctness-clean `performance-v2` run |
| `--keep-run-root` | Retain run roots for debugging |

A run publishes seven artifacts: `run-manifest.json`, `attempts.jsonl`,
`run-findings.jsonl`, `measurements.jsonl`, `voice-sample-diagnostics.jsonl`,
`summary.json`, and `report.md`. `attempts.jsonl` carries one row per measured
ordinal, so the published latency denominator can be reconciled with the
configured sample count; together with `run-findings.jsonl` it makes the
whole-run disposition recomputable from artifacts alone. See the runbook for the
verification procedure.

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

The benchmark writes seven artifacts atomically:

- `run-manifest.json` — commit, dirty-worktree, environment fingerprint, provenance digests.
- `attempts.jsonl` — one row per measured attempt; the latency denominator.
- `run-findings.jsonl` — cleanup and warmup failures, which never become attempts.
- `measurements.jsonl` — one measurement record per line; sufficient to recompute the summary.
- `voice-sample-diagnostics.jsonl` — supplementary per-sample stage/memory timing for the two
  condition-5 voice workloads; read by no correctness derivation, and not required to load a run.
- `summary.json` — workload counts, metric status, active/control deltas, derived cost availability and (when available) recomputable `costEvidence`, disposition.
- `report.md` — human-readable Markdown report.

## Threshold and price approval semantics

A threshold document may be proposed separately and approved by an authorized
approver; the benchmark validates its provenance before runtime start. An
approved threshold that a measurement breaches makes the run gate-invalid.

A price document may be proposed and approved separately. Cost is calculated
only when the model/provider matches, the window is effective at the usage
observation time, and every required dimension has a price. Otherwise the
result is absent with a content-free reason; zero is never emitted as a cost.

`costAvailability` is derived, never asserted: the report builder takes one
discriminated cost result, so `available` is published only together with the
`costEvidence` that produced it. The evidence carries the embedded sanitized
brain-usage artifact, its canonical digest, the price-document digest, the
currency, the amount, and the per-dimension token count, unit price, and
subtotal — enough for `memory:qualify-g8` to recompute the amount from the
approved document rather than trust the flag.

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

Each kind is its own strict shape. A `brain-usage-sample` carries the numeric
`UsageRecord` the cost calculator needs, and its `observedAt` must equal that
record's; an ASR or TTS sample has no such field and rejects one.

## Controlled brain-usage capture

`memory:capture-brain-usage` (`scripts/memory/capture-brain-usage.ts`, core
logic in `performance/brain-usage-capture.ts`) is the only memory CLI that makes
a real, billable provider call, and only when an operator runs it with
credentials. `memory:benchmark` stays provider-offline.

```bash
pnpm memory:capture-brain-usage -- \
  --output <private-external-directory> \
  --sample-id brain-usage-001 \
  --host-provenance <content-free-host-label> \
  --config-provenance <content-free-config-label>
```

It reuses `GeminiBrainProvider` and its existing `usageSink`, sends one fixed
synthetic probe request, drains the stream while discarding every generated
chunk, and captures exactly one terminal usage record. It fails closed when
credentials are absent (exit 2), and when no record, more than one record, a
non-complete call, or no token counts were observed (exit 3). It writes
`usage-record.json` (raw numeric; keep it private) and `live-artifact.json`
(import this into the benchmark). Exit codes: `0` captured, `2` invalid CLI /
missing credentials / unpublishable fields, `3` no trustworthy observation, `4`
unsafe output or write failure, `5` unexpected exception.

Calculated cost is an estimate from observed usage plus an approved price
document, not verified billing truth, and a locally mocked capture is not G8
release evidence.

## Limitations

- Deterministic stub benchmark; does not establish live Discord transport performance.
- Barge-in results are controller cancellation path, not acoustic barge-in qualification.
- Cost is unavailable without both a matching approved price document and one cost-eligible brain usage sample.
- Timings are environment-bound; only the contract digest must be identical between matched runs.

See `docs/memory/runbooks/g8-performance-benchmark.md` for the operator runbook.

---

## Aggregate G8 qualification

`memory:qualify-g8` (`scripts/memory/qualify-g8.ts`, pure logic in
`g8/qualification.ts`) aggregates previously produced evidence — evaluator run
pairs, performance run pairs, threshold/price documents, an active-soak report,
and external signoff records — into one G8 decision for an exact candidate
commit. It consumes evidence and never runs an evaluator, benchmark, or soak.
Every missing, stale, malformed, unevaluated, or unapproved input becomes a
stable blocker code; `measured_not_evaluated` never qualifies, and a threshold
or price document satisfies an approval requirement only when a supplied
signoff record covers its digest. Exit codes: `0` pass, `2` invalid
CLI/path/input, `3` blocked, `5` unexpected. A pass authorizes nothing and does
not trigger IMP-807 staged rollout. See
`docs/memory/runbooks/g8-qualification.md` for the full condition mapping and
blocker semantics.
