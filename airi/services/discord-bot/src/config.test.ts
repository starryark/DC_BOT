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

  it('configures catalog mode, pause capping, and warmup independently', () => {
    vi.stubEnv('GPT_SOVITS_VOICE_PROFILES_FILE', ' ../../../voice-profiles.local.json ')
    vi.stubEnv('GPT_SOVITS_MAX_MODEL_PAUSE_MS', '600')
    vi.stubEnv('GPT_SOVITS_WARMUP_ENABLED', 'false')
    resetConfigCache()

    expect(config().tts.voiceProfilesFile).toBe('../../../voice-profiles.local.json')
    expect(config().tts.maxModelPauseMs).toBe(600)
    expect(config().tts.warmupEnabled).toBe(false)
  })

  it('uses safe defaults for invalid voice-style settings', () => {
    vi.stubEnv('GPT_SOVITS_MAX_MODEL_PAUSE_MS', '-1')
    vi.stubEnv('GPT_SOVITS_WARMUP_ENABLED', 'maybe')
    resetConfigCache()

    expect(config().tts.voiceProfilesFile).toBe('')
    expect(config().tts.maxModelPauseMs).toBe(350)
    expect(config().tts.warmupEnabled).toBe(true)
  })
})
