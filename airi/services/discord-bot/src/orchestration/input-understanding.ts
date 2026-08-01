import type { CharacterEntityProfile, CharacterInteractionProfile, SupportedLanguage } from '../character/types'

export type LanguageResolutionReason = 'explicit-language-request' | 'japanese-script' | 'chinese-frame' | 'english-sentence' | 'conversation-context' | 'character-alias' | 'asr-language' | 'character-default'

export interface RecognizedEntity {
  entityId: string
  kind: 'character-name' | 'nickname'
  matchedSurface: string
  canonicalName: string
  promptDescription?: string
}

export interface InputUnderstanding {
  responseLanguage: SupportedLanguage
  confidence: number
  reason: LanguageResolutionReason
  isAmbiguous: boolean
  asrLanguageRaw?: string
  asrLanguageNormalized?: SupportedLanguage
  entities: RecognizedEntity[]
}

export function normalizeSupportedLanguage(raw: unknown): SupportedLanguage | undefined {
  if (typeof raw !== 'string')
    return undefined
  const value = raw.trim().normalize('NFKC').toLowerCase()
  if (['ja', 'japanese', '日本語'].includes(value))
    return 'ja'
  if (['zh', 'chinese', 'mandarin', '中文'].includes(value))
    return 'zh'
  if (['en', 'english', '英语', '英語'].includes(value))
    return 'en'
  return undefined
}

function aliasPattern(alias: string): RegExp {
  const escaped = alias.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const latin = /^[a-z\d '\-]+$/i.test(escaped)
  return new RegExp(latin ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped, 'giu')
}

export function recognizeEntities(text: string, profiles: CharacterEntityProfile[]): RecognizedEntity[] {
  const normalized = text.normalize('NFKC')
  const found: RecognizedEntity[] = []
  for (const entity of profiles) {
    for (const alias of [...entity.aliases].sort((a, b) => b.length - a.length)) {
      const match = aliasPattern(alias).exec(normalized)
      if (match) {
        found.push({ entityId: entity.id, kind: entity.kind, matchedSurface: match[0], canonicalName: entity.canonicalName, promptDescription: entity.promptDescription })
        break
      }
    }
  }
  return found
}

function isAliasOnly(text: string, profiles: CharacterEntityProfile[]): boolean {
  let remainder = text.normalize('NFKC')
  for (const entity of profiles) {
    for (const alias of entity.aliases)
      remainder = remainder.replace(aliasPattern(alias), '')
  }
  return !/[\p{L}\p{N}]/u.test(remainder)
}

export function isStableLanguageEvidence(reason: LanguageResolutionReason): boolean {
  return ['explicit-language-request', 'japanese-script', 'chinese-frame', 'english-sentence'].includes(reason)
}

function explicitLanguageRequest(text: string): SupportedLanguage | undefined {
  const prefix = '(?:answer|reply|respond|use|say it)\\s+(?:to me\\s+)?in\\s+'
  if (new RegExp(`${prefix}english`, 'i').test(text))
    return 'en'
  if (new RegExp(`${prefix}(?:chinese|mandarin)`, 'i').test(text) || /请?用中文(?:回答|说|回复)?/.test(text))
    return 'zh'
  if (new RegExp(`${prefix}japanese`, 'i').test(text) || /日本語で(?:答え|話し|返事)/.test(text))
    return 'ja'
  return undefined
}

export function resolveInputUnderstanding(input: { text: string, asrLanguage?: unknown, previousStableLanguage?: SupportedLanguage, characterInteractionProfile: CharacterInteractionProfile }): InputUnderstanding {
  const text = input.text.normalize('NFKC')
  const entities = recognizeEntities(text, input.characterInteractionProfile.entities)
  const asr = normalizeSupportedLanguage(input.asrLanguage)
  let responseLanguage: SupportedLanguage
  let reason: LanguageResolutionReason
  let confidence = 0.6
  const explicit = explicitLanguageRequest(text)
  if (explicit) {
    responseLanguage = explicit
    reason = 'explicit-language-request'
    confidence = 1
  }
  else if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) {
    responseLanguage = 'ja'
    reason = 'japanese-script'
    confidence = 0.98
  }
  else if (/[你您吗呢吧是请为什么怎]/u.test(text)) {
    responseLanguage = 'zh'
    reason = 'chinese-frame'
    confidence = 0.94
  }
  else if (/^[\s\p{P}]*[A-Za-z]+(?:\s+[A-Za-z]+){2,}[\s\p{P}]*$/u.test(text) || /^(?:hello|hi|hey|thanks|thank you)[!.?]*$/i.test(text)) {
    responseLanguage = 'en'
    reason = 'english-sentence'
    confidence = 0.9
  }
  else if ((entities.length > 0 && isAliasOnly(text, input.characterInteractionProfile.entities)) || /^(?:ok|yes|no|yeah|nope|嗯|嗯嗯|うん)[!.?]*$/iu.test(text)) {
    responseLanguage = input.previousStableLanguage ?? input.characterInteractionProfile.defaultResponseLanguage
    reason = input.previousStableLanguage ? 'conversation-context' : entities.length ? 'character-alias' : 'character-default'
    confidence = entities.length ? 0.82 : 0.65
  }
  else if (asr) {
    responseLanguage = asr
    reason = 'asr-language'
    confidence = 0.7
  }
  else if (input.previousStableLanguage) {
    responseLanguage = input.previousStableLanguage
    reason = 'conversation-context'
    confidence = 0.65
  }
  else {
    responseLanguage = input.characterInteractionProfile.defaultResponseLanguage
    reason = 'character-default'
    confidence = 0.55
  }
  return { responseLanguage, confidence, reason, isAmbiguous: !isStableLanguageEvidence(reason), asrLanguageRaw: typeof input.asrLanguage === 'string' ? input.asrLanguage : undefined, asrLanguageNormalized: asr, entities }
}
