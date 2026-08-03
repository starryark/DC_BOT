import type { DiscordMentionInputEvent } from '../orchestration/events'

export interface TextIngressContext {
  readonly isDirectMessage: boolean
  readonly isThread: boolean
}

/** Observes generation and real Discord send outcomes without changing shadow prompts. */
export interface DiscordTextMemoryObserver {
  admit: (event: DiscordMentionInputEvent, context: TextIngressContext) => Promise<void>
  beginGeneration: (event: DiscordMentionInputEvent) => Promise<void>
  generated: (event: DiscordMentionInputEvent, chunks: readonly string[]) => Promise<void>
  delivering: (event: DiscordMentionInputEvent, segmentIndex: number) => Promise<void>
  deliveredSegment: (event: DiscordMentionInputEvent, segmentIndex: number, discordMessageId: string) => Promise<void>
  delivered: (event: DiscordMentionInputEvent) => Promise<void>
  failed: (event: DiscordMentionInputEvent, error: unknown) => Promise<void>
}

export interface DiscordTextContextProvider {
  contextFor: (event: import('../orchestration/events').DiscordMentionInputEvent) => Promise<MemoryContextResult>
}

/** Explicitly distinguishes an inert adapter, valid empty context, and a failed active dependency. */
export type MemoryContextResult
  = | { readonly status: 'disabled' }
    | { readonly status: 'available', readonly text: string }
    | { readonly status: 'required_unavailable', readonly error: Error }
