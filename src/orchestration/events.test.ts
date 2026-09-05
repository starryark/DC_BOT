import type {
  ActivityInteractionInputEvent,
  BaseInputEvent,
  DiscordMentionInputEvent,
  InputEvent,
  SlashCommandInputEvent,
  VoiceInputEvent,
} from './events'

import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from '../memory/discord-actor-snapshot'

/**
 * InputEvent union narrowing / field presence
 * (`02-public-contracts.md` §1). VoiceInputEvent mirrors VoiceUtterance
 * (pcm/sampleRate/voiceChannelId). Each variant carries the type-specific
 * fields the orchestrator narrows on.
 */

function base(overrides: Partial<BaseInputEvent> = {}): BaseInputEvent {
  return {
    eventId: 'e1',
    turnId: 't1',
    userId: 'u1',
    displayName: 'Tester',
    actorEvidence: buildDiscordActorEvidence({ userId: 'u1', displayName: 'Tester', observedAtEpochMs: 1, source: 'gateway' }),
    timestamp: 1,
    ...overrides,
  }
}

const voice: VoiceInputEvent = {
  ...base(),
  type: 'voice',
  voiceChannelId: 'vc1',
  pcm: Buffer.from([1, 2, 3]),
  sampleRate: 16000,
}

const mention: DiscordMentionInputEvent = {
  ...base(),
  type: 'discord-mention',
  messageId: 'm1',
  text: 'hello kurisu',
}

const slash: SlashCommandInputEvent = {
  ...base(),
  type: 'slash-command',
  commandName: 'voice-test',
}

const activity: ActivityInteractionInputEvent = {
  ...base(),
  type: 'activity',
  activitySessionId: 's1',
  action: 'poke',
  payload: { x: 1 },
}

describe('inputEvent — type narrowing', () => {
  it('narrows on type === "voice"', () => {
    const e: InputEvent = voice
    if (e.type === 'voice') {
      // Voice-specific fields are present and correctly typed.
      expect(e.voiceChannelId).toBe('vc1')
      expect(e.sampleRate).toBe(16000)
      expect(Buffer.isBuffer(e.pcm)).toBe(true)
      // text is NOT a field on voice (ASR runs after).
      expect((e as unknown as Record<string, unknown>).text).toBeUndefined()
    }
    else {
      expect.unreachable('should have narrowed to voice')
    }
  })

  it('narrows on type === "discord-mention" and exposes stripped mention text', () => {
    const e: InputEvent = mention
    if (e.type === 'discord-mention') {
      expect(e.messageId).toBe('m1')
      expect(e.text).toBe('hello kurisu')
      // pcm/voiceChannelId are NOT on mention.
      expect((e as unknown as Record<string, unknown>).pcm).toBeUndefined()
      expect((e as unknown as Record<string, unknown>).voiceChannelId).toBeUndefined()
    }
  })

  it('narrows on type === "slash-command"', () => {
    const e: InputEvent = slash
    if (e.type === 'slash-command')
      expect(e.commandName).toBe('voice-test')
  })

  it('narrows on type === "activity"', () => {
    const e: InputEvent = activity
    if (e.type === 'activity') {
      expect(e.activitySessionId).toBe('s1')
      expect(e.action).toBe('poke')
      expect(e.payload).toEqual({ x: 1 })
    }
  })

  it('every variant carries the shared BaseInputEvent fields', () => {
    for (const e of [voice, mention, slash, activity] as InputEvent[]) {
      expect(e.eventId).toBe('e1')
      expect(e.turnId).toBe('t1')
      expect(e.userId).toBe('u1')
      expect(e.displayName).toBe('Tester')
      expect(e.timestamp).toBe(1)
    }
  })

  it('voiceInputEvent mirrors VoiceUtterance pcm/sampleRate/channels concerns (16kHz mono PCM16)', () => {
    // The voice adapter converts a VoiceUtterance into a VoiceInputEvent; the
    // orchestrator contract fixes sampleRate at 16000.
    expect(voice.sampleRate).toBe(16000)
    expect(Buffer.isBuffer(voice.pcm)).toBe(true)
  })

  it('the four type tags exhaust the union (compile-time exhaustiveness check)', () => {
    const tags: InputEvent['type'][] = ['voice', 'discord-mention', 'slash-command', 'activity']
    expect(new Set(tags).size).toBe(4)
    // Exhaustive switch proves the union is exactly these four.
    function label(e: InputEvent): string {
      switch (e.type) {
        case 'voice': return 'voice'
        case 'discord-mention': return 'mention'
        case 'slash-command': return 'slash'
        case 'activity': return 'activity'
      }
    }
    expect(label(voice)).toBe('voice')
    expect(label(mention)).toBe('mention')
    expect(label(slash)).toBe('slash')
    expect(label(activity)).toBe('activity')
  })
})
