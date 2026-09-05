import type { GptSoVitsLang } from './types'

export type SpeechBoundary
  = | 'sentence'
    | 'clause'
    | 'hard-limit'
    | 'control-token'
    | 'stream-end'

export interface VoiceSamplingControls {
  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number
}

export interface VoiceTimingControls {
  speedFactor: number
  fragmentInterval: number
  textSplitMethod: string
}

export interface VoiceReferenceProfile {
  id: string
  label: string
  referenceAudio: string
  referenceText: string
  promptLanguage: GptSoVitsLang
  sampling: VoiceSamplingControls
  timing: VoiceTimingControls
  variationSeeds: number[]
  warmup: boolean
}

export interface VoiceProfileCatalog {
  schemaVersion: 1
  catalogVersion: string
  defaultProfileId: string
  profiles: ReadonlyMap<string, VoiceReferenceProfile>
  emotionMap: ReadonlyMap<string, string>
}

export interface ResolvedSpeechStyle {
  emotion: string
  intensity: number
  profileId: string
  catalogVersion: string
  referenceAudio: string
  referenceText: string
  promptLanguage: GptSoVitsLang
  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number
  speedFactor: number
  fragmentInterval: number
  textSplitMethod: string
  seed: number
  variationIndex: number
}

export interface StyledSpeechChunk {
  text: string
  style: Readonly<ResolvedSpeechStyle>
  pauseBeforeMs: number
  boundary: SpeechBoundary
}
