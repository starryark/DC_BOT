# DC_BOT Emotion-Aware Speech and Latency Optimization Plan

## 1. Mission

Implement an emotion-aware speech pipeline for the Discord bot so that ACT-v1 signals such as:

```text
<|ACT:"emotion":{"name":"think","intensity":0.5},"motion":"微微颔首，看向屏幕"|>
```

control the acoustic delivery of the following speech.

The implementation must:

1. Select an appropriate GPT-SoVITS reference clip from an operator-editable voice-profile catalog.
2. Pass the selected reference audio, exact reference transcript, sampling parameters, timing parameters, and deterministic seed into GPT-SoVITS.
3. Preserve the existing guarantees around cancellation epochs, ordered playback, history cleanliness, and one-chunk lookahead.
4. Remove unnecessary double segmentation.
5. Add latency instrumentation for HTTP headers, first audio byte, first playback, and full response completion.
6. Support incremental rollout: the bot must continue working with a single neutral reference while additional references are being prepared.
7. Provide a template where the operator can manually insert reference-audio paths and exact spoken transcripts.

The implementation should focus first on intentional speech variation. Raw PCM transport, advanced VAD, and full barge-in improvements are follow-up work unless they can be introduced without expanding the core change excessively.

---

# 2. Repository Context: Do Not Rediscover

The agent should work from this known state rather than repeating a broad repository audit.

## Current pipeline

The direct voice path is:

```text
Discord voice
  → Qwen3-ASR
  → Gemini streamed text
  → ACT/DELAY token stripping
  → multilingual speech chunker
  → bounded GPT-SoVITS synthesis
  → Discord playback
```

`ConversationController.generateAndSpeak()` passes Gemini output through `chunkStream()`. The chunker strips ACT/DELAY tokens, calls `onControlToken()`, and emits plain strings into `runBoundedTtsPipeline()`. The controller then synthesizes and plays each string.

The current controller parses ACT tokens and logs `emotion`, `intensity`, and `motionHint`, but this information does not enter `TtsRequest`. DELAY tokens are implemented by awaiting a timer directly inside the control-token callback.

The current `TtsRequest` contains only:

```ts
{
  text: string
  language: GptSoVitsLang
  pronunciationProfileVersion?: string
}
```

It cannot represent an emotional reference, prosody controls, or a deterministic seed.

The GPT-SoVITS provider currently sends one configured reference clip and transcript for every request, along with:

```ts
media_type: 'wav'
streaming_mode: cfg.streamingMode
speed_factor: 1.0
text_split_method: 'cut5'
```

No ACT-derived state is used.

GPT-SoVITS supports `top_k`, `top_p`, `temperature`, `speed_factor`, `fragment_interval`, `seed`, `repetition_penalty`, streaming modes 0–3, and other controls. The checked-in text segmentation implementation includes `cut0`, explicitly defined as no additional splitting.

The repository already has:

* A one-chunk synthesized lookahead with a cancellation-waste bound.
* Epoch checks preventing stale synthesis and playback.
* A two-tier TTS cache with extensible synthesis parameters in its identity.
* Vitest tests for control-token stripping, chunking, TTS ordering, provider request bodies, and cache behavior.

The character card declares the ACT emotion vocabulary:

```text
happy
sad
angry
think
surprised
awkward
question
curious
neutral
```

The existing character voice profile contains a provider, voice ID, and prompt language, but no emotional reference bank.

## Repository rules

Before editing, read:

```text
airi/AGENTS.md
```

Follow its TypeScript, testing, JSDoc, module-boundary, and no-commit requirements. Use pnpm workspace filters and Vitest. The guide prefers Valibot for schema validation, and Valibot is already present in the workspace catalog, though it is not currently a direct dependency of the Discord bot package.

Do not clone another copy of the repository. Do not create commits.

---

# 3. Core Architectural Decision

Introduce a structured stream between Gemini and TTS.

Replace this conceptual contract:

```ts
AsyncIterable<string>
```

with:

```ts
AsyncIterable<StyledSpeechChunk>
```

The new stream must preserve the order of:

```text
text → ACT → text → DELAY → text
```

ACT and DELAY must no longer be side-effect callbacks disconnected from the chunks they govern.

## Target architecture

```text
Gemini deltas
  ↓
tokenizeSpeechStream()
  ↓
SpeechEvent stream
  ├── text delta
  ├── ACT action
  └── DELAY request
  ↓
StyleAwareSpeechChunker
  ↓
StyledSpeechChunk
  {
    text,
    style,
    pauseBeforeMs,
    boundary
  }
  ↓
bounded TTS pipeline
  ↓
TtsRequest with resolved conditioning
  ↓
GPT-SoVITS
```

## Critical invariant

An ACT token applies only to speech that follows it.

For example:

```text
<|ACT think|> First clause.
<|ACT surprised|> Second clause!
```

must produce:

```ts
[
  {
    text: 'First clause.',
    style: { emotion: 'think', profileId: 'analytical', ... },
  },
  {
    text: 'Second clause!',
    style: { emotion: 'surprised', profileId: 'surprised', ... },
  },
]
```

A later ACT token must never mutate the style object already attached to an earlier chunk. Every emitted chunk receives an immutable style snapshot.

---

# 4. Operator-Editable Voice Profile Template

## New files

Add:

```text
airi/services/discord-bot/config/gpt-sovits-voice-profiles.example.json
airi/services/discord-bot/src/providers/tts/voice-profile-catalog.ts
airi/services/discord-bot/src/providers/tts/voice-profile-catalog.test.ts
```

The operator will copy the example to a local file, such as:

```text
TTS-KurisuMakise/voice-profiles.local.json
```

