# Proposal: Multilingual GPT-SoVITS Output for Discord Voice Bot

## 1. Objective

Modify the existing Discord voice bot so that its GPT-SoVITS speech output works reliably in at least:

* Japanese (`ja`)
* Chinese / Mandarin (`zh`)
* English (`en`)

The existing architecture should remain intact:

```text
Discord voice
    ↓
Qwen3-ASR
    ↓
Gemini
    ↓
GPT-SoVITS
    ↓
Discord voice
```

The repository README describes this as the current working `direct` backend and states that the bot uses Qwen3-ASR locally, Gemini for response generation, and the Kurisu Makise GPT-SoVITS model for speech playback.

This task should focus primarily on **correct language propagation into GPT-SoVITS**, while also fixing the two supporting issues already visible in the supplied logs that would otherwise prevent reliable multilingual validation:

1. Missing English GPT-SoVITS/NLTK runtime resource.
2. Race condition where the Discord bot can attempt TTS before GPT-SoVITS is ready.

Do not redesign the entire voice pipeline unless repository inspection demonstrates that a larger change is actually necessary.

---

# 2. Important instruction to the coding agent

Do **not** assume the file structure, class names, interfaces, or exact implementation from this proposal.

The supplied logs contain paths such as:

```text
providers/tts/gpt-sovits.ts
orchestration/conversation-controller.ts
orchestration/speech-chunker.ts
```

and the README says the Discord bot implementation is under the AIRI Discord service, but these are evidence from the current checkout rather than an instruction to blindly patch specific files.

Before editing anything:

1. Read the root README.
2. Read the Discord bot README/configuration documentation if present.
3. Inspect the actual repository tree.
4. Search for all GPT-SoVITS-related configuration and request construction.
5. Search for the TTS provider interface and all its callers.
6. Search for ASR language metadata.
7. Search for Gemini streaming/chunking logic.
8. Search for `/voice-test`.
9. Inspect the service-launch scripts.
10. Inspect the checked-in GPT-SoVITS version and its actual `/tts` API schema.
11. Inspect existing tests before deciding where new tests belong.

Adapt the implementation to the architecture that actually exists.

---

# 3. Current evidence and problem statement

## 3.1 ASR is already multilingual

The observed logs show Qwen correctly identifying languages.

For example, Chinese input is recognized as Chinese:

```text
ASR result ... language=zh text=你会说中文吗？
```

but the subsequent GPT-SoVITS synthesis requests in the first run are logged as:

```text
GptSoVitsTts ... language=ja
```

The same mismatch occurs repeatedly for Chinese turns.

Therefore the primary issue does **not** appear to be ASR.

---

## 3.2 Target TTS language was being forced to Japanese

The first log provides direct evidence that ASR language metadata and TTS language metadata diverge:

```text
ASR language=zh
...
GptSoVitsTts language=ja
```

The coding agent should determine exactly where this happens.

Possible causes include, but are not limited to:

* TTS provider using `GPT_SOVITS_PROMPT_LANG` as target language.
* TTS provider constructed once with a fixed `ja`.
* Caller failing to pass language information.
* TTS interface not supporting a language parameter.
* Conversation controller dropping ASR language metadata.
* Speech chunker dropping turn metadata.
* A default configuration value overriding the caller.
* `/voice-test` or other code path independently hardcoding Japanese.
* A partially implemented language-routing change already existing in the current repo.

Do not assume which one is true until tracing the code.

---

# 4. Crucial GPT-SoVITS distinction: prompt language vs target text language

The agent must inspect the checked-in GPT-SoVITS API implementation and confirm the semantics for the repository's exact version.

The expected GPT-SoVITS model is configured with a Japanese Kurisu reference voice. The README currently documents:

```dotenv
GPT_SOVITS_REF_AUDIO=../TTS-KurisuMakise/害羞示范.wav
GPT_SOVITS_PROMPT_LANG=ja
```

Do **not** automatically change this Japanese prompt/reference language to the user's language.

