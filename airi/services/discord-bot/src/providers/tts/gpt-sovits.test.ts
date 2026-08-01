import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetConfigCache } from '../../config'
import { GptSoVitsTtsProvider } from './gpt-sovits'

/**
 * Regression guard for Language_Fix_Proposal §13, §24: the GPT-SoVITS request
 * must populate `text_lang` (the language being synthesized) and `prompt_lang`
 * (the configured Kurisu reference language) INDEPENDENTLY. The original bug
 * routed everything through `ja` because PROMPT_LANG was reused as the target.
 *
 * The global `fetch` is mocked so no network is involved.
 */

interface CapturedRequest {
  url: string
  body: {
    text: string
    text_lang: string
    ref_audio_path: string
    prompt_text: string
    prompt_lang: string
    media_type: string
    streaming_mode: number
    text_split_method: string
    [key: string]: unknown
  }
}

function mockFetchOk(): { fetchMock: ReturnType<typeof vi.fn>, captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = []
  const fetchMock = vi.fn().mockImplementation(async (url: string, init: RequestInit) => {
    captured.push({ url, body: JSON.parse(init.body as string) })
    const webStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x52, 0x49, 0x46, 0x46])) // "RIFF"
        controller.close()
      },
    })
    return { ok: true, status: 200, body: webStream } as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, captured }
}

