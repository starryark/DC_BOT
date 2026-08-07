# 00 — Current State of the Repository (Runtime V2 Wave 0)

> Subagent 0A "Repository Cartographer" output. READ-ONLY research — no code
> changes. Recorded on 2026-07-31 against the working tree at that date.
> Every fact below is verified against the actual local checkout, not against
> upstream assumptions in `plan.md`.

This file is the authoritative "ground truth" snapshot that later Runtime V2
waves build on. It records git state, the three-process topology, the complete
`discord-bot` source layout, every request path through the voice loop, the
configuration surface, and an explicit owner/refactor map.

---

## 1. Repository topology and git state

### 1.1 Outer repository (`DC_BOT`)

- **Remote:** `https://github.com/starryark/DC_BOT.git`
- **HEAD:** `45678d1494661cb6843451e613b3dd9dbb56e8bf` (branch `main`)
  - Author: Yangyi Liu · 2026-07-31 · subject: `msg`
- **`git status --short` (top level):**

  ```
   m GPT-SoVITS       # modified gitlink (pointer moved)
   m airi            # modified gitlink (pointer moved)
  ?? Proposal.md     # untracked
  ```

  Note the lowercase `m` in the first column with a blank second column: that
  means the index records a different commit SHA for these paths than the
  working tree's nested repo currently sits at (the gitlink pointer is
  out-of-sync), but there is no working-tree "modification" in the usual sense.

### 1.2 `airi/` and `GPT-SoVITS/` are NOT submodules — they are orphan gitlinks

There is **no `.gitmodules`** at the repository root (`ls .gitmodules` → not
found). Both directories are nonetheless tracked in the outer index as
**gitlinks (mode `160000`)**:

```
$ git ls-files --stage airi GPT-SoVITS
160000 2ae95253d9779bcf60deb23a48dedf8d73ccd7c9 0	airi
160000 d523079fc05d9a8028d6085bffe4a2757c32abb6 0	GPT-SoVITS
```

Each one is a **nested full git clone** (`.git` is a real directory, not a
file) with its own `origin` and its own `main` branch. Because there is no
`.gitmodules`, `git submodule status` fails with
`fatal: no submodule mapping found in .gitmodules for path 'GPT-SoVITS'`.

Concretely:

| Path | Tracked how in outer | Nested HEAD | Nested origin | Nature |
|------|----------------------|-------------|---------------|--------|
| `airi/` | gitlink `160000` → `2ae95253…` | `2ae95253d9779bcf60deb23a48dedf8d73ccd7c9` (`main`) | `https://github.com/moeru-ai/airi.git` | **nested clone** of upstream AIRI |
| `GPT-SoVITS/` | gitlink `160000` → `d523079f…` | `d523079fc05d9a8028d6085bffe4a2757c32abb6` (`main`) | `https://github.com/RVC-Boss/GPT-SoVITS.git` | **nested clone** of upstream GPT-SoVITS |
| `qwen3-asr/` | **fully tracked** (ordinary files) in outer repo | (shares outer HEAD `45678d14…`) | — | **vendored in outer repo** (first-party code) |

- `airi HEAD` detail: `2ae95253…` · Kobi Hikri · 2026-07-29 ·
  `chore(ci): attach provenance and SBOM attestations to the released image (#2149)`
- `GPT-SoVITS HEAD` detail: `d523079f…` · RVC-Boss · 2026-07-22 ·
  `Remove redundant code`

**Implication for Runtime V2:** the discord-bot source lives *inside* the
nested AIRI clone. Its files are **not** tracked by the outer `DC_BOT` repo at
all — `git ls-files airi/services/discord-bot/src` returns nothing in the outer
repo. All version control of discord-bot happens in the nested `airi/.git`.
This is why `airi/services/discord-bot` shows up as `??` (untracked) inside the
nested repo for every custom file, and `M` for the few upstream files that were
modified.

### 1.3 Working-tree modifications inside the nested `airi/` repo (discord-bot only)

From `git status --short` run inside `airi/`, scoped to
`services/discord-bot`:

```
 M services/discord-bot/.env                                  # secrets (untracked in outer)
 M services/discord-bot/package.json                          # deps trimmed to direct-mode needs
 M services/discord-bot/src/adapters/airi-adapter.ts          # custom: intent set + command wiring
 M services/discord-bot/src/bots/discord/commands/index.ts    # custom: command registration
 M services/discord-bot/src/bots/discord/commands/summon.ts   # now just re-exports VoiceManager
 M services/discord-bot/src/index.ts                          # custom: direct-mode bootstrap
 D services/discord-bot/src/pipelines/tts.ts                  # removed (old OpenAI STT path)
?? services/discord-bot/.config                               # non-secret runtime config
?? services/discord-bot/.env.example
?? services/discord-bot/src/avatar/                           # custom: avatar publisher
?? services/discord-bot/src/bots/discord/commands/avatar-state.ts
?? services/discord-bot/src/bots/discord/commands/voice-test.ts
?? services/discord-bot/src/config.ts                         # custom: centralized config
?? services/discord-bot/src/orchestration/                    # custom: controller/sessions/chunker/queue/telemetry
?? services/discord-bot/src/providers/                        # custom: asr/brain/tts providers
?? services/discord-bot/src/services.ts                       # custom: shared service locator
?? services/discord-bot/src/voice/                            # custom: refactored voice transport
?? services/discord-bot/vitest.config.ts
```