The intended conceptual distinction is:

```text
prompt_lang
    = language of the reference/prompt speech/text

text_lang
    = language of the text currently being synthesized
```

For this project it is perfectly reasonable for a Chinese request to look conceptually like:

```text
prompt_lang = ja
text_lang   = zh
```

and an English request like:

```text
prompt_lang = ja
text_lang   = en
```

The coding agent must verify these field names and semantics against the exact checked-in `api_v2.py` / GPT-SoVITS implementation before editing the caller.

### Desired model

Japanese:

```text
reference voice: Japanese Kurisu
prompt_lang: ja
text_lang: ja
```

Chinese:

```text
reference voice: Japanese Kurisu
prompt_lang: ja
text_lang: zh
```

English:

```text
reference voice: Japanese Kurisu
prompt_lang: ja
text_lang: en
```

Mixed/uncertain language:

```text
reference voice: Japanese Kurisu
prompt_lang: ja
text_lang: auto
```

if `auto` is supported by the checked-in GPT-SoVITS version.

---

# 5. Why the current behavior is wrong

The GPT-SoVITS inference log shows Chinese text reaching a Japanese text frontend.

Examples include Chinese target text followed by warnings such as:

```text
JPCommonLabel_make() ... No phoneme
```

That strongly supports the diagnosis that Chinese text is being interpreted using Japanese preprocessing because the target language sent to GPT-SoVITS is wrong.

The agent should confirm this by tracing one actual request from:

```text
ASR result
→ Gemini response
→ speech chunk
→ TTS provider
→ HTTP /tts payload
→ GPT-SoVITS text preprocessing
```

Document that trace in the implementation summary.

---

# 6. Repository investigation phase

Before making changes, perform the following searches.

## 6.1 Find GPT-SoVITS configuration

Search for:

```text
GPT_SOVITS
PROMPT_LANG
text_lang
prompt_lang
ref_audio
9880
/tts
```

Determine:

* All relevant environment variables.
* Where defaults are defined.
* Whether `.env.example`, `.config`, PowerShell scripts, TypeScript configuration parsing, or other configuration systems duplicate values.
* Whether any value is hardcoded outside configuration.
* Whether `PROMPT_LANG` is currently reused as the synthesis language.

Create a small map such as:

```text
Environment variable
→ config parser
→ provider constructor
→ synthesize()
→ HTTP request field
```

---

## 6.2 Find the TTS abstraction

Locate:

* GPT-SoVITS provider.
* Generic TTS interface/base class if one exists.
* Synthesis request type.
* All provider callers.
* Voice-test caller.
* Mock/fake TTS used by tests.

Determine whether language can already be passed through the abstraction.

Prefer extending the existing abstraction cleanly instead of special-casing GPT-SoVITS deep inside orchestration code.

For example, if the existing conceptual interface is:

```ts
synthesize(text: string)
```

consider whether the architecture naturally supports something like:

```ts
synthesize(text: string, options?: {
  language?: string
})
```

or:

```ts
synthesize({
  text,
  language,
})
```

Do not use those exact signatures unless they fit the current codebase.

---

## 6.3 Find ASR result representation

Determine what Qwen returns.

The logs indicate that it already exposes:

```text
text
language
```

Find the corresponding type and determine whether the language survives past transcription.

Trace it through:

```text
ASR
→ conversation turn
→ Gemini generation
→ TTS
```

The goal is to identify exactly where language metadata is dropped or overwritten.

---

## 6.4 Inspect Gemini response policy

Determine whether the bot currently instructs Gemini to:

* answer in the user's language;
* answer in Japanese;
* use character/persona language rules;
* dynamically mirror the user;
* produce multilingual output.

Do not change the character/persona unnecessarily.

The language-routing strategy should reflect actual response behavior.

---

## 6.5 Inspect speech chunking

The logs show the bot synthesizes generated responses in multiple small chunks.

Determine:

* whether Gemini is streamed;
* where chunks are split;
* whether chunks know the enclosing turn language;
* whether some chunks can consist of only punctuation or a few characters;
* whether TTS calls occur before the full Gemini response exists.

This matters because language detection should generally **not** run independently on tiny fragments such as:

```text
嗯？
```

or:

```text
OK.
```

unless there is sufficient context.

---

# 7. Recommended language-routing architecture

The exact implementation should match the existing abstractions, but the preferred conceptual behavior is:

```text
ASR language
      ↓
normalize
      ↓
turn-level language hint
      ↓
Gemini
      ↓
generated chunks
      ↓
TTS language resolver
      ↓
GPT-SoVITS text_lang
```

Do not modify `prompt_lang` as part of this routing.

---

# 8. Language normalization

Implement one authoritative normalization function rather than scattering comparisons throughout the code.

The function should map likely language forms into GPT-SoVITS-compatible values.

Conceptually:

```text
en
en-US
en-GB
→ en

zh
zh-CN
zh-TW
cmn
→ zh

ja
ja-JP
jp
→ ja

unknown / und / unsupported
→ auto
```

Only include aliases that can actually occur in this repository's ASR/provider outputs.

Do not add arbitrary aliases without evidence.

The normalized result should be represented with a constrained type if practical, for example conceptually:

```text
"en" | "zh" | "ja" | "auto"
```

plus any additional values supported and genuinely needed by the vendored GPT-SoVITS version.

---

# 9. Decide target language at the turn level where possible

For ordinary single-language conversations, use the ASR language as the initial language hint.

Example:

```text
User speaks Chinese
Qwen returns zh
Gemini is expected to answer Chinese
TTS turn language = zh
```

This avoids trying to detect the language of every streamed fragment.

That is particularly important when fragments are very small.

---

# 10. Generated-text language should still be allowed to override when strongly evident

ASR language should be treated as a **hint**, not an unconditional truth about generated text.

For example:

```text
User speaks Chinese:
“Say hello in English.”

Gemini:
“Hello! Nice to meet you.”
```

Blindly using `zh` for this response would be incorrect.

Therefore add a lightweight response-language resolution strategy appropriate to the existing streaming architecture.

A recommended precedence is:

```text
1. Explicit response-language metadata, if the brain layer already provides it.
2. Strong language evidence from generated text.
3. Current turn's ASR language hint.
4. GPT-SoVITS auto mode.
```

Avoid introducing a heavyweight language-detection model unless necessary.

---

# 11. Suggested lightweight script-aware detection

If no existing language detector is already present, a lightweight heuristic should be sufficient for the required languages.

Examples:

### Strong Japanese evidence

Presence of:

```text
Hiragana
Katakana
```

strongly indicates Japanese.

### Strong English evidence

A response consisting predominantly of Latin alphabet words can be classified as English.

### Han-only text

Han characters alone are ambiguous between Chinese and Japanese.

For example:

```text
今日
```

should **not** be classified from Unicode script alone.

Use contextual information such as the turn's ASR language hint.

### Mixed text

If a meaningful response contains multiple language classes, prefer GPT-SoVITS `auto` if supported and verified.

Examples:

```text
你好, Patrick!
```

```text
Gemini API は使えるわよ。
```

The agent should test whether the current GPT-SoVITS version's explicit `zh`/`ja` modes already handle embedded English adequately before forcing `auto` for every Latin fragment.

---

# 12. Streaming-specific requirement

Do not sacrifice response latency by unnecessarily waiting for the complete Gemini response before starting TTS.

The current bot appears designed around streamed generation and speech chunking.

Preferred behavior:

1. Carry a turn-level language hint into the TTS path.
2. Use that for the first chunks unless strong contradictory evidence exists.
3. Permit subsequent chunks to switch to another target language or `auto` when clearly necessary.
4. Do not perform unreliable detection on punctuation-only chunks.
5. Preserve ordering and playback behavior.

