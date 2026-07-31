# GPT-SoVITS + Kurisu Makise — Setup Guide (VERIFIED WORKING)

This stands up the local GPT-SoVITS TTS service with the trained Kurisu
Makise voice, for the Discord voice bot's `/voice-test` and the full loop.

> **Status: fully set up and verified (2026-07-30).** Both the pretrained
> models and the Kurisu config are in place. A real `/tts` request produced a
> valid 163 KB Kurisu WAV in 6.8s. Skip to **Step 2** to (re)start it.

## What's present

- `GPT-SoVITS/` — RVC-Boss upstream, HEAD `d523079`. **Pretrained models ARE
  downloaded** into `GPT-SoVITS/GPT_SoVITS/pretrained_models/` (33 files:
  v2Pro base `s1v3.ckpt` + `v2Pro/s2Gv2Pro.pth`, BERT `chinese-roberta-wwm-ext-large`,
  `chinese-hubert-base`, speaker-verification `sv/pretrained_eres2netv2w24s4ep4.ckpt`).
- `GPT-SoVITS/GPT_SoVITS/configs/tts_infer_kurisu.yaml` — points the `custom:`
  block at the trained Kurisu v2Pro weights with `device: cuda`, `is_half: true`.
- Python env: the conda env **`GPTSoVits`** at `C:\Users\lyang\miniforge3\envs\GPTSoVits`
  (Python 3.10, torch 2.11.0+cu128 with **sm_120 support for the RTX 5060 Ti**).
- `TTS-KurisuMakise/` — trained v2Pro weights (`牧懒红莉栖-e15.ckpt` 155 MB +
  `牧懒红莉栖_e4_s972.pth` 135 MB) and reference clips (`害羞示范.wav`, `无奈.wav`).
- GPU: RTX 5060 Ti (Blackwell sm_120), 16 GB VRAM. Combined Qwen-0.6B + GPT-SoVITS
  VRAM = **~8 GB / 16 GB** (measured).
- `ffmpeg` is on PATH.

## The key compatibility fact (verified by request)

The Kurisu model is **GPT-SoVITS v2Pro**. A trained model + a per-request
reference audio are used **simultaneously** — this is GPT-SoVITS's normal
mode, not a special feature. The trained `.ckpt`/`.pth` load once (the voice);
each `/tts` request supplies `ref_audio_path` to condition that voice.

## CRITICAL: ref_audio_path is resolved server-side, relative to GPT-SoVITS CWD

`api_v2.py` resolves `ref_audio_path` relative to **its own working directory**
(the `GPT-SoVITS/` repo root), NOT the bot's CWD. Since GPT-SoVITS runs from
`DC_BOT/GPT-SoVITS/`, the Kurisu clips resolve as `../TTS-KurisuMakise/<clip>.wav`.
**Use absolute paths if in doubt** — they always work.

## Step 1 (DONE) — one-time setup, for reference

If rebuilding from scratch on this machine (everything is already done):

1. The conda env `GPTSoVits` already exists with torch+cu128. Don't recreate it.
2. Pretrained models came from
   `https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models.zip`
   (4.35 GB). **The zip's top-level dir is `pretrained_models/`, but GPT-SoVITS
   code looks under `GPT_SoVITS/pretrained_models/`** — extract into
   `GPT-SoVITS/GPT_SoVITS/` (or copy the files there), NOT into the repo root.

## Step 2 — Start the GPT-SoVITS API (run each boot)

```bash
cd C:/Users/lyang/Code/DC_BOT/GPT-SoVITS
# Use the conda env's python directly (no activation needed in bash):
"C:/Users/lyang/miniforge3/envs/GPTSoVits/python.exe" api_v2.py \
  -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer_kurisu.yaml
```

Wait for `Uvicorn running on http://127.0.0.1:9880`. The `enc_q` "missing keys"
warning during load is **normal** (posterior encoder is dropped at inference).

## Step 3 — Verify (Python handles the UTF-8 reference filename)

```bash
cd C:/Users/lyang/Code/DC_BOT/GPT-SoVITS
python -c "
import urllib.request, json
body = json.dumps({
  'text': 'こんにちは。今日は何をしましょうか。',
  'text_lang': 'ja',
  'ref_audio_path': '../TTS-KurisuMakise/害羞示范.wav',
  'prompt_text': '', 'prompt_lang': 'ja',
  'media_type': 'wav', 'streaming_mode': 0,
}).encode('utf-8')
r = urllib.request.urlopen(urllib.request.Request(
  'http://127.0.0.1:9880/tts', data=body,
  headers={'Content-Type':'application/json'}), timeout=90)
d = r.read(); open('kurisu_test.wav','wb').write(d)
print(f'HTTP {r.status} | {len(d)} bytes | RIFF={d[:4]==b\"RIFF\"}')
"
# Play kurisu_test.wav to hear Kurisu.
```

## Step 4 — Wire into the bot

`airi/services/discord-bot/.env` (copy from `.env.example`):

```env
GPT_SOVITS_URL=http://127.0.0.1:9880
# Path relative to the GPT-SoVITS working directory (see CRITICAL note above):
GPT_SOVITS_REF_AUDIO=../TTS-KurisuMakise/害羞示范.wav
GPT_SOVITS_PROMPT_TEXT=
GPT_SOVITS_PROMPT_LANG=ja
GPT_SOVITS_STREAMING_MODE=0
```

Then `/summon` and `/voice-test language:ja text:"こんにちは。"`.

## Latency tuning (after correctness)

Once `/voice-test` reliably produces Kurisu audio, benchmark `streaming_mode`
(plan.md §28): `0` (whole, verified working), `1` (fragment/quality),
`2` (streaming), `3` (fast/low-quality). Change one layer at a time.

## VRAM gate (plan.md §39)

Measured with both models resident: **~8 GB / 16 GB**. Headroom remains, so
`Qwen/Qwen3-ASR-1.7B` is testable later. Never unload/reload either model
per turn.
