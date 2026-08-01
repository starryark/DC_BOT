# Gemini 3.6 Flash compatibility profile

Audit date: 2026-08-01

Scope: the direct Gemini provider in `airi/services/discord-bot`. This is a read-only Wave 0 compatibility audit; it does not prescribe an Interactions API migration and makes no production-code changes.

## Installed SDK and model

- `airi/pnpm-workspace.yaml` declares `@google/genai: ^2.14.0` in the dependency catalog.
- `airi/pnpm-lock.yaml` resolves the discord bot importer and package snapshot to **`@google/genai@2.14.0`**.
- `src/config.ts` defaults `GEMINI_MODEL` to **`gemini-3.6-flash`** and permits an operator override.
- Google lists `gemini-3.6-flash` as a stable model with a 1,048,576-token input limit and a 65,536-token output limit: [Gemini 3.6 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash).

The package manifest uses a catalog range while the lockfile pins the reproducible installed version. All implementation work should preserve the lockfile pin unless an SDK upgrade is a deliberate, separately reviewed change.

## JavaScript request-field compatibility

The provider calls `GoogleGenAI.models.generateContentStream`. The following are JavaScript/camelCase members of `GenerateContentConfig` in the official `@google/genai` API reference: [GenerateContentConfig](https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html).

| Field | Supported SDK shape | Current use | Audit result |
| --- | --- | --- | --- |
| `systemInstruction` | `config.systemInstruction` | Passed as a string | Supported and correctly located. |
| `abortSignal` | `config.abortSignal` | Passed from `BrainProvider.generate` | Supported and correctly located. The provider also classifies an aborted request as `BrainRequestAbortedError`. |
| `maxOutputTokens` | `config.maxOutputTokens` | Not sent | Supported by the SDK, but no application cap is currently enforced. |
| `thinkingConfig` | `config.thinkingConfig` | Not sent | Supported by the SDK, but no explicit generation profile is currently wired. |
| `thinkingLevel` | `config.thinkingConfig.thinkingLevel` | Not sent | Supported for Gemini 3.6 Flash. Official JavaScript examples use `ThinkingLevel.LOW`; the accepted levels are `minimal`, `low`, `medium`, and `high`, with `medium` the model default: [Gemini thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking). |

SDK support does not imply that every SDK field is valid for every model. In particular, Gemini 3.6's model-specific rules below take precedence over the broader SDK type surface.

## Current provider payload

`src/providers/brain/gemini.ts` currently constructs this effective payload:

```ts
{
  model: this.model,
  contents: request.contents,
  config: {
    systemInstruction: request.systemInstruction,
    abortSignal: signal,
  },
}
```

It does not send tools, safety overrides, structured-output settings, sampling controls, output limits, or thinking controls. The response is consumed as an async stream and only non-empty `chunk.text` values are yielded.

## Prohibited and absent parameters

A repository search of `airi/services/discord-bot/src` found no generation request using any of the following:

- `temperature`
- `topP` or `top_p`
- `topK` or `top_k`
- `candidateCount`
- `thinkingBudget`