If the existing architecture already buffers enough text to determine language reliably, use that instead.

---

# 13. GPT-SoVITS request construction

After inspecting the exact vendored API, ensure target and reference language are populated independently.

Conceptually, the request should contain:

```text
text = generated speech text

text_lang = resolved target language

ref_audio_path = Kurisu reference audio

prompt_text = configured reference transcription, if used

prompt_lang = configured Kurisu reference language
```

Avoid logic equivalent to:

```text
text_lang = GPT_SOVITS_PROMPT_LANG
```

unless the target is genuinely Japanese.

Logging should also distinguish them.

Preferred diagnostic log fields:

```text
textLanguage=zh
promptLanguage=ja
chars=...
streamingMode=...
```

rather than one ambiguous field called only:

```text
language=...
```

This will make future diagnosis much easier.

Never log secret credentials.

---

# 14. Configuration changes

Inspect the existing configuration system first.

If useful, introduce a target-language fallback such as conceptually:

```dotenv
GPT_SOVITS_TEXT_LANG=auto
```

or a similarly named setting consistent with the repository conventions.

Its role should be a **fallback**, not something that disables dynamic language routing.

Suggested semantics:

```text
Known turn/response language
→ use dynamic language

Unknown language
→ configured fallback

No fallback configured
→ auto
```

Do not rename or repurpose:

```text
GPT_SOVITS_PROMPT_LANG
```

because that setting should continue representing the Japanese Kurisu reference/prompt.

Update `.env.example` and README if configuration changes.

Do not commit actual `.env` secrets.

---

# 15. Preserve Kurisu model configuration

The README states that GPT-SoVITS must use the Kurisu-specific inference configuration rather than the generic default configuration.

Do not accidentally replace or bypass that configuration while fixing language support.

The resulting bot must continue using the existing Kurisu weights and reference audio.

---

# 16. English runtime dependency is currently broken

There is a second independent issue.

The GPT-SoVITS inference log shows English preprocessing failing because NLTK cannot find:

```text
averaged_perceptron_tagger_eng
```

The failure originates from GPT-SoVITS English text preprocessing and causes `/tts` to return HTTP 400.

This must be addressed as part of multilingual support.

---

# 17. Fix the English NLTK dependency properly

Do not solve this by manually downloading the resource only on the developer's current machine.

Make the repository's documented/setup process install or verify the required NLTK data.

The README says GPT-SoVITS is provisioned through a dedicated setup script/environment and explicitly warns against sharing the Qwen virtual environment because their dependency requirements conflict.

Therefore:

1. Inspect the GPT-SoVITS setup script.
2. Inspect the checked-in NLTK version.
3. Inspect GPT-SoVITS' English frontend.
4. Determine exactly which NLTK resources it requires.
5. Add installation of those resources to GPT-SoVITS setup/provisioning.
6. Add a verification step or useful startup diagnostic.

Prefer deterministic setup-time provisioning over a hidden runtime network download.

At minimum, the currently observed required resource is:

```text
averaged_perceptron_tagger_eng
```

but verify whether other resources are required by the checked-in version.

---

# 18. Startup race condition

The second run demonstrates a separate reliability issue.

The bot recognizes English and selects:

```text
language=en
```

for GPT-SoVITS, but the HTTP request immediately fails with:

```text
ECONNREFUSED
127.0.0.1:9880
```

This means the Discord bot can become usable before the GPT-SoVITS service has finished loading.

The README itself instructs the user to wait for ASR and TTS weights to finish loading.

Make the launcher enforce readiness rather than relying entirely on human timing if this can be done cleanly.

---

# 19. Add service readiness handling

Inspect the actual launcher implementation.

The README says the launcher starts:

```text
Qwen3-ASR :8765
GPT-SoVITS :9880
Discord bot
```

Desired startup flow:

```text
launch ASR
launch GPT-SoVITS
      ↓
wait for ASR readiness
wait for GPT-SoVITS readiness
      ↓
launch Discord bot
```

