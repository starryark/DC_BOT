import type { ResolvedSpeechStyle, VoiceProfileCatalog } from '../providers/tts/speech-style-types'
import type { AvatarAction } from './output'

export interface ResolveSpeechStyleInput {
  action?: AvatarAction
  catalog: VoiceProfileCatalog
  neutralStyle: ResolvedSpeechStyle
  turnId: string
  chunkIndex: number
  text: string
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** Resolve an ACT action into a reproducible, immutable acoustic style. */
export function resolveSpeechStyle(input: ResolveSpeechStyleInput): Readonly<ResolvedSpeechStyle> {
  const emotion = input.action?.emotion?.trim().toLowerCase() || 'neutral'
  const rawIntensity = input.action?.intensity ?? 1
  const intensity = clamp(Number.isFinite(rawIntensity) ? rawIntensity : 1, 0, 1)
  const mappedId = input.catalog.emotionMap.get(emotion)
  const selected = (mappedId && input.catalog.profiles.get(mappedId))
    ?? input.catalog.profiles.get(input.catalog.defaultProfileId)

  if (!selected)
    throw new Error(`Default voice profile is unavailable: ${input.catalog.defaultProfileId}`)

  const variationIndex = stableHash([
    input.turnId,
    selected.id,
    String(input.chunkIndex),
    input.catalog.catalogVersion,
  ].join('\0')) % selected.variationSeeds.length
  const seed = selected.variationSeeds[variationIndex]
  if (seed === undefined)
    throw new Error(`Voice profile has no variation seeds: ${selected.id}`)

  const interpolate = (neutral: number, target: number): number => neutral + (target - neutral) * intensity
  const style: ResolvedSpeechStyle = {
    emotion,
    intensity,
    profileId: selected.id,
    catalogVersion: input.catalog.catalogVersion,
    referenceAudio: selected.referenceAudio,
    referenceText: selected.referenceText,
    promptLanguage: selected.promptLanguage,
    topK: Math.round(clamp(interpolate(input.neutralStyle.topK, selected.sampling.topK), 1, 100)),
    topP: clamp(interpolate(input.neutralStyle.topP, selected.sampling.topP), 0.01, 1),
    temperature: clamp(interpolate(input.neutralStyle.temperature, selected.sampling.temperature), 0.1, 2),
    repetitionPenalty: clamp(interpolate(input.neutralStyle.repetitionPenalty, selected.sampling.repetitionPenalty), 0.1, 2),
    speedFactor: clamp(interpolate(input.neutralStyle.speedFactor, selected.timing.speedFactor), 0.9, 1.1),
    fragmentInterval: clamp(interpolate(input.neutralStyle.fragmentInterval, selected.timing.fragmentInterval), 0, 1),
    textSplitMethod: selected.timing.textSplitMethod,
    seed,
    variationIndex,
  }
  return Object.freeze(style)
}

/** FNV-1a over UTF-16 code units; stable across processes and JS runtimes. */
function stableHash(value: string): number {
  let hash = 0x811C9DC5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}
