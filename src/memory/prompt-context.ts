const CONTROL_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu
const MASS_MENTION = /@(everyone|here)/giu
const ROLE_MARKER = /(^|\n)\s*(system|assistant|developer|user)\s*:/giu
const PROMPT_LOCAL_PERSON_REFERENCE = /\b(?:MEMORY_PERSON_[1-9]\d*|p_[1-9]\d*|P[1-9]\d*)\b/gu

/** How a remembered turn reached the room. */
export type PromptContextModality = 'text' | 'voice'

export interface PromptContextItem {
  readonly personRef?: string
  /** Memory semantics are emitted only from this closed set. */
  readonly layer?: 'recent' | 'summary' | 'semantic' | 'episodic'
  /**
   * How the turn arrived. Without it a spoken turn and a typed turn serialize
   * identically, so a model asked what was said in voice denies having heard
   * anything while the transcript sits in its own context.
   */
  readonly modality?: PromptContextModality
  readonly text: string
}

export interface SerializedPromptContext {
  readonly text: string
  readonly includedItems: number
  readonly truncated: boolean
}

/**
 * Serializes untrusted memory as length-prefixed data, never as chat roles.
 * Person references are prompt-local labels; durable identifiers are not accepted by this boundary.
 */
export function serializePromptContext(items: readonly PromptContextItem[], maxCharacters: number): SerializedPromptContext {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 64)
    throw new RangeError('memory prompt budget must be an integer of at least 64 characters')

  const header = '<memory-data encoding="json-string-length-prefixed">\n'
  const footer = '</memory-data>'
  let text = header
  let includedItems = 0
  let truncated = false

  for (const item of items) {
    const cleaned = item.text
      .normalize('NFC')
      .replace(CONTROL_CHARACTERS, '')
      .replace(MASS_MENTION, '@\u200B$1')
      .replace(ROLE_MARKER, '$1$2\\u003A')
      .replaceAll('</memory-data>', '<\\/memory-data>')
    const value = JSON.stringify(cleaned)
    const person = item.personRef && /^(?:P|p_|MEMORY_PERSON_)[1-9]\d*$/u.test(item.personRef) ? ` person=${JSON.stringify(item.personRef)}` : ''
    // Emit only the two known literals rather than interpolating the field.
    // Modality is an attribute a caller supplies, so echoing it verbatim would
    // reopen the delimiter boundary this function exists to hold shut.
    const modality = item.modality === 'voice' || item.modality === 'text' ? ` modality="${item.modality}"` : ''
    const layer = item.layer === 'recent' || item.layer === 'summary' || item.layer === 'semantic' || item.layer === 'episodic' ? ` layer="${item.layer}"` : ''
    const line = `item length=${cleaned.length}${layer}${modality}${person} value=${value}\n`
    if (text.length + line.length + footer.length > maxCharacters) {
      truncated = true
      break
    }
    text += line
    includedItems += 1
  }
  text += footer
  return Object.freeze({ text, includedItems, truncated })
}

/** Removes prompt-local actor handles before model output reaches text or TTS. */
export function redactPromptLocalReferences(text: string): string {
  return text.replace(PROMPT_LOCAL_PERSON_REFERENCE, 'someone')
}
