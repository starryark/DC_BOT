# DC_BOT Verified Repository Context Seed

This file is a **seed context**, not a substitute for a fresh drift check. It records the repository state verified while this skill bundle was created.

## Repository identity

- Repository: `starryark/DC_BOT`
- Default branch: `main`
- Verified latest commit on `main`: `1131327cdb7b0878a32127424a7b4723ca92b0e8`
- Commit message: `docs(memory): record IMP-803 baseline and validation evidence`
- Historical measured performance commit recorded by current docs: `a215840bfc366d4ae68f8dc4c09fb86c34dded19`
- Historical measured commit message: `fix(memory): use type imports for contracts to fix runtime ESM errors`

### Identity rule

Do not expect the immutable IMP-803 benchmark manifest to claim commit `1131327...` merely because that is the later documentation/current-state commit. The current repository documentation records the deterministic performance baseline at `a215840b...`; `1131327...` is a later evidence/documentation state. Treat measured-code identity, documentation/promotion identity, and a future candidate identity as separate values.

## Current recorded IMP-803 facts

`docs/memory/CURRENT.md` records:

- benchmark code commit: `a215840bfc366d4ae68f8dc4c09fb86c34dded19`
- workload/contract digest: `c403dd7781fdd28c214c65010d1f36fcbb4a68c9aa849d6b7dfb2b8624e959c6`
- seed: `20260802`
- run: `bench-2026-08-07T1903-a215840b`
- host: `win32 x64`
- Node: `v24.14.0`
- disposition: `correctness_clean_measured_not_evaluated`
- explicit limitation: this does **not** mean G8 passed and does **not** imply deployment approval.

## Verified file map

The following paths existed on `main` when this bundle was created.

| Path | Role | Verified blob SHA / note |
|---|---|---|
| `docs/memory/CURRENT.md` | Current program status; records IMP-802/803 boundaries and historical benchmark identity. | `693868d5f773029aa9b7a97c97d901747b6d7272` |
| `docs/memory/evidence/evidence-index.md` | Evidence index / promotion authority. | `3922ea3895b24ac9d0ca7ebcd0ce7ab92befd80c` |
| `airi/package.json` | AIRI workspace root; declares `packageManager: pnpm@10.33.0`. | `ea622bd2260416c838bc6b85efbe8d189e55d8d6` |
| `airi/pnpm-workspace.yaml` | pnpm workspace definition; includes `services/**`. | `85a573e45f15d2480a49745f823d6eaeec1c0c9f` |
| `airi/services/discord-bot/package.json` | Repository-native Discord-bot commands. | `191c9c24ae5707489715037fd101446c1c948823` |
| `airi/services/discord-bot/scripts/memory/benchmark.ts` | IMP-803 deterministic performance CLI; threshold input, baseline input, output/evidence guards. | `976f0aed498f7a4c4d3ddb8f0523f3c40faae813` |
| `airi/services/discord-bot/scripts/memory/baseline.ts` | Standalone baseline/candidate comparison CLI. | `6b5ef3e02a34617825761513a84df4213052f84e` |
| `airi/services/discord-bot/scripts/memory/evaluate.ts` | Separate G8-1 functional evaluator, not the performance-policy evaluator. | `87c3ef2fc0d0406bf5e745be9b1546f92759a32a` |
| `airi/services/discord-bot/evals/memory/performance/contracts.ts` | Strict performance schemas, metric units/statistics, run manifest, workload contract ID/version. | `6780abc168a472b0d7ad59ba49ffd3734f27aead` |
| `airi/services/discord-bot/evals/memory/performance/threshold-contract.ts` | Approved performance threshold document schema, compatibility, threshold application. | `9c54df6274e38993ce9a4b30f72dc1dd069c5207` |
| `airi/services/discord-bot/evals/memory/performance/workloads.ts` | Frozen `performance-v1` workload catalog and `WORKLOAD_CATALOG_DIGEST`. | `6698e8b78831fccf68566b94b60ec7e393d894d8` |
| `airi/services/discord-bot/evals/memory/performance/runtime-runner.ts` | Runtime workload execution; bridges deterministic runtime workloads to production-shaped memory runtime operations. | `cdfbd2850105966ec1ce43774664529b5d1dfe2a` |
| `airi/services/discord-bot/evals/memory/performance/controller-runner.ts` | Text/voice controller workload execution; directly exercises `MentionResponder`, `ConversationController`, and active memory adapters. | `a845a7c93069ee41b7db55d9e472b149b5978f3e` |
| `airi/services/discord-bot/evals/memory/performance/controller-runner.test.ts` | Focused controller benchmark tests covering text, voice, barge-in, active/inert pairs, and correctness recording. | `ffe8eef5b717c0e7607ca7a952c7ee434a694d1b` |
| `airi/services/discord-bot/evals/memory/performance/cli.test.ts` | Focused CLI guards for performance benchmark execution/arguments/output behavior. | `4775b800b6e55a2e3ae0d0a3a2f0fab3376a21e8` |
| `airi/services/discord-bot/evals/memory/performance/threshold-contract.test.ts` | Focused tests for performance-threshold parsing, provenance/compatibility, and application semantics. | `5602daebe63476bd20769faf65db5dbdbc72137b` |
| `airi/services/discord-bot/evals/memory/performance/report.ts` | Performance summary/disposition, recomputation, baseline deltas, content-free report. | `de7bde6d5aaedea6c11cac55d1ec82426da281a4` |
| `airi/services/discord-bot/evals/memory/performance/baseline.ts` | Library-level compatible baseline comparison and run loading. | `aa8b52c01c291730c81144bee3bc74b75c5cf73d` |
| `airi/services/discord-bot/evals/memory/runtime-adapter.ts` | Runtime adapter reached by performance/functional evaluators; use when tracing into product runtime. | `001af250692cebe581914fb2bdf3ada0fc4a976a` |

