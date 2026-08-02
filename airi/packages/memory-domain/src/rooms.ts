/**
 * Physical Discord locations, logical rooms, and bindings (IMP-104; ADR-005).
 *
 * The distinction this file exists to enforce: a *physical location* is a
 * Discord channel, and a *logical room* is a conversation context. They are
 * not the same thing, and the mapping between them is data, not convention.
 *
 * The current runtime conflates them twice — `guild-session.ts:81` projects a
 * whole guild onto `voiceRoom(guildId, guildId)`, and `room-id.ts` derives
 * room identity from the channel id alone. Both are safe *because* nothing
 * crosses channels today. Once memory does, only an explicit binding record
 * may join two locations (REQ-SCOPE-001, FIND-011).
 */

import type { BindingId, CharacterId, LogicalRoomId, PhysicalRoomId, Timestamp } from './ids'

import { MemoryError } from './errors'
import { asLogicalRoomId, asPhysicalRoomId } from './ids'

/** The kinds of Discord place an event can arrive from. */
export type ChannelKind = 'guildText' | 'thread' | 'guildVoice' | 'dm'

/** A concrete Discord place. */
export interface PhysicalLocation {
  platform: 'discord'
  /** Absent exactly when `channelKind` is `dm`. */
  guildId?: string
  channelId: string
  channelKind: ChannelKind
}

/**
 * Deterministic id for a physical location.
 *
 * Shape: `discord:guild:<guildId>:<kind>:<channelId>`, or `discord:dm:<channelId>`.
 * Deterministic so that the same place always maps to the same row without a
 * lookup, and prefixed by guild so that a DM id can never be mistaken for a
 * guild channel id.
 */
export function physicalRoomIdOf(location: PhysicalLocation): PhysicalRoomId {
  if (location.channelKind === 'dm') {
    if (location.guildId != null)
      throw new MemoryError('INVALID_ROOM_REF', 'a DM location must not carry a guildId', { retryable: false })
    return asPhysicalRoomId(`discord:dm:${location.channelId}`)
  }
  if (!location.guildId) {
    throw new MemoryError('INVALID_ROOM_REF', `a ${location.channelKind} location requires a guildId`, { retryable: false })
  }
  return asPhysicalRoomId(`discord:guild:${location.guildId}:${location.channelKind}:${location.channelId}`)
}

/** True when the location is a direct message, i.e. outside every guild. */
export function isDirectMessage(location: PhysicalLocation): boolean {
  return location.channelKind === 'dm'
}

/**
 * A conversation context.
 *
 * `characterId` is part of the room, not a filter over it: the same channel
 * talking to two personas is two conversations, and their memories must not
 * mix (TEST-SCOPE-003).
 */
export interface LogicalRoom {
  logicalRoomId: LogicalRoomId
  characterId: CharacterId
  kind: 'dm' | 'guildChannel' | 'guildVoice' | 'thread' | 'bound'
  /** Monotonic counter bumped when the room's binding set changes. */
  bindingVersion: number
}

/**
 * The logical room a location gets when nothing binds it.
 *
 * Isolation is the default: an unbound channel is its own room and shares
 * history with nothing (REQ-SCOPE-002, AC-013).
 */
export function isolatedLogicalRoomId(physicalRoomId: PhysicalRoomId, characterId: CharacterId): LogicalRoomId {
  return asLogicalRoomId(`room:${characterId}:${physicalRoomId}`)
}

/** How a binding came to exist. */
export type BindingKind = 'explicit' | 'configured'

export interface BindingPolicy {
  /** When false the binding exists for addressing only and shares no history. */
  crossChannelHistory: boolean
  direction: 'bidirectional' | 'physicalToLogical'
}

/** An authorized, versioned join between a physical location and a logical room. */
export interface RoomBinding {
  bindingId: BindingId
  physicalRoomId: PhysicalRoomId
  logicalRoomId: LogicalRoomId
  characterId: CharacterId
  bindingKind: BindingKind
  policy: BindingPolicy
  validFrom: Timestamp
  validUntil?: Timestamp
  /** Who authorized it. Required: an unattributed binding cannot be reviewed. */
  createdBy: string
}