So the direct-mode voice bot is almost entirely **untracked new files** inside
the nested AIRI clone, layered on top of a small number of modified upstream
files. The old `pipelines/tts.ts` (which held the OpenAI-compatible STT path)
is deleted.

---

## 2. Process topology

Three long-running processes plus one external API, orchestrated by
`start-bot.ps1` (see §5):

```
Process 1 — Node.js (tsx)      airi/services/discord-bot   (pnpm start)
Process 2 — Python 3.11        qwen3-asr/.venv             (python -m app.server)   :8765
Process 3 — Python 3.11        GPT-SoVITS/.venv            (python api_v2.py …)      :9880
External                       Google Gemini API           (generateContentStream)
```

**ASR and GPT-SoVITS intentionally run in separate Python environments**
(`qwen3-asr/.venv` vs `GPT-SoVITS/.venv`). This is a hard process boundary
driven by a dependency conflict: `qwen3-asr` pins `transformers==4.57.6` and
`accelerate==1.12.0` (via `qwen-asr==0.0.6`, see `qwen3-asr/pyproject.toml`),
while GPT-SoVITS needs its own incompatible `transformers`. Runtime V2 must
**preserve this boundary** — do not collapse the two Python services into one
venv.

---

## 3. `discord-bot` source map (verified file tree)

Root: `airi/services/discord-bot/`. Test files use `*.test.ts` and run under
Vitest (`pnpm --filter @proj-airi/discord-bot test` = `vitest run`).

```
src/
├── index.ts                         [CUSTOM] main(): wires adapter + providers + controller
├── config.ts                        [CUSTOM] single env loader → AppConfig (cached)
├── services.ts                      [CUSTOM] setServices/getServices/tryGetServices locator
│
├── adapters/
│   └── airi-adapter.ts              [UPSTREAM-MODIFIED] Discord Client + AIRI ServerChannel
│
├── bots/discord/commands/
│   ├── index.ts                     [UPSTREAM-MODIFIED] SlashCommand registration + barrel
│   ├── ping.ts                      [UPSTREAM] /ping handler
│   ├── summon.ts                    [UPSTREAM-MODIFIED] now just re-exports VoiceManager
│   ├── voice-test.ts                [CUSTOM] /voice-test: TTS-only smoke test
│   └── avatar-state.ts              [CUSTOM] /avatar-state: debug avatar behavior preview
│
├── voice/
│   ├── voice-manager.ts             [CUSTOM] pure voice transport; per-guild/per-user capture
│   └── types.ts                     [CUSTOM] VoiceUtterance, GuildVoiceSession, events
│
├── orchestration/
│   ├── conversation-controller.ts   [CUSTOM] full loop: utterance→ASR→queue→Gemini→chunker→TTS→play
│   ├── guild-session.ts             [CUSTOM] per-guild bounded in-memory history (★ Wave 1 target)
│   ├── turn-queue.ts                [CUSTOM] per-guild FIFO serial executor
│   ├── speech-chunker.ts            [CUSTOM] multilingual sentence/clause chunker
│   ├── telemetry.ts                 [CUSTOM] per-turn TurnTimer latency instrumentation
│   └── conversation-controller.test.ts
│
├── providers/
│   ├── asr/
│   │   ├── types.ts                 [CUSTOM] AsrProvider/AsrResult/AsrInput interfaces
│   │   └── qwen-http.ts             [CUSTOM] POST /v1/transcribe (audio/wav body)
│   ├── brain/
│   │   ├── types.ts                 [CUSTOM] BrainProvider/BrainTurn interfaces
│   │   ├── prompt.ts                [CUSTOM] SYSTEM_PROMPT (multilingual output rules)
│   │   └── gemini.ts                [CUSTOM] generateContentStream; contents via resolver
│   └── tts/
│       ├── types.ts                 [CUSTOM] TtsProvider/TtsRequest; GptSoVitsLang
│       ├── language.ts              [CUSTOM] resolveTtsLanguage / normalizeLanguage
│       ├── gpt-sovits.ts            [CUSTOM] POST /tts to api_v2.py
│       ├── gpt-sovits.test.ts
│       └── language.test.ts
│
├── avatar/
│   ├── publisher.ts                 [CUSTOM] WS publisher → avatar relay (Live2D behaviors)
│   └── publisher.test.ts
│
├── constants/
│   └── audio.ts                     [UPSTREAM] DECODE_SAMPLE_RATE=16000, DECODE_FRAME_SIZE=1024
│
└── utils/
    ├── opus.ts                      [UPSTREAM] OpusDecoder (opusscript) → PCM16
    ├── audio.ts                     [UPSTREAM] getWavHeader / convertOpusToWav
    └── audio-monitor.ts             [UPSTREAM, UNUSED by direct mode] legacy eliza-style monitor
```

Legend: `[CUSTOM]` = newly written for this project (untracked inside airi);
`[UPSTREAM]` = unchanged AIRI scaffolding; `[UPSTREAM-MODIFIED]` = upstream
file that was edited.

