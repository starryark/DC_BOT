"""Model loading and inference.

The model is loaded EXACTLY ONCE at startup and held in a process-global
singleton (plan.md §18). Per-request inference is serialized by an asyncio
lock so the GPU is never asked to run two transcriptions concurrently.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any

import numpy as np
import torch

from . import config

# Qwen3-ASR's language output is a plain-English string ("Chinese", "English",
# "Japanese"). Normalize to the BCP-ish internal codes the bot uses.
_LANGUAGE_MAP = {
    "chinese": "zh",
    "english": "en",
    "japanese": "ja",
    "日本語": "ja",
    "mandarin": "zh",
    "中文": "zh",
    "英语": "en",
    "英語": "en",
}


def normalize_language(raw: object) -> str:
    if not isinstance(raw, str) or not raw:
        return "und"
    key = raw.strip().lower()
    if key in _LANGUAGE_MAP:
        return _LANGUAGE_MAP[key]
    if key in {"ja", "zh", "en"}:
        return key
    return "und"


class AsrEngine:
    """Thin wrapper around Qwen3ASRModel with serialized inference."""

    def __init__(self) -> None:
        self.model: Any = None
        self.device: str = config.ASR_DEVICE
        self.model_name: str = config.ASR_MODEL
        self._lock = asyncio.Lock()
        self._ready = False

    def load(self) -> None:
        # Imported lazily so the module can be imported (e.g. by tests) without
        # triggering the heavy torch/qwen_asr import chain.
        from qwen_asr import Qwen3ASRModel

        dtype = _resolve_dtype(config.ASR_DTYPE)
        self.model = Qwen3ASRModel.from_pretrained(
            self.model_name,
            dtype=dtype,
            device_map=self.device,
            max_inference_batch_size=1,
            max_new_tokens=256,
        )
        self._ready = True

    @property
    def ready(self) -> bool:
        return self._ready

    async def transcribe(self, samples: np.ndarray, sample_rate: int) -> tuple[str, str, int]:
        """Run one transcription. Returns (text, language_code, inference_ms)."""
        if not self._ready or self.model is None:
            raise RuntimeError("ASR model is not loaded")

        # Serialize GPU inference (plan.md §18). The lock is acquired across the
        # blocking torch call, which is run in a thread executor so the event
        # loop stays responsive.
        def _run() -> tuple[str, str, int]:
            results = self.model.transcribe(
                audio=(samples, sample_rate),
                language=None,  # auto language identification
            )
            r = results[0]
            text = (r.text or "").strip()
            language = normalize_language(getattr(r, "language", None))
            return text, language, 0  # inference_ms filled by caller

        async with self._lock:
            start = time.perf_counter()
            text, language, _ = await asyncio.to_thread(_run)
            inference_ms = int((time.perf_counter() - start) * 1000)
            return text, language, inference_ms


def _resolve_dtype(name: str) -> Any:
    name = name.lower()
    if name == "bfloat16":
        return torch.bfloat16
    if name == "float16":
        return torch.float16
    if name == "float32":
        return torch.float32
    return torch.bfloat16


# Process-global singleton, loaded once at startup.
engine = AsrEngine()
