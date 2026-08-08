import type { VoiceInputEvent } from '../orchestration/events'
import type { ConversationRoom, ConversationTurn } from '../orchestration/room'
import type { CharacterRuntime } from './types'

import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from '../memory/discord-actor-snapshot'
import { DefaultPromptCompiler, estimateTokens } from './prompt-compiler'

/** A minimal character for deterministic ordering assertions. */
function makeCharacter(overrides: Partial<CharacterRuntime> = {}): CharacterRuntime {
  return {
    id: 'kurisu',
    name: 'Makise Kurisu',
    identity: {
      description: 'DESCRIPTION_MARKER',
      personality: 'PERSONALITY_MARKER',
      scenario: 'SCENARIO_MARKER',
      systemPrompt: 'PERSONA_MARKER',
      postHistoryInstructions: 'POSTHISTORY_MARKER',
    },
    voice: { provider: 'gpt-sovits', voiceId: 'kurisu', referenceAudio: '', promptLanguage: 'ja' },
    asr: { hotwords: [] },
    interaction: { defaultResponseLanguage: 'ja', entities: [], pronunciationProfileVersion: 'test-v1' },
    avatar: { renderer: 'live2d' },
    outputProtocol: { type: 'act-v1', emotions: ['happy', 'neutral'], allowDelay: true },
    ...overrides,
  }
}

function makeRoom(recentTurns: ConversationTurn[] = []): ConversationRoom {
  return {
    id: 'guild:g:voice:c',
    characterId: 'kurisu',
    recentTurns,
    createdAt: 1,
    updatedAt: 2,
  }
}

function makeInput(text: string): { input: VoiceInputEvent, text: string } {
  return {
    input: {
      type: 'voice',
      eventId: 't1:in',
      turnId: 't1',
      guildId: 'g',
      channelId: 'c',
      userId: 'u',
      displayName: 'Okabe',
      actorEvidence: buildDiscordActorEvidence({ userId: 'u', displayName: 'Okabe', observedAtEpochMs: 100, source: 'gateway' }),
      timestamp: 100,
      voiceChannelId: 'c',
      pcm: Buffer.alloc(0),
      sampleRate: 16000,
    },
    text,
  }
}

const compiler = new DefaultPromptCompiler()

describe('defaultPromptCompiler — exact §5.3 ordering', () => {
  it('places runtime safety BEFORE persona in systemInstruction', () => {
    const character = makeCharacter()
    const room = makeRoom()
    const { input, text } = makeInput('hi')
    const { prompt } = compiler.compile({ character, room, currentInput: input, currentInputText: text })

    const safetyIdx = prompt.systemInstruction.indexOf('output language')
    const personaIdx = prompt.systemInstruction.indexOf('PERSONA_MARKER')
    expect(safetyIdx).toBeGreaterThan(-1)
    expect(personaIdx).toBeGreaterThan(-1)
    expect(safetyIdx).toBeLessThan(personaIdx)
  })

  it('places persona BEFORE description/personality/scenario', () => {
    const character = makeCharacter()
    const room = makeRoom()
    const { input, text } = makeInput('hi')
    const { prompt } = compiler.compile({ character, room, currentInput: input, currentInputText: text })

    const personaIdx = prompt.systemInstruction.indexOf('PERSONA_MARKER')
    const descIdx = prompt.systemInstruction.indexOf('DESCRIPTION_MARKER')
    const persIdx = prompt.systemInstruction.indexOf('PERSONALITY_MARKER')
    const scenIdx = prompt.systemInstruction.indexOf('SCENARIO_MARKER')
    expect(personaIdx).toBeLessThan(descIdx)
    expect(descIdx).toBeLessThan(persIdx)
    expect(persIdx).toBeLessThan(scenIdx)
  })

  it('places post_history_instructions at the very end of systemInstruction', () => {
    const character = makeCharacter()
    const room = makeRoom()
    const { input, text } = makeInput('hi')
    const { prompt } = compiler.compile({ character, room, currentInput: input, currentInputText: text })

    const postIdx = prompt.systemInstruction.indexOf('POSTHISTORY_MARKER')
    expect(postIdx).toBeGreaterThan(-1)
    // Nothing semantic after it — the post_history section is the tail.
    expect(prompt.systemInstruction.lastIndexOf('---')).toBeLessThan(postIdx)
  })

  it('includes the ACT-v1 output protocol instructions in the safety section', () => {
    const character = makeCharacter()
    const room = makeRoom()
    const { input, text } = makeInput('hi')
    const { prompt } = compiler.compile({ character, room, currentInput: input, currentInputText: text })

    expect(prompt.systemInstruction).toContain('<|ACT:"emotion"')
    expect(prompt.systemInstruction).toContain('happy, neutral')
  })
})

