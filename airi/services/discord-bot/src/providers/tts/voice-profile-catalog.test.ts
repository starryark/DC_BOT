import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { createSingleReferenceCatalog, loadVoiceProfileCatalog, parseVoiceProfileCatalog } from './voice-profile-catalog'

function validCatalog() {
  return {
    schemaVersion: 1,
    catalogVersion: 'test-v1',
    defaultProfile: 'neutral',
    profiles: {
      neutral: {
        label: 'Neutral',
        referenceAudio: 'neutral.wav',
        referenceText: 'exact words',
        promptLanguage: 'ja',
        topK: 15,
        topP: 0.95,
        temperature: 0.85,
        repetitionPenalty: 1.35,
        speedFactor: 1,
        fragmentInterval: 0.12,
        textSplitMethod: 'cut0',
        variationSeeds: [11],
        warmup: true,
      },
      surprised: {
        label: 'Surprised',
        referenceAudio: 'surprised.wav',
        referenceText: '本当なの？',
        promptLanguage: 'ja',
        topK: 20,
        topP: 0.98,
        temperature: 1,
        repetitionPenalty: 1.3,
        speedFactor: 1.03,
        fragmentInterval: 0.08,
        textSplitMethod: 'cut0',
        variationSeeds: [21, 22],
        warmup: false,
      },
    },
    emotionMap: { neutral: 'neutral', surprised: 'surprised' },
  }
}

describe('voice profile catalog', () => {
  it('loads and normalizes a valid catalog', () => {
    const catalog = parseVoiceProfileCatalog(validCatalog())

    expect(catalog.defaultProfileId).toBe('neutral')
    expect(catalog.profiles.get('surprised')?.sampling.topK).toBe(20)
    expect(catalog.emotionMap.get('surprised')).toBe('surprised')
  })

  it('reports missing files and invalid JSON without falling back', async () => {
    const singleReference = { referenceAudio: 'legacy.wav', referenceText: 'legacy words', promptLanguage: 'ja' as const }
    await expect(loadVoiceProfileCatalog({ filePath: join('missing', 'profiles.json'), singleReference })).rejects.toThrow('Unable to read')
    await expect(loadVoiceProfileCatalog({ filePath: import.meta.filename, singleReference })).rejects.toThrow('Invalid JSON')
  })

  it.each([
    ['wrong schema version', (value: ReturnType<typeof validCatalog>) => { value.schemaVersion = 2 }],
    ['empty catalog version', (value: ReturnType<typeof validCatalog>) => { value.catalogVersion = '' }],
    ['unsupported prompt language', (value: ReturnType<typeof validCatalog>) => { value.profiles.neutral.promptLanguage = 'fr' }],
    ['parameter outside bounds', (value: ReturnType<typeof validCatalog>) => { value.profiles.neutral.speedFactor = 1.2 }],
  ])('rejects %s', (_name, mutate) => {
    const value = validCatalog()
    mutate(value)
    expect(() => parseVoiceProfileCatalog(value)).toThrow('Invalid voice profile catalog')
  })

  it('rejects a missing or incomplete default profile', () => {
    const missing = validCatalog()
    missing.defaultProfile = 'absent'
    expect(() => parseVoiceProfileCatalog(missing)).toThrow('default profile \'absent\' does not exist')

    const incomplete = validCatalog()
    incomplete.profiles.neutral.referenceText = ''
    expect(() => parseVoiceProfileCatalog(incomplete)).toThrow('missing referenceText')

    const seedless = validCatalog()
    seedless.profiles.neutral.variationSeeds = []
    expect(() => parseVoiceProfileCatalog(seedless)).toThrow('has no variation seeds')
  })

  it('disables incomplete optional profiles and maps their emotions to neutral', () => {
    const value = validCatalog()
    value.profiles.surprised.referenceText = ''
    const warning = vi.fn()
    const catalog = parseVoiceProfileCatalog(value, warning)

    expect(catalog.profiles.has('surprised')).toBe(false)
    expect(catalog.emotionMap.get('surprised')).toBe('neutral')
    expect(warning).toHaveBeenCalledWith({ kind: 'profile-disabled', profileId: 'surprised', reason: 'missing_reference_text' })
    expect(warning).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warning.mock.calls)).not.toContain('本当なの')
  })

  it('warns and falls back for an unknown emotion-map target', () => {
    const value = validCatalog()
    value.emotionMap.surprised = 'missing'
    const warning = vi.fn()
    const catalog = parseVoiceProfileCatalog(value, warning)

    expect(catalog.emotionMap.get('surprised')).toBe('neutral')
    expect(warning).toHaveBeenCalledWith({ kind: 'emotion-map-fallback', emotion: 'surprised', profileId: 'missing', reason: 'unknown_or_unavailable_profile' })
  })

  it('creates explicit single-reference mode only when requested', async () => {
    const input = { referenceAudio: 'legacy.wav', referenceText: 'exact legacy words', promptLanguage: 'ja' as const }
    const direct = createSingleReferenceCatalog(input)
    const loaded = await loadVoiceProfileCatalog({ filePath: '', singleReference: input })

    expect(direct.defaultProfileId).toBe('neutral')
    expect(loaded.profiles.get('neutral')?.referenceText).toBe('exact legacy words')
    expect(() => createSingleReferenceCatalog({ ...input, referenceText: '' })).toThrow('exact reference transcript')
  })
})
