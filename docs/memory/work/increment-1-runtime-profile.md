# Increment 1 — runtime profile and composition root

## Outcome

The Discord bot starts and stops safely in `off` and `shadow`.

## Existing code to reuse

- `src/memory/feature-flags.ts`: canonical validation and posture.
- `@proj-airi/memory-sqlite`: guarded authoritative opener, migrations,
  durability verification, repositories, backup, and unit-of-work.
- `src/index.ts`: the sole Discord-bot composition root and shutdown owner.

## Files likely to change

- `services/discord-bot/src/config.ts`
- `services/discord-bot/src/index.ts`
- `services/discord-bot/src/memory/` runtime, path, and boundary modules/tests
- `services/discord-bot/package.json`
- root `.gitignore` and memory status documentation

## Out of scope

Ingress persistence, prompt reads, room bindings, commands, FTS, summaries,
extraction, and degraded replay.

## Acceptance tests

- Missing memory configuration selects off.
- Invalid modes and profile/low-level conflicts fail startup.
- Off mode creates no path and opens no database.
- Shadow opens the resolved authority and refuses a second writer.
- Repo-local and explicit absolute paths resolve predictably and unsafe paths fail.
- Structured status is redacted.
- Shutdown closes storage and releases ownership.
- Source-boundary test permits `memory-sqlite` only in the approved composition module.
- Existing off-mode text and voice tests remain green.

## Completion record

Completed 2026-08-02. Added centralized profile expansion and conflict
detection, one tested path resolver, inert off runtime, guarded shadow runtime,
redacted health, graceful close, and a source-boundary test. Active and
degraded profiles validate but deliberately fail activation until their later
increments. Typecheck, focused tests, full Discord tests (383), domain tests
(206), and targeted lint passed.
