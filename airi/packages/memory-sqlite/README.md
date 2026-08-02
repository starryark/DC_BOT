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