describe('defaultPromptCompiler — contents (turns + current input)', () => {
  it('renders recent turns oldest-first, then the current input as the last user turn', () => {
    const character = makeCharacter()
    const room = makeRoom([
      { turnId: 't0', role: 'user', speaker: 'Okabe', text: 'hello', timestamp: 1 },
      { turnId: 't0a', role: 'assistant', text: 'hi there', timestamp: 2 },
      { turnId: 't1', role: 'user', speaker: 'Mayuri', text: 'tutturu', timestamp: 3 },
    ])
    const { input, text } = makeInput('next?')
    const { prompt } = compiler.compile({ character, room, currentInput: input, currentInputText: text })

    expect(prompt.contents).toHaveLength(4)
    expect(prompt.contents[0]).toEqual({ role: 'user', parts: [{ text: 'Okabe: hello' }] })
    expect(prompt.contents[1]).toEqual({ role: 'model', parts: [{ text: 'hi there' }] })
    expect(prompt.contents[2]).toEqual({ role: 'user', parts: [{ text: 'Mayuri: tutturu' }] })
    // current input is the final user turn, speaker-labeled.
    expect(prompt.contents[3]).toEqual({ role: 'user', parts: [{ text: 'Okabe: next?' }] })
  })

  it('omits the persona section cleanly when system_prompt is empty', () => {
    const character = makeCharacter({
      identity: {
        description: 'D',
        personality: 'P',
        scenario: 'S',
        systemPrompt: '',
        postHistoryInstructions: '',
      },
    })
    const room = makeRoom()
    const { input, text } = makeInput('hi')
    const { prompt } = compiler.compile({ character, room, currentInput: input, currentInputText: text })
    expect(prompt.systemInstruction).not.toContain('PERSONA_MARKER')
    // Safety section still present.
    expect(prompt.systemInstruction).toContain('output language')
  })
})

describe('defaultPromptCompiler — lorebook activation', () => {
  it('activates entries whose keys appear in recent turns or the current input', () => {
    const character = makeCharacter({
      lorebook: {
        entries: [
          { keys: ['タイムマシン'], content: 'TIME_MACHINE_LORE' },
          { keys: ['アマデウス'], content: 'AMADEUS_LORE' },
          { keys: ['never-mentioned'], content: 'SHOULD_NOT_APPEAR' },
        ],
      },
    })
    const room = makeRoom([
      { turnId: 't0', role: 'user', speaker: 'Okabe', text: 'タイムマシンって作れる？', timestamp: 1 },
    ])
    const { input, text } = makeInput('アマデウスについて教えて')
    const { prompt, metrics } = compiler.compile({ character, room, currentInput: input, currentInputText: text })

    expect(prompt.systemInstruction).toContain('TIME_MACHINE_LORE')
    expect(prompt.systemInstruction).toContain('AMADEUS_LORE')
    expect(prompt.systemInstruction).not.toContain('SHOULD_NOT_APPEAR')
    expect(metrics.loreEntryCount).toBe(2)
  })

  it('orders activated entries by insertionOrder (ascending)', () => {
    const character = makeCharacter({
      lorebook: {
        entries: [
          { keys: ['k'], content: 'SECOND', insertionOrder: 5 },
          { keys: ['k'], content: 'FIRST', insertionOrder: 1 },
        ],
      },
    })
    const room = makeRoom()
    const { input, text } = makeInput('k')
    const { prompt } = compiler.compile({ character, room, currentInput: input, currentInputText: text })
    expect(prompt.systemInstruction.indexOf('FIRST')).toBeLessThan(prompt.systemInstruction.indexOf('SECOND'))
  })

  it('respects enabled=false', () => {
    const character = makeCharacter({
      lorebook: { entries: [{ keys: ['k'], content: 'DISABLED', enabled: false }] },
    })
    const room = makeRoom()
    const { input, text } = makeInput('k')
    const { prompt, metrics } = compiler.compile({ character, room, currentInput: input, currentInputText: text })
    expect(prompt.systemInstruction).not.toContain('DISABLED')
    expect(metrics.loreEntryCount).toBe(0)
  })
})

describe('defaultPromptCompiler — memories + summary + metrics', () => {
  it('includes retrieved memories and the running summary in systemInstruction', () => {
    const character = makeCharacter()
    const room = makeRoom()
    room.runningSummary = 'SUMMARY_MARKER'
    const { input, text } = makeInput('hi')
    const { prompt, metrics } = compiler.compile({
      character,
      room,
      currentInput: input,
      currentInputText: text,
      memories: [{ text: 'MEMORY_ONE' }, { text: 'MEMORY_TWO' }],
    })
    expect(prompt.systemInstruction).toContain('MEMORY_ONE')
    expect(prompt.systemInstruction).toContain('MEMORY_TWO')
    expect(prompt.systemInstruction).toContain('SUMMARY_MARKER')
    expect(metrics.memoryCount).toBe(2)
  })

  it('reports recentTurnCount and a non-zero approximateTokens', () => {
    const character = makeCharacter()
    const room = makeRoom([
      { turnId: 't0', role: 'user', speaker: 'Okabe', text: 'こんにちは', timestamp: 1 },
    ])
    const { input, text } = makeInput('調子はどう？')
    const { metrics } = compiler.compile({ character, room, currentInput: input, currentInputText: text })
    expect(metrics.recentTurnCount).toBe(1)
    expect(metrics.approximateTokens).toBeGreaterThan(0)
  })

  it('compiles deterministically for the same input (stable order/content)', () => {
    const character = makeCharacter()
    const room = makeRoom([
      { turnId: 't0', role: 'user', speaker: 'Okabe', text: 'same', timestamp: 1 },
    ])
    const { input, text } = makeInput('same')
    const a = compiler.compile({ character, room, currentInput: input, currentInputText: text })
    const b = compiler.compile({ character, room, currentInput: input, currentInputText: text })
    expect(a.prompt.systemInstruction).toBe(b.prompt.systemInstruction)
    expect(a.prompt.contents).toEqual(b.prompt.contents)
    expect(a.metrics).toEqual(b.metrics)
  })
})

describe('estimateTokens — heuristic', () => {
  it('counts latin text at ~chars/4 and CJK at ~chars/2', () => {
    // "hello" (5 latin) → ceil(5/4) = 2
    expect(estimateTokens('hello')).toBe(2)
    // 4 CJK glyphs → ceil(4/2) = 2
    expect(estimateTokens('牧瀬紅莉')).toBe(2)
    // empty → 0
    expect(estimateTokens('')).toBe(0)
  })
})
