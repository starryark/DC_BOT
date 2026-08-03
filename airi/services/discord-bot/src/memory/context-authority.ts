import type { AuthorizationContext, CharacterId, LogicalRoomId, PhysicalRoomId } from '@proj-airi/memory-domain'

import type { SerializedPromptContext } from './prompt-context'

export interface RecentContextRequest {
  readonly authorization: AuthorizationContext
  readonly logicalRoomId: LogicalRoomId
  readonly physicalRoomId: PhysicalRoomId
  readonly characterId: CharacterId
  readonly maxItems: number
  readonly maxCharacters: number
}

export interface RecentContextResult extends SerializedPromptContext {
  readonly sentinel: 'ok' | 'noDurableContext'
}

/** Selects only exact-scope inbound evidence and delivery-eligible assistant output. */
export interface ContextMemoryAuthority {
  assembleRecent: (request: RecentContextRequest) => Promise<RecentContextResult>
}
