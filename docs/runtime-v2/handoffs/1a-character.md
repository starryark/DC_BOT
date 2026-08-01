# 1A Character/Card Runtime — CCv3 CharacterRegistry + PromptCompiler + ACT-v1 parser

## Summary

Wave 1 character subsystem, implemented exactly against `02-public-contracts.md`
§5, §7, §8 and `04-decisions.md` D006. Purely additive: 5 new source modules
under `src/character/**` plus 4 inline Vitest suites. No existing file was
modified. The frozen contracts are honored byte-for-byte: `CharacterRuntime`
shape, `CharacterRegistry.load → CharacterRuntime`, the EXACT §5.3 prompt
ordering, and the ACT-v1 parser contract.

The headline **compatibility requirement is met and proven by a test**: the LIVE
`Makise Kurisu/card.json` — which has NO `extensions.dc_bot` and keeps the ACT
protocol in `creator_notes` — loads into a normalized `CharacterRuntime`
(identity, voice, ASR hotwords, avatar metadata, output protocol) **without
throwing**, with no Discord/model-provider side effects. The registry derives
safe defaults from the canonical emotion list and from the AIRI `speech`
extension so the Integration Lead can adopt the character runtime first and
migrate the card separately.

## Files changed

All NEW (additive). None of the Integration-Lead-owned or sibling files were
touched.

- `airi/services/discord-bot/src/character/types.ts` — `CharacterRuntime` +
  `VoiceProfile` + `AsrCharacterProfile` + `AvatarProfile` +
  `OutputProtocolProfile` + `CharacterLorebook` + `LorebookEntry` (§5.1).
- `airi/services/discord-bot/src/character/card-schema.ts` — CCv3 card TS types
  (`CharaCardV3` / `CharaCardV3Data` / `CharacterBook`), the `DcBotExtension`
  type (§7) + concrete `Normalized*` post-normalization types, `CANONICAL_EMOTIONS`,
  `validateCard`, `readDcBotExtension`, `readAiriExtension`, `normalizeDcBotExtension`,
  `normalizeLorebook`. Unknown CCv3 fields survive parsing (preserve-and-ignore).
- `airi/services/discord-bot/src/character/character-registry.ts` — `CharacterRegistry`
  interface + `FileCharacterRegistry` + `buildCharacterRuntime` + `CharacterLoadError`
  + `resolveRelativeAsset`. Loads/validates/normalizes a CCv3 card into an immutable
  `CharacterRuntime`; resolves assets relative to the card dir (containment-enforced);
  caches loaded runtimes. MUST NOT and DOES NOT call Gemini/TTS/ASR/Discord/memory.
- `airi/services/discord-bot/src/character/prompt-compiler.ts` — `PromptCompiler`
  interface + `DefaultPromptCompiler` + `CompiledPrompt` / `CompiledPromptMetrics`
  + `estimateTokens`. Implements the EXACT §5.3 ordering. Persona comes from
  `card.system_prompt` (NOT `creator_notes`).
- `airi/services/discord-bot/src/character/output-protocol/act-v1-parser.ts` —
  `parseActV1(text, opts)` → `{ actions, pauses, cleanText }`. Strict bounded
  parser (no `eval`, no blind `JSON.parse`). Robust to malformed input.
- Tests (inline `*.test.ts`, matching `conversation-controller.test.ts`):
  - `airi/services/discord-bot/src/character/card-schema.test.ts` (24 tests)
  - `airi/services/discord-bot/src/character/character-registry.test.ts` (14 tests)
  - `airi/services/discord-bot/src/character/prompt-compiler.test.ts` (13 tests)
  - `airi/services/discord-bot/src/character/output-protocol/act-v1-parser.test.ts` (18 tests)

## Public interfaces added/changed

No existing interface was changed. All additions are under `src/character/`:

