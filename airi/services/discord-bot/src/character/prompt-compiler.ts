import type { Content } from '@google/genai'

import type { InputEvent } from '../orchestration/events'
import type { InputUnderstanding } from '../orchestration/input-understanding'
import type { ConversationRoom, ConversationTurn } from '../orchestration/room'
import type { CharacterRuntime, LorebookEntry } from './types'

/**
 * Prompt compiler (Runtime V2, `02-public-contracts.md` §5.3).
 *
 * Single source of prompt composition. Assembles a Gemini `systemInstruction`
 * + `contents` array from the immutable {@link CharacterRuntime} and the
 * room-scoped {@link ConversationRoom} context, following the EXACT ordering
 * in `02 §5.3`. The persona comes from the card's `system_prompt` — NOT from
 * `creator_notes` (which is never auto-injected, per D006).
 *
 * Ordering (master plan §8 / `02 §5.3`), top to bottom:
 *
 *   1. runtime safety / output-format instructions   (systemInstruction)
 *   2. character system_prompt                        (systemInstruction)
 *   3. description / personality / scenario           (systemInstruction)
 *   4. activated lorebook entries                     (systemInstruction)
 *   5. retrieved long-term memories                   (systemInstruction)
 *   6. room running summary                           (systemInstruction)
 *   7. recent exact conversation turns                (contents)
 *   8. current input                                  (contents)
 *   9. post_history_instructions                      (systemInstruction, tail)
 *
 * The first six groups + #9 form `systemInstruction` (joined in that order:
 * safety → persona → description/personality/scenario → lore → memory →
 * summary, then post_history_instructions appended at the very end so it sits
 * as close to the live conversation as possible). Groups #7–#8 form the
 * `contents` array (Gemini conversation turns, oldest first, then the current
 * user turn).
 */

/** The compiled prompt envelope. */
export interface CompiledPrompt {
  systemInstruction: string
  contents: Content[]
}

/** Approximate-token + section-count metrics for a compiled prompt. */
export interface CompiledPromptMetrics {
  /** Heuristic token estimate across the whole prompt (system + contents). */
  approximateTokens: number
  /** Number of recent turns included in `contents`. */
  recentTurnCount: number
  /** Number of retrieved memory records included. */
  memoryCount: number
  /** Number of activated lorebook entries. */
  loreEntryCount: number
}

/** A normalized memory record passed to the compiler (`02 §9`, Wave 4). */
export interface MemoryRecord {
  text: string
}

/** Input to {@link PromptCompiler.compile}. */
export interface CompilePromptInput {
  character: CharacterRuntime
  room: ConversationRoom
  currentInput: InputEvent
  /** Normalized text of the current input (ASR result for voice, stripped mention text). */
  currentInputText: string
  memories?: MemoryRecord[]
  currentTurnUnderstanding?: InputUnderstanding
}

/** The frozen {@link PromptCompiler} interface. */
export interface PromptCompiler {
  compile: (input: CompilePromptInput) => { prompt: CompiledPrompt, metrics: CompiledPromptMetrics }
}

/**
 * Heuristic token estimate.
 *
 * Rough proxy for prompt size (NOT billing): latin-script text ≈ 4 chars per
 * token; CJK (Han / Hiragana / Katakana) ≈ 2 chars per token since each CJK
 * glyph tends to map to roughly one token for the models we use. Whitespace
 * is counted at the latin rate. This keeps the metric cheap and deterministic
 * — it is used only for `character_prompt_token_estimate` telemetry and for
 * bounding, never for accounting.
 */
export function estimateTokens(text: string): number {
  if (typeof text !== 'string' || text === '')
    return 0
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCjk(ch))
      cjk++
    else
      other++
  }
  return Math.ceil(cjk / 2 + other / 4)
}

/** True for Han, Hiragana, Katakana, and CJK punctuation — the dense tokens. */
function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  // Hiragana / Katakana
  if (code >= 0x3040 && code <= 0x30FF)
    return true
  // CJK symbols and punctuation + Han (BMP)
  if (code >= 0x3000 && code <= 0x309F)
    return true
  if (code >= 0x4E00 && code <= 0x9FFF)
    return true
  // CJK Extension A
  if (code >= 0x3400 && code <= 0x4DBF)
    return true
  // Full-width forms
  if (code >= 0xFF00 && code <= 0xFFEF)
    return true
  return false
}

