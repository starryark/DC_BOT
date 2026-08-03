import type { AuthorizationContext, CharacterId, EventId, LogicalRoomId, PhysicalRoomId } from '@proj-airi/memory-domain'

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

export interface RecentContextManifestItem {
  readonly id: string
  readonly sourceType: 'inbound' | 'assistant_output'
  readonly deliveryStatus?: string
}

export interface RecentContextResult extends SerializedPromptContext {
  readonly sentinel: 'ok' | 'noDurableContext'
  readonly manifest: {
    readonly selected: readonly RecentContextManifestItem[]
    readonly truncated: boolean
    readonly bindingRevision: number
    readonly candidateReadLimit: number
  }
}

/** Selects bounded logical-room history after validating the requesting physical room's current authority. */
export interface ContextMemoryAuthority {
  assembleRecent: (request: RecentContextRequest) => Promise<RecentContextResult>
}
