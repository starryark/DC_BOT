# Discord Voice Bot Reliability and Performance Implementation Plan

## 1. Mission

Improve the Discord voice bot so that:

1. A response is never cut off because another synthesized chunk or response starts.
2. The bot ignores new speech while thinking or speaking by default.
3. Short phrases from the same user are combined into useful turns.
4. Multiple speakers do not produce overlapping bot responses or excessive Gemini calls.
5. Filler speech, duplicate transcripts, and low-value fragments do not reach Gemini.
6. Gemini quota failures trigger controlled cooldown behavior rather than repeated failing requests.
7. GPT-SoVITS work is reduced through chunking improvements and a reusable audio cache.
8. Cancellation, disconnects, and optional barge-in cannot leave stale audio playing.
9. The implementation is covered by deterministic tests and useful telemetry.

The existing pipeline is:

```text
Discord voice
    → Qwen3-ASR
    → Gemini
    → GPT-SoVITS
    → Discord voice
```

The repository README identifies `airi/services/discord-bot` as the bot implementation and documents the existing direct backend, local ASR and TTS services, endpointing configuration, streaming mode, and development test commands.

This plan is an optimization of the existing direct pipeline. Do not redesign the bot from scratch.

---

# 2. Evidence and current failure modes

## 2.1 Playback replacement

`@discordjs/voice` specifies that calling `AudioPlayer.play()` while a resource is already playing destroys the old resource and replaces it. Therefore, every call to `play()` must be serialized or explicitly treated as an interruption.

The logs show multiple GPT-SoVITS requests for one Gemini response, followed by separate playback completion events:

```text
Synthesizing chars=6
Synthesizing chars=9
Audio playback done
Synthesizing chars=16
Audio playback done
```

This creates a race if the next synthesized chunk reaches `AudioPlayer.play()` before the active resource becomes idle.

## 2.2 Excessively small TTS chunks

The logs contain GPT-SoVITS requests as small as:

```text
chars=2
chars=4
chars=6
chars=7
chars=8
```

Very short chunks increase fixed synthesis overhead, produce unnatural prosody, and amplify playback replacement races. A GPT-SoVITS issue also reports incorrect behavior for very short synthesis text, so tiny requests should be avoided even when they are technically valid.

## 2.3 Fragmented user speech

The logs contain many finalized utterances between approximately 0.4 and 0.9 seconds. These frequently become:

```text
Empty transcription
嗯。
我。
Hello.
```

Several of those fragments trigger complete Gemini requests.

## 2.4 Uncontrolled barge-in

One log shows:

```text
Barge-in detected
GptSoVitsTts Synthesizing ...
```

on consecutive lines. Playback was interrupted, but the remaining synthesis pipeline continued. This means interruption currently affects the player without reliably cancelling generation, TTS, queued chunks, or stale results.

## 2.5 Gemini request amplification

The logs show both per-minute and per-day `429 RESOURCE_EXHAUSTED` failures. Repeated fillers and short phrases continue to produce Gemini calls after quota exhaustion.

## 2.6 Current code locations inferred from stack traces

The logs identify these active components:

```text
src/orchestration/conversation-controller.ts
src/orchestration/speech-chunker.ts
src/orchestration/turn-queue.ts
src/providers/brain/gemini.ts
VoiceManager implementation
GPT-SoVITS provider
```

The coding agent must verify the exact local paths before editing. Do not perform broad architecture rediscovery unless the local checkout materially differs from these paths.

---

# 3. Required engineering skills

Assign agents with demonstrated competence in the following areas.

## TypeScript and Node.js

Required knowledge:

* TypeScript strict typing.
* Async iterators and generators.
* Node.js streams.
* `AbortController` and cancellation propagation.
* Promise lifecycle and race prevention.
* Bounded queues and backpressure.
* Fake timers and deterministic concurrency tests.

## Discord voice

Required knowledge:

* `@discordjs/voice`.
* `AudioPlayerStatus`.
* `AudioResource`.
* Voice connection subscription.
* Discord receive streams.
* Per-user speaking events.
* Opus decoding and PCM handling.
* Clean voice connection teardown.

## Audio processing

Required knowledge:

* PCM sample rate, bit depth, and channel count.
* WAV headers versus raw PCM.
* Why complete WAV files cannot be blindly concatenated.
* Audio duration calculation.
* Silence padding.
* Streaming response handling.

GPT-SoVITS supports `wav`, `raw`, `ogg`, and `aac`, and its implementation specifically warns that only the first streaming WAV chunk should contain a WAV header.

## Model-service integration

Required knowledge:

* Qwen3-ASR HTTP service behavior.
* Gemini streaming generation.
* Gemini rate limiting and cooldowns.
* GPT-SoVITS HTTP synthesis.
* GPU serialization and resource contention.

Qwen3-ASR currently supports 0.6B and 1.7B models, language identification, offline inference, and optional `torch.compile`; streaming inference currently requires its vLLM backend. Model changes are a later benchmark, not the first fix.

## Testing and performance

Required knowledge:

* Vitest or the repository’s existing TypeScript test runner.
* Python `pytest` where ASR changes are required.
* Mock HTTP providers.
* Mock Discord player state transitions.
* Latency and queue-depth telemetry.
* Reproducible audio test fixtures.

---

# 4. Non-goals

Do not:

* Create a new Discord bot.
* Rewrite Discord RTP or Opus handling.
* Mix users into one audio stream before ASR.
* Add speaker diarization.
* Add WhisperX, pyannote, or another cloud STT provider.
* Replace Qwen3-ASR before fixing orchestration.
* Reload Qwen or GPT-SoVITS per turn.
* implement full duplex as the default.
* Allow simultaneous Gemini responses in one guild.
* Add an unbounded FIFO queue of future spoken turns.
* use LLM response caching as a substitute for input filtering.
* modify unrelated AIRI services.
* reset, clean, stash, or overwrite user changes.
* commit tokens, API keys, generated audio caches, or recorded user speech.

---

# 5. Target behavioral contract

## 5.1 Default interaction policy

The default mode must be half-duplex:

```text
IDLE
  Accept speech.

COLLECTING
  Accept and merge speech for the current conversational turn.

THINKING
  Ignore newly finalized speech.

SPEAKING
  Ignore newly finalized speech.

DISCONNECTING
  Reject all work and cancel active operations.
```

