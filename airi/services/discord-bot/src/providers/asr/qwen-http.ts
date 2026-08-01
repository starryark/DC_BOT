import type { AsrInput, AsrProvider, AsrResult } from './types'

import { config } from '../../config'
import { normalizeSupportedLanguage } from '../../orchestration/input-understanding'

/**
 * Talks to the local Python `qwen3-asr` service over HTTP. No temp files, no
 * OpenAI transcription API (plan.md §19). Uses the global `fetch`.
 *
 * The request body is the raw 16 kHz mono PCM16 WAV built by
 * `convertOpusToWav` from the transport's utterance PCM.
 */
export class QwenHttpAsrProvider implements AsrProvider {
  private readonly baseUrl: string
  private readonly timeoutMs: number

  constructor(baseUrl?: string, timeoutMs?: number) {
    this.baseUrl = (baseUrl ?? config().asr.baseUrl).replace(/\/$/, '')
    this.timeoutMs = timeoutMs ?? config().asr.requestTimeoutMs
  }

  async transcribe(input: AsrInput): Promise<AsrResult> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(`${this.baseUrl}/v1/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: input.wav,
        signal: controller.signal,
      })
      if (!res.ok) {
        const detail = await res.text().catch(() => res.statusText)
        throw new Error(`ASR ${res.status}: ${detail}`)
      }
      const json = (await res.json()) as {
        text: string
        language: string
        inference_ms: number
      }
      return {
        text: json.text ?? '',
        language: normalizeSupportedLanguage(json.language) ?? 'und',
        inferenceMs: json.inference_ms ?? 0,
      }
    }
    finally {
      clearTimeout(timer)
    }
  }

  async health(): Promise<{ ready: boolean }> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { method: 'GET' })
      if (!res.ok)
        return { ready: false }
      const json = (await res.json()) as { ready: boolean }
      return { ready: !!json.ready }
    }
    catch {
      return { ready: false }
    }
  }
}
