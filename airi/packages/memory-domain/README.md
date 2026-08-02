# `@proj-airi/memory-domain`

Transport-neutral contracts for the DC_BOT shared-memory layer: identity,
scope, events, causality, generation, delivery, and the memory layers, plus the
`MemoryPort` interface that is the single durable memory authority for the
Discord text and voice paths.

## What it does

Defines the types and the small amount of pure policy that both the text
adapter and the voice adapter must agree on, so that "we each tested it" cannot
mean "we each tested a different shape". Concretely:

| Module | Owns |
|---|---|
| `ids` | Branded identifiers and RFC 3339 UTC timestamps |
| `errors` | The `MemoryError` taxonomy, including which codes mean "not durable" |
| `capabilities` | What a backend may claim it can do, and the CJK/Latin split |
| `identity` | Discord snowflake as the durable key, actor snapshots, presentation projection |
| `aliases` / `addressing` | Five alias scopes, precedence, visibility, opaque prompt handles |
| `rooms` | Physical locations vs logical rooms vs versioned bindings |
| `authorization` | Deny-by-default decisions with explainable codes |
| `events` / `causality` | Immutable event envelopes, separate lifecycle, many-to-many causes |
| `generation` / `delivery` | Generation and delivery state machines, context eligibility |
| `memory-records` / `provenance` / `corrections` | Layered records, provenance, supersession, tombstones |
| `port` | The 13-operation `MemoryPort` |
| `fixtures` | Deterministic conformance fixtures shared by every adapter |

## How to use it

```ts
import {
  assertAppendable,
  attributedActor,
  buildCausalEdges,
  isAssistantSegmentEligible,
  resolveLogicalRoom,
} from '@proj-airi/memory-domain'
```

Adapters import the contracts and implement them. They never redeclare a type
this package exports — `src/boundaries.test.ts` fails the build if they do.

The fixtures are part of the published surface, not test helpers:

```ts
import { FIXTURE_GROUP_TURN_EVENTS, FIXTURE_VOICE_DELIVERIES } from '@proj-airi/memory-domain'
```

## When to use it

- Building any adapter that reads or writes durable memory (SQLite, a test
  fake, a future remote transport).
- Writing a conformance or failure-injection suite that must exercise the same
  scenarios the other adapters do.

## When not to use it

- For ephemeral, per-turn session state. Voice playback queues, cancellation
  epochs, and floor arbitration stay in the service; they are not memory.
- To reach a database. This package has zero runtime dependencies and imports
  no driver, transport, Discord SDK, or model provider — by design and by test.
- As a place to add a convenience helper for one call site. The package is a
  contract; every export is something more than one workstream must agree on.

## Status

Rollout stage **R1** — merged, runtime disabled. Nothing here is wired into a
production path yet. See `docs/memory/implementation-status.md` for the gate
status that governs what may be built on top of it, and `docs/memory/adr/` for
the decisions the shapes here encode.

## Tests

```bash
pnpm -F @proj-airi/memory-domain exec vitest run
pnpm -F @proj-airi/memory-domain typecheck
```
