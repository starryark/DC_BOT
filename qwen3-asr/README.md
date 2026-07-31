# qwen3-asr

Local Qwen3-ASR transcription service for the Discord voice bot. Runs as a
separate Python process (plan.md §16–18) and exposes a tiny HTTP API the
Node `discord-bot` calls per finalized utterance.

> **Status: fully set up and verified (2026-07-30)** on this machine. The
> `.venv` exists with torch+cu128 + qwen-asr; unit tests pass; a real ja/zh/en
> transcription smoke test matched expected text with correct auto language ID
> (~1s steady-state). Skip to **Run** to (re)start it.

## Endpoints (loopback only, `127.0.0.1:8765`)

- `GET /health` → `{ ready, device, model }`
- `POST /v1/transcribe` — body is a 16 kHz mono PCM16 WAV. Returns:
  ```json
  { "text": "...", "language": "ja", "audio_ms": 2140, "inference_ms": 977, "model": "Qwen/Qwen3-ASR-0.6B" }
  ```

Language is auto-detected (`language=None`) and normalized to `zh|en|ja`.

## Setup (one-time; ALREADY DONE on this machine)

Uses `uv` (installed) to create a Python 3.11 venv. The RTX 5060 Ti is
Blackwell (sm_120) and **requires cu128** — the older cu124 torch does NOT
support it. `qwen-asr==0.0.6` pins `transformers==4.57.6` and needs Python `<3.13`,
which is why it gets its own venv separate from GPT-SoVITS (which uses 4.50.0).

```bash
# from DC_BOT/qwen3-asr
uv venv --python 3.11 .venv
# 1. torch+cu128 (sm_120 / Blackwell support):
uv pip install --python .venv/Scripts/python.exe torch torchaudio \
  --index-url https://download.pytorch.org/whl/cu128
# 2. qwen-asr + service deps (note: qwen-asr pins transformers==4.57.6):
uv pip install --python .venv/Scripts/python.exe \
  "qwen-asr==0.0.6" "fastapi[standard]" "pydantic>=2.9,<2.11" \
  soundfile "librosa==0.10.2" uvicorn pytest httpx
```

## Run (each boot)

```bash
cd C:/Users/lyang/Code/DC_BOT/qwen3-asr
.venv/Scripts/python.exe -m app.server
```

The model downloads from HuggingFace on first start (~1.5 GB, cached after),
loads once onto the GPU, and `/health` reports `ready: true` (~40s cold).
First transcription is slow (~23s, torch JIT warmup); steady-state is ~1s.

## Tests

```bash
.venv/Scripts/python.exe -m pytest -q
```

Unit tests set `ASR_SKIP_LOAD=1` to skip the heavy model load (config, language
normalization, request validation). 6 tests, ~3s. **All pass.**

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `ASR_MODEL` | `Qwen/Qwen3-ASR-0.6B` | HF model id. Switch to `Qwen/Qwen3-ASR-1.7B` to trade VRAM for accuracy. |
| `ASR_HOST` | `127.0.0.1` | Bind host (loopback only). |
| `ASR_PORT` | `8765` | Bind port. |
| `ASR_DEVICE` | `cuda:0` | Torch device_map. |
| `ASR_DTYPE` | `bfloat16` | `bfloat16` / `float16` / `float32`. |
| `ASR_MIN_AUDIO_MS` | `250` | Reject audio shorter than this. |
| `ASR_MAX_AUDIO_MS` | `30000` | Reject audio longer than this. |

## Tests

```bash
pytest -q
```

The unit tests do not load the model (they cover config, language
normalization, and request validation). The model-dependent path is a manual
GPU smoke test: point the bot at the service and check the Phase 2 logs.
