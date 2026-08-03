# Increments 3–7 completion record

Completed locally on 2026-08-02 under the private-owner execution contract.

## Increment 3 — events, causality, delivery

Text and voice append idempotent inbound events, causal generations, output
segments, and delivery transitions. Failed text, cancelled voice, and unplayed
voice are excluded; completed local playback is represented as `unheard` with
playback-range evidence rather than a false audibility claim.

## Increment 4 — shared adapters and shadow soak

Text and voice use the same guarded runtime authority. Voice freezes event-local
actor evidence, persists one event per speaker, retains group causality, and
records every playback segment. Existing playback ordering and epoch behavior
passed the complete Discord suite. Shadow failures are reported through the
adapter failure hooks and never presented as committed memory.

## Increment 5 — privacy core

`/memory status`, `show`, `remember`, `correct`, `forget`, and `export` default
to the attributable requester and current room. Explicit facts retain source
event provenance; corrections supersede prior facts. Forget redacts primary
payloads, invalidates/tombstones derived records, verifies absence, and retains
minimal tombstones. Backup helpers capture and replay deletion obligations
against an isolated verified restore candidate.

## Increment 6 — active recent context

Active mode is activatable. Authorized exact-scope durable context replaces
legacy recent history in text and voice prompts while preserving the existing
system/persona prefix and current input. Serialization is bounded and treats
memory as untrusted data; context lookup has a 250 ms fail-closed deadline.
Off mode remains inert and does not delete or open the authority database.

## Increment 7 — optional capabilities

Summary and automatic-extraction activation is refused until worker-specific
soak evidence exists. Vector, relationship/graph, and remote capabilities retain
their benchmark/topology gates. Optional workers are not on the voice-critical
path and are not falsely advertised as complete.

## Validation actually run

- `pnpm -F @proj-airi/discord-bot typecheck` — passed.
- `pnpm -F @proj-airi/discord-bot test` — 41 files, 397 tests passed.
- `pnpm -F @proj-airi/memory-sqlite test` — 14 files, 127 tests passed.
- `pnpm -F @proj-airi/memory-domain test` — 10 files, 206 tests passed.
- Targeted ESLint over changed production TypeScript — passed.
- `git diff --check` — passed; Git emitted only LF/CRLF conversion notices.

Formal governance approval remains absent and is recorded as owner-accepted
risk; this record is technical completion evidence, not a governance sign-off.