---

## 4. Path-by-path request flow (direct backend)

All of the following is the `direct` code path (`config().backend === 'direct'`),
which is the only path actually wired in `index.ts:56-65`. The `airi` backend is
declared but inert (it would defer to the AIRI WebSocket server).

### 4.1 Startup / bootstrap (`src/index.ts`)

1. `config()` parses env into a cached `AppConfig` (`config.ts:101`).
2. `new DiscordAdapter({...})` — constructs the discord.js `Client` (intents
   `Guilds` + `GuildVoiceStates`) and the AIRI `ServerChannel`, and internally
   constructs `new VoiceManager(client)` exposed as `adapter.voiceManager`
   (`airi-adapter.ts:67-88`).
3. `new AvatarPublisher(...)` is bound to the voice manager's `sessionStart` /
   `sessionEnd` events (`publisher.ts:39-42`) and started if enabled.
4. Providers are instantiated: `QwenHttpAsrProvider`, `GptSoVitsTtsProvider`,
   `GeminiBrainProvider`.
5. **Conversation-history ownership link:** `brain.setContentsProvider((turn)
   => sessions.get(turn.guildId).getContents())` (`index.ts:50-54`). The Gemini
   provider owns **no** history; it asks the `GuildSessionRegistry` for the
   assembled `contents` array per generation. The controller adds the user turn
   to the session *before* calling `generate`, so the resolver snapshots the
   current history.
6. `new ConversationController({ voice, asr, brain, tts, sessions })` subscribes
   to `voice`'s `utterance` and `bargeIn` events (`conversation-controller.ts:54-55`).
7. `setServices({...})` publishes the shared instances so `/voice-test` and
   `/avatar-state` can reach them without re-constructing providers
   (`services.ts`).
8. `adapter.start()` logs in to Discord.
9. SIGINT/SIGTERM → `adapter.stop()` + `avatar.stop()` + `process.exit(0)`.

### 4.2 Discord client + command registration

- **Client intents:** `GatewayIntentBits.Guilds | GatewayIntentBits.GuildVoiceStates`
  only (`airi-adapter.ts:68-71`). **No** Message Content intent.
- **Command registration:** `registerCommands(token, readyClient.user.id)`
  fires once on `Events.ClientReady` (`airi-adapter.ts:201-205`), issuing a
  global `PUT applicationCommands(clientId)` (`commands/index.ts:53-56`).
  Registered commands:
  - `/ping` (`ping.ts`) — replies "Pong!".
  - `/summon` — joins the caller's voice channel.
  - `/leave` — leaves the current channel.
  - `/voice-test` — TTS-only smoke test (see §4.11).
  - `/avatar-state` — **only when `AVATAR_DEBUG_COMMAND_ENABLED=true`**, and
    gated behind Manage Guild permission (`commands/index.ts:35-52`).
- **Interaction dispatch:** a single `Events.InteractionCreate` handler in
  `airi-adapter.ts:207-230` routes `summon`/`leave` to
  `voiceManager.handle{Join,Leave}ChannelCommand`, and the others to their
  handlers.

### 4.3 Voice join path

`/summon` → `handleJoinChannelCommand` (`voice-manager.ts:615`) →
`joinChannel(interaction.member.voice.channel)` (`voice-manager.ts:154`):

1. Destroys any existing session for this guild.
2. `joinVoiceChannel({ selfDeaf:false, selfMute:false, group: client.user.id })`.
3. Waits `entersState(Ready, 20_000)`.
4. Stores a `GuildVoiceSession { guildId, channelId, connection, users:Map }`.
5. Wires `connection.on('stateChange')` (reconnect/destroy handling,
   `voice-manager.ts:122-147`) and
   `connection.receiver.speaking.on('start'|'end')`.
6. `setSelfVoice` undeafens/unmutes the bot if it has DeafenMembers.
7. Emits `sessionStart` (consumed by `AvatarPublisher`).

### 4.4 Voice receive path (per-user, 16 kHz mono PCM16)

The endpointing design lives in `voice-manager.ts` and `voice/types.ts`. State
is keyed two ways:

- `sessions: Map<guildId, GuildVoiceSession>` — one per guild (Discord allows
  one bot connection per guild).
- `captures: Map<"${guildId}:${userId}", UserCaptureSession>` — per-user
  capture bookkeeping (`pcmChunks`, `totalBytes`, `speechStartedAt`,
  `lastPacketAt`, `finalizeTimer`, `state`).
- `decoders: Map<"${guildId}:${userId}", Readable>` — one OpusDecoder pipeline
  kept alive while subscribed.

Flow:

1. `receiver.speaking start` → `handleSpeakingStart` (`voice-manager.ts:240`):
   skips the bot itself and other bots, cancels any pending `finalizeTimer`,
   flips `state='speaking'`, and on first sight calls `subscribeMember`.
2. `subscribeMember` (`voice-manager.ts:318`): `connection.receiver.subscribe(
   userId)` → `pipeline(receiveStream, new OpusDecoder(16000, 1))` → each
   decoded PCM packet calls `onPcmPacket`.
