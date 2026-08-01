import type { AvatarBehavior, AvatarStateSnapshot } from '@proj-airi/discord-avatar-protocol'

import { defineStore } from 'pinia'
import { ref } from 'vue'

export type AvatarConnectionStatus = 'connecting' | 'authenticated' | 'disconnected' | 'reconnecting'

export const useAvatarStore = defineStore('discord-avatar', () => {
  const status = ref<AvatarConnectionStatus>('connecting')
  const snapshot = ref<AvatarStateSnapshot>()
  const retiredSessions = new Set<string>()

  function replace(next: AvatarStateSnapshot, guildId: string, channelId: string): boolean {
    if (next.guildId !== guildId || next.channelId !== channelId)
      return false
    if (retiredSessions.has(next.sessionId))
      return false
    if (snapshot.value && snapshot.value.sessionId !== next.sessionId)
      retiredSessions.add(snapshot.value.sessionId)
    snapshot.value = next
    return true
  }

  function apply(next: AvatarStateSnapshot, guildId: string, channelId: string): boolean {
    if (next.guildId !== guildId || next.channelId !== channelId)
      return false
    const current = snapshot.value
    if (retiredSessions.has(next.sessionId))
      return false
    if (current?.sessionId === next.sessionId && next.sequence <= current.sequence)
      return false
    if (current && current.sessionId !== next.sessionId)
      retiredSessions.add(current.sessionId)
    snapshot.value = next
    return true
  }

  return { status, snapshot, replace, apply }
})

export const behaviorMotion: Record<AvatarBehavior, string> = {
  idle: 'Idle',
  listening: 'Curious',
  thinking: 'Think',
  speaking: 'Idle',
}

export function availableBehaviorMotion(behavior: AvatarBehavior, availableGroups: readonly string[]): string | undefined {
  const desired = behaviorMotion[behavior]
  const match = availableGroups.find(group => group.toLowerCase() === desired.toLowerCase())
  if (match)
    return match
  return availableGroups.find(group => group.toLowerCase() === 'idle')
}
