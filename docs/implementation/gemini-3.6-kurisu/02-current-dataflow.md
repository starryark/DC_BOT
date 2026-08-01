# Current runtime dataflow

This is a read-only audit of the direct Discord voice runtime as it exists at the Wave 0 baseline. “Wired” means a card value changes an external request, prompt, playback, or persisted conversation state—not merely that it is parsed and retained.

## End-to-end path

```text
Discord VoiceManager utterance
  -> admission / busy-policy check
  -> Opus-to-WAV conversion
  -> QwenHttpAsrProvider POST /v1/transcribe
  -> epoch check (reject late ASR)
  -> transcript filtering / per-user duplicate cache
  -> response-language and entity understanding
  -> conversation-floor grouping
  -> DefaultPromptCompiler (persona, routing, lore, history)
  -> GeminiBrainProvider.generate stream
  -> speech chunker (extracts ACT/DELAY spans)
  -> ACT-v1 parser
  -> visible-text accumulation
  -> per-chunk language resolution
  -> TTS-only entity pronunciation replacement
  -> CachedTtsProvider -> GPT-SoVITS POST /tts
  -> epoch check (reject late synthesis)
  -> VoiceManager playback queue tagged by turnId/responseEpoch/chunkIndex
  -> await epoch playback drain
  -> final epoch check
  -> atomic user/assistant history commit
```

`src/index.ts` constructs one card runtime at boot and passes it only to `ConversationController` and `MentionResponder`. `services.ts` exposes the constructed providers and avatar publisher to commands, but adds no card routing. Card load failure is non-fatal and selects a generic prompt, English default response language, no entities, and the default pronunciation profile.

## Card-field wiring matrix

Statuses: **fully wired** changes the intended operational sink; **partially wired** reaches some but not all intended sinks; **metadata only** is parsed/stored with no runtime effect; **ignored** is preserved by the loose schema but omitted from `CharacterRuntime`.