3. `onPcmPacket` (`voice-manager.ts:366`) pushes the chunk into the user's
   buffer and either (a) runs barge-in detection while the bot is playing, (b)
   force-finalizes on `maxUtteranceMs`, or (c) **restarts the per-user
   `finalizeTimer`** for trailing-silence endpointing.

**This is the key fix over upstream:** the old `VoiceManager` had a single
global `processingVoice`/`transcriptionTimeout` that dropped every other user's
audio and cleared ALL users' buffers after one transcription. The current code
keys everything per-guild and per-user — no global timer exists (see the class
docstring at `voice-manager.ts:82-97`).

### 4.5 Opus decode path (`utils/opus.ts`)

`OpusDecoder extends Transform` wraps `opusscript`. Constructed with
`(16000, 1)` (sample rate 16 kHz, mono). `_transform` calls
`this.decoder.decode(chunk)` and pushes the PCM16 buffer. Constants live in
`constants/audio.ts`: `DECODE_SAMPLE_RATE = 16000`,
`DECODE_FRAME_SIZE = 1024`. The WAV header builder (`utils/audio.ts`) produces a
44-byte RIFF/WAVE/PCM header at 16 kHz / mono / 16-bit.

### 4.6 Utterance finalization (trailing-silence endpointing)

`scheduleFinalize` (`voice-manager.ts:412`) clears any existing timer and arms
`setTimeout(finalizeUtterance, config().voice.endSilenceMs)` (default 650 ms,
`config.ts:117`). A new speaking burst or any fresh packet cancels it. When the
timer fires:

`finalizeUtterance` (`voice-manager.ts:431`):
1. Resets `state='idle'`, clears `finalizeTimer`.
2. `pcm = Buffer.concat(capture.pcmChunks)`.
3. **Resets only this user's buffer** (not every user's).
4. Drops utterances shorter than `minUtteranceMs` (default 250 ms) as noise.
5. Emits a `VoiceUtterance { guildId, channelId, userId, displayName, pcm,
   sampleRate:16000, channels:1, startedAt, endedAt }` (`voice/types.ts:12`).
6. If `DEBUG_DUMP_AUDIO`, writes a WAV under `./dumps/`.

### 4.7 ASR request path (`providers/asr/qwen-http.ts`)

`QwenHttpAsrProvider.transcribe({ wav, sampleRate:16000 })`:

- `POST ${baseUrl}/v1/transcribe` with `Content-Type: audio/wav` and the **raw
  WAV body** (no temp files, no OpenAI API).
- Abort-enforced by `ASR_REQUEST_TIMEOUT_MS` (default 15 000 ms).
- Expects `{ text, language, inference_ms }`, returns `AsrResult { text,
  language, inferenceMs }`.
- `health()` GETs `/health` → `{ ready }`.

The `wav` buffer is built by `convertOpusToWav(utterance.pcm)` in the
controller (`conversation-controller.ts:70`).

### 4.8 Gemini request path (`providers/brain/gemini.ts`)

`GeminiBrainProvider.generate(turn, signal)` is an `async *` generator:

1. Resolves `contents = this.resolver(turn)` — the provider is **stateless**;
   the resolver (wired in `index.ts:50-54`) returns
   `sessions.get(turn.guildId).getContents()`.
2. `client.models.generateContentStream({ model, contents, config:
   { systemInstruction: SYSTEM_PROMPT, abortSignal: signal } })`.
3. Yields each `chunk.text` delta.

`SYSTEM_PROMPT` (`providers/brain/prompt.ts`) instructs the model to reply in
the most recent speaker's language (zh/en/ja), avoid markdown that sounds
unnatural spoken, and keep conversational answers concise. It does **not**
currently encode Kurisu's persona — that persona text lives in the character
card (see §7).

### 4.9 Conversation-history ownership (`orchestration/guild-session.ts`) ★ Wave 1 target

`GuildSession` holds `history: Content[]` (Gemini-format, oldest first), bounded
to `CONVERSATION_MAX_MESSAGES` (default 24). History is **PER-GUILD**, keyed by
`guildId`, in a `GuildSessionRegistry`. Turns are **speaker-labeled**:
`addUserTurn(displayName, text)` stores `{ role:'user', parts:[{ text:
"${displayName}: ${text}" }] }` so Gemini can tell multiple humans apart
without per-user conversations (`guild-session.ts:30-36`). `addModelTurn` stores
the completed assistant reply. `getContents()` returns a defensive snapshot.

**This is exactly the structure Runtime V2 Wave 1 must replace with room-scoped
context.** Today "room" == "guild"; there is no notion of voice-channel-scoped
or topic-scoped context, and nothing is persisted.

### 4.10 Turn-queue ownership (`orchestration/turn-queue.ts`)

`GuildTurnQueue` is a per-guild FIFO serial executor. `enqueue(task)` runs jobs
one at a time in order; if nothing is running the next job starts immediately.
`GuildTurnQueueRegistry` lazily creates one queue per guild. The controller uses
this so that **only one Gemini generation (+ its TTS playback) is active per
guild at a time** — the bot never talks over itself — while ASR still runs
concurrently across users (`conversation-controller.ts:106-111`).

### 4.11 Full conversation loop (`orchestration/conversation-controller.ts`)

