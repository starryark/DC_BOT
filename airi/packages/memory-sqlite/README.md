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
