import type { TelemetryEventName, TelemetryFields } from '../telemetry'
import type { ConversationInput, TranscribedUtterance } from './group-turn-builder'

import { buildGroupTurn } from './group-turn-builder'

export type FloorDecision
  = | { kind: 'accepted', flushAt: number }
    | { kind: 'ignored', reason: 'empty_transcript' | 'window_closed' | 'active_speaker_lease' | 'cancelled_epoch' }
    | { kind: 'request_one_at_a_time', speakers: string[] }

export interface ConversationFloorOptions {
  groupWindowMs: number
  activeSpeakerLeaseMs: number
  maxGroupSpeakers: number
  maxGroupUtterances: number
  /** Adjacent fragments at or below this gap are one speaker message. */
  mergeGapMs?: number
  /** The floor never owns epoch state; the orchestrator supplies freshness. */
  isEpochCurrent: (epoch: number) => boolean
  emit?: (event: TelemetryEventName, fields: TelemetryFields) => void
}

interface ActiveSpeakerLease { userId: string, until: number }

/**
 * Per-guild floor state: one bounded collection, followed by one optional
 * active-speaker lease. It stores transcribed events—not PCM mixtures—and owns
 * no timer, generation, playback, or response epoch.
 */
export class ConversationFloor {
  private utterances: TranscribedUtterance[] = []
  private flushAt?: number
  private groupEpoch?: number
  private lease?: ActiveSpeakerLease
  private overflowSpeakers?: string[]

  constructor(private readonly options: ConversationFloorOptions) {}

  add(utterance: TranscribedUtterance): FloorDecision {
    if (!utterance.text.trim())
      return this.ignored(utterance, 'empty_transcript')
    if (!this.options.isEpochCurrent(utterance.responseEpoch))
      return this.ignored(utterance, 'cancelled_epoch')

    if (this.utterances.length === 0) {
      if (this.lease && utterance.startedAt < this.lease.until && utterance.inputEvent.userId !== this.lease.userId)
        return this.ignored(utterance, 'active_speaker_lease')
      this.flushAt = utterance.endedAt + this.options.groupWindowMs
      this.groupEpoch = utterance.responseEpoch
      this.options.emit?.('conversation_group_opened', {
        guildId: utterance.inputEvent.guildId,
        responseEpoch: utterance.responseEpoch,
        userId: utterance.inputEvent.userId,
        durationMs: this.options.groupWindowMs,
      })
    }
    else if (utterance.startedAt > this.flushAt! || utterance.responseEpoch !== this.groupEpoch) {
      return this.ignored(utterance, utterance.responseEpoch !== this.groupEpoch ? 'cancelled_epoch' : 'window_closed')
    }

    const previous = this.utterances.at(-1)
    this.utterances.push(utterance)
    if (previous && previous.inputEvent.userId === utterance.inputEvent.userId && utterance.startedAt - previous.endedAt <= (this.options.mergeGapMs ?? this.options.groupWindowMs)) {
      this.options.emit?.('utterance_merged', {
        guildId: utterance.inputEvent.guildId,
        responseEpoch: utterance.responseEpoch,
        userId: utterance.inputEvent.userId,
        chars: utterance.text.length,
      })
    }
    const speakers = this.distinctSpeakers()
    if (speakers.length > this.options.maxGroupSpeakers
      || this.utterances.length > this.options.maxGroupUtterances
      || hasHeavyCrossSpeakerOverlap(this.utterances)) {
      this.overflowSpeakers = speakers.map(speaker => speaker.displayName)
      return { kind: 'request_one_at_a_time', speakers: this.overflowSpeakers }
    }
    return { kind: 'accepted', flushAt: this.flushAt! }
  }

  flush(now: number): ConversationInput | undefined {
    if (this.flushAt == null || now < this.flushAt)
      return undefined
    const epoch = this.groupEpoch!
    if (!this.options.isEpochCurrent(epoch)) {
      this.clearCollection()
      return undefined
    }

    const utterances = this.utterances
    const overflowSpeakers = this.overflowSpeakers
    this.clearCollection()
    this.options.emit?.('conversation_group_flushed', {
      guildId: utterances[0].inputEvent.guildId,
      responseEpoch: epoch,
      speakers: new Set(utterances.map(item => item.inputEvent.userId)).size,
      utterances: utterances.length,
      durationMs: now - utterances[0].endedAt,
    })
    if (overflowSpeakers) {
      return {
        kind: 'request_one_at_a_time',
        guildId: utterances[0].inputEvent.guildId!,
        responseEpoch: epoch,
        speakers: overflowSpeakers,
      }
    }

    const result = buildGroupTurn(utterances, this.options.mergeGapMs ?? this.options.groupWindowMs)
    const last = result.messages.at(-1)!
    this.lease = { userId: last.userId, until: now + this.options.activeSpeakerLeaseMs }
    return result
  }

  clear(): void {
    this.clearCollection()
    this.lease = undefined
  }

  private clearCollection(): void {
    this.utterances = []
    this.flushAt = undefined
    this.groupEpoch = undefined
    this.overflowSpeakers = undefined
  }

  private distinctSpeakers(): Array<{ userId: string, displayName: string }> {
    const speakers = new Map<string, string>()
    for (const utterance of this.utterances)
      speakers.set(utterance.inputEvent.userId, utterance.inputEvent.displayName)
    return [...speakers].map(([userId, displayName]) => ({ userId, displayName }))
  }

  private ignored(utterance: TranscribedUtterance, reason: 'empty_transcript' | 'window_closed' | 'active_speaker_lease' | 'cancelled_epoch'): FloorDecision {
    this.options.emit?.('utterance_discarded', {
      guildId: utterance.inputEvent.guildId,
      responseEpoch: utterance.responseEpoch,
      userId: utterance.inputEvent.userId,
      reason,
    })
    return { kind: 'ignored', reason }
  }
}

/** More than half of the shorter utterance overlaps another speaker. */
function hasHeavyCrossSpeakerOverlap(utterances: readonly TranscribedUtterance[]): boolean {
  for (let leftIndex = 0; leftIndex < utterances.length; leftIndex++) {
    const left = utterances[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < utterances.length; rightIndex++) {
      const right = utterances[rightIndex]
      if (left.inputEvent.userId === right.inputEvent.userId)
        continue
      const overlap = Math.max(0, Math.min(left.endedAt, right.endedAt) - Math.max(left.startedAt, right.startedAt))
      const shorter = Math.min(left.endedAt - left.startedAt, right.endedAt - right.startedAt)
      if (shorter > 0 && overlap / shorter > 0.5)
        return true
    }
  }
  return false
}

/** Keeps floor windows isolated and lifecycle-clear per Discord guild. */
export class ConversationFloorRegistry {
  private readonly floors = new Map<string, ConversationFloor>()

  constructor(private readonly optionsForGuild: (guildId: string) => ConversationFloorOptions) {}

  get(guildId: string): ConversationFloor {
    let floor = this.floors.get(guildId)
    if (!floor) {
      floor = new ConversationFloor(this.optionsForGuild(guildId))
      this.floors.set(guildId, floor)
    }
    return floor
  }

  delete(guildId: string): void {
    this.floors.get(guildId)?.clear()
    this.floors.delete(guildId)
  }
}