## Verified command surfaces

`airi/package.json` declares the workspace package manager as `pnpm@10.33.0`, and `airi/pnpm-workspace.yaml` includes `services/**`. The verified command working directory is therefore the repository's `airi/` directory, not the repository root.

`airi/services/discord-bot/package.json` defines:

- `memory:evaluate` → `tsx scripts/memory/evaluate.ts`
- `memory:benchmark` → `tsx scripts/memory/benchmark.ts`
- `memory:baseline` → `tsx scripts/memory/baseline.ts`
- `test` → `vitest run`
- `typecheck` → `tsc --noEmit`

Run the following from `<repo>/airi` (or use an execution API that sets `cwd=<repo>/airi`):

```text
pnpm -F @proj-airi/discord-bot memory:benchmark -- --help
pnpm -F @proj-airi/discord-bot memory:baseline -- --help
pnpm -F @proj-airi/discord-bot memory:evaluate -- --help
pnpm -F @proj-airi/discord-bot typecheck
pnpm -F @proj-airi/discord-bot test
```

These examples are one-line argv-equivalent forms and do not depend on PowerShell continuation syntax. The executing agent must first verify that the repository-declared `pnpm` version (or a repository-approved compatible route) and required Node runtime are actually available, and should still run `--help` or inspect package/workspace files after repository drift.

## Performance benchmark rules verified in source

`memory:benchmark` currently supports:

- `--suite smoke|performance-v1`
- `--seed <integer>`
- `--warmup <integer>`
- `--samples <integer>`
- `--sample-capacity <integer>`
- `--output <directory>`
- `--thresholds <file>`
- `--price-document <file>`
- `--import-live <file>`
- `--baseline <directory>`
- `--keep-run-root`

Important behavior:

1. `performance-v1` requires an explicit output directory.
2. Output must be a safe external path; in-repository output is rejected.
3. `performance-v1` requires a known Git HEAD and a clean worktree.
4. Git SHA/dirty state are rechecked before artifacts are written; changing the worktree during a benchmark invalidates the run.
5. With `--baseline`, the baseline manifest's `contractDigest` must match the current frozen workload catalog digest.
6. With `--thresholds`, the threshold document is parsed and compatibility-validated before runtime execution.
7. Generated artifacts are:
   - `run-manifest.json`
   - `measurements.jsonl`
   - `summary.json`
   - `report.md`
8. Exit codes:
   - `0` complete/correctness-clean/no approved threshold failure;
   - `2` invalid CLI/contract/threshold/price/provenance;
   - `3` correctness failure or approved threshold failure;
   - `4` unsafe output/cleanup/redaction/artifact-write failure;
   - `5` unexpected runtime exception.

### Orchestration consequence

Any production or diagnostic code intended to be measured by a full `performance-v1` run must first be frozen in a **local commit** so the worktree is clean and the exact measured SHA is preserved. This does not authorize pushing the commit.

## Threshold policy is separate from workload contract identity

`threshold-contract.ts` defines a distinct `performance-thresholds` document with fields including:

- `schemaVersion`
- `contractId`
- `contractDigest`
- `source`
- `approver`
- `approvedAt`
- `provenance`
- optional effective dates
- `thresholds[]`, each with:
  - `workloadId`
  - `metricId`
  - `statistic`
  - `unit`
  - `comparator` (`lte` or `gte`)
  - `bound`

Critical semantics:

- If **no threshold document** is supplied, measurements are `not_evaluated`.
- If a threshold document does not contain a matching threshold identity for a measurement, that measurement is `not_evaluated`.
- If a measurement outcome is unavailable, it is `not_evaluated`.
- Only a matching available metric can be `passed` or `failed`.

Therefore:

> The workload `contractDigest` proves workload/measurement-contract compatibility. It is **not** itself the approved threshold policy.

