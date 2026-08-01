import type { ResolvedSpeechStyle, VoiceProfileCatalog, VoiceReferenceProfile } from '../providers/tts/speech-style-types'

import { describe, expect, it } from 'vitest'

import { resolveSpeechStyle } from './speech-style-resolver'

function profile(id: string, topK: number, speedFactor: number, seeds: number[]): VoiceReferenceProfile {
  return {
    id,
    label: id,
    referenceAudio: `${id}.wav`,
    referenceText: `${id} transcript`,
    promptLanguage: 'ja',
    sampling: { topK, topP: 0.9, temperature: 0.8, repetitionPenalty: 1.3 },
    timing: { speedFactor, fragmentInterval: 0.1, textSplitMethod: 'cut0' },
    variationSeeds: seeds,
    warmup: false,
  }
}

const neutralProfile = profile('neutral', 10, 1, [11, 12])
const analyticalProfile = profile('analytical', 20, 1.1, [21, 22, 23])
const catalog: VoiceProfileCatalog = {
  schemaVersion: 1,
  catalogVersion: 'v1',
  defaultProfileId: 'neutral',
  profiles: new Map([['neutral', neutralProfile], ['analytical', analyticalProfile]]),
  emotionMap: new Map([['neutral', 'neutral'], ['think', 'analytical'], ['missing', 'unavailable']]),
}
const neutralStyle: ResolvedSpeechStyle = {
  emotion: 'neutral',
  intensity: 1,
  profileId: 'neutral',
  catalogVersion: 'v1',
  referenceAudio: 'neutral.wav',
  referenceText: 'neutral transcript',
  promptLanguage: 'ja',
  topK: 10,
  topP: 0.9,
  temperature: 0.8,
  repetitionPenalty: 1.3,
  speedFactor: 1,
  fragmentInterval: 0.1,
  textSplitMethod: 'cut0',
  seed: 11,
  variationIndex: 0,
}

describe('resolveSpeechStyle', () => {
  it('normalizes emotion and interpolates numeric controls by clamped intensity', () => {
    const style = resolveSpeechStyle({ action: { emotion: ' THINK ', intensity: 0.5 }, catalog, neutralStyle, turnId: 'turn', chunkIndex: 0, text: 'hi' })
    expect(style.profileId).toBe('analytical')
    expect(style.emotion).toBe('think')
    expect(style.topK).toBe(15)
    expect(style.speedFactor).toBeCloseTo(1.05)
    expect(Object.isFrozen(style)).toBe(true)
  })

  it('falls back to the default for unknown and unavailable mappings', () => {
    for (const emotion of ['unknown', 'missing']) {
      const style = resolveSpeechStyle({ action: { emotion }, catalog, neutralStyle, turnId: 'turn', chunkIndex: 0, text: '' })
      expect(style.profileId).toBe('neutral')
    }
  })

  it('chooses the same seed for retries of the same chunk', () => {
    const input = { action: { emotion: 'think' }, catalog, neutralStyle, turnId: 'turn-7', chunkIndex: 2, text: 'same' }
    expect(resolveSpeechStyle(input).seed).toBe(resolveSpeechStyle(input).seed)
    expect(analyticalProfile.variationSeeds).toContain(resolveSpeechStyle(input).seed)
  })
})
