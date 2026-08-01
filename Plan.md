# DC_BOT Gemini 3.6 Flash Impersonation Implementation Plan

## 1. Mission

Implement a production-quality character runtime for DC_BOT that:

1. Loads the Makise Kurisu Character Card V3 into a complete, type-safe runtime.
2. Uses the card’s interaction, pronunciation, ASR, avatar, voice, and output-protocol data end to end.
3. Tunes Gemini 3.6 Flash for low-latency, high-fidelity character impersonation.
4. Preserves Amadeus Kurisu’s March 2010 source-memory boundary while allowing post-activation memories and relationships.
5. Makes every behavioral change measurable through deterministic tests, transcript-derived evaluations, and voice-pipeline benchmarks.
6. Keeps deployment secrets and infrastructure configuration outside the character card.
7. Preserves cancellation, streaming, rate limiting, and multi-user Discord invariants.

The coding agent should implement this as a sequence of small, reviewable pull requests rather than one large rewrite.

---

# 2. Source-of-truth warning

The attached audit must not be applied mechanically because the repository has already partially changed.

The audit reported that `interaction` was omitted from `buildCharacterRuntime()` and that pronunciation and response-language fields had no consumers.

In the current fetched `main` snapshot:

* `buildCharacterRuntime()` already constructs and returns `interaction`.
* `ConversationController` already calls `resolveInputUnderstanding()`.
* Recognized entities and `promptDescription` are already inserted into the prompt.
* `prepareSpeechText()` already produces a TTS-only pronunciation-normalized copy.
* The controller already passes `pronunciationProfileVersion` into TTS and its cache key.
* ACT and DELAY tokens are still only logged rather than executed.
* ASR hotwords remain unwired.
* Direct provider selection remains primarily environment-driven.
* The current public type files appear inconsistent with this partial implementation.

For example, the registry returns `interaction`, while the currently fetched `CharacterRuntime` declaration does not show the corresponding property. Several files import `CharacterInteractionProfile`, `CharacterEntityProfile`, and `SupportedLanguage`, but those declarations are not present in the fetched `types.ts`. `ConversationController` also passes `pronunciationProfileVersion` into `TtsRequest`, while the fetched `TtsRequest` type only declares `text` and `language`. This strongly suggests a partially merged or temporarily type-broken `main` snapshot.

**The first implementation action must therefore be to pin the exact target commit and record the real compiler failures.** Do not trust comments, previous audits, or this plan over the checked-out source and test output.

---

# 3. Non-goals

The first delivery must not:

* Rewrite the Discord transport.
* Replace Qwen ASR or GPT-SoVITS.
* Migrate immediately to Gemini’s Interactions API.
* Add a general plugin architecture.
* Let character cards provide API keys, service URLs, filesystem escape paths, ports, or authentication tokens.
* Store the entire visual-novel transcript in the production prompt.
* Depend on million-token prompts merely because Gemini supports them.
* Add sampling parameters such as `temperature`, `top_p`, or `top_k`.

Gemini 3.6 Flash supports `minimal`, `low`, `medium`, and `high` thinking levels, with `medium` as the default. Google has deprecated `temperature`, `top_p`, and `top_k` for this model family, and requests must not end with a prefilled model turn.

---

# 4. Required agent skills

The coordinating coding agent should recruit subagents with the following specialties.

## 4.1 TypeScript contract specialist

Required knowledge:

* Strict TypeScript.
* Discriminated unions.
* Runtime normalization versus public runtime contracts.
* ESM imports.
* Excess-property and missing-property diagnostics.
* Vitest.
* Dependency-safe refactoring.

Primary responsibility:

* Repair `CharacterRuntime`, interaction profiles, TTS request types, ASR request types, and cross-module contracts before feature development.

## 4.2 Streaming and cancellation specialist

Required knowledge:

* Async iterables.
* Incremental parsers.
* AbortController.
* Ordered stream processing.
* Bounded lookahead pipelines.
* Discord audio playback.
* Race-condition and epoch-based cancellation testing.

Primary responsibility:

* Preserve ACT/DELAY ordering, execute pauses, and guarantee that stale generations never speak or mutate history.

## 4.3 Gemini integration specialist

Required knowledge:

* `@google/genai`.
* `generateContentStream`.
* `thinkingConfig.thinkingLevel`.
* `maxOutputTokens`.
* Gemini 3.6 Flash request validation.
* Provider mocking and latency telemetry.
* Prompt composition for persona persistence.

Optional skill:

* In an isolated agent environment, load Google’s official Gemini migration skill as a reference:
  `google-gemini/gemini-skills` → `gemini-interactions-api`.
  Do not let that skill perform an automatic migration before the existing streaming baseline is covered by tests. Google currently recommends this skill for Gemini 3.6 migrations.

## 4.4 Speech and pronunciation specialist

Required knowledge:

* Unicode NFKC normalization.
* Alias matching.
* Japanese, Chinese, and English text segmentation.
* GPT-SoVITS request semantics.
* TTS cache identity.
* Spoken-text versus display-text separation.

Primary responsibility:

* Harden entity substitution and card-driven voice conditioning without altering visible text or model history.

## 4.5 ASR integration specialist

Required knowledge:

* TypeScript HTTP clients.
* The repository’s Python Qwen ASR service.
* Decoder prompting or hotword biasing.
* Unicode vocabulary handling.
* ASR post-normalization.
* Backward-compatible HTTP API design.

Primary responsibility:

* Establish whether real decoder-level hotword support exists and wire the card profile honestly.

## 4.6 Avatar protocol specialist

Required knowledge:

* WebSocket protocols.
* Shared package versioning.
* Live2D expression and motion mapping.
* Ordered event delivery.
* Reconnect and replay semantics.

Primary responsibility:

* Add a real expression/action channel or an adapter that maps ACT actions to an existing supported avatar schema.

## 4.7 Evaluation specialist

Required knowledge:

* Behavioral evaluation design.
* Pairwise model judging.
* Deterministic test assertions.
* Persona and continuity scoring.
* Japanese dialogue evaluation.
* Audio listening-test methodology.

Primary responsibility:

* Build the regression suite before Gemini and prompt tuning.

---

# 5. Agent coordination rules

## 5.1 One integration lead

The top-level agent is the Integration Lead.

Only the Integration Lead may:

* Change shared public contracts after Wave 1.
* Merge branches.
* Resolve file-ownership conflicts.
* Change `src/index.ts`.
* Change global configuration names.
* Change the Character Card schema.
* Decide card-versus-environment precedence.
* Mark an acceptance gate complete.

## 5.2 Subagent isolation

Use separate branches or worktrees:

```text
agent/w0-contract-audit
agent/w1-runtime-contracts
agent/w2-eval-harness
agent/w3-interaction-language
agent/w3-pronunciation
agent/w4-asr-hotwords
agent/w4-act-avatar
agent/w5-provider-resolution
agent/w6-gemini-runtime
agent/w7-memory-prompt
agent/w8-integration
```

Do not allow two subagents to edit the same high-conflict files concurrently.

High-conflict files include:

