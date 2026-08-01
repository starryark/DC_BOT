import type { AsrInput, AsrProvider, AsrResult } from './types'

import { config } from '../../config'
import { normalizeSupportedLanguage } from '../../orchestration/input-understanding'

export function normalizeAsrHotwords(values: readonly string[] = []): string[] {
  const result: string[] = []
  const seen = new Set<string>()
  let serializedChars = 0
  for (const raw of values) {
    const value = raw.normalize('NFKC').trim()
    if (!value || value.length > 64 || seen.has(value))
      continue
    const added = encodeURIComponent(value).length + (result.length ? 1 : 0)
    if (result.length >= 64 || serializedChars + added > 4096)
      break
    seen.add(value)
    result.push(value)
    serializedChars += added
  }
  return result
}

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
      const hotwords = normalizeAsrHotwords(input.hotwords)
      const headers: Record<string, string> = { 'Content-Type': 'audio/wav' }
      if (hotwords.length) {
        headers['X-DC-BOT-Hotword-Profile'] = 'card-v1'
        headers['X-DC-BOT-Hotwords'] = encodeURIComponent(hotwords.join(','))
      }
      if (input.languageHint)
        headers['X-DC-BOT-Language-Hint'] = input.languageHint
      const res = await fetch(`${this.baseUrl}/v1/transcribe`, {
        method: 'POST',
        headers,
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
        hotword_mode?: AsrResult['hotwordMode']
      }
      return {
        text: json.text ?? '',
        language: normalizeSupportedLanguage(json.language) ?? 'und',
        inferenceMs: json.inference_ms ?? 0,
        hotwordMode: json.hotword_mode ?? 'unsupported',
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