Use an actual health/readiness endpoint if the checked-in service exposes one.

If GPT-SoVITS does not expose an inexpensive health endpoint, use a conservative readiness mechanism such as TCP connection availability.

Requirements:

* bounded timeout;
* useful error message;
* no infinite loop;
* configurable enough for slow CUDA/model startup;
* no repeated expensive synthesis requests;
* preserve visible service terminals if that is the current launcher behavior.

Do not make service readiness dependent on Gemini.

---

# 20. Gemini quota errors are not part of the TTS defect

The later log contains Gemini HTTP 429 quota failures before TTS is reached.

Do not attempt to “fix” Gemini quotas as part of this task.

Instead, make multilingual TTS testable independently.

The README already documents `/voice-test` specifically for testing GPT-SoVITS and Discord playback without involving ASR or Gemini.

Use that capability heavily.

---

# 21. Improve `/voice-test` for multilingual validation if appropriate

Inspect the existing slash command.

If it currently only accepts:

```text
text
```

consider adding an **optional** language parameter, if doing so fits the command design.

Conceptually:

```text
/voice-test text:"こんにちは" language:ja
/voice-test text:"你好" language:zh
/voice-test text:"Hello" language:en
/voice-test text:"你好, hello, こんにちは" language:auto
```

If changing the Discord command schema creates unnecessary complexity, an internal/dev command or direct provider test may be sufficient instead.

Do not make explicit language mandatory for normal conversations.

The normal bot should resolve language automatically.

---

# 22. Direct GPT-SoVITS integration tests

Before testing Discord conversation flow, directly exercise the local `/tts` API.

The agent should create or document repeatable test requests for:

### Japanese

```text
text_lang = ja
text = こんにちは。今日はいい天気ですね。
prompt_lang = ja
```

Expected:

```text
HTTP 200
non-empty audio
```

### Chinese

```text
text_lang = zh
text = 你好。今天想聊些什么？
prompt_lang = ja
```

Expected:

```text
HTTP 200
non-empty audio
```

### English

```text
text_lang = en
text = Hello. What would you like to talk about today?
prompt_lang = ja
```

Expected:

```text
HTTP 200
non-empty audio
no NLTK LookupError
```

### Mixed language

If supported:

```text
text_lang = auto
text = 你好。Hello. こんにちは。
prompt_lang = ja
```

Expected:

```text
HTTP 200
non-empty audio
```

Do not use Gemini for these tests.

---

# 23. Unit tests for language normalization

Add unit tests for the normalization/resolution layer.

At minimum:

```text
en       → en
en-US    → en
zh       → zh
zh-CN    → zh
ja       → ja
ja-JP    → ja
und      → auto
undefined→ auto
unsupported language → auto
```

Adjust the cases to match actual ASR outputs found in the repository.

---

# 24. Unit tests for request construction

Mock the HTTP request to GPT-SoVITS and verify independent values.

Critical tests:

### Japanese

Input:

```text
target language = ja
configured prompt language = ja
```

Expected request:

```text
text_lang=ja
prompt_lang=ja
```

### Chinese

Input:

```text
target language = zh
configured prompt language = ja
```

Expected:

```text
text_lang=zh
prompt_lang=ja
```

### English

Expected:

```text
text_lang=en
prompt_lang=ja
```

### Unknown

Expected:

```text
text_lang=auto
prompt_lang=ja
```

This test is important because it prevents the original bug from being reintroduced.

---

# 25. Orchestration tests

Mock:

```text
ASR
Gemini
TTS
```

and validate propagation.

Example:

```text
ASR:
  text = "你好"
  language = zh

Gemini:
  generated text = "你好，有什么事吗？"

Expected:
  TTS receives target language zh
```

English:

```text
ASR language = en
→ TTS target language = en
```

Japanese:

```text
ASR language = ja
→ TTS target language = ja
```

Unknown:

```text
ASR language = und
→ TTS target language auto
```

---

# 26. Test explicit language switching

