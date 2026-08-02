# memory-sqlite

Forward-only SQLite schema migrations for the shared-memory system. The package
is an inert persistence foundation: it does not open a production database,
implement `MemoryPort`, or enable any memory feature flag.

Call `migrate(database)` on an explicitly opened `node:sqlite` database. The
runner enables foreign-key enforcement, rejects unknown future versions and
checksum changes, and applies each migration in an exclusive transaction.

There are intentionally no down migrations. Recovery is by disabling durable
writes and restoring the verified pre-migration database snapshot, as required
by the approved migration plan.

IMP-202 adds inert `IdentityRepository` and `AliasRepository` APIs. Callers
provide an already-open, migrated `DatabaseSync`; the package still opens no
production database and is not composed into `MemoryPort` or Discord runtime.
Identity observations are atomic and snowflake-keyed, preserve idempotent
event-time snapshots, update partial current projections without erasing
unsupplied fields, throttle unchanged freshness writes to 24 hours, and update
platform-observed aliases only on material changes. Alias lookups require one
exact scope and return all colliding candidates (or an explicit ambiguous
outcome); they never merge or arbitrarily select people.

IMP-203 adds `RoomRepository`, `BindingRepository`, and
`PolicyDataRepository`. Rooms use exact Discord locator strings, preserve
identity across presentation renames, and carry explicit lifecycle state.
Unbound physical-room/character pairs resolve deterministically to singleton
logical rooms. Binding mutations are transactional and append versions;
optimistic expected-version checks reject stale writes, retirement immediately
restores singleton resolution, and revision evidence changes on narrowing or
room invalidation. Exact policy queries return only one requested room,
character, privacy domain, lifecycle, and revision projection; missing,
ambiguous, cross-guild, DM/guild, expired, or inaccessible state denies by
returning no evidence. Migration 3 is additive; migrations 1 and 2 are
unchanged. Runtime composition and feature flags remain untouched.

IMP-204 adds `EventRepository` and `CausalEdgeRepository` behind additive
migration 4 (`event_causality_repositories`). Event appends atomically allocate
the logical-room sequence, persist an immutable attributed envelope plus its
initial lifecycle evidence, explicitly distinguish exact idempotent retries
from conflicting key reuse, and read one exact physical/logical boundary in
`occurredAt`, then `eventId` order. Lifecycle changes append evidence; the
governed-redaction primitive removes payload content while retaining event and
causal identity. Causal edges retain `(generation, event, role)` cardinality,
require a trigger, and traverse deterministically in both directions. The
causal repository references fixture generation rows until IMP-205 implements
generation ownership. No runtime, delivery, deletion workflow, or flag is
enabled.

IMP-208 adds an explicit file-backed validation profile: foreign keys on, WAL,
`synchronous=FULL`, latest migration, and a finite 250 ms provisional busy
timeout. Exhaustion becomes a typed persistence failure; retries are never
infinite. The value is a local measurement recommendation, not a production SLO.

`createVerifiedBackup` uses the `node:sqlite` online backup API and atomically
publishes an integrity-checked snapshot plus schema/checksum manifest.
`restoreVerifiedBackup` restores only to an isolated path, requires tombstone
replay before publication, verifies again, and checkpoints WAL. See
`docs/memory/sqlite-backup-restore.md`. Never copy only a live WAL main file, use
a network filesystem, or add independent SQLite writer processes. PostgreSQL or
topology reconsideration is required when those constraints or approved measured
bounds fail. Runtime flags remain off; DB/Discord atomicity and exactly-once
Discord delivery are not claimed.

IMP-205 adds `GenerationRepository`, `OutputRepository`, and
`DeliveryRepository` behind additive migration 5
(`generation_output_delivery_repositories`). Generations retain exact ordered
snapshot evidence and validated append-only lifecycle history; room-version
advancement is never used as a generation commit CAS. Output segments are
immutable, generation-owned, and ordinally ordered. Delivery attempts retain
stable retry identity, distinct physical attempt numbers, append-only evidence,
receipt-backed text outcomes, local voice-playback ranges, and unresolved crash
states. `DeliveryRepository.eligible` applies exact room/character scope in SQL
and delegates nuanced admission and prefix projection to the domain policy.
The strict default excludes voice, partial, unknown, failed, and never-attempted
output. No reconciler, transport, runtime composition, or rollout flag is added.

IMP-206 adds `SummaryRepository`, `MemoryRepository`, and
`CorrectionRepository` behind additive migration 6
(`layered_memory_provenance_repositories`). Domain-shaped tables keep summaries,
semantic facts, episodes, and operator procedures separate while legacy v1
memory rows remain intact. Writes validate durable provenance, confidence,
temporal intervals, fact content, and procedure authorship before transactional
base-plus-lineage persistence. Facts support half-open as-of reads, current reads,
atomic append-only corrections, exact retry deduplication, and deterministic
chain reconstruction. No retrieval ranking, worker, deletion executor, runtime
composition, or rollout flag is added.

IMP-207 exports `UnitOfWork`, canonical JSON/hash helpers,
`executeIdempotently`, and `ReconciliationQueue`. `UnitOfWork` uses a short
`BEGIN IMMEDIATE` database-only boundary, rejects nesting, preserves the
original operation error after a successful rollback, and reports rollback
failure. Callers must perform Discord, model, network, and filesystem work only
after the transaction returns; SQLite is never claimed atomic with those
systems. Successful idempotent operations store only a canonical request hash
and stable JSON result; conflicting key reuse is rejected without replacement.

The durable queue orders claim candidates by priority descending,
`available_at`, then `job_id`. Claims atomically increment attempts and receive
a unique lease token, so expired claims can be reclaimed while every stale
success/retry/cancel/dead-letter transition is fenced—even when a worker name is
reused. Retry uses injected full jitter with exponential growth capped by the
caller, clears lease fields, and dead-letters at maximum attempts. Diagnostics
are classification-only inputs, normalized to one line, and capped at 512
characters. Reconciliation observations and decisions are append-only and
retain policy version plus non-private process/operator identity. Migration 7
is additive; legacy queue rows remain inspectable but require an exact retry or
policy-controlled reconstruction before hash-based deduplication. No worker
loop, Discord call, WAL/busy-timeout rollout, runtime composition, or flag is
enabled.
