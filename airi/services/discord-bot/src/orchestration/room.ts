import type { ConversationRoomId } from './room-id'

import { config } from '../config'

/**
 * Conversation room state (Runtime V2, `02-public-contracts.md` §2).
 *
 * Replaces per-guild history (`GuildSession`, `00-current-state.md` §4.9). A
 * room owns recent exact turns + an optional running summary. It does NOT own
 * long-term memory — memory is a separate subsystem
 * (`02-public-contracts.md` §9, `04-decisions.md` D004).
 *
 * Invariants (`01-architecture.md` invariant #2, `04-decisions.md` D003):
 * - Two separate channels in one guild MUST NOT share recent history.
 * - Two users speaking sequentially in one voice room MUST share that room's
 *   history (appendTurn by userA then userB → both visible).
 */

/** A single turn recorded in a room's recent history. */
export interface ConversationTurn {
  turnId: string
  role: 'user' | 'assistant'
  /** Speaker display name for user turns; undefined for assistant. */
  speaker?: string
  text: string
  /** Detected/source language hint ('zh' | 'en' | 'ja' | 'und' | ...). */
  language?: string
  timestamp: number
}

/** The mutable state of one conversation room. */
export interface ConversationRoom {
  id: ConversationRoomId
  characterId: string

  recentTurns: ConversationTurn[]
  runningSummary?: string

  /** Active character mode (e.g. 'amadeus'); undefined = default. */
  activeMode?: string

  createdAt: number
  updatedAt: number
}

/**
 * Room store interface (`02-public-contracts.md` §2.3).
 *
 * The initial implementation is in-memory (process lifetime). Persistence of
 * context* is not required in Wave 1; *persistent memory* is Wave 4 and is a
 * different subsystem.
 */
export interface RoomStore {
  get: (roomId: ConversationRoomId) => ConversationRoom | undefined
  getOrCreate: (roomId: ConversationRoomId, characterId: string) => ConversationRoom
  appendTurn: (roomId: ConversationRoomId, turn: ConversationTurn) => void
  setRunningSummary: (roomId: ConversationRoomId, summary: string) => void
  setActiveMode: (roomId: ConversationRoomId, mode: string | undefined) => void
  clear: (roomId: ConversationRoomId) => void
}

/**
 * Bounded capacity for `recentTurns`. Defaults to today's
 * `CONVERSATION_MAX_MESSAGES` (`config().brain.maxMessages`, default 24) so
 * the room store matches the prior per-guild bound before it is rewired.
 */
function defaultMaxTurns(): number {
  const n = config().brain.maxMessages
  return Number.isFinite(n) && n > 0 ? n : 24
}

/**
 * In-memory, process-lifetime `RoomStore`.
 *
 * Rooms are lazily created on first `getOrCreate`/`appendTurn`.
 * `recentTurns` is bounded to `maxTurns` (default {@link defaultMaxTurns});
 * the oldest turns are dropped when the bound is exceeded, exactly mirroring
 * today's `GuildSession.trim`. The store keeps no long-term memory and writes
 * nothing to disk.
 */
export class InMemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<ConversationRoomId, ConversationRoom>()
  private readonly maxTurns: number

  constructor(options?: { maxTurns?: number }) {
    this.maxTurns = options?.maxTurns ?? defaultMaxTurns()
  }

  get(roomId: ConversationRoomId): ConversationRoom | undefined {
    return this.rooms.get(roomId)
  }

  getOrCreate(roomId: ConversationRoomId, characterId: string): ConversationRoom {
    let room = this.rooms.get(roomId)
    if (!room) {
      const now = Date.now()
      room = {
        id: roomId,
        characterId,
        recentTurns: [],
        createdAt: now,
        updatedAt: now,
      }
      this.rooms.set(roomId, room)
    }
    return room
  }

  appendTurn(roomId: ConversationRoomId, turn: ConversationTurn): void {
    const room = this.getOrCreate(roomId, '')
    room.recentTurns.push(turn)
    room.updatedAt = Date.now()
    this.trim(room)
  }

  setRunningSummary(roomId: ConversationRoomId, summary: string): void {
    const room = this.getOrCreate(roomId, '')
    room.runningSummary = summary
    room.updatedAt = Date.now()
  }

  setActiveMode(roomId: ConversationRoomId, mode: string | undefined): void {
    const room = this.getOrCreate(roomId, '')
    room.activeMode = mode
    room.updatedAt = Date.now()
  }

  clear(roomId: ConversationRoomId): void {
    const room = this.rooms.get(roomId)
    if (!room)
      return
    room.recentTurns = []
    room.runningSummary = undefined
    room.updatedAt = Date.now()
  }

  /** Drop oldest turns so recentTurns never exceeds the configured bound. */
  private trim(room: ConversationRoom): void {
    if (room.recentTurns.length <= this.maxTurns)
      return
    room.recentTurns = room.recentTurns.slice(room.recentTurns.length - this.maxTurns)
  }
}
