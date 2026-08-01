# DC_BOT Runtime V2 — Master Implementation Plan

## Purpose

Evolve the existing `st but tightly assembled Discord voice pipeline into a maintainable **character runtime** that supports:

* Character Card V3 / AIRI-style character definitions.
* Persistent conversational context.
* Room-scoped conversation state.
* Discord voice conversations.
* Discord `@bot` text conversations.
* Lower perceived voice-response latency.
* Context-aware Qwen3-ASR.
* GPT-SoVITS streaming and proper voice conditioning.
* Replaceable model providers.
* Memory as a separate subsystem from ordinary context.
* Semantic character actions/emotions.
* Future Discord-native Live2D through a Discord Activity.
* Good observability, testing, cancellation, and failure recovery.
* A structure that can later reconnect to more of AIRI without putting AIRI's full server stack into the voice hot path.

This document is the implementation authority for Runtime V2.

Existing `plan.md` and `Live2D_Plan.md` are supporting documents. Reuse their useful implementation research, but resolve conflicts in favor of this document and the actual checked-out repository state.

---

# 1. Agent operating instructions

## 1.1 Do not begin by rediscovering the whole project

The current project has already been researched.

Known state:

* The functional voice path is:

```text
Discord voice
    ↓
Qwen3-ASR
    ↓
Gemini
    ↓
GPT-SoVITS / Kurisu
    ↓
Discord voice
```

* The running Discord implementation is under:

```text
airi/services/discord-bot
```

* Existing commands include:

```text
/summon
/leave
/ping
/voice-test
```

* Existing orchestration code visible in runtime traces includes at least:

```text
src/providers/brain/gemini.ts
src/orchestration/speech-chunker.ts
src/orchestration/conversation-controller.ts
src/orchestration/turn-queue.ts
```

* Existing AIRI Discord voice plumbing already handles Discord voice connections, Opus decoding, per-user input, reconnect behavior, playback, and barge-in-related behavior. Preserve this rather than rewriting Discord's voice protocol. ASR and GPT-SoVITS intentionally run in separate Python environments because their dependency versions conflict. Preserve the process boundary. t already supports configurable GPT-SoVITS streaming modes, but current logged successful synthesis used `streamingMode=0`. t conversation history is described as per-server/guild. Runtime V2 must replace this conceptual scope with room-scoped context. nown performance baseline

A successful Japanese turn in the checked-in log recorded approximately:

```text
endpoint delay             656 ms
ASR                        872 ms
Gemini first token        3429 ms
first audible TTS         8813 ms
Gemini complete          15205 ms
```

The important baseline is:

```text
user stops speaking → first bot audio ≈ 8.8 s
```

The same TTS run repeatedly logs:

```text
Warning: Prompt free is not supported batch_infer! switch to naive_infer
```

GPT-SoVITS is therefore currently entering a fallback path because the reference prompt transcription is absent. aste the first optimization wave shaving milliseconds from localhost HTTP.

Prioritize:

1. correct GPT-SoVITS conditioning;
2. streaming TTS;
3. TTS/playback pipelining;
4. LLM first-token latency;
5. endpointing/ASR refinement afterward.

## 1.3 Known character-card state

The current Kurisu card is:

```text
Makise Kurisu/card.json
```

It is already Character Card V3 and contains:

```text
description
personality
scenario
system_prompt
post_history_instructions
extensions.airi
speech voice_id = kurisu
displayModelId
```

The card also currently stores the ACT/emotion protocol inside `creator_notes`. r Card V3 explicitly provides `extensions` for application-specific data, supports `character_book`, and includes asset support including Live2D assets. Runtime-specific ACT/TTS/ASR/avatar configuration should therefore live under an application extension rather than being treated as creator notes. nown upstream capabilities

Do not spend agent time rechecking the following unless implementation behavior contradicts them.

### GPT-SoVITS

Current `api_v2.py` supports:

```text
prompt_text
prompt_lang
ref_audio_path
streaming_mode = 0 | 1 | 2 | 3
media_type = wav | raw | ogg | aac
parallel_infer
StreamingResponse
```

Mode `2` is actual streamed inference with variable chunks; mode `3` uses fixed-length streaming chunks. 3-ASR

`Qwen/Qwen3-ASR-0.6B-hf` has native Transformers support and supports:

* language identification;
* offline and streaming inference;
* a free-form `prompt` for context/hotwords such as names and specialist vocabulary;
* `torch.compile`.

Use the new backend only behind the existing ASR service contract until benchmarking proves it better for this deployment. ord text

Discord's Message Content intent is privileged, but messages explicitly mentioning the application are one of Discord's documented exceptions where message content remains available without general Message Content access. Runtime V2 should therefore begin with **mention-only text interaction** and add `GuildMessages`, without requesting general Message Content merely to implement `@Kurisu ...`. ord Live2D

Discord Activities are web applications rendered inside Discord through an iframe and communicate with the Discord client through the Embedded App SDK. Use an Activity as the visual body rather than attempting to transmit a fake webcam/video stream. . Overall architecture contract

The target architecture is:

```text
                 Discord Voice
                       │
                       ▼
                 Voice Adapter
                       │
                 VoiceUtterance
                       │
                       ▼
                 ┌────────────┐
Discord @mention │            │ Activity interaction
───────────────► │   Input    │ ◄──────────────────
                 │ Adapters   │
                 └─────┬──────┘
                       │
                 normalized InputEvent
                       │
                       ▼
              ┌──────────────────┐
              │ TurnOrchestrator │
              │                  │
              │ room state       │
              │ attention        │
              │ cancellation     │
              │ context          │
              │ memory retrieval │
              └───────┬──────────┘
                      │
               PromptCompiler
                      │
                      ▼
               BrainProvider
                    Gemini
                      │
             streaming TurnOutput
                      │
        ┌─────────────┼──────────────┐
        ▼             ▼              ▼
   Discord text   Speech sink    Avatar sink
                      │              │
                 GPT-SoVITS      Discord
                      │           Activity
                 Discord voice      │
                                     ▼
                                   Live2D
```

The central design rule is:

> There is one character runtime and one conversation model. Voice, Discord text, and Live2D are adapters/sinks around it.

Do not build independent "text bot logic" and "voice bot logic."

---

# 3. Core domain interfaces

Finalize these interfaces before parallel implementation agents begin.

Names may be adjusted to local conventions, but semantics must remain.

## 3.1 Input events

```ts
type InputEvent =
  | VoiceInputEvent
  | DiscordMentionInputEvent
  | SlashCommandInputEvent
  | ActivityInteractionInputEvent

interface BaseInputEvent {
  eventId: string
  turnId: string

  guildId?: string
  channelId?: string
  userId: string
  displayName: string

  timestamp: number
}

interface VoiceInputEvent extends BaseInputEvent {
  type: 'voice'
  voiceChannelId: string
  pcm: Buffer
  sampleRate: number
}

