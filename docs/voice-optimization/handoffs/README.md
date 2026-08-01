# Handoffs — voice optimization

Format per Optimize.md §7. Each handoff is ≤ ~1,200 words and contains only:

```
Commit or patch identifier
Files read
Files changed
Interfaces added or changed
Tests added
Commands run and results
Behavior now guaranteed
Known limitations
Risks
Exact context required by the next agent
```

## Execution note

Waves 0–2 were executed by a **single agent in one working tree**, not by
parallel subagents in separate branches. Optimize.md §8's branch-per-agent and
file-ownership rules exist to prevent two agents editing one file in a wave;
with one agent that hazard does not arise, so the waves were executed in
dependency order (0 → 1A → 1B → 1C → 2A) in place. The per-agent handoff
documents are therefore consolidated into `w0-w2-consolidated.md`.

Rules that still applied and were honored: no destructive Git commands, no
reset/stash/clean, user changes preserved, no formatting of unrelated files,
tests committed alongside the feature they verify.

## Index

| Wave | Scope | Handoff | Status |
|------|-------|---------|--------|
| 0 | Discovery + contract | `../repository-map.md`, `../baseline-findings.md`, `../architecture-contract.md` | done |
| 1A | Playback ownership | `w0-w2-consolidated.md` | done |
| 1B | Input gate + transcript filter | `w0-w2-consolidated.md` | done |
| 1C | Gemini limiter + cooldown | `w0-w2-consolidated.md` | done |
| 2A | Controller state machine | `w0-w2-consolidated.md` | done |
| 3A–3D | Chunker, TTS cache, floor, telemetry | — | not started |
| 4A–4C | QA, benchmarks, adversarial review | — | not started |