```
utterance event
  → onUtterance: ASR runs immediately (not queue-gated)
     convertOpusToWav → asr.transcribe
     if empty text → skip Gemini, finish telemetry
     else abortGeneration(guildId)   [finalize-level barge-in]
  → queues.get(guildId).enqueue(generateAndSpeak)
     session.addUserTurn(userName, text)
     brain.generate(turn, signal)              [streaming]
       for await (chunk of chunkStream(stream))
         synthesizeAndPlay(guildId, chunk, turnLang, …)
     if not aborted → session.addModelTurn(fullReply)
```

`SpeechChunker` (`orchestration/speech-chunker.ts`) accumulates streamed Gemini
deltas and emits at terminal punctuation (`. ? ! 。 ？ ！`) or at soft/hard char
limits (80/140), so TTS can start on chunk 1 while Gemini is still generating
chunk 2. `chunkStream` flushes any remainder on stream end.

Barge-in (`conversation-controller.ts:216-228` + `voice-manager.ts:380-396`):
while the bot is playing, each user's decoded PCM amplitude is computed
(`averageAmplitude`); a sustained average above `bargeInThreshold` (default
0.05) stops playback immediately and aborts TTS. The Gemini generation is
aborted only when the human utterance **finalizes** (not on the first noise
packet), so keyboard clicks don't kill useful work.

### 4.12 TTS request path (`providers/tts/gpt-sovits.ts`)

`GptSoVitsTtsProvider.synthesize({ text, language }, signal)`:

- Requires `GPT_SOVITS_REF_AUDIO` (throws if unset).
- Resolves `text_lang` from the request (the caller's resolved target language,
  or a text-detection fallback), and `prompt_lang` from config (always the
  Kurisu reference-clip language, default `ja`).
- Body sent to `POST ${baseUrl}/tts` (`api_v2.py`, port 9880):

  ```json
  {
    "text": "...",
    "text_lang": "zh|en|ja|auto",
    "ref_audio_path": "../TTS-KurisuMakise/...",
    "prompt_text": "",          // see §8 — currently empty
    "prompt_lang": "ja",
    "media_type": "wav",
    "streaming_mode": 0,        // GPT_SOVITS_STREAMING_MODE
    "speed_factor": 1.0,
    "text_split_method": "cut5"
  }
  ```

- The response body (web `ReadableStream`) is wrapped via
  `NodeReadable.fromWeb(...)` and returned to the controller, which hands it to
  `voice.playAudioStream`.

Language resolution (`providers/tts/language.ts`) precedence:
1. Strong script evidence in the chunk text (kana ⇒ `ja`, Han-no-kana ⇒ `zh`,
   Latin ⇒ `en`) — but only when `meaningfulChars >= 4`.
2. The turn's ASR-detected language as a hint.
3. `GPT_SOVITS_TEXT_LANG` fallback (default `auto`, deferring to GPT-SoVITS'
   per-segment `LangSegmenter`).

`prompt_lang` and `text_lang` are kept strictly separate by design — see the
`.env.example` comment block and `Language_Fix_Proposal.md`.

### 4.13 Audio playback path (`voice/voice-manager.ts`)

`playAudioStream(guildId, audioStream)` (`voice-manager.ts:509`) — **guild-
keyed**, not user-keyed:

1. Cleans up any existing `AudioPlayer` for the guild.
2. `createAudioPlayer({ behaviors:{ noSubscriber: Pause } })`, stored on
   `session.activeAudioPlayer`; `connection.subscribe(audioPlayer)`.
3. `createAudioResource(stream, { inputType: StreamType.Arbitrary })`.
4. `audioPlayer.play(resource)`; on idle, clears `session.activeAudioPlayer`.

`stopPlayback(guildId)` (`voice-manager.ts:538`) stops and detaches the player
(used by barge-in). `isPlaying(guildId)` and `hasSession(guildId)` are the
query helpers used by `/voice-test`.

---

## 5. Startup scripts

### 5.1 `start-bot.ps1` / `start-bot.cmd`

