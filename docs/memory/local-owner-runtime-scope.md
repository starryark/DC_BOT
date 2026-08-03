# Local owner runtime scope

The repository owner authorizes private local implementation and activation of
milestone-one shared memory. Formal reviewer or governance sign-off is not
present; that risk is accepted by the owner and is not a technical gate pass.

## Selected local layout

- Authority: `<repo>/.local/memory/authority/memory.sqlite`
- Backups: `<repo>/.local/memory/backups/`
- Spool: `<repo>/.local/memory/spool/`
- Reports, exports, logs, and bindings: sibling paths under `.local/memory/`
- An operator may instead select one explicit absolute runtime root.

One Discord-bot process is the sole write-capable authority. The existing
SQLite writer guard must reject any second writer. Repository deletion or a
destructive cleanup can destroy repo-local memory, and same-disk backups do not
protect against full-disk loss. All runtime artifacts are sensitive plaintext.

Vector retrieval, graph storage, relationship hypotheses, remote transport,
summaries, automatic extraction, and lexical retrieval are prohibited during
milestone one unless promoted by their later dedicated work items.

No new privileged Discord intent is authorized. Event-local identity and alias
evidence is accepted when member-cache information is incomplete.

The identity, scope, authorization, one-writer, delivery-eligibility,
untrusted-prompt-data, fail-closed, deletion, and off-mode invariants in
`EXECUTION_CONTRACT.md` are binding.