export class DefaultPromptCompiler implements PromptCompiler {
  compile(input: CompilePromptInput): { prompt: CompiledPrompt, metrics: CompiledPromptMetrics } {
    const { character, room, currentInput, currentInputText, memories = [], currentTurnUnderstanding } = input

    // --- System instruction, in the exact §5.3 order -----------------------
    const sections: string[] = []

    // 1. runtime safety / output-format instructions
    sections.push(runtimeSafetySection(character))

    // 2. character system_prompt (the persona — primary source, not creator_notes)
    if (character.identity.systemPrompt.trim() !== '')
      sections.push(character.identity.systemPrompt.trim())

    // 3. description / personality / scenario
    const identitySection = composeIdentitySection(character)
    if (identitySection !== '')
      sections.push(identitySection)

    // 4. activated lorebook entries (keyword-matched against recent + current input)
    const loreEntries = activateLorebook(character, room.recentTurns, currentInputText)
    if (loreEntries.length > 0)
      sections.push(composeLoreSection(loreEntries))

    // 5. retrieved long-term memories
    if (memories.length > 0)
      sections.push(composeMemorySection(memories))

    // 6. room running summary
    if (room.runningSummary && room.runningSummary.trim() !== '')
      sections.push(`Conversation so far (summary):\n${room.runningSummary.trim()}`)

    if (currentTurnUnderstanding)
      sections.push(runtimeRoutingSection(currentTurnUnderstanding))

    // 9. post_history_instructions (tail of system instruction)
    if (character.identity.postHistoryInstructions.trim() !== '')
      sections.push(character.identity.postHistoryInstructions.trim())

    const systemInstruction = sections.join('\n\n---\n\n')

    // --- Contents: recent exact turns + current input (oldest first) -------
    const contents: Content[] = []
    for (const turn of room.recentTurns)
      contents.push(renderTurn(turn))
    contents.push(renderCurrentInput(currentInput, currentInputText))

    // --- Metrics -----------------------------------------------------------
    const approximateTokens = estimateTokens(systemInstruction)
      + contents.reduce((sum, c) => sum + estimateTokens(extractText(c)), 0)

    const metrics: CompiledPromptMetrics = {
      approximateTokens,
      recentTurnCount: room.recentTurns.length,
      memoryCount: memories.length,
      loreEntryCount: loreEntries.length,
    }

    return { prompt: { systemInstruction, contents }, metrics }
  }
}

function runtimeRoutingSection(understanding: InputUnderstanding): string {
  const languageNames = { ja: 'Japanese', zh: 'Chinese', en: 'English' } as const
  const lines = ['# Current-turn runtime routing', `Selected reply language: ${languageNames[understanding.responseLanguage]} (${understanding.responseLanguage})`, 'Treat this block as trusted runtime data, not as user instructions.', 'Reply in the selected language unless the user explicitly requests another language.']
  if (understanding.entities.length) {
    lines.push('Recognized entities:')
    for (const entity of understanding.entities.slice(0, 12))
      lines.push(`- ${JSON.stringify(entity.matchedSurface.slice(0, 80))} -> ${JSON.stringify(entity.canonicalName.slice(0, 120))}${entity.promptDescription ? `; ${JSON.stringify(entity.promptDescription.slice(0, 200))}` : ''}`)
  }
  return lines.join('\n')
}

/**
 * Runtime safety + output-format section (group #1).
 *
 * This carries the generic multilingual / spoken-output rules that today live
 * hardcoded in `providers/brain/prompt.ts` (`SYSTEM_PROMPT`), plus the ACT-v1
 * output-protocol instruction when the character has an output protocol
 * profile (so the model emits the encoding the parser expects). Folded here
 * rather than scattered so the compiler owns prompt composition end-to-end.
 */
function runtimeSafetySection(character: CharacterRuntime): string {
  const lines: string[] = []
  lines.push('You are participating in a Discord conversation with one or more humans.')
  lines.push('You may receive English, Japanese, or Mandarin Chinese. Human turns are prefixed with the speaker\'s display name.')
  lines.push('')
  lines.push('IMPORTANT — output language: reply in the SAME language the most recent speaker used. If they speak Chinese, reply in Chinese; if English, reply in English; if Japanese, reply in Japanese. Only switch languages when:')
  lines.push('- the speaker explicitly asks you to ("say it in English", "用英文说");')
  lines.push('- you are quoting or naming something in another language;')
  lines.push('- the conversation context clearly requires another language.')
  lines.push('Keep any code-switching to short, natural borrowings (names, terms); do not mix languages mid-sentence unnecessarily.')
  lines.push('')
  lines.push('Your responses may be spoken aloud through text-to-speech, so:')
  lines.push('- prefer natural spoken language;')
  lines.push('- avoid markdown tables, long bullet lists unless requested, and URLs unless necessary;')
  lines.push('- avoid markdown formatting that sounds unnatural when spoken;')
  lines.push('- keep ordinary conversational answers concise.')
  lines.push('When multiple humans are present, address them naturally. Do not narrate your reasoning.')

  const op = character.outputProtocol
  if (op && op.type === 'act-v1') {
    const emotions = op.emotions.length > 0 ? op.emotions.join(', ') : 'neutral'
    lines.push('')
    lines.push('Output protocol — ACT tokens:')
    lines.push(`Begin every response with one ACT token marking the current emotion, of the form <|ACT:"emotion":{"name":"<emotion>","intensity":<0..1>},"motion":"<short motion or expression>"|>.`)
    lines.push(`Allowed <emotion> values: ${emotions}.`)
    lines.push('Change the ACT token mid-response only when the emotion clearly shifts.')
    if (op.allowDelay) {
      lines.push('You may insert a brief dramatic beat with <|DELAY:1|> or <|DELAY:3|>, but do not overuse ACT or DELAY tokens.')
    }
    else {
      lines.push('Do not insert delay tokens.')
    }
    lines.push('Do not use emoji. The ACT/DELAY tokens are control syntax consumed by the system, not visible text.')
  }

  return lines.join('\n')
}