Do not infer threshold bounds from `threshold-contract.ts`, the workload digest, or the baseline. The approved threshold document is a separate required artifact when the task requires a real performance-policy decision.

No authoritative threshold document path was established while this bundle was created. A repository-search miss is not proof that none exists. The executing artifact factory/gatekeeper must locate the approved document from repository/project evidence or stop as `INCOMPLETE` if it is required but unavailable.

## Report/disposition rules verified in source

`report.ts` uses these run dispositions:

- `correctness_clean_measured_not_evaluated`
- `correctness_clean_thresholds_passed`
- `failed`

A run becomes `failed` for correctness/cleanup failures or failed approved thresholds. If there are no failures and at least one threshold-evaluated pass, it can be `correctness_clean_thresholds_passed`; otherwise it remains measured-not-evaluated.

The report deliberately does not call the overall result “G8 passed.”

## Workload and runtime bridge

`workloads.ts` is the frozen catalog for the deterministic `performance-v1` suite. It includes runtime and controller workloads and publishes `WORKLOAD_CATALOG_DIGEST`.

`runtime-runner.ts`:

- runs isolated runtime workloads with seeded sampling;
- checks correctness postconditions before recording valid latency samples;
- does not time fixture generation, report serialization, report writing, or cleanup;
- bridges through the runtime adapter toward `createMemoryRuntime`.

`controller-runner.ts` is equally authoritative for controller-family workloads:

- runs text and voice controller workloads;
- constructs production `MentionResponder` / `ConversationController`;
- uses active or inert memory adapters for matched comparisons;
- records controller correctness failures before treating samples as valid;
- reaches real memory adapter/runtime paths while keeping provider/playback fakes benchmark-owned.

For a performance failure, trace:

```text
metric
  -> workload id/spec (`workloads.ts`)
  -> runner family / operation (`runtime-runner.ts` or `controller-runner.ts`)
  -> runtime adapter
  -> production memory API
  -> authoritative implementation
  -> persistence/model/provider boundary
```

Do not assume benchmark/report overhead is the product bottleneck unless measurement evidence shows that.

## Standalone baseline comparison

`scripts/memory/baseline.ts` loads two run directories and calls the library comparator in `evals/memory/performance/baseline.ts`.

The library comparator requires matching `contractDigest` for compatibility and emits candidate-minus-baseline deltas for matching observed metrics.

Use this path as an independent semantic parity check when the plan requires baseline comparison.

## Functional evaluation remains separate

`memory:evaluate` is the G8-1 functional baseline evaluator.

Verified properties:

- suites: `smoke|active-v1`;
- deterministic seed;
- explicit external output required for `active-v1`;
- optional **functional** threshold document parsed through the functional evaluator contracts;
- synthetic fixtures and isolated storage;
- no Discord client/provider/operational config required for the evaluator itself;
- exit code `3` represents scenario assertion or zero-tolerance failure.

Do not pass a performance threshold document to the functional evaluator merely because both CLIs use an option named `--thresholds`; they use different contracts.

## Portable repository/tool lookup rules

For this repository:

1. Pin `main` with repository metadata/commit fetch.
2. For every known path in this seed, use a direct file fetch/read at the pinned SHA.
3. For inventories, use a direct directory/tree read.
4. Traverse imports/call sites with direct file reads when establishing benchmark → production ownership.
5. Use code search only to discover candidate paths/symbols. An empty code-search result is not evidence of absence.
6. A local checkout is required only for worktree-specific operations (edits, diff, clean-state proof, tests/builds/benchmarks, local commits). Remote GitHub reads do not substitute for those runtime proofs.
7. `gh` is optional. Prefer connector-backed repository reads and authorized GitHub writes where an exact connector action exists.

Before execution, record availability of the local checkout, shell, `git`, package manager, Node/runtime, external writable output directory, and fresh-context/direct-child invocation. Missing required execution capabilities make the applicable gate `INCOMPLETE`; they do not justify invented tool calls.

## DC_BOT-specific preflight gates recommended by the supplied Plan.md

Before any optimization edit:

1. Recover the immutable IMP-803 primary baseline directory.
2. Verify required raw files and their recorded hashes/digests against evidence.
3. Reconcile the historical measured commit (`a215840b...`) with the later evidence/docs commit (`1131327...`).
4. Locate and verify the approved performance threshold document if the task is to make an actual G8 performance-policy decision.
5. Run an unmodified clean candidate before deciding whether optimization is necessary.
6. Build a metric/workload threshold matrix.
7. Only if a real required metric fails, trace that metric to the measured production path.
8. Add diagnostics only if the existing evidence cannot localize the cost.
9. Optimize the first evidence-proven bottleneck only.
10. Re-run repeatability, independent baseline comparison, functional evaluation, and full regression gates.

If the unmodified candidate already satisfies all required approved thresholds and correctness gates, skip speculative production optimization.
