# IMP-208 concurrency, backup, and compatibility evidence

Recorded 2026-08-02 on `6c19bb3b9862c870f93b7fdd6aa398d9241420c7` plus
the IMP-208 working diff. Synthetic temporary file-backed databases only; no
production database, Discord data, prompt, transcript, identity, or credential.

Environment: Windows `10.0.26200`; AMD Ryzen 5 3600; 12 logical processors;
51,459,162,112 bytes RAM; storage type not determinable from Node APIs; Node
24.14.0; SQLite 3.51.2; schema 7. Pragmas: foreign keys on, WAL,
`synchronous=FULL`, bounded 250 ms busy timeout.

Correctness passed with zero lost acknowledged writes, duplicates, partial
transactions, FK violations, or integrity failures. Separate connections wrote
different and same logical-room boundaries; uniqueness rejected collision. A
WAL reader saw a committed snapshot while a child held `BEGIN IMMEDIATE`. A
blocked writer exhausted the 100 ms test budget in the accepted 75–600 ms range,
returned typed `PERSISTENCE_FAILED`/`SQLITE_BUSY_EXHAUSTED`, and wrote nothing.
Queue contention produced one lease, safe expiry/reclaim, and stale-token fencing
even with a reused worker name.

Real child processes were force-killed before begin, after begin, after mutation
before commit, immediately after commit, after a WAL workload, and before a
checkpoint. Another child held a writer lock during bounded contention. Every
database reopened with valid integrity, foreign keys, and migration history;
the interrupted mutation was absent and the committed mutation existed once.
These are OS kills, not handled exceptions; power loss is not simulated.

Online backup, manifest publication, isolated restore, post-backup tombstone
replay, verification, and checkpoint passed. Queue and idempotency rows survived.
The restored canary was ineligible and had verified SQLite tombstone evidence
before publication. Full derived-store deletion remains IMP-702/IMP-703.

Compatibility passed empty-to-v7, exact v1–v6 to v7, and exact-v7 no-op. Existing
tests preserve representative historical rows. Checksum mismatch, future schema,
duplicate definitions, and unordered definitions fail closed. Rolling old-binary
compatibility is not claimed because runtime composition is disabled.

Benchmark: `pnpm -F @proj-airi/memory-sqlite benchmark:imp208`; seed 208; 2,000
FULL-synchronous transactions, 32 rooms, one serialized writer, read every ten
writes, WAL autocheckpoint disabled. Result: 356.33 ops/s; append p50 2.06 ms,
p95 3.02 ms, p99 3.08 ms; DB 978,944 bytes; WAL 18,305,192 bytes before and zero
after checkpoint; checkpoint 8.40 ms; backup 978,944 bytes/21.95 ms; restore
15.66 ms; integrity 4.35 ms. Zero busy outcomes occurred in this serialized run;
the correctness suite measured contention separately.

The 250 ms timeout is a provisional workstation recommendation, not a universal
SLO. Operations/evaluation approval needs a deployment-shaped soak. Repository
tests prove ADR-003's technical envelope, not the unpublished production
topology. OQ-BLOCK-003 remains open for actual one-process/local-storage evidence;
G2 production rollout is not approved by this report.

## Continuation validation at committed HEAD

Revalidated 2026-08-02 at committed HEAD
`2d0b260ad7ba32b60740a472a6e2ded9cfb1ff4f`. The operator handoff described the
fourteen IMP-208 files as uncommitted, but that exact fourteen-file change is the
HEAD commit and the initial working tree was clean. The SQLite typecheck, all 11
SQLite test files/88 tests, scoped lint, memory-domain typecheck and 10 files/206
tests, and Discord-bot typecheck and 33 files/365 tests passed again. Independent
SHA-256 recomputation produced
`339ad95d51c276186ac42487ea8e863c0b0721199c89a0b7661a4f4c10df2b80` for
migration 6 and
`2c6d9647b4d404f7eab1363ea8a97c0df536cf3837dd9accaa1933ce929f880d` for
migration 7.

A separate benchmark run with the same documented seed/workload observed 499.89
ops/s; append p50 1.955 ms, p95 2.105 ms, and p99 2.414 ms; 978,944-byte main
database; 18,305,192-byte WAL before and zero after checkpoint; checkpoint 6.353
ms; backup 18.493 ms; restore 10.360 ms; integrity check 3.791 ms. These are a
second workstation observation, not a replacement production threshold or
deployment-shaped soak.

No approved `IMP-209` exists in the authoritative backlog. IMP-301 is the next
listed coding task, but its precondition is passed G1 and G2 gates. Technical G2
validation is complete; formal G2 sign-off remains pending OQ-BLOCK-003. An
operator must provide an approved deployment record confirming one authoritative
bot process, a local non-network SQLite authority path, an approved operational
backup location, and a deployment-shaped workload/soak that accepts the measured
contention, checkpoint, backup, restore, latency, and throughput envelope.
