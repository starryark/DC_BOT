import type { VoiceInputEvent } from './events'
import type { InputUnderstanding } from './input-understanding'

export interface TranscribedUtterance {
  inputEvent: VoiceInputEvent
  text: string
  language: string
  startedAt: number
  endedAt: number
  responseEpoch: number
  understanding: InputUnderstanding
}

export interface GroupMessage {
  userId: string
  displayName: string
  text: string
  language: string
  startedAt: number
  endedAt: number
  understanding: InputUnderstanding
}

export interface GroupConversationInput {
  kind: 'conversation'
  guildId: string
  responseEpoch: number
  /** Original events remain separate; PCM is never concatenated or copied. */
  utterances: readonly TranscribedUtterance[]
  messages: readonly GroupMessage[]
  promptText: string
}

export interface OneAtATimeInput {
  kind: 'request_one_at_a_time'
  guildId: string
  responseEpoch: number
  speakers: string[]
}

export type ConversationInput = GroupConversationInput | OneAtATimeInput

/** Merge only adjacent fragments from the same speaker, preserving source events. */
export function buildGroupTurn(utterances: readonly TranscribedUtterance[], mergeGapMs: number): GroupConversationInput {
  if (utterances.length === 0)
    throw new Error('Cannot build an empty conversation group')

  const ordered = [...utterances].sort((a, b) => a.startedAt - b.startedAt || a.endedAt - b.endedAt)
  const messages: GroupMessage[] = []
  for (const utterance of ordered) {
    const previous = messages.at(-1)
    if (previous && previous.userId === utterance.inputEvent.userId && utterance.startedAt - previous.endedAt <= mergeGapMs) {
      previous.text = joinFragments(previous.text, utterance.text)
      previous.endedAt = Math.max(previous.endedAt, utterance.endedAt)
      if (previous.language !== utterance.language)
        previous.language = 'und'
      previous.understanding = utterance.understanding
      continue
    }
    messages.push({
      userId: utterance.inputEvent.userId,
      displayName: utterance.inputEvent.displayName,
      text: utterance.text.trim(),
      language: utterance.language,
      startedAt: utterance.startedAt,
      endedAt: utterance.endedAt,
      understanding: utterance.understanding,
    })
  }

  const lines = ['Recent Discord voice messages:', '']
  for (const message of messages) {
    // JSON quoting prevents names containing brackets/newlines from becoming
    // prompt structure or looking like an instruction boundary.
    lines.push(`[speaker=${JSON.stringify(message.displayName)}, time=${formatTimestamp(message.startedAt)}]`)
    lines.push(message.text)
    lines.push('')
  }
  lines.push('Reply once to the group. Use speaker names only when useful.')

  return {
    kind: 'conversation',
    guildId: ordered[0].inputEvent.guildId!,
    responseEpoch: ordered[0].responseEpoch,
    utterances: ordered,
    messages,
    promptText: lines.join('\n'),
  }
}

function joinFragments(left: string, right: string): string {
  const a = left.trimEnd()
  const b = right.trimStart()
  if (!a)
    return b
  if (!b)
    return a
  return `${a} ${b}`
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 23)
}
