import type { ResolvedSpeechStyle, VoiceProfileCatalog, VoiceReferenceProfile } from '../providers/tts/speech-style-types'

import { describe, expect, it } from 'vitest'

import { chunkStyledSpeechStream, StyleAwareSpeechChunker } from './style-aware-speech-chunker'

function profile(id: string, seed: number): VoiceReferenceProfile {
  return {
    id,
    label: id,
    referenceAudio: `${id}.wav`,
    referenceText: `${id} text`,
    promptLanguage: 'ja',
    sampling: { topK: 10, topP: 0.9, temperature: 0.8, repetitionPenalty: 1.3 },
    timing: { speedFactor: 1, fragmentInterval: 0.1, textSplitMethod: 'cut0' },
    variationSeeds: [seed],
    warmup: false,
  }
}

const neutral = profile('neutral', 1)
const think = profile('analytical', 2)
const surprised = profile('surprised', 3)
const catalog: VoiceProfileCatalog = {
  schemaVersion: 1,
  catalogVersion: 'v1',
  defaultProfileId: 'neutral',
  profiles: new Map([['neutral', neutral], ['analytical', think], ['surprised', surprised]]),
  emotionMap: new Map([['think', 'analytical'], ['surprised', 'surprised']]),
}
const neutralStyle: ResolvedSpeechStyle = {
  emotion: 'neutral',
  intensity: 1,
  profileId: 'neutral',
  catalogVersion: 'v1',
  referenceAudio: 'neutral.wav',
  referenceText: 'neutral text',
  promptLanguage: 'ja',
  topK: 10,
  topP: 0.9,
  temperature: 0.8,
  repetitionPenalty: 1.3,
  speedFactor: 1,
  fragmentInterval: 0.1,
  textSplitMethod: 'cut0',
  seed: 1,
  variationIndex: 0,
}

function chunker(maxModelPauseMs = 350) {
  return new StyleAwareSpeechChunker({ catalog, neutralStyle, turnId: 'turn', maxModelPauseMs })
}

describe('styleAwareSpeechChunker', () => {
  it('flushes before ACT and never mutates the earlier style snapshot', () => {
    const value = chunker()
    value.push({ kind: 'action', action: { emotion: 'think', intensity: 1 } })
    expect(value.push({ kind: 'text', delta: 'First clause' })).toEqual([])
    const first = value.push({ kind: 'action', action: { emotion: 'surprised', intensity: 1 } })[0]!
    value.push({ kind: 'text', delta: 'Second clause!' })
    const second = value.flush()[0]!

    expect(first.boundary).toBe('control-token')
    expect(first.style.profileId).toBe('analytical')
    expect(second.style.profileId).toBe('surprised')
    expect(first.style.profileId).toBe('analytical')
    expect(Object.isFrozen(first.style)).toBe(true)
  })

  it('caps accumulated delays and applies them only to following speech', () => {
    const value = chunker(350)
    value.push({ kind: 'text', delta: 'Before' })
    const before = value.push({ kind: 'delay', requestedMs: 300 })[0]!
    value.push({ kind: 'delay', requestedMs: 300 })
    value.push({ kind: 'text', delta: 'After' })
    const after = value.flush()[0]!

    expect(before.pauseBeforeMs).toBe(0)
    expect(after.pauseBeforeMs).toBe(350)
  })

  it('does not emit dead air for a trailing delay', () => {
    const value = chunker()
    value.push({ kind: 'delay', requestedMs: 300 })
    expect(value.flush()).toEqual([])
  })

  it('publishes each avatar action before activating its speech style', () => {
    const seen: string[] = []
    const value = new StyleAwareSpeechChunker({
      catalog,
      neutralStyle,
      turnId: 'turn',
      maxModelPauseMs: 350,
      onAvatarAction: action => seen.push(action.emotion ?? ''),
    })

    value.push({ kind: 'action', action: { emotion: 'think' } })
    expect(seen).toEqual(['think'])
    value.push({ kind: 'text', delta: 'Following speech' })
    expect(value.flush()[0]?.style.profileId).toBe('analytical')
  })

  it('redacts split prompt-local references before chunks reach TTS', async () => {
    async function* events() {
      yield { kind: 'text' as const, delta: 'Never speak p_' }
      yield { kind: 'text' as const, delta: '1 or MEMORY_PERSON_2 or P3!' }
    }
    const chunks = []
    for await (const chunk of chunkStyledSpeechStream(events(), { catalog, neutralStyle, turnId: 'turn', maxModelPauseMs: 350 }))
      chunks.push(chunk.text)
    expect(chunks.join(' ')).toBe('Never speak someone or someone or someone!')
  })
})