Add this configuration:

```dotenv
GPT_SOVITS_VOICE_PROFILES_FILE=../../../TTS-KurisuMakise/voice-profiles.local.json
```

The catalog’s `referenceAudio` values should use the same path semantics as the current GPT-SoVITS request: they are paths sent to the Python GPT-SoVITS server and are normally relative to the GPT-SoVITS process working directory.

The `referenceText` value must be the exact transcript of the associated reference clip. It must not be a summary, emotion description, filename, or translation.

## Template

Create the following JSON template. JSON comments are not permitted, so guidance belongs in the README rather than inside the JSON.

```json
{
  "schemaVersion": 1,
  "catalogVersion": "kurisu-prosody-v1",
  "defaultProfile": "neutral",
  "profiles": {
    "neutral": {
      "label": "Neutral baseline",
      "referenceAudio": "../TTS-KurisuMakise/REPLACE-neutral.wav",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 15,
      "topP": 0.95,
      "temperature": 0.85,
      "repetitionPenalty": 1.35,
      "speedFactor": 1.0,
      "fragmentInterval": 0.12,
      "textSplitMethod": "cut0",
      "variationSeeds": [11001, 11002, 11003],
      "warmup": true
    },
    "analytical": {
      "label": "Thinking or analytical",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 12,
      "topP": 0.9,
      "temperature": 0.74,
      "repetitionPenalty": 1.38,
      "speedFactor": 0.99,
      "fragmentInterval": 0.16,
      "textSplitMethod": "cut0",
      "variationSeeds": [12001, 12002, 12003],
      "warmup": true
    },
    "questioning": {
      "label": "Questioning or skeptical",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 16,
      "topP": 0.95,
      "temperature": 0.86,
      "repetitionPenalty": 1.34,
      "speedFactor": 1.0,
      "fragmentInterval": 0.12,
      "textSplitMethod": "cut0",
      "variationSeeds": [13001, 13002, 13003],
      "warmup": true
    },
    "curious": {
      "label": "Interested or curious",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 18,
      "topP": 0.97,
      "temperature": 0.92,
      "repetitionPenalty": 1.33,
      "speedFactor": 1.01,
      "fragmentInterval": 0.11,
      "textSplitMethod": "cut0",
      "variationSeeds": [14001, 14002, 14003],
      "warmup": false
    },
    "amused": {
      "label": "Happy or amused",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 20,
      "topP": 0.98,
      "temperature": 0.98,
      "repetitionPenalty": 1.3,
      "speedFactor": 1.02,
      "fragmentInterval": 0.1,
      "textSplitMethod": "cut0",
      "variationSeeds": [15001, 15002, 15003],
      "warmup": false
    },
    "concerned": {
      "label": "Sad, concerned, or gentle",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 12,
      "topP": 0.9,
      "temperature": 0.76,
      "repetitionPenalty": 1.38,
      "speedFactor": 0.98,
      "fragmentInterval": 0.18,
      "textSplitMethod": "cut0",
      "variationSeeds": [16001, 16002, 16003],
      "warmup": false
    },
    "irritated": {
      "label": "Angry, firm, or irritated",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 17,
      "topP": 0.94,
      "temperature": 0.88,
      "repetitionPenalty": 1.37,
      "speedFactor": 1.01,
      "fragmentInterval": 0.09,
      "textSplitMethod": "cut0",
      "variationSeeds": [17001, 17002, 17003],
      "warmup": false
    },
    "surprised": {
      "label": "Surprised",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 21,
      "topP": 0.98,
      "temperature": 1.0,
      "repetitionPenalty": 1.3,
      "speedFactor": 1.03,
      "fragmentInterval": 0.08,
      "textSplitMethod": "cut0",
      "variationSeeds": [18001, 18002, 18003],
      "warmup": false
    },
    "awkward": {
      "label": "Awkward, shy, or embarrassed",
      "referenceAudio": "",
      "referenceText": "",
      "promptLanguage": "ja",
      "topK": 14,
      "topP": 0.93,
      "temperature": 0.84,
      "repetitionPenalty": 1.36,
      "speedFactor": 0.99,
      "fragmentInterval": 0.17,
      "textSplitMethod": "cut0",
      "variationSeeds": [19001, 19002, 19003],
      "warmup": false
    }
  },
  "emotionMap": {
    "neutral": "neutral",
    "think": "analytical",
    "question": "questioning",
    "curious": "curious",
    "happy": "amused",
    "sad": "concerned",
    "angry": "irritated",
    "surprised": "surprised",
    "awkward": "awkward"
  }
}
```

## Template behavior

Only `neutral` must be complete for the catalog to load.

A non-default profile with a missing `referenceAudio` or `referenceText` must be marked unavailable and ignored with one startup warning:

```text
voice_profile_disabled profileId=surprised reason=missing_reference_text
```

If an emotion maps to an unavailable profile, use `neutral`.

Do not silently accept an incomplete default profile. If the catalog is configured but `defaultProfile` is invalid, fail startup with a clear message.

`label` is human-readable metadata only. The exact spoken transcript belongs in `referenceText`.

Whenever an audio file is replaced without changing its path, the operator must update `catalogVersion`. Document this explicitly because the catalog version participates in cache identity.

---

# 5. New Domain Types

Add the following concepts to a dedicated side-effect-free type module, preferably:

```text
src/providers/tts/speech-style-types.ts
```

Do not place runtime configuration reads in this module.