describe('gptSoVitsTtsProvider — text_lang / prompt_lang separation', () => {
  beforeEach(() => {
    // Configure the Kurisu reference (prompt) language as Japanese — this must
    // NEVER change regardless of the synthesized target language.
    vi.stubEnv('GPT_SOVITS_URL', 'http://127.0.0.1:9880')
    vi.stubEnv('GPT_SOVITS_REF_AUDIO', '../TTS-KurisuMakise/害羞示范.wav')
    vi.stubEnv('GPT_SOVITS_PROMPT_TEXT', '')
    vi.stubEnv('GPT_SOVITS_PROMPT_LANG', 'ja')
    vi.stubEnv('GPT_SOVITS_STREAMING_MODE', '0')
    resetConfigCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    resetConfigCache()
  })

  it('sends text_lang=zh while keeping prompt_lang=ja for a Chinese turn', async () => {
    const { captured } = mockFetchOk()
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await provider.synthesize({ text: '你好。今天想聊些什么？', language: 'zh' }, new AbortController().signal)

    expect(captured).toHaveLength(1)
    expect(captured[0].body.text_lang).toBe('zh')
    expect(captured[0].body.prompt_lang).toBe('ja')
  })

  it('sends text_lang=en while keeping prompt_lang=ja for an English turn', async () => {
    const { captured } = mockFetchOk()
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await provider.synthesize({ text: 'Hello. What would you like to talk about?', language: 'en' }, new AbortController().signal)

    expect(captured[0].body.text_lang).toBe('en')
    expect(captured[0].body.prompt_lang).toBe('ja')
  })

  it('sends text_lang=ja and prompt_lang=ja for a Japanese turn', async () => {
    const { captured } = mockFetchOk()
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await provider.synthesize({ text: 'こんにちは。今日はいい天気ですね。', language: 'ja' }, new AbortController().signal)

    expect(captured[0].body.text_lang).toBe('ja')
    expect(captured[0].body.prompt_lang).toBe('ja')
  })

  it('forwards text_lang=auto verbatim for the auto/mixed path', async () => {
    const { captured } = mockFetchOk()
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await provider.synthesize({ text: '你好。Hello. こんにちは。', language: 'auto' }, new AbortController().signal)

    expect(captured[0].body.text_lang).toBe('auto')
    expect(captured[0].body.prompt_lang).toBe('ja')
  })

  it('always uses the configured Kurisu ref audio, independent of language', async () => {
    const { captured } = mockFetchOk()
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await provider.synthesize({ text: '你好', language: 'zh' }, new AbortController().signal)
    expect(captured[0].body.ref_audio_path).toBe('../TTS-KurisuMakise/害羞示范.wav')
  })

  it('reports an actionable message when GPT-SoVITS is unreachable (ECONNREFUSED)', async () => {
    const fetchMock = vi.fn().mockImplementation(() => {
      const err = new TypeError('fetch failed')
      ;(err as Error & { cause?: { code?: string } }).cause = { code: 'ECONNREFUSED' }
      throw err
    })
    vi.stubGlobal('fetch', fetchMock)
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await expect(
      provider.synthesize({ text: '你好', language: 'zh' }, new AbortController().signal),
    ).rejects.toThrow(/not reachable at http:\/\/127\.0\.0\.1:9880/i)
  })

  it('surfaces the NLTK averaged_perceptron_tagger_eng setup hint on HTTP 400', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Resource \'averaged_perceptron_tagger_eng\' not found.',
    } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await expect(
      provider.synthesize({ text: 'Hello', language: 'en' }, new AbortController().signal),
    ).rejects.toThrow(/averaged_perceptron_tagger_eng/)
  })

  it('sends exact resolved reference, sampling, timing, seed, and no extra splitting', async () => {
    const { captured } = mockFetchOk()
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    await provider.synthesize({
      text: '考えてみましょう。',
      language: 'ja',
      conditioning: {
        profileId: 'analytical', catalogVersion: 'kurisu-v2', referenceAudio: '../refs/think.wav', referenceText: 'これは正確な参照音声です。', promptLanguage: 'ja',
        topK: 12, topP: 0.9, temperature: 0.74, repetitionPenalty: 1.38, speedFactor: 0.99, fragmentInterval: 0.16,
        textSplitMethod: 'cut0', seed: 12002, variationIndex: 1,
      },
    }, new AbortController().signal)

    expect(captured[0].body).toMatchObject({
      ref_audio_path: '../refs/think.wav', prompt_text: 'これは正確な参照音声です。', prompt_lang: 'ja',
      top_k: 12, top_p: 0.9, temperature: 0.74, repetition_penalty: 1.38, speed_factor: 0.99,
      fragment_interval: 0.16, seed: 12002, text_split_method: 'cut0', batch_size: 1,
      split_bucket: true, parallel_infer: true,
    })
  })

  it('reports headers, first nonempty audio byte, and full-stream timing separately', async () => {
    const times = [0, 10, 30, 50]
    const events: Array<{ event: string, fields: Record<string, string | number> }> = []
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array())
          controller.enqueue(new Uint8Array([1, 2]))
          controller.close()
        },
      }),
    } as Response))
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000, { now: () => times.shift()!, onEvent: event => events.push(event) })
    const stream = await provider.synthesize({ text: 'hello', language: 'en' }, new AbortController().signal)
    for await (const _chunk of stream) { /* drain */ }

    expect(events).toEqual([
      { event: 'tts_http_headers_received', fields: { profileId: 'single-reference', streamingMode: 0, chars: 5, headersMs: 10 } },
      { event: 'tts_first_audio_byte', fields: { profileId: 'single-reference', streamingMode: 0, chars: 5, headersMs: 10, firstByteMs: 30 } },
      { event: 'tts_audio_stream_completed', fields: { profileId: 'single-reference', streamingMode: 0, chars: 5, headersMs: 10, totalStreamMs: 50 } },
    ])
  })

  it('aborts a synthesis request that exceeds its timeout', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 25)
    const pending = provider.synthesize({ text: 'こんにちは', language: 'ja' }, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' })

    await vi.advanceTimersByTimeAsync(25)
    await assertion
    vi.useRealTimers()
  })

  it('forwards a premature response-stream failure to the consumer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0x52, 0x49, 0x46, 0x46]))
          controller.error(new Error('premature close'))
        },
      }),
    } as Response)
    vi.stubGlobal('fetch', fetchMock)
    const provider = new GptSoVitsTtsProvider('http://127.0.0.1:9880', 5000)
    const stream = await provider.synthesize({ text: 'こんにちは', language: 'ja' }, new AbortController().signal)

    const consume = async () => {
      for await (const _chunk of stream) { /* consume */ }
    }
    await expect(consume()).rejects.toThrow('premature close')
  })
})
