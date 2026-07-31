Yes. With Japanese + English + Mandarin as hard requirements, I would **change the STT choice from Parakeet to Qwen3-ASR**.

For your machine and this Discord workload, my recommended first build is:

```text
Discord voice
   ↓
existing AIRI @discordjs/voice receiver
   ↓
existing AIRI OpusDecoder → PCM16 / 16 kHz / mono
   ↓
per-user utterance segmentation
   ↓
Qwen3-ASR-0.6B locally on RTX 5060 Ti
   ↓
language + transcript
   ↓
Gemini API
   ↓
GPT-SoVITS local /tts API
   ↓
existing AIRI Discord audio playback
```

And my recommendation regarding AIRI is:

> **Reuse AIRI's Discord implementation, but leave the full AIRI WebSocket/server wrapper out of the voice hot path.**

I would **not** start a new Discord bot project from scratch, and I would also **not** send every voice turn through `AIRI server → AIRI agent → back to Discord`. Instead, refactor `services/discord-bot` so its Discord transport is reusable and plug Qwen/Gemini/GPT-SoVITS directly into it.

Keep the possibility of an AIRI backend behind an interface, so you can re-enable AIRI's full character/memory/UI stack later.

---

# 1. STT choice: Qwen3-ASR

Parakeet was the better recommendation when the requirement looked English-centric. It is no longer my choice with:

* English
* Japanese
* Mandarin Chinese

Qwen3-ASR-0.6B and 1.7B both natively support Chinese, English, Japanese, automatic language identification, offline inference and streaming inference. Qwen's current package also accepts `(numpy array, sample rate)` directly, so your decoded Discord PCM does not fundamentally need to become a disk file. ([GitHub][1])

Its language detection is useful here because you don't have to tell the bot:

```text
this user is speaking Japanese now
```

You can simply use:

```python
language=None
```

and Qwen returns both:

```python
result.language
result.text
```

The official API exposes exactly this behavior. ([GitHub][1])

Qwen's reported multilingual benchmarks include Japanese in CommonVoice, MLC-SLM and Fleurs. In Qwen's own evaluation, the 1.7B substantially outperforms Whisper-large-v3 on several multilingual aggregate benchmarks, while the 0.6B gives a smaller/faster accuracy tradeoff. Their reported language-identification averages are 96.8% for 0.6B and 97.9% for 1.7B versus 94.1% for Whisper-large-v3. Treat those figures as vendor-reported benchmarks, but they are compelling enough to make Qwen the first model I'd test for this use case. ([GitHub][1])

### Start with 0.6B, not 1.7B

Use:

```text
Qwen/Qwen3-ASR-0.6B
```

first.

Your GPU also has to host GPT-SoVITS, so there is little reason to consume additional VRAM before you know you need the 1.7B accuracy improvement.

Have Codex make this configurable:

```env
ASR_MODEL=Qwen/Qwen3-ASR-0.6B
```

Then testing the larger model should be a one-line change:

```env
ASR_MODEL=Qwen/Qwen3-ASR-1.7B
```

Qwen reports a measurable offline/streaming accuracy difference: its 0.6B aggregate in the listed streaming comparison moves from 3.48 offline to 4.40 streaming, while 1.7B moves from 2.69 to 3.33. This is another reason to start with **complete-utterance offline inference** rather than immediately setting up vLLM streaming. ([GitHub][1])

Also, Qwen's current implementation only exposes streaming through its vLLM backend, whereas the ordinary Transformers backend supports straightforward offline inference. ([GitHub][1])

For v1:

> **Qwen3-ASR-0.6B + Transformers backend + completed utterances.**

Not vLLM.

---

# 2. AIRI: what should actually be reused?

Quite a lot.

The current AIRI `services/discord-bot` already has the hard Discord plumbing:

```text
services/discord-bot/
```

with dependencies for Discord.js, `@discordjs/voice`, Opus decoding, libsodium/DAVE voice support, logging and audio utilities. 

Its current voice manager already does:

```text
/summon
    ↓
joinVoiceChannel()
    ↓
selfDeaf: false
    ↓
receiver.speaking.start/end
    ↓
receiver.subscribe(userId)
    ↓
OpusDecoder(16000, 1)
    ↓
PCM audio
```

and contains reconnect handling and human-speaking-during-bot-output detection. 

**Keep all of those concepts.**

In particular, reuse:

* Discord client initialization.
* slash command registration.
* `/summon`.
* voice-channel joining.
* Discord receive connection.
* per-user voice subscriptions.
* `OpusDecoder`.
* 16 kHz mono decode.
* guild/member metadata.
* non-bot speaker filtering.
* voice connection reconnection.
* existing audio-player machinery.
* existing barge-in/volume work as a starting point.

Do not rewrite Discord's voice protocol yourself.

---

# 3. What I would remove from the hot path

The current architecture is:

```text
Discord
 ↓
AIRI DiscordAdapter
 ↓
VoiceManager
 ↓
OpenAI-compatible STT
 ↓
AIRI WebSocket ServerChannel
 ↓
AIRI agent
 ↓
output event
 ↓
DiscordAdapter
```

