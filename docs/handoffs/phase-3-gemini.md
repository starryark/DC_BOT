# Phase 3 Handoff — Gemini Brain

## Files changed
- **New** `src/providers/brain/types.ts` — `BrainProvider`, `BrainTurn`.
- **New** `src/providers/brain/prompt.ts` — `SYSTEM_PROMPT` (plan.md §23, multilingual spoken-friendly).
- **New** `src/providers/brain/gemini.ts` — `GeminiBrainProvider` using `@google/genai` `generateContentStream`.
- **New** `src/orchestration/guild-session.ts` — `GuildSession` (bounded per-guild history, speaker-labeled) + `GuildSessionRegistry`.
- **Modified** `pnpm-workspace.yaml` — added `@google/genai: ^2.14.0` to catalog.
- **Modified** `services/discord-bot/package.json` — added `@google/genai: catalog:`.
- **Modified** `pnpm-lock.yaml` (already dirty) — `@google/genai@2.14.0` added.

## Public interfaces
- `GeminiBrainProvider`:
  - `setContentsProvider(fn: (turn) => Content[])` — controller injects session history resolution.
  - `generate(turn, signal): AsyncIterable<string>` — streams text deltas.
- `GuildSessionRegistry.get(guildId)` → `GuildSession`; `addUserTurn(name, text)`, `addModelTurn(text)`, `getContents()`.

## Configuration added
`GEMINI_API_KEY`, `GEMINI_MODEL=gemini-2.5-flash` (`.env.example` had `gemini-3.6-flash` from plan.md; updated guidance: `gemini-2.5-flash` is the current stable flash, `gemini-flash-latest` rolls forward — both valid). `CONVERSATION_MAX_MESSAGES=24`.

## Verified API facts (@google/genai 2.14.0)
- `new GoogleGenAI({ apiKey })`
- `ai.models.generateContentStream({ model, contents, config })` → async iterable; `chunk.text` (`string | undefined`).
- `config: { systemInstruction, abortSignal }` (camelCase). Abort is client-side only (server op not cancelled, still billed) — acceptable for barge-in.
- `contents: Content[]` with `role: 'user'|'model'`, `parts: [{ text }]`.
- Requires Node ≥20 (machine is on 24). ESM-first; ships CJS too. With `verbatimModuleSyntax`, types use `import type`.

## Assumptions
- One logical conversation per guild (plan.md §21) — speaker-labeled in the text, not separate per-user conversations.
- The provider is stateless; the controller owns session state and injects the contents resolver. This keeps the provider replaceable (plan.md §51 `AiriCoreBrainProvider` later).
- History is bounded in-memory only for v1 (plan.md §22); persistence deferred.

## Known issues
- Not yet wired to run end-to-end (controller is Phase 5). Phase 3 acceptance (JA→JA/ZH→ZH/EN→EN) requires the controller or a temporary harness; deferred to Phase 5 integration.
- The model default in `.env.example` reads `gemini-3.6-flash` (from plan.md); as of mid-2026 `gemini-2.5-flash` is the documented stable flash. It's configurable, so this only matters at runtime — the operator should set GEMINI_MODEL to a model their API key has access to.

## Tests run
- `pnpm -F @proj-airi/discord-bot typecheck` → **PASS**.

## Integration instructions (Phase 5)
```
const brain = new GeminiBrainProvider()
const sessions = new GuildSessionRegistry()
brain.setContentsProvider((turn) => {
  const session = sessions.get(turn.guildId)
  session.addUserTurn(turn.userName, turn.text)
  return session.getContents()
})
// on complete generation: session.addModelTurn(fullReplyText)
```