```ts
export type SpeechBoundary =
  | 'sentence'
  | 'clause'
  | 'hard-limit'
  | 'control-token'
  | 'stream-end'

export interface VoiceSamplingControls {
  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number
}

export interface VoiceTimingControls {
  speedFactor: number
  fragmentInterval: number
  textSplitMethod: string
}

export interface VoiceReferenceProfile {
  id: string
  label: string
  referenceAudio: string
  referenceText: string
  promptLanguage: GptSoVitsLang
  sampling: VoiceSamplingControls
  timing: VoiceTimingControls
  variationSeeds: number[]
  warmup: boolean
}

export interface VoiceProfileCatalog {
  schemaVersion: 1
  catalogVersion: string
  defaultProfileId: string
  profiles: ReadonlyMap<string, VoiceReferenceProfile>
  emotionMap: ReadonlyMap<string, string>
}

export interface ResolvedSpeechStyle {
  emotion: string
  intensity: number
  profileId: string
  catalogVersion: string

  referenceAudio: string
  referenceText: string
  promptLanguage: GptSoVitsLang

  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number

  speedFactor: number
  fragmentInterval: number
  textSplitMethod: string

  seed: number
  variationIndex: number
}

export interface StyledSpeechChunk {
  text: string
  style: Readonly<ResolvedSpeechStyle>
  pauseBeforeMs: number
  boundary: SpeechBoundary
}
```

Use `Readonly` or frozen objects at the emission boundary so an ACT token arriving later cannot alter an earlier chunk.

---

# 6. Catalog Validation and Configuration

## Configuration additions

Extend `TtsClientConfig`:

```ts
voiceProfilesFile: string
maxModelPauseMs: number
warmupEnabled: boolean
```

Suggested environment variables:

```dotenv
GPT_SOVITS_VOICE_PROFILES_FILE=
GPT_SOVITS_MAX_MODEL_PAUSE_MS=350
GPT_SOVITS_WARMUP_ENABLED=true
```

An empty catalog path means explicit single-reference mode using the existing:

```dotenv
GPT_SOVITS_REF_AUDIO
GPT_SOVITS_PROMPT_TEXT
GPT_SOVITS_PROMPT_LANG
```

This is not a hidden fallback inside a malformed catalog. These are two explicit deployment modes:

```text
No catalog configured:
  single-reference mode

Catalog configured:
  validated profile-bank mode
```

When profile-bank mode is configured, do not fall back to the global reference because of a catalog error. Fail startup for an invalid default profile.

## Validation

Use Valibot unless adding it directly to the Discord bot package introduces an unexpected package-boundary problem. It is already in the workspace catalog.

Validation must enforce:

* `schemaVersion === 1`
* Nonempty `catalogVersion`
* Nonempty `defaultProfile`
* Profile IDs with a conservative identifier format such as `/^[a-z0-9][a-z0-9_-]*$/`
* Prompt languages restricted to supported GPT-SoVITS languages used by the bot
* `topK` within a bounded positive integer range
* `topP` within `(0, 1]`
* `temperature` within a safe range, for example `[0.1, 2]`
* `repetitionPenalty` within a safe range
* `speedFactor` within `[0.9, 1.1]`
* `fragmentInterval` within `[0, 1]`
* `textSplitMethod` initially restricted to `cut0` or another consciously approved method
* Positive integer seeds
* At least one variation seed on each enabled profile
* All emotion-map targets must either exist or generate a startup warning and fall back to the default

Do not log `referenceText`.

---

# 7. Speech Event Tokenizer

Create:

```text
src/orchestration/speech-events.ts
src/orchestration/speech-events.test.ts
```

## Event types

```ts
export type SpeechEvent =
  | { kind: 'text'; delta: string }
  | { kind: 'action'; action: AvatarAction }
  | { kind: 'delay'; requestedMs: number }
```

## Responsibilities

`tokenizeSpeechStream()` must:

1. Consume arbitrary Gemini delta boundaries.
2. Reassemble ACT/DELAY tokens split across deltas.
3. Emit ordinary text in the original order.
4. Parse complete control tokens with the existing bounded ACT-v1 parser.
5. Never emit markup as text.
6. Ignore malformed control metadata without throwing.
7. Preserve the current maximum-held-token safety behavior.
8. Emit actions and delays in document order.
9. Avoid sleeping or performing playback side effects.

The existing `stripControlTokens()` tests provide the behavioral starting point. Refactor rather than duplicate its scanner.

Keep a compatibility helper only if existing production callers still need plain strings during the migration. Remove it once all production call sites use structured events.

---

# 8. Style Resolver

Create:

```text
src/orchestration/speech-style-resolver.ts
src/orchestration/speech-style-resolver.test.ts
```

## Inputs

```ts
{
  action?: AvatarAction
  catalog: VoiceProfileCatalog
  neutralStyle: ResolvedSpeechStyle
  turnId: string
  chunkIndex: number
  text: string
}
```

## Resolution

1. Normalize the emotion string with trim and lowercase.
2. Clamp intensity to `[0, 1]`.
3. Map the ACT emotion through `catalog.emotionMap`.
4. Use the default profile if:

   * Emotion is missing.
   * Emotion is unknown.
   * The mapped profile is unavailable.
5. Select a deterministic variation seed.
6. Interpolate numeric controls between the neutral profile and selected profile using intensity.
7. Clamp all interpolated outputs again.
8. Return an immutable style snapshot.

## Intensity interpolation

The reference clip changes categorically, but numeric controls should scale with intensity:

```ts
resolvedValue = neutralValue + (selectedValue - neutralValue) * intensity
```

Use appropriate rounding for integer parameters such as `topK`.

This gives `intensity` a meaningful effect without allowing extreme model parameters.

## Deterministic variation

Select a variation index with a stable hash of:

```text
turnId
profileId
chunkIndex
catalogVersion
```

Then:

```ts
variationIndex = hash % variationSeeds.length
seed = variationSeeds[variationIndex]
```

A retry of the same chunk in the same turn must use the same seed.

For cacheable fixed prompts such as cooldown notices, use a stable synthetic turn ID:

```text
system:cooldown
system:one-at-a-time
```

This keeps those prompts cacheable and reproducible.

---

# 9. Style-Aware Chunker

Create or refactor toward:

```text
src/orchestration/style-aware-speech-chunker.ts
src/orchestration/style-aware-speech-chunker.test.ts
```

The existing `SpeechChunker` boundary logic should remain reusable. Do not duplicate multilingual punctuation detection.

## State

The style-aware chunker owns:

```ts
activeAction
activeResolvedStyle
pendingPauseBeforeMs
textBuffer
bufferStyle
```

## Event behavior

### Text event

Append text to the current multilingual chunker.

When the buffer becomes nonempty, snapshot the current style as `bufferStyle`.

When a natural boundary is produced, emit:

```ts
{
  text,
  style: bufferStyle,
  pauseBeforeMs,
  boundary
}
```

Then reset `pauseBeforeMs` to zero.

### ACT event

If the text buffer is empty:

```text
Update active style immediately.
```

If the text buffer is nonempty:

```text
Flush the buffered text with its existing style.
Then update the active style.
```

This creates a semantic boundary at the control token and prevents style leakage.

ACT tokens should normally occur at clause boundaries because of prompt rules. A control-token flush may therefore produce a shorter-than-normal chunk, but it must never attach a new emotion retroactively to earlier text.

### DELAY event

If the text buffer is nonempty:

```text
Flush the current text first.
```

Then add the delay to `pendingPauseBeforeMs` for the next speech chunk.

Apply:

```ts
appliedMs = Math.min(requestedMs, config.tts.maxModelPauseMs)
```

Do not sleep in the tokenizer or chunker.

If multiple DELAY tokens occur before the next text, add them together and clamp the total.

A trailing DELAY at the end of the response must be discarded. It must not keep the turn open after all speech has played.

## Prompt adjustment

Update the model delivery rules in the prompt compiler:

```text
- Emit ACT before the spoken clause it controls.
- Change ACT only at a sentence or clause boundary.
- Use no more than two ACT changes in an ordinary response.
- DELAY may appear only between complete clauses.
- Do not emit DELAY after the final spoken text.
- Prefer a short, immediately speakable first clause.
```

Do not weaken the existing rule that control markup must never appear in visible text, TTS text, or history.

---

# 10. Generalize the Bounded TTS Pipeline

Change:

```ts
runBoundedTtsPipeline<TAudio>(
  chunks: AsyncIterable<string>,
  ...
)
```

to:

```ts
runBoundedTtsPipeline<TChunk, TAudio>(
  chunks: AsyncIterable<TChunk>,
  options: {
    synthesize: (chunk: TChunk, chunkIndex: number) => Promise<TAudio | null>
    play: (prepared: PreparedTtsChunk<TChunk, TAudio>) => Promise<void>
    isCancelled: () => boolean
    onChunk?: (chunk: TChunk, chunkIndex: number) => void
  }
)
```

`PreparedTtsChunk` should retain the original structured chunk:

```ts
export interface PreparedTtsChunk<TChunk, TAudio> {
  chunk: TChunk
  chunkIndex: number
  audio: TAudio
}
```

Preserve these existing guarantees:

* Synthesis order is deterministic.
* Playback order is deterministic.
* At most one synthesized but unplayed successor exists.
* Cancellation prevents future iterator advancement.
* A stale response never reaches playback.

Do not increase prefetch depth as part of this work.

---

# 11. Extend `TtsRequest`

Add a synthesis-conditioning object:

```ts
export interface TtsConditioning {
  profileId: string
  catalogVersion: string

  referenceAudio: string
  referenceText: string
  promptLanguage: GptSoVitsLang

  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number

  speedFactor: number
  fragmentInterval: number
  textSplitMethod: string

  seed: number
  variationIndex: number
}

export interface TtsTraceContext {
  guildId: string
  turnId: string
  responseEpoch: number
  chunkIndex: number
}

export interface TtsRequest {
  text: string
  language: GptSoVitsLang
  pronunciationProfileVersion?: string
  conditioning?: TtsConditioning
  trace?: TtsTraceContext
}
```

`trace` must never participate in the cache identity.

`conditioning` should be required for normal conversational synthesis after the catalog is integrated. It may remain optional for the explicit single-reference deployment mode and isolated tests.

---

# 12. Conversation Controller Integration

Only the integration lead should edit:

```text
src/orchestration/conversation-controller.ts
```

This prevents parallel subagents from conflicting in the central orchestrator.

## Required changes

Replace:

```ts
const stream = chunkStream(
  this.brain.generate(...),
  token => this.onControlToken(...),
  ...
)
```

with a structured pipeline:

```ts
const events = tokenizeSpeechStream(this.brain.generate(...))

const chunks = styledChunkStream(events, {
  catalog: this.voiceProfileCatalog,
  initialStyle: this.defaultSpeechStyle,
  maxPauseMs: config().tts.maxModelPauseMs,
  chunking: config().ttsChunking,
  onAvatarAction: action => this.publishOrLogAvatarAction(...),
})
```

The avatar action should still be logged or published immediately.

The audio style and avatar action must originate from the same parsed action object.

## Synthesis

Change `synthesizeChunk()` to receive `StyledSpeechChunk`.

It must:

1. Resolve target speech language as it does now.
2. Apply pronunciation substitutions.
3. Pass the chunk’s immutable conditioning to TTS.
4. Include trace context.
5. Log style metadata without logging prompt text.

Example:

```text
tts_style_resolved
  guildId=...
  turnId=...
  chunkIndex=...
  emotion=think
  intensity=0.5
  profileId=analytical
  variationIndex=1
  seed=12002
  speedFactor=0.995
  temperature=0.795
```

## Playback pause

Move DELAY handling into playback:

```ts
await cancellableDelay(chunk.pauseBeforeMs, parentSignal)
```

Perform the delay immediately before queueing that chunk.

Because the successor may already be synthesizing in the one-chunk lookahead slot, model-requested pauses no longer prevent generation or TTS prefetch.

Check the epoch and abort signal both before and after the delay.

## History

Append only:

```ts
chunk.text
```

to `fullReply`.

Control tokens, style IDs, pause metadata, and reference labels must never enter conversation history.

---

# 13. GPT-SoVITS Provider Changes

Update:

```text
src/providers/tts/gpt-sovits.ts
src/providers/tts/gpt-sovits.test.ts
```

## Request body

When conditioning is present, send:

```ts
const body = {
  text: request.text,
  text_lang: textLang,

  ref_audio_path: conditioning.referenceAudio,
  prompt_text: conditioning.referenceText,
  prompt_lang: conditioning.promptLanguage,

  top_k: conditioning.topK,
  top_p: conditioning.topP,
  temperature: conditioning.temperature,
  repetition_penalty: conditioning.repetitionPenalty,

  speed_factor: conditioning.speedFactor,
  fragment_interval: conditioning.fragmentInterval,
  seed: conditioning.seed,

  text_split_method: conditioning.textSplitMethod,
  media_type: 'wav',
  streaming_mode: cfg.streamingMode,

  batch_size: 1,
  split_bucket: cfg.streamingMode === 0,
  parallel_infer: cfg.streamingMode === 0
}
```

Use `cut0` for bot-generated semantic chunks. The bot chunker already owns sentence and clause segmentation.

Do not allow a profile to override the deployment streaming mode in the first implementation. Streaming mode affects transport behavior and should remain a deployment-level benchmark choice.

## Safe parameter policy

Do not use large speed changes as the main emotional control.

Keep validated speed values close to `1.0`. Emotional differences should come primarily from:

1. Reference audio.
2. Reference transcript.
3. Sampling controls.
4. Clause timing.
5. Small speed adjustments.

## HTTP timing instrumentation

Measure:

```text
request_started
headers_received
first_audio_byte
stream_ended
```

`fetch()` resolving means headers are available, not that the user has heard audio.

Wrap the returned response stream with a pass-through transform or async generator that logs the first nonempty audio chunk exactly once.

Suggested log events:

```text
tts_http_headers_received
tts_first_audio_byte
tts_audio_stream_completed
```

Include:

```text
profileId
streamingMode
chars
headersMs
firstByteMs
totalStreamMs
```

Do not log reference transcripts.

---

# 14. Cache Identity

Update:

```text
src/providers/tts/tts-cache.ts
src/providers/tts/tts-cache.test.ts
src/index.ts
```

Bump:

```ts
TTS_CACHE_KEY_VERSION
```

from `1` to `2`.

The cache identity must include all fields capable of changing audio:

```ts
{
  normalizedText,
  textLanguage,
  pronunciationProfileVersion,

  voiceModelVersion,
  catalogVersion,
  profileId,
  referenceAudioFingerprint,
  promptTextFingerprint,
  promptLanguage,

  topK,
  topP,
  temperature,
  repetitionPenalty,
  speedFactor,
  fragmentInterval,
  seed,
  variationIndex,

  mediaType,
  streamingMode,
  textSplitMethod
}
```

Because the bot may not have filesystem access semantics matching the Python server, fingerprint the reference-audio path string together with `catalogVersion`, rather than requiring the Node process to read the audio file.

Document:

```text
Replacing audio at the same path requires a catalogVersion bump.
```

The cache key must not include:

```text
guildId
turnId
responseEpoch
chunkIndex
motionHint
```

The selected seed already captures the intended acoustic variation.

---

# 15. Startup and Warm-Up

## Bootstrap

In `src/index.ts`:

1. Load configuration.
2. Load and validate the voice catalog when configured.
3. Construct the raw GPT-SoVITS provider.
4. Construct the cache wrapper.
5. Pass the catalog into `ConversationController`.
6. Perform optional provider-level warm-up after GPT-SoVITS readiness and before Discord starts accepting conversational work.

## Warm-up policy

Do not warm every configured profile automatically.

Warm:

* The default profile.
* Profiles with `"warmup": true`.
* A maximum of three profiles by default.

Use a short Japanese sentence appropriate for the reference language.

Warm-up must bypass a disk-cache hit so the underlying model path is exercised. A cached WAV alone does not warm BERT, semantic generation, or vocoder kernels.

Add a raw-provider warm-up method or call the raw provider directly before wrapping it with the cache.

Warm-up failure should be logged but should not terminate startup after the catalog itself has validated.

---

# 16. Latency Improvements Included in This Change

## Remove double segmentation

Use `cut0` for already chunked conversational speech.

Keep bot-side multilingual chunking as the owner of semantic segmentation.

## Do not block generation on DELAY

Represent DELAY as `pauseBeforeMs` and apply it at playback time.

This allows the model and one TTS successor to continue preparing during the pause.

## Produce an immediately speakable first clause

Update prompt instructions so the model emits:

```text
ACT
short complete clause
remaining explanation
```