interface DiscordMentionInputEvent extends BaseInputEvent {
  type: 'discord-mention'
  messageId: string
  text: string
}

interface ActivityInteractionInputEvent extends BaseInputEvent {
  type: 'activity'
  activitySessionId: string
  action: string
  payload?: unknown
}
```

ASR remains a provider operation performed after a voice event is received.

Do not make downstream conversation code depend directly on Discord message or voice classes.

---

# 4. Conversation rooms

Replace guild-only conversation history.

Use room identities approximately like:

```ts
type ConversationRoomId = string

function textRoom(guildId: string, channelId: string) {
  return `guild:${guildId}:text:${channelId}`
}

function threadRoom(guildId: string, threadId: string) {
  return `guild:${guildId}:thread:${threadId}`
}

function voiceRoom(guildId: string, voiceChannelId: string) {
  return `guild:${guildId}:voice:${voiceChannelId}`
}
```

A room owns:

```ts
interface ConversationRoom {
  id: ConversationRoomId

  characterId: string

  recentTurns: ConversationTurn[]
  runningSummary?: string

  activeMode?: string

  createdAt: number
  updatedAt: number
}
```

Do not let two unrelated channels in the same guild share raw context accidentally.

Later allow explicit room binding:

```text
text channel #kurisu
        │
        └──── same logical room ─── voice channel General
```

This enables a user to speak to Kurisu and continue the same conversation by `@mention` later.

---

# 5. Output must be semantic events

The brain/controller should no longer conceptually return only one finished string.

Use:

```ts
type TurnOutput =
  | {
      type: 'text.delta'
      text: string
    }
  | {
      type: 'speech.segment'
      segmentId: string
      text: string
    }
  | {
      type: 'avatar.action'
      action: AvatarAction
    }
  | {
      type: 'pause'
      durationMs: number
    }
  | {
      type: 'final'
    }
```

Consumers:

```text
DiscordTextSink   ← text events
SpeechSink        ← speech segments
AvatarSink        ← avatar actions
Telemetry         ← everything
```

The ACT syntax may exist as one LLM-output encoding, but ACT tokens are **not the internal architecture**.

They must be parsed immediately into `AvatarAction`.

Never send ACT markup into:

```text
GPT-SoVITS
Discord visible replies
memory summaries
ordinary conversation history
```

---

# 6. Character subsystem

Create a character layer that makes Kurisu data-driven.

Suggested path inside the current bot:

```text
airi/services/discord-bot/src/character/
    types.ts
    card-schema.ts
    character-registry.ts
    prompt-compiler.ts
    character-assets.ts
    output-protocol.ts
```

Avoid relocating the entire repo during this change.

## Character runtime type

```ts
interface CharacterRuntime {
  id: string
  name: string

  identity: {
    description: string
    personality: string
    scenario: string
    systemPrompt: string
    postHistoryInstructions: string
  }

  voice: VoiceProfile
  asr: AsrCharacterProfile

  avatar?: AvatarProfile
  lorebook?: CharacterLorebook

  outputProtocol?: OutputProtocolProfile
}
```

## Character registry

Responsibilities:

```text
load card
validate CCv3
normalize optional fields
resolve application extensions
resolve assets
return immutable CharacterRuntime
```

It must not:

```text
call Gemini
call TTS
call ASR
manage Discord
write memory
```

---

# 7. Kurisu card migration

Add a DC_BOT-specific extension.

Recommended shape:

```json
{
  "extensions": {
    "airi": {
      "...": "preserve existing AIRI fields"
    },

    "dc_bot": {
      "outputProtocol": {
        "type": "act-v1",
        "emotions": [
          "happy",
          "sad",
          "angry",
          "think",
          "surprised",
          "awkward",
          "question",
          "curious",
          "neutral"
        ],
        "allowDelay": true
      },

      "voice": {
        "provider": "gpt-sovits",
        "voiceId": "kurisu",
        "referenceAudio": "害羞示范.wav",
        "referenceTextFile": "reference.txt",
        "promptLanguage": "ja"
      },

      "asr": {
        "hotwords": [
          "牧瀬紅莉栖",
          "クリスティーナ",
          "アマデウス",
          "岡部倫太郎",
          "未来ガジェット研究所"
        ]
      },

      "avatar": {
        "renderer": "live2d",
        "displayModelId": "display-model-0-BFdupzrCE8y9q0Vofel"
      }
    }
  }
}
```

Do not store:

```text
API keys
Discord tokens
absolute user machine paths
ports
CUDA device selection
```

inside the card.

Those remain deployment configuration.

`creator_notes` should not automatically be injected into prompts.

Prompt behavior should primarily use the semantic card fields:

```text
system_prompt
description
personality
scenario
character_book
post_history_instructions
```

---

# 8. Prompt compiler

Implement prompt composition once.

Recommended ordering:

```text
runtime safety/output-format instructions
        ↓
character system_prompt
        ↓
description
personality
scenario
        ↓
activated lorebook entries
        ↓
retrieved long-term memories
        ↓
room running summary
        ↓
recent exact conversation turns
        ↓
current input
        ↓
post_history_instructions
```

Do not concatenate everything blindly.

The compiler should expose telemetry:

```ts
interface CompiledPromptMetrics {
  approximateTokens: number
  recentTurnCount: number
  memoryCount: number
  loreEntryCount: number
}
```

This matters because an oversized prompt hurts first-token latency and eventually cost.

Add deterministic tests for prompt ordering.

---

# 9. Conversation context versus memory

These must not be the same subsystem.

## Context

Context represents the active conversation.

Use:

```text
recent exact turns
+
running room summary
```

## Memory

Memory represents information worth retaining beyond the current short context.

Use an interface from the beginning:

```ts
interface MemoryStore {
  search(query: MemoryQuery): Promise<MemoryRecord[]>
  save(record: MemoryRecord): Promise<void>
  update(id: string, patch: Partial<MemoryRecord>): Promise<void>
  forget(id: string): Promise<void>
}
```

Initial implementation:

```text
SQLite
+
FTS5
+
recency
+
salience
```

Do not begin with a vector database.

An embedding column may be added later.

Example record:

```ts
interface MemoryRecord {
  id: string

  characterId: string

  scope:
    | { type: 'user'; userId: string }
    | { type: 'room'; roomId: string }
    | { type: 'guild'; guildId: string }

  text: string

  sourceTurnIds: string[]

  salience: number
  confidence: number

  createdAt: number
  updatedAt: number
  lastAccessedAt?: number

  tags: string[]
}
```

Memory extraction/summarization must not block audio response.

Response first.

Memory maintenance afterward.

---

# 10. Delivery policy

Input medium and output medium must be decoupled.

Recommended default:

```text
Voice input
    → voice output
    → avatar output if available