New speech while the bot is thinking or speaking must not:

* invoke ASR;
* invoke Gemini;
* invoke GPT-SoVITS;
* stop the current playback;
* enter a future FIFO backlog.

Log it as an intentional drop:

```text
input_discarded reason=bot_busy phase=speaking
```

Optional barge-in can remain behind a disabled-by-default configuration flag.

## 5.2 Playback contract

For each guild:

* Exactly one persistent `AudioPlayer` owns output.
* Exactly one playback scheduler owns calls to `AudioPlayer.play()`.
* `play()` must never be called while another resource is active, except after an explicit cancellation has stopped the previous resource.
* Synthesized chunks play in sequence.
* Completion of the conversation turn includes completion of all accepted playback chunks.
* Leaving the channel cancels generation, synthesis, pending audio, and active playback.
* Results from an obsolete response epoch are discarded.

## 5.3 Turn contract

For each guild:

* At most one accepted conversation turn is being generated or spoken.
* Short pieces from the same user may be merged.
* Nearby utterances from multiple users may be grouped into one Gemini request.
* Each speaker remains a separate ASR input.
* The bot produces one group response, not one response per fragment.
* Empty, filler-only, and duplicate transcripts are filtered before Gemini.
* Conversation history is committed only after a successful assistant response.

## 5.4 Cancellation contract

A response has an immutable epoch number.

Every asynchronous operation must carry:

```ts
guildId
turnId
responseEpoch
AbortSignal
```

A stale result must not mutate history, enqueue audio, or change session state.

Cancellation must invalidate all of:

```text
Gemini stream
pending text chunks
active TTS HTTP request
completed but not-yet-played TTS results
playback queue
active Discord resource
```

---

# 6. Shared data model

The implementation should converge on an explicit guild session structure. Adjust names to match local style, but preserve the semantics.

```ts
type GuildPhase =
  | 'idle'
  | 'collecting'
  | 'thinking'
  | 'speaking'
  | 'disconnecting';

type InputPolicy =
  | 'half_duplex'
  | 'latest_wins'
  | 'barge_in';

interface GuildConversationSession {
  guildId: string;
  phase: GuildPhase;
  inputPolicy: InputPolicy;

  responseEpoch: number;
  currentTurnId?: string;

  generationAbort?: AbortController;
  ttsAbort?: AbortController;

  activeSpeakerLease?: {
    userId: string;
    expiresAt: number;
  };

  recentTranscripts: Map<string, RecentTranscript>;
  pendingConversationInput?: PendingConversationInput;

  playback: GuildPlaybackSession;
  history: ConversationMessage[];

  geminiCooldownUntil: number;
  lastCooldownPromptAt?: number;
}
```

```ts
interface VoiceUtterance {
  guildId: string;
  channelId: string;
  userId: string;
  displayName: string;

  pcm: Buffer;
  sampleRate: 16000;
  channels: 1;

  startedAt: number;
  endedAt: number;
}
```

```ts
interface TranscribedUtterance {
  utteranceId: string;
  guildId: string;
  userId: string;
  displayName: string;

  text: string;
  normalizedText: string;
  language: string;

  startedAt: number;
  endedAt: number;
}
```

```ts
interface ConversationInput {
  turnId: string;
  guildId: string;
  utterances: TranscribedUtterance[];
  createdAt: number;
}
```

```ts
interface PlaybackItem {
  id: string;
  guildId: string;
  turnId: string;
  responseEpoch: number;
  chunkIndex: number;

  audio: Buffer | NodeJS.ReadableStream;
  inputType: StreamType;
  durationMs?: number;
}
```

---

# 7. Context-management rules for all agents

The lead agent must create these files before implementation work is parallelized:

```text
docs/voice-optimization/
├── architecture-contract.md
├── repository-map.md
├── baseline-findings.md
├── decisions.md
├── test-matrix.md
└── handoffs/
```

## `architecture-contract.md`

Keep this file under roughly 2,000 words. It must contain only:

* pipeline overview;
* state machine;
* response epoch contract;
* provider interfaces;
* playback ownership;
* input policy;
* queue limits;
* audio format assumptions;
* environment settings;
* non-goals.

Every implementation subagent receives this file.

## `repository-map.md`

Record:

* current commit hash;
* current branch;
* uncommitted files;
* exact paths of relevant implementations;
* exact paths of existing tests;
* package scripts;
* logging utilities;
* configuration loader;
* current player creation and subscription paths;
* all call sites of `AudioPlayer.play()` and `AudioPlayer.stop()`;
* all call sites of Gemini generation;
* all call sites of GPT-SoVITS synthesis;
* all code that mutates conversation history.

This prevents later agents from repeating discovery.

## `baseline-findings.md`

Include:

* summarized log evidence;
* current default endpoint timeout;
* current TTS chunk sizes;
* current barge-in behavior;
* observed quota failures;
* current playback control flow;
* known reproduction procedures.

## Agent handoff format

Every subagent must write:

```text
docs/voice-optimization/handoffs/<wave>-<agent>.md
```

Each handoff must contain:

```text
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

Limit each handoff to approximately 1,200 words.

The lead agent should pass handoffs to later agents instead of full chat transcripts.

---

# 8. Branch and file-ownership strategy

Use separate branches or Git worktrees for subagents.

Suggested naming:

```text
agent/w0-repo-map
agent/w1-playback
agent/w1-input
agent/w1-gemini
agent/w2-controller
agent/w3-cache-chunker
agent/w3-multispeaker
agent/w3-telemetry
agent/w4-tests
agent/w4-performance
```

Rules:

1. No two agents edit the same source file in the same wave.
2. Shared interfaces are defined before parallel implementation begins.
3. The lead agent cherry-picks small commits in dependency order.
4. Each commit must compile or clearly declare the prerequisite commit.
5. Avoid formatting unrelated files.
6. Never use destructive Git commands.
7. Before editing, run:

```bash
git rev-parse HEAD
git status --short
git branch --show-current
```

8. Record uncommitted user files and do not alter them unless directly required.
9. Tests should be committed with the feature they verify.

---

# 9. Subagent execution waves

## Wave 0 — Discovery and contract

Run these agents in parallel, with no production code changes.

### Agent 0A — Repository Cartographer

#### Context

Provide:

```text
Repository root
airi/services/discord-bot/**
package.json files relevant to the service
pnpm-workspace.yaml
README.md
plan.md
bot_log .txt
bot_log_2 .txt
```

#### Skills

* Repository navigation.
* TypeScript architecture.
* Dependency analysis.
* Discord voice familiarity.

#### Tasks

1. Locate the exact current implementations of:

   * `VoiceManager`;
   * Discord adapter;
   * guild session state;
   * conversation controller;
   * turn queue;
   * speech chunker;
   * Gemini provider;
   * GPT-SoVITS provider;
   * Qwen HTTP client;
   * configuration loader;
   * telemetry.
2. Find every `AudioPlayer.play()` call.
3. Find every `AudioPlayer.stop()` call.
4. Trace one complete turn from speaking event to playback completion.
5. Identify where a queued task is considered complete.
6. Determine whether `voice.play()` resolves at playback start or playback end.
7. Find conversation-history mutation points.
8. Identify current test utilities.
9. Write `repository-map.md`.

#### Output

No production code.

### Agent 0B — Concurrency and Log Analyst

#### Context

Provide only:

```text
bot_log .txt
bot_log_2 .txt
conversation-controller.ts
turn-queue.ts
speech-chunker.ts
VoiceManager implementation
```

#### Skills

* Async race analysis.
* Log correlation.
* State-machine design.

#### Tasks

1. Build an event timeline for:

   * one successful multi-chunk response;
   * one self-interruption;
   * one barge-in;
   * one short-fragment sequence;
   * one quota-exhaustion sequence.
2. Identify probable race windows.
3. Determine which async functions resolve too early.
4. Specify invariants for playback and cancellation.
5. Write `baseline-findings.md`.

#### Output

No production code.

### Agent 0C — Test Harness Cartographer

#### Context

Provide:

```text
discord-bot package.json
existing test configuration
existing voice tests
existing provider tests
VoiceManager public API
ConversationController public API
```

#### Skills

* Vitest/Jest.
* Fake timers.
* Mock streams.
* Async state testing.

#### Tasks

1. Identify the current test runner.
2. Determine how to mock `@discordjs/voice`.
3. Create a test design for:

   * playback serialization;
   * cancellation;
   * half-duplex drops;
   * transcript filtering;
   * cooldown behavior;
   * multi-speaker grouping.
4. Do not implement production code.
5. Write the first version of `test-matrix.md`.

### Lead checkpoint after Wave 0

The lead agent must:

1. Read all three handoffs.
2. Create `architecture-contract.md`.
3. Resolve naming and ownership conflicts.
4. Record decisions in `decisions.md`.
5. Commit the documentation.
6. Do not begin parallel implementation until the contract is stable.

---

## Wave 1 — Independent foundational fixes

Run these agents in parallel after the architecture contract is committed.

### Agent 1A — Playback Ownership and Serialization

#### Owned files

Give this agent only:

```text
VoiceManager implementation
guild voice-session implementation
voice-related types
voice playback tests
architecture-contract.md
repository-map.md
```

Do not give Gemini or ASR internals.

#### Responsibilities

Implement a single playback scheduler per guild.

Recommended public API:

```ts
interface VoicePlaybackController {
  enqueue(item: PlaybackItem): Promise<PlaybackResult>;
  cancelEpoch(epoch: number): void;
  stopAll(reason: PlaybackStopReason): Promise<void>;
  awaitDrained(epoch: number): Promise<void>;
  getSnapshot(): PlaybackSnapshot;
}
```

An acceptable simpler API is:

```ts
playAudio(item: PlaybackItem): Promise<void>
```

provided that:

* it resolves only after the resource reaches `Idle` or fails;
* concurrent calls are internally serialized;
* stale epochs are rejected;
* no caller can directly call `AudioPlayer.play()`.

#### Implementation requirements

1. Create one persistent `AudioPlayer` per guild voice session.
2. Centralize all `play()` calls in one method.
3. Maintain:

   * current item;
   * bounded pending queue;
   * active epoch;
   * queue-drain promise.
4. Start the next item only after the current resource reaches `Idle`.
5. Subscribe to player errors once at the session level.
6. Ensure an `Idle` event from an old resource cannot resolve the wrong queue item.
7. Destroy or release each completed resource.
8. On disconnect:

   * reject pending playback promises;
   * stop the current resource;
   * clear listeners;
   * clear the queue.
9. Add an invariant log if a replacement attempt occurs:

```text
playback_invariant_violation activeItem=... attemptedItem=...
```

10. Do not implement barge-in policy in this agent. Expose cancellation primitives only.

#### Required tests

* Three chunks enqueue concurrently and play exactly in order.
* `play()` is never invoked twice without an intervening `Idle` or explicit stop.
* The returned promise resolves after playback, not after playback start.
* Player error rejects the current item and permits policy-defined continuation.
* Cancelling an epoch removes pending items from that epoch.
* A stale epoch item never calls `play()`.
* Disconnect empties and rejects the queue.
* Event listeners do not grow after repeated playback.

#### Commit boundary

One focused commit containing playback implementation and tests.

---

### Agent 1B — Input Gate, Endpointing, and Transcript Filter

#### Owned files

Provide:

```text
VoiceManager receive/capture code
utterance types
new transcript-filter module
new input-policy module
relevant tests
architecture-contract.md
baseline-findings.md
```

Do not provide or edit Gemini and playback implementation files.

#### Responsibilities

Reduce short-fragment churn before it reaches Gemini.

#### Step 1: busy gate

Add a callback or policy interface that can reject input before ASR:

```ts
type UtteranceAdmissionDecision =
  | { accept: true }
  | {
      accept: false;
      reason:
        | 'bot_thinking'
        | 'bot_speaking'
        | 'disconnecting'
        | 'speaker_not_selected';
    };
```

The orchestration layer should expose the guild phase without creating a circular dependency.

When half-duplex is active:

```text
thinking → discard
speaking → discard
```

Prefer dropping finalized PCM before calling ASR.

#### Step 2: endpointing adjustments

Use these starting defaults:

```env
VOICE_END_SILENCE_MS=900
VOICE_MIN_UTTERANCE_MS=300
VOICE_MAX_UTTERANCE_MS=30000
VOICE_PRE_ROLL_MS=200
VOICE_POST_ROLL_MS=150
```

If the existing per-user capture session already cancels finalization when the same user resumes speaking, preserve that behavior and extend the silence interval.

Do not introduce a single global timer. Timers must remain per guild and per user.

#### Step 3: transcript normalization

Create a pure function:

```ts
normalizeTranscript(text: string, language?: string): string
```

It should:

* trim whitespace;
* normalize Unicode where appropriate;
* collapse repeated whitespace;
* normalize punctuation spacing;
* preserve semantic casing;
* avoid aggressive translation or rewriting.

#### Step 4: filler filtering

Create:

```ts
interface TranscriptFilterContext {
  language?: string;
  awaitingConfirmation: boolean;
  recentTranscript?: RecentTranscript;
  now: number;
}

interface TranscriptFilterResult {
  accept: boolean;
  normalizedText: string;
  reason?:
    | 'empty'
    | 'too_short'
    | 'filler'
    | 'duplicate';
}
```

Initial standalone filler sets:

```text
English: uh, um, hmm, mhm
Chinese: 嗯, 呃, 啊
Japanese: えー, えっと, うん
```

Punctuation-only forms should match the same entries.

Do not drop:

```text
yes
no
嗯
うん
```

when `awaitingConfirmation=true`.

#### Step 5: duplicate suppression

Reject an identical normalized transcript from the same user within:

```env
VOICE_DUPLICATE_WINDOW_MS=3000
```

Do not compare across users.

#### Required tests

* Speech while the bot is speaking is rejected before ASR.
* Speech while idle is accepted.
* Per-user finalization timers do not affect other users.
* Same-user speech resumed within the endpoint window is merged.
* Standalone `嗯。` is rejected in ordinary context.
* `嗯。` is accepted when a confirmation is expected.
* Repeated `Hello.` within three seconds is rejected.
* Different users saying the same text are not deduplicated.
* Empty ASR output never enters the turn queue.

---

### Agent 1C — Gemini Rate Limiter and Cooldown

#### Owned files

Provide:

```text
Gemini provider
brain provider types
new rate-limiter module
Gemini provider tests
architecture-contract.md
bot log excerpts containing 429 responses
```

Do not edit the conversation controller in this wave.

#### Responsibilities

Make Gemini failures explicit and machine-readable.

#### Add typed errors

```ts
class BrainRateLimitError extends Error {
  retryAfterMs: number;
  quotaMetric?: string;
  quotaId?: string;
  model?: string;
}
```

```ts
class BrainRequestAbortedError extends Error {}
```

Parse Gemini SDK errors and extract:

* status code;
* retry delay;
* quota metric;
* quota ID;
* model.

Use structured fields where available. Fall back to conservative parsing only when necessary.

#### Add local request limiter

Create a global limiter scoped by API key/model process:

```ts
interface BrainRateLimiter {
  acquire(signal: AbortSignal): Promise<void>;
  blockUntil(timestamp: number): void;
  snapshot(): RateLimiterSnapshot;
}
```

Starting configuration:

```env
GEMINI_REQUESTS_PER_MINUTE=4
GEMINI_MAX_CONCURRENT_REQUESTS=1
GEMINI_DEFAULT_COOLDOWN_MS=60000
```

The configured limit must remain below the external account limit.

#### Provider behavior

1. Check the local limiter before beginning generation.
2. Pass `AbortSignal` to the SDK when supported.
3. Convert 429 responses to `BrainRateLimitError`.
4. Immediately block future acquisitions until the retry time.
5. Do not retry automatically inside the provider.
6. Do not retry an obsolete voice turn.
7. Preserve the streaming response interface.

Gemini supports streaming generation through its current JavaScript SDK, but the repository may still use `generateContentStream`; preserve the existing SDK surface unless a separate migration is approved.

#### Required tests

* Local RPM limit delays or rejects excess requests deterministically.
* A 429 creates `BrainRateLimitError`.
* Retry delay is parsed correctly.
* Cooldown blocks subsequent provider calls.
* Abort does not become a generic provider failure.
* No internal retry occurs after cancellation.

---

# 10. Wave 2 — Controller integration

Run one primary integration agent. Do not parallelize controller edits.

### Agent 2A — Conversation State Machine and Cancellation

#### Context

Provide:

```text
architecture-contract.md
repository-map.md
handoffs from Agents 1A, 1B, and 1C
conversation-controller.ts
guild-session.ts
turn-queue.ts
provider interfaces
conversation history implementation
```

Do not provide entire implementation transcripts from the previous agents.

#### Responsibilities

Make the conversation controller the sole owner of conversational policy.

## Step 1: explicit phase transitions

Add one function for state changes:

```ts
transitionGuildPhase(
  session: GuildConversationSession,
  next: GuildPhase,
  reason: string,
): void
```

Valid transitions:

```text
idle → collecting
collecting → thinking
thinking → speaking
speaking → idle

collecting → idle
thinking → idle
speaking → idle

any active state → disconnecting
disconnecting → idle only after a new voice session is created
```

Unexpected transitions should be logged and rejected in tests.

## Step 2: response epoch

At the start of every accepted response:

```ts
const epoch = ++session.responseEpoch;
```

Pass `epoch` through:

```text
Gemini generation
speech chunker
TTS synthesis
playback enqueue
history commit
telemetry
```

Before using any async result:

```ts
if (epoch !== session.responseEpoch)
  return;
```

## Step 3: cancellation method

Implement:

```ts
async cancelActiveResponse(
  session: GuildConversationSession,
  reason: CancellationReason,
): Promise<void>
```

It must:

1. Increment `responseEpoch`.
2. Abort Gemini.
3. Abort active TTS.
4. Discard pending text chunks.
5. Cancel pending playback items.
6. Stop active playback when policy requires it.
7. Clear the current turn ID.
8. Return the guild to a valid phase.
9. Log one summarized cancellation event.

## Step 4: half-duplex admission

Before ASR:

```ts
if (
  session.inputPolicy === 'half_duplex'
  && (session.phase === 'thinking' || session.phase === 'speaking')
) {
  discardUtterance('bot_busy');
  return;
}
```

The dropped utterance must not be placed in a backlog.

## Step 5: task completion semantics

The guild turn task must not resolve when Gemini finishes or when the last TTS request starts.

It resolves only when:

```text
all generated text consumed
AND all accepted TTS requests settled
AND all accepted playback items completed
```

This is essential because the next queued turn must not start while the previous response is speaking.

## Step 6: queue policy

For default half-duplex mode:

```text
maximum waiting conversation turns = 0
```

For optional `latest_wins`:

```text
maximum waiting conversation turns = 1
replace the waiting turn with the newest completed turn
```

Do not use an unbounded FIFO.

## Step 7: history commit

Use transactional history behavior:

1. Build a provisional user turn.
2. Generate the assistant response.
3. Only after successful generation, commit:

   * accepted user input;
   * final assistant text.
4. If generation is aborted or rate-limited:

   * do not commit a fake assistant response;
   * do not leave an unmatched user message in normal conversation history.
5. Diagnostic history may be recorded separately.

## Step 8: quota behavior

When `BrainRateLimitError` occurs:

1. Set `session.geminiCooldownUntil`.
2. Clear the current generation safely.
3. Play one cached unavailable prompt if:

   * no prompt was played recently;
   * playback is available;
   * the current epoch is still valid.
4. Do not make another Gemini request until cooldown expires.
5. Subsequent speech during cooldown should be discarded or receive one non-repeated local response.

Suggested debounce:

```env
GEMINI_COOLDOWN_PROMPT_INTERVAL_MS=60000
```

## Required tests

* A turn remains active until its last audio chunk finishes.
* A new utterance during thinking is dropped.
* A new utterance during speaking is dropped.
* Dropped utterances never call ASR or Gemini.
* A cancelled Gemini stream cannot enqueue TTS.
* A completed stale TTS call cannot enqueue playback.
* An old playback event cannot transition a new turn to idle.
* A 429 starts cooldown and produces at most one local prompt.
* Conversation history remains paired after failure.
* Disconnect cancels the complete pipeline.
* Two guilds can process independently.

---

# 11. Wave 3 — Quality and efficiency features

After the integrated controller is stable, run the following agents in parallel with non-overlapping file ownership.

## Agent 3A — Speech Chunker and Bounded TTS Pipeline

#### Owned files

```text
speech-chunker.ts
speech-chunker tests
new bounded async queue if needed
TTS orchestration helper, excluding provider internals
```

#### Responsibilities

Reduce tiny synthesis calls without destroying first-audio latency.

## Chunking rules

Maintain a text buffer from the Gemini stream.

Suggested defaults:

```env
TTS_CHUNK_MIN_LATIN_CHARS=40
TTS_CHUNK_TARGET_LATIN_CHARS=75
TTS_CHUNK_MAX_LATIN_CHARS=120

TTS_CHUNK_MIN_CJK_CHARS=14
TTS_CHUNK_TARGET_CJK_CHARS=28
TTS_CHUNK_MAX_CJK_CHARS=50

TTS_CHUNK_MAX_WAIT_MS=900
TTS_PREFETCH_CHUNKS=1
```

Emit a chunk when:

```text
terminal punctuation is present
AND language-specific minimum is reached
```

or:

```text
maximum size is reached
```

or:

```text
the model stream is finished
```

or, with care:

```text
maximum wait time is reached
AND the buffered text is large enough to synthesize safely
```

Do not emit tiny opening acknowledgements such as:

```text
Sure.
Okay.
そうね。
嗯。
```

when more response text is expected. Attach them to the next clause.

## Language handling

Detect the dominant script in the buffered response:

* kana strongly indicates Japanese;
* Latin-dominant text indicates English;
* Han without kana generally indicates Chinese;
* use the ASR language only as a fallback hint.

Do not alter `prompt_lang`; it identifies the reference audio language.

## Bounded pipeline

Implement one-chunk lookahead:

```text
chunk N playing
chunk N+1 may synthesize
chunk N+2 must wait
```

This limits wasted GPU work after cancellation.

A possible structure:

```ts
for await (const chunk of chunkStream(modelOutput)) {
  assertCurrentEpoch();

  const audio = await ttsPipeline.synthesizeWithLookahead(
    chunk,
    epoch,
    signal,
  );

  assertCurrentEpoch();
  await playback.enqueue(audio);
}
```

A more efficient implementation may synthesize N+1 while N plays, but keep total outstanding synthesized-unplayed chunks at one.

## Required tests

* English output does not emit two-character chunks.
* CJK punctuation does not emit tiny standalone acknowledgements.
* Final short text is flushed.
* Abbreviations and decimal points do not split incorrectly.
* Cancellation stops future chunks.
* Outstanding TTS lookahead never exceeds one.
* Chunk order remains deterministic.

---

## Agent 3B — TTS Cache

#### Owned files

```text
new providers/tts/tts-cache.ts
GPT-SoVITS provider integration
cache tests
configuration schema
```

Do not edit the speech chunker.

#### Cache scope

Implement a two-tier cache:

```text
memory LRU
    ↓ miss
disk cache
    ↓ miss
GPT-SoVITS
```

## Cache key

Use a stable hash of:

```ts
{
  normalizedText,
  textLanguage,
  voiceModelVersion,
  referenceAudioFingerprint,
  promptTextFingerprint,
  promptLanguage,
  speedFactor,
  mediaType,
  streamingMode,
  textSplitMethod,
  relevantSynthesisParameters,
}
```

Do not use only the text.

## Disk format

Store:

```text
<cache-root>/<first-two-hash-chars>/<full-hash>.audio
<cache-root>/<first-two-hash-chars>/<full-hash>.json
```

Metadata should include:

```ts
interface TtsCacheMetadata {
  keyVersion: number;
  createdAt: string;
  lastAccessedAt?: string;
  sizeBytes: number;
  mediaType: string;
  sampleRate?: number;
  durationMs?: number;
}
```

Use atomic writes:

```text
write temporary file
fsync or close
rename to final path
```

Do not expose partially written files.

## Suggested defaults

```env
TTS_CACHE_ENABLED=true
TTS_CACHE_DIR=.cache/tts
TTS_CACHE_MAX_MB=512
TTS_CACHE_MAX_ITEMS=1000
TTS_CACHE_TTL_HOURS=168
TTS_CACHE_MEMORY_ITEMS=32
```

Add the cache directory to `.gitignore`.

## Pre-generated prompts

Provide a way to prewarm:

```text
I didn't catch that.
One person at a time, please.
I'm temporarily unable to answer.
```

Use localized variants where the product requires them.

## Cancellation behavior

A caller cancellation should stop waiting for synthesis, but a successfully completed shared synthesis may be cached if:

* it was not itself aborted;
* the audio passed validation;
* caching does not delay shutdown.

Avoid complex promise deduplication in the first implementation unless duplicate simultaneous requests are common.

## Cache exclusions

Do not cache:

* failed or incomplete HTTP responses;
* empty audio;
* audio below minimum duration;
* responses with unknown configuration identity.

## Required tests

* Memory hit avoids provider request.
* Disk hit avoids provider request.
* Configuration change invalidates the key.
* Reference-audio change invalidates the key.
* Partial files are not read.
* Concurrent identical misses do not corrupt the cache.
* Eviction respects size and item limits.
* Cache failures fall back to synthesis.
* No cache files are tracked by Git.

Gemini already provides implicit context caching for sufficiently large repeated prompt prefixes, but that does not replace request filtering and does not eliminate RPM or RPD calls. Do not build an LLM response cache as part of this change.

---

## Agent 3C — Multi-Speaker Conversation Floor

#### Owned files

```text
new conversation-floor.ts
new group-turn-builder.ts
multi-speaker tests
session types related only to speaker arbitration
```

Avoid editing the main controller directly. Expose a small integration API.

#### Goal

Handle nearby utterances from multiple Discord users without:

* mixing PCM;
* generating simultaneous responses;
* sending one Gemini request per fragment;
* creating a large queue.

## Conversation-floor API

```ts
interface ConversationFloor {
  add(utterance: TranscribedUtterance): FloorDecision;
  flush(now: number): ConversationInput | undefined;
  clear(): void;
}
```

Suggested decisions:

```ts
type FloorDecision =
  | { kind: 'accepted'; flushAt: number }
  | { kind: 'ignored'; reason: string }
  | { kind: 'request_one_at_a_time'; speakers: string[] };
```

## Collection behavior

Starting defaults:

```env
VOICE_GROUP_WINDOW_MS=800
VOICE_ACTIVE_SPEAKER_LEASE_MS=5000
VOICE_MAX_GROUP_SPEAKERS=2
VOICE_MAX_GROUP_UTTERANCES=4
```

Algorithm:

1. The first accepted meaningful transcript opens an 800 ms collection window.
2. Additional accepted transcripts during that window are grouped.
3. Preserve each speaker’s identity and timing.
4. Do not concatenate raw audio.
5. Build one Gemini input after the window closes.
6. If speech overlaps heavily or exceeds the speaker limit:

   * do not attempt to infer an ordered conversation;
   * return a cached “one person at a time” response.
7. If the same speaker produces nearby fragments:

   * merge adjacent text where timing indicates a continuation.
8. Prefer the current active speaker during the lease interval.
9. Do not hold the floor while the bot is thinking or speaking.

## Gemini input format

Use a structured text input similar to:

```text
Recent Discord voice messages:

[Patrick, 10:02:14.120]
Can you explain that?

[Alice, 10:02:14.430]
Specifically the cache part.

Reply once to the group. Use speaker names only when useful.
```

Escape or delimit display names so they cannot be confused with system instructions.

## Required tests

* Two speakers within the group window create one `ConversationInput`.
* One user’s adjacent fragments merge.
* PCM remains separate.
* Three or more overlapping speakers produce the local one-at-a-time action.
* A speaker lease prevents background fragments from stealing the turn.
* Group windows are independent per guild.
* A group flush cannot occur after the response epoch is cancelled.

---

## Agent 3D — Telemetry

#### Owned files

```text
telemetry module
logging helpers
telemetry tests
documentation
```

Avoid controller behavior changes.

#### Required events

Emit structured events for:

```text
guild_phase_changed
utterance_received
utterance_merged
utterance_discarded
transcript_filtered
conversation_group_opened
conversation_group_flushed
response_epoch_started
response_cancelled
gemini_request_started
gemini_rate_limited
gemini_cooldown_active
tts_cache_hit
tts_cache_miss
tts_synthesis_started
tts_synthesis_completed
playback_enqueued
playback_started
playback_completed
playback_cancelled
playback_invariant_violation
```

## Required fields

Where relevant:

```text
guildId
turnId
responseEpoch
userId
phase
reason
chunkIndex
chars
language
queueDepth
cacheTier
durationMs
cooldownMs
```

Do not log:

* API keys;
* authorization headers;
* entire model prompts by default;
* complete user audio;
* cache file contents;
* sensitive environment variables.

## Derived metrics

Support calculation of:

```text
utterance end → ASR complete
utterance end → Gemini first token
utterance end → first audible audio
TTS real-time factor
playback queue wait
total response playback duration
discard rate by reason
filler-filter rate
duplicate-filter rate
TTS cache hit rate
Gemini 429 count
cancelled stale-result count
```

---

# 12. Wave 4 — Verification and performance

Run QA agents after all Wave 3 features are integrated.

## Agent 4A — Deterministic Unit and Integration QA

#### Context

Provide:

```text
architecture-contract.md
all public interfaces
all agent handoffs
test-matrix.md
changed source files
```

#### Responsibilities

Expand tests without changing architecture unless a defect requires a minimal fix.

## Mandatory regression tests

### Playback

* A three-chunk response plays all three chunks.
* No chunk replaces another.
* `AudioPlayer.play()` call count equals completed accepted resources.
* Every `play()` after the first follows `Idle` or explicit cancellation.
* Playback task resolves after the final resource.

### Busy input

* User speech during thinking is ignored.
* User speech during speaking is ignored.
* Ignored speech does not call ASR.
* Ignored speech does not create a queued future response.

### Cancellation

* Leave during Gemini generation aborts Gemini.
* Leave during TTS aborts TTS.
* Leave during playback stops audio and clears the queue.
* Old TTS completion after leave is discarded.
* Old player events do not modify a new session.

### Short phrases

* Multiple short same-user fragments become one ASR request where capture-level merging applies.
* Filler-only transcripts do not call Gemini.
* Duplicate transcripts do not call Gemini twice.

### Multiple speakers

* Two useful utterances produce one Gemini request.
* Audio is not mixed.
* Excessive overlap uses the local one-at-a-time prompt.

### Quota

* A 429 activates cooldown.
* Cooldown suppresses further Gemini calls.
* The unavailable prompt is not repeated for every utterance.

### Cache

* Repeated standard prompts are cache hits.
* Cache key changes when voice configuration changes.
* Cache corruption falls back safely.

## Fault injection

Simulate:

* ASR timeout;
* Gemini abort;
* Gemini 429;
* GPT-SoVITS connection refusal;
* GPT-SoVITS timeout;
* invalid audio response;
* player error;
* voice connection destroyed;
* stream premature close.

Each failure must leave the guild in a recoverable state.

---

## Agent 4B — Performance and Audio Benchmarking

#### Context

Provide:

```text
benchmark scripts
representative audio dumps approved for local testing
telemetry schema
provider configuration
current hardware information
```

Do not give unrelated application code.

## Baseline measurements

Capture:

```text
ASR model and dtype
GPU model
idle VRAM
ASR-loaded VRAM
TTS-loaded VRAM
combined idle VRAM
ASR peak VRAM
TTS peak VRAM
average ASR latency
Gemini first-token latency
TTS first-audio latency
user-stop-to-first-audio latency
```

## TTS experiment matrix

Benchmark:

```text
streaming mode: 0, 2, 3
Latin targets: 40, 75, 100 characters
CJK targets: 14, 28, 45 characters
prefetch: 0, 1
cache: cold, warm
```

For each combination record:

* first-audio latency;
* total synthesis latency;
* playback gaps;
* real-time factor;
* cancellation waste;
* subjective pronunciation and prosody.

Do not enable a faster streaming mode solely because latency improves. Verify audio quality.

## ASR experiment matrix

Only after orchestration fixes pass:

```text
Qwen3-ASR-0.6B
Qwen3-ASR-0.6B with torch.compile
Qwen3-ASR-1.7B
Qwen3-ASR-1.7B with torch.compile
```

Test:

* short English phrases;
* short Chinese phrases;
* short Japanese phrases;
* multilingual switching;
* moderate background noise;
* separate simultaneous Discord speakers;
* strings of short phrases.

Do not implement Qwen streaming unless offline endpointing remains the primary bottleneck after these changes.

---

## Agent 4C — Adversarial Concurrency Review

#### Context

Provide only:

```text
guild session
conversation controller
turn queue
playback controller
conversation floor
cancellation code
tests
architecture contract
```

#### Responsibilities

Attempt to find:

* stale epoch mutations;
* double state transitions;
* unresolved promises;
* listener leaks;
* queue deadlocks;
* active playback replacement;
* history corruption;
* disconnect races;
* cross-guild state contamination;
* cache races;
* limiter starvation.

Produce a written review before changing code.

Any fixes must be isolated commits with a regression test.

---

# 13. Wave 5 — Lead integration and rollout

The lead agent owns final integration.

## Step 1: merge order

Recommended order:

```text
Wave 0 documentation
Agent 1A playback
Agent 1B input/filter
Agent 1C Gemini limiter
Agent 2A controller
Agent 3A chunker
Agent 3B TTS cache
Agent 3C conversation floor
Agent 3D telemetry
Wave 4 fixes
```

## Step 2: resolve interface drift

The lead must ensure there is one authoritative definition for:

* `GuildConversationSession`;
* `VoiceUtterance`;
* `ConversationInput`;
* `PlaybackItem`;
* cancellation reasons;
* phase transitions;
* provider errors.

Remove duplicated types created in temporary branches.

## Step 3: configuration

Add documented settings to `.env.example` or `.config.example`.

Recommended initial defaults:

```env
# Conversation policy
BOT_INPUT_POLICY=half_duplex
BARGE_IN_ENABLED=false

# Endpointing
VOICE_END_SILENCE_MS=900
VOICE_MIN_UTTERANCE_MS=300
VOICE_MAX_UTTERANCE_MS=30000
VOICE_PRE_ROLL_MS=200
VOICE_POST_ROLL_MS=150
VOICE_DUPLICATE_WINDOW_MS=3000

# Multiple speakers
VOICE_GROUP_WINDOW_MS=800
VOICE_ACTIVE_SPEAKER_LEASE_MS=5000
VOICE_MAX_GROUP_SPEAKERS=2
VOICE_MAX_GROUP_UTTERANCES=4

# Speech chunking
TTS_CHUNK_MIN_LATIN_CHARS=40
TTS_CHUNK_TARGET_LATIN_CHARS=75
TTS_CHUNK_MAX_LATIN_CHARS=120
TTS_CHUNK_MIN_CJK_CHARS=14
TTS_CHUNK_TARGET_CJK_CHARS=28
TTS_CHUNK_MAX_CJK_CHARS=50
TTS_CHUNK_MAX_WAIT_MS=900
TTS_PREFETCH_CHUNKS=1

# TTS cache
TTS_CACHE_ENABLED=true
TTS_CACHE_DIR=.cache/tts
TTS_CACHE_MAX_MB=512
TTS_CACHE_MAX_ITEMS=1000
TTS_CACHE_TTL_HOURS=168
TTS_CACHE_MEMORY_ITEMS=32

# Gemini protection
GEMINI_REQUESTS_PER_MINUTE=4
GEMINI_MAX_CONCURRENT_REQUESTS=1
GEMINI_DEFAULT_COOLDOWN_MS=60000
GEMINI_COOLDOWN_PROMPT_INTERVAL_MS=60000
```

Validate all numeric values:

* reject negative values;
* reject zero where invalid;
* enforce safe upper bounds;
* log effective configuration without secrets.

## Step 4: documentation

Update:

```text
README.md
RUNBOOK.md
.env.example or .config example
docs/voice-optimization/architecture-contract.md
docs/voice-optimization/test-matrix.md
```

Explain:

* default half-duplex behavior;
* how to enable optional barge-in;
* how the TTS cache is stored and cleared;
* how Gemini cooldown works;
* how to interpret new telemetry;
* how to run performance benchmarks.

## Step 5: validation commands

Run from the repository’s expected directories:

```powershell
Set-Location airi
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test
```

Where ASR code changed:

```powershell
Set-Location ..\qwen3-asr
.\.venv\Scripts\python.exe -m pytest
```

Also run the project’s normal lint or formatting commands if present in `package.json`.

Do not invent commands without checking existing scripts.

---

# 14. Manual acceptance procedure

Use a test Discord server and record structured telemetry.

## Scenario A — complete multi-sentence response

1. Join a voice channel.
2. Run `/summon`.
3. Ask a question expected to produce three or more sentences.
4. Do not speak during the response.

Pass conditions:

* no sentence is cut off;
* chunks play in order;
* there is no overlap;
* no `playback_invariant_violation`;
* the guild returns to `idle` only after the last audio finishes.

## Scenario B — speak while the bot is thinking

1. Ask a question.
2. Speak again before the first audio starts.

Pass conditions:

* the second utterance is logged as discarded;
* no second ASR request occurs;
* no second Gemini request occurs;
* the first answer completes normally.

## Scenario C — speak while the bot is speaking

1. Ask a question.
2. Speak during playback.

Pass conditions under default settings:

* playback continues;
* the new utterance is ignored;
* no backlog response occurs after playback.

## Scenario D — short phrases

Say with natural pauses:

```text
Can you...
tell me...
what time...
the meeting is?
```

Pass conditions:

* the phrase sequence produces one useful conversation turn;
* filler fragments do not produce separate Gemini requests;
* the final transcript remains understandable.

## Scenario E — multiple speakers

Have two people speak related phrases within one second.

Pass conditions:

* each speaker is transcribed separately;
* one Gemini request is made;
* one response is spoken.

Then have three people speak over one another.

Pass conditions:

* the bot uses the cached one-at-a-time prompt;
* it does not generate multiple responses.

## Scenario F — quota failure

Use a mock or controlled test configuration that returns a 429.

Pass conditions:

* cooldown activates;
* one local unavailable prompt may play;
* subsequent speech does not repeatedly call Gemini;
* the bot recovers after cooldown.

## Scenario G — disconnect races

Run `/leave` during:

* Gemini generation;
* TTS synthesis;
* playback.

Pass conditions:

* all operations settle;
* no stale audio plays after leaving;
* no unhandled promise rejection;
* expected stream closures are not logged as fatal failures;
* the bot can `/summon` again and operate normally.

---

# 15. Automated acceptance gates

The change is not complete unless all of these are true.

## Correctness

* No direct `AudioPlayer.play()` call exists outside the playback owner.
* No direct policy-level `AudioPlayer.stop()` call exists outside cancellation or teardown.
* Playback promises resolve on completion.
* Guild phase transitions are explicit and tested.
* Every generated response has an epoch.
* Every stale asynchronous result is rejected.
* Half-duplex is the default.
* No unbounded turn queue exists.
* Conversation history remains paired.

## Performance

* Short filler fragments cause zero Gemini requests.
* Duplicate transcripts inside the configured window cause zero additional Gemini requests.
* TTS chunks meet language-specific minimums except for final complete responses.
* TTS lookahead is bounded to one.
* Warm cache hits avoid GPT-SoVITS.
* One guild does not block another except where a deliberately global GPU semaphore is required.

## Reliability

* Disconnect cleans all timers, streams, listeners, queues, and abort controllers.
* Provider failures return the guild to a usable state.
* Expected shutdown stream closures are downgraded from fatal errors where appropriate.
* Repeated playback does not increase listener counts.
* No cache corruption can prevent fallback synthesis.

## Quality

* English, Chinese, and Japanese speech remain supported.
* `prompt_lang` remains tied to the reference voice.
* `text_lang` remains tied to synthesized content.
* Multi-speaker text includes speaker identity safely.
* The bot does not answer standalone fillers in ordinary context.

---

# 16. Rollout sequence

Use feature flags so defects can be isolated.

## Rollout stage 1

Enable:

```text
serialized playback
response epochs
half-duplex
busy input drops
```

Keep:

```text
TTS cache disabled
multi-speaker grouping disabled
barge-in disabled
```

Run manual tests and collect logs.

## Rollout stage 2

Enable:

```text
transcript filtering
duplicate suppression
larger speech chunks
Gemini cooldown
```

Compare:

* Gemini calls per minute;
* filler drop rate;
* first-audio latency;
* cut-off incidents.

## Rollout stage 3

Enable:

```text
TTS cache
one-chunk lookahead
multi-speaker floor
```

Monitor:

* cache hit rate;
* GPT-SoVITS calls per conversation;
* overlap fallback frequency;
* playback gap duration.

## Rollout stage 4

Benchmark, but do not automatically enable:

```text
GPT-SoVITS streaming modes
Qwen 1.7B
torch.compile
optional barge-in
```

Promote only after measurable improvement without quality regressions.

---

# 17. Optional barge-in follow-up

Do not include this in the first production milestone.

When implemented, barge-in should require:

* `BARGE_IN_ENABLED=true`;
* sustained human speech;
* a minimum duration such as 300–500 ms;
* a VAD or robust energy window;
* exclusion of isolated keyboard clicks;
* complete response cancellation.

Suggested flow:

```text
possible human speech
    → verify sustained speech
    → increment response epoch
    → abort TTS
    → clear playback queue
    → stop active player
    → continue human capture
    → finalize utterance
    → optionally abort Gemini
    → create new turn
```

Do not stop useful Gemini work on the first loud PCM frame. Confirm speech first.

---

# 18. Expected final deliverables

The coding effort should produce:

```text
1. Serialized per-guild playback controller
2. Explicit guild conversation state machine
3. Response-epoch cancellation
4. Default half-duplex input policy
5. Improved per-user endpointing
6. Transcript normalization, filler filtering, and deduplication
7. Gemini rate limiter and cooldown
8. Language-aware speech chunker
9. Bounded one-chunk TTS lookahead
10. Versioned memory and disk TTS cache
11. Multi-speaker conversation-floor component
12. Structured telemetry
13. Deterministic regression tests
14. Performance benchmark scripts
15. Updated README, runbook, and configuration examples
16. Subagent handoff documents
```

---

# 19. Final instruction to the lead coding agent

Execute this work as a coordinated repository change, not as a collection of independent speculative patches.

Before modifying source:

```text
- inspect the actual working tree;
- preserve all user changes;
- write the repository map;
- establish the shared architecture contract;
- establish file ownership;
- reproduce the failures with tests;
- then begin implementation.
```

Prioritize in this order:

```text
1. Playback cannot replace active audio.
2. A turn does not complete until playback completes.
3. New speech is ignored while busy.
4. Stale work cannot play.
5. Short and filler speech does not reach Gemini.
6. Quota failures produce cooldown.
7. Chunking and caching reduce TTS work.
8. Multiple speakers produce one controlled response.
9. Model/runtime benchmarks happen last.
```

The primary success metric is not raw model accuracy. It is a stable conversational pipeline in which each accepted turn has one owner, one lifecycle, bounded work, deterministic cancellation, and complete ordered playback.