`src/index.ts` currently creates `DiscordAdapter` with `AIRI_URL`, defaulting to `ws://localhost:6121/ws`. 

`DiscordAdapter` then creates a `ServerChannel` and declares AIRI events such as:

```text
input:text
input:text:voice
output:gen-ai:chat:message
```



That layer is useful when Discord is supposed to be **one frontend attached to the whole AIRI ecosystem**.

It isn't required to make your Discord voice bot work.

---

# 4. Why I recommend bypassing the AIRI server wrapper

Your desired hot path is very straightforward:

```text
Qwen → Gemini → GPT-SoVITS
```

Adding:

```text
Qwen
 ↓
AIRI websocket
 ↓
AIRI server event model
 ↓
AIRI provider abstraction
 ↓
Gemini
 ↓
AIRI output event
 ↓
Discord process
 ↓
GPT-SoVITS
```

doesn't solve an immediate problem.

It introduces another process, another transport protocol, event schemas and more failure states.

More importantly, the current AIRI Discord adapter's `output:gen-ai:chat:message` handler is wired to send generated responses into **Discord text channels**. I don't see current wiring there that takes that AIRI output and calls `VoiceManager.playAudioStream()`. The voice manager has playback support, but it is a separate method. 

You would therefore still have to create that glue.

At that point, direct orchestration is cleaner.

---

# 5. But don't throw away AIRI's agent work

There is a useful middle ground.

AIRI now has:

```text
@proj-airi/core-agent
```

and the project explicitly describes its chat orchestrator as **platform-agnostic**. It provides session history, contexts, FIFO send queues, provider-independent LLM streaming and hooks without requiring Vue/Pinia. 

Its public package exports `createChatOrchestratorRuntime`, its context registry, response categorization, session helpers and LLM infrastructure. 

So I would architect your code so that later you can choose between:

```text
BrainProvider
 ├─ GeminiBrainProvider        ← build now
 └─ AiriCoreBrainProvider      ← optional later
```

I would **not integrate `core-agent` in milestone 1**.

First get:

```text
voice → ASR → Gemini → TTS → voice
```

working.

Then decide whether AIRI's session/context/personality system gives you something you want.

---

# 6. When full AIRI *would* be worth retaining

Keep the AIRI server wrapper if your intended end state is:

```text
               AIRI character
                    │
          ┌─────────┼─────────┐
          ▼         ▼         ▼
        Discord    Web UI    Games
                    │
                 Live2D
                    │
              memories/tools
```

In other words, use full AIRI if you want:

* the same character state across AIRI Stage and Discord;
* AIRI's UI configuration;
* AIRI memory system;
* AIRI contexts;
* AIRI tools;
* Minecraft/Factorio integrations;
* shared sessions between multiple platforms;
* AIRI's character/persona system.

AIRI already supports Gemini as an LLM provider. ([GitHub][2])

For a Discord-first agent with your own Gemini/TTS configuration:

> **Full wrapper: leave it off.**

---

# 7. Don't use unSpeech for GPT-SoVITS

AIRI advertises `unspeech`, but that project's current README describes its providers as **online TTS services** and specifically redirects users elsewhere when they need local TTS. GPT-SoVITS is not one of its listed backends. ([GitHub][3])

GPT-SoVITS already gives you the local API you need.

Its official `api_v2.py` exposes:

```text
POST http://127.0.0.1:9880/tts
```

with:

```text
text
text_lang
ref_audio_path
prompt_text
prompt_lang
streaming_mode
media_type
...
```

and returns audio directly. ([GitHub][4])

It already supports English, Japanese and Chinese, including mixed-language text handling in the project. ([GitHub][5])

So:

```text
Gemini
 ↓
GPT-SoVITS HTTP API
 ↓
Discord AudioPlayer
```

No middle TTS proxy.

---

# 8. Final target architecture

I would give Codex this as the architecture contract:

```text
┌─────────────────────────────────────────────────────┐
│                    Discord                          │
│                                                     │
│ Alice ─────┐                                        │
│ Bob ───────┼── per-user Discord voice streams       │
│ Chen ──────┘                                        │
└────────────────────────┬────────────────────────────┘
                         │
                         ▼
              AIRI Discord VoiceManager
                         │
                  OpusDecoder
                         │
               PCM16 / 16k / mono
                         │
              per-user segmentation
                         │
                         ▼
             ┌───────────────────────┐
             │ Local ASR service     │
             │ Qwen3-ASR-0.6B       │
             │ CUDA                  │
             └──────────┬────────────┘
                        │
                 language + text
                        │
                        ▼
             ConversationController
                        │
              one queue per guild
                        │
                        ▼
              GeminiBrainProvider
                        │
              Gemini streaming API
                        │
                        ▼
                 speech chunker
                        │
                        ▼
             GPTSoVitsTtsProvider
                        │
            localhost:9880 /tts
                        │
                        ▼
             Discord playback queue
                        │
                        ▼
                  voice channel
```

And the process separation:

```text
Process 1
Node.js
services/discord-bot

Process 2
Python
services/qwen3-asr

Process 3
Python
GPT-SoVITS api_v2.py

External
Gemini API
```