Discord @mention
    → Discord text output
    → avatar output if the related Activity is active
    → DO NOT speak into VC by default

Activity interaction
    → Activity-visible response
    → optionally voice if interaction came from bound VC session
```

Represent this explicitly:

```ts
interface DeliveryPolicy {
  text: boolean
  speech: boolean
  avatar: boolean
}
```

Do not hide this decision inside `if (event.type === ...)` statements across the codebase.

---

# 11. Subagent execution model

The parent coding agent is the **Integration Lead**.

It owns:

```text
architecture
cross-agent interface decisions
shared bootstrap files
merge order
final integration
release testing
```

Specialists must not all ingest the entire AIRI/GPT-SoVITS/Qwen repositories.

Use bounded context.

---

# 12. Shared context files

Before implementation, create:

```text
docs/runtime-v2/
    00-current-state.md
    01-architecture.md
    02-public-contracts.md
    03-performance-baseline.md
    04-decisions.md

docs/runtime-v2/handoffs/
```

Every implementation subagent receives:

```text
00-current-state.md
01-architecture.md
02-public-contracts.md
```

plus only its owned source subtree.

`04-decisions.md` is an ADR-style append-only decision log.

Example:

```text
D001 Keep ASR and TTS as separate Python processes.
D002 Voice and text use the same TurnOrchestrator.
D003 Conversation context is room-scoped.
D004 SQLite precedes vector memory.
D005 Live2D uses a Discord Activity.
```

This is how context is preserved without repeatedly feeding agents the whole repository.

---

# 13. Required subagent handoff format

Every agent writes:

```text
docs/runtime-v2/handoffs/<agent-name>.md
```

containing only:

```text
# Summary

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

Do not store chain-of-thought or long exploratory notes in handoffs.

Downstream agents should read the handoff rather than rereading another agent's entire implementation history.

---

# 14. Wave 0 — Cartography and immutable baseline

Run two subagents in parallel.

## Subagent 0A — Repository Cartographer

### Context

Give:

```text
README.md
plan.md
Live2D_Plan.md

airi/services/discord-bot/**
qwen3-asr/app/**
relevant startup scripts
GPT-SoVITS Kurisu config
Makise Kurisu/card.json
```

Do not ask it to research upstream projects.

### Task

Verify the **actual local HEAD**.

Produce:

```text
docs/runtime-v2/00-current-state.md
```

Include:

```text
git commit hashes
whether AIRI/GPT-SoVITS/Qwen directories are vendored/submodules/checkouts
actual bot file tree
startup path
Discord client bootstrap
command registration
voice receive path
Opus decode path
utterance finalization
ASR request path
Gemini request path
SpeechChunker path
TTS request path
audio playback path
conversation-history ownership
turn queue ownership
configuration loader
test commands
```

Also identify:

```text
files safe to refactor
files owned by upstream
files already customized from upstream
```

### Restrictions

No functional code changes.

---

## Subagent 0B — Baseline / Benchmark Analyst

### Context

Give:

```text
bot_log*.txt
Inference_Log*.txt
README performance-related configuration
current ASR/TTS/Gemini provider code
existing tests
```

### Task

Create:

```text
docs/runtime-v2/03-performance-baseline.md
```

Measure or extract:

```text
endpoint delay
ASR latency
LLM first token
LLM completion
TTS request → first bytes
TTS request → full response
Discord playback start
user stop → first audio
```

Create fixed benchmark fixtures:

```text
Japanese short utterance
English short utterance
Mandarin short utterance
Japanese 10–15 second utterance
noise/filler fixture
```

Record:

```text
P50
P95
sample count
model configuration
GPU
streaming mode
warm/cold state
```

Do not optimize yet.

---

# 15. Wave 0 integration gate

The Integration Lead now writes:

```text
01-architecture.md
02-public-contracts.md
04-decisions.md
```

using this master plan plus the Cartographer's corrections.

Only after the public interfaces are frozen should specialist implementation begin.

If local reality contradicts this document, update `04-decisions.md` with the reason.

Do not silently diverge.

---

# 16. Wave 1 — Runtime foundation

Run the following agents in parallel after Wave 0.

---

## Subagent 1A — Character/Card Runtime

### Context

Give:

```text
docs/runtime-v2/00-current-state.md
docs/runtime-v2/01-architecture.md
docs/runtime-v2/02-public-contracts.md

Makise Kurisu/card.json

airi/services/discord-bot/src/config/**
relevant existing character/personality code only
```

Also provide the Character Card facts already summarized in this document.

### Owns

```text
src/character/**
Makise Kurisu/card.json
Makise Kurisu/reference.txt
character-specific tests
```

### Tasks

1. Implement Character Card V3 validation.
2. Preserve unknown extension fields.
3. Add `CharacterRegistry`.
4. Add normalized `CharacterRuntime`.
5. Add `PromptCompiler`.
6. Add `extensions.dc_bot`.
7. Move ACT protocol metadata into `extensions.dc_bot.outputProtocol`.
8. Preserve existing AIRI extension.
9. Resolve Kurisu voice metadata.
10. Add ASR hotword metadata.
11. Add avatar metadata.
12. Add tests for malformed cards and missing optional fields.
13. Ensure `creator_notes` is not treated as automatic system prompt content.
14. Document migration behavior.

### Acceptance

Given Kurisu's current card:

```text
registry.load("kurisu")
```

must return a normalized character runtime containing:

```text
identity
voice profile
ASR vocabulary
avatar metadata
output protocol
```

with no Discord/model-provider side effects.

---

## Subagent 1B — Conversation Domain

### Context

Give:

```text
shared runtime-v2 docs
current conversation-controller.ts
turn-queue.ts
existing conversation state/history code
voice event public interfaces
```

### Owns

```text
src/orchestration/room*
src/orchestration/turn*
src/orchestration/events*
```

Avoid editing providers.

### Tasks

1. Introduce `ConversationRoomId`.
2. Replace conceptual guild-only session ownership.
3. Define normalized `InputEvent`.
4. Define `TurnOutput`.
5. Define `DeliveryPolicy`.
6. Preserve one active generated response per room.
7. Support cancellation through `AbortSignal`.
8. Support barge-in cancellation.
9. Preserve cross-room concurrency.
10. Add deterministic unit tests.

### Important behavior

Two separate channels in the same guild:

```text
#science
#gaming
```

must not share recent conversation history.

Two users speaking sequentially in one voice room should share that room's conversational history.

---

## Subagent 1C — Telemetry/Tracing

### Context

Give:

```text
shared docs
existing telemetry/logger code
current provider interfaces
baseline document
```

### Owns

```text
src/observability/**
telemetry tests
```

### Tasks

Define one `turnId` through:

```text
Discord receive
endpoint finalized
ASR begin/end
attention decision
prompt compile
LLM request
LLM first token
LLM complete
TTS request
TTS first byte
TTS first PCM
playback queued
playback start
playback end
memory work
avatar events
```