```ts
// src/character/types.ts — frozen §5.1 shapes
export interface CharacterRuntime {
  id: string; name: string
  identity: { description, personality, scenario, systemPrompt, postHistoryInstructions }
  voice: VoiceProfile
  asr: AsrCharacterProfile
  avatar?: AvatarProfile
  lorebook?: CharacterLorebook
  outputProtocol?: OutputProtocolProfile
}
export interface VoiceProfile { provider, voiceId, referenceAudio, referenceTextFile?, referenceText?, promptLanguage }
export interface AsrCharacterProfile { hotwords: string[] }
export interface AvatarProfile { renderer, displayModelId? }
export interface OutputProtocolProfile { type, emotions: string[], allowDelay }
export interface CharacterLorebook { entries: LorebookEntry[] }
export interface LorebookEntry { keys: string[], content, extensions?, enabled?, insertionOrder? }

// src/character/card-schema.ts
export const CANONICAL_EMOTIONS = ['happy','sad','angry','think','surprised','awkward','question','curious','neutral'] as const
export function validateCard(raw: string): CardValidation   // { ok, card, errors, warnings } — never throws on malformed input
export function readDcBotExtension(card): DcBotExtension | null
export function readAiriExtension(card): unknown            // verbatim
export function normalizeDcBotExtension(raw): NormalizedDcBotExtension   // fills safe defaults; never throws
export function normalizeLorebook(raw): CharacterLorebook | undefined

// src/character/character-registry.ts
export interface CharacterRegistry { load(characterId: string): CharacterRuntime }
export class FileCharacterRegistry implements CharacterRegistry
export class CharacterLoadError extends Error
export function buildCharacterRuntime(characterId, cardDir, cardJson, logger?): CharacterRuntime
export function resolveRelativeAsset(cardDir, relPath): string   // containment-enforced, posix-separated

// src/character/prompt-compiler.ts — frozen §5.3
export interface CompiledPrompt { systemInstruction: string; contents: Content[] }   // Content from @google/genai
export interface CompiledPromptMetrics { approximateTokens, recentTurnCount, memoryCount, loreEntryCount }
export interface PromptCompiler { compile(input): { prompt: CompiledPrompt; metrics: CompiledPromptMetrics } }
export class DefaultPromptCompiler implements PromptCompiler
export function estimateTokens(text: string): number

// src/character/output-protocol/act-v1-parser.ts — frozen §8
export interface ActV1ParseResult { actions: AvatarAction[]; pauses: { durationMs }[]; cleanText: string }
export function parseActV1(text: string, options?: { allowDelay?, delayUnitMs? }): ActV1ParseResult
```

## Behavior implemented

**Card validation** (`card-schema.ts`): `spec === 'chara_card_v3'` required;
`spec_version` major `3` required, minor mismatch warn-but-accept; `data.name`
and `data.system_prompt` required non-empty strings. Unknown fields survive
(the parsed card is a loose record). `validateCard` never throws — invalid JSON
or non-object roots return `{ ok: false, errors }`.

