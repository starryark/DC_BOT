import { Buffer } from 'node:buffer'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { QwenHttpAsrProvider } from './qwen-http'

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
