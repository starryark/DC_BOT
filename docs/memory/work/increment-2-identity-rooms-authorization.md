# Increment 2 — identity, rooms, and authorization

## Outcome

All supported Discord ingress resolves stable actors and isolated rooms through
one deny-by-default authorization boundary.

## Existing code to reuse

- Frozen actor evidence in `src/memory/discord-actor-snapshot.ts`.
- Identity, aliases, rooms, scopes, and authorization in `memory-domain`.
- Existing text/voice room resolution and event-local voice evidence.
- SQLite identity, alias, room, binding, and policy repositories.

## Files likely to change

- Discord memory application adapters and tests.
- Mention, slash-command, and voice ingress wiring.
- Versioned local room-binding loader and schema tests.
- Runtime construction, exposing only `MemoryPort` and authorization services.

## Out of scope

Event persistence, generation causality, delivery persistence, prompt reads,
privacy commands, FTS, summaries, extraction, and degraded replay.

## Acceptance tests

- Same Discord ID resolves to one person across text and voice.
- Same-name users remain separate and rename snapshots are preserved.
- Missing member cache retains the Discord user ID.
- DM, guild, channel/thread, voice, and character scopes do not leak.
- Unbound locations remain isolated; valid bindings share one logical room.
- Invalid bindings fail closed.
- Authorization is observed before every repository call.

## Completion record

Completed 2026-08-02. Acceptance is covered by the Discord memory runtime,
room-binding, ingress-authority, and actor-snapshot suites.
