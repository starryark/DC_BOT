# Active-memory stabilization evidence — 2026-08-03

Baseline: `2f07752d4d52bf75d32babd897e1a6bf8ba1363e`

Status: A1-A7 implemented. A8 automated evidence passed. Active-ready remains withheld because the required private Discord soak was not available in this execution environment.

## Executed checks

From `airi/services/discord-bot`:

```text
.\node_modules\.bin\vitest.cmd run
41 files passed; 403 tests passed.

pnpm -F @proj-airi/discord-bot typecheck
passed.
```

From `airi/packages/memory-domain`:

```text
.\node_modules\.bin\vitest.cmd run
10 files passed; 206 tests passed.

pnpm -F @proj-airi/memory-domain typecheck
passed.
```

From `airi/packages/memory-sqlite`:

```text
.\node_modules\.bin\vitest.cmd run
14 files passed; 129 tests passed.

pnpm -F @proj-airi/memory-sqlite typecheck
passed.
```

From `airi`:

```text
.\node_modules\.bin\eslint.cmd <all changed TypeScript paths>
passed with zero errors and zero warnings.

pnpm -F @proj-airi/memory-sqlite benchmark:imp208
2,000 rows; 498.2098 operations/second; append p95 2.1453 ms;
zero busy/locked errors; backup 18.6635 ms; restore 10.5331 ms;
integrity verification 4.1276 ms.

git diff --check
passed; Git emitted only LF-to-CRLF working-copy notices.
```

The Discord suite was rerun after formatting alongside both memory packages and produced the same 403/206/129 passing totals. A later isolated run of `conversation-controller.test.ts` exhibited two known timing-sensitive failures; the complete suite before and after formatting passed without a production change in that path. This isolated timing result is retained here rather than hidden.

## Covered stabilization behavior

- Fail-closed active admission, context, and pre-model generation causality.
- Empty durable context produces a current-input-only prompt.
- Configured binding idempotency, retirement, ownership isolation, and atomic rollback.
- Bound text/voice continuity and unbound fallback after retirement.
- Logical-room SQL limits, deterministic ordering, current-event exclusion, and context manifests.
- Shared conversational/privacy ingress and character identity.
- Disabled remember/correct operations produce no event or fact writes.
- Segment-level text outcomes preserve earlier successful sends.
- Voice success, cancellation, failure, session cleanup, actual channel destination, and bounded trace expiry.
- Deletion closure over inbound content, facts, episodes, summaries, and causally derived output.
- Restore replay through the same closed deletion-target registry; unknown targets fail closed.
- Read-only/redacted operator inspection and guarded mutation workflows.

## Outstanding activation evidence

The required private Discord soak with redacted runtime evidence needs valid Discord credentials, a private guild, text/thread/voice locations, and human observation of live transport behavior. Those resources were not provided to this environment. Consequently:

- production and ordinary local use remain in `shadow`;
- `active` remains opt-in for implementation/testing only;
- status is not changed to active-ready.