| Card field | Parse and runtime storage | Consumer / operational effect | Tests | Status |
|---|---|---|---|---|
| `spec`, `spec_version` | Validated by `validateCard`; not retained in `CharacterRuntime` | Gates card acceptance; major-version mismatch warns | `card-schema.test.ts` covers wrong spec and version warnings | **fully wired** |
| `data.name` | Required; normalized to `CharacterRuntime.name` | Load log/display identity; no prompt injection by itself | schema required-field and registry load tests | **partially wired** |
| `description`, `personality`, `scenario` | Stored under `runtime.identity` | Prompt compiler emits the non-empty values in the identity section | prompt ordering/omission tests | **fully wired** |
| `system_prompt` | Required by schema; stored as `identity.systemPrompt` | Primary persona section in Gemini `systemInstruction` | schema and prompt ordering tests | **fully wired** |
| `post_history_instructions` | Stored as `identity.postHistoryInstructions` | Appended at the end of `systemInstruction` | dedicated prompt compiler ordering test | **fully wired** |
| `character_book.entries[].keys/content/enabled/insertionOrder` | Normalized into `runtime.lorebook.entries` | Keyword match across recent/current text; enabled entries are sorted and injected as lore | activation, ordering, and disabled-entry tests | **fully wired** |
| `character_book.entries[].extensions` | Preserved on normalized entry | No consumer | schema preservation test | **metadata only** |
| Other entry fields (`name`, `priority`, `caseSensitive`, etc.) and book fields (`scanDepth`, `tokenBudget`, `recursiveScanning`, etc.) | Preserved only in parsed loose card; omitted from runtime | No activation or budgeting effect; matching is case-sensitive `String.includes` regardless of card flags | unknown-field preservation is tested generically | **ignored** |
| `creator_notes` | Preserved by loose parse; omitted from runtime | Deliberately not prompt-injected | policy is documented in schema; no direct behavior test | **ignored** |
| `first_mes`, `alternate_greetings`, `group_only_greetings`, `mes_example` | Preserved by loose parse; omitted from runtime | No greeting/few-shot behavior | no operational tests | **ignored** |
| `character_version`, `creator`, `tags` and unknown CCv3 fields | Preserved by validation; omitted from runtime | No runtime consumer | unknown-field preservation test | **metadata only** |
| `extensions.dc_bot.outputProtocol.type` | Normalized/stored | Prompt/parser behavior is enabled only when value is exactly `act-v1` | registry and prompt tests | **fully wired** |
| `outputProtocol.emotions` | Normalized/deduplicated/stored | Allowed vocabulary is listed in the model prompt, but parser does not validate emitted emotion names against it | normalization and prompt tests; parser robustness tests do not enforce vocabulary | **partially wired** |
| `outputProtocol.allowDelay` | Normalized/stored | Controls prompt permission and whether parsed DELAY produces pause records | prompt/parser tests | **partially wired** because pauses are logged, not scheduled |
| `extensions.dc_bot.interaction.defaultResponseLanguage` | Normalized/stored | Used by input understanding as fallback; selected language is inserted into the prompt and guides TTS | controller language-routing and input-understanding tests | **fully wired** |
| `interaction.entities[].id/canonicalName/nativeName/kind/aliases/promptDescription` | Normalized/stored | Entity matching influences current-turn trusted routing text in the prompt | input-understanding/prompt integration coverage | **fully wired** |
| `interaction.entities[].pronunciations[language].speechText` | Normalized/stored | Replaces aliases only in a separate TTS copy; visible response/history retain original model text | `pronunciation.test.ts` plus controller synthesis coverage | **fully wired** |
| `interaction.pronunciationProfileVersion` | Normalized/stored | Sent with `TtsRequest` and included in cache identity; raw GPT-SoVITS ignores it, but cache invalidation changes | pronunciation/cache/controller tests | **fully wired** |
| `extensions.dc_bot.asr.hotwords` | Normalized/stored as `runtime.asr.hotwords` | No value is passed to `AsrProvider.transcribe`; Qwen request body is WAV only | schema/registry normalization tests only | **metadata only** |
| `extensions.dc_bot.voice.provider`, `voiceId` | Normalized/stored (with AIRI speech fallback) | Bootstrap always constructs `GptSoVitsTtsProvider`; provider and voice ID do not select it or configure a voice | registry fallback tests only | **metadata only** |
| `voice.referenceAudio`, `referenceTextFile`, resolved `referenceText`, `promptLanguage` | Paths/text are resolved and stored | GPT-SoVITS reads `GPT_SOVITS_REF_AUDIO`, prompt text, and prompt language from environment config instead of the runtime card | registry path/text tests and provider env-config tests | **metadata only** |
| `extensions.dc_bot.avatar.renderer`, `displayModelId` | Normalized/stored (display model can fall back to AIRI extension) | `AvatarPublisher` is constructed only from environment relay config and never receives the character/avatar profile | registry tests only | **metadata only** |
| `extensions.airi.modules.speech.provider/voice_id` | Read only as fallback while building `runtime.voice` | No downstream provider selection | registry live-card fallback test | **metadata only** |
| `extensions.airi.modules.displayModelId` | Read only as avatar fallback | No downstream renderer/model selection | registry test | **metadata only** |
| `extensions.airi.modules.consciousness.provider/model` | Preserved in raw card but never projected into runtime | Gemini provider/model come exclusively from deployment config | no card-to-model test | **ignored** |
| Other `extensions.airi` fields and unknown `extensions.dc_bot` fields | Preserved by parsing | No runtime consumer | AIRI verbatim/unknown preservation tests | **metadata only** |

## Required path findings

### ACT actions

For an `act-v1` card, the prompt compiler instructs Gemini to emit ACT tokens. The stream chunker removes each control span before speech text is accumulated. `onControlToken` rejects a stale epoch, calls `parseActV1`, and logs `avatar_action` with emotion, intensity, and motion hint. The clean token never reaches TTS or history. No action is sent to `AvatarPublisher`; the relay currently supports only coarse behavior state. Therefore ACT parsing/stripping is wired, but avatar actuation is **partial**.

### DELAY

The compiler permits DELAY only when `allowDelay` is true. The parser strips the token in all cases and emits `{durationMs}` only when allowed. `onControlToken` merely logs `avatar_pause`; neither `runBoundedTtsPipeline` nor playback waits for the duration. DELAY is therefore **partially wired** and has no audible timing effect.

### ASR hotwords

Hotwords reach `CharacterRuntime.asr.hotwords` and stop there. `ConversationController` calls `transcribe({wav, sampleRate})`; `QwenHttpAsrProvider` posts the WAV bytes as `audio/wav` with no query, header, or multipart hotword field. Operational status: **metadata only**.

### Response language

ASR language and transcript evidence feed `resolveInputUnderstanding`, with the card default and prior stable language as fallback/context. Stable evidence updates guild session state. The selected language and matched entity descriptions enter the trusted runtime-routing prompt block. The response language also seeds chunk-level `resolveTtsLanguage`; strong generated-text evidence may override it, then GPT-SoVITS receives the resolved `text_lang`. This path is **fully wired**.

### Pronunciation