`start-bot.cmd` is a one-line `-ExecutionPolicy Bypass` wrapper around
`start-bot.ps1` (so the system PowerShell policy doesn't block it).

`start-bot.ps1` parameters: `-AsrModel` (default `Qwen/Qwen3-ASR-0.6B`),
`-AsrDevice` (`cuda:0`), `-AsrDtype` (`bfloat16`), `-GeminiModel`, `-TtsPython`,
`-ReadinessTimeoutSec` (180), `-ReadinessPollIntervalSec` (2). It:

1. Validates `airi/services/discord-bot/.env` has `DISCORD_TOKEN` and
   `GEMINI_API_KEY`; errors clearly if not.
2. Checks `qwen3-asr/.venv/Scripts/python.exe` and
   `GPT-SoVITS/GPT_SoVITS/configs/tts_infer_kurisu.yaml` exist.
3. **Selects a GPT-SoVITS interpreter** in order:
   `GPT-SoVITS/runtime/python.exe` → `GPT-SoVITS/.venv/Scripts/python.exe` →
   `$USERPROFILE/miniforge3/envs/GPTSoVits/python.exe` → `python` on PATH.
4. Exports `NLTK_DATA` (preferring `GPT-SoVITS/nltk_data`) and **verifies the
   English frontend** before launching (`from text.english import g2p;
   g2p('English')`) — catches the `averaged_perceptron_tagger_eng` gap early.
5. Starts ASR (`python -m app.server`, cwd `qwen3-asr`) and GPT-SoVITS
   (`python api_v2.py -a 127.0.0.1 -p 9880 -c
   GPT_SoVITS/configs/tts_infer_kurisu.yaml`, cwd `GPT-SoVITS`) — each in its
   own visible PowerShell window, reusing either if its port is already
   listening.
6. **Readiness gating:** polls ASR `GET /health` (real readiness) and a TCP
   connect on GPT-SoVITS port 9880 (the model loads synchronously before
   uvicorn binds, so an accepted connection means ready), bounded by
   `-ReadinessTimeoutSec`. On timeout it throws and does **not** launch the bot.
   `-ReadinessTimeoutSec 0` skips the wait.
7. Starts the bot: `pnpm.cmd start` in `airi/services/discord-bot`.

### 5.2 Bot `start` script (`package.json`)

```
"start": "tsx --env-file=.env --env-file-if-exists=.config --env-file-if-exists=.env.local src/index.ts"
```

Three env layers, applied in order, later wins: `.env` (secrets), `.config`
(non-secret tuning), `.env.local` (per-machine overrides). No `dotenv` import —
`tsx` injects env via the `--env-file` flags.

### 5.3 `setup-gpt-sovits.ps1` / `setup-gpt-sovits.cmd`

Provisions `GPT-SoVITS/.venv` (Python 3.11 via `uv`), installs CUDA 12.8
PyTorch (`cu128`, switchable to `cu126`/`cpu`), installs
`extra-req.txt --no-deps` then `requirements.txt`, downloads the NLTK
`averaged_perceptron_tagger_eng` into `GPT-SoVITS/nltk_data`, and verifies
Japanese (`pyopenjtalk`) + English (`nltk.pos_tag`) frontends.

### 5.4 `service-status.ps1` / `service-status.cmd`

`netstat`-based check reporting PID/Process/Path for ports 8765 (ASR) and 9880
(GPT-SoVITS).

---

## 6. Configuration surface (`src/config.ts`)

`config()` is the **single** place env is read — nothing in `src/` reads
`process.env` for runtime config directly. It is cached (`cached` singleton,
`resetConfigCache()` for tests). The `AppConfig` shape:

| Group | Field | Env var | Default |
|-------|-------|---------|---------|
| root | `backend` | `BOT_BACKEND` | `direct` (`airi` ⇒ WS) |
| root | `discordToken` | `DISCORD_TOKEN` | `''` |
| root | `discordClientId` | `DISCORD_BOT_CLIENT_ID` | `''` (unused; uses auth app id) |
| root | `airiToken` / `airiUrl` | `AIRI_TOKEN` / `AIRI_URL` | `abcd` / `ws://localhost:6121/ws` |
| `voice` | `endSilenceMs` | `VOICE_END_SILENCE_MS` | 650 |
| `voice` | `minUtteranceMs` | `VOICE_MIN_UTTERANCE_MS` | 250 |
| `voice` | `maxUtteranceMs` | `VOICE_MAX_UTTERANCE_MS` | 30000 |
| `voice` | `bargeInWindowFrames` | `BARGE_IN_WINDOW_FRAMES` | 30 |
| `voice` | `bargeInThreshold` | `BARGE_IN_THRESHOLD` | 0.05 |
| `voice` | `debugDumpAudio` | `DEBUG_DUMP_AUDIO` | false |
| `asr` | `baseUrl` | `ASR_BASE_URL` | `http://127.0.0.1:8765` |
| `asr` | `requestTimeoutMs` | `ASR_REQUEST_TIMEOUT_MS` | 15000 |
| `brain` | `provider` | — | `'gemini'` |
| `brain` | `apiKey` | `GEMINI_API_KEY` | `''` |
| `brain` | `model` | `GEMINI_MODEL` | `gemini-3.6-flash` |
| `brain` | `maxMessages` | `CONVERSATION_MAX_MESSAGES` | 24 |
| `tts` | `baseUrl` | `GPT_SOVITS_URL` | `http://127.0.0.1:9880` |
| `tts` | `requestTimeoutMs` | `GPT_SOVITS_REQUEST_TIMEOUT_MS` | 30000 |
| `tts` | `refAudioPath` | `GPT_SOVITS_REF_AUDIO` | `''` |
| `tts` | `promptText` | `GPT_SOVITS_PROMPT_TEXT` | `''` |
| `tts` | `promptLang` | `GPT_SOVITS_PROMPT_LANG` | `ja` |
| `tts` | `textLangFallback` | `GPT_SOVITS_TEXT_LANG` | `auto` |
| `tts` | `streamingMode` | `GPT_SOVITS_STREAMING_MODE` | 0 |
| `avatar` | `enabled` | `AVATAR_ENABLED` | false |
| `avatar` | `relayUrl` | `AVATAR_RELAY_URL` | `ws://127.0.0.1:8080/ws/publisher` |
| `avatar` | `publishToken` | `AVATAR_RELAY_PUBLISH_TOKEN` | `''` |
| `avatar` | `debugCommandEnabled` | `AVATAR_DEBUG_COMMAND_ENABLED` | false |

If `avatar.enabled` is true, config validates that the token is present and the
URL uses `ws:`/`wss:` (`config.ts:154-168`). The actual runtime `.config` file
mirrors `.env.example` but points the ref audio at
`../TTS-KurisuMakise\WAV\crs_0127.WAV_0000000000_0000164160.wav`.

### Qwen3-ASR env (`qwen3-asr/app/config.py`)

Process env (set by `start-bot.ps1`): `ASR_MODEL` (`Qwen/Qwen3-ASR-0.6B`),
`ASR_HOST` (`127.0.0.1`, loopback only), `ASR_PORT` (8765), `ASR_DEVICE`
(`cuda:0`), `ASR_DTYPE` (`bfloat16`), `ASR_MIN_AUDIO_MS` (250),
`ASR_MAX_AUDIO_MS` (30000). `ASR_SKIP_LOAD=1` skips the model load for dry
runs/tests.

---

## 7. Character card and the ACT/emotion protocol

- **Card:** `Makise Kurisu/card.json` — Character Card V3
  (`spec: "chara_card_v3"`, `spec_version: 3.0`). 8654 bytes.
- **`data` keys:** `name`, `description`, `personality`, `scenario`,
  `first_mes`, `alternate_greetings`, `group_only_greetings`,
  `character_version`, `creator`, `creator_notes`, `system_prompt`,
  `post_history_instructions`, `mes_example`, `tags`, `extensions`.
- **Persona source:** `data.system_prompt` (508 chars, Japanese) defines
  Kurisu's tone/persona. **The bot's `SYSTEM_PROMPT` (`providers/brain/prompt.ts`)
  does NOT currently load this card** — it only carries the generic multilingual
  voice-bot rules. Runtime V2 must decide how persona text reaches Gemini.
- **`data.extensions`** contains `depth_prompt`, `fav`, `talkativeness`, and an
  `airi` block (module providers: consciousness → `google-generative-ai`
  `models/gemini-3.6-flash`, speech → `gpt-sovits` voice `kurisu`, plus AIRI
  display-model/artistry config). It does **not** contain a `dc_bot` key.

**★ The ACT/emotion protocol is stored inside `creator_notes`, NOT in
`extensions`.** `creator_notes` (543 chars, Japanese) specifies that every
response must begin with one ACT token:

```
<|ACT:"emotion":{"name":"neutral","intensity":0.6},"motion":"画面から視線を上げる"|>
```

with allowed `emotion` names `happy / sad / angry / think / surprised / awkward
/ question / curious / neutral`, a short `motion` description, optional
`<|DELAY:1|>` / `<|DELAY:3|>`, and a "don't overuse ACT/DELAY, no emoji" rule.
**Runtime V2 must move this protocol into
`extensions.dc_bot.outputProtocol`** (per master plan), because `creator_notes`
is a free-text author field, not a machine-parseable contract.

- **Manifest:** `Makise Kurisu/manifest.json` — `format:
  "airi-character-card"`, `version: 1`. Declares the card (`path: "card.json"`,
  `spec: "chara_card_v3"`) and a `displayModel` resource
  (`format: "live2d-zip"`, `path: "models/body-model.zip"`). The referenced
  `Makise Kurisu/models/body-model.zip` (8.7 MB) exists.

---

## 8. GPT-SoVITS "prompt free" fallback (known issue, recorded)

The inference logs (`Inference_Log.txt`, `Inference_Log_2.txt`) repeatedly
contain:

```
Prompt free is not supported batch_infer! switch to naive_infer
```

Root cause: `GPT_SOVITS_PROMPT_TEXT` is empty (both `.env.example` and the live
`.config` leave it blank), so `api_v2.py` falls back from its faster
`batch_infer` path to the slower `naive_infer` path because it has no reference
prompt text to pair with `ref_audio_path`. This is a correctness-preserving but
latency-costly fallback. Runtime V2 should either supply a transcript for the
reference clip or accept the naive path deliberately.

---

## 9. Avatar / Live2D publisher (`src/avatar/publisher.ts`)

`AvatarPublisher` is a WebSocket client to a separate avatar relay
(`AVATAR_RELAY_URL`, default `ws://127.0.0.1:8080/ws/publisher`). It:

- Binds to the voice manager's `sessionStart`/`sessionEnd` to track which
  channel each guild is in.
- Speaks the `@proj-airi/discord-avatar-protocol` (`avatar.behavior.set`
  frames with `schemaVersion`, `guildId`, `channelId`, `sessionId`,
  `sequence`, `connected`, `behavior` ∈ `idle|listening|thinking|speaking`,
  `speaking`, `mouthOpen`).
- Authenticates with `publisher.hello` + token, handles heartbeats, ACKs via
  `state.result`, and reconnects with exponential backoff (cap 30 s).
- Currently **does not** auto-flip behavior on ASR/Gemini/TTS events — that
  wiring is the Live2D effort's job (see `Live2D_Plan.md`, which proposes a
  Discord Activity rendering AIRI's WebGL Live2D rather than a bot camera tile).

`/avatar-state` (`commands/avatar-state.ts`) is a Manage-Guild-gated debug
command to manually preview a behavior; it only registers when
`AVATAR_DEBUG_COMMAND_ENABLED=true`.

---

## 10. Tests and dev commands

- **Bot tests:** `pnpm --filter @proj-airi/discord-bot test`
  → `vitest run` (config: `vitest.config.ts`, includes `src/**/*.test.ts`).
  Existing tests:
  - `src/orchestration/conversation-controller.test.ts`
  - `src/providers/tts/gpt-sovits.test.ts`
  - `src/providers/tts/language.test.ts`
  - `src/avatar/publisher.test.ts`
- **Typecheck:** `pnpm --filter @proj-airi/discord-bot typecheck`
  → `tsc --noEmit`.
- **ASR tests:** from `qwen3-asr/`, `.\.venv\Scripts\python.exe -m pytest`
  (test file: `qwen3-asr/tests/test_server.py`; dev deps `pytest`, `httpx`).

---

## 11. Ownership / refactor-safety map

### 11.1 Safe to refactor (owned by this project; untracked in outer repo)

All `[CUSTOM]` files in §3 are first-party and safe to change:
`config.ts`, `services.ts`, `index.ts` (custom bootstrap),
`voice/{voice-manager,types}.ts`, the entire `orchestration/` and `providers/`
trees, `avatar/publisher.ts`, `bots/discord/commands/{voice-test,avatar-state}.ts`.

### 11.2 Upstream AIRI scaffolding — edit with care, do not break workspace contracts

- `adapters/airi-adapter.ts` — modified for direct mode but still constructs the
  AIRI `ServerChannel` (`@proj-airi/server-sdk`). The discord.js `Client` and
  intent set are here.
- `bots/discord/commands/index.ts`, `summon.ts`, `ping.ts` — `summon.ts` is now
  a re-export shim; `index.ts` was edited to add commands.
- `utils/{opus,audio,audio-monitor}.ts`, `constants/audio.ts` — unchanged
  upstream utilities. (`audio-monitor.ts` is legacy and unused by direct mode.)

### 11.3 Upstream workspace dependencies (`@proj-airi/*`) — do NOT modify, consumed as-is

The discord-bot's `package.json` depends on several workspace packages that
**exist in the nested AIRI clone** under `airi/packages/`:

- `@proj-airi/discord-avatar-protocol` (avatar frame schema — used by
  `avatar/publisher.ts` and `commands/avatar-state.ts`)
- `@proj-airi/server-sdk` (AIRI WebSocket `Client`/`ServerChannel`)
- `@proj-airi/server-shared` (Discord metadata types, `ContextUpdateStrategy`)
- `@proj-airi/audio`

These are `workspace:^` deps resolved by the pnpm workspace; they are **not**
DC_BOT code and must not be edited as part of Runtime V2.

### 11.4 External checkouts — treat as read-only upstream

- `airi/` — nested clone of `moeru-ai/airi` at `2ae95253…`. The discord-bot
  source lives here but is version-controlled by `airi/.git`, not the outer
  repo.
- `GPT-SoVITS/` — nested clone of `RVC-Boss/GPT-SoVITS` at `d523079f…`.
  `api_v2.py` and `GPT_SoVITS/configs/tts_infer_kurisu.yaml` live here. The
  Kurisu-trained weights and reference clips are in `TTS-KurisuMakise/`
  (e.g. `害羞示范.wav`, `牧懒红莉栖-e15.ckpt`, `牧懒红莉栖_e4_s972.pth`), which
  is a separate Hugging Face-style asset directory, not a git repo.

---

## 12. Facts Runtime V2 must preserve / act on

1. **Conversation history is PER-GUILD** (`GuildSession` keyed by `guildId`,
   bounded in-memory to 24 messages). Wave 1 replaces this with room-scoped
   context. The provider ↔ history link is `brain.setContentsProvider` in
   `index.ts:50-54` — change there and in `guild-session.ts`.
2. **The ACT/emotion protocol lives in `creator_notes`** of
   `Makise Kurisu/card.json`, not in `extensions`. Move it to
   `extensions.dc_bot.outputProtocol`. The bot's current `SYSTEM_PROMPT`
   (`providers/brain/prompt.ts`) does not load the card at all.
3. **GPT-SoVITS runs the slow `naive_infer` fallback** because
   `GPT_SOVITS_PROMPT_TEXT` is empty (confirmed in `Inference_Log*.txt`).
4. **ASR and GPT-SoVITS use separate Python environments** (`transformers`
   version conflict). Keep the two-process boundary.
5. **`airi/` and `GPT-SoVITS/` are orphan gitlinks** (mode `160000`, no
   `.gitmodules`). `git submodule status` errors. `qwen3-asr/` is fully tracked
   in the outer repo.
6. **No Message Content intent** — only `Guilds` + `GuildVoiceStates`.
7. **One Gemini generation per guild at a time** (`GuildTurnQueue`); ASR is
   concurrent across users. Barge-in aborts TTS immediately, generation on
   finalize.
8. **`utils/audio-monitor.ts` is legacy/unused** by the direct path (the new
  endpointing lives entirely in `voice-manager.ts`). Safe to ignore or remove
  if confirmed unused elsewhere.