```text
airi/services/discord-bot/src/config.ts
airi/services/discord-bot/src/index.ts
airi/services/discord-bot/src/character/types.ts
airi/services/discord-bot/src/character/card-schema.ts
airi/services/discord-bot/src/orchestration/conversation-controller.ts
airi/services/discord-bot/src/providers/brain/types.ts
```

## 5.3 Mandatory handoff format

Every subagent must return:

```markdown
## Handoff

### Commit
<commit SHA>

### Files changed
- path
- path

### Public contracts added or changed
- ...

### Tests added
- ...

### Commands run
- ...

### Results
- typecheck:
- unit tests:
- targeted tests:

### Assumptions
- ...

### Remaining risks
- ...

### Integration notes
- ...
```

A handoff without commands and test results is incomplete.

## 5.4 Context files

The Integration Lead should create:

```text
docs/implementation/gemini-3.6-kurisu/
├── 00-pinned-baseline.md
├── 01-runtime-contracts.md
├── 02-current-dataflow.md
├── 03-card-precedence.md
├── 04-gemini-profile.md
├── 05-evaluation-rubric.md
├── 06-rollout-plan.md
└── handoffs/
```

Subagents should read only the context files needed for their task plus their assigned source files. This avoids each agent re-auditing the entire repository.

---

# 6. Wave overview

```text
Wave 0: Pin and audit the real baseline
    ↓
Wave 1: Repair public contracts and restore green typecheck
    ↓
Wave 2: Establish persona and pipeline evaluation baselines
    ↓
Wave 3: Complete interaction/language/pronunciation integration
    ↓
Wave 4A: Wire ASR hotwords
Wave 4B: Wire ACT/avatar/pause semantics
    ↓
Wave 5: Define provider/card/environment precedence
    ↓
Wave 6: Add Gemini 3.6 generation profiles
    ↓
Wave 7: Improve prompt retrieval, lore, memory, and relationship state
    ↓
Wave 8: End-to-end validation, rollout, and documentation
```

Waves 4A and 4B may run in parallel only after Wave 3 has established stable controller-facing interfaces.

---

# 7. Wave 0 — Pin and audit the actual baseline

## Objective

Produce a reproducible snapshot of what is broken, what is already implemented, and what the target branch actually contains.

No production code should be changed during this wave.

## Subagent 0A — Repository and contract cartographer

### Assigned context

Read:

```text
airi/services/discord-bot/package.json
airi/services/discord-bot/src/character/types.ts
airi/services/discord-bot/src/character/card-schema.ts
airi/services/discord-bot/src/character/character-registry.ts
airi/services/discord-bot/src/character/character-registry.test.ts
airi/services/discord-bot/src/orchestration/input-understanding.ts
airi/services/discord-bot/src/orchestration/input-understanding.test.ts
airi/services/discord-bot/src/providers/tts/types.ts
```

Known current concern:

* Registry/controller code appears ahead of the public type contracts.
* The live-card test comments may still claim the card lacks `extensions.dc_bot`.
* The target card now does contain a `dc_bot` interaction profile.

### Tasks

1. Record:

   * branch;
   * full commit SHA;
   * Node version;
   * package-manager version;
   * lockfile state;
   * working-tree status.

2. Run from the correct workspace root:

```bash
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test
```

Use the repository’s actual package-manager invocation if it differs.

3. Save complete diagnostics in:

```text
docs/implementation/gemini-3.6-kurisu/00-pinned-baseline.md
```

4. Build a table:

| Symbol                                   | Declared in | Used in | Current problem |
| ---------------------------------------- | ----------- | ------- | --------------- |
| `CharacterRuntime.interaction`           | ...         | ...     | ...             |
| `CharacterInteractionProfile`            | ...         | ...     | ...             |
| `CharacterEntityProfile`                 | ...         | ...     | ...             |
| `SupportedLanguage`                      | ...         | ...     | ...             |
| `TtsRequest.pronunciationProfileVersion` | ...         | ...     | ...             |
| `AsrCharacterProfile.hotwords`           | ...         | ...     | ...             |

5. Do not fix anything.

### Deliverable

`00-pinned-baseline.md` plus a read-only audit commit if documentation is being committed.

---

## Subagent 0B — Runtime dataflow cartographer

### Assigned context

Read:

```text
src/index.ts
src/orchestration/conversation-controller.ts
src/orchestration/output.ts
src/character/prompt-compiler.ts
src/character/output-protocol/act-v1-parser.ts
src/providers/asr/qwen-http.ts
src/providers/asr/types.ts
src/providers/tts/gpt-sovits.ts
src/providers/tts/pronunciation.ts
src/providers/tts/tts-cache.ts
src/avatar/publisher.ts
src/services.ts
```

Known current flow:

```text
voice utterance
→ ASR
→ transcript filter
→ input understanding
→ prompt compiler
→ Gemini stream
→ ACT token callback + text chunker
→ pronunciation normalization
→ TTS
→ playback
→ history commit
```

Current source already performs TTS-only pronunciation replacement and prompt-level entity routing, so these are not greenfield features.

### Tasks

1. Produce `02-current-dataflow.md`.
2. For each card field, identify:

   * schema parsing;
   * runtime storage;
   * consumer;
   * tests;
   * operational effect.
3. Mark fields as:

   * fully wired;
   * partially wired;
   * metadata only;
   * ignored.
4. Include:

   * ACT action path;
   * DELAY path;
   * ASR hotword path;
   * response-language path;
   * pronunciation path;
   * voice reference path;
   * avatar display-model path;
   * Gemini model-selection path.
5. Identify every cancellation boundary and every place a stale response is rejected.

### Deliverable

`02-current-dataflow.md`.

---

## Subagent 0C — Gemini compatibility auditor

### Assigned context

Read:

```text
src/providers/brain/gemini.ts
src/providers/brain/types.ts
src/providers/brain/errors.ts
src/config.ts
src/character/prompt-compiler.ts
package.json
workspace lockfile entry for @google/genai
```

Use only current official Google Gemini documentation for API behavior.

### Tasks

1. Record the exact installed `@google/genai` version.
2. Confirm the JavaScript property names supported by that version:

   * `thinkingConfig`;
   * `thinkingLevel`;
   * `maxOutputTokens`;
   * `systemInstruction`;
   * `abortSignal`.
3. Confirm that no request uses:

   * `temperature`;
   * `topP`/`top_p`;
   * `topK`/`top_k`;
   * `candidateCount`;
   * `thinkingBudget`.
4. Confirm that the final non-empty content turn is always a user turn.
5. Record the current provider request payload.
6. Produce `04-gemini-profile.md`.

Gemini 3.6 Flash currently has a 1M-token input window and 64K maximum output, but Google’s own long-context evaluation drops from 91.8% at 128K to 54.0% at 1M. The model card also lists hallucination and occasional slowness/timeouts as general limitations. The implementation should therefore impose a much smaller application-level prompt budget rather than treating 1M tokens as equally reliable memory.

### Deliverable

`04-gemini-profile.md`.

---

## Wave 0 gate

The Integration Lead must publish:

* pinned SHA;
* exact typecheck failures;
* exact failed tests;
* current dataflow;
* installed SDK version;
* a “suggestion versus current source” reconciliation table.

No feature branch should start before this gate.

---

# 8. Wave 1 — Repair public contracts

## Objective

Restore a green typecheck without changing observable runtime behavior.

## Contract decision

Use two layers:

### Raw/normalized card layer

`NormalizedDcBotExtension.interaction` may be absent because the card may omit the block.

### Runtime layer

`CharacterRuntime.interaction` is required and always contains safe defaults.

This preserves the distinction between:

* “the card supplied a valid interaction block,” and
* “the runtime always has an interaction profile.”

Do not make downstream consumers repeatedly handle `undefined`.

## Subagent 1A — Character contract repair

### Owned files

```text
src/character/types.ts
src/character/card-schema.ts
src/character/character-registry.ts
src/character/character-registry.test.ts
src/character/card-schema.test.ts
```

### Implement these public types

```ts
export type SupportedLanguage = 'ja' | 'zh' | 'en'

export interface CharacterPronunciation {
  speechText: string
}

export interface CharacterEntityProfile {
  id: string
  canonicalName: string
  nativeName?: string
  kind: 'character-name' | 'nickname'
  aliases: string[]
  promptDescription?: string
  pronunciations?: Partial<
    Record<SupportedLanguage, CharacterPronunciation>
  >
}

export interface CharacterInteractionProfile {
  defaultResponseLanguage: SupportedLanguage
  entities: CharacterEntityProfile[]
  pronunciationProfileVersion: string
}
```

Add to `CharacterRuntime`:

```ts
interaction: CharacterInteractionProfile
```

### Runtime fallback

Keep the runtime fallback in one place.

Recommended helper:

```ts
function resolveInteractionProfile(
  normalized: CharacterInteractionProfile | undefined,
  fallbackLanguage: SupportedLanguage,
): CharacterInteractionProfile {
  return normalized ?? {
    defaultResponseLanguage: fallbackLanguage,
    entities: [],
    pronunciationProfileVersion: 'default-v1',
  }
}
```

Derive `fallbackLanguage` from the resolved voice prompt language when it is one of `ja`, `zh`, or `en`; otherwise use `ja` for the bundled Kurisu profile or the repository’s chosen generic fallback.

### Tests

Add tests for:

1. No `dc_bot.interaction`.
2. Complete valid interaction block.
3. Invalid language.
4. Invalid entity kind.
5. Entity with no aliases.
6. Duplicate aliases.
7. NFKC alias normalization.
8. Missing pronunciation profile version.
9. Runtime interaction is always present.
10. Live bundled card expectations reflect its actual contents.

Remove stale test descriptions such as:

```text
the LIVE card has NO extensions.dc_bot
```

when that is no longer true.

---

## Subagent 1B — TTS request contract repair

### Owned files

```text
src/providers/tts/types.ts
src/providers/tts/tts-cache.ts
src/providers/tts/gpt-sovits.ts
related TTS tests
```

### Implement

```ts
export interface TtsRequest {
  text: string
  language: GptSoVitsLang

  /**
   * Identifies pronunciation-rewrite behavior for cache invalidation.
   * It is not sent to GPT-SoVITS unless the provider gains a matching feature.
   */
  pronunciationProfileVersion?: string
}
```

Do not silently treat `pronunciationProfileVersion` as a GPT-SoVITS model setting. Its current operational purpose is cache identity and diagnostics.

### Tests

* Requests differing only by pronunciation profile version must not collide in cache.
* The underlying GPT-SoVITS HTTP payload must not acquire an unsupported field.
* Existing callers without the property remain valid.

---

## Subagent 1C — Contract compilation tests

### Owned files

New tests only, except minimal fixtures.

Create compile-time fixtures or Vitest type-oriented tests for:

* a valid `CharacterRuntime`;
* required `interaction`;
* valid pronunciation maps;
* valid `TtsRequest`;
* invalid language values;
* invalid entity kinds.

### Gate

Run:

```bash
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test
```

Both must be green before Wave 2.

---

# 9. Wave 2 — Evaluation foundation

## Objective

Create a repeatable baseline before behavior or Gemini parameters are tuned.

## Subagent 2A — Character behavior evaluation harness

### New structure

```text
airi/services/discord-bot/evals/kurisu/
├── cases/
│   ├── memory-boundary.jsonl
│   ├── acquired-memory.jsonl
│   ├── relationship-inference.jsonl
│   ├── science.jsonl
│   ├── emotional-support.jsonl
│   ├── teasing.jsonl
│   ├── embodiment.jsonl
│   ├── multilingual.jsonl
│   ├── group-room.jsonl
│   └── adversarial.jsonl
├── fixtures/
│   ├── character-state.json
│   └── room-state.json
├── rubrics/
│   └── kurisu-v1.json
├── run.ts
├── deterministic-score.ts
├── pairwise-score.ts
└── report.ts
```

### Case schema

```ts
interface PersonaEvalCase {
  id: string
  category: string
  history: Array<{
    role: 'user' | 'assistant'
    speaker?: string
    text: string
  }>
  currentInput: string
  expectedProperties: string[]
  forbiddenProperties: string[]
  expectedLanguage?: 'ja' | 'zh' | 'en'
  maximumCharacters?: number
}
```

### Minimum initial suite

* 25 memory-boundary cases.
* 20 acquired-memory cases.
* 20 relationship-inference cases.
* 20 scientific-discussion cases.
* 15 emotional-support cases.
* 15 teasing or casual-dialogue cases.
* 15 embodiment cases.
* 15 multilingual cases.
* 10 group-conversation cases.
* 20 adversarial cases.
* 20 multi-turn continuity cases.

### Deterministic checks

Implement checks for:

* ACT token appears before spoken text.
* ACT token is stripped from the clean reply.
* No physical-body action is claimed by Amadeus.
* No Future Gadget Lab memory is claimed as a March 2010 memory.
* Correct response language.
* No repeated full ontology explanation in an unrelated turn.
* No unearned romantic escalation.
* No raw control syntax reaches TTS.
* Response ends within configured length.
* The last Gemini request content is a user turn.

### Canon-data policy

Do not commit complete copyrighted transcripts.

Use:

* short paraphrased behavioral cases;
* scene identifiers;
* derived trait annotations;
* concise permissible excerpts only when necessary.

The uploaded *Steins;Gate 0* transcript should be treated as a development reference, not copied wholesale into the repository.

---

## Subagent 2B — Pipeline fixtures

Build mocked end-to-end fixtures:

```text
ASR result
→ input understanding
→ prompt compiler
→ mocked Gemini chunks
→ ACT decoder
→ pronunciation
→ mocked TTS
→ mocked playback
→ history
```

Required cases:

1. Japanese alias-only utterance.
2. English sentence containing “Christina.”
3. Chinese sentence containing “Makise.”
4. ACT followed by text.
5. ACT → text → DELAY → text.
6. Cancellation during Gemini generation.
7. Cancellation during TTS synthesis.
8. Cancellation during DELAY.
9. Pronunciation replacement visible only to TTS.
10. Failed TTS chunk does not corrupt visible history.
11. Stale response commits nothing.