Use monotonic time for durations.

Log stage duration separately.

Do not treat `user stop → audio` as the only latency metric.

---

# 17. Wave 1 integration gate

Integration Lead:

1. Merge the domain contracts.
2. Wire existing voice path through `TurnOrchestrator`.
3. Preserve existing functionality.
4. Do not add text/memory/Live2D yet.
5. Run:

```text
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test

qwen3-asr/.venv/Scripts/python.exe -m pytest
```

plus existing smoke tests.

The bot must still complete:

```text
/summon
voice
ASR
Gemini
TTS
playback
/leave
```

before continuing.

---

# 18. Wave 2 — Latency and model-provider optimization

Run 2A, 2B, and 2C in parallel.

---

## Subagent 2A — GPT-SoVITS Performance

This is the highest-priority performance agent.

### Context

Give:

```text
shared docs
performance baseline
current GptSoVits provider
current SpeechChunker public interface
current VoiceManager playback public interface
GPT-SoVITS API facts from this document
TTS-KurisuMakise assets
Inference_Log_2.txt
```

Do not give it the entire AIRI frontend.

### Owns

```text
src/providers/tts/**
TTS benchmark utilities
Kurisu voice profile integration
```

If `speech-chunker.ts` must change, coordinate through a public interface change rather than editing it concurrently with another owner.

### Step 1 — Correct reference conditioning

The current request is prompt-free.

Generate an initial transcript for:

```text
TTS-KurisuMakise/害羞示范.wav
```

using the local ASR service.

Store the reviewed value in:

```text
Makise Kurisu/reference.txt
```

The agent may generate the first transcription automatically, but it must flag uncertainty rather than inventing Japanese words it cannot verify.

Send:

```text
ref_audio_path
prompt_text
prompt_lang=ja
```

for every Kurisu request.

Verify the GPT-SoVITS log no longer contains:

```text
Prompt free is not supported batch_infer!
```

for ordinary conditioned synthesis.

### Step 2 — Benchmark streaming modes

Benchmark identical phrases with:

```text
streaming_mode=0
streaming_mode=1
streaming_mode=2
streaming_mode=3
```

Measure:

```text
request → first response byte
request → first playable PCM
request → complete audio
RTF
subjective quality
```

Default candidate is mode `2`, but do not make that permanent until measured.

### Step 3 — Streaming playback

Current behavior must evolve from:

```text
TTS request
   ↓
wait for whole generated asset
   ↓
Discord playback
```

toward:

```text
TTS response
   │
   ├─ chunk
   ├─ chunk
   ├─ chunk
   ▼
playable stream
   ▼
Discord starts before synthesis finishes
```

Do not automatically choose `raw` merely because it exists.

Benchmark:

```text
streaming WAV
raw PCM
existing audio path
```

and choose the lowest-complexity path that starts Discord playback reliably without unnecessary transcoding.

### Step 4 — Cancellation

An interrupted bot response must abort:

```text
outstanding GPT-SoVITS HTTP request
queued speech segments
future playback
```

Do not let abandoned TTS continue consuming GPU unnecessarily.

### Step 5 — TTS lookahead

If speech remains segmented, synthesize segment `N+1` while segment `N` is playing.

Bound the queue.

Do not synthesize the entire remaining answer far ahead because barge-in would waste compute.

Recommended maximum:

```text
current playing segment
+
one prefetched segment
```

### Acceptance

Warm short Japanese synthesis should:

* use nonempty prompt conditioning;
* begin playback from streamed output;
* cancel cleanly;
* improve TTS-first-playable latency materially versus baseline.

---

## Subagent 2B — Qwen3-ASR Backend

### Context

Give:

```text
shared docs
qwen3-asr/app/**
ASR provider contract
current ASR tests
benchmark audio
CharacterRuntime ASR interface
Qwen3-ASR facts in this document
```

### Owns

```text
qwen3-asr/**
except unrelated upstream code if avoidable
```

### Preserve API

The Discord service should not need to know which Qwen implementation is active.

Maintain an API similar to:

```text
POST /v1/transcribe
```

with a stable response:

```json
{
  "text": "...",
  "language": "ja"
}
```

Add optional:

```json
{
  "prompt": "..."
}
```

or equivalent request property.

### Implement selectable backends

Example:

```text
ASR_BACKEND=current
ASR_BACKEND=transformers-hf
```

For the HF backend:

```text
Qwen/Qwen3-ASR-0.6B-hf
Transformers >= required upstream version
optional torch.compile
warm-up
```

Add:

```text
ASR_TORCH_COMPILE=false|true
ASR_WARMUP_RUNS=...
```

Do not enable compile by default until local benchmark results justify its warmup/memory cost.

### Readiness semantics

`GET /health` should only report ready after:

```text
model loaded
GPU placement complete
required kernels initialized
configured warmup complete
one trivial inference path succeeds
```

### Context/hotword input

Build prompts from upstream-provided context rather than hardcoding Kurisu in Python.

Example request:

```text
Vocabulary:
牧瀬紅莉栖,
クリスティーナ,
アマデウス,
岡部倫太郎,
未来ガジェット研究所,
Patrick,
Alice
```

### Acceptance

Benchmark both backends on the same fixtures.

Do not switch default solely because a vendor benchmark says it is faster.

Record:

```text
P50/P95
VRAM
cold startup
warm inference
transcript quality
language accuracy
```

---

## Subagent 2C — Brain Streaming / Response Latency

### Context

Give:

```text
shared docs
Gemini provider only
PromptCompiler public contract
Speech segmentation interface
performance baseline
```

### Owns

```text
src/providers/brain/**
brain tests
```

### Tasks

1. Preserve provider abstraction.
2. Keep Gemini model configurable.
3. Ensure generation is actually consumed as a stream.
4. Emit first-token telemetry immediately.
5. Use `AbortSignal`.
6. Do not wait for complete LLM output before allowing first speech segment.
7. Remove duplicated character instructions from request construction.
8. Avoid resending irrelevant context.
9. Handle provider `429` errors explicitly.
10. Surface retry metadata to the orchestrator rather than recursively retrying a voice response.

Do not add an automatic fallback LLM in this wave.

Keep:

```ts
interface BrainProvider
```

replaceable for a future:

```text
GeminiBrainProvider
AiriCoreBrainProvider
local LLM
```

---

# 19. Wave 2D — Attention policy

After the basic provider changes stabilize, assign a smaller specialist.

## Subagent 2D — Attention / Turn Filtering

### Goal

Stop wasting full model turns on:

```text
empty transcription
isolated filler
accidental noise
very short meaningless acknowledgements
```

without making the bot unresponsive.

### Owns

```text
src/orchestration/attention/**
```

### API

```ts
interface AttentionDecision {
  type: 'respond' | 'observe' | 'ignore'
  reason: string
  confidence?: number
}
```