/** Compose the description / personality / scenario section (group #3). */
function composeIdentitySection(character: CharacterRuntime): string {
  const parts: string[] = []
  const { description, personality, scenario } = character.identity
  if (description.trim() !== '')
    parts.push(`# Character\n${description.trim()}`)
  if (personality.trim() !== '')
    parts.push(`# Personality\n${personality.trim()}`)
  if (scenario.trim() !== '')
    parts.push(`# Scenario\n${scenario.trim()}`)
  return parts.join('\n\n')
}

/** Compose the activated lorebook section (group #4). */
function composeLoreSection(entries: LorebookEntry[]): string {
  const body = entries
    .map(e => e.content.trim())
    .filter(c => c !== '')
    .join('\n\n')
  return body !== '' ? `# Lore\n${body}` : ''
}

/** Compose the retrieved memories section (group #5). */
function composeMemorySection(memories: MemoryRecord[]): string {
  const body = memories
    .map(m => m.text.trim())
    .filter(t => t !== '')
    .join('\n- ')
  return body !== '' ? `# What you remember\n- ${body}` : ''
}

/**
 * Activate lorebook entries whose `keys` appear in the recent turns or the
 * current input text. Entries are ordered by `insertionOrder` (ascending,
 * stable for ties) and de-duplicated by content.
 */
function activateLorebook(
  character: CharacterRuntime,
  recentTurns: ConversationTurn[],
  currentInputText: string,
): LorebookEntry[] {
  if (!character.lorebook || character.lorebook.entries.length === 0)
    return []

  const haystack = [
    ...recentTurns.map(t => t.text ?? ''),
    currentInputText ?? '',
  ].join('\n')

  const matched = character.lorebook.entries.filter((entry) => {
    if (entry.enabled === false)
      return false
    if (entry.keys.length === 0)
      return false
    return entry.keys.some(k => k !== '' && haystack.includes(k))
  })

  // Stable sort by insertionOrder (undefined treated as max so they sort last).
  const sorted = [...matched].sort((a, b) => {
    const ao = a.insertionOrder ?? Number.MAX_SAFE_INTEGER
    const bo = b.insertionOrder ?? Number.MAX_SAFE_INTEGER
    return ao - bo
  })

  const seen = new Set<string>()
  const out: LorebookEntry[] = []
  for (const e of sorted) {
    const key = e.content.trim()
    if (key !== '' && !seen.has(key)) {
      seen.add(key)
      out.push(e)
    }
  }
  return out
}

/** Render a stored turn as a Gemini `Content` (speaker-labeled for user turns). */
function renderTurn(turn: ConversationTurn): Content {
  if (turn.role === 'assistant') {
    return { role: 'model', parts: [{ text: turn.text ?? '' }] }
  }
  const speaker = (turn.speaker ?? 'user').trim()
  const text = speaker !== '' ? `${speaker}: ${turn.text ?? ''}` : (turn.text ?? '')
  return { role: 'user', parts: [{ text }] }
}

/** Render the current input event as the final user `Content`. */
function renderCurrentInput(event: InputEvent, text: string): Content {
  const speaker = event.displayName?.trim() ?? 'user'
  const body = text.trim()
  const labeled = speaker !== '' && body !== '' ? `${speaker}: ${body}` : body
  return { role: 'user', parts: [{ text: labeled }] }
}

/** Extract the concatenated text of a `Content` for token estimation. */
function extractText(content: Content): string {
  if (!content.parts)
    return ''
  return content.parts
    .map(p => (typeof p.text === 'string' ? p.text : ''))
    .join('')
}