Add a case where ASR language and generated text language differ.

Example:

```text
User language = zh

Generated response:
"Hello, nice to meet you."
```

Expected behavior should be whichever resolution policy was deliberately selected, ideally:

```text
TTS = en
```

or:

```text
TTS = auto
```

but **not blindly `zh`**.

This ensures the implementation is genuinely multilingual rather than merely “speak in the ASR language.”

---

# 27. Test mixed-language generated text

Example:

```text
"你好 Patrick, welcome back."
```

Expected:

* no exception;
* no Japanese phonemizer warnings caused by an inappropriate `ja`;
* intelligible synthesis;
* language mode chosen according to the documented policy.

Also test:

```text
"Gemini API は使えるわよ。"
```

because Japanese plus English is a realistic character response.

---

# 28. Speech-chunking regression tests

If language is carried through streamed chunks, verify that chunking does not lose it.

For example:

```text
Turn language = zh

Chunks:
"你好，"
"今天想"
"聊什么？"
```

Every chunk should receive an appropriate TTS language unless the resolver intentionally changes it.

Also test:

```text
"嗯？"
```

and punctuation-only chunks if those can exist.

Avoid per-chunk language classification that gives inconsistent results merely because a fragment is too small.

---

# 29. Startup tests

If the launcher is modified:

Test:

```text
TTS starts slowly
→ bot waits
→ GPT-SoVITS becomes ready
→ bot starts
```

Test failure:

```text
GPT-SoVITS never becomes ready
→ bounded timeout
→ useful error
→ bot is not launched into a known-broken state
```

Do similarly for ASR if the launcher already supports readiness checks.

---

# 30. Setup tests for NLTK

After a fresh GPT-SoVITS environment setup:

Run an English frontend smoke test.

Expected:

```text
no averaged_perceptron_tagger_eng LookupError
```

The setup process should be sufficient on a clean machine without a developer manually opening Python and downloading NLTK data afterwards.

---

# 31. Use existing project validation commands

The README documents development checks for the Discord bot and Qwen service. Preserve and run the applicable existing commands rather than inventing a separate build process.

At minimum, run the repository's:

* TypeScript typecheck.
* Discord bot tests.
* Any formatter/linter required by the workspace.
* GPT-SoVITS smoke tests added by this task.
* Existing ASR tests only if touched.

Do not install the Discord service independently with npm if the workspace uses pnpm.

---

# 32. End-to-end acceptance test

After direct/provider tests pass:

Start the complete stack.

Wait until both local inference services report ready.

Then test in Discord.

## Japanese

Speak:

```text
こんにちは。今日は何をしていたの？
```

Expected:

```text
ASR language=ja
Gemini generates Japanese
GPT-SoVITS target language=ja
audible Kurisu response
```

## Chinese

Speak:

```text
你好，你会说中文吗？
```

Expected:

```text
ASR language=zh
Gemini generates Chinese
GPT-SoVITS target language=zh or appropriate auto mode
audible Chinese Kurisu response
```

There must not be a repeating pattern of Chinese input followed by:

```text
TTS language=ja
```

unless generated output is genuinely Japanese.

## English

Speak:

```text
Hello. Can you speak English?
```

Expected:

```text
ASR language=en
Gemini generates English
GPT-SoVITS target language=en
audible English Kurisu response
no NLTK resource error
```

---

# 33. Logging requirements

Improve logs enough to diagnose language routing.

For every TTS call, log something conceptually equivalent to:

```text
targetLanguage=zh
promptLanguage=ja
chars=15
streamingMode=0
```

At turn level, useful fields include:

```text
asrLanguage=zh
resolvedResponseLanguage=zh
```

If language detection overrides ASR:

```text
asrLanguage=zh
resolvedResponseLanguage=en
languageResolution=text-detection
```

Do not log:

* Discord token.
* Gemini API key.
* sensitive environment contents.

---

# 34. Error handling

Distinguish useful classes of failures.

Examples:

### GPT-SoVITS unavailable

```text
TTS service unavailable at configured address
```

instead of only raw `fetch failed`.

### GPT-SoVITS HTTP 400

Preserve the useful server message in logs.

### Unsupported language

Fall back to `auto` rather than crashing if that is supported by the vendored version.

### Dependency failure

If English NLTK data is missing, surface a clear setup-specific error.

Do not silently fall back to Japanese when the target language is unknown.

That would recreate the current defect in a less visible form.

---

# 35. Backward compatibility requirements

The fix must not regress existing Japanese behavior.

Preserve:

* `/summon`
* `/leave`
* `/ping`
* `/voice-test`
* Discord playback
* barge-in behavior
* conversation queue behavior
* speech chunking
* Gemini streaming
* Kurisu reference voice
* current audio format expected by Discord
* current supported startup workflow

Only change an interface more broadly if necessary to propagate language cleanly.

---

# 36. Scope boundaries

Do not:

* replace Gemini;
* replace Qwen ASR;
* replace GPT-SoVITS;
* retrain Kurisu;
* switch to a cloud TTS provider;
* change the character voice;
* solve Gemini billing/quota;
* rewrite the AIRI Discord adapter;
* add a large language-detection ML dependency without justification.

This should remain a focused multilingual TTS integration fix.

---

# 37. Potential implementation shape

The following is illustrative only.

After repo inspection, the architecture may end up conceptually similar to:

```text
Transcription
{
  text
  language
}
       │
       ▼
normalizeLanguage()
       │
       ▼
TurnContext
{
  inputLanguageHint
}
       │
       ▼
Gemini stream
       │
       ▼
speech chunker
       │
       ▼
resolveTtsLanguage(
  generatedChunk,
  inputLanguageHint
)
       │
       ▼
tts.synthesize({
  text,
  language
})
       │
       ▼
GPT-SoVITS request
{
  text,
  text_lang: resolved language,
  prompt_lang: configured reference language
}
```

Again: fit this concept to the actual abstractions rather than forcing these exact types onto the codebase.

---

# 38. Recommended implementation order

## Phase 1 — Repository reconnaissance

No edits.

Produce a short internal map of:

```text
ASR result type
language flow
Gemini stream
speech chunker
TTS abstraction
GPT-SoVITS request builder
configuration loader
setup scripts
startup scripts
tests
```

Identify current behavior.

---

## Phase 2 — Reproduce independently

Before patching:

1. Start GPT-SoVITS only.
2. Call `/tts` directly with Japanese.
3. Call `/tts` directly with Chinese.
4. Call `/tts` directly with English.
5. Record exact payloads/results.

Confirm whether:

```text
prompt_lang=ja + text_lang=zh
```

works with the checked-in Kurisu model.

Confirm whether:

```text
prompt_lang=ja + text_lang=en
```

works after resolving NLTK setup.

This validates the backend before changing Discord code.

---

## Phase 3 — Fix GPT-SoVITS dependency provisioning

Make clean setup capable of English synthesis.

Verify from a clean or equivalent environment.

---

## Phase 4 — Fix target-language propagation

Separate:

```text
reference/prompt language
```

from:

```text
target synthesized-text language
```

Carry language through the TTS interface.

---

## Phase 5 — Add language resolver

Normalize known language codes.

Support unknown/mixed responses gracefully.

Keep resolution stable across streamed chunks.

---

## Phase 6 — Add unit/integration tests

Cover:

```text
ja
zh
en
auto/unknown
mixed text
ASR→TTS propagation
request field separation
```

---

## Phase 7 — Fix service readiness

Prevent first TTS request from hitting port 9880 before GPT-SoVITS is ready.

---

## Phase 8 — Update diagnostics and documentation

Update configuration documentation, setup instructions, multilingual examples, and troubleshooting.

---

## Phase 9 — End-to-end Discord validation

Only after direct GPT-SoVITS and provider tests pass.

---

