import type {
  AvatarBehaviorSet,
  AvatarStateSnapshot,
  StateResultStatus,
} from '@proj-airi/discord-avatar-protocol'
import type { WebSocket } from 'ws'

interface Room {
  activeSessionId?: string
  latest?: AvatarStateSnapshot
  retiredSessions: Set<string>
  viewers: Set<WebSocket>
}

export interface ApplyResult {
  snapshot?: AvatarStateSnapshot
  status: StateResultStatus
}

export function roomKey(guildId: string, channelId: string): string {
  return `${guildId}\0${channelId}`
}

function sameState(current: AvatarStateSnapshot, update: AvatarBehaviorSet): boolean {
  return current.guildId === update.guildId
    && current.channelId === update.channelId
    && current.sessionId === update.sessionId
    && current.sequence === update.sequence
    && current.timestamp === update.timestamp
    && current.connected === update.connected
    && current.behavior === update.behavior
    && current.speaking === update.speaking
    && current.mouthOpen === update.mouthOpen
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>()

  establish(guildId: string, channelId: string): void {
    const key = roomKey(guildId, channelId)
    if (!this.rooms.has(key))
      this.rooms.set(key, { retiredSessions: new Set(), viewers: new Set() })
  }

  has(guildId: string, channelId: string): boolean {
    return this.rooms.get(roomKey(guildId, channelId))?.latest?.connected === true
  }

  apply(update: AvatarBehaviorSet): ApplyResult {
    const key = roomKey(update.guildId, update.channelId)
    this.establish(update.guildId, update.channelId)
    const room = this.rooms.get(key)!

    if (room.retiredSessions.has(update.sessionId))
      return { status: 'stale' }

    const current = room.latest
    if (room.activeSessionId === update.sessionId && current) {
      if (update.sequence < current.sequence)
        return { status: 'stale' }
      if (update.sequence === current.sequence)
        return { status: sameState(current, update) ? 'duplicate' : 'conflict' }
    }
    else if (room.activeSessionId) {
      room.retiredSessions.add(room.activeSessionId)
    }

    room.activeSessionId = update.sessionId
    const snapshot: AvatarStateSnapshot = { ...update, type: 'avatar.state.snapshot' }
    room.latest = snapshot
    const encoded = JSON.stringify(snapshot)
    for (const viewer of room.viewers) {
      if (viewer.readyState === viewer.OPEN)
        viewer.send(encoded)
    }
    return { snapshot, status: 'accepted' }
  }

  subscribe(guildId: string, channelId: string, viewer: WebSocket): AvatarStateSnapshot | undefined {
    this.establish(guildId, channelId)
    const room = this.rooms.get(roomKey(guildId, channelId))!
    room.viewers.add(viewer)
    return room.latest
  }

  unsubscribe(guildId: string, channelId: string, viewer: WebSocket): void {
    this.rooms.get(roomKey(guildId, channelId))?.viewers.delete(viewer)
  }

  removeViewer(viewer: WebSocket): void {
    for (const room of this.rooms.values())
      room.viewers.delete(viewer)
  }
}
