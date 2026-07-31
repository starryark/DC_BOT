# Phase 6 Handoff — Runtime Bring-up (VERIFIED)

After the user said "proceed, you have full access," I stood up the entire GPU
runtime and verified both AI services end-to-end with real requests.

## Environment discovered on the machine
- **uv 0.11.7** + **conda** (miniforge3) both present.
- **CUDA 13.3** toolkit + nvcc; **ffmpeg** + **git-lfs** on PATH; 953 GB free.
- A pre-existing **`GPTSoVits` conda env** at `miniforge3/envs/GPTSoVits` with
  **torch 2.11.0+cu128 (sm_120 / Blackwell ✓)**, all GPT-SoVITS deps.
- A **pre-existing running stack** at `C:\AI`: GPT-SoVITS (Kurisu v2Pro) on :9880
  + an `airi_bridge` on :9000. → User chose to **replace it with the DC_BOT
  instance and stop the bridge**. Both stopped (pids 3640, 20808).

## Actions taken
1. Downloaded `pretrained_models.zip` (4.35 GB) from HF `XXXXRT/GPT-SoVITS-Pretrained`.
2. Extracted into `GPT-SoVITS/GPT_SoVITS/pretrained_models/` (33 files). **Gotcha
   found & fixed:** the zip's top dir is `pretrained_models/` but GPT-SoVITS code
   looks under `GPT_SoVITS/pretrained_models/` — had to copy, not extract at root.
3. Created `qwen3-asr/.venv` (Python 3.11 via uv) + torch+cu128 + qwen-asr 0.0.6.
4. Fixed ASR test (`ASR_SKIP_LOAD=1` env flag) → **6/6 unit tests pass**.
5. Stopped old :9880 + :9000; started DC_BOT GPT-SoVITS with `tts_infer_kurisu.yaml`.
6. Appended non-secret config keys to `airi/services/discord-bot/.env`.

## Verified results (real requests, not simulations)
- **TTS:** `/tts` with Kurisu ref → **HTTP 200, 163 KB valid WAV (RIFF), 6.8s**.
  Confirms the "trained model + reference audio simultaneously" capability.
- **ASR:** transcribed ja/zh/en samples with **correct text + correct auto
  language ID** (ja/zh/en), ~1s steady-state (23s first call = JIT warmup).
- **VRAM:** Qwen 0.6B + GPT-SoVITS resident = **~8 GB / 16 GB**. 1.7B is testable.
- **Bot boot:** constructs all providers, logs `Direct backend active: Qwen ASR → Gemini → GPT-SoVITS`, typecheck clean.

## Critical gotchas documented
1. **`ref_audio_path` resolves relative to GPT-SoVITS CWD**, not the bot's. Use
   `../TTS-KurisuMakise/害羞示范.wav` (or absolute). The `.env` + setup doc are fixed.
2. **UTF-8 filenames** (`害羞示范.wav`) get mangled through curl on Windows —
   the Node provider sends them in a JSON body via `fetch`, which is correct.
3. **cu124 torch does NOT support RTX 5060 Ti (sm_120)** — must use cu128. Both
   envs use torch 2.11+cu128.

## NOT done (requires user secrets)
- **`DISCORD_TOKEN`** in `.env` is literally `''` (placeholder). Bot won't log in
  until the user pastes a real token.
- **`GEMINI_API_KEY`** is empty. `/voice-test` works without it; the full loop
  (voice → Gemini → TTS) needs it.

## Services currently running
- GPT-SoVITS Kurisu on `127.0.0.1:9880` (pid 9752) — leave running.
- Qwen3-ASR on `127.0.0.1:8765` (pid 20476) — leave running.
- Bot: not running (needs token).

## Docs updated
- `GPT_SOVITS_KURISU_SETUP.md` — rewritten to reflect verified state.
- `qwen3-asr/README.md` — rewritten with uv + cu128 workflow.
- `RUNBOOK.md` (new) — consolidated start/verify/use/troubleshoot guide.
- `.env.example` + `.env` — correct `GPT_SOVITS_REF_AUDIO` path.
