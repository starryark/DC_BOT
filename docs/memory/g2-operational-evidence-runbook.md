# G2 operational evidence runbook

**Status:** live operational document.

How to collect the deployment evidence `OQ-BLOCK-003` requires, using the
test-only soak harness in `@proj-airi/memory-sqlite`, and how to turn it into a
signed G2 acceptance record.

Read this before running anything:

- The harness writes a **new synthetic database it creates itself**. It never
  opens an existing database, never enables a memory feature flag, and never
  changes Discord behaviour. All workload data is generated; it contains no
  tokens, no user content, no guild identifiers, and no personal data.
- A completed run does **not** pass G2. `summary.json` always reports
  `g2AutomaticallyPassed: false`. Approval is
  `docs/memory/evidence/g2-operational-acceptance-template.md`, signed.
- The harness refuses unsafe paths and has **no override flag**. If it refuses,
  the path is wrong — pick another one.

## 1. Preconditions

1. `IMP-201`–`IMP-208` are complete and their tests pass on the revision you are
   about to run:
   ```bash
   pnpm -F @proj-airi/memory-sqlite typecheck
   pnpm -F @proj-airi/memory-sqlite test
   ```
2. You are on the intended **deployment host**, using the intended **storage
   volume**. A workstation run measures the workstation, not the deployment.
3. Node 22+ with `node:sqlite` available (the repository is validated on Node
   24.x), and `pnpm` installed.
4. Record the revision under test, and confirm the tree is clean:
   ```bash
   git rev-parse HEAD
   git status --short
   ```
   A dirty tree is allowed but is recorded in the report as a limitation.
5. Enough free space for roughly `duration × write rate × 3 KB`, plus WAL, plus
   one full-size backup per backup interval. A long soak can produce many
   gigabytes of backups — plan the evidence volume accordingly.
6. No runtime memory flag is enabled anywhere. The soak is independent of the
   bot process and must not be run to "warm up" a production database.

## 2. Choose the synthetic database directory

`G2_DATABASE_DIRECTORY` is where the run-scoped authority database is created.

- It must be on the **volume the deployment will use**, so the measurements mean
  something.
- It must be **empty on first use**. The harness writes
  `g2-synthetic-directory.json` into it and will reuse it later; it refuses any
  non-empty directory without that marker, and refuses outright if it finds a
  file that looks like a database.
- It must not be the operating-system temporary directory (or inside it), a UNC
  path, a filesystem root, or anywhere inside the repository checkout.
- It must never be the directory you intend to use for the real authority
  database.

```powershell
New-Item -ItemType Directory -Force D:\dc-bot-g2\authority | Out-Null
```

Each run creates its own file, `<run-id>.db`, so runs never share a database.

## 3. Choose separate output and backup staging directories

`G2_OUTPUT_DIRECTORY` holds evidence: manifests, metrics, event log, staged
backups, restored candidates, and the report. It must be a **different**
directory from the database directory, and neither may contain the other.

```powershell
New-Item -ItemType Directory -Force D:\dc-bot-g2\evidence | Out-Null
```

Backups are staged under `<output>/<run-id>/backups/` and restores under
`<output>/<run-id>/restore/`, both outside the authority directory. Copying a
verified backup to the real operational destination is a separate operator step
(§12) — the harness never does it and never pretends it happened.

## 4. Capture process topology evidence

Do this on the deployment host **while the bot is running normally**, before or
after the soak. These commands are evidence helpers, not proof: they show what
was true at the moment they ran, on the accounts they can see. A process running
as another user, or started after you looked, will not appear.

```powershell
# Everything currently running Node, with its command line and owner.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Select-Object ProcessId, ParentProcessId, CommandLine,
    @{n='Owner';e={ $_ | Invoke-CimMethod -MethodName GetOwner | ForEach-Object { "$($_.Domain)\$($_.User)" } }} |
  Format-List

# Anything holding the authority database open (run elevated; handle.exe from
# Sysinternals, or Resource Monitor's Associated Handles view).
handle.exe -nobanner -a "authority.db"

# Services that might touch the data volume.
Get-Service | Where-Object { $_.Status -eq 'Running' } | Select-Object Name, DisplayName
```

