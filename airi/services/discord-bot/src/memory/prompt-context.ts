const CONTROL_CHARACTERS = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu
const MASS_MENTION = /@(everyone|here)/giu
const ROLE_MARKER = /(^|\n)\s*(system|assistant|developer|user)\s*:/giu

export interface PromptContextItem {
  readonly personRef?: string
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
    const person = item.personRef ? ` person=${JSON.stringify(item.personRef)}` : ''
    const line = `item length=${cleaned.length}${person} value=${value}\n`
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
