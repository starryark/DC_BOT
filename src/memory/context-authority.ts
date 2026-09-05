import type { AuthorizationContext, CharacterId, EventId, LayeredContextManifest, LayeredContextManifestItem, LogicalRoomId, MemoryLayer, PhysicalRoomId, SearchMemoryInput, SearchMemoryOutput, SnapshotContextItem, SnapshotContextManifest, Timestamp } from '@proj-airi/memory-domain'

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

/** A typed, authorization-bound request for the G6 layered selector. */
export interface LayeredContextRequest extends RecentContextRequest {
  /** Original current-turn text. It is hashed in the manifest and never logged there. */
  readonly query: string
  /** Typed predicates eligible for deterministic exact lookup; never parsed from model output. */
  readonly exactPredicates?: readonly string[]
  readonly includeLayers: readonly Extract<MemoryLayer, 'recent' | 'summary' | 'semantic' | 'episodic'>[]
  /** Half-open temporal view. Omitted means current records only. */
  readonly asOf?: Timestamp
}

export interface LayeredContextResult extends SerializedPromptContext {
  readonly sentinel: 'ok' | 'noDurableContext'
  readonly manifest: LayeredContextManifest
}

export type LayeredSelectionManifestItem = LayeredContextManifestItem

/** Projects the recent tier for the v8 snapshot manifest stored on every generation. */
export function recentManifestOfLayered(manifest: LayeredContextManifest): SnapshotContextManifest {
  return {
    formatVersion: 1,
    logicalRoomVersion: manifest.logicalRoomVersion,
    bindingRevision: manifest.bindingRevision,
    maxItems: manifest.maxItems,
    maxCharacters: manifest.maxCharacters,
    candidateReadLimit: manifest.maxItems * 4,
    truncated: manifest.truncated,
    items: manifest.selected.flatMap(item => item.layer === 'recent' ? [item.source] : []),
  }
}

/** Selects bounded logical-room history after validating the requesting physical room's current authority. */
export interface ContextMemoryAuthority {
  assembleRecent: (request: RecentContextRequest) => Promise<RecentContextResult>
  assembleLayered: (request: LayeredContextRequest) => Promise<LayeredContextResult>
  searchMemory: (auth: AuthorizationContext, input: SearchMemoryInput) => Promise<SearchMemoryOutput>
}
