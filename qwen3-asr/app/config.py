"""Runtime configuration for the Qwen3-ASR service.

All settings come from environment variables with safe defaults. The service
binds to 127.0.0.1 only — it is never exposed externally (plan.md §17).
"""
from __future__ import annotations

import os


def get_str(key: str, default: str) -> str:
    return os.environ.get(key, default)


def get_int(key: str, default: int) -> int:
    raw = os.environ.get(key)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


# Model: start with 0.6B (plan.md §1). Switching to 1.7B is a one-line change.
ASR_MODEL = get_str("ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")

# Bind address — loopback only.
ASR_HOST = get_str("ASR_HOST", "127.0.0.1")
ASR_PORT = get_int("ASR_PORT", 8765)

# Device + dtype.
ASR_DEVICE = get_str("ASR_DEVICE", "cuda:0")
# "bfloat16", "float16", or "float32". bf16 is preferred when the GPU supports it.
ASR_DTYPE = get_str("ASR_DTYPE", "bfloat16")

# Reject audio shorter than this (ms) — noise / accidental triggers.
ASR_MIN_AUDIO_MS = get_int("ASR_MIN_AUDIO_MS", 250)
# Hard cap on audio length (ms). The Discord transport already caps utterances
# at 30s; this is a second line of defense.
ASR_MAX_AUDIO_MS = get_int("ASR_MAX_AUDIO_MS", 30000)
