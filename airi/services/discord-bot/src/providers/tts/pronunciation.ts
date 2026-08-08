import type { CharacterEntityProfile, SupportedLanguage } from '../../character/types'

export interface SpeechPreparationResult {
  displayText: string
  speechText: string
  substitutions: Array<{ entityId: string, from: string, to: string, language: SupportedLanguage }>
}

export function prepareSpeechText(input: { text: string, language: SupportedLanguage, entities: CharacterEntityProfile[] }): SpeechPreparationResult {
  let speechText = input.text
  const substitutions: SpeechPreparationResult['substitutions'] = []
  const protectedRanges = [...speechText.matchAll(/`[^`]*`|https?:\/\/\S+/g)].map(match => [match.index!, match.index! + match[0].length])
  const candidates = input.entities.flatMap(entity => entity.aliases.map(alias => ({ entity, alias }))).sort((a, b) => b.alias.length - a.alias.length)
  for (const { entity, alias } of candidates) {
    const replacement = entity.pronunciations?.[input.language]?.speechText
    if (!replacement)
      continue
    const escaped = alias.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const latin = /^[a-z\d '-]+$/i.test(escaped)
    const regex = new RegExp(latin ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped, 'giu')
    speechText = speechText.replace(regex, (from, offset: number) => {
      if (substitutions.length >= 16 || protectedRanges.some(([start, end]) => offset >= start && offset < end))
        return from
      substitutions.push({ entityId: entity.id, from, to: replacement, language: input.language })
      return replacement
    })
  }
  return { displayText: input.text, speechText, substitutions }
}
