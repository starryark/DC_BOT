# Phase 2 Handoff — Qwen3-ASR

## Files changed
### Python service (new, at `DC_BOT/qwen3-asr/`)
- `pyproject.toml` — deps: `qwen-asr==0.0.6` (pins `transformers==4.57.6`), `fastapi[standard]`, `pydantic`, `numpy<2.0`, `soundfile`, `librosa==0.10.2`, `uvicorn`. **torch must be installed separately** (matching CUDA build) — it's not a declared qwen-asr dep.
- `app/__init__.py`, `app/config.py` (env-driven settings), `app/schemas.py` (Pydantic), `app/model.py` (`AsrEngine` singleton + language normalization), `app/server.py` (FastAPI `/v1/transcribe` + `/health`).
- `tests/test_server.py` — model-free unit tests (config, language map, request validation).
- `README.md` — setup/run/config.

### Node client (new, in discord-bot)
- `src/providers/asr/types.ts` — `AsrProvider`, `AsrResult`, `AsrInput`.
- `src/providers/asr/qwen-http.ts` — `QwenHttpAsrProvider` (global `fetch`, abort+timeout, no temp files).

### Cleanup
- **Deleted** `src/pipelines/tts.ts` (the misnamed STT file) and the now-empty `pipelines/` dir. All its exports were dead after Phase 1.

## Public interfaces
- Python: `POST /v1/transcribe` (body = 16k mono PCM16 WAV) → `{text, language, audio_ms, inference_ms, model}`; `GET /health` → `{ready, device, model}`. Loopback only.
- Node: `new QwenHttpAsrProvider()`; `transcribe({wav, sampleRate:16000})` → `AsrResult`; `health()`.

## Configuration added
`ASR_BASE_URL=http://127.0.0.1:8765`, `ASR_REQUEST_TIMEOUT_MS=15000` (in `config.ts` + `.env.example`). Python side: `ASR_MODEL`, `ASR_HOST`, `ASR_PORT`, `ASR_DEVICE`, `ASR_DTYPE`, `ASR_MIN_AUDIO_MS`, `ASR_MAX_AUDIO_MS`.

## Verified API facts (from official qwen-asr 0.0.6 docs)
- `from qwen_asr import Qwen3ASRModel`
- `Qwen3ASRModel.from_pretrained("Qwen/Qwen3-ASR-0.6B", dtype=torch.bfloat16, device_map="cuda:0", max_inference_batch_size=1, max_new_tokens=256)`
- `model.transcribe(audio=(np.ndarray, sr), language=None)` → returns **list**; use `results[0].text` / `results[0].language`.
- `language=None` = auto language ID; returns English strings ("Chinese"/"English"/"Japanese"), normalized to `zh|en|ja`.
- Offline (non-vLLM) inference confirmed supported; streaming requires vLLM (deferred per plan.md §50).

## Assumptions
- `soundfile.read` accepts the WAV the Node side builds (`convertOpusToWav`, 44-byte header + PCM16). soundfile returns float32; passed straight to qwen-asr.
- Inference is serialized via an asyncio lock + `asyncio.to_thread` so the event loop stays responsive while torch blocks.

## Known issues
- **Unit tests NOT executed**: this machine has Python 3.13 but the ASR deps aren't installed (and `qwen-asr` needs `<3.13` + a CUDA torch). The tests are written to run in the GPU venv during Phase 4 setup. This is honestly reported, not verified.
- discord-bot's now-unused deps (`@huggingface/transformers`, `@xsai/generate-transcription`, `@xsai-ext/providers`, `@xsai/generate-speech`, `@xsai/shared-chat`, `@xsai/generate-text`, `@proj-airi/audio`) are left in package.json to minimize lockfile churn; they're confirmed unused in src and can be removed in a cleanup pass once the loop is end-to-end.

## Tests run
- `pnpm -F @proj-airi/discord-bot typecheck` → **PASS**.

## Integration instructions
- The ConversationController (Phase 5) constructs `new QwenHttpAsrProvider()` and calls `transcribe({ wav: convertOpusToWav(utterance.pcm), sampleRate: 16000 })` on each `utterance` event.
- A temporary Phase-2 adapter listener (added when ASR service is running) logs `{language, text, inferenceMs}` per utterance (plan.md §45).
