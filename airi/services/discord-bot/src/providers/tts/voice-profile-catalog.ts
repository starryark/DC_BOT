import { readFile } from 'node:fs/promises'
import * as v from 'valibot'

import type { GptSoVitsLang } from './types'
import type { VoiceProfileCatalog, VoiceReferenceProfile } from './speech-style-types'

const profileIdPattern = /^[a-z0-9][a-z0-9_-]*$/
const profileId = v.pipe(v.string(), v.regex(profileIdPattern))
const nonempty = v.pipe(v.string(), v.trim(), v.minLength(1))
const promptLanguage = v.picklist(['zh', 'en', 'ja', 'auto'] as const)

const profileSchema = v.object({
  label: nonempty,
  referenceAudio: v.string(),
  referenceText: v.string(),
  promptLanguage,
  topK: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
  topP: v.pipe(v.number(), v.minValue(Number.MIN_VALUE), v.maxValue(1)),
  temperature: v.pipe(v.number(), v.minValue(0.1), v.maxValue(2)),
  repetitionPenalty: v.pipe(v.number(), v.minValue(0.5), v.maxValue(2)),
  speedFactor: v.pipe(v.number(), v.minValue(0.9), v.maxValue(1.1)),
  fragmentInterval: v.pipe(v.number(), v.minValue(0), v.maxValue(1)),
  textSplitMethod: v.literal('cut0'),
  variationSeeds: v.array(v.pipe(v.number(), v.integer(), v.minValue(1))),
  warmup: v.boolean(),
})

const catalogSchema = v.object({
  schemaVersion: v.literal(1),
  catalogVersion: nonempty,
  defaultProfile: profileId,
  profiles: v.record(profileId, profileSchema),
  emotionMap: v.record(nonempty, profileId),
})

type CatalogInput = v.InferOutput<typeof catalogSchema>
type ProfileInput = v.InferOutput<typeof profileSchema>

export type VoiceProfileWarning =
  | { kind: 'profile-disabled'; profileId: string; reason: 'missing_reference_audio' | 'missing_reference_text' | 'empty_variation_seeds' }
  | { kind: 'emotion-map-fallback'; emotion: string; profileId: string; reason: 'unknown_or_unavailable_profile' }

export interface SingleReferenceProfileInput {
  referenceAudio: string
  referenceText: string
  promptLanguage: GptSoVitsLang
  catalogVersion?: string
}

export interface LoadVoiceProfileCatalogOptions {
  /** Empty selects explicit single-reference mode; a configured path is never silently bypassed. */
  filePath: string
  singleReference: SingleReferenceProfileInput
  onWarning?: (warning: VoiceProfileWarning) => void
}

const singleReferenceDefaults = {
  label: 'Single reference',
  topK: 15,
  topP: 0.95,
  temperature: 0.85,
  repetitionPenalty: 1.35,
  speedFactor: 1,
  fragmentInterval: 0.12,
  textSplitMethod: 'cut0',
  variationSeeds: [1] as number[],
  warmup: true,
} as const

function toProfile(id: string, profile: ProfileInput): VoiceReferenceProfile {
  return Object.freeze({
    id,
    label: profile.label,
    referenceAudio: profile.referenceAudio,
    referenceText: profile.referenceText,
    promptLanguage: profile.promptLanguage,
    sampling: Object.freeze({
      topK: profile.topK,
      topP: profile.topP,
      temperature: profile.temperature,
      repetitionPenalty: profile.repetitionPenalty,
    }),
    timing: Object.freeze({
      speedFactor: profile.speedFactor,
      fragmentInterval: profile.fragmentInterval,
      textSplitMethod: profile.textSplitMethod,
    }),
    variationSeeds: [...profile.variationSeeds],
    warmup: profile.warmup,
  })
}

