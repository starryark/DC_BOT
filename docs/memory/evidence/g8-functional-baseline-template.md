# G8 functional baseline — evidence template

This template records a content-free G8-1 functional baseline run (IMP-802).
A dated copy is produced only after a clean full `active-v1` run from a clean
candidate commit; machine artifacts that contain diagnostic details stay outside
the repository even when their data is synthetic.

## Required fields

Copy these sections into the dated report and fill them from the validated
`summary.json`. Never paste a raw Discord identifier, canary token, fixture
payload, database path, or the redaction key into this document.

- **Run identity**
  - candidate commit (full 40-char SHA)
  - dataset version and dataset digest
  - evaluator schema version
  - seed
  - platform
  - normalized result digest
- **Whole-run result**
  - applicable pass rate (`applicablePassed/applicableTotal`)
  - zero-tolerance failures count (must be zero)
  - cleanup failures count (must be zero)
  - counts by outcome
  - counts by capability disposition
- **Capability classification**
  - unsupported categories (explicit, never passed by omission)
  - unverified categories (explicit, never passed by omission)
- **Thresholds**
  - measurement status (`measured_not_evaluated` unless an approved threshold
    document was supplied)
  - approval fields (thresholds approved, signed decision — both false unless a
    separate signed artifact exists)

## Required claims (exact wording)

A G8-1 baseline report must state, verbatim:

> G8 functional baseline established for the active profile at `<commit>` using
> dataset `<version>/<digest>` and seed `<seed>`. All applicable zero-tolerance
> assertions passed. Unsupported future capabilities and live transport checks
> remain explicit. G8 is not passed and no deployment approval is implied.

## Non-overclaim boundaries

The report must not:

- claim live Discord DM transport behavior;
- claim acoustic barge-in cancellation under the shipped configuration;
- re-qualify or re-state the A8 soak result;
- advertise vector, graph, remote, degraded, spool, summary, extraction,
  lexical, or semantic capabilities as operational;
- state or imply production SLOs, retrieval-quality thresholds, or deployment
  approval.

## Reproducibility

The run is reproducible from a clean checkout at the candidate commit using:

```bash
pnpm -F @proj-airi/discord-bot memory:evaluate -- \
  --suite active-v1 \
  --seed <seed> \
  --output <safe-external-output-directory>
```

Two runs of the same seed must produce the same normalized result digest; the
digest excludes absolute paths, wall-clock timestamps, elapsed-time noise,
process ids, and platform-specific separators.