### First implementation

Use deterministic heuristics.

Do not call another LLM just to decide whether to call the LLM.

Examples:

```text
empty ASR
→ ignore

known filler only
→ ignore or observe

explicit character name
→ respond

user actively in recent exchange with bot
→ respond

ordinary substantial utterance in single-user test mode
→ respond
```

Make policy configurable because group voice channels differ from one-on-one channels.

The logs already show repeated empty/filler turns and Gemini quota exhaustion, so filtering should occur before expensive generation. 0. Wave 2 performance gate

Run at least 20 warm turns across the fixed fixtures.

Report:

```text
P50
P95
```

for every stage.

Minimum goal:

```text
user-stop → first audible response:
reduce substantially from ~8.8 s baseline
```

Suggested milestone:

```text
P50 < 5.0 s
```

Stretch:

```text
P50 < 3.0–4.0 s
```

provided the selected remote Gemini model can sustain it.

More useful subsystem target:

```text
TTS request → first playable audio < ~2 s warm
```

The targets are performance gates, not reasons to degrade voice quality badly.

Preserve multilingual quality for:

```text
Japanese
English
Mandarin
```

---

# 21. Wave 3 — Discord text + unified rooms

Do this only after the unified orchestrator exists.

---

## Subagent 3A — Discord Mention Adapter

### Context

Give:

```text
shared docs
Discord client initialization
current adapters/bots/discord subtree
TurnOrchestrator public API
DeliveryPolicy
room resolver
```

Do not give model internals.

### Owns

```text
Discord text input adapter
Discord text output sink
text-specific tests
```

### Tasks

1. Add `GuildMessages`.
2. Do not enable privileged Message Content merely for mention chat.
3. Listen to `messageCreate`.
4. Ignore:

   * bots;
   * self;
   * messages without explicit bot mention.
5. Strip the application mention safely.
6. Preserve attachments/metadata for future multimodal expansion without implementing vision now.
7. Convert into `DiscordMentionInputEvent`.
8. Resolve text `ConversationRoomId`.
9. Send it through the same `TurnOrchestrator`.
10. Stream/edit Discord response if worthwhile, but respect Discord API limits.
11. Split overly long final replies cleanly.
12. Use typing indicators while appropriate.
13. Never invoke GPT-SoVITS by default for a plain text mention.

Example:

```text
@Kurisu この前話していた実験、覚えてる？
```

should use the same character/prompt/context subsystem as voice.

---

## Subagent 3B — Room Binding

### Owns

```text
src/orchestration/room-binding*
Discord binding command only
```

Implement persistence mapping such as:

```text
guildId + textChannelId → logical room
guildId + voiceChannelId → logical room
```

Add a slash command conceptually like:

```text
/bind-chat
```

Exact UX may be adapted to Discord API constraints.

Behavior:

```text
voice room General
      │
      ├── logical conversation "lab"
      │
text #kurisu
```

A voice turn followed by a text mention should see shared context only if explicitly bound.

Unbound channels remain isolated.

---

# 22. Wave 3 integration gate

Test:

### Text isolation

```text
#channel-a → fact A
#channel-b → ask about fact A
```

Channel B must not automatically know it from short context.

### Bound continuity

```text
voice room → tell Kurisu fact X
bound text room → ask what X was
```

Kurisu should have the active-room context.

### Delivery

Text mention:

```text
must not unexpectedly speak in voice channel
```

Voice turn:

```text
must still speak normally
```

---

# 23. Wave 4 — Persistent memory

Persistent memory comes after ordinary context works.

---

## Subagent 4A — SQLite Memory Store

### Context

Give:

```text
MemoryStore interface
ConversationRoom interfaces
character ID design
storage/config layer
```

No Gemini implementation required.

### Owns

```text
src/memory/**
database migrations
memory tests
```

### Implement

SQLite tables approximately:

```text
memories
memory_sources
room_summaries
room_bindings
schema_version
```

Use FTS5 where available.

Search score can begin as:

```text
scope match
+ lexical relevance
+ recency
+ salience
```

Add deterministic maximum retrieval count/token budget.

Do not pull hundreds of memory records into prompts.

---

## Subagent 4B — Context Summarizer / Memory Writer

### Context

Give:

```text
MemoryStore interface
BrainProvider interface
conversation-turn schema
PromptCompiler memory insertion contract
```

### Owns

```text
src/memory/maintenance/**
```

### Behavior

After the user has received their response:

```text
turn completes
    ↓
async maintenance task
    ├─ update running room summary if necessary
    └─ optionally extract important memories
```

Examples worth remembering:

```text
preferred name
ongoing project
important prior promise
stable relationship/context fact
meaningful recurring interest
```

Examples not worth remembering:

```text
every filler utterance
full raw transcripts forever
every generated sentence
```

Avoid storing speculative model inference as certain fact.

Maintain:

```text
confidence
sourceTurnIds
```

---

# 24. Memory controls

Add user/admin controls before calling memory complete.

Minimum:

```text
/reset-context
```

clears active room context without necessarily deleting long-term memory.

Add one of:

```text
/forget-me
/memory-clear
```

depending on desired UX.

Persistent memory should be configurable:

```text
MEMORY_ENABLED=true
MEMORY_DB_PATH=...
```

Do not place database files inside upstream source directories if avoidable.

---

# 25. Wave 5 — Character-aware ASR

Once CharacterRuntime and the upgraded ASR service both exist, wire them together.

Build ASR prompt from:

```text
character ASR hotwords
+
active lorebook proper nouns
+
Discord participant display names
+
recent proper nouns if inexpensive
```

Example:

```text
Context for transcription.
Character vocabulary:
牧瀬紅莉栖
クリスティーナ
アマデウス
岡部倫太郎
未来ガジェット研究所

People in the current voice room:
Patrick
Alice
```

Do not feed the whole character card to ASR.

Cap prompt length.

Normalize potentially adversarial display names before embedding them into an ASR context prompt.

This subsystem should improve recognition, not become another prompt-injection channel.

---

# 26. Wave 6 — Semantic emotion/action protocol

Implement this before Live2D so the runtime is avatar-independent.

---

## Subagent 6A — Output Protocol Parser

### Context

Give:

```text
CharacterRuntime outputProtocol
TurnOutput contract
existing ACT examples from card
brain stream contract
```

### Owns

```text
src/character/output-protocol/**
```

### Parse

Input:

```text
<|ACT:"emotion":{"name":"question","intensity":0.7},"motion":"眉をひそめる"|>
そんなこと、本当に可能だと思ってるの？
```

Output:

```ts
{
  type: 'avatar.action',
  action: {
    emotion: 'question',
    intensity: 0.7,
    motionHint: '眉をひそめる'
  }
}
```

plus clean speech/text:

```text
そんなこと、本当に可能だと思ってるの？
```

