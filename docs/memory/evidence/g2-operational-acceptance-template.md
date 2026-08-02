# G2 operational acceptance record (template)

**Status of this file:** live editable template. Copy it to
`docs/memory/evidence/g2-operational-acceptance-<YYYY-MM-DD>.md` and complete
the copy. Do not fill in this template itself.

This record is the evidence artifact `OQ-BLOCK-003` requires: it is where an
authorized operations owner accepts or rejects SQLite as the milestone-one
default, and where the G2 reviewer records the gate decision. It is completed by
people, not by a tool.

> A completed soak run does not approve anything. `summary.json` always carries
> `g2AutomaticallyPassed: false` and `productionApprovalImplied: false`. This
> document, signed, is the approval.

Leave a field blank only when you also record why in the adjacent comments.
Write `not verified` rather than a guess; an unverified field that reads as
verified is worse than an empty one.

---

## 1. Repository and deployment identity

| Field | Value |
|---|---|
| Repository revision (`git rev-parse HEAD`) | |
| Working tree clean at run time (`git status --porcelain` empty) | |
| Host name | |
| Operating system and version | |
| CPU / logical processors / RAM | |
| Node version | |
| SQLite library version | |
| `@proj-airi/memory-sqlite` version | |
| Deployment mode (single host embedded bot process / other — describe) | |
| Evidence run IDs included in this record | |
| Evidence output location (and where it is archived) | |
| Person completing this record | |
| Date completed | |

## 2. Authoritative writer topology

ADR-003 decision 4 permits exactly one application process to own writes;
REQ-OPS-012 requires writes to be serialized inside it and REQ-OPS-013 requires
a second process to fail startup or stay explicitly read-only.

| Question | Answer | Evidence attached |
|---|---|---|
| How many operating-system processes hold write-capable connections to the authority database? | | |
| Which process is it (image name, PID at inspection, service/user account)? | | |
| What starts and supervises the bot process (Task Scheduler, NSSM, manual `start-bot.ps1`, other)? | | |
| Can the ASR service reach the database file? With what permissions? | | |
| Can the TTS service reach the database file? With what permissions? | | |
| Do any workers, cron jobs, scripts, or backup agents open the database? | | |
| Can any external client (AIRI, tooling, analytics) reach the database? | | |
| What happens today if a second bot instance is started? | | |
| Is that behaviour enforced by code, or is it an operating rule? | | |
| Writer-ownership guard package version / guard version | | |
| Configured acquisition timeout and observed refusal latency | | |
| Typed refusal classification | | |
| First owner remained operational after the competing probe | | |
| Clean release and reacquisition result | | |
| Forced-termination crash recovery and reacquisition result | | |
| Connections intentionally outside the guard, and why | | |

**Technical guard evidence:** the package now provides a process-level
SQLite/VFS ownership guard for the authoritative writer. Record
`expected-ownership-refusal` only when the typed bounded probe succeeded.
`unexpectedly-succeeded`, `not-tested`, and `probe-infrastructure-failure` do
not satisfy this row. This technical result does not replace the deployment
process inventory, topology attestation, or formal G2 approval. Record remaining
risk or remediation:

```
```

**Evidence attachments (list file names):**

```
```

## 3. Storage locality

REQ-OPS-011 requires the database, `-wal`, and `-shm` files to live on a local
filesystem on the bot host; network shares and synchronized cloud folders are
unsupported. No automated check in this repository can prove this — every row
below is an operator attestation backed by attached command output.

| Field | Value | Evidence attached |
|---|---|---|
| Absolute authority database path (planned production path) | | |
| Volume / drive and filesystem type | | |
| Attested as a physically local drive (not iSCSI/SAN presented as local — state which) | | |
| Confirmed **not** a mapped network drive or UNC path | | |
| Confirmed **not** inside OneDrive/Dropbox/Google Drive or any sync root | | |
| Confirmed **not** inside a backup agent's live-sync folder | | |
| Filesystem permissions / ACLs on the directory and files | | |
| `-wal` and `-shm` confirmed co-located with the main database | | |
| Free space and growth headroom | | |
| Encryption-at-rest mechanism for the volume (ADR-003 `OPEN-BLOCK-003`) | | |

**Evidence attachments:**

```
```

## 4. Backup operation

REQ-OPS-030 requires a SQLite-documented snapshot mechanism; REQ-OPS-031
requires backups to be encrypted or inside an approved encrypted boundary, to
carry schema metadata, and to be covered by retention and deletion policy.

| Field | Value |
|---|---|
| Local staging location for verified backups | |
| Real operational destination (host, bucket, share, media) | |
| Destination owner / administrator | |
| Is the destination off-host? | |
| Encryption in transit | |
| Encryption at rest, and who holds the keys | |
| Access control on the destination | |
| Retention period | |
| How backups are covered by the deletion/forget policy (artifact 14) | |
| Schedule and trigger (who or what runs it) | |
| Monitoring / alert on backup failure or staleness | |
| Target RPO | |
| Target RTO | |
| Restore-test frequency | |
| Date and run ID of the latest successful restore drill | |
| Who performed that drill | |

**The soak stages backups locally and never copies them off-host.** The command
or integration that performs the real copy, and evidence that it ran:

```
```

**Evidence attachments:**

```
```

## 5. Soak evidence

