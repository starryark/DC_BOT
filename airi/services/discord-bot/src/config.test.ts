import { afterEach, describe, expect, it, vi } from 'vitest'

import { config, resetConfigCache } from './config'

afterEach(() => {
  vi.unstubAllEnvs()
  resetConfigCache()
})

describe('runtime config numeric bounds', () => {
  it('falls back for non-positive timeouts and unsafe conversation bounds', () => {
    vi.stubEnv('ASR_REQUEST_TIMEOUT_MS', '0')
    vi.stubEnv('GPT_SOVITS_REQUEST_TIMEOUT_MS', '-1')
    vi.stubEnv('CONVERSATION_MAX_MESSAGES', '1001')
    resetConfigCache()

    expect(config().asr.requestTimeoutMs).toBe(15_000)
    expect(config().tts.requestTimeoutMs).toBe(30_000)
    expect(config().brain.maxMessages).toBe(24)
  })

  it('accepts only the supported integer GPT-SoVITS streaming modes', () => {
    vi.stubEnv('GPT_SOVITS_STREAMING_MODE', '2')
    resetConfigCache()
    expect(config().tts.streamingMode).toBe(2)

    vi.stubEnv('GPT_SOVITS_STREAMING_MODE', '4')
    resetConfigCache()
    expect(config().tts.streamingMode).toBe(0)
  })
})