### Robustness

Malformed ACT content must not break the turn.

Fallback:

```text
treat malformed control syntax as stripped/ignored metadata
preserve safe visible response content
```

Do not evaluate arbitrary JSON/code from LLM output.

---

# 27. Wave 7 — Live2D foundation

Use the existing `Live2D_Plan.md` as the detailed specialist reference, but execute it only after Runtime V2's event contracts exist.

The Activity should be an **output/input adapter**, not another copy of the character brain.

Architecture:

```text
TurnOrchestrator
      │
      ├── AvatarAction
      │
      ▼
AvatarPublisher
      │
      ▼
secure relay
      │
      ▼
Discord Activity
      │
      ▼
AIRI-derived Live2D renderer
```

The Activity renders locally.

Do not stream rendered video frames from the bot.

---

# 28. Live2D subagent wave A

Run after semantic avatar interfaces are frozen.

## Subagent 7A — Avatar Protocol

### Owns

```text
shared avatar protocol package
```

Define versioned messages:

```ts
type AvatarEvent =
  | AvatarSnapshot
  | AvatarBehaviorEvent
  | AvatarActionEvent
  | AvatarSpeechStateEvent
  | AvatarMouthSampleEvent
```

Include:

```text
protocolVersion
sessionId
turnId
sequence
timestamp
```

Must support snapshot recovery after reconnect.

---

## Subagent 7B — Discord Activity Shell

### Context

Only:

```text
Avatar protocol
Discord Activity requirements
minimal renderer mounting interface
```

### Owns

```text
Activity Discord/bootstrap/networking layer
```

Responsibilities:

```text
Embedded App SDK initialization
session identity
layout
responsive resize
mobile behavior
relay connection
reconnection
```

No Live2D internals.

---

## Subagent 7C — AIRI Live2D Renderer

### Context

Give:

```text
relevant AIRI Live2D renderer subtree
Avatar protocol
renderer mounting contract
Kurisu display model metadata
```

Do not give Discord bot internals.

### Responsibilities

Render:

```text
model load
idle animation
blink
gaze
expression
motion
mouth parameter
responsive scaling
```

Expose semantic renderer calls such as:

```ts
setBehavior('thinking')
setEmotion('curious', 0.8)
playGesture('brow_furrow')
setMouthOpen(0.42)
```

Do not let server events reference raw Cubism parameters directly.

---

# 29. Live2D subagent wave B

After the Activity can display Kurisu locally:

## Subagent 7D — Avatar Relay

Own:

```text
relay service only
```

Implement:

```text
publisher authentication
viewer/session authentication
room/session routing
snapshot cache
sequence handling
rate limits
health
WSS-ready deployment structure
```

No model inference.

---

## Subagent 7E — Bot Avatar Publisher

Own:

```text
Discord bot avatar publisher
```

Publish state transitions:

```text
idle
listening
thinking
speaking
interrupted
error
```

Use the existing `turnId`.

Do not wait for the relay before producing voice.

Avatar failure must be nonfatal.

---

# 30. Live2D subagent wave C — Lip sync

## Subagent 7F — Audio/Lip-Sync

### Input

Use the actual playable/generated audio stream.

Not LLM text timing.

Pipeline:

```text
TTS playable PCM
     │
     ├── Discord voice
     │
     └── amplitude envelope
               ↓
        mouth samples ~20–25 Hz
               ↓
           relay
               ↓
          Activity
               ↓
      ParamMouthOpenY
```

Compute smoothed amplitude/RMS.

Add configurable delay:

```text
AVATAR_ANIMATION_DELAY_MS
```

Synchronize against actual playback epoch, not TTS request time.

Later optionally derive phoneme/viseme information, but amplitude lip-sync is the first implementation.

---

# 31. Live2D subagent wave D — Motion Director

## Subagent 7G — Avatar Director

Map semantic actions:

```text
question
curious
happy
sad
angry
think
surprised
awkward
neutral
```

to character-specific animation profiles.

Example:

```text
semantic:
emotion=question
motionHint=眉をひそめる

          ↓

Kurisu avatar profile:
expression=exp_question
motion=Think01
brow parameters=...
gaze=user
```

The LLM must never decide raw Live2D parameter numbers.

This lets another character use entirely different assets while preserving the same semantic protocol.

---

# 32. Live2D Activity interactions

After rendering is stable, Activity interactions may produce normalized inputs.

Examples:

```text
click Kurisu
select lab gadget
choose conversation topic
poke a UI experiment
change standing position
```

Convert to:

```text
ActivityInteractionInputEvent
```

and route through the ordinary `TurnOrchestrator`.

Do not create a separate Activity chatbot backend.

---

# 33. Wave 8 — Repository hygiene

Do not perform a giant directory migration before the runtime works.

Once Runtime V2 is stable, assign a repository-maintenance agent.

Its job is to evaluate whether your project-owned code should remain under:

```text
airi/services/discord-bot
```

or move to something like:

```text
apps/discord-bot
packages/runtime-core
packages/character
services/asr-qwen
services/avatar-relay
```

The correct choice depends on whether the existing AIRI checkout is vendored, a submodule, or intended to continue tracking upstream.

The Cartographer must establish this first.

Avoid mixing major architecture changes and mass file moves in the same pull request.

If upstream synchronization matters, consider:

```text
pinned submodules
patches
small adapter packages
clear vendor boundary
```

instead of maintaining an increasingly divergent anonymous AIRI fork.

---

# 34. Configuration plan

Continue the current separation:

```text
.env       → secrets
.config    → nonsecret project configuration
.env.local → local overrides
```

Suggested additions:

```text
# Character
CHARACTER_PATH=../../Makise Kurisu/card.json
CHARACTER_ID=makise-kurisu

# Context
CONTEXT_MAX_RECENT_TURNS=
CONTEXT_SUMMARY_ENABLED=true

# Memory
MEMORY_ENABLED=true
MEMORY_DB_PATH=
MEMORY_MAX_RESULTS=

# Discord Text
DISCORD_MENTION_CHAT_ENABLED=true

# ASR
ASR_BACKEND=current
ASR_CONTEXT_ENABLED=true
ASR_TORCH_COMPILE=false
ASR_WARMUP_RUNS=3

# TTS
GPT_SOVITS_PROMPT_TEXT_FILE=
GPT_SOVITS_STREAMING_MODE=2
GPT_SOVITS_MEDIA_TYPE=
TTS_PREFETCH_SEGMENTS=1

# Avatar
AVATAR_ENABLED=false
AVATAR_RELAY_URL=
AVATAR_RELAY_PUBLISH_TOKEN=
AVATAR_MOUTH_HZ=25
AVATAR_ANIMATION_DELAY_MS=
```

Do not duplicate character-specific voice metadata in environment variables once CharacterRuntime reliably owns it, except for explicit machine overrides.

---

