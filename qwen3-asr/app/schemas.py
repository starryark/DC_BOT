"""Pydantic response schemas (plan.md §17)."""
from __future__ import annotations

from pydantic import BaseModel


class TranscribeResponse(BaseModel):
    text: str
    language: str
    audio_ms: int
    inference_ms: int
    model: str
    hotword_mode: str = "unsupported"


class HealthResponse(BaseModel):
    ready: bool
    device: str
    model: str
