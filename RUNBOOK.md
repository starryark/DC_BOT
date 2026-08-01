# DC Voice Bot — Runbook

The Discord voice bot: **Qwen3-ASR → Gemini → GPT-SoVITS (Kurisu)** → playback.
Everything is built, typechecked, and the two AI services are verified working
on this machine. This is the one doc to run the whole stack.

## Architecture (3 processes + 1 external API)

```
Process A (Node)   airi/services/discord-bot        Discord transport + orchestration
Process B (Python) qwen3-asr  on 127.0.0.1:8765     Qwen3-ASR-0.6B transcription
Process C (Python) GPT-SoVITS on 127.0.0.1:9880     GPT-SoVITS Kurisu v2Pro TTS
External           Gemini API                        LLM (streaming)
```

## Prerequisites (all satisfied on this machine — verified 2026-07-30)

- [x] GPU: RTX 5060 Ti (Blackwell sm_120), 16 GB. Combined VRAM ~8 GB.
- [x] `GPTSoVits` conda env at `C:\Users\lyang\miniforge3\envs\GPTSoVits` (torch 2.11+cu128, sm_120).
- [x] `qwen3-asr/.venv` (Python 3.11, torch+cu128, qwen-asr 0.0.6).
- [x] GPT-SoVITS pretrained models in `GPT-SoVITS/GPT_SoVITS/pretrained_models/` (33 files).
- [x] Kurisu trained weights in `TTS-KurisuMakise/` (v2Pro).
- [x] `ffmpeg` on PATH.
- [ ] **You must provide:** a real `DISCORD_TOKEN` and `GEMINI_API_KEY` in
      `airi/services/discord-bot/.env` (currently placeholders).

## Start the stack (each boot, in this order)

The one-command launcher handles ordering, readiness waits, and NLTK wiring:

```bash
cd C:/Users/lyang/Code/DC_BOT
./start-bot.cmd            # starts ASR + GPT-SoVITS, waits for readiness, then the bot
```

It waits (bounded, `-ReadinessTimeoutSec` default 180s) for ASR `/health` ready
and a TCP connect on GPT-SoVITS :9880 before launching the bot, so the first TTS
request no longer races the model load. To start the three services manually:

```bash
# 1. GPT-SoVITS (Kurisu TTS) — ~30s to load, then "Uvicorn running on :9880"
cd C:/Users/lyang/Code/DC_BOT/GPT-SoVITS
"C:/Users/lyang/miniforge3/envs/GPTSoVits/python.exe" api_v2.py \
  -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer_kurisu.yaml

# 2. Qwen3-ASR — ~40s cold (downloads model first time), then "/health ready:true"
cd C:/Users/lyang/Code/DC_BOT/qwen3-asr
.venv/Scripts/python.exe -m app.server

# 3. The Discord bot (loads .env secrets + .config settings)
cd C:/Users/lyang/Code/DC_BOT/airi
pnpm -F @proj-airi/discord-bot start
```

Leave all three running. The bot logs `Direct backend active: Qwen ASR → Gemini → GPT-SoVITS.`

## Verify each service independently

