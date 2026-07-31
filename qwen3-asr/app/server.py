"""FastAPI server exposing /v1/transcribe and /health (plan.md §17).

Run:
    uvicorn app.server:app --host 127.0.0.1 --port 8765
or:
    python -m app.server
"""
from __future__ import annotations

import io
import os
import time

import numpy as np
import soundfile as sf
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import config
from .model import engine
from .schemas import HealthResponse, TranscribeResponse

app = FastAPI(title="Qwen3-ASR", version="0.1.0")


@app.on_event("startup")
def _load_model() -> None:
    """Load the model exactly once at startup (plan.md §18)."""
    # Allow tests / dry runs to skip the heavy model load.
    if os.environ.get("ASR_SKIP_LOAD") == "1":
        return
    try:
        engine.load()
    except Exception as exc:  # noqa: BLE001
        # Log but do not crash — /health will report not ready.
        print(f"[qwen3-asr] failed to load model: {exc}")  # noqa: T201
        raise


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        ready=engine.ready,
        device=engine.device,
        model=engine.model_name,
    )


@app.post("/v1/transcribe", response_model=TranscribeResponse)
async def transcribe(request: Request) -> TranscribeResponse:
    """Transcribe a 16 kHz mono PCM16 WAV sent as the raw request body."""
    raw = await request.body()
    if not raw:
        raise HTTPException(status_code=400, detail="empty body")

    try:
        samples, sample_rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=False)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"invalid WAV: {exc}") from exc

    # soundfile returns float32 in [-1, 1]; qwen-asr accepts float numpy arrays.
    if samples.ndim == 2:
        samples = samples.mean(axis=1)  # mono-ize defensively
    audio_ms = int(len(samples) * 1000 / sample_rate)

    if audio_ms < config.ASR_MIN_AUDIO_MS:
        return TranscribeResponse(
            text="", language="und", audio_ms=audio_ms, inference_ms=0, model=engine.model_name,
        )
    if audio_ms > config.ASR_MAX_AUDIO_MS:
        raise HTTPException(status_code=413, detail=f"audio too long: {audio_ms}ms > {config.ASR_MAX_AUDIO_MS}ms")

    start = time.perf_counter()
    text, language, infer_ms = await engine.transcribe(samples, sample_rate)
    total_ms = int((time.perf_counter() - start) * 1000)

    return TranscribeResponse(
        text=text,
        language=language,
        audio_ms=audio_ms,
        inference_ms=max(infer_ms, total_ms),
        model=engine.model_name,
    )


@app.exception_handler(HTTPException)
async def _http_exc(_request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(status_code=exc.status_code, content={"error": exc.detail})


def main() -> None:
    uvicorn.run(
        "app.server:app",
        host=config.ASR_HOST,
        port=config.ASR_PORT,
        log_level="info",
    )


if __name__ == "__main__":
    main()
