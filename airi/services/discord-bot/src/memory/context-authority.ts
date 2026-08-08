import type { AuthorizationContext, CharacterId, EventId, LogicalRoomId, PhysicalRoomId, SnapshotContextItem, SearchMemoryInput, SearchMemoryOutput } from '@proj-airi/memory-domain'

import type { SerializedPromptContext } from './prompt-context'

export interface RecentContextRequest {
  readonly authorization: AuthorizationContext
  readonly logicalRoomId: LogicalRoomId
  readonly physicalRoomId: PhysicalRoomId
  readonly characterId: CharacterId
  readonly maxItems: number
  readonly maxCharacters: number
  readonly excludeEventIds?: readonly EventId[]
}

export interface RecentContextResult extends SerializedPromptContext {
  readonly sentinel: 'ok' | 'noDurableContext'
  readonly manifest: {
    readonly formatVersion: 1
    readonly logicalRoomVersion: number
    readonly maxItems: number
    readonly maxCharacters: number
    readonly selected: readonly SnapshotContextItem[]
    readonly truncated: boolean
    readonly bindingRevision: number
    readonly candidateReadLimit: number
  }
}

/** Selects bounded logical-room history after validating the requesting physical room's current authority. */
export interface ContextMemoryAuthority {
  assembleRecent: (request: RecentContextRequest) => Promise<RecentContextResult>
  searchMemory: (auth: AuthorizationContext, input: SearchMemoryInput) => Promise<SearchMemoryOutput>
}
