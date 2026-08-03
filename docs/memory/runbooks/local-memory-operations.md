# Local memory operations

Production and ordinary local use remain in `shadow` mode. These commands do not activate memory.

Run commands from `airi/services/discord-bot`. Use `--help` on any command to print the shared option reference. Inspection commands open SQLite read-only and print metadata only unless `memory:inspect -- --show-content` is explicitly supplied.

```powershell
pnpm memory:status -- --root C:\safe\memory-runtime
pnpm memory:inspect -- --root C:\safe\memory-runtime
pnpm memory:integrity -- --root C:\safe\memory-runtime
pnpm memory:verify-deletion -- --root C:\safe\memory-runtime
pnpm memory:smoke -- --root C:\safe\memory-runtime
```

Mutation commands acquire the same single-writer ownership guard as the bot. Stop the bot first; refusal while another writer owns the authority is expected and safe.

```powershell
pnpm memory:backup -- --root C:\safe\memory-runtime --destination C:\safe\memory-runtime\backups\memory-2026-08-03.sqlite
pnpm memory:restore -- --root C:\safe\memory-runtime --backup C:\safe\memory-runtime\backups\memory-2026-08-03.sqlite --destination C:\safe\memory-runtime\restore\candidate.sqlite
pnpm memory:reconcile-bindings -- --root C:\safe\memory-runtime --binding-file C:\safe\bindings.json --character kurisu
pnpm memory:reconcile-deliveries -- --root C:\safe\memory-runtime
```

Backup uses SQLite's online verified-backup API; never copy a live database file. Restore always publishes an isolated candidate and reapplies every deletion obligation captured from the current authority. It does not promote the candidate automatically. Unknown obligation types, corrupt snapshots, malformed manifests, existing destinations, relative paths, and destinations inside the live authority directory fail with exit code 1. Success exits 0 and prints JSON.
