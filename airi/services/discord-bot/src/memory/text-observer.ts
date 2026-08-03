import type { DiscordMentionInputEvent } from '../orchestration/events'

export interface TextIngressContext {
  readonly isDirectMessage: boolean
  readonly isThread: boolean
}

/** Observes generation and real Discord send outcomes without changing shadow prompts. */
export interface DiscordTextMemoryObserver {
  admit: (event: DiscordMentionInputEvent, context: TextIngressContext) => Promise<void>
  generated: (event: DiscordMentionInputEvent, chunks: readonly string[]) => Promise<void>
  delivered: (event: DiscordMentionInputEvent, discordMessageIds: readonly string[]) => Promise<void>
  failed: (event: DiscordMentionInputEvent, error: unknown) => Promise<void>
}

export interface DiscordTextContextProvider {
  contextFor: (event: import('../orchestration/events').DiscordMentionInputEvent) => Promise<string | undefined>
}
