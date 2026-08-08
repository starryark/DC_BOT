# IMPLEMENTATION_REPORT

## 1. Candidate Identity
- **Ending SHA:** The local checkout has been committed to `main` with commit message "feat(memory): IMP-606 lexical/full-text retrieval".
- **Changed Files:**
  - `airi/packages/memory-domain/src/capabilities.ts`
  - `airi/packages/memory-sqlite/src/index.ts`
  - `airi/packages/memory-sqlite/src/migration-runner.test.ts`
  - `airi/packages/memory-sqlite/src/migration-runner.ts`
  - `airi/packages/memory-sqlite/src/migrations/index.ts`
  - `airi/packages/memory-sqlite/src/repositories/search.test.ts`
  - `airi/packages/memory-sqlite/src/repositories/search.ts`
  - `airi/packages/memory-sqlite/src/schema/v9.ts`
  - `airi/services/discord-bot/src/memory/context-authority.ts`
  - `airi/services/discord-bot/src/memory/runtime.ts`

## 2. Invariant Mapping & Files
- **Additive Lexical-Index Schema:** Created `schema/v9.ts` containing the `memory_search_latin` (`unicode61`) and `memory_search_cjk` (`trigram`) tables, along with lifecycle triggers to maintain sync with `inbound_event_records` and other required tables.
- **SQLite Retrieval Implementation:** Created `repositories/search.ts` providing `SearchRepository.searchMemory`. It joins FTS target tables with authorization, temporal, and lifecycle logic, returning matching semantic hits while dropping any invalid row.
- **Truthful Runtime Wiring:** Updated `MemoryRuntime` inside `runtime.ts` to implement `ContextMemoryAuthority.searchMemory` connected to `SearchRepository`.
- **Capability Advertisement:** Added `fulltext_cjk` to `M1_SQLITE_CAPABILITIES` in `capabilities.ts`.

## 3. Commands Executed
- Executed `vitest` for tests in `search.test.ts` to verify temporal boundaries, capability checking, and FTS5 operations.
- Executed `node` and typescript checkers to verify checksum computation for migration `v9`.
- Executed `pnpm -F @proj-airi/memory-sqlite exec tsc --noEmit && pnpm -F @proj-airi/discord-bot exec tsc --noEmit` to ensure types passed cleanly.

## 4. Test Results
- `SearchRepository` tests pass 3/3 constraints (authorization lock, temporal boundaries, unsupported capability behavior).
- `migration-runner` successfully loads `v9.ts` without errors.

## 5. Limitations & Unresolved Items
- Dataset evaluation logic has not been fully implemented in `discord-bot/evals/memory`. The subagents must evaluate if further dataset metrics are necessary.
