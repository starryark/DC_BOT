# SQLite backup and restore procedure

This procedure applies only to the canonical ADR-001 topology and A21-ADR-003
SQLite profile: one authoritative DC_BOT
process, a local non-network filesystem, WAL, foreign keys on every connection,
`synchronous=FULL`, and short serialized writes. Runtime memory flags remain off.

## Backup

The database owner supplies explicit source and destination paths to
`createVerifiedBackup`. The destination must differ from the authority. The
utility uses Node's SQLite online backup API; it never copies only the live main
file. It writes a uniquely named `.partial-*` database, runs `integrity_check`,
`foreign_key_check`, and exact migration-history/checksum verification, writes a
schema/checksum/size manifest, and atomically renames both artifacts. Partial
files are rejected as backups and removed after failure.

## Restore

Disable durable writes. Call `restoreVerifiedBackup` with a verified backup and
a new isolated destination; never restore over the authority. It copies to a
partial path, verifies, invokes mandatory deletion-obligation replay, verifies
again, checkpoints WAL, and only then publishes the isolated candidate. An
operator must inspect it and transfer authority; this package does not do so.

IMP-208 proves primary SQLite canary ineligibility plus existing
`forget_requests`/`deletion_tombstones`. Full derived-store deletion closure
remains IMP-702/IMP-703. On failure retain the old authority, reject the
candidate, surface a persistence failure, and never fall back to ephemeral
history. There are no down migrations.

Never use a network filesystem or independently managed SQLite writer processes.
Do not deploy hard links to the authority database, and exclude
`.dc-bot-writer-*.lease.sqlite*` sidecars from database discovery, backup,
restore replacement, and cleanup globs.
Move to PostgreSQL/reconsider topology if either appears, bounded busy failures
exceed an approved budget, or checkpoint, backup, latency, or throughput fails
an approved operational SLO.