Portable equivalents:

```bash
ps -eo pid,ppid,user,args | grep -i node
lsof /path/to/authority.db     # Linux/macOS
```

Save the output. §2 of the acceptance template asks for exactly this.

## 5. Capture storage-locality evidence

Also evidence helpers, not proof. A SAN LUN presents as a local disk; a
synchronised folder looks like an ordinary directory. Interpret the output, then
attest.

```powershell
# Drive type: 3 = local fixed disk, 4 = network drive.
fsutil fsinfo drivetype D:

# Volume, filesystem, and health.
Get-Volume -DriveLetter D | Format-List

# Is the drive letter actually a mapped network drive?
Get-PSDrive -PSProvider FileSystem | Select-Object Name, Root, DisplayRoot
Get-SmbMapping

# Bus type: NVMe/SATA/SAS/iSCSI/Fibre Channel. iSCSI and FC are not local disks.
Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, BusType, MediaType

# Permissions on the directory the bot will use.
Get-Acl D:\dc-bot\memory | Format-List

# Confirm the path is not inside a sync root.
Get-ChildItem Env:OneDrive*
```

Portable equivalents:

```bash
df -T /path/to/directory
findmnt -T /path/to/directory
ls -la /path/to/directory
```

Check by hand that the path is not inside OneDrive, Dropbox, Google Drive, a
backup agent's live-sync folder, or a container bind mount backed by a share.

The harness records storage locality as `unknown` unless you attest to it:

```powershell
$env:G2_STORAGE_ATTESTATION = "D: is a local NVMe fixed disk (BusType NVMe, drivetype 3), not a mapped drive or sync folder. Attested by <name>, <date>."
```

That string is copied verbatim into the report as an attestation. It is never
treated as automated verification.

## 6. Run a short validation soak

Prove the harness works on this host before committing to a long run.

```powershell
$env:G2_DATABASE_DIRECTORY            = "D:\dc-bot-g2\authority"
$env:G2_OUTPUT_DIRECTORY              = "D:\dc-bot-g2\evidence"
$env:G2_DURATION_SECONDS              = "60"
$env:G2_LOGICAL_ROOMS                 = "8"
$env:G2_TEXT_WRITE_RATE               = "8"
$env:G2_VOICE_WRITE_RATE              = "4"
$env:G2_READER_CONCURRENCY            = "2"
$env:G2_QUEUE_CLAIMERS                = "2"
$env:G2_CHECKPOINT_INTERVAL_SECONDS   = "10"
$env:G2_BACKUP_INTERVAL_SECONDS       = "20"
$env:G2_RESTART_INTERVAL_SECONDS      = "30"
$env:G2_CONTENTION_PROBE_INTERVAL_SECONDS = "20"

pnpm -F @proj-airi/memory-sqlite benchmark:g2
```

Bash:

```bash
G2_DATABASE_DIRECTORY=/srv/dc-bot-g2/authority \
G2_OUTPUT_DIRECTORY=/srv/dc-bot-g2/evidence \
G2_DURATION_SECONDS=60 \
pnpm -F @proj-airi/memory-sqlite benchmark:g2
```

Expect `status completed`, `Valid for operator review: true`, and zero
correctness counters. If the run reports `invalid`, read
`summary.json → limitations` and the failure fields before changing anything.