/** True when `binding` is in force at `at`. */
export function isBindingActive(binding: RoomBinding, at: Timestamp): boolean {
  if (Date.parse(binding.validFrom) > Date.parse(at))
    return false
  return binding.validUntil == null || Date.parse(binding.validUntil) > Date.parse(at)
}

/**
 * Reject a binding that would join a DM to guild-visible context.
 *
 * DM isolation is absolute in this milestone. A DM participant did not consent
 * to their conversation being readable from a guild, and no binding authority
 * in the system is empowered to grant that (FIND-011, SCN-015).
 */
export function assertBindable(location: PhysicalLocation, target: LogicalRoom): void {
  if (isDirectMessage(location) && target.kind !== 'dm') {
    throw new MemoryError('DM_ISOLATION_VIOLATION', 'a DM may not be bound to a guild-scoped logical room', {
      retryable: false,
      details: { channelId: location.channelId, targetKind: target.kind },
    })
  }
  if (!isDirectMessage(location) && target.kind === 'dm') {
    throw new MemoryError('DM_ISOLATION_VIOLATION', 'a guild channel may not be bound into a DM logical room', {
      retryable: false,
      details: { channelId: location.channelId },
    })
  }
}

/** The outcome of mapping a physical location onto a logical room. */
export interface RoomResolution {
  physicalRoomId: PhysicalRoomId
  logicalRoomId: LogicalRoomId
  /** `isolated` means no binding applied; the room is this channel alone. */
  roomKind: 'isolated' | 'bound'
  /** The binding that applied, for the selection manifest. */
  bindingId?: BindingId
  /** Evidence of which binding generation this resolution reflects (ADR-015). */
  bindingVersion: number
}

export interface ResolveRoomInput {
  location: PhysicalLocation
  characterId: CharacterId
  /** Every binding the repository holds; filtering happens here. */
  bindings: readonly RoomBinding[]
  at: Timestamp
}

/**
 * Resolve which logical room an event belongs to.
 *
 * Bindings are matched on physical room **id**, never on a name or label. Two
 * channels that happen to be called `#general` are two rooms; only an explicit
 * binding id joins them (SCN-019).
 *
 * More than one active binding for the same physical room and character is a
 * configuration error, not something to resolve by precedence — silently
 * picking one would make history membership depend on row order.
 */
export function resolveLogicalRoom(input: ResolveRoomInput): RoomResolution {
  const physicalRoomId = physicalRoomIdOf(input.location)
  const applicable = input.bindings.filter(binding =>
    binding.physicalRoomId === physicalRoomId
    && binding.characterId === input.characterId
    && binding.policy.crossChannelHistory
    && isBindingActive(binding, input.at),
  )

  if (applicable.length > 1) {
    throw new MemoryError('DUPLICATE_BINDING', 'more than one active history binding for this location and character', {
      retryable: false,
      details: { physicalRoomId, bindings: applicable.map(binding => binding.bindingId) },
    })
  }

  if (applicable.length === 0) {
    return {
      physicalRoomId,
      logicalRoomId: isolatedLogicalRoomId(physicalRoomId, input.characterId),
      roomKind: 'isolated',
      bindingVersion: 0,
    }
  }

  const binding = applicable[0]
  if (isDirectMessage(input.location)) {
    throw new MemoryError('DM_ISOLATION_VIOLATION', 'a DM location may not carry a cross-channel history binding', {
      retryable: false,
      details: { physicalRoomId, bindingId: binding.bindingId },
    })
  }

  return {
    physicalRoomId,
    logicalRoomId: binding.logicalRoomId,
    roomKind: 'bound',
    bindingId: binding.bindingId,
    // Binding identity plus validity window is the version evidence a
    // generation records; a revoked binding changes it and invalidates caches.
    bindingVersion: Date.parse(binding.validFrom),
  }
}