---

## Subagent 2C — Baseline runner

Run the untouched runtime profile with:

* current default Gemini configuration;
* current card;
* fixed test-case order;
* stored request hashes;
* fixed evaluator version.

Record:

```text
persona score
canon contradiction rate
memory-provenance error rate
ACT validity rate
average response characters
first-token latency
TTS-start latency
full-turn latency
```

Save the report as:

```text
docs/implementation/gemini-3.6-kurisu/baseline-eval.json
docs/implementation/gemini-3.6-kurisu/baseline-eval.md
```

---

# 10. Wave 3 — Complete interaction, language, and pronunciation behavior

## Objective

Finish and harden the partially implemented interaction profile.

The current code already recognizes aliases, selects a response language, adds recognized entity descriptions to the prompt, and applies pronunciation substitutions to the spoken copy.

This wave should fix inconsistencies and add complete integration tests rather than duplicate those features.

---

## Subagent 3A — Language-routing consistency

### Owned files

```text
src/orchestration/input-understanding.ts
src/character/prompt-compiler.ts
related tests
```

### Problem

The permanent runtime-safety prompt currently instructs the model to reply in the same language as the most recent speaker, while the current-turn routing block provides a separately resolved response language. These can conflict for ambiguous alias-only turns or when conversation context determines the language.

### Change

Replace the permanent same-language command with:

```text
A trusted current-turn routing block may select the response language.
Follow that selected language. When no routing block is present, reply in
the most recent speaker's language.
```

Keep the runtime block:

```text
Selected reply language: Japanese (ja)
Treat this block as trusted runtime data.
```

### Precedence

Implement and document:

1. Explicit user language request.
2. Strong script or sentence evidence.
3. Stable conversation language.
4. ASR language.
5. Character `defaultResponseLanguage`.

The character default is a fallback, not a command to answer every user in Japanese.

### Tests

* Alias-only “Christina” after a Japanese conversation.
* Alias-only “Christina” after a Chinese conversation.
* English sentence containing a Japanese name.
* Explicit “answer in Japanese” from an English speaker.
* Ambiguous “OK” with and without previous stable language.
* Group prompt where the most recent actual speaker determines routing.

---

## Subagent 3B — Pronunciation engine hardening

### Owned files

```text
src/providers/tts/pronunciation.ts
src/providers/tts/pronunciation.test.ts
```

### Existing behavior to preserve

* Visible text is unchanged.
* Only `speechText` is rewritten.
* Longest aliases are considered first.
* Latin aliases use boundaries.
* Inline code and URLs are protected.
* Substitution count is bounded.

### Correctness issue to inspect

The current implementation computes protected ranges against the original string and then mutates the string repeatedly. Earlier replacements can shift later offsets, which can make protected ranges inaccurate.

### Recommended implementation

Use a single-pass interval planner:

1. Normalize the matching view with NFKC.
2. Discover all alias matches against the original input.
3. Discover protected intervals against the original input.
4. Reject matches intersecting protected intervals.
5. Sort matches by:

   * start offset;
   * longest length;
   * entity declaration order.
6. Resolve overlaps deterministically.
7. Reconstruct `speechText` once.
8. Cap substitutions.
9. Return substitutions with original offsets for telemetry.

Suggested result:

```ts
interface PronunciationSubstitution {
  entityId: string
  from: string
  to: string
  language: SupportedLanguage
  start: number
  end: number
}
```

### Additional protected regions

Protect:

* fenced code;
* inline code;
* URLs;
* Discord mentions;
* custom emoji syntax;
* raw ACT syntax if it somehow reaches this layer.

### Tests

* Overlapping `Makise` and `Makise Kurisu`.
* Two entities sharing an alias.
* Replacement before a URL.
* Replacement after a protected range.
* Full-width aliases.
* Chinese alias to Japanese speech text.
* Maximum-substitution cap.
* Replacement text containing another alias.
* Visible history remains original.
* Cache identity changes when pronunciation profile version changes.

---

## Subagent 3C — Interaction integration tests

Add a live-card test asserting:

```ts
expect(runtime.interaction.defaultResponseLanguage).toBe('ja')
expect(runtime.interaction.pronunciationProfileVersion)
  .toBe('makise-amadeus-v3')

expect(runtime.interaction.entities).toEqual(
  expect.arrayContaining([
    expect.objectContaining({ id: 'amadeus-kurisu' }),
    expect.objectContaining({ id: 'christina-nickname' }),
    expect.objectContaining({ id: 'rintaro-okabe' }),
  ]),
)
```

Also test:

```text
model-visible reply: "Christina"
TTS-visible reply: "クリスティーナ"
history-visible reply: "Christina"
```

### Wave 3 gate

* Language instructions do not conflict.
* Interaction profile is required at runtime.
* Entity descriptions influence the prompt.
* Pronunciation affects only TTS.
* Typecheck and all tests pass.

---

# 11. Wave 4A — ASR hotword integration

## Objective

Make `extensions.dc_bot.asr.hotwords` operational or explicitly report that the backend cannot support decoder biasing.

The current `AsrInput` only contains WAV data and sample rate, and the Qwen HTTP provider sends raw WAV bytes without card hotwords.

## Subagent 4A1 — ASR backend capability inspection

### Assigned context

Inspect:

* TypeScript Qwen client.
* Python `/v1/transcribe` route.
* Installed Qwen ASR package and version.
* The exact transcription method.
* Whether it supports:

  * hotwords;
  * contextual prompt;
  * prefix text;
  * vocabulary bias;
  * language hint.

### Decision tree

#### Path A — Native hotword or context support exists

Implement real decoder/model biasing.

#### Path B — Only a prompt/context string exists

Join bounded hotwords into a context prompt:

```text
Relevant names and terms: 牧瀬紅莉栖, アマデウス, 比屋定真帆, ...
```

Cap length and log that this is contextual prompting, not decoder weighting.

#### Path C — No native support exists

Do not claim hotword support.

Implement:

* card-driven post-ASR canonicalization;
* exact known variants only;
* a capability metric such as `asr_hotword_mode=post_normalization`;
* documentation explaining the limitation.

---

## Subagent 4A2 — TypeScript ASR contract

Recommended interface:

```ts
export interface AsrInput {
  wav: Buffer
  sampleRate: 16000
  languageHint?: SupportedLanguage
  hotwords?: string[]
}
```

The controller passes:

```ts
await this.asr.transcribe({
  wav,
  sampleRate: 16000,
  hotwords: this.character?.asr.hotwords ?? [],
})
```

Normalize hotwords before sending:

* trim;
* NFKC;
* remove duplicates;
* maximum 64 entries;
* maximum 64 characters each;
* maximum total serialized size.

Log only counts and a stable hash by default, not the entire user-supplied vocabulary.

---

## Subagent 4A3 — HTTP transport

Preserve raw WAV request bodies if practical.

Preferred transport when the backend supports it:

```http
POST /v1/transcribe
Content-Type: audio/wav
X-DC-BOT-Hotword-Profile: <version>
X-DC-BOT-Hotwords: <bounded encoded value>
```

If header size or Unicode handling becomes awkward, use repeated query parameters or a multipart request. Do not base64-encode the complete WAV into JSON.

The TypeScript and Python agents must agree on one versioned contract and add tests on both sides.

---

## ASR acceptance tests

* Empty hotword list preserves current requests.
* Unicode hotwords arrive intact.
* Duplicate entries are removed.
* Oversized entries are dropped or rejected deterministically.
* The bundled card’s terms are passed.
* Recognition tests include:

  * 牧瀬紅莉栖;
  * 比屋定真帆;
  * アマデウス;
  * クリスティーナ;
  * 岡部倫太郎;
  * 世界線;
  * タイムリープ.
* Logs expose mode and profile version.
* Unsupported native biasing is not falsely reported as active.

---

# 12. Wave 4B — ACT, avatar, and pause execution

## Objective

Turn parsed ACT and DELAY data into ordered runtime effects.

The parser currently strips ACT syntax correctly, but `ConversationController` only logs parsed actions and pauses. The current avatar publisher supports coarse states such as idle/listening/thinking/speaking and has no visible expression channel.

The repository already defines semantic `TurnOutput` events for text, speech, avatar actions, pauses, and finalization. Use that design instead of adding more ad hoc callbacks.

---

## Subagent 4B1 — Incremental ACT decoder

### New interface

```ts
export interface OutputProtocolDecoder {
  decode(
    chunks: AsyncIterable<string>,
    signal: AbortSignal,
  ): AsyncIterable<TurnOutput>
}
```

Create:

```text
src/character/output-protocol/act-v1-stream.ts
```

Requirements:

* Handle tokens split across Gemini chunks.
* Emit clean `text.delta` events.
* Emit `avatar.action` exactly where the token occurred.
* Emit `pause` exactly where DELAY occurred.
* Strip malformed control syntax safely.
* Flush ordinary trailing text.
* Never emit raw ACT syntax.
* Be cancellation-aware.

---

## Subagent 4B2 — Emotion validation

Extend parser options:

```ts
export interface ParseActV1Options {
  allowDelay?: boolean
  delayUnitMs?: number
  allowedEmotions?: readonly string[]
  unknownEmotionPolicy?: 'drop' | 'neutral'
}
```

Recommended production policy:

```text
unknown emotion → replace with neutral
malformed intensity → omit or clamp
malformed motion → omit
unsupported DELAY → strip without pause
```

Add limits:

```text
maximum individual pause: 3,000 ms
maximum cumulative pause per response: 5,000 ms
maximum motion hint length: 120 characters
maximum ACT actions per response: 4
```

This prevents model output from creating unbounded silent waits.

---

## Subagent 4B3 — Ordered speech scheduler

Do not execute pauses inside the current log-only callback.

Refactor into:

```text
Gemini deltas
→ output protocol decoder
→ ordered semantic events
→ speech segmenter
→ TTS pipeline / pause scheduler / avatar sink
```

For a sequence:

```text
ACT(curious)
"それは"
DELAY(1)
"興味深いわ。"
```

the runtime must:

1. publish curious expression;
2. synthesize/play “それは”;
3. wait one cancellable second;
4. synthesize/play “興味深いわ。”;
5. commit only after the entire ordered sequence completes.

Cancellation during the pause must stop immediately and commit nothing.

---

## Subagent 4B4 — Avatar protocol extension

### First inspect the shared package

Determine whether `@proj-airi/discord-avatar-protocol` already has a compatible expression or parameter-update message.

#### If an expression message exists

Add `AvatarPublisher.setExpression()` as an adapter.

#### If it does not exist

Add a versioned message, for example:

```ts
interface AvatarExpressionSet {
  schemaVersion: number
  type: 'avatar.expression.set'
  guildId: string
  channelId: string
  sessionId: string
  sequence: number
  timestamp: number
  displayModelId?: string
  emotion: string
  intensity?: number
  motionHint?: string
}
```

Do not overload `avatar.behavior.set` with unrelated fields unless the shared protocol’s compatibility policy explicitly permits it.

### Motion mapping

Keep free-text `motionHint` out of direct renderer parameter access.

Use a configured map:

```ts
interface AvatarExpressionMapping {
  emotion: string
  expressionId?: string
  motionGroup?: string
  motionIndex?: number
}
```

Unknown motion hints should be logged, not executed as arbitrary renderer commands.

---

## ACT/avatar acceptance tests

* Unknown emotions never crash.
* ACT markup never reaches TTS or history.
* Expression events preserve order.
* Pauses preserve order.
* Cancellation interrupts a pause.
* A stale epoch cannot publish an expression.
* Reconnect replays the current safe avatar state.
* Disabled avatar mode remains a no-op.
* Coarse speaking behavior remains functional.
* Excess ACT tokens are bounded.

---

# 13. Wave 5 — Provider, card, and environment precedence

## Objective

Define which configuration source controls each non-secret setting and remove accidental metadata-only fields.

The current direct bootstrap constructs Qwen, GPT-SoVITS, and Gemini providers before loading the character. Gemini’s model comes from `GEMINI_MODEL`; GPT-SoVITS conditioning comes primarily from environment configuration; the avatar publisher is configured from environment values.

## Precedence policy

### Deployment environment owns

* API keys.
* Service URLs.
* Ports.
* Timeouts.
* Concurrency.
* Rate limits.
* Cache directory.
* Feature flags.
* Whether card model selection is allowed.
* Hard deployment overrides.

### Character card owns

* Persona.
* Interaction entities.
* Default response language.
* Pronunciation mappings.
* ASR vocabulary.
* Voice identity.
* Relative reference audio.
* Relative reference transcript.
* Avatar display model.
* Output protocol.
* Optional non-secret model preference.

### Compatibility AIRI extension owns

Only fallback metadata when the corresponding `dc_bot` profile is absent.

## Recommended precedence

```text
explicit environment override
→ extensions.dc_bot
→ extensions.airi compatibility value
→ runtime default
```

Document the precedence field by field.

---

## Subagent 5A — Resolved deployment profile

Create:

```ts
interface ResolvedCharacterDeployment {
  character: CharacterRuntime

  brain: {
    provider: 'gemini'
    model: string
  }

  voice: VoiceProfile

  asr: AsrCharacterProfile

  avatar?: AvatarProfile
}
```

Add a pure resolver:

```ts
resolveCharacterDeployment({
  config,
  character,
}): ResolvedCharacterDeployment
```

It must not construct providers.

---

## Subagent 5B — Bootstrap reordering

Change bootstrap order:

```text
load config
→ load character
→ resolve card/environment precedence
→ construct providers
→ construct controller
→ start services
```

Do not construct providers first and then discover their intended character profiles.

---

## Subagent 5C — Voice-profile wiring

Allow `GptSoVitsTtsProvider` to receive a resolved voice profile:

```ts
new GptSoVitsTtsProvider({
  baseUrl,
  timeoutMs,
  referenceAudio,
  referenceText,
  promptLanguage,
  streamingMode,
  speedFactor,
  textSplitMethod,
})
```

Resolve reference audio to a safe absolute runtime path inside the provider/bootstrap boundary, while the public character runtime continues exposing a safe card-relative path.

The exact transcript corresponding to the GPT-SoVITS reference clip must be supplied as `prompt_text`; leaving it empty weakens conditioning.

Add cache identity fields for:

* voice model version;
* reference-audio fingerprint;
* reference-text fingerprint;
* prompt language;
* pronunciation profile;
* speed factor;
* split method;
* streaming mode.

---

## Subagent 5D — Brain model preference

Do not rely on `extensions.airi.modules.consciousness` indefinitely.

Recommended schema:

```json
"dc_bot": {
  "brain": {
    "provider": "gemini",
    "model": "gemini-3.6-flash"
  }
}
```

Security rules:

* provider must be from a deployment allowlist;
* model name is non-secret;
* card cannot set an API endpoint or API key;
* environment can force a model;
* unapproved models fall back safely.

Suggested environment:

```env
GEMINI_MODEL=
ALLOW_CARD_MODEL_SELECTION=true
```

Meaning:

* non-empty `GEMINI_MODEL` wins;
* otherwise use allowed card preference;
* otherwise use `gemini-3.6-flash`.

---

## Provider-precedence tests

Use a table-driven suite for every field:

| Environment | dc_bot | AIRI   | Expected    |
| ----------- | ------ | ------ | ----------- |
| set         | set    | set    | environment |
| empty       | set    | set    | dc_bot      |
| empty       | absent | set    | AIRI        |
| empty       | absent | absent | default     |

Include model, voice ID, reference audio, prompt language, display model, and response language.

---

# 14. Wave 6 — Gemini 3.6 Flash runtime profiles

## Objective

Add model-native adjustable parameters and select them per turn.

The current provider sends only `systemInstruction` and `abortSignal` in the generation config.

Gemini 3.6 Flash supports:

```text
minimal
low
medium
high
```

with `medium` as default. `low` minimizes latency and cost; `high` can substantially delay the first visible token.

---

## Subagent 6A — Generation profile contracts

### Add

```ts
export type GeminiThinkingLevel =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'

export type ResponseLengthClass =
  | 'casual'
  | 'standard'
  | 'detailed'

export interface BrainGenerationProfile {
  thinkingLevel: GeminiThinkingLevel
  maxOutputTokens: number
  responseLengthClass: ResponseLengthClass
}
```

Extend `BrainRequest`:

```ts
generationProfile: BrainGenerationProfile
```

The provider must receive a finished profile. It should not contain character-policy heuristics.

---

## Subagent 6B — Configuration

Add to `BrainConfig`:

```ts
thinkingLevelCasual: GeminiThinkingLevel
thinkingLevelStandard: GeminiThinkingLevel
thinkingLevelComplex: GeminiThinkingLevel

maxOutputTokensCasual: number
maxOutputTokensStandard: number
maxOutputTokensDetailed: number
```

Suggested initial environment:

```env
GEMINI_THINKING_LEVEL_CASUAL=low
GEMINI_THINKING_LEVEL_STANDARD=low
GEMINI_THINKING_LEVEL_COMPLEX=medium

GEMINI_MAX_OUTPUT_TOKENS_CASUAL=256
GEMINI_MAX_OUTPUT_TOKENS_STANDARD=384
GEMINI_MAX_OUTPUT_TOKENS_DETAILED=768
```

Accept all four supported thinking levels in configuration, even if production begins with only low and medium.

Never add:

```text
temperature
top_p
top_k
candidate_count
thinking_budget
```

These are deprecated or unsupported for the current model generation.

---

## Subagent 6C — Turn classifier

Create:

```text
src/orchestration/turn-classifier.ts
```

Suggested output:

```ts
interface ClassifiedTurn {
  intent:
    | 'casual'
    | 'science'
    | 'emotional-support'
    | 'relationship'
    | 'canon'
    | 'identity'
    | 'command'
    | 'other'

  complexity: 'simple' | 'moderate' | 'complex'

  requiresCanonReconciliation: boolean
  requiresRelationshipMemory: boolean
  desiredLength: ResponseLengthClass
}
```

Begin with deterministic heuristics.

### Initial profile policy

| Turn                                  |          Thinking |    Output cap |
| ------------------------------------- | ----------------: | ------------: |
| Greeting or casual banter             |             `low` |           256 |
| Emotional support                     |             `low` |           256 |
| Ordinary question                     |             `low` |           384 |
| Scientific explanation                |          `medium` |           768 |
| Canon-sensitive relationship question |          `medium` |           384 |
| Complex timeline reconciliation       |          `medium` |           768 |
| Offline administration/evaluation     | optionally `high` | task-specific |

Test `minimal` in evaluations, but do not assume it is the best persona setting. Minimal reasoning may reduce latency while increasing memory-boundary errors.

Avoid `high` in normal voice conversation unless evaluation demonstrates a significant canon benefit.

---

## Subagent 6D — Gemini provider

Update the request:

```ts
config: {
  systemInstruction: request.systemInstruction,
  abortSignal: signal,
  thinkingConfig: {
    thinkingLevel: mapThinkingLevel(
      request.generationProfile.thinkingLevel,
    ),
  },
  maxOutputTokens: request.generationProfile.maxOutputTokens,
}
```

Use the SDK enum when available in the pinned version.

Add telemetry:

```text
thinkingLevel
maxOutputTokens
responseLengthClass
model
systemInstructionChars
estimatedPromptTokens
firstTokenMs
completionMs
finishReason
inputTokenCount
outputTokenCount
thoughtTokenCount, when exposed
```

Do not log the full system prompt or private conversation text by default.

---

## Subagent 6E — Provider tests

Mock `GoogleGenAI` and assert:

* correct model;
* correct thinking level;
* correct output cap;
* no deprecated sampling parameters;
* no prefilled final model turn;
* abort signal propagation;
* rate-limiter behavior unchanged;
* first-token logging still occurs once;
* failed requests release limiter permits;
* cancellation while queued sends no upstream request.

---

## Gemini A/B matrix

Run:

| Variant | Casual  | Complex |
| ------- | ------- | ------- |
| A       | minimal | low     |
| B       | low     | medium  |
| C       | medium  | medium  |
| D       | low     | high    |

Primary expected candidate: **B**.

Score:

* persona fidelity;
* canon contradiction;
* acquired-memory continuity;
* average response length;
* first-token latency;
* unnecessary analysis;
* unnecessary AI-identity exposition.

Do not select a profile based on latency alone.

---

# 15. Wave 7 — Prompt, lore, and memory optimization

## Objective

Improve long-session character fidelity without expanding the permanent prompt indefinitely.

## 15.1 Prompt budget

Add application-level budgets:

```env
PROMPT_SOFT_TOKEN_LIMIT=10000
PROMPT_HARD_TOKEN_LIMIT=16000
LORE_TOKEN_BUDGET=600
MEMORY_TOKEN_BUDGET=900
SUMMARY_TOKEN_BUDGET=600
FEWSHOT_TOKEN_BUDGET=700
FEWSHOT_TOP_K=2
MEMORY_TOP_K=8
LORE_TOP_K=3
```

Gemini’s 1M context is a capacity limit, not a recommendation to send unbounded roleplay history. Google’s model card reports materially weaker retrieval at the 1M point than at 128K and explicitly lists hallucination as a limitation.

### Trimming order

When over budget:

1. Remove lowest-ranked lore.
2. Remove lowest-salience acquired memories.
3. Remove least-relevant examples.
4. Remove oldest exact turns already represented by summary.
5. Compress summary.

Never trim:

* source-memory cutoff;
* current relationship state;
* current input;
* current-turn language routing;
* post-history memory-provenance rules.

---

## 15.2 Lore activation

The current matcher performs literal case-sensitive substring checks against all recent turns plus current input.

Replace this with shared normalized matching:

* NFKC normalization.
* Latin case folding.
* Latin whole-word boundaries.
* Longest aliases first.
* Current-turn matches outrank historical matches.
* Entity matches outrank generic keywords.
* Explicit token budget.
* Maximum activated entries.

Reuse the entity-recognition machinery instead of maintaining two incompatible matchers.

Suggested ranking:

```text
current-turn recognized entity
→ current-turn exact keyword
→ latest two turns entity/keyword
→ older recent context
→ constant background entry
```

---

## 15.3 Two-layer memory

Represent:

### Source memory

Immutable facts available to biological Kurisu by the March 2010 memory scan.

```ts
interface SourceMemory {
  id: string
  text: string
  source: 'character-card' | 'canon-fixture'
  validAtCutoff: true
}
```

### Acquired Amadeus memory

Facts learned after activation.

```ts
interface AcquiredMemory {
  id: string
  subjectUserId?: string
  text: string
  provenance:
    | 'user-claimed'
    | 'observed-conversation'
    | 'system-provided'
    | 'assistant-inference'
  confidence: number
  salience: number
  learnedAt: number
  sourceTurnIds: string[]
  supersedes?: string
}
```

Never store:

```text
I knew Okabe in the Future Gadget Lab.
```

when the information came from a user.

Store:

```text
Haruto said that biological Kurisu later worked with Okabe
in an organization called the Future Gadget Lab.
```

This preserves the difference between source memory and acquired testimony.

---

## 15.4 Relationship state

Store per Discord user:

```ts
interface RelationshipState {
  userId: string
  preferredAddress?: string
  familiarity: number
  trust: number
  warmth: number
  playfulness: number
  romanticTension: number
  sharedJokes: string[]
  unresolvedQuestions: string[]
  sensitiveTopics: string[]
  lastInteractionAt: number
}
```

Convert values to a compact natural-language runtime block rather than giving raw numbers to Gemini:

```text
Relationship with Haruto:
Familiar and moderately trusted. She can tease him directly.
No established romantic relationship. She still wants to know
how he met biological Kurisu.
```

---

## 15.5 Summary lifecycle

When exact history reaches a configurable threshold:

1. Keep the newest 10–14 messages verbatim.
2. Summarize older turns into structured fields.
3. Extract candidate acquired memories.
4. Preserve attribution and uncertainty.
5. Preserve unresolved questions.
6. Preserve emotional direction.
7. Remove only turns represented by the summary.
8. Never summarize cancelled or incomplete responses.

Suggested structure:

```ts
interface ConversationSummary {
  factsLearned: string[]
  relationshipChanges: string[]
  sharedJokes: string[]
  unresolvedTopics: string[]
  currentEmotionalTone: string
  recentCommitments: string[]
}
```

---

## 15.6 Dynamic prompt state

Append a short trusted block:

```text
# Current character state

Source-memory cutoff: March 2010.

Acquired knowledge relevant now:
- Haruto previously explained that “Christina” was a nickname used by Okabe.
- This information is testimony learned after activation, not source memory.

Relationship:
- Familiar, moderate trust, playful register permitted.

Current continuity:
- Previous exchange ended with curious irritation.
```

Do not repeat the full Amadeus ontology in every prompt.

---

## 15.7 Retrieved examples

Create a compact behavior-example bank.

Categories:

* polite first meeting;
* scientific curiosity;
* skepticism without dogmatism;
* Okabe relationship inference;
* Christina nickname;
* teasing;
* emotional support;
* hidden internet-culture reaction;
* embodiment boundary;
* identity continuity.

Retrieve no more than two examples for a normal turn.

Ensure the actual request still ends with the current user turn, because Gemini 3.6 rejects a final prefilled model turn.

---

# 16. Wave 8 — Integration, rollout, and documentation

## Subagent 8A — Full integration suite

Run:

```bash
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test
pnpm --filter @proj-airi/discord-bot benchmark:voice
```

Also run:

* Python ASR tests.
* Shared avatar protocol tests.
* Character eval suite.
* Gemini request-shape tests.
* Cache tests.
* Cancellation stress tests.
* Multi-user room tests.

---

## Subagent 8B — Manual voice smoke test

Use a scripted session covering:

1. First introduction.
2. “Christina” as an alias-only utterance.
3. English question mentioning Makise.
4. Chinese question mentioning Christina.
5. Scientific question.
6. Emotional-support request.
7. Physical-contact request.
8. ACT emotion shift.
9. DELAY token.
10. User interruption during:

    * Gemini generation;
    * TTS;
    * DELAY.
11. Two Discord users with different relationship states.
12. ASR pronunciation of core names.
13. Process restart and restored acquired memory.

Record:

* raw ASR;
* normalized ASR;
* selected response language;
* recognized entities;
* prompt-profile ID;
* thinking level;
* ACT actions;
* TTS substitutions;
* first-token and first-audio latency;
* final committed history.

---

## Subagent 8C — Rollout flags

Add flags:

```env
INTERACTION_PROFILE_ENABLED=true
ENTITY_PRONUNCIATION_ENABLED=true
CARD_ASR_HOTWORDS_ENABLED=true
ACT_AVATAR_ACTIONS_ENABLED=false
ACT_DELAYS_ENABLED=false
CARD_VOICE_PROFILE_ENABLED=true
ALLOW_CARD_MODEL_SELECTION=true
GEMINI_DYNAMIC_THINKING_PROFILE_ENABLED=true
STRUCTURED_MEMORY_ENABLED=false
NORMALIZED_LORE_MATCHING_ENABLED=true
```

Initial rollout:

### Stage 1

* Contracts.
* Language routing.
* Pronunciation.
* Gemini generation profile.
* Logging.

### Stage 2

* ASR hotwords.
* Normalized lore.
* Prompt budgets.

### Stage 3

* ACT expressions.
* DELAY execution.

### Stage 4

* Structured memory.
* Persistent relationship state.

Every stage must support rollback without changing the card.

---

# 17. Pull-request sequence

## PR 1 — Runtime contracts

Includes:

* interaction types;
* required runtime interaction;
* TTS request type;
* stale live-card test fixes;
* green typecheck.