This is the architecture I would build.

---

# 9. Critical refactor before adding models

There is one AIRI implementation detail I would fix first.

The current `VoiceManager` has a single global:

```ts
processingVoice
transcriptionTimeout
```

while audio buffers themselves are per-user. 

Then after one transcription completes it clears every user's accumulated buffers. 

That means its current model isn't ideal for:

```text
Alice talking
Bob talking simultaneously
```

which is normal in Discord.

Do **not** build the new system on top of those globals.

---

# 10. State model Codex should implement

Use:

```ts
interface GuildVoiceSession {
  guildId: string
  channelId: string

  connection: VoiceConnection

  users: Map<string, UserCaptureSession>

  conversationQueue: AsyncQueue<ConversationTurn>

  activeGeneration?: AbortController
  activeTts?: AbortController
  activeAudioPlayer?: AudioPlayer
}
```

Per user:

```ts
interface UserCaptureSession {
  userId: string
  displayName: string

  pcmChunks: Buffer[]
  totalBytes: number

  speechStartedAt: number
  lastPacketAt: number

  finalizeTimer?: NodeJS.Timeout
  state: 'idle' | 'speaking' | 'finalizing'
}
```

Never have:

```ts
global processingVoice
```

across guilds or users.

---

# 11. Internal provider contracts

Codex should define these **before** implementing providers.

### ASR

```ts
interface AsrResult {
  text: string
  language: 'zh' | 'en' | 'ja' | string
  inferenceMs: number
}

interface AsrProvider {
  transcribe(input: {
    wav: Buffer
    sampleRate: 16000
  }): Promise<AsrResult>
}
```

### LLM

```ts
interface BrainTurn {
  guildId: string
  userId: string
  userName: string
  language: string
  text: string
}

interface BrainProvider {
  generate(
    turn: BrainTurn,
    signal: AbortSignal
  ): AsyncIterable<string>
}
```

### TTS

```ts
interface TtsRequest {
  text: string
  language: 'zh' | 'en' | 'ja'
}

interface TtsProvider {
  synthesize(
    request: TtsRequest,
    signal: AbortSignal
  ): Promise<NodeJS.ReadableStream>
}
```

This is important.

None of the Discord classes should know:

```text
Qwen
Gemini
GPT-SoVITS
```

by name.

They know interfaces.

---

# 12. Codex subagent strategy

This is how I would divide the task for good context performance.

Do **not** give every subagent the entire AIRI repository.

Each specialist gets:

1. the global architecture contract;
2. the interfaces relevant to it;
3. only relevant source files;
4. a strict expected output.

## Subagent A — Repository Cartographer

**Context**

Give it:

```text
package.json
pnpm-workspace.yaml
services/discord-bot/**
packages/audio/**
packages/core-agent/src/index.ts
packages/core-agent/src/runtime/chat-orchestrator-runtime.ts
```

Do not give model/TTS documentation yet.

**Task**

Read the user's actual local AIRI HEAD.

Produce:

```text
docs/discord-bot-reuse-map.md
```

containing:

* current commit hash;
* existing Discord file tree;
* command registration path;
* Discord login path;
* voice join path;
* voice receive path;
* Opus decode path;
* audio playback path;
* current AIRI ServerChannel coupling;
* dependencies safe to reuse;
* files to modify;
* files explicitly not to modify.

**Rule**

No code changes from this agent.

This is the first Codex task because your local clone may differ from the upstream main branch I inspected.

---

# 13. Subagent B — Discord Voice Transport

Give it only:

```text
services/discord-bot/src/bots/discord/**
services/discord-bot/src/constants/audio*
services/discord-bot/src/utils/audio*
services/discord-bot/src/utils/opus*
services/discord-bot/package.json
```

plus Cartographer's reuse map.

### Responsibility

Only:

```text
Discord ↔ raw audio
```

No Gemini.

No Qwen.

No GPT-SoVITS.

No AIRI agent logic.

### Tasks

Refactor `VoiceManager` so that:

```text
VoiceManager
   emits completed utterances
```

rather than directly calling:

```ts
openaiTranscribe(...)
airiClient.send(...)
```

Add something like:

```ts
voiceManager.on('utterance', handler)
```

with:

```ts
interface VoiceUtterance {
  guildId: string
  channelId: string
  userId: string
  displayName: string

  pcm: Buffer
  sampleRate: 16000
  channels: 1

  startedAt: number
  endedAt: number
}
```

---

# 14. Utterance endpointing

First implementation:

```text
Discord speaking starts
      ↓
subscribe(userId)
      ↓
decode continuously
      ↓
Discord speaking stops
      ↓
start ~650 ms finalize timer
      ↓
if speaking resumes:
    cancel timer
      ↓
otherwise:
    finalize utterance
```

Recommended initial values:

```env
VOICE_END_SILENCE_MS=650
VOICE_MIN_UTTERANCE_MS=250
VOICE_MAX_UTTERANCE_MS=30000
```

Later this can become adaptive.

Do not use AIRI's current global 1500 ms transcription timeout. It's both too global and relatively sluggish for conversational use. 

---

# 15. VAD policy

