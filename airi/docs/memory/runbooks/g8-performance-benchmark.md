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
(run-manifest, measurements JSONL, summary, report) with a deterministic
contract digest and environment-bound timings.

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
   git status --short   # must print nothing for performance-v1
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
  --suite performance-v1 \
  --seed 20260802 \
  --output "$OUT"
```

The full suite requires:
- explicit `--output` outside the checkout;
- a known git HEAD (not `unknown`);
- a clean worktree;
- a non-empty output directory rejected unless it is a prior run.

### Repetition

Repeat with three fixed seeds or three repeated runs of the same declared
seed/config:

```bash
for seed in 20260802 20260803 20260804; do
  OUT="$(mktemp -d -t dc-bot-imp803-${seed}-XXXXXX)"
  pnpm -F @proj-airi/discord-bot memory:benchmark -- \
    --suite performance-v1 \
    --seed "$seed" \
    --output "$OUT"
done
```

## Before treating the result as evidence

1. **Hash every artifact.** Record the SHA-256 of `run-manifest.json`,
   `measurements.jsonl`, `summary.json`, and `report.md`.

2. **Independently recompute summary statistics.** The `measurements.jsonl`
   must be sufficient to reproduce `summary.json`; the report builder has a
   recomputation test. Run it against the JSONL and confirm the metric counts
   match.

3. **Confirm the contract digest is identical between matched runs.** The
   `contractDigest` field must be the same 64-char hex for every run of the
   same workload catalog; timings are allowed to differ.

4. **Confirm no approved threshold or cost claim appears without matching
   documents.** Cost is absent without an approved, matching price document.

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