Avoid introductory fragments such as a standalone “Well” or “Okay” unless they are combined with the first meaningful clause.

## First-byte metrics

Do not treat `tts.synthesize()` returning a stream as “synthesis complete.”

Measure headers, first byte, playback queueing, actual player start, and drain separately.

## Streaming benchmark

Do not change the default from mode `0` in the core implementation.

After the style pipeline is stable, run a controlled benchmark of modes:

```text
0
1
2
3
```

Record:

```text
headers latency
first-byte latency
first-playback latency
full synthesis time
audio duration
real-time factor
quality score
boundary artifacts
```

Streaming may improve first-byte latency while increasing full synthesis time. Select it using measurements rather than assumption.

---

# 17. Deferred Performance Work

Keep these outside the first style-propagation patch unless the implementation remains small and independently testable:

1. Raw PCM from GPT-SoVITS to Discord.
2. Persistent resampling to 48 kHz stereo.
3. Crossfading adjacent generated chunks.
4. Silence trimming.
5. VAD replacement.
6. Adaptive speech endpointing.
7. Streaming ASR.
8. Guarded barge-in.
9. Speaker-embedding style-drift rejection.

Create follow-up notes rather than mixing all of these into one risky change.

---

# 18. Tests

## Catalog tests

Test:

* Valid catalog.
* Missing file.
* Invalid JSON.
* Wrong schema version.
* Empty catalog version.
* Missing default profile.
* Incomplete default profile.
* Incomplete optional profile disabled.
* Unknown emotion-map target.
* Parameter bounds.
* Unsupported prompt language.
* Empty variation-seed array.
* Explicit single-reference mode when no catalog path exists.

## Speech event tests

Test:

* Ordinary text.
* ACT in one delta.
* ACT split over many deltas.
* DELAY split over many deltas.
* Multiple tokens in one delta.
* Text before and after a token.
* Malformed ACT.
* Truncated token at stream end.
* Token maximum-held-length behavior.
* No markup reaches text events.

## Styled chunk tests

Test:

* Initial ACT styles the first chunk.
* Two ACT tokens create two differently styled chunks.
* Style changes do not mutate an earlier emitted chunk.
* ACT with no emotion falls back safely.
* Unknown emotion uses neutral.
* Unavailable mapped profile uses neutral.
* Intensity zero resolves numeric controls to neutral.
* Intensity one resolves numeric controls to the selected profile.
* Intermediate intensity interpolates correctly.
* DELAY is attached to the following chunk.
* DELAY is capped.
* Multiple DELAY values accumulate and cap.
* Trailing DELAY is ignored.
* ACT in a nonempty buffer creates a control-token boundary.
* Control metadata never enters chunk text.

## Pipeline tests

Preserve all existing one-lookahead tests using structured chunks.

Add:

* Chunk metadata survives synthesis and playback.
* Cancellation during `pauseBeforeMs` stops playback.
* Cancellation during TTS prevents queueing.
* No future chunk is synthesized after cancellation.
* Playback remains ordered across different styles.

## Provider tests

Assert the request body includes:

```text
ref_audio_path
prompt_text
prompt_lang
top_k
top_p
temperature
repetition_penalty
speed_factor
fragment_interval
seed
text_split_method=cut0
```

Preserve independent `text_lang` and `prompt_lang` tests.

Add first-byte instrumentation tests using a response stream that delays its first chunk.

## Cache tests

Changing any of these must change the key:

```text
catalogVersion
profileId
referenceAudio
referenceText
temperature
speedFactor
seed
textSplitMethod
pronunciationProfileVersion
```

Changing trace context must not change the key.

## Controller integration tests

Use fake providers and a fake Gemini delta stream.

Assert:

* `think` reaches TTS as `analytical`.
* `surprised` reaches TTS as `surprised`.
* TTS receives the exact catalog transcript.
* History contains only spoken text.
* Avatar logging/publishing still occurs.
* A stale epoch cannot play a styled chunk.
* The applied model pause is capped.
* A final DELAY does not delay response completion.

---

# 19. Manual Audio Evaluation

Add:

```text
airi/services/discord-bot/scripts/evaluate-voice-styles.ts
```

The script should synthesize a fixed corpus into an output directory with a manifest.

## Corpus

For each enabled profile, include:

* One neutral statement.
* One question.
* One short clause.
* One longer two-clause sentence.
* One sentence containing character-specific names.

Cover Japanese first. Add smaller Chinese and English subsets to detect cross-language voice drift.

## Manifest

Record:

```json
{
  "profileId": "analytical",
  "emotion": "think",
  "intensity": 0.7,
  "seed": 12002,
  "text": "...",
  "language": "ja",
  "headersMs": 0,
  "firstByteMs": 0,
  "totalMs": 0,
  "audioBytes": 0,
  "outputFile": "..."
}
```

## Human scoring

Score each sample from 1–5 for:

```text
Speaker identity
Emotional appropriateness
Natural pitch contour
Rhythm and pauses
Pronunciation
Chunk-boundary smoothness
Noise or artifacts
```

Do not accept a configuration using latency numbers alone.

---

# 20. Documentation

Update:

```text
airi/services/discord-bot/.env.example
README.md
RUNBOOK.md
airi/docs/voice-optimization/emotion-aware-speech.md
```

Document:

* How to copy the profile template.
* Where to place reference clips.
* How `referenceAudio` is interpreted.
* How to transcribe a reference clip exactly.
* Why empty `referenceText` disables a profile.
* How emotion mapping works.
* How fallback to neutral works.
* Why audio replacement requires `catalogVersion` changes.
* Why `cut0` is used.
* How to run profile evaluation.
* How to run typecheck, tests, and voice benchmarks.
* How to disable the catalog and return to explicit single-reference mode.