I would **not block milestone 1 on integrating Silero**.

Discord already tells the bot which user is speaking, and AIRI already receives speaking start/end events.

For milestone 2, add Silero as an extra endpointing/validation layer if testing shows:

* keyboard noise triggers turns;
* fans/music produce fake turns;
* users pause frequently;
* Discord speaking events are unreliable.

Silero's current VAD supports streaming use, 8/16 kHz input and thousands of languages, and is intended for voice-bot use. ([GitHub][6])

Your existing 16 kHz pipeline aligns perfectly with it.

---

# 16. Subagent C — Qwen ASR service

Give this subagent:

* the `AsrProvider` interface;
* Qwen3-ASR official API snippets;
* expected Discord audio format;
* no Discord implementation files.

Create:

```text
services/qwen3-asr/
├── pyproject.toml
├── README.md
├── app/
│   ├── __init__.py
│   ├── config.py
│   ├── model.py
│   ├── schemas.py
│   └── server.py
└── tests/
```

### Runtime

Start with:

```text
Python 3.12
qwen-asr
Transformers backend
Qwen/Qwen3-ASR-0.6B
CUDA
BF16 when supported
batch size 1
```

Qwen currently recommends an isolated Python 3.12 environment and `pip install -U qwen-asr`; its Transformers backend is sufficient for the offline inference we want. ([GitHub][1])

---

# 17. Qwen service endpoint

Use:

```http
POST /v1/transcribe
Content-Type: audio/wav
```

Body:

```text
16 kHz
mono
PCM16 WAV
```

Response:

```json
{
  "text": "今日は何をしますか？",
  "language": "ja",
  "audio_ms": 2140,
  "inference_ms": 83,
  "model": "Qwen/Qwen3-ASR-0.6B"
}
```

Also expose:

```http
GET /health
```

returning:

```json
{
  "ready": true,
  "device": "cuda:0",
  "model": "Qwen/Qwen3-ASR-0.6B"
}
```

Do not expose this externally.

Bind:

```text
127.0.0.1
```

only.

---

# 18. Qwen inference rules

ASR subagent must:

* load model exactly once at startup;
* never load per request;
* use `language=None`;
* return Qwen's detected language;
* normalize Qwen language output into BCP-ish internal codes:

```text
Chinese  → zh
English  → en
Japanese → ja
```

* reject empty/very short audio;
* set a 30-second maximum;
* serialize GPU inference initially;
* measure inference latency.

Do **not** add the ForcedAligner.

You already know who spoke because Discord gives you the user ID, and you don't need word timestamps for an assistant. The aligner would simply consume more GPU memory.

---

# 19. ASR Node client

Add:

```text
services/discord-bot/src/providers/asr/
├── types.ts
└── qwen-http.ts
```

The provider sends the in-memory WAV buffer to:

```env
ASR_BASE_URL=http://127.0.0.1:8765
```

No temporary files.

No OpenAI transcription API.

The current AIRI `pipelines/tts.ts` has both an old local Transformers Whisper path and an OpenAI-compatible `openaiTranscribe()` path. Neither is the one I'd retain for this build. 

Once Qwen works, remove those dependencies only if repo usage analysis confirms they're unused elsewhere.

---

# 20. Subagent D — Gemini brain

Give this agent:

```text
BrainProvider interface
ConversationTurn interface
session semantics
system prompt requirements
```

and no audio internals.

Use Google's current:

```text
@google/genai
```

SDK.

Google's current Node example initializes `GoogleGenAI` and supports `generateContentStream()`, so use streaming from the beginning. ([Google AI for Developers][7])

Make model configurable:

```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.6-flash
```

Do not scatter the model string through source.

---

# 21. Gemini conversation model

Use one logical session per guild:

```text
discord-guild-{guildId}
```

That's actually a good idea already present in AIRI's Discord architecture.

Conversation history should identify the human speaker:

```text
Alice: Could you explain this?

Yuki: 日本語で説明して。

Chen: 用中文总结一下。
```

Do **not** create one Gemini conversation per Discord user.

Everyone in the voice channel should be talking to the same bot with the same room context.

---

# 22. Initial memory policy

For v1, don't build a database.

Use bounded in-memory history:

```ts
Map<guildId, ConversationHistory>
```

with perhaps:

```text
last 24 user/assistant messages
```

or a token budget.

Why?

Because persistent memory is independent from proving the voice loop.

Later either:

```text
AIRI core-agent
```

or a database can own persistent sessions.

---

# 23. Gemini system prompt contract

Tell Codex to include these rules:

```text
You are participating in a Discord voice conversation.

You may receive English, Japanese, or Mandarin Chinese.

Reply primarily in the language used by the most recent speaker unless:
- they explicitly request another language;
- context clearly requires another language.

Responses will be spoken aloud through TTS.
Prefer natural spoken language.
Avoid markdown tables.
Avoid long lists unless requested.
Avoid URLs unless necessary.
Avoid markdown formatting that sounds unnatural when spoken.
Keep ordinary conversational answers concise.
```

Crucially:

> Let Gemini answer in the user's language.

That way the ASR language doesn't rigidly dictate output if someone says:

```text
"Explain that in Japanese."
```

---

# 24. Gemini output needs a speech chunker

Do not wait for Gemini's entire response before starting TTS.

But also don't send every Gemini token to GPT-SoVITS.

Build:

```text
Gemini tokens
 ↓
SpeechChunker
 ↓
sentence / clause
 ↓
GPT-SoVITS
```

For example:

```text
Gemini:
"Sure. Transformers use attention to..."

SpeechChunker:
1. "Sure."
2. "Transformers use attention to..."
```

Then synthesize chunk 1 while Gemini is generating chunk 2.

This is where much of the perceived latency improvement will come from.

---

# 25. Multilingual speech chunking rules

The chunker must understand:

```text
English:
. ? !

Japanese:
。？！ 

Chinese:
。？！
```

Use punctuation boundaries plus minimum/maximum text sizes.

Suggested initial behavior:

```text
emit on terminal punctuation
OR
emit around 60–100 characters if no punctuation appears
```

Don't split blindly every N characters.

---

# 26. Subagent E — GPT-SoVITS integration

Give it only:

* `TtsProvider`;
* GPT-SoVITS API documentation;
* Discord player's expected stream format.

The current GPT-SoVITS API can run locally on port 9880 and its `/tts` endpoint supports `text_lang`, reference audio, prompt language, WAV/raw output and multiple streaming modes. ([GitHub][4])

Configuration:

```env
GPT_SOVITS_URL=http://127.0.0.1:9880

GPT_SOVITS_REF_AUDIO=...
GPT_SOVITS_PROMPT_TEXT=...
GPT_SOVITS_PROMPT_LANG=ja

GPT_SOVITS_STREAMING_MODE=1
```

Don't hardcode the voice reference.

---

# 27. Language mapping to GPT-SoVITS

Internal:

```ts
'zh'
'en'
'ja'
```

maps directly to GPT-SoVITS's supported language codes. Its project documentation explicitly defines `zh`, `ja`, and `en`. ([GitHub][8])

For mixed-language Gemini output, GPT-SoVITS has support for Chinese-English, Japanese-English and mixed Chinese/Japanese/English text processing. ([GitHub][9])

Still, don't assume ASR language equals TTS language.

Implement:

```ts
detectTextLanguageForTts(text)
```

or use a mixed-language mode if the installed GPT-SoVITS version exposes one.

The TTS subagent should inspect the **actual installed GPT-SoVITS version/config** before selecting the appropriate `text_lang` value.

---

# 28. TTS implementation stages

First:

```text
streaming_mode = 0
media_type = wav
```

Get correctness working.

Then benchmark:

```text
0 = complete synthesis
1 = quality-first fragments
2 = streaming
3 = fastest/lower-quality streaming
```

Those modes are defined by the current API. ([GitHub][4])

I'd expect mode `1` or `2` to be the interesting conversational setting, but let actual 5060 Ti measurements decide.

---

# 29. Reuse AIRI playback

The existing `VoiceManager.playAudioStream()` already:

* creates an `AudioPlayer`;
* subscribes the Discord voice connection;
* builds an audio resource;
* plays a readable stream;
* handles idle state. 

Have the voice transport agent retain/refactor that.

Don't write another playback stack unnecessarily.

Make it guild-oriented instead of user-oriented:

```ts
playAudioStream(guildId, stream)
```

not:

```ts
playAudioStream(userId, stream)
```

because the output belongs to a Discord voice connection, not to the particular user who caused the response.

---

# 30. Subagent F — Conversation Controller

This subagent receives **summaries/interfaces** from B, C, D and E.

It does not get all their implementation context.

Create:

```text
services/discord-bot/src/orchestration/
├── conversation-controller.ts
├── guild-session.ts
├── speech-chunker.ts
└── turn-queue.ts
```

Its pipeline:

```ts
onUtterance(utterance)
    ↓
asr.transcribe()
    ↓
queue GuildTurn
    ↓
brain.generate()
    ↓
SpeechChunker
    ↓
tts.synthesize()
    ↓
voice.play()
```

---

# 31. One LLM response at a time per guild

This matters.

If Alice and Bob overlap:

```text
Alice finishes at 10.00
Bob finishes at   10.30
```

ASR can run independently.

But don't allow:

```text
Gemini response A
Gemini response B
```

to simultaneously talk over each other.

Use:

```text
one conversation generation queue / guild
```

AIRI's own `core-agent` uses FIFO send queues for this same general reason. 

---

# 32. Barge-in behavior

AIRI already contains a rudimentary mechanism: while the bot has an active audio player, decoded human PCM amplitude is monitored and playback is stopped after sustained volume exceeds a threshold. 

Preserve the idea, but move control to `ConversationController`.

When a human genuinely starts talking:

```text
Human speech
   ↓
stop Discord audio player
   ↓
AbortController.abort() current TTS
   ↓
optionally abort current Gemini generation
   ↓
continue capturing human
   ↓
ASR
   ↓
new turn
```

I recommend **aborting TTS immediately** but allowing the LLM generation to be aborted once the human utterance is finalized, rather than on the first noise packet.

This avoids keyboard clicks killing useful Gemini work.

