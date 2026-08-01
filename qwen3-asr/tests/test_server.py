"""Tests that don't require the GPU model to be loaded.

The model-dependent path is covered by a fixture-based smoke test run manually
on the GPU machine (see README). Here we test config, language normalization,
and the request validation surface.
"""
from __future__ import annotations

import io

import numpy as np
import soundfile as sf
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client() -> TestClient:
    # Skip the heavy model load during unit tests via the env flag.
    import os
    os.environ["ASR_SKIP_LOAD"] = "1"
    from app import server
    from app import model
    model.engine._ready = False  # type: ignore[attr-defined]
    with TestClient(server.app, raise_server_exceptions=False) as c:
        yield c


def _wav_bytes(samples: np.ndarray, sr: int = 16000) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, sr, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def test_normalize_language() -> None:
    from app.model import normalize_language
    assert normalize_language("Chinese") == "zh"
    assert normalize_language("English") == "en"
    assert normalize_language("Japanese") == "ja"
    assert normalize_language("日本語") == "ja"
    assert normalize_language("Mandarin") == "zh"
    assert normalize_language("中文") == "zh"
    assert normalize_language("英语") == "en"
    assert normalize_language("po") == "und"
    assert normalize_language("pt") == "und"
    assert normalize_language("Portuguese") == "und"
    assert normalize_language("") == "und"
    assert normalize_language({}) == "und"
    assert normalize_language(None) == "und"


def test_health_reports_not_ready(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is False


def test_transcribe_rejects_empty(client: TestClient) -> None:
    r = client.post("/v1/transcribe", content=b"")
    assert r.status_code == 400


def test_transcribe_rejects_garbage(client: TestClient) -> None:
    r = client.post("/v1/transcribe", content=b"not a wav")
    assert r.status_code == 400


def test_transcribe_too_short_returns_empty(client: TestClient) -> None:
    # 50ms of silence is below the 250ms floor.
    samples = np.zeros(int(16000 * 0.05), dtype=np.float32)
    r = client.post("/v1/transcribe", content=_wav_bytes(samples))
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == ""
    assert body["language"] == "und"
    assert body["hotword_mode"] == "unsupported"


def test_transcribe_too_long(client: TestClient) -> None:
    samples = np.zeros(int(16000 * 31), dtype=np.float32)
    r = client.post("/v1/transcribe", content=_wav_bytes(samples))
    assert r.status_code == 413
