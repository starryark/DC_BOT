import type { TranscribedUtterance } from './group-turn-builder'

import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import { buildDiscordActorEvidence } from '../memory/discord-actor-snapshot'
import { ConversationFloorCoordinator } from './conversation-floor-coordinator'

const BASE = 1_700_000_000_000
const GROUP_WINDOW_MS = 800

interface ScheduledTimer {
  readonly callback: () => void
  readonly delayMs: number
  readonly handle: ReturnType<typeof setTimeout>
  cleared: boolean
  fired: boolean
}

function createTimerHandle(id: number): ReturnType<typeof setTimeout> {
  const handle: NodeJS.Timeout = {
    close() {
      return handle
    },
    hasRef() {
      return false
    },
    ref() {
      return handle
    },
    refresh() {
      return handle
    },
    unref() {
      return handle
    },
    [Symbol.dispose]() {},
    [Symbol.toPrimitive]() {
      return id
    },
    _onTimeout() {},
  }
  return handle
}

function createHarness() {
  let now = BASE
  let epoch = 7
  let nextTimerId = 1
  const timers: ScheduledTimer[] = []
  const onFlush = vi.fn()
  const coordinator = new ConversationFloorCoordinator({
    floorOptions: () => ({
      groupWindowMs: GROUP_WINDOW_MS,
      activeSpeakerLeaseMs: 5_000,
      maxGroupSpeakers: 2,
      maxGroupUtterances: 4,
      isEpochCurrent: candidate => candidate === epoch,
    }),
    onFlush,
    now: () => now,
    setTimer(callback, delayMs) {
      const scheduled: ScheduledTimer = {
        callback,
        delayMs,
        handle: createTimerHandle(nextTimerId++),
        cleared: false,
        fired: false,
      }
      timers.push(scheduled)
      return scheduled.handle
    },
    clearTimer(handle) {
      const scheduled = timers.find(timer => timer.handle === handle)
      if (scheduled)
        scheduled.cleared = true
    },
  })

  return {
    coordinator,
    onFlush,
    timers,
    setNow(value: number) {
      now = value
    },
    cancelEpoch() {
      epoch += 1
    },
    fire(timer: ScheduledTimer) {
      timer.fired = true
      timer.callback()
    },
  }
}

function utterance(userId: string, startedAt: number, endedAt: number, responseEpoch = 7): TranscribedUtterance {
  return {
    inputEvent: {
      type: 'voice',
      eventId: `g1:${userId}:${startedAt}`,
      turnId: `turn-${userId}`,
      guildId: 'g1',
      channelId: 'voice-1',
      voiceChannelId: 'voice-1',
      userId,
      displayName: userId,
      actorEvidence: buildDiscordActorEvidence({ userId, displayName: userId, guildId: 'g1', observedAtEpochMs: startedAt, source: 'gateway' }),
      timestamp: endedAt,
      pcm: Buffer.from([1]),
      sampleRate: 16000,
    },
    text: `message from ${userId}`,
    language: 'en',
    startedAt,
    endedAt,
    responseEpoch,
    understanding: { responseLanguage: 'en', confidence: 0.9, reason: 'english-sentence', isAmbiguous: false, entities: [] },
  }
}

describe('conversationFloorCoordinator', () => {
  // ROOT CAUSE:
  //
  // A timer callback used to surrender ownership before asking the floor to
  // flush. When the injected clock was still before `flushAt`, the floor kept
  // its collection but the coordinator left it without a retry timer.
  //
  // The callback now retains a live schedule until the floor is actually due.
  it('re-arms a pending group when its timer callback fires early (IEV-803)', () => {
    const harness = createHarness()
    const flushAt = BASE + GROUP_WINDOW_MS
    expect(harness.coordinator.add(utterance('u1', BASE - 100, BASE))).toEqual({ kind: 'accepted', flushAt })
    expect(harness.timers[0].delayMs).toBe(GROUP_WINDOW_MS)

    harness.setNow(flushAt - 1)
    harness.fire(harness.timers[0])
    const retainedRetry = harness.coordinator.hasPending('g1')
    expect(harness.timers).toHaveLength(2)
    expect(harness.timers[1].delayMs).toBe(1)
    expect(harness.timers[1].cleared).toBe(false)

    // The unchanged flushAt proves the original collection remained in the
    // floor; a new collection would derive its window from this later ending.
    expect(harness.coordinator.add(utterance('u2', BASE + 1, BASE + 2))).toEqual({ kind: 'accepted', flushAt })
    expect(retainedRetry).toBe(true)
    expect(harness.onFlush).not.toHaveBeenCalled()

    const activeTimer = harness.timers.at(-1)!
    expect(activeTimer.delayMs).toBe(1)
    harness.setNow(flushAt)
    harness.fire(activeTimer)

    expect(harness.coordinator.hasPending('g1')).toBe(false)
    expect(harness.onFlush).toHaveBeenCalledTimes(1)
  })

  it('ignores a stale callback after a newer timer owns the guild schedule', () => {
    const harness = createHarness()
    const flushAt = BASE + GROUP_WINDOW_MS
    harness.coordinator.add(utterance('u1', BASE - 100, BASE))
    const staleTimer = harness.timers[0]
    harness.coordinator.add(utterance('u2', BASE + 1, BASE + 2))
    const activeTimer = harness.timers[1]

    expect(staleTimer.cleared).toBe(true)
    harness.setNow(flushAt)
    harness.fire(staleTimer)

    expect(harness.coordinator.hasPending('g1')).toBe(true)
    expect(harness.onFlush).not.toHaveBeenCalled()

    harness.fire(activeTimer)
    expect(harness.coordinator.hasPending('g1')).toBe(false)
    expect(harness.onFlush).toHaveBeenCalledTimes(1)
    expect(harness.onFlush.mock.calls[0][0].utterances).toHaveLength(2)
  })

  it('clear cancels the active timer and makes its captured callback inert', () => {
    const harness = createHarness()
    const flushAt = BASE + GROUP_WINDOW_MS
    harness.coordinator.add(utterance('u1', BASE - 100, BASE))
    const staleTimer = harness.timers[0]

    harness.coordinator.clear('g1')
    expect(staleTimer.cleared).toBe(true)
    expect(harness.coordinator.hasPending('g1')).toBe(false)

    harness.setNow(flushAt)
    harness.fire(staleTimer)
    expect(harness.coordinator.hasPending('g1')).toBe(false)
    expect(harness.onFlush).not.toHaveBeenCalled()
  })

  it('terminates a due schedule without flushing after its response epoch is cancelled', () => {
    const harness = createHarness()
    const flushAt = BASE + GROUP_WINDOW_MS
    harness.coordinator.add(utterance('u1', BASE - 100, BASE))
    harness.cancelEpoch()

    harness.setNow(flushAt)
    harness.fire(harness.timers[0])

    expect(harness.coordinator.hasPending('g1')).toBe(false)
    expect(harness.onFlush).not.toHaveBeenCalled()
  })
})