/** Build the explicit no-catalog deployment mode from the legacy reference settings. */
export function createSingleReferenceCatalog(input: SingleReferenceProfileInput): VoiceProfileCatalog {
  if (!input.referenceAudio.trim())
    throw new Error('Invalid single-reference voice profile: GPT_SOVITS_REF_AUDIO is required')
  if (!input.referenceText.trim())
    throw new Error('Invalid single-reference voice profile: GPT_SOVITS_PROMPT_TEXT must be the exact reference transcript')

  const neutral = toProfile('neutral', {
    ...singleReferenceDefaults,
    referenceAudio: input.referenceAudio,
    referenceText: input.referenceText,
    promptLanguage: input.promptLanguage,
  })
  return Object.freeze({
    schemaVersion: 1,
    catalogVersion: input.catalogVersion?.trim() || 'single-reference-v1',
    defaultProfileId: 'neutral',
    profiles: new Map([['neutral', neutral]]),
    emotionMap: new Map(),
  })
}

function validationMessage(issues: readonly v.BaseIssue<unknown>[]): string {
  return issues.map(issue => v.getDotPath(issue) ?? issue.message).join('; ')
}

function buildCatalog(input: CatalogInput, onWarning?: (warning: VoiceProfileWarning) => void): VoiceProfileCatalog {
  const defaultInput = input.profiles[input.defaultProfile]
  if (!defaultInput)
    throw new Error(`Invalid voice profile catalog: default profile '${input.defaultProfile}' does not exist`)
  if (!defaultInput.referenceAudio.trim())
    throw new Error(`Invalid voice profile catalog: default profile '${input.defaultProfile}' is missing referenceAudio`)
  if (!defaultInput.referenceText.trim())
    throw new Error(`Invalid voice profile catalog: default profile '${input.defaultProfile}' is missing referenceText`)
  if (defaultInput.variationSeeds.length === 0)
    throw new Error(`Invalid voice profile catalog: default profile '${input.defaultProfile}' has no variation seeds`)

  const profiles = new Map<string, VoiceReferenceProfile>()
  for (const [id, profile] of Object.entries(input.profiles)) {
    const reason = !profile.referenceAudio.trim()
      ? 'missing_reference_audio'
      : !profile.referenceText.trim()
        ? 'missing_reference_text'
        : profile.variationSeeds.length === 0
          ? 'empty_variation_seeds'
          : undefined
    if (reason) {
      if (id !== input.defaultProfile)
        onWarning?.({ kind: 'profile-disabled', profileId: id, reason })
      continue
    }
    profiles.set(id, toProfile(id, profile))
  }

  const emotionMap = new Map<string, string>()
  for (const [emotion, target] of Object.entries(input.emotionMap)) {
    if (!profiles.has(target)) {
      // Disabled profiles already emitted their single warning above. Only a
      // genuinely unknown target needs an additional catalog diagnostic.
      if (!input.profiles[target])
        onWarning?.({ kind: 'emotion-map-fallback', emotion, profileId: target, reason: 'unknown_or_unavailable_profile' })
      emotionMap.set(emotion.trim().toLowerCase(), input.defaultProfile)
    }
    else {
      emotionMap.set(emotion.trim().toLowerCase(), target)
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    catalogVersion: input.catalogVersion,
    defaultProfileId: input.defaultProfile,
    profiles,
    emotionMap,
  })
}

/** Parse a catalog value without filesystem access, useful for startup assembly and tests. */
export function parseVoiceProfileCatalog(value: unknown, onWarning?: (warning: VoiceProfileWarning) => void): VoiceProfileCatalog {
  const result = v.safeParse(catalogSchema, value)
  if (!result.success)
    throw new Error(`Invalid voice profile catalog: ${validationMessage(result.issues)}`)
  return buildCatalog(result.output, onWarning)
}

/** Load profile-bank mode, or explicitly generate single-reference mode when no path is configured. */
export async function loadVoiceProfileCatalog(options: LoadVoiceProfileCatalogOptions): Promise<VoiceProfileCatalog> {
  if (!options.filePath.trim())
    return createSingleReferenceCatalog(options.singleReference)

  let source: string
  try {
    source = await readFile(options.filePath, 'utf8')
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Unable to read voice profile catalog '${options.filePath}': ${message}`)
  }
  let value: unknown
  try {
    value = JSON.parse(source)
  }
  catch {
    throw new Error(`Invalid JSON in voice profile catalog '${options.filePath}'`)
  }
  return parseVoiceProfileCatalog(value, options.onWarning)
}