**Registry** (`character-registry.ts`): `load(id)` reads `card.json` from a
registered root (or `config().character.root` once the Integration Lead wires
it — see Configuration below), validates CCv3, normalizes `extensions.dc_bot`
(safe defaults) + preserves `extensions.airi` verbatim, resolves asset paths
relative to the card dir, and returns an immutable cached `CharacterRuntime`.
`resolveRelativeAsset` enforces containment: traversal (`../../../etc/passwd`)
and absolute paths are reduced to the basename inside the card dir; separators
normalized to POSIX. `referenceText` is loaded from `referenceTextFile` when
present (fixes D008's `naive_infer` fallback once a transcript is supplied).
`CharacterLoadError` is thrown only for missing files / invalid CCv3 / no
registered root — never for a card that merely lacks `extensions.dc_bot`.

**Compatibility (the LIVE card)**: when `extensions.dc_bot` is absent,
`normalizeDcBotExtension(null)` returns all defaults — `outputProtocol`
derived from `CANONICAL_EMOTIONS`, `asr.hotwords = []`, `avatar.renderer =
'live2d'`. Voice falls back through `dc_bot.voice` → AIRI `speech` module
(`provider`/`voice_id`) → hard default; `displayModelId` falls back to the
AIRI `modules.displayModelId`. So the LIVE card yields `voice.provider =
'gpt-sovits'`, `voice.voiceId = 'kurisu'`, `avatar.displayModelId =
'display-model-0-BFdupzrCE8y9q0Vofel'` — all sourced from the AIRI extension.

**PromptCompiler** (`prompt-compiler.ts`): `compile()` produces
`{ systemInstruction, contents }` in the EXACT §5.3 order —
systemInstruction = [runtime safety/output-format] → [character system_prompt]
→ [description/personality/scenario] → [activated lorebook] → [memories] →
[running summary] → [post_history_instructions appended at the tail];
contents = recent turns (oldest first) + current input as the final user turn.
Speaker labels are folded into user-turn text (`${speaker}: ${text}`), matching
today's `GuildSession` convention. `creator_notes` is NEVER injected. The ACT-v1
output-protocol instructions are emitted into the safety section only when the
character has an `outputProtocol` of `type: 'act-v1'`, so the model emits the
encoding the parser expects. Lorebook entries activate on keyword match against
recent turns + current input, ordered by `insertionOrder`, de-duplicated by
content, `enabled=false` excluded. `estimateTokens` = latin≈chars/4 + CJK≈chars/2
(documented heuristic proxy, not billing).

**ACT-v1 parser** (`output-protocol/act-v1-parser.ts`): `parseActV1(text)` →
`{ actions, pauses, cleanText }`. Parses `<|ACT:"emotion":{...},"motion":"..."|>`
and `<|DELAY:n|>`. Strict bounded scanner for the emotion object (no `eval`, no
blind `JSON.parse` — only `name`/`intensity` keys accepted). Robustness
contract: malformed tokens never throw; unrecognized tokens and malformed
emotion payloads are stripped as metadata while safe visible text is preserved;
intensity clamped to 0..1; adjacent non-space chars around a removed token get a
single separating space (so `a<|DELAY:1|>b` → `a b`, not `ab`). `cleanText` is
the only string that may reach TTS/Discord/history/memory (D006).

## Configuration added

None added to `config.ts` (Integration-Lead-owned). The registry reads an
**optional** `config().character.root` via a double-cast-through-`unknown`
compatibility seam, so it works the moment the Integration Lead adds it without
this module needing an edit. Required Integration-Lead config addition (see
Integration instructions): `CHARACTER_PATH` (root dir) + `CHARACTER_ID`
(default id, e.g. `kurisu`).

## Tests added

69 new tests across 4 files (inline `*.test.ts`, `vitest.config.ts` glob
`src/**/*.test.ts`):

- `card-schema.test.ts` (24): required-field rejection (missing/empty `name`,
  missing `system_prompt`, wrong `spec`); preserve-and-ignore of unknown fields;
  spec_version major-mismatch warn + minor accept + missing warn; invalid-JSON /
  non-object no-throw; `dc_bot`/`airi` extension reads; `normalizeDcBotExtension`
  defaults + emotion fallback/dedupe + hotwords coercion; `normalizeLorebook`
  content filtering + verbatim `enabled`/`insertionOrder`/`extensions`.
- `character-registry.test.ts` (14): **LIVE Kurisu card loads into a full runtime
  with no `extensions.dc_bot`** (identity/voice/asr/avatar/outputProtocol all
  present, voice derived from AIRI); cache identity; pure-data (no provider
  calls); `extensions.dc_bot`-present reads; unknown-field survival;
  `CharacterLoadError` on missing required field + on no registered root;
  `referenceText` resolution from `referenceTextFile` (temp dir) + absent-file
  undefined; `resolveRelativeAsset` containment (traversal/absolute → basename,
  posix separators, empty input).
- `prompt-compiler.test.ts` (13): the EXACT §5.3 ordering asserted by index
  (safety < persona < description < personality < scenario; post_history at the
  tail); ACT-v1 instructions present; contents oldest-first + current input as
  last user turn (speaker-labeled); empty-persona graceful omission; lorebook
  keyword activation + `insertionOrder` sort + `enabled=false`; memory + summary
  inclusion; metrics (`recentTurnCount`, `memoryCount`, `loreEntryCount`,
  `approximateTokens > 0`); deterministic for same input; `estimateTokens`
  latin/CJK rates.
- `act-v1-parser.test.ts` (18): the §8 canonical example + both
  `creator_notes` examples (single neutral ACT; multi-token with two ACTs + a
  DELAY); DELAY default/custom unit + `allowDelay:false`; robustness — no
  tokens, empty string, non-string input, unterminated `<|`, malformed emotion
  object, truncated motion, intensity clamp, no-motion ACT, empty emotion `{}`,
  unknown control token, JSON-injection attempt (never executed), multiline
  preservation.

## Tests executed

From `airi/services/discord-bot/`:

- `pnpm typecheck` (`tsc --noEmit`): **PASS** (0 errors).
- `pnpm test` (`vitest run`): **PASS — 13 test files, 156 tests, 0 failures.**

Baseline before my changes: 9 files / 87 tests (per the task brief and verified
green at start). After my changes: 13 files / 156 tests (87 baseline + 69 new),
all green. The existing suites (`conversation-controller`, `gpt-sovits`,
`language`, `publisher`, and 1B/1C's `room`/`events`/`delivery`/`turn`/
`turn-tracer`) remain fully green — confirming the additive-only constraint.

## Benchmark results

N/A — this wave adds pure data types + an in-memory card load with no provider
I/O. No latency-relevant code path runs yet (the prompt compiler is not wired
into the live brain provider; that is the Integration Lead's gate work).

## Assumptions

1. `import type` for interface-only imports, no semicolons (ASI), `@guiiai/logg`'s
   `useLogg` — all matched to existing files (`conversation-controller.ts`,
   `guild-session.ts`, `gemini.ts`).
2. Test location is inline `*.test.ts` next to source (confirmed by
   `conversation-controller.test.ts` + `vitest.config.ts` glob `src/**/*.test.ts`).
3. `Content` is imported from `@google/genai` (verified shape: `{ role?: string,
   parts?: Part[] }`, `Part.text?: string`); the existing `guild-session.ts`
   uses `role: 'model'` for assistant turns — I match that convention.
4. `creator_notes` is intentionally NOT a prompt field (D006); persona comes from
   `data.system_prompt`. The ACT protocol stays in `creator_notes` on the LIVE
   card but is NOT auto-injected — the prompt compiler emits ACT-v1 instructions
   derived from the (defaulted) `outputProtocol` profile instead.
5. Token estimate is a documented heuristic proxy (latin≈chars/4, CJK≈chars/2),
   used only for the `character_prompt_token_estimate` telemetry metric + bounding
   — not billing.
6. The `delayUnitMs` default is 1000 (so `<|DELAY:1|>` = 1000 ms), matching the
   small-integer convention in the Kurisu `creator_notes`.
7. `config().character.root` is read via a double cast through `unknown` so the
   registry adopts it without an edit once the Integration Lead adds it; until
   then, `characterRoots` / the injected `resolvePath` (used in tests) is the
   way to point at a card directory.

## Known limitations

- **Not wired into the live pipeline yet.** The brain provider still uses the
  hardcoded `SYSTEM_PROMPT` (`providers/brain/prompt.ts`); the Integration Lead
  swaps it onto `PromptCompiler.compile()` output at the Wave-1 gate. Until then
  the persona does not reach Gemini at runtime — only the compiler + tests exist.
- **The act-v1 parser is the foundation only.** Wave 6A owns the full
  output-protocol module wiring (streaming `TurnOutput` emission from raw LLM
  text). This module exposes `parseActV1` and is unit-tested, but the
  orchestrator does not call it yet.
- **Voice `referenceAudio` is empty for the LIVE card** (the AIRI extension has
  no ref-audio path). The TTS provider keeps falling back to its env-configured
  `GPT_SOVITS_REF_AUDIO` until the card is migrated to carry
  `extensions.dc_bot.voice.referenceAudio`. This is intentional for the
  transition window.
- **`FileCharacterRegistry` caches by character id** (the card never changes at
  runtime). There is no hot-reload; a card edit needs a process restart.

## Integration instructions

For the Integration Lead (Wave 1 gate):

1. **Config additions (required):** add to `config.ts` / `AppConfig`:
   ```ts
   character: {
     root: env.CHARACTER_PATH || ''      // dir holding <id>/card.json folders
     id: env.CHARACTER_ID || 'kurisu'    // default character id
   }
   ```
   `FileCharacterRegistry` already reads `config().character.root` via the
   compatibility seam; no edit to `src/character/**` is needed. Env vars
   `CHARACTER_PATH` / `CHARACTER_ID` should be added to `.env.example` /
   `.config`. For the LIVE setup, `CHARACTER_PATH` points at the dir containing
   `Makise Kurisu/` and `CHARACTER_ID=kurisu` (the registry joins
   `${root}/${id}` to find `card.json`).
2. **Construct the registry** in `index.ts` / `services.ts`:
   `new FileCharacterRegistry({ characterRoots: { kurisu: '<abs path to Makise Kurisu dir>' } })`
   (or rely on `config().character.root`). Call `registry.load('kurisu')` once
   at startup; pass the resulting `CharacterRuntime` to the prompt compiler.
3. **Swap the brain's system prompt onto the compiler.** In the Gemini provider
   (or wherever `contents` are resolved), replace the hardcoded `SYSTEM_PROMPT`
   with `PromptCompiler.compile({ character, room, currentInput,
   currentInputText, memories }).prompt`, feeding `systemInstruction` to
   `generateContentStream`'s `config.systemInstruction` and `contents` to the
   request. The existing `setContentsProvider` resolver becomes a call to the
   compiler (room-scoped per 1B's handoff). `creator_notes` is NOT involved.
4. **Wire the act-v1 parser** (Wave 6A, or now if desired): run each streamed
   LLM chunk through `parseActV1` so `cleanText` goes to TTS/Discord/history and
   `actions`/`pauses` go to the avatar sink / speech scheduler. This enforces
   D006 at the output boundary. The character's `outputProtocol.allowDelay`
   gates `<|DELAY:n|>` pauses.
5. **Migrate the card (separate, lower-priority change):** move the ACT protocol
   from `creator_notes` into `extensions.dc_bot.outputProtocol` (and optionally
   add `voice.referenceAudio` + `asr.hotwords`). The registry already handles a
   card with OR without `extensions.dc_bot`, so this migration is non-breaking
   and can happen after the runtime is adopted.
6. **ASR hotwords (Wave 2B/5):** once `AsrInput.prompt` is wired, pass
   `runtime.asr.hotwords` to the ASR provider.

## Follow-up items

- Wave 6A: full output-protocol module wiring (streaming `TurnOutput` from raw
  LLM text via `parseActV1`) — the parser foundation is here and tested.
- Wave 2B/5: feed `runtime.asr.hotwords` into `AsrInput.prompt`.
- Wave 4: the compiler already accepts `memories: MemoryRecord[]`; wire the
  memory retriever's output into `compile()` once the memory subsystem lands.
- Integration Lead: migrate `creator_notes` ACT protocol →
  `extensions.dc_bot.outputProtocol` on the LIVE card (non-breaking; registry
  handles both shapes).
- Optional: once `config().character` is added, tighten the
  `readConfigCharacterRoot` double-cast to a typed read (cosmetic; the cast is
  the documented compatibility seam and is safe).