### Configuration reference

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `G2_DATABASE_DIRECTORY` | yes | — | Directory for the run-scoped synthetic authority database. |
| `G2_OUTPUT_DIRECTORY` | yes | — | Directory for evidence; must be separate from the above. |
| `G2_DURATION_SECONDS` | no | 300 | Workload duration, 5 s – 30 days. |
| `G2_SEED` | no | 20260802 | Deterministic workload seed. |
| `G2_LOGICAL_ROOMS` | no | 24 | Synthetic logical rooms, alternating text and voice channels. |
| `G2_TEXT_WRITE_RATE` | no | 4 | Text ingress appends per second. |
| `G2_VOICE_WRITE_RATE` | no | 2 | Voice ingress appends per second. |
| `G2_READER_CONCURRENCY` | no | 3 | Read-only connections. |
| `G2_QUEUE_CLAIMERS` | no | 2 | Logical reconciliation claimers inside the single process. |
| `G2_CHECKPOINT_INTERVAL_SECONDS` | no | 60 | WAL checkpoint interval; must not exceed the duration. |
| `G2_BACKUP_INTERVAL_SECONDS` | no | 120 | Online backup interval; must not exceed the duration. |
| `G2_RESTART_INTERVAL_SECONDS` | no | 600 | Connection-reopen interval; may exceed the duration (then not exercised). |
| `G2_CONTENTION_PROBE_INTERVAL_SECONDS` | no | 120 | Bounded lock-contention probe interval. |
| `G2_BUSY_TIMEOUT_MS` | no | 250 | Busy timeout, 1–60000 ms. 250 ms is the IMP-208 provisional workstation value, not an approved SLO. |
| `G2_LATENCY_SAMPLE_CAPACITY` | no | 200000 | Retained latency samples per category before reservoir sampling. |
| `G2_THRESHOLDS_FILE` | no | — | Operator threshold document; without it every metric is `measured-not-evaluated`. |
| `G2_STORAGE_ATTESTATION` | no | — | Free-text operator attestation about storage locality. |
| `G2_SECOND_WRITER_PROBE` | no | — | Exactly `enabled` to arm the second-writer probe. |

Invalid values are startup errors. The harness never silently lowers a setting.

## 7. Run the long deployment-shaped soak

Set the workload from expected **peak** Discord traffic, not average, and run
long enough to cross several checkpoint, backup, and reopen cycles. Artifact 16
§10.2 asks for at least two continuous weeks of representative data before
proposing SLOs; a single multi-hour soak is evidence about the storage envelope,
not a substitute for that baseline.

```powershell
$env:G2_DURATION_SECONDS              = "28800"   # 8 hours
$env:G2_LOGICAL_ROOMS                 = "32"
$env:G2_TEXT_WRITE_RATE               = "12"
$env:G2_VOICE_WRITE_RATE              = "6"
$env:G2_READER_CONCURRENCY            = "4"
$env:G2_QUEUE_CLAIMERS                = "3"
$env:G2_CHECKPOINT_INTERVAL_SECONDS   = "300"
$env:G2_BACKUP_INTERVAL_SECONDS       = "3600"
$env:G2_RESTART_INTERVAL_SECONDS      = "7200"
$env:G2_CONTENTION_PROBE_INTERVAL_SECONDS = "1800"
$env:G2_SECOND_WRITER_PROBE           = "enabled"

pnpm -F @proj-airi/memory-sqlite benchmark:g2
```

Run it when the host is otherwise in its normal state. Note anything else that
was running; a soak on a busy host measures a busy host.

Arming `G2_SECOND_WRITER_PROBE` runs one short child process after the workload
that tries to acquire the same guarded authority API against the **synthetic**
database. The expected result is `expected-ownership-refusal`, with a typed
`SQLITE_WRITER_OWNERSHIP_UNAVAILABLE` classification, the configured timeout,
observed latency, and confirmation that the first owner remained operational.
`unexpectedly-succeeded` is adverse evidence. `probe-infrastructure-failure`
means the probe is inconclusive, not passed. Focused package tests additionally
force-terminate an owning process and prove reacquisition without deleting the
lease database; attach those test results as crash-recovery evidence.

## 8. Monitor the run

```powershell
Get-Content -Wait "D:\dc-bot-g2\evidence\<run-id>\events.jsonl" | Select-String '"type":"progress"'
Get-ChildItem "D:\dc-bot-g2\authority" | Select-Object Name, Length
```

