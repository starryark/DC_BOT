import { Buffer } from 'node:buffer'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizeAsrHotwords, QwenHttpAsrProvider } from './qwen-http'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('qwenHttpAsrProvider — fault handling', () => {
  it('aborts a request that exceeds its timeout', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))
    const provider = new QwenHttpAsrProvider('http://127.0.0.1:8765', 25)
    const pending = provider.transcribe({ wav: Buffer.from('wav'), sampleRate: 16_000 })
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    await vi.advanceTimersByTimeAsync(25)
    await assertion
  })

  it('reports an unhealthy service after connection refusal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const provider = new QwenHttpAsrProvider('http://127.0.0.1:8765', 25)
    await expect(provider.health()).resolves.toEqual({ ready: false })
  })
})

describe('qwenHttpAsrProvider — character vocabulary', () => {
  it('normalizes, deduplicates, and bounds hotwords', () => {
    expect(normalizeAsrHotwords([' 牧瀬紅莉栖 ', '牧瀬紅莉栖', 'ＡＩ', 'x'.repeat(65)]))
      .toEqual(['牧瀬紅莉栖', 'AI'])
  })

  it('preserves the raw wav body and transports Unicode hotwords', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: '', language: 'ja', inference_ms: 1 }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const wav = Buffer.from('wav')
    await new QwenHttpAsrProvider('http://localhost', 100).transcribe({ wav, sampleRate: 16_000, hotwords: ['牧瀬紅莉栖'] })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(init.body).toBe(wav)
    expect(decodeURIComponent((init.headers as Record<string, string>)['X-DC-BOT-Hotwords']!)).toBe('牧瀬紅莉栖')
  })
})
