# IMP-803 deterministic performance benchmark runbook

This runbook describes the operator procedure for running the IMP-803
deterministic performance benchmark (`memory:benchmark`) and recording a
candidate baseline. It is a **deterministic harness runbook**, not a gate: the
benchmark establishes code-path latency and cancellation behaviour, never live
Discord transport performance, room-acoustic barge-in qualification, production
provider availability, billed cost, or deployment approval.

## What the benchmark is

A credential-free, deterministic benchmark that measures production-shaped
memory operations and controller boundaries through the real `ScenarioRuntime`
adapter, `MentionResponder`, and `ConversationController`, driven by
benchmark-owned deterministic fakes. It produces a content-free artifact set
with a deterministic contract digest and environment-bound timings.

The contract family is `performance-v2`. Every published run consists of **six**
artifacts:

| Artifact | What it carries |
|---|---|
| `run-manifest.json` | Contract identity, environment, and the effective `workloadPlan` |
| `attempts.jsonl` | One row per measured attempt: ordinal, outcome, and failed postcondition ids |
| `run-findings.jsonl` | Content-free cleanup failures; empty when none occurred |
| `measurements.jsonl` | Latency statistics with their observation denominators |
| `summary.json` | Derived counts and the whole-run disposition |
| `report.md` | The human-readable rendering |

`attempts.jsonl` and `run-findings.jsonl` are what make a run auditable. Without
them the published summary cannot be checked against its own evidence, which is
why a directory missing either is not a valid `performance-v2` artifact set.

### What changed from `performance-v1`

`performance-v1` artifacts are **never** valid `performance-v2` evidence and are
rejected automatically as baselines. The v1 harness could not support the checks
below:

- measured attempts were not published at all, and a failed sample was silently
  dropped, so `attempted` could not be reconciled with the configured count;
- both runners emitted a hardcoded `correctnessClean: true`;
- cleanup failures forced the run to `failed` while appearing in no artifact,
  so the disposition was not recomputable;
- the four barge-in stages were selected by a workload-id prefix and separated
  only by fixed sleeps, and four of the six cancellation predicates were
  hardcoded true;
- the runtime runner minted identifiers with `Math.random()`, so no run was
  reproducible.

## What the benchmark is not

- **Not G8 passed.** The overall disposition is `correctness_clean_*` or
  `failed`, never `G8 passed`.
- **Not A8 requalified.** Acoustic A8 requalification remains a separate
  private Discord twelve-scenario run under the shipped barge-in configuration.
- **Not live transport qualified.** Controller barge-in results are labelled
  `controller cancellation path`, never `acoustic barge-in qualification`.
- **Not production SLO achieved.** Timings are environment-bound and allowed to
  differ between matched runs; only the contract digest must be identical.
- **Not deployment approved.** No artifact or status field implies deployment
  approval.

## Prerequisites

1. A clean checkout at an exact commit:
   ```bash
   git clone https://github.com/starryark/DC_BOT.git
   cd DC_BOT/airi
   git fetch --all --tags --prune
   git switch <candidate-commit>
   git status --short   # must print nothing for performance-v2
   ```

2. The pinned workspace toolchain:
   ```bash
   corepack enable
   corepack prepare pnpm@10.33.0 --activate
   pnpm install --frozen-lockfile
   ```

3. A representative host and configuration selection. Record the host, CPU,
   memory, platform, architecture, and SQLite version; any change invalidates a
   candidate baseline.

## Running the smoke suite (credential-free)

```bash
pnpm -F @proj-airi/discord-bot memory:benchmark -- \
  --suite smoke \
  --seed 20260802
```

Smoke uses a temporary external output directory, requires no Discord or
provider credentials, and exercises one of each essential path. It is a wiring
check, not a baseline.

## Running a full deterministic baseline

Choose an external output directory outside the checkout:

```bash
OUT="$(mktemp -d -t dc-bot-imp803-XXXXXX)"
pnpm -F @proj-airi/discord-bot memory:benchmark -- \
  --suite performance-v2 \
  --seed 20260802 \
  --output "$OUT"
```

The full suite requires:
- explicit `--output` outside the checkout;
- a known git HEAD (not `unknown`);
- a clean worktree;
- a non-empty output directory rejected unless it is a prior run.

### Repetition

Run the **same** seed three times first. The purpose of these three runs is
reproducibility, not seed diversity: a harness whose correctness pattern varies
between identical runs is not deterministic, and averaging that variation away
would hide the defect rather than fix it.

```bash
for repetition in 1 2 3; do
  OUT="$(mktemp -d -t dc-bot-imp803-r${repetition}-XXXXXX)"
  pnpm -F @proj-airi/discord-bot memory:benchmark -- \
    --suite performance-v2 \
    --seed 20260802 \
    --output "$OUT"
done
```

Seed diversity, if wanted, comes only after the three identical-seed runs agree.

## Before treating the result as evidence

1. **Hash every artifact.** Record the SHA-256 of all six: `run-manifest.json`,
   `attempts.jsonl`, `run-findings.jsonl`, `measurements.jsonl`, `summary.json`,
   and `report.md`.

