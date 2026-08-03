# Shared-memory execution contract

The local checkout is the source of truth. Preserve all existing work and reuse
the existing memory-domain and memory-sqlite contracts. Implement one work item
at a time and record only commands that were actually run.

## Binding invariants

- Discord user IDs are durable identity anchors; names never merge people.
- Authorization precedes repository access and locations are isolated by default.
- Cross-location continuity requires a validated explicit binding.
- Exactly one guarded write authority may be active.
- Only delivered text and played voice are completed conversational context.
- Retrieved memory is bounded, untrusted data and never a control instruction.
- Failure cannot silently create a second context authority.
- Correction and deletion cover primary and derived data.
- Off mode preserves existing behavior and opens or creates no memory storage.
- Vector, graph, relationship, and remote-transport work remains disabled.
- No new privileged Discord intent is authorized for milestone one.

Private local activation is owner-authorized. Missing formal review is recorded
as owner risk accepted, never as a passed technical or governance gate.