---

# 33. Context strategy for Codex agents

This is important for the "optimal context performance" part.

Give every subagent a shared file:

```text
docs/discord-voice-architecture.md
```

Maximum roughly 2–4 pages.

It should contain only:

* target architecture;
* provider interfaces;
* audio contract;
* concurrency contract;
* language requirements;
* environment variables;
* non-goals.

Then agent-specific context.

Don't repeatedly inject:

```text
the whole AIRI monorepo
+
Qwen docs
+
Gemini docs
+
GPT-SoVITS repo
```

into every agent.

---

# 34. Context matrix

| Agent           | AIRI code               | Qwen docs  | Gemini docs | GPT-SoVITS docs |
| --------------- | ----------------------- | ---------- | ----------- | --------------- |
| Cartographer    | Relevant repo           | No         | No          | No              |
| Voice transport | Discord/audio only      | No         | No          | No              |
| ASR             | Audio contract only     | Yes        | No          | No              |
| Gemini          | Interfaces/history only | No         | Yes         | No              |
| TTS             | Playback contract       | No         | No          | Yes             |
| Controller      | Interfaces + summaries  | No         | Minimal     | Minimal         |
| QA/perf         | All public interfaces   | Test facts | Test facts  | Test facts      |

That's much better than seven agents repeatedly digesting thousands of unrelated lines.

---

# 35. Context handoff format

Make each agent finish by writing a concise:

```text
docs/handoffs/<agent>.md
```

with exactly:

```text
Files changed
Public interfaces
Configuration added
Assumptions
Known issues
Tests run
Integration instructions
```

The integration agent reads these handoffs.

It should **not** need each subagent's entire reasoning history.

---

# 36. Subagent G — QA and performance

This agent should run after integration.

Create fixtures:

```text
test/fixtures/asr/en.wav
test/fixtures/asr/ja.wav
test/fixtures/asr/zh.wav
```

with known transcripts.

Test:

### ASR

```text
English
Japanese
Mandarin
```

### switching

```text
Alice English
Alice Japanese
Alice Mandarin
```

### multiple speakers

```text
Alice speaking
Bob interrupts
```

### overlapping speech

Both clean Discord streams should remain independent.

### silence

No Gemini call.

### keyboard/noise

No Gemini call where possible.

### interruption

Bot audio stops and accepts human turn.

### reconnect

Voice connection restores cleanly.

---

# 37. Instrument every stage

Every conversation turn should have a `turnId`.

Log:

```text
turnId
guildId
userId

audioDurationMs

endpointDelayMs

asrMs
asrLanguage

geminiFirstTokenMs
geminiCompleteMs

ttsFirstAudioMs
ttsCompleteMs

playbackStartedMs

totalUserStopToAudioMs
```

Do not optimize from intuition.

Optimize the biggest measured delay.

---

# 38. Initial latency goals

Use these as engineering goals, not promises:

```text
speech end detection       500–750 ms
ASR                         <300 ms desirable
Gemini first useful text    <1000 ms desirable
first TTS audio             <750 ms desirable
```

The key UX metric:

```text
USER STOPS SPEAKING
        ↓
BOT STARTS MAKING SOUND
```

Aim eventually for roughly:

```text
~1–2 seconds
```

under normal conditions.

Do not fail a test just because a network request occasionally exceeds this; record distributions.

---

# 39. GPU profiling gate

Before trying 1.7B, QA should capture:

```text
idle VRAM

GPT-SoVITS loaded VRAM

Qwen 0.6B loaded VRAM

both loaded VRAM

Qwen transcription peak

GPT-SoVITS synthesis peak
```

Use `nvidia-smi` / PyTorch memory statistics.

Then:

### If plenty remains

Benchmark:

```text
Qwen3-ASR-1.7B
```

### If close to OOM

Stay:

```text
0.6B
```

Do not unload/reload the ASR model every conversation turn. That will destroy latency.

---

# 40. Environment contract

Have Codex create:

```text
services/discord-bot/.env.example
```

roughly:

```env
# Discord
DISCORD_TOKEN=

# Runtime
BOT_BACKEND=direct

# ASR
ASR_BASE_URL=http://127.0.0.1:8765
ASR_REQUEST_TIMEOUT_MS=15000
VOICE_END_SILENCE_MS=650
VOICE_MIN_UTTERANCE_MS=250
VOICE_MAX_UTTERANCE_MS=30000

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.6-flash

# GPT-SoVITS
GPT_SOVITS_URL=http://127.0.0.1:9880
GPT_SOVITS_REF_AUDIO=
GPT_SOVITS_PROMPT_TEXT=
GPT_SOVITS_PROMPT_LANG=ja
GPT_SOVITS_STREAMING_MODE=0

# Conversation
CONVERSATION_MAX_MESSAGES=24

# Optional legacy AIRI
AIRI_URL=ws://localhost:6121/ws
AIRI_TOKEN=
```

Do not commit real tokens.

Google's current Gemini documentation uses `@google/genai` and currently shows `gemini-3.6-flash` in its Node streaming example, but making the model an environment setting prevents this fast-moving detail from becoming architectural. ([Google AI for Developers][7])