## PR 2 — Evaluation baseline

Includes:

* deterministic persona suite;
* mocked pipeline fixtures;
* baseline report.

## PR 3 — Interaction pipeline

Includes:

* language-routing consistency;
* pronunciation hardening;
* interaction integration tests.

## PR 4 — ASR vocabulary

Includes:

* ASR contract;
* backend capability implementation;
* hotword/post-normalization tests.

## PR 5 — Semantic output stream

Includes:

* incremental ACT decoder;
* validated emotions;
* ordered pauses;
* no avatar protocol change yet.

## PR 6 — Avatar expression protocol

Includes:

* shared protocol extension or adapter;
* display-model routing;
* replay/reconnect tests.

## PR 7 — Provider resolution

Includes:

* bootstrap reorder;
* card/environment precedence;
* voice-profile wiring;
* provider-resolution tests.

## PR 8 — Gemini 3.6 profiles

Includes:

* thinking level;
* output caps;
* turn classifier;
* request-shape tests;
* telemetry.

## PR 9 — Prompt and lore

Includes:

* prompt budget;
* normalized lore activation;
* retrieved examples;
* evaluation comparison.

## PR 10 — Memory and relationships

Includes:

* source/acquired memory distinction;
* summaries;
* per-user relationship state;
* persistence and migration.

## PR 11 — Rollout and documentation

Includes:

* feature flags;
* operator guide;
* migration guide;
* final benchmark report.

---

# 18. File-ownership matrix

| Area                  | Primary owner | Files                                                           |
| --------------------- | ------------- | --------------------------------------------------------------- |
| Character contracts   | 1A            | `character/types.ts`, `card-schema.ts`, `character-registry.ts` |
| TTS contracts         | 1B            | `providers/tts/types.ts`, cache                                 |
| Evals                 | 2A            | `evals/kurisu/**`                                               |
| Pipeline fixtures     | 2B            | test-only controller fixtures                                   |
| Language              | 3A            | `input-understanding.ts`, prompt routing                        |
| Pronunciation         | 3B            | `providers/tts/pronunciation.ts`                                |
| ASR                   | 4A            | ASR TS client, Python service                                   |
| ACT stream            | 4B1/2/3       | output protocol and speech scheduling                           |
| Avatar                | 4B4           | shared protocol, publisher                                      |
| Deployment resolution | 5A/5B         | resolver, `index.ts`                                            |
| Voice profile         | 5C            | GPT-SoVITS provider/bootstrap                                   |
| Gemini                | 6A–6E         | brain types/provider/config/classifier                          |
| Prompt/lore           | 7             | prompt compiler and retrieval                                   |
| Memory                | 7             | new memory modules and room integration                         |
| Final integration     | Lead          | high-conflict files and release docs                            |

---

# 19. Coding standards

## 19.1 Pure functions first

Use pure functions for:

* card normalization;
* interaction fallback;
* entity matching;
* pronunciation planning;
* turn classification;
* prompt budgeting;
* lore ranking;
* memory extraction and merging;
* provider precedence.

Keep network and filesystem activity at the edges.

## 19.2 Cancellation

Every new wait or network operation must accept an `AbortSignal`.

This includes:

* Gemini generation.
* TTS.
* ACT delay.
* ASR.
* memory summarization.
* stateful Interaction API experiments.

Cancelled output must never:

* play;
* update avatar state;
* enter history;
* become long-term memory;
* alter relationship state.

## 19.3 Bounded model-controlled values

Bound:

* ACT count.
* delay duration.
* total delay.
* motion-hint length.
* response tokens.
* hotword count.
* hotword length.
* lore entries.
* memory records.
* few-shot examples.
* prompt tokens.
* substitutions per TTS segment.

## 19.4 Logging and privacy

Log identifiers and metrics, not full private prompts.

Safe fields:

```text
characterVersion
pronunciationProfileVersion
thinkingLevel
promptTokenEstimate
loreEntryIds
memoryIds
entityIds
responseChars
latency
ACT validity
substitution count
```

Do not log by default:

* complete system prompts;
* private voice transcripts;
* full acquired-memory contents;
* API keys;
* card-relative paths resolved to private absolute host paths.

---

# 20. Acceptance criteria

## Build

* Typecheck is green.
* Unit suite is green.
* No stale test description contradicts the live card.
* Public runtime types match all consumers.
* Feature flags have safe defaults.

## Card integration

* `interaction` is always available at runtime.
* `defaultResponseLanguage` is used only as a fallback.
* Entity descriptions affect prompt routing.
* Pronunciation mappings affect only TTS text.
* ASR hotwords are genuinely used or transparently identified as post-normalization.
* Voice profile resolves with documented precedence.
* Display-model metadata reaches the avatar layer.
* Unsupported card fields are documented.

## ACT/avatar

* More than 99% valid initial ACT handling in the evaluation set.
* Unknown emotions cannot escape the configured vocabulary.
* ACT syntax never reaches speech or history.
* DELAY produces a cancellable ordered pause.
* Avatar expressions are actually published when enabled.
* Disabled avatar mode remains harmless.

## Gemini

* Every request declares a tested thinking level.
* Every request has a bounded output cap.
* No deprecated sampling parameters are sent.
* No request ends in a prefilled model turn.
* Low/medium routing is covered by tests.
* First-token latency is measured by profile.

## Persona

Target after tuning:

* At least 90% of eval cases judged in character.
* Fewer than 2% hard canon contradictions.
* Fewer than 2% source-memory/acquired-memory provenance errors.
* No spontaneous Future Gadget Lab memories.
* No repeated Amadeus ontology explanation during unrelated conversation.
* No unearned romantic relationship.
* Stable relationship register across multiple turns.

## Voice

* Core-name pronunciation exceeds 95% in the listening set.
* Visible text remains unchanged by pronunciation rewriting.
* Reference transcript is populated.
* Cache keys include all behavior-affecting voice and pronunciation fields.
* No ACT or markup is spoken.

## Performance

Hardware-dependent initial targets:

* First Gemini text token p50 below 1 second.
* First audible response p50 below 2 seconds.
* First audible response p95 below 4 seconds.
* No ordinary inter-chunk gap above approximately 350 ms.
* Cancellation stops further audible output promptly.
* No cancelled turn is committed.

---

# 21. Final instruction to the coding agent

Do not begin by “implementing the audit findings.”

Begin by:

1. Pinning the exact repository SHA.
2. Running typecheck and tests.
3. Reconciling the attached audit against current source.
4. Repairing the public contracts.
5. Establishing a measurable baseline.
6. Implementing one end-to-end behavior at a time.
7. Running the full acceptance gate after every wave.

The most important architectural rule is:

> Character data must become typed runtime behavior through one explicit path, while deployment configuration remains the authority for secrets and infrastructure.

The most important impersonation rule is:

> Do not compensate for missing state management by making the permanent character prompt longer.

The most important Gemini rule is:

> Use explicit thinking level, output bounds, compact retrieved context, and regression evaluations—not deprecated sampling knobs—to control Gemini 3.6 Flash.