```bash
# ASR (auto language ID, ~1s steady-state)
curl -s http://127.0.0.1:8765/health
# then POST a 16k mono WAV to http://127.0.0.1:8765/v1/transcribe

# TTS — use Python so the UTF-8 ref filename (害羞示范.wav) is handled correctly.
# Multilingual smoke tests (prompt_lang stays ja = the Kurisu reference clip;
# text_lang = the language being synthesized):
cd C:/Users/lyang/Code/DC_BOT/GPT-SoVITS
python -c "import urllib.request,json; b=json.dumps({'text':'こんにちは。今日はいい天気ですね。','text_lang':'ja','ref_audio_path':'../TTS-KurisuMakise/害羞示范.wav','prompt_text':'','prompt_lang':'ja','media_type':'wav','streaming_mode':0}).encode(); r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9880/tts',data=b,headers={'Content-Type':'application/json'}),timeout=90); open('ja.wav','wb').write(r.read()); print('ja',r.status)"
python -c "import urllib.request,json; b=json.dumps({'text':'你好。今天想聊些什么？','text_lang':'zh','ref_audio_path':'../TTS-KurisuMakise/害羞示范.wav','prompt_text':'','prompt_lang':'ja','media_type':'wav','streaming_mode':0}).encode(); r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9880/tts',data=b,headers={'Content-Type':'application/json'}),timeout=90); open('zh.wav','wb').write(r.read()); print('zh',r.status)"
python -c "import urllib.request,json; b=json.dumps({'text':'Hello. What would you like to talk about today?','text_lang':'en','ref_audio_path':'../TTS-KurisuMakise/害羞示范.wav','prompt_text':'','prompt_lang':'ja','media_type':'wav','streaming_mode':0}).encode(); r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9880/tts',data=b,headers={'Content-Type':'application/json'}),timeout=90); open('en.wav','wb').write(r.read()); print('en',r.status)"
# Mixed (auto lets GPT-SoVITS' LangSegmenter detect per segment):
python -c "import urllib.request,json; b=json.dumps({'text':'你好。Hello. こんにちは。','text_lang':'auto','ref_audio_path':'../TTS-KurisuMakise/害羞示范.wav','prompt_text':'','prompt_lang':'ja','media_type':'wav','streaming_mode':0}).encode(); r=urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:9880/tts',data=b,headers={'Content-Type':'application/json'}),timeout=90); open('auto.wav','wb').write(r.read()); print('auto',r.status)"
```

English needs NLTK `averaged_perceptron_tagger_eng`; if the `en` call returns
HTTP 400 with that resource name, run `./setup-gpt-sovits.cmd` and confirm
`GPT-SoVITS/nltk_data/taggers/averaged_perceptron_tagger_eng/english.pickle` exists.

See `GPT_SOVITS_KURISU_SETUP.md` (full TTS detail) and `qwen3-asr/README.md` (ASR detail).

## Use it in Discord

1. Join a voice channel.
2. `/summon` — bot joins. Console logs `[utterance]` when you speak.
3. `/voice-test language:ja text:"こんにちは。"` — standalone Kurisu TTS check (no ASR/Gemini). Try `language:zh`, `language:en`, and `language:auto` for multilingual validation.
4. Speak normally — full loop: voice → Qwen → Gemini → Kurisu → playback.
5. `/leave` — bot leaves cleanly.

## Key behaviors

- **Per-user capture, no global timer.** Two users can speak simultaneously;
  each is transcribed independently (plan.md §9–10).
- **Half-duplex by default.** One turn per guild at a time. Speech that arrives
  while the bot is thinking or speaking is dropped *before* ASR and is never
  queued. Change with `BOT_INPUT_POLICY`.
- **Serialized playback.** One persistent `AudioPlayer` per guild and one
  scheduler own every `play()` call; chunks play in order and a turn stays
  active until its last chunk finishes.
- **Barge-in is off by default** (`BARGE_IN_ENABLED=false`). When enabled under
  a non-half-duplex policy, sustained speech cancels the whole response —
  generation, synthesis, queued audio and the active resource together.
- **Filler/duplicate filtering** runs before the model; a repeat of your own
  previous line inside `VOICE_DUPLICATE_WINDOW_MS` is dropped.
- **Quota cooldown.** A Gemini 429 suspends requests for the API-reported retry
  delay and speaks one short notice, debounced by
  `GEMINI_COOLDOWN_PROMPT_INTERVAL_MS`.
- **Structured per-turn events** are logged (see below).

### Reading the logs

Each turn emits named events with `guildId`, `turnId` and `responseEpoch`:

```text
utterance_received        an utterance passed admission + filtering
input_discarded           dropped before ASR (reason=bot_speaking|bot_thinking|…)
transcript_filtered       dropped before the model (reason=empty|too_short|filler|duplicate)
guild_phase_changed       idle → collecting → thinking → speaking → idle
response_epoch_started    a generation began
gemini_request_started    a model request left the process
gemini_rate_limited       429; carries cooldownMs + quotaMetric
gemini_cooldown_active    a request was suppressed by the cooldown
tts_synthesis_started     a chunk went to GPT-SoVITS
playback_enqueued         audio queued (chunkIndex, queueDepth)
playback_started          play() was issued
playback_completed        the resource reached idle (durationMs)
playback_cancelled        epoch cancelled, disconnect, or superseded
response_completed        history committed
avatar_action             an ACT token was parsed out of the reply
```

