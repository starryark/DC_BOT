# Discord voice bot

This repository contains a working Discord voice conversation pipeline:

```text
Discord voice -> Qwen3-ASR -> Gemini -> GPT-SoVITS -> Discord voice
```

The bot implementation is in `airi/services/discord-bot`. It supports `/summon`,
`/leave`, `/ping`, and `/voice-test`. In the default `direct` backend, a user
speaks after `/summon`; the bot transcribes the utterance locally, generates a
reply with Gemini, synthesizes it with the Kurisu Makise GPT-SoVITS weights,
and plays it in the same voice channel.

## Requirements

- Windows PowerShell
- Node.js and pnpm (the checked-in AIRI workspace specifies pnpm 10.33.0)
- Python 3.10-3.12
- A CUDA-capable GPU is strongly recommended
- A Discord application/bot token
- A Gemini API key

The Discord bot must be invited with permission to view channels, use
application commands, connect, speak, and use voice activity. The implemented
voice bot requests only the Guilds and Guild Voice States gateway intents; it
does not require Discord's privileged Message Content intent.

## First-time setup

Run all commands below from this repository's root.

### 1. Configure the Discord bot

```powershell
Copy-Item airi\services\discord-bot\.env.example airi\services\discord-bot\.env
notepad airi\services\discord-bot\.env
```

At minimum, fill in:

```dotenv
DISCORD_TOKEN=your_bot_token
GEMINI_API_KEY=your_gemini_api_key
BOT_BACKEND=direct
```

`DISCORD_BOT_CLIENT_ID` is present in the example but is not required by the
current implementation: the bot uses its authenticated application ID when it
registers global slash commands.

Keep these defaults unless you deliberately changed ports:

```dotenv
ASR_BASE_URL=http://127.0.0.1:8765
GPT_SOVITS_URL=http://127.0.0.1:9880
GPT_SOVITS_REF_AUDIO=../TTS-KurisuMakise/害羞示范.wav
GPT_SOVITS_PROMPT_LANG=ja
```

Do not commit `.env`.

#### Splitting secrets from config

The bot loads two env files on start (see the `start` script): `.env` (secrets —
token, Gemini key) and `.config` (non-sensitive settings — URLs, ports, tuning).
You may keep your non-secret overrides in `airi/services/discord-bot/.config`
instead of `.env`; both are applied, with `.env` taking precedence. `.env.local`
is also loaded last if present, for per-machine overrides.

#### Multilingual TTS — `prompt_lang` vs `text_lang`

The Kurisu voice can speak Japanese, Chinese, and English from the same model.
Two language fields are kept strictly separate in every GPT-SoVITS request:

- `prompt_lang` (`GPT_SOVITS_PROMPT_LANG`, default `ja`) — the language of the
  Kurisu *reference clip*. This defines the speaker's voice identity and should
  **not** be changed to the user's language.
- `text_lang` — the language of the text *currently being synthesized*. This is
  a property of the speech, not the voice, and is resolved per turn:

  1. Strong script evidence in the generated text (kana ⇒ `ja`, Latin-dominant ⇒
     `en`, Han ⇒ `zh`).
  2. The ASR-detected turn language as a hint.
  3. `GPT_SOVITS_TEXT_LANG` (default `auto`) — lets GPT-SoVITS' per-segment
     `LangSegmenter` auto-detect.

Use `/voice-test` to validate each language without involving ASR or Gemini:

```
/voice-test language:ja text:"こんにちは。"
/voice-test language:zh text:"你好，你会说中文吗？"
/voice-test language:en text:"Hello. Can you speak English?"
/voice-test language:auto text:"你好, hello, こんにちは"
```

English synthesis additionally requires the NLTK `averaged_perceptron_tagger_eng`
resource; `setup-gpt-sovits.cmd` provisions it, and `start-bot.cmd` verifies the
English frontend before launching.

### 2. Install the bot dependencies

The `airi/node_modules` directory is already present in this checkout. If it is
missing or stale:

```powershell
Set-Location airi
pnpm install
Set-Location ..
```

This is a pnpm workspace; do not install the Discord service with npm in
isolation.

### 3. Install Qwen3-ASR

This checkout already has `qwen3-asr/.venv`. To recreate it:

```powershell
py -3.11 -m venv qwen3-asr\.venv
qwen3-asr\.venv\Scripts\python.exe -m pip install --upgrade pip
qwen3-asr\.venv\Scripts\python.exe -m pip install torch --index-url https://download.pytorch.org/whl/cu124
qwen3-asr\.venv\Scripts\python.exe -m pip install -e qwen3-asr
```

Choose the PyTorch CUDA wheel compatible with your driver. The first ASR start
downloads the configured Hugging Face model if it is not cached.

For CPU-only use, launch with `-AsrDevice cpu -AsrDtype float32`. It will be
considerably slower.

### 4. Install GPT-SoVITS

The GPT-SoVITS source and pretrained assets are checked out under
`GPT-SoVITS`. Its custom Kurisu weights are already under
`TTS-KurisuMakise`.

Install GPT-SoVITS into its own Python environment:

```powershell
.\setup-gpt-sovits.cmd
```

This creates `GPT-SoVITS/.venv` with Python 3.11, installs CUDA 12.8 PyTorch,
and then installs the checked-in GPT-SoVITS requirements. The included Windows
compatibility adjustment uses SoundFile for reference WAV decoding because
TorchCodec does not publish Windows wheels. To choose another PyTorch build:

```powershell
.\setup-gpt-sovits.cmd -TorchBuild cu126
# or: .\setup-gpt-sovits.cmd -TorchBuild cpu
```

Do not reuse `qwen3-asr/.venv`: Qwen ASR and GPT-SoVITS require incompatible
versions of `transformers`.

The launcher
looks for these interpreters in order:

1. `GPT-SoVITS\runtime\python.exe`
2. `GPT-SoVITS\.venv\Scripts\python.exe`
3. `python` on `PATH`

The bot must start GPT-SoVITS with
`GPT_SoVITS/configs/tts_infer_kurisu.yaml`; the default `tts_infer.yaml` loads
the generic pretrained voice instead of the included Kurisu weights.

## Run

The easiest path opens one terminal for each long-running service. Use the
`.cmd` entry point on Windows so the system PowerShell execution policy does
not block the launcher:

```powershell
.\start-bot.cmd
```

The bypass applies only to the PowerShell process created by this command; it
does not modify your user or machine execution policy.

The launcher checks configuration and installed runtimes, then starts:

- Qwen3-ASR at `http://127.0.0.1:8765`
- GPT-SoVITS at `http://127.0.0.1:9880`
- the Discord bot

The launcher waits for both local services to become ready before starting the
bot, so the first TTS request can no longer hit `ECONNREFUSED`. It polls ASR's
`GET /health` (real readiness) and a TCP connect on GPT-SoVITS' port 9880 (the
model loads synchronously before uvicorn binds, so an accepted connection means
it is ready). The wait is bounded by `-ReadinessTimeoutSec` (default 180s, for
slow CUDA cold starts); on timeout the bot is not launched into a known-broken
state. Pass `-ReadinessTimeoutSec 0` to skip the wait if you start services
manually. Existing services on those ports are reused. In Discord:

1. Join a voice channel.
2. Run `/summon`.
3. Speak normally and pause at the end of the utterance.
4. Run `/leave` when finished.

Use `/voice-test text:こんにちは` to test Discord playback and GPT-SoVITS
without involving ASR or Gemini. Global slash-command registration can take a
short time to appear after the first bot start.

Stop each terminal with `Ctrl+C`.

Service terminals are opened as normal visible PowerShell windows. To check
whether either local model service is running in the background:

```powershell
.\service-status.cmd
```

If a service is running without a visible terminal, stop its reported PID with
`Stop-Process -Id <PID>`, then launch again to get a visible window.

### Model and runtime overrides

Parameters can be changed without editing source:

```powershell
.\start-bot.cmd `
  -AsrModel "Qwen/Qwen3-ASR-1.7B" `
  -AsrDevice "cuda:0" `
  -AsrDtype "bfloat16" `
  -GeminiModel "gemini-2.5-flash"
```

To select an explicit GPT-SoVITS interpreter:

```powershell
.\start-bot.cmd -TtsPython "C:\path\to\python.exe"
```

`GEMINI_MODEL` may also be edited directly in
`airi/services/discord-bot/.env`. Use a model name available to your Gemini
account; the launcher override applies only to the processes it starts.

### Manual start

If you prefer three existing terminals:

Terminal 1:

```powershell
Set-Location qwen3-asr
.\.venv\Scripts\python.exe -m app.server
```

Terminal 2:

```powershell
Set-Location GPT-SoVITS
python api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer_kurisu.yaml
```

Terminal 3:

```powershell
Set-Location airi\services\discord-bot
pnpm start
```

## Useful configuration

The complete set of bot settings is documented in
`airi/services/discord-bot/.env.example`. The most useful tuning values are:

- `VOICE_END_SILENCE_MS`: trailing silence that ends an utterance (default 650)
- `VOICE_MAX_UTTERANCE_MS`: hard utterance limit (default 30000)
- `BARGE_IN_THRESHOLD`: speech amplitude required to interrupt playback
- `CONVERSATION_MAX_MESSAGES`: retained per-server conversation history
- `GPT_SOVITS_STREAMING_MODE`: `0` for full synthesis, `1`-`3` for streaming
- `DEBUG_DUMP_AUDIO=true`: saves finalized input WAVs under the bot's `dumps`
  directory

Qwen service settings are process environment variables: `ASR_MODEL`,
`ASR_DEVICE`, `ASR_DTYPE`, `ASR_HOST`, and `ASR_PORT`.

## Health checks and troubleshooting

Check ASR readiness:

```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
```

Common failures:

- **Bot logs in but does not hear users:** confirm Connect/Speak permissions,
  run `/summon` from the voice channel, and check that ASR reports `ready: true`.
- **`/voice-test` says TTS failed:** GPT-SoVITS is not listening on port 9880,
  its Python dependencies are missing, or it was started without the Kurisu
  config.
- **CUDA out of memory:** use the 0.6B ASR model, close other GPU workloads, or
  use CPU/float32 for ASR. GPT-SoVITS' Kurisu config currently selects CUDA and
  half precision.
- **Gemini generation fails:** verify `GEMINI_API_KEY` and use a Gemini model
  your key can access.
- **Commands do not appear:** confirm the bot was invited with the
  `applications.commands` scope and wait for global command propagation.

For development checks:

```powershell
Set-Location airi
pnpm --filter @proj-airi/discord-bot typecheck
pnpm --filter @proj-airi/discord-bot test
Set-Location ..\qwen3-asr
.\.venv\Scripts\python.exe -m pytest
```
