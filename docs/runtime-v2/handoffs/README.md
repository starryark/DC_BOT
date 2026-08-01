# Runtime V2 — Subagent Handoffs

Every implementation subagent writes a handoff here as
`docs/runtime-v2/handoffs/<agent-name>.md`, containing **only** the fields below
(master plan §13). Do not store chain-of-thought or long exploratory notes —
downstream agents read the handoff instead of rereading another agent's history.

Required sections:

```markdown
# <Agent Name> — <one-line scope>

## Summary

## Files changed

## Public interfaces added/changed

## Behavior implemented

## Configuration added

## Tests added

## Tests executed

## Benchmark results

## Assumptions

## Known limitations

## Integration instructions

## Follow-up items
```

## Index

| Wave | Agent | Handoff | Status |
|------|-------|---------|--------|
| 0 | 0A Repository Cartographer | (output is `../00-current-state.md`) | done |
| 0 | 0B Baseline/Benchmark Analyst | (output is `../03-performance-baseline.md`) | done |
| 1 | 1A Character/Card Runtime | `1a-character.md` | done |
| 1 | 1B Conversation Domain | `1b-conversation.md` | pending |
| 1 | 1C Telemetry/Tracing | `1c-telemetry.md` | done |
| 2 | 2A GPT-SoVITS Performance | `2a-tts.md` | pending |
| 2 | 2B Qwen3-ASR Backend | `2b-asr.md` | pending |
| 2 | 2C Brain Streaming / Latency | `2c-brain.md` | pending |
| 2D | 2D Attention / Turn Filtering | `2d-attention.md` | pending |
| 3 | 3A Discord Mention Adapter | `3a-discord-text.md` | pending |
| 3 | 3B Room Binding | `3b-room-binding.md` | pending |
| 4 | 4A SQLite Memory Store | `4a-memory-store.md` | pending |
| 4 | 4B Context Summarizer / Memory Writer | `4b-memory-maintenance.md` | pending |
| 6 | 6A Output Protocol Parser | `6a-output-protocol.md` | pending |
| 7 | 7A–7G Avatar / Live2D | `7*-avatar.md` | pending |