`guild_phase_transition_rejected` and `playback_invariant_violation` should
never appear in normal operation; both indicate a bug worth reporting.

### Performance benchmark

With ASR and GPT-SoVITS running, execute `pnpm --filter
@proj-airi/discord-bot benchmark:voice -- --output
benchmarks/voice/latest.json` from `airi`. Optional `--asr` accepts a
comma-separated list of approved WAV fixtures. Repeat ASR runs after starting
each model/compile configuration and identify it with `--asr-model` and
`--asr-dtype`. The command never clears the TTS cache automatically; cold-cache
preparation stays operator-controlled to avoid deleting data. Record subjective
pronunciation, prosody, and audible gaps beside the JSON report before changing
streaming defaults.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot: `Discord token not provided` | `DISCORD_TOKEN` in `.env` is empty — paste your real token. |
| Bot: `GEMINI_API_KEY is not set` | Gemini needs a key. TTS/`/voice-test` work without it; the full loop needs it. |
| TTS: `... not exists` | `ref_audio_path` is resolved relative to the **GPT-SoVITS CWD**, not the bot's. Use `../TTS-KurisuMakise/害羞示范.wav` or an absolute path. |
| TTS: HTTP 400 `Please enter valid text` | Older `check_params` rejects CJK punctuation with the default split. The bot sends `text_split_method: 'cut5'`; if your GPT-SoVITS build is the older one, the per-chunk text is short enough that it usually passes. |
| TTS: `averaged_perceptron_tagger_eng not found` | English frontend missing its NLTK resource. Run `./setup-gpt-sovits.cmd` and confirm `GPT-SoVITS/nltk_data/taggers/averaged_perceptron_tagger_eng/english.pickle` exists. `start-bot.cmd` verifies this frontend before launching. |
| TTS: `not reachable at http://127.0.0.1:9880 (connection refused)` | GPT-SoVITS isn't up yet. The launcher waits for readiness; if launched manually, wait for `Uvicorn running on :9880` and the model-load logs before `/summon`. |
| Bot replies in Japanese to Chinese/English | Expected if Gemini chose Japanese for the character; the system prompt mirrors the speaker's language. `/voice-test language:zh` confirms zh TTS works in isolation. |
| Bot ignores you while it is talking | Working as designed under `BOT_INPUT_POLICY=half_duplex`. Look for `input_discarded reason=bot_speaking`. Set `latest_wins` or `barge_in` (plus `BARGE_IN_ENABLED=true`) to interrupt. |
| Short replies like "嗯" get no answer | The filler filter dropped them (`transcript_filtered reason=filler`). They are accepted when the bot's own previous reply ended in a question. |
| Bot says it can't answer, then goes quiet | Gemini quota cooldown. Check `gemini_rate_limited` for `cooldownMs`; requests resume automatically when it expires. |
| `Character card could not be loaded` at boot | `CHARACTER_PATH`/`CHARACTER_ID` do not resolve to a `card.json`. The log prints the resolved path. The bot still runs, with a generic prompt. |
| Port 9880 / 8765 in use | A previous instance didn't exit. `Stop-Process -Id <pid> -Force`. |
| First ASR call ~23s | Torch JIT warmup on first inference; subsequent calls ~1s. |

## File map

```
DC_BOT/
├── airi/services/discord-bot/src/   the bot (transport, providers, orchestration)
│   ├── voice/                       VoiceManager (transport) + types
│   ├── providers/{asr,brain,tts}/   Qwen/Gemini/GPT-SoVITS providers (interfaces + impls)
│   ├── orchestration/               controller, turn-queue, speech-chunker, telemetry
│   ├── config.ts                    centralized env config
│   └── .env                         YOUR secrets (token + Gemini key)
├── qwen3-asr/                       Python ASR service (.venv ready)
├── GPT-SoVITS/                      Python TTS (pretrained models + Kurisu config ready)
├── TTS-KurisuMakise/                trained v2Pro weights + reference clips
├── docs/                            architecture + per-phase handoffs
├── GPT_SOVITS_KURISU_SETUP.md       full TTS setup detail
└── RUNBOOK.md                       this file
```
