import type { AvatarAction } from './output'

import { parseActV1 } from '../character/output-protocol/act-v1-parser'
import { scanSpeechStream } from './speech-chunker'

export type SpeechEvent
  = | { kind: 'text', delta: string }
    | { kind: 'action', action: AvatarAction }
    | { kind: 'delay', requestedMs: number }

/** Convert streamed ACT-v1 markup into ordered, side-effect-free speech events. */
export async function* tokenizeSpeechStream(deltas: AsyncIterable<string>): AsyncIterable<SpeechEvent> {
  for await (const part of scanSpeechStream(deltas)) {
    if (part.kind === 'text') {
      yield { kind: 'text', delta: part.text }
      continue
    }

    // The existing parser is deliberately bounded and treats malformed model
    // metadata as ignorable rather than allowing it to fail the turn.
    const parsed = parseActV1(part.token)
    for (const action of parsed.actions)
      yield { kind: 'action', action }
    for (const pause of parsed.pauses)
      yield { kind: 'delay', requestedMs: pause.durationMs }
  }
}