# 35. Error-handling contract

Every external stage needs a defined failure mode.

## ASR failure

```text
log
do not generate garbage response
optionally notify text/debug channel
return room to listening
```

## Gemini 429

```text
do not hammer retries
respect retry metadata
surface temporary unavailable state
preserve queue integrity
```

## TTS failure

If voice input generated valid text but speech fails:

```text
do not corrupt history
optionally send fallback text if configured
return speaking state to false
```

## Avatar failure

```text
voice/text continues normally
```

## Memory failure

```text
response continues normally
memory job logs failure
```

Memory and avatar are explicitly noncritical paths.

---

# 36. Cancellation model

Introduce a turn-scoped abort hierarchy.

Conceptually:

```text
Room turn AbortController
    │
    ├── Gemini
    ├── TTS request
    ├── queued speech chunks
    └── avatar speech events
```

Barge-in:

```text
human starts meaningful speech
       ↓
cancel current bot speaking turn
       ↓
stop playback
       ↓
abort pending TTS
       ↓
discard stale output
       ↓
accept new human turn
```

Every async provider should either accept `AbortSignal` or be wrapped so stale results are ignored.

Never let an old response resume speaking after a new conversation turn has begun.

---

# 37. GPU scheduling

Do not build an elaborate scheduler during initial implementation.

First instrument:

```text
ASR job start/end
TTS job start/end
VRAM if readily available
queue depth
```

With one voice room the natural sequence is usually:

```text
ASR uses GPU
    ↓
remote Gemini
    ↓
TTS uses GPU
```

which is favorable.

If multi-room use later creates contention, introduce a local scheduler interface:

```ts
interface ComputeScheduler {
  runAsr<T>(task: () => Promise<T>): Promise<T>
  runTts<T>(task: () => Promise<T>): Promise<T>
}
```

Prefer short ASR work over queued long TTS work where this improves responsiveness.

Do not merge the ASR and TTS Python environments just to implement scheduling.

---

# 38. Testing pyramid

## Unit tests

Required for:

```text
Character Card parsing
PromptCompiler ordering
ConversationRoom ID generation
room isolation
TurnOutput parsing
ACT parser
attention heuristics
memory ranking
Discord mention stripping
delivery policy
TTS request construction
ASR context construction
```

## Contract tests

Mock:

```text
ASR HTTP
Gemini stream
GPT-SoVITS streaming HTTP
avatar relay
```

Validate cancellation and partial streams.

## Integration tests

Use actual local services for:

```text
ASR fixture → text
TTS phrase → playable stream
voice-test
complete controller with mocked Discord transport
```

## Manual Discord tests

Matrix:

```text
Japanese voice
English voice
Mandarin voice

barge-in
rapid consecutive turns
two speakers
two voice rooms
text mention
two text channels
bound text+voice context

service restart
voice reconnect
Gemini 429
TTS unavailable
ASR unavailable
```

---

# 39. Performance benchmark suite

Never judge latency from one conversational impression.

Record at least:

```text
20 short-turn runs
5 longer-turn runs
```

after warmup.

Metrics:

```text
endpoint_ms
asr_ms
prompt_compile_ms
brain_ttft_ms
brain_complete_ms
speech_segment_ready_ms
tts_first_byte_ms
tts_first_pcm_ms
playback_start_ms
user_stop_to_audio_ms
total_turn_ms
```

Also track:

```text
ASR backend
ASR prompt size
model
TTS streaming mode
TTS media format
TTS text length
speech segment length
character prompt token estimate
```

This will expose regressions caused by larger context/memory.

---

# 40. Performance strategy after Runtime V2

Only optimize what benchmark traces demonstrate.

Potential experiments, in order:

### Experiment A

```text
GPT-SoVITS correct prompt_text
```

### Experiment B

```text
streaming mode 2 vs 3
```

### Experiment C

```text
streaming WAV vs raw
```

### Experiment D

```text
first speech chunk length
```

### Experiment E

```text
one-segment TTS prefetch
```

### Experiment F

```text
Qwen current backend vs Transformers-hf
```

### Experiment G

```text
torch.compile
```

### Experiment H

```text
Gemini model variants
```

### Experiment I

```text
prompt/context budget reductions
```

Change one major variable per benchmark.

---

# 41. Git / merge strategy

Each specialist works in a separate branch/worktree if the coding environment supports it.

Naming:

```text
runtime-v2/cartography
runtime-v2/character
runtime-v2/conversation
runtime-v2/telemetry
runtime-v2/tts
runtime-v2/asr
runtime-v2/brain
runtime-v2/text
runtime-v2/memory
runtime-v2/avatar-protocol
...
```

Specialists should not rebase one another repeatedly.

The Integration Lead merges at wave gates.

Prefer small commits:

```text
feat(character): add CCv3 registry
feat(runtime): add room-scoped turn model
perf(tts): stream GPT-SoVITS response
feat(discord): add mention input adapter
```

Do not produce one enormous Runtime V2 commit.

---

# 42. File-ownership rules

Parallel agents must not casually modify shared bootstrap files.

During specialist waves:

```text
src/index.ts
package.json
global config bootstrap
command registry
main controller constructor
startup scripts
```

are Integration Lead-owned unless explicitly delegated.

If a specialist needs a shared change:

1. document the requested change in its handoff;
2. expose its own public interface;
3. let Integration Lead perform the bootstrap modification.

This dramatically reduces merge conflict and accidental architectural divergence.

---

# 43. Standard prompt for every coding subagent

Use a prompt structurally similar to:

```text
You are Subagent <NAME> working on DC_BOT Runtime V2.

Read first:
- docs/runtime-v2/00-current-state.md
- docs/runtime-v2/01-architecture.md
- docs/runtime-v2/02-public-contracts.md
- the handoffs explicitly listed below.

Your owned files are:
<PATHS>

Do not modify:
<PATHS>

Your exact responsibility:
<TASK>

Do not redesign cross-system architecture.
Do not investigate unrelated upstream projects.
If the existing public contract prevents correct implementation, stop that part
and record the required contract change in your handoff instead of silently
creating a competing abstraction.

Requirements:
- preserve current working behavior unless your task explicitly changes it;
- add tests for new behavior;
- use existing logging/telemetry conventions;
- support cancellation where applicable;
- do not add secrets;
- do not make unrelated cleanup edits;
- run the relevant tests/typecheck;
- write docs/runtime-v2/handoffs/<NAME>.md using the required handoff format.

Return:
1. concise implementation summary;
2. files changed;
3. tests/benchmarks;
4. handoff path.
```

This prompt should be generated from the master plan rather than recreated differently for every agent.

---

# 44. Integration Lead workflow after every wave

The parent agent must:

1. Read specialist handoffs.
2. Inspect diffs.
3. Reject duplicated abstractions.
4. Resolve public-contract changes centrally.
5. Integrate shared bootstrap code.
6. Run complete tests.
7. Run at least one end-to-end smoke test.
8. Update:

   ```text
   docs/runtime-v2/04-decisions.md
   ```