2. **Independently recompute the whole summary.** `recomputeSummary()` parses
   the manifest, attempts, findings, and measurements through the strict v2
   schemas and rebuilds the correctness state without reading `summary.json`.
   Confirm it reproduces the published workload counts, sample counts, failed
   postcondition count, cleanup count, sample-completeness status, threshold
   status counts, and disposition. `loadRun()` performs this check and refuses
   any directory whose summary disagrees with its own rows.

3. **Verify the effective workload plan.** `run-manifest.json` carries
   `workloadPlan`. For every workload confirm `attempted == sampleCount`, that
   each ordinal in `0..sampleCount-1` appears exactly once, that
   `passed + failed == attempted`, and that each metric's `observationCount`
   equals that workload's passed attempts.

4. **Confirm same-seed reproducibility.** Across the three repetitions the
   contract digest, workload plan, attempt ordinals, attempt outcomes, failed
   postcondition ids, sample-completeness result, and correctness disposition
   must be identical. **Latency values are expected to differ.** If a
   correctness pattern differs between repetitions, stop — do not average the
   inconsistency away.

5. **Confirm the contract digest is identical between matched runs.** The
   `contractDigest` field must be the same 64-char hex for every run of the
   same workload catalog.

6. **Confirm no approved threshold or cost claim appears without matching
   documents.** Cost is absent without an approved, matching price document.

## Baseline compatibility policy

`--baseline <directory>` compares a candidate against an accepted reference.
The comparison refuses the pair, listing every reason, unless all of the
following hold:

- **Contract identity** — `schemaVersion`, `contractId`, `contractDigest`, and
  `suite` all match. A `performance-v1` directory is always refused.
- **Effective plan** — `workloadPlan` matches entry for entry, including
  `sampleCapacity`. Capacity decides which samples a percentile was computed
  over, so a different capacity means a different statistic.
- **Correctness eligibility** — *both* runs have zero failed measured attempts,
  zero cleanup findings, complete attempt sets, and measurement denominators
  equal to their passed attempts. A failed or partial run is never a reference.
- **Environment** — `platform`, `architecture`, `nodeVersion`, `pnpmVersion`,
  `sqliteVersion`, `cpuModel`, `cpuCount`, and `totalMemoryBytes` match exactly.
- **Measurement coverage** — the metric sets match in both directions, with
  identical `unit`, `statistic`, and `role`. A metric present in only one run is
  an incompatibility, never a silently skipped comparison.

Threshold presence is deliberately **not** part of compatibility. A clean run
whose metrics are all `not_evaluated` is a valid raw latency reference; a
threshold document governs policy evaluation, not whether two samples were taken
under comparable conditions.

**On the environment tolerance.** Equality is exact, including
`totalMemoryBytes`. A tolerance is a policy decision with a numeric bound, and
no such bound is authorized. If governance wants one, it must be written here
first; the comparator is then changed to match. It must not be invented in code.

## Workloads deliberately absent from `performance-v2`

`active-writer-contention` was removed rather than renamed. In v1 its measured
body was byte-identical to `same-room-serialized-load` and its postcondition was
"an append returned an event id", so it proved nothing the serialization
workload does not already prove. Demonstrating real writer contention requires a
second runtime competing for one authority, which the scenario adapter does not
expose and whose writer-ownership lease release is already documented as racy on
Windows inside a measured loop. Adding that seam solely for the benchmark is out
of bounds. A smaller truthful catalog is preferred to a larger misleading one.

## Optional controlled live samples

Run only with operator-supplied credentials and private external output.

- The hardened ASR/TTS benchmark creates a versioned artifact; import it via
  `--import-live`.
- A brain usage sample runs only if safe numeric SDK metadata exists (the
  installed `@google/genai@2.14.0` exposes `usageMetadata` on streamed chunks).
- Import artifacts into a deterministic benchmark report; do not merge their
  values into the deterministic contract digest.
- Keep prompt, transcript, audio, provider secrets, and private paths outside
  published artifacts.

## Threshold proposal and approval

A threshold document may be proposed separately and approved by an authorized
approver. The benchmark validates threshold provenance (dataset version, digest,
evaluator schema) before runtime start. An approved threshold that a measurement
breaches makes the run gate-invalid (exit 3).

A price document may be proposed and approved separately. Cost is calculated
only when the model/provider matches, the window is effective, and every
required dimension has a price; otherwise the result is absent with a reason.

## Evidence redaction and publication

Every artifact is scanned for prohibited content before publication. If the scan
finds a Discord snowflake, known fixture canary, absolute checkout path, run-root
path, secret-bearing environment value, prompt/transcript/generated-text field,
redaction key, or raw imported sample path, the run exits 4 and leaves no final
artifact set. Redact and rescan before publishing any artifact externally.

## Rerun triggers

Any of the following invalidates a candidate baseline:
- a source change;
- a test change;
- a dependency change;
- a workload-contract change (the contract digest changes);
- a host change;
- a relevant configuration change.

## Status boundaries

After a real full baseline, the narrow allowed claim is:

> IMP-803 deterministic performance baseline recorded for the named commit,
> workload contract, host, and configuration.

It must not say G8 passed, deployment approved, A8 requalified, live transport
qualified, acoustic barge-in qualified, or production SLO achieved.

Promotion documents that may change after a baseline: `docs/memory/CURRENT.md`
and `docs/memory/evidence/evidence-index.md`. These are modified only after a
real baseline is executed and recorded, never merely because the CLI exists.
