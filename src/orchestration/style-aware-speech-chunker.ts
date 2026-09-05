import type { ResolvedSpeechStyle, StyledSpeechChunk, VoiceProfileCatalog } from '../providers/tts/speech-style-types'
import type { AvatarAction } from './output'
import type { SpeechChunk, SpeechChunkerOptions } from './speech-chunker'
import type { SpeechEvent } from './speech-events'

import { redactPromptLocalReferences } from '../memory/prompt-context'
import { SpeechChunker } from './speech-chunker'
import { resolveSpeechStyle } from './speech-style-resolver'

export interface StyleAwareSpeechChunkerOptions {
  catalog: VoiceProfileCatalog
  neutralStyle: ResolvedSpeechStyle
  turnId: string
  maxModelPauseMs: number
  chunker?: Partial<SpeechChunkerOptions>
  /** Observe parsed avatar actions immediately, before they become active speech style. */
  onAvatarAction?: (action: AvatarAction) => void
}

/** Stateful bridge from ordered speech events to immutable styled TTS chunks. */
export class StyleAwareSpeechChunker {
  private activeAction: AvatarAction | undefined
  private bufferAction: AvatarAction | undefined
  private readonly chunker: SpeechChunker
  private chunkIndex = 0
  private hasBufferedText = false
  private pendingPauseBeforeMs = 0

  constructor(private readonly options: StyleAwareSpeechChunkerOptions) {
    this.chunker = new SpeechChunker(options.chunker)
  }

  push(event: SpeechEvent): StyledSpeechChunk[] {
    if (event.kind === 'text') {
      if (event.delta && !this.hasBufferedText) {
        this.bufferAction = snapshotAction(this.activeAction)
        this.hasBufferedText = true
      }
      return this.emit(this.chunker.pushWithBoundaries(event.delta))
    }

    const flushed = this.flushControlBoundary()
    if (event.kind === 'action') {
      this.options.onAvatarAction?.(event.action)
      this.activeAction = snapshotAction(event.action)
    }
    else {
      this.pendingPauseBeforeMs = Math.min(this.options.maxModelPauseMs, this.pendingPauseBeforeMs + Math.max(0, event.requestedMs))
    }
    return flushed
  }

  /** Finish buffered speech. A trailing delay intentionally emits nothing. */
  flush(): StyledSpeechChunk[] {
    return this.emit(this.chunker.flushWithBoundary())
  }

  private flushControlBoundary(): StyledSpeechChunk[] {
    return this.emit(this.chunker.flushForControlToken())
  }

  private emit(chunks: SpeechChunk[]): StyledSpeechChunk[] {
    const emitted = chunks.map((chunk) => {
      const style = resolveSpeechStyle({
        action: this.bufferAction,
        catalog: this.options.catalog,
        neutralStyle: this.options.neutralStyle,
        turnId: this.options.turnId,
        chunkIndex: this.chunkIndex++,
        text: chunk.text,
      })
      const result: StyledSpeechChunk = Object.freeze({
        text: chunk.text,
        style,
        pauseBeforeMs: this.pendingPauseBeforeMs,
        boundary: chunk.boundary,
      })
      this.pendingPauseBeforeMs = 0
      return result
    })

    if (chunks.length > 0) {
      // A natural emission may leave a suffix in the multilingual chunker. It
      // remains governed by the style captured when this buffer began.
      this.hasBufferedText = this.chunker.hasPendingText()
      if (!this.hasBufferedText)
        this.bufferAction = undefined
    }
    return emitted
  }
}

/** Chunk a complete event stream without sleeping or performing playback. */
export async function* chunkStyledSpeechStream(
  events: AsyncIterable<SpeechEvent>,
  options: StyleAwareSpeechChunkerOptions,
): AsyncIterable<StyledSpeechChunk> {
  const chunker = new StyleAwareSpeechChunker(options)
  for await (const event of events) {
    for (const chunk of chunker.push(event))
      yield { ...chunk, text: redactPromptLocalReferences(chunk.text) }
  }
  for (const chunk of chunker.flush())
    yield { ...chunk, text: redactPromptLocalReferences(chunk.text) }
}

function snapshotAction(action: AvatarAction | undefined): AvatarAction | undefined {
  return action ? Object.freeze({ ...action }) : undefined
}
