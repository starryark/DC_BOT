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
- **One Gemini turn per guild at a time** (FIFO queue); ASR stays concurrent.
- **Barge-in:** talking while the bot speaks stops playback + TTS instantly;
  the in-flight Gemini reply aborts once your utterance finalizes.
- **Per-turn telemetry** is logged with stage latencies (plan.md §37).

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
