import type { GenerationAttempt } from '@proj-airi/memory-domain'

import type { DiscordMentionInputEvent } from '../orchestration/events'

export interface TextIngressContext {
  readonly isDirectMessage: boolean
  readonly isThread: boolean
}

/** Observes generation and real Discord send outcomes without changing shadow prompts. */
export interface DiscordTextMemoryObserver {
  admit: (event: DiscordMentionInputEvent, context: TextIngressContext) => Promise<void>
  prepareForModel: (event: DiscordMentionInputEvent) => Promise<PreparedModelMemory>
  generated: (event: DiscordMentionInputEvent, chunks: readonly string[]) => Promise<void>
  delivering: (event: DiscordMentionInputEvent, segmentIndex: number) => Promise<void>
  deliveredSegment: (event: DiscordMentionInputEvent, segmentIndex: number, discordMessageId: string) => Promise<void>
  delivered: (event: DiscordMentionInputEvent) => Promise<void>
  failed: (event: DiscordMentionInputEvent, error: unknown) => Promise<void>
}

/**
 * The single result of preparing durable memory for one model request.
 *
 * `context` is the exact serialized history the request must use; `generation`
 * is the durable attempt already persisted and moved to running. Returning both
 * together is what keeps a model call from ever preceding its own evidence.
 */
export interface PreparedModelMemory { readonly context: MemoryContextResult, readonly generation?: GenerationAttempt }

/** Explicitly distinguishes an inert adapter, valid empty context, and a failed active dependency. */
export type MemoryContextResult
  = | { readonly status: 'disabled' }
    | { readonly status: 'available', readonly text: string }
    | { readonly status: 'required_unavailable', readonly error: Error }