Each clean speech chunk is copied through `prepareSpeechText`. It performs language-specific, boundary-aware alias replacement using matched card entities. Only `prepared.speechText` goes to TTS; `fullReply`, visible output, and committed history retain the original clean model text. The profile version is logged, travels in the TTS request, and participates in cache identity. This path is **fully wired**.

### Voice reference

The registry safely resolves card-relative reference audio/transcript fields, but the instantiated TTS provider never receives `character.voice`. Its HTTP body uses environment-derived `config().tts.refAudioPath`, `promptText`, and `promptLang`; trained weights are likewise external service state. Card voice reference is **metadata only** at runtime.

### Avatar display model

The registry stores renderer/display-model metadata, but bootstrap gives `AvatarPublisher` only enabled/url/token. The publisher binds voice session lifecycle and emits coarse `avatar.behavior.set` envelopes; it has no character/model field. Display-model selection is **metadata only**.

### Gemini model selection

`GeminiBrainProvider` snapshots `config().brain.model` (`GEMINI_MODEL`, default `gemini-3.6-flash`) in its constructor and uses it for every request. The card’s AIRI consciousness provider/model is not projected or consumed. Selection is deployment-only; the card path is **ignored**.

## Cancellation and stale-result boundaries

The guild `responseEpoch` is the correlation key. Cancellation increments it before aborting work, so continuations from the old epoch become unusable even if an underlying API finishes late.

| Boundary | Cancellation mechanism | Stale rejection |
|---|---|---|
| Admission / interrupt policy | Busy half-duplex input is dropped; interrupting policies call `cancel(..., 'superseded')` | Work is avoided before conversion/ASR, or old epoch is incremented |
| ASR | Qwen provider owns a request-timeout `AbortController`; the conversation cancellation signal is **not** passed to ASR | After `transcribe`, controller compares `session.responseEpoch` with captured `admissionEpoch` before filter/history/floor mutation |
| Conversation-floor grouping | `cancel` clears pending turn; floor has `isEpochCurrent` callback | `onConversationGroup` requires phase `collecting` and exact input epoch; floor flush also consults current epoch |
| Gemini queue/request/stream | Per-response `AbortController.signal` goes to `brain.generate` and Google `abortSignal`; `cancel` aborts it | Pipeline `isCancelled` uses epoch mismatch or aborted signal; aborted-provider error exits without commit |
| Control tokens | No separate abort | `onControlToken` immediately rejects epoch mismatch |
| TTS scheduling | Pipeline checks `isCancelled` before further work | `synthesizeChunk` refuses an already-aborted signal |
| GPT-SoVITS fetch/stream | Provider combines parent abort with its own timeout controller | After synthesis resolves, controller rejects epoch mismatch or parent abort before returning audio |
| Playback enqueue | `cancelPlaybackEpoch(guildId, oldEpoch)` plus `stopPlayback` | `playChunk` checks epoch/signal before enqueue; queue items carry turn/epoch/chunk identity |
| Playback drain / history | Playback cancellation releases queued audio | Epoch/signal checked before drain and again after drain; only then is the paired exchange committed |
| Cleanup | `finally` runs for every response | Only the owning epoch may clear active fields, transition to idle, or start a pending turn |
| Session end / barge-in / explicit cancel | All converge on `cancel`; disconnect additionally leaves the session terminal | Epoch bump precedes abort and playback teardown |
| One-at-a-time prompt | Own epoch and abort controller | Checks epoch/signal after TTS; `finally` mutates session only if epoch still owns it |

One exception is the cooldown notice: it creates a fresh epoch and an otherwise unowned abort signal, but does not perform a post-synthesis epoch check before enqueue. It is short, locally initiated courtesy audio, yet it is not protected to the same standard as normal generation. ASR similarly cannot be stopped by turn cancellation; safety relies on rejecting its late result.

## Test coverage summary

The strongest end-to-end coverage is in `conversation-controller.test.ts`: language routing, group/floor epoch invalidation, half-duplex admission, disconnect abort of Gemini/TTS, late TTS discard, playback-epoch cancellation, no post-cancel enqueue, no cancelled history commit, and latest-wins supersession. Parser, prompt composition/lore, schema normalization, registry path resolution, TTS request fields/timeouts, cache behavior, pronunciation isolation, and avatar publisher acknowledgement/lifecycle are covered in their adjacent test files.

The gaps mirror the unwired paths: there is no test proving hotwords reach Qwen, card voice reference reaches GPT-SoVITS, ACT/DELAY affects avatar/playback, display-model metadata reaches the relay, or card model metadata selects Gemini—because none of those transfers currently exists.