This is compatible with Gemini 3.6 Flash. Google states that `temperature`, `top_p`, and `top_k` are deprecated for Gemini 3.6 Flash, are ignored now, and may produce HTTP 400 errors in future model generations. They should remain absent. See [Using the latest Gemini models](https://ai.google.dev/gemini-api/docs/latest-model#api-changes-and-parameter-updates).

`candidateCount` and `thinkingBudget` are also absent, as required by this plan. Although the general SDK surface may expose these for other models or use cases, they must not be introduced into this Gemini 3.6 profile. Gemini 3 models should use `thinkingLevel`, not a numeric thinking budget.

## Final-turn validation

Gemini 3.6 rejects a request when its last non-empty content turn has role `model`. The current request builders satisfy this rule:

| Request path | Why the final turn is a user turn |
| --- | --- |
| Character prompt compiler | `DefaultPromptCompiler.compile()` renders all stored turns, then unconditionally appends `renderCurrentInput(...)`, which returns `{ role: 'user', ... }`. |
| Voice fallback | `ConversationController.compileRequest()` copies history, then appends the accepted current input with role `user`. |
| Discord mention fallback | `MentionResponder.compileFallback()` maps history, then appends the current mention with role `user`. |
| Discord mention with character | Uses the same `DefaultPromptCompiler` invariant. |

Therefore every normal generation path ends with a non-empty current user turn. The current-input builders trim or substitute input before request compilation, so the appended turn is not a model prefill. Stored history may legitimately contain model turns; only the final non-empty turn is restricted. Google documents both the validation rule and the recommended user/model history layout in [the latest-model migration guidance](https://ai.google.dev/gemini-api/docs/latest-model#api-changes-and-parameter-updates) and [text generation documentation](https://ai.google.dev/gemini-api/docs/generate-content/text-generation).

Risk: this invariant is structural rather than enforced at the `GeminiBrainProvider` boundary. A future caller can construct `BrainRequest.contents` directly and end it with a model turn. Wave 6 should add provider/request-validation tests (or a narrow runtime assertion) covering an empty array, an empty final user part, and a final non-empty model turn.

## Recommended application generation profile

For the voice-character workload, introduce explicit application-level settings in Wave 6 rather than relying on the model defaults:

| Setting | Recommended starting point | Rationale |
| --- | --- | --- |
| Model | `gemini-3.6-flash` | Stable model already selected by default. |
| Thinking level | `low` for ordinary voice turns; evaluate `minimal` as the latency challenger | Google describes `low` as minimizing latency and cost. `minimal` may still reason and is not guaranteed to disable thinking. Persona fidelity and ACT-protocol compliance must be measured before selecting it. |
| Max output tokens | A small explicit cap, initially 512 tokens | Discord speech should be concise; an application cap bounds latency and TTS work. This is a starting hypothesis for evaluation, not a model limit. |
| Sampling controls | Omit | Required for forward compatibility with Gemini 3.6. |
| Candidate count | Omit | Streaming consumes one textual answer and no multi-candidate policy exists. |

Represent this as an explicit typed generation profile and pass only supported values to `config.thinkingConfig.thinkingLevel` and `config.maxOutputTokens`. Do not add `temperature`, `topP`, `topK`, or `thinkingBudget` as compatibility aliases.

## Prompt-budget posture

The model's 1M-token input window is a hard capacity, not an appropriate conversation-memory target. The application currently bounds stored messages (`CONVERSATION_MAX_MESSAGES`, default 24) and produces an approximate prompt-token metric, but the provider does not enforce an aggregate token/character ceiling.

Wave 6/7 should retain a much smaller evaluated application budget, with deterministic trimming priorities: preserve runtime/output rules, persona and current-turn routing, preserve the current user turn, then prefer the most relevant lore/memory and recent exact turns. The budget should leave ample room beneath the output limit and be tuned using persona-continuity and first-token-latency measurements. Do not expand history merely because the advertised context window permits it.

## Compatibility conclusion

The current direct provider payload is API-compatible with Gemini 3.6 Flash: it uses supported camelCase SDK properties, contains none of the disallowed/deprecated generation controls, streams through `generateContentStream`, and all current request-construction paths end in a user turn. The compatibility gaps are configuration gaps rather than current request violations: there is no explicit `thinkingLevel`, no `maxOutputTokens`, no provider-boundary final-turn guard, and no enforced application prompt budget.

## Sources

- [Gemini 3.6 Flash model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash)
- [Using the latest Gemini models](https://ai.google.dev/gemini-api/docs/latest-model)
- [Gemini thinking guide](https://ai.google.dev/gemini-api/docs/generate-content/thinking)
- [`@google/genai` `GenerateContentConfig` reference](https://googleapis.github.io/js-genai/release_docs/interfaces/types.GenerateContentConfig.html)
- [Gemini text generation guide](https://ai.google.dev/gemini-api/docs/generate-content/text-generation)