`progress` records appear every five seconds with acknowledged writes, failed
writes, reads, queue claims, and maximum WAL size. `checkpoint`, `backup`,
`restart`, `contention.probe`, and `restore` records appear as those phases run.

## 9. Handle interruption

Press `Ctrl+C`, or send `SIGTERM`/`SIGBREAK`. The harness stops the workload,
closes connections, and still writes `metrics.json`, `summary.json`, and the
report with `status: interrupted` and `validForOperatorReview: false`. The exit
code is 130.

An interrupted run is real evidence about everything up to the interruption, but
it is **not** a completed soak. Do not submit one as the acceptance evidence
without saying so.

If the process is killed outright, the run directory keeps whatever was flushed;
`events.jsonl` is written as the run proceeds. Such a directory has no
`summary.json` and must be labelled incomplete by hand.

## 10. Locate the output

```text
<G2_OUTPUT_DIRECTORY>/<run-id>/
  run-manifest.json     run id, purpose, syntheticDataOnly, paths
  configuration.json    resolved configuration and requested-vs-effective values
  environment.json      host, Node, SQLite, revision, PRAGMA evidence
  events.jsonl          streamed run events
  metrics.json          counters, latency distributions, phase records
  summary.json          the stable machine-readable summary
  g2-soak-report.md     the human-readable report
  backups/              staged verified backups plus manifests
  restore/              the restored candidate from the drill
  logs/
```

`backups/` may also contain `*.partial-*-wal` / `*.partial-*-shm` sidecars left
by the verification connection. The published artifacts are `backup-NNNN.db` and
`backup-NNNN.db.manifest.json`; the sidecars are inert leftovers and can be
deleted.

Read `g2-soak-report.md` first, then `summary.json → limitations`.

## 11. Perform or verify the restore drill

Every completed run performs one drill automatically: it restores the newest
verified backup to `restore/`, replays a synthetic deletion obligation into the
candidate before publication, verifies integrity, foreign keys, schema version,
migration checksums, and record counts against the backup window, checkpoints
the candidate, and records achieved RPO and RTO. The authority database is never
overwritten.

Confirm in the report that:

- `Restore valid` is `yes`.
- Record counts land inside the backup window.
- Deletion-obligation replay is `applied`.
- Achieved RPO and RTO are acceptable against §6 of the acceptance template —
  and note that the harness's RPO is measured against a backup taken minutes
  earlier in a test, not against your real backup schedule. Compute the real
  RPO from the operational schedule.

To drill by hand against a staged backup, follow
`docs/memory/sqlite-backup-restore.md`: `restoreVerifiedBackup` to a **new**
isolated path, then inspect. Never restore over the authority.

## 12. Copy verified backups to the operational destination

The harness stages backups locally and stops there. Copying to the real
destination is an operator action:

1. Copy `backup-NNNN.db` **and** `backup-NNNN.db.manifest.json` together — a
   backup without its manifest is rejected on restore.
2. Use the approved encrypted transport and destination.
3. Verify the copy (size and checksum) at the destination.
4. Record the command, timestamp, operator, and destination in §4 of the
   acceptance template. Do not record an off-host copy that did not happen.

## 13. Complete the acceptance record

Copy `docs/memory/evidence/g2-operational-acceptance-template.md` to
`docs/memory/evidence/g2-operational-acceptance-<YYYY-MM-DD>.md` and fill it in
from the report, the topology evidence (§4), and the storage evidence (§5).

Once the envelope in §6 of that record is approved, write it as a threshold
document and re-run the soak with it so results are evaluated rather than only
measured:

```json
{
  "format": 1,
  "approvedBy": "REPLACE WITH THE APPROVING OPERATIONS LEAD",
  "approvedAt": "REPLACE WITH AN ISO TIMESTAMP",
  "source": "REPLACE WITH THE RUN IDS AND JUSTIFICATION THESE NUMBERS CAME FROM",
  "thresholds": [
    { "metric": "append.p95Ms", "comparison": "atMost", "value": 0, "unit": "ms" },
    { "metric": "append.p99Ms", "comparison": "atMost", "value": 0, "unit": "ms" },
    { "metric": "throughput.operationsPerSecond", "comparison": "atLeast", "value": 0, "unit": "ops/s" },
    { "metric": "checkpoint.p95Ms", "comparison": "atMost", "value": 0, "unit": "ms" },
    { "metric": "wal.maximumBytes", "comparison": "atMost", "value": 0, "unit": "bytes" },
    { "metric": "contention.busyRetryExhaustion", "comparison": "atMost", "value": 0, "unit": "count" },
    { "metric": "recovery.achievedRtoMs", "comparison": "atMost", "value": 0, "unit": "ms" }
  ]
}
```

The zeros are placeholders, not recommendations. This repository holds no
approved numbers: artifact 16 §10.1 states its latency table is a set of test
hypotheses, and the IMP-208 workstation benchmark is explicitly not an SLO. The
harness rejects a threshold document that does not name its approver, and
reports any metric it cannot find as `metric-unavailable` rather than passed.

Available metric keys: `append.p50Ms`, `append.p95Ms`, `append.p99Ms`,
`appendVoice.p95Ms`, `appendVoice.p99Ms`, `read.p95Ms`, `queueClaim.p95Ms`,
`checkpoint.p95Ms`, `checkpoint.p99Ms`, `backup.p95Ms`, `restore.maxMs`,
`throughput.operationsPerSecond`, `contention.busyRetryExhaustion`,
`contention.maximumWriterQueueDepth`, `wal.maximumBytes`, `wal.finalBytes`,
`storage.databaseBytes`, `correctness.failedWrites`,
`correctness.acknowledgedWritesMissingAfterReopen`,
`correctness.duplicateEffects`, `recovery.achievedRpoMs`,
`recovery.achievedRtoMs`.

## 14. Required reviewers

From `artifacts/21-implementation-backlog.md` (IMP-208): **persistence lead,
operations lead, evaluation lead** must sign. For anything beyond G2 coding
continuation, artifact 16 §10.2 additionally names the text owner, voice owner,
memory/data owner, product owner, and privacy/security owner.

Reviewers should check that:

- The run used the deployment host and volume, not a workstation.
- The workload is justified against expected peak traffic.
- Storage locality and the process inventory are attested with attached output.
- The operational backup destination is real, owned, encrypted, and retained.
- Every limitation in `summary.json` is either accepted or remediated.
- The approved envelope has a stated basis, not a copied hypothesis.

## 15. Update implementation status after approval

Only after the acceptance record is signed:

1. Update the G2 row in `docs/memory/implementation-status.md` §9 with the
   decision, the record filename, and the date.
2. Update `docs/memory/continuation-blocker-report.md`.
3. Record `OQ-BLOCK-003` as resolved, with a link to the signed record.
4. State the approved scope, so it is clear whether `IMP-301` is unblocked for
   coding only or for more.

Until then: deployment evidence item `OQ-EVIDENCE-003` is open, operational G2
is unapproved, and IMP-301B plus every persistence activation remains blocked.
The separate coding-only scope permits runtime-inert IMP-301A.

## 16. What must remain disabled before R2 approval

- Every runtime memory feature flag in `airi/services/discord-bot/src/config.ts`
  stays `false`. The soak does not enable any of them.
- No production or developer database is opened by the harness, and none may be
  pointed at by `G2_DATABASE_DIRECTORY`.
- No shadow writes, no production writes, no vector or graph storage, no remote
  memory service.
- No new Discord gateway intent. `OQ-BLOCK-004` / `FIND-010` is a separate
  blocker that this record does not resolve, and `IMP-305` stays blocked.
- Only one write-capable process at a time. The authoritative public opener
  enforces a SQLite/VFS ownership lease; deployment inventory must still prove
  that the real bot runtime uses that authority.