---

# 21. Subagent Execution Strategy

The lead agent owns context consolidation and central integration. Subagents should receive narrow file ownership and return concise reports rather than pasting entire source files into the lead context.

## Shared context packet for every subagent

Give every subagent this exact context:

```text
Repository: DC_BOT, existing checkout. Do not clone and do not commit.

Goal:
Carry ACT-v1 emotion and intensity into GPT-SoVITS through an operator-editable voice reference catalog while preserving cancellation, history cleanliness, ordered playback, and one synthesized lookahead.

Known current behavior:
- ConversationController sends Gemini through chunkStream().
- ACT is stripped and only logged.
- DELAY sleeps in onControlToken().
- TtsRequest has no style.
- GPT-SoVITS always uses the same configured reference, speed 1.0, and cut5.
- TTS cache identity is extensible but currently version 1.
- GPT-SoVITS supports reference text/audio, sampling controls, seeds, fragment interval, cut0, and streaming modes.
- Control markup must never reach TTS, Discord-visible text, or history.
- Do not increase TTS lookahead beyond one.
- Do not weaken response-epoch checks.
- Follow airi/AGENTS.md.
- Use Vitest and pnpm workspace commands.
- Do not add unrelated refactors.
```

Each subagent response must contain:

```text
1. Files examined.
2. Invariants found.
3. Proposed or completed changes.
4. Tests added or required.
5. Risks or unresolved questions.
6. Exact commands run.
```

## Wave 0: Focused reconnaissance

These subagents perform narrow verification only. They do not edit production code.

### Subagent 0A — Stream and cancellation contracts

Read:

```text
conversation-controller.ts
speech-chunker.ts
tts-pipeline.ts
conversation-state.ts
speech-chunker.test.ts
tts-pipeline.test.ts
```

Deliver:

* The exact cancellation and ordering invariants.
* Every string-only interface that must become generic or structured.
* Places where a style object might accidentally be mutated.
* A recommended event/chunk contract.

### Subagent 0B — GPT-SoVITS request specialist

Read:

```text
gpt-sovits.ts
gpt-sovits.test.ts
GPT-SoVITS/api_v2.py
GPT-SoVITS/GPT_SoVITS/TTS_infer_pack/text_segmentation_method.py
```

Deliver:

* Verified request parameter names and ranges.
* Confirmation of `cut0`.
* Streaming-mode behavior relevant to the Node stream.
* Parameters that materially affect cache identity.
* Any incompatibility between WAV streaming and modes 1–3.

### Subagent 0C — Configuration and cache specialist

Read:

```text
config.ts
.env.example
tts-cache.ts
tts-cache.test.ts
index.ts
package.json
```

Deliver:

* Catalog-loading placement.
* Valibot dependency recommendation.
* Exact cache identity changes.
* Startup failure and fallback policy.
* Warm-up integration options.

### Subagent 0D — Character and prompt specialist

Read:

```text
card.json
card-schema.ts
character-registry.ts
character/types.ts
prompt-compiler.ts
act-v1-parser.ts
```

Deliver:

* Exact emotion vocabulary.
* Prompt changes that keep ACT at clause boundaries.
* Whether any character-runtime type should reference the profile catalog.
* A recommendation on keeping the catalog as deployment configuration rather than embedding API-facing paths in the character card.

The lead consolidates Wave 0 into a one-page decision record before coding.

## Wave 1: Parallel foundation implementation

Subagents in this wave must not edit overlapping files.

### Subagent 1A — Voice catalog

Own:

```text
voice-profile-catalog.ts
voice-profile-catalog.test.ts
speech-style-types.ts
gpt-sovits-voice-profiles.example.json
config.ts
.env.example
```

Implement:

* Schema.
* Validation.
* Optional-profile disabling.
* Default-profile failure.
* Configuration parsing.
* Template.

Do not edit `index.ts` or `conversation-controller.ts`.

### Subagent 1B — Structured speech events

Own:

```text
speech-events.ts
speech-events.test.ts
style-aware-speech-chunker.ts
style-aware-speech-chunker.test.ts
speech-style-resolver.ts
speech-style-resolver.test.ts
```

Implement:

* Token event stream.
* ACT and DELAY ordering.
* Style snapshots.
* Intensity interpolation.
* Deterministic variation selection.
* Delay accumulation and capping.

Do not edit provider or controller files.

### Subagent 1C — Provider and cache contracts

Own:

```text
providers/tts/types.ts
providers/tts/gpt-sovits.ts
providers/tts/gpt-sovits.test.ts
providers/tts/tts-cache.ts
providers/tts/tts-cache.test.ts
```

Implement:

* Extended request types.
* GPT-SoVITS request parameters.
* First-byte instrumentation.
* Cache-key version and identity support.

Do not edit `index.ts`.

### Subagent 1D — Generic bounded pipeline

Own:

```text
orchestration/tts-pipeline.ts
orchestration/tts-pipeline.test.ts
```

Generalize the pipeline to structured chunks while proving that the one-lookahead and cancellation guarantees remain unchanged.

## Wave 2: Lead integration

The lead agent integrates all Wave 1 outputs.

Lead-owned files:

```text
conversation-controller.ts
index.ts
prompt-compiler.ts
services or command wiring for /voice-test
README.md
RUNBOOK.md
```

Integration order:

1. Resolve all shared types.
2. Load catalog at startup.
3. Pass catalog into controller.
4. Replace string chunk stream with styled chunks.
5. Move DELAY to playback.
6. Connect style conditioning to `TtsRequest`.
7. Update cache identity construction.
8. Update prompt delivery rules.
9. Preserve system prompts and `/voice-test`.
10. Run targeted tests after each integration step.