9. Record current benchmark change.
10. Commit the wave before launching dependent agents.

Do not immediately launch all remaining agents merely because earlier agents finished.

The wave gates are intentional context-management boundaries.

---

# 45. Execution graph

Use approximately:

```text
             ┌────────────────────┐
             │ 0A Cartographer    │
             └─────────┬──────────┘
                       │
             ┌─────────▼──────────┐
             │ Shared contracts   │
             └─────────┬──────────┘
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
 Character/Card   Conversation       Telemetry
       │             Domain              │
       └───────────────┬─────────────────┘
                       ▼
                Wave 1 Integration
                       │
         ┌─────────────┼──────────────┐
         ▼             ▼              ▼
       TTS            ASR           Brain
         └─────────────┼──────────────┘
                       ▼
                  Attention
                       │
                       ▼
                Performance Gate
                       │
             ┌─────────┴──────────┐
             ▼                    ▼
       Discord Text          Room Binding
             └─────────┬──────────┘
                       ▼
                  Text/Voice Gate
                       │
             ┌─────────┴──────────┐
             ▼                    ▼
       SQLite Memory       Memory Maintenance
             └─────────┬──────────┘
                       ▼
              Character-aware ASR
                       │
                       ▼
               Semantic Actions
                       │
                       ▼
                Avatar Protocol
                       │
           ┌───────────┼─────────────┐
           ▼           ▼             ▼
      Activity      Live2D         Relay
         Shell      Renderer
           └───────────┼─────────────┘
                       ▼
                 Bot Publisher
                       │
                       ▼
                    Lip Sync
                       │
                       ▼
                Motion Director
                       │
                       ▼
                  Live2D QA
                       │
                       ▼
             Repository Hygiene
                       │
                       ▼
                Release Candidate
```

---

# 46. Milestones

## Milestone 1 — Character Runtime

Done when:

```text
card.json is actually consumed
Kurisu prompt comes from the card
voice profile comes from the character
room-scoped context works
voice still works end-to-end
```

No memory or Live2D required.

## Milestone 2 — Responsive Voice

Done when:

```text
GPT-SoVITS prompt-free fallback is gone
TTS streams
playback can start before full synthesis finishes
barge-in cancels generation/playback
benchmark improves materially
```

## Milestone 3 — Unified Discord Character

Done when:

```text
@bot works
voice + text use one orchestrator
room context isolation works
optional room binding works
```

## Milestone 4 — Persistent Character

Done when:

```text
running summaries work
SQLite memory works
memory does not block response
clear/reset controls exist
```

## Milestone 5 — Embodied Character

Done when:

```text
Discord Activity opens
Kurisu Live2D renders
states follow listening/thinking/speaking
semantic emotion actions work
mouth follows actual TTS audio
reconnection recovers snapshot state
```

---

# 47. Explicit non-goals for the first implementation

Do not:

* Rewrite Discord voice networking.
* Merge the Qwen and GPT-SoVITS environments.
* Put the full AIRI WebSocket/server stack back into the voice hot path.
* Rewrite the bot around AIRI core-agent immediately.
* Introduce Kubernetes.
* Introduce Redis just for one-machine state.
* Introduce a vector database before SQLite retrieval is insufficient.
* Introduce a second LLM solely for attention detection.
* Send rendered Live2D video to Discord.
* Let Live2D block voice.
* Let memory maintenance block voice.
* Allow ACT tokens to reach TTS.
* Give the LLM direct Cubism parameter control.
* Perform a giant repo relocation before Runtime V2 is stable.
* Tune latency without benchmark traces.
* Optimize ASR first merely because it is an AI model; current measurements show TTS/LLM are larger contributors.

---

# 48. Definition of Done for Runtime V2 core

Runtime V2 core is complete when all of these are true:

### Character

* Character Card V3 loads successfully.
* Character-specific configuration is isolated from machine configuration.
* `system_prompt`, personality, description, scenario, and post-history instructions affect generation.
* `extensions.dc_bot` drives voice/ASR/avatar metadata.
* Unknown CCv3 fields survive parsing where appropriate.

### Context

* Context is room-scoped.
* Different Discord channels do not contaminate one another.
* Voice and text can deliberately share a logical room.
* Running context survives more than a handful of turns without repeatedly acting like first contact.

### Voice

* Japanese works.
* English works.
* Mandarin works.
* Barge-in works.
* Old turns cannot resume after cancellation.
* TTS uses the correct Kurisu reference prompt.
* Streaming TTS reaches Discord playback.

### Discord text

* Explicit `@bot` mention generates a text response.
* Plain unrelated guild messages are ignored.
* No general Message Content permission is required for the mention-only MVP.
* Text uses the same character/context runtime as voice.

### ASR

* Qwen service remains isolated.
* Character vocabulary can be supplied as transcription context.
* Backend selection is configurable.
* Health means genuinely ready.
* Benchmark results exist for the chosen backend.

### Memory

* SQLite persistence works.
* Memory lookup is scoped.
* Memory work is outside the critical response path.
* Reset/forget behavior exists.

### Observability

Each successful voice turn reports:

```text
endpoint
ASR
brain TTFT
brain complete
TTS first byte/PCM
playback start
user stop → audio
```

using one `turnId`.

### Live2D foundation

When enabled:

* Discord Activity displays the model.
* Avatar state follows the actual bot state.
* Semantic emotion actions map into Kurisu-specific animation.
* Mouth movement follows the audio signal.
* Activity failure never breaks ordinary bot conversation.

### Engineering

* Typecheck passes.
* Unit tests pass.
* ASR tests pass.
* End-to-end voice smoke test passes.
* End-to-end mention smoke test passes.
* No secrets are committed.
* Handoff documentation exists.
* Performance baseline and post-change benchmark are both recorded.

---

# 49. Final architecture principle

Do not optimize this project toward:

```text
a Discord bot with Qwen + Gemini + GPT-SoVITS glued together
```

Optimize toward:

```text
                    Makise Kurisu Runtime
                           │
            ┌──────────────┼──────────────┐
            │              │              │
         Discord        Memory          Character
          Rooms                          Card/Lore
            │
     ┌──────┴───────┐
     ▼              ▼
   Voice           Text
     │              │
     └──────┬───────┘
            ▼
     Turn Orchestrator
            │
       Character Brain
            │
   ┌────────┼───────────┐
   ▼        ▼           ▼
 speech    text       actions
   │                    │
GPT-SoVITS           Live2D
   │                 Activity
Discord
```

The character is the product.

Discord, Gemini, Qwen, GPT-SoVITS, AIRI components, SQLite, and Live2D are replaceable capabilities around that character.

That architectural boundary is more important than any individual model optimization.