| Field | Value |
|---|---|
| Run IDs | |
| Duration of each run | |
| Workload shape (rooms, text rate, voice rate, readers, claimers, seed) | |
| Expected peak production workload, and how it was estimated | |
| Measured throughput (operations per second) | |
| Justification that the measured workload covers expected peak | |
| Correctness outcome (lost/duplicate/partial/integrity/FK/checksum counters) | |
| Append latency p50 / p95 / p99 (text) | |
| Append latency p50 / p95 / p99 (voice) | |
| Read latency p95 | |
| Queue-claim latency p95 | |
| Busy/locked outcomes, retries, exhaustion, maximum single wait | |
| Maximum writer queue depth | |
| Database size at end of run | |
| Maximum and final WAL size | |
| Checkpoint count, failures, p95 / p99 duration | |
| Backup count, size, duration, verification results | |
| Restore drill result, achieved RPO, achieved RTO | |
| Restart/recovery result and which kinds were exercised | |
| SQLite PRAGMA verification result | |

### 5.1 Known blind spots in the soak evidence

Copy the `limitations` array from `summary.json` and add anything the reviewers
identify. Do not delete entries that are still true.

```
```

State explicitly which of the following this evidence does **not** cover:

- [ ] Physical storage locality (attested in §3, not measured).
- [ ] Absence of other writers outside the observed process inventory.
- [ ] Off-host backup completion.
- [ ] Real Discord workload equivalence.
- [ ] Operating-system process-crash durability, if only connection reopen was exercised.
- [ ] Power-loss and storage-controller failure.
- [ ] Multi-week representative distribution required by artifact 16 §10.2.

## 6. Approved operating envelope

These are the numbers the deployment is accepted against. They are **not**
supplied by this repository: artifact 16 §10.1 states its latency table is a set
of test hypotheses that must not be encoded as gates until approved. Fill each
row from the measured distributions plus a stated user-need justification.

| Parameter | Approved value | Basis / justification |
|---|---|---|
| Maximum expected write rate (events/second) | | |
| Minimum accepted throughput (operations/second) | | |
| Append p95 | | |
| Append p99 | | |
| Busy/locked exhaustion budget (per hour and per day) | | |
| Maximum WAL size before alert | | |
| Checkpoint p95 | | |
| Checkpoint p99 | | |
| Backup objective (frequency, maximum duration, maximum age) | | |
| Approved RPO | | |
| Approved RTO | | |
| Maximum logical-room concurrency | | |
| Maximum database size before review | | |
| Review or migration triggers (link to ADR-003 §10.7 `TRIGGER-DB-*`) | | |
| Review cadence and next review date | | |

Once approved, record these values in a threshold document and re-run the soak
with `G2_THRESHOLDS_FILE` set, so future runs are evaluated rather than merely
measured. The threshold document must name its approver; the harness rejects
one that does not.

## 7. Approval scope

Select exactly one. Approving a broader scope than the evidence supports is a
gate failure in itself.

- [ ] **G2 coding continuation only** — unblocks `IMP-301` and later persistence-dependent coding tasks. No runtime memory flag is enabled and no production data is written.
- [ ] **R2 shadow-write preparation** — additionally permits preparing shadow writes under the rollout plan. Requires the writer topology and storage sections to be fully verified.
- [ ] **Production write rollout** — requires everything above plus the operational backup destination, approved envelope, and the privacy/deletion prerequisites.
- [ ] **Not approved** — record required remediation below.

Scope rationale:

```
```

## 8. Sign-off

Required signatories (artifact 21, IMP-208 required reviewers):

| Role | Name | Decision (approve / reject / abstain) | Date | Comments |
|---|---|---|---|---|
| Persistence lead | | | | |
| Operations lead | | | | |
| Evaluation lead | | | | |

Recommended additional signatories (required for anything beyond G2 coding
continuation; artifact 16 §10.2 names these owners for SLO approval):

| Role | Name | Decision | Date | Comments |
|---|---|---|---|---|
| Text pipeline owner | | | | |
| Voice pipeline owner | | | | |
| Memory / data owner | | | | |
| Product owner | | | | |
| Privacy / security owner | | | | |

## 9. Formal decision

| Field | Value |
|---|---|
| Decision (**GO** / **NO-GO** / **CONDITIONAL GO**) | |
| Decision date | |
| Decision recorded by | |
| Conditions (required if CONDITIONAL GO), each with an owner and a due date | |
| Rationale (required for every decision) | |
| `OQ-BLOCK-003` disposition (open / resolved) | |
| G2 gate status after this decision | |
| Follow-up actions and owners | |

Rationale:

```
```

## 10. After approval

Only when the decision above is GO or CONDITIONAL GO and its conditions are
recorded:

1. Update the G2 row in `docs/memory/implementation-status.md` §9 with the
   decision, this record's filename, and the date.
2. Update `docs/memory/continuation-blocker-report.md` to reflect the resolved
   or conditioned blocker.
3. Note that `IMP-301` is unblocked for the approved scope.
4. Record the approved envelope as a threshold document for future runs.

`OQ-BLOCK-004` / `FIND-010` is a separate blocker and is **not** resolved by
this record. `IMP-305` and any behaviour depending on guild member freshness
remain blocked, and no new Discord gateway intent is approved here.
