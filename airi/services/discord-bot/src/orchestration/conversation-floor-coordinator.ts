import type { ConversationFloorOptions, FloorDecision } from './conversation-floor'
import type { ConversationInput, TranscribedUtterance } from './group-turn-builder'

import { ConversationFloorRegistry } from './conversation-floor'

export interface ConversationFloorCoordinatorOptions {
  floorOptions: (guildId: string) => ConversationFloorOptions
  onFlush: (input: ConversationInput) => Promise<void> | void
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/** Timer/lifecycle adapter around the pure per-guild floor API. */
export class ConversationFloorCoordinator {
  private readonly floors: ConversationFloorRegistry
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void

  constructor(private readonly options: ConversationFloorCoordinatorOptions) {
    this.floors = new ConversationFloorRegistry(options.floorOptions)
    this.now = options.now ?? Date.now
    this.setTimer = options.setTimer ?? setTimeout
    this.clearTimer = options.clearTimer ?? clearTimeout
  }

  add(utterance: TranscribedUtterance): FloorDecision {
    const guildId = utterance.inputEvent.guildId!
    const decision = this.floors.get(guildId).add(utterance)
    if (decision.kind === 'accepted')
      this.schedule(guildId, decision.flushAt)
    // Overflow leaves the original group timer intact. Flushing immediately
    // would race transcripts already completing ASR inside the same window.
    return decision
  }

  hasPending(guildId: string): boolean {
    return this.timers.has(guildId)
  }

  clear(guildId: string): void {
    const timer = this.timers.get(guildId)
    if (timer)
      this.clearTimer(timer)
    this.timers.delete(guildId)
    this.floors.delete(guildId)
  }

  private schedule(guildId: string, flushAt: number): void {
    const current = this.timers.get(guildId)
    if (current)
      this.clearTimer(current)
    const timer = this.setTimer(() => {
      this.timers.delete(guildId)
      const input = this.floors.get(guildId).flush(this.now())
      if (input)
        void this.options.onFlush(input)
    }, Math.max(0, flushAt - this.now()))
    this.timers.set(guildId, timer)
  }
}
