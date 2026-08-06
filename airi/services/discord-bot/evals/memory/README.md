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