## Wave 3: Independent reviews

### Subagent 3A — Concurrency reviewer

Review only.

Focus on:

* Epoch checks.
* Abort propagation.
* Delay cancellation.
* Iterator advancement.
* Mutable style references.
* Lookahead depth.
* Startup/shutdown cleanup.

Return concrete defects with file and line references.

### Subagent 3B — TTS and cache reviewer

Review only.

Focus on:

* Correct API parameter names.
* Reference-text handling.
* Prompt-language separation.
* Seed reproducibility.
* Cache-key completeness.
* Accidental logging of transcripts.
* Double segmentation.

### Subagent 3C — Test-gap reviewer

Review only.

Compare acceptance criteria against tests.

Reject smoke-only tests and identify missing regression coverage.

The lead fixes review findings before moving to benchmarks.

## Wave 4: Latency and quality experiments

### Subagent 4A — Benchmark instrumentation

Own the benchmark script and metrics.

Add:

```text
headersMs
firstByteMs
playbackQueuedMs
playbackStartedMs
drainedMs
profileId
variationIndex
streamingMode
```

### Subagent 4B — Streaming mode matrix

Run modes 0–3 with the same text, profile, seed, and hardware.

Do not change defaults. Return data and audio artifacts only.

### Subagent 4C — Audio quality evaluation

Generate the profile evaluation corpus and manifest.

Return:

* Broken profiles.
* Profiles that sound indistinguishable.
* Speaker-identity drift.
* Boundary artifacts.
* Recommended parameter changes.

The lead selects production defaults only after comparing latency and listening results.

---

# 22. Implementation Sequence for the Lead Agent

Follow this sequence exactly.

## Step 1 — Establish baseline

Run:

```powershell
Set-Location airi
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test
```

Save the output.

Do not begin with a broad cleanup.

## Step 2 — Add failing regression tests

Before production changes, add tests proving the current defect:

```text
An ACT emotion is observed, but the TTS request receives no corresponding style.
```

The test should fail against the current implementation.

## Step 3 — Add catalog types, loader, and example

Complete profile validation and neutral fallback independently of the conversation pipeline.

## Step 4 — Add structured speech events

Preserve every existing token-stripping behavior while exposing ACT and DELAY as events.

## Step 5 — Add style resolver and style-aware chunking

Prove multiple ACT transitions and delay placement using pure tests.

## Step 6 — Generalize the bounded pipeline

Keep the same operational behavior with structured chunks.

## Step 7 — Extend TTS provider and cache identity

Test request bodies and cache-key changes before controller integration.

## Step 8 — Integrate controller

Replace callback-based control handling with structured styled chunks.

Delete obsolete delay sleeping from `onControlToken()`.

Retain avatar action publication/logging.

## Step 9 — Add prompt rules

Make ACT placement predictable and clause-aligned.

## Step 10 — Add telemetry

Instrument headers, first byte, playback start, and drain.

## Step 11 — Add warm-up

Warm only default and explicitly flagged profiles.

## Step 12 — Documentation and template check

Verify a user can copy the example catalog, fill only neutral, start the bot, and add profiles incrementally.

## Step 13 — Full validation

Run:

```powershell
Set-Location airi
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test
pnpm lint
```

Then run the voice benchmark against local services.

Do not create a commit.

---

# 23. Acceptance Criteria

The work is complete only when all of these are true.

## Functional

* `think` selects the analytical profile.
* `surprised` selects the surprised profile when available.
* Missing emotional profiles fall back to neutral.
* Intensity alters resolved numeric controls.
* The exact reference transcript is sent to GPT-SoVITS.
* `cut0` is used for bot-generated chunks.
* Identical turn/chunk/style inputs produce the same seed.
* Different variation indices can produce different seeds.
* DELAY no longer blocks Gemini stream consumption.
* Applied pauses are capped.
* Trailing DELAY produces no dead air.

## Safety and correctness

* No ACT or DELAY markup reaches TTS.
* No ACT or DELAY markup reaches history.
* No reference transcript is written to logs.
* A stale epoch cannot play audio.
* Cancellation during a pause stops promptly.
* One synthesized lookahead remains the maximum.
* TTS errors still skip only the affected chunk.
* Prompt language remains independent from target text language.

## Cache

* Every audio-affecting parameter is in the key.
* Trace metadata is excluded.
* Cache key version is bumped.
* Catalog version invalidates audio generated from replaced references.

## Performance

* Profile resolution and event processing add negligible CPU time.
* Non-streaming median first-audio latency does not regress materially from baseline.
* Warm-up removes or substantially reduces the first live synthesis penalty.
* First-byte metrics are available for modes 0–3.
* No streaming mode is enabled by default without measured quality and latency evidence.

## Quality

* At least neutral, analytical, questioning, and awkward references are manually reviewed.
* Analytical and neutral are audibly distinguishable.
* Questions do not consistently end with flat declarative intonation.
* Chunk boundaries do not create obvious speaker-identity jumps.
* Reference changes do not cause unacceptable identity drift.

---

# 24. Expected Final Agent Report

The coding agent’s final response must include:

```text
Summary of architecture changes

Files added
Files modified

Behavior before
Behavior after

Profile template location
Instructions for filling referenceAudio and referenceText

Tests run and results

Benchmark results
- mode
- profile
- headers latency
- first-byte latency
- first-playback latency
- total latency

Known limitations

Deferred follow-up tasks

No commits created
```

The report must explicitly call out any acceptance criterion that could not be verified with the available audio references or hardware.