---

# 41. Proposed file structure after refactoring

I would aim for:

```text
services/discord-bot/
└── src/
    ├── index.ts
    │
    ├── adapters/
    │   ├── discord-adapter.ts
    │   └── airi-adapter.ts          # optional legacy/full-AIRI mode
    │
    ├── bots/discord/
    │   └── commands/
    │       ├── index.ts
    │       └── summon.ts
    │
    ├── voice/
    │   ├── voice-manager.ts
    │   ├── guild-voice-session.ts
    │   └── types.ts
    │
    ├── providers/
    │   ├── asr/
    │   │   ├── types.ts
    │   │   └── qwen-http.ts
    │   │
    │   ├── brain/
    │   │   ├── types.ts
    │   │   └── gemini.ts
    │   │
    │   └── tts/
    │       ├── types.ts
    │       └── gpt-sovits.ts
    │
    ├── orchestration/
    │   ├── conversation-controller.ts
    │   ├── guild-session.ts
    │   ├── speech-chunker.ts
    │   └── turn-queue.ts
    │
    ├── constants/
    └── utils/

services/qwen3-asr/
├── pyproject.toml
├── README.md
├── app/
│   ├── config.py
│   ├── model.py
│   ├── server.py
│   └── schemas.py
└── tests/
```

But the Cartographer subagent should adjust this based on your actual local AIRI HEAD rather than mechanically moving files.

---

# 42. Codex execution order

Tell Codex **not to parallelize everything immediately**.

The dependency graph should be:

```text
        Cartographer
             │
             ▼
      Architecture contract
             │
      ┌──────┼──────┐
      ▼      ▼      ▼
    Voice   ASR    Gemini
      │      │      │
      │      │      ▼
      │      │      TTS
      │      │      │
      └──────┼──────┘
             ▼
        Controller
             │
             ▼
         Integration
             │
             ▼
         QA / Perf
```

After the architecture contract exists, Voice/ASR/Gemini/TTS can largely run independently.

---

# 43. Codex phase 0 — inspect before touching

Give Codex this exact instruction:

```text
Before modifying any source, inspect the actual checked-out AIRI commit.

Record:
- git rev-parse HEAD
- git status
- services/discord-bot file tree
- current discord-bot package.json
- current VoiceManager implementation
- current DiscordAdapter implementation
- current audio/Opus utilities
- current command registration
- whether my checkout differs materially from upstream assumptions in the architecture brief.

Do not overwrite uncommitted user changes.
Do not reset, clean, stash or checkout user files.
```

Very important because I can inspect upstream AIRI, but **I cannot see your local working tree from this conversation**.

Codex can.

---

# 44. Phase 1 acceptance test — Discord only

Before Qwen/Gemini/TTS:

```text
/summon
 ↓
bot joins
 ↓
Alice speaks
 ↓
console:
[utterance]
guild = ...
user = Alice
duration = 2114ms
bytes = ...
```

Save nothing permanently.

Optionally in dev mode allow:

```env
DEBUG_DUMP_AUDIO=true
```

to dump a WAV for manual listening.

Default false.

---

# 45. Phase 2 acceptance test — Qwen

Expected logs:

```text
Alice utterance: 2.1 s
ASR language: en
ASR: "What should we build today?"

Yuki utterance: 3.0 s
ASR language: ja
ASR: "今日は何を作りますか？"

Chen utterance: 2.6 s
ASR language: zh
ASR: "我们今天做什么？"
```

No Gemini yet.

This lets you judge ASR independently.

---

# 46. Phase 3 acceptance test — Gemini

Still no TTS.

```text
voice
 ↓
Qwen
 ↓
Gemini
 ↓
Discord text/log
```

Confirm:

* Japanese → natural Japanese.
* Mandarin → natural Mandarin.
* English → English.
* explicit language requests work.
* shared guild history works.

---

# 47. Phase 4 acceptance test — GPT-SoVITS

Independent test command:

```text
/voice-test language:ja text:"こんにちは。"
```

or an internal developer script.

Verify:

```text
Gemini text
 ↓
GPT-SoVITS
 ↓
audio played in Discord
```

Do not debug ASR at the same time.

---

# 48. Phase 5 — whole loop

Only after each component independently passes:

```text
Human
 ↓
Discord
 ↓
Qwen
 ↓
Gemini
 ↓
GPT-SoVITS
 ↓
Discord
```

Then start optimizing latency.

---

# 49. Phase 6 — streaming TTS

Once baseline is reliable:

```text
Gemini generateContentStream()
             │
             ▼
       sentence chunker
             │
       ┌─────┴───────┐
       ▼             ▼
    chunk 1        chunk 2
       │
      TTS
       │
    playback
```

Don't make Qwen streaming at the same time.

Change **one latency layer at a time**.

---

# 50. Phase 7 — optional ASR streaming

Only investigate Qwen's streaming mode after everything else works.

It currently requires Qwen's vLLM backend and lacks timestamp output in streaming mode. ([GitHub][1])

It becomes useful if you later want:

* live captions;
* semantic endpointing;
* instant command detection;
* "stop"/"wait" recognition before utterance completion;
* speculative Gemini generation.