# 39. Acceptance criteria

The task is complete when all of the following are true.

### Japanese

```text
Japanese speech
→ Japanese ASR
→ Gemini response
→ Japanese GPT-SoVITS audio
```

works at least as well as before.

### Chinese

```text
Chinese speech
→ Chinese ASR
→ Gemini response
→ Chinese GPT-SoVITS audio
```

works reliably.

No systematic routing of Chinese text through `text_lang=ja`.

### English

```text
English speech
→ English ASR
→ Gemini response
→ English GPT-SoVITS audio
```

works reliably.

No:

```text
averaged_perceptron_tagger_eng not found
```

error.

### Mixed language

Mixed or explicitly switched-language responses do not crash and are assigned an appropriate target language / auto mode.

### Reference language

The Japanese Kurisu reference remains configured independently from synthesized target language.

### Startup

A normal launcher start does not allow the bot to send a TTS request before GPT-SoVITS is actually ready, or otherwise handles that condition gracefully.

### Tests

Automated tests cover language normalization and the separation between:

```text
prompt_lang
```

and:

```text
text_lang
```

### Documentation

A fresh developer following repository setup documentation can reproduce English, Chinese, and Japanese speech without undocumented manual dependency steps.

---

# 40. Expected deliverables from the coding agent

At completion, provide:

## A. Root-cause report

Briefly state:

* where Japanese was being forced;
* why Chinese went through Japanese preprocessing;
* why English failed;
* why the initial English request sometimes received connection refused;
* whether any previous partial language-routing implementation already existed.

## B. Changed files

List each changed file and why it was changed.

Do not simply provide a git diff without explanation.

## C. Language-routing design

Document the final rule, for example:

```text
response metadata
→ text evidence
→ ASR language hint
→ auto fallback
```

or whatever rule best fits the actual implementation.

## D. Configuration semantics

Clearly document the difference between:

```text
GPT_SOVITS_PROMPT_LANG
```

and any target-language configuration.

## E. Tests performed

Include exact results for:

```text
Japanese direct TTS
Chinese direct TTS
English direct TTS
mixed-language direct TTS
unit tests
typecheck
Discord /voice-test
full voice conversation
```

## F. Remaining limitations

For example:

* mixed Chinese/Japanese Han-only fragments may be ambiguous;
* Gemini quota may prevent final live conversation testing;
* `auto` behavior depends on the vendored GPT-SoVITS version.

Do not claim a test passed if it was blocked by quota or unavailable hardware.

---

# 41. Evidence supplied with this task

Use the supplied logs as regression evidence.

The key known observations are:

1. Qwen recognizes Chinese correctly while GPT-SoVITS is subsequently invoked as Japanese.
2. GPT-SoVITS then emits Japanese frontend/phoneme warnings while processing Chinese text.
3. English GPT-SoVITS preprocessing fails because the required NLTK `averaged_perceptron_tagger_eng` resource is absent.
4. A later run shows that `language=en` can reach the TTS layer, suggesting a partial language-routing fix may already exist in the current checkout; however, that request fails because port 9880 is not yet accepting connections.
5. Later turns are also blocked by Gemini quota errors, so those logs cannot be used to conclude that Chinese/English TTS itself failed after the partial routing change.
6. The README already provides `/voice-test` specifically to bypass ASR and Gemini during TTS/playback testing.

Use these observations to guide investigation, but verify everything against the actual repository state before editing.

---

# 42. Definition of the intended final behavior

The final implementation should make language a property of the **speech being synthesized**, not a permanent property of the Kurisu voice.

In other words:

```text
Kurisu voice identity
    ≠
Japanese-only speech
```

The Japanese reference audio defines the speaker.

The target-language field defines what that speaker is currently saying.

The system should therefore be capable of:

```text
Kurisu speaking Japanese
Kurisu speaking Chinese
Kurisu speaking English
```

without switching models and without modifying the Japanese reference language on every conversational turn.

That separation is the central design requirement of this task.