For a first Discord assistant, it is unnecessary complexity.

---

# 51. Phase 8 — optional AIRI core integration

After the direct bot works, make an explicit decision.

If you want AIRI memory/persona/context:

```text
BrainProvider
       │
       ├── GeminiBrainProvider
       │
       └── AiriCoreBrainProvider
```

At this point evaluate `createChatOrchestratorRuntime`.

It already provides platform-agnostic session persistence interfaces, context snapshots, FIFO queuing, prompt composition and LLM streaming hooks. 

This is a much cleaner later integration than making your first voice prototype depend on the AIRI WebSocket server.

---

# 52. Things Codex should explicitly NOT do

Put this in the project brief:

```text
DO NOT:
- create a new Discord bot from scratch;
- implement Discord RTP/Opus protocols manually;
- mix users' audio before ASR;
- add speaker diarization;
- use WhisperX;
- use pyannote;
- send local audio to cloud STT;
- add unSpeech for GPT-SoVITS;
- add Qwen ForcedAligner;
- implement Qwen streaming in milestone 1;
- put ASR inside the Node process;
- reload Qwen per utterance;
- reload GPT-SoVITS per response;
- run multiple Gemini responses concurrently in one guild;
- hardcode API keys;
- hardcode GPT-SoVITS reference paths;
- destroy existing AIRI adapter functionality unless necessary;
- overwrite unrelated local modifications.
```

---

# 53. Definition of done for v1

Codex shouldn't declare the project done until all of these work:

* `/summon` joins a voice channel.
* `/leave` leaves cleanly.
* Two users can be captured independently.
* Bot doesn't transcribe itself.
* English transcription works.
* Japanese transcription works.
* Mandarin transcription works.
* Qwen automatically identifies all three.
* empty/noise utterances do not invoke Gemini.
* Gemini receives speaker name and shared guild history.
* Gemini responds in appropriate language.
* GPT-SoVITS speaks English.
* GPT-SoVITS speaks Japanese.
* GPT-SoVITS speaks Mandarin.
* TTS output reaches Discord.
* human speech can interrupt bot playback.
* voice disconnect/reconnect doesn't leak streams.
* no global transcription timer exists.
* one guild cannot block another guild.
* logs contain stage latency.
* clean shutdown closes Discord and outstanding HTTP requests.
* `pnpm ... typecheck` for the Discord service passes.
* ASR service tests pass.

---

## My final architecture choice

I would build **inside your AIRI checkout**, because there is already substantial Discord work worth keeping.

But I would organize it like this:

```text
AIRI repository
│
├── services/discord-bot     ← REUSE heavily
│
│   Discord login            ← keep
│   commands                 ← keep
│   voice connections        ← keep
│   Opus decoding            ← keep
│   PCM extraction           ← keep
│   playback                 ← keep/refactor
│
├── services/qwen3-asr       ← ADD
│
└── AIRI server wrapper      ← OPTIONAL, not hot path
```

The direct runtime becomes:

```text
AIRI's Discord transport
        ↓
Qwen3-ASR-0.6B local
        ↓
Gemini API
        ↓
GPT-SoVITS local
        ↓
AIRI's Discord playback
```

**That is the version I'd have Codex build first.**

The most important architectural change is not the model selection—it is **turning AIRI's `VoiceManager` into a transport component instead of letting it know about AIRI ServerChannel or STT**. Once you do that, Qwen/Gemini/GPT-SoVITS become replaceable providers, AIRI can be reattached later, and the Discord-specific code that AIRI has already solved remains useful rather than being rewritten. 

[1]: https://github.com/QwenLM/Qwen3-ASR/blob/main/README.md "Qwen3-ASR/README.md at main · QwenLM/Qwen3-ASR · GitHub"
[2]: https://github.com/moeru-ai/airi/blob/main/README.md?utm_source=chatgpt.com "airi/README.md at main · moeru-ai/airi · GitHub"
[3]: https://raw.githubusercontent.com/moeru-ai/unspeech/main/README.md "raw.githubusercontent.com"
[4]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py?utm_source=chatgpt.com "GPT-SoVITS/api_v2.py at main · RVC-Boss/GPT-SoVITS · GitHub"
[5]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/README.md?utm_source=chatgpt.com "GPT-SoVITS/README.md at main · RVC-Boss/GPT-SoVITS · GitHub"
[6]: https://github.com/snakers4/silero-vad/wiki/Version-history-and-Available-Models?utm_source=chatgpt.com "Version history and Available Models · snakers4/silero-vad Wiki · GitHub"
[7]: https://ai.google.dev/api/generate-content?utm_source=chatgpt.com "Generating content  |  Gemini API  |  Google AI for Developers"
[8]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/docs/cn/README.md?utm_source=chatgpt.com "GPT-SoVITS/docs/cn/README.md at main · RVC-Boss/GPT-SoVITS · GitHub"
[9]: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/docs/en/Changelog_EN.md?utm_source=chatgpt.com "GPT-SoVITS/docs/en/Changelog_EN.md at main · RVC-Boss/GPT-SoVITS · GitHub"
