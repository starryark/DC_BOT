import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { env } from 'node:process'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetConfigCache } from '../config'
import {
  buildCharacterRuntime,
  CharacterLoadError,
  FileCharacterRegistry,
  resolveRelativeAsset,
} from './character-registry'

/**
 * Character registry tests (`02-public-contracts.md` §5.2, master plan §16 1A).
 *
 * The headline compatibility requirement: the LIVE `Makise Kurisu/card.json`
 * (which has NO `extensions.dc_bot`) MUST load into a normalized
 * CharacterRuntime without throwing — identity, voice, ASR hotwords, avatar
 * metadata, and output protocol all present with safe defaults.
 */
// Test file lives at src/character/. The LIVE card
// is at <discord_bot>/characters/Makise Kurisu/card.json.
const REPO_ROOT = resolvePath(__dirname, '../..')
const CARD_DIR = resolvePath(REPO_ROOT, 'characters', 'Makise Kurisu')
const KURISU_CARD_JSON = readFileSync(resolvePath(CARD_DIR, 'card.json'), 'utf8')

beforeEach(() => {
  // Each test gets a clean config cache (config.ts is cached and may be read
  // by the registry when characterRoots is absent).
  resetConfigCache()
})

afterEach(() => {
  resetConfigCache()
})

describe('fileCharacterRegistry — LIVE Kurisu card (compatibility)', () => {
  it('loads the live card interaction profile into a full runtime', () => {
    const registry = new FileCharacterRegistry({
      resolvePath: () => ({ dir: CARD_DIR, json: KURISU_CARD_JSON }),
    })
    const runtime = registry.load('kurisu')

    expect(runtime.id).toBe('kurisu')
    expect(runtime.name).toBe('Makise Kurisu')
    // identity comes from the semantic card fields (NOT creator_notes).
    expect(runtime.identity.systemPrompt).toContain('牧瀬紅莉栖')
    expect(runtime.identity.systemPrompt.length).toBeGreaterThan(50)
    expect(runtime.identity.description).toContain('牧瀬紅莉栖')
    expect(runtime.identity.personality.length).toBeGreaterThan(0)
    expect(runtime.identity.scenario.length).toBeGreaterThan(0)
    expect(runtime.identity.postHistoryInstructions.length).toBeGreaterThan(0)

    // outputProtocol derived from canonical emotion list (creator_notes has it,
    // but extensions.dc_bot does not → defaults kick in).
    expect(runtime.outputProtocol).toBeDefined()
    expect(runtime.outputProtocol?.type).toBe('act-v1')
    expect(runtime.outputProtocol?.emotions).toContain('happy')
    expect(runtime.outputProtocol?.emotions).toContain('curious')
    expect(runtime.outputProtocol?.allowDelay).toBe(true)

    // voice derived from the AIRI speech extension.
    expect(runtime.voice.provider).toBe('gpt-sovits')
    expect(runtime.voice.voiceId).toBe('kurisu')
    expect(runtime.voice.promptLanguage).toBe('ja')

    expect(runtime.asr.hotwords).toContain('牧瀬紅莉栖')
    expect(runtime.asr.hotwords).toContain('アマデウス')

    // avatar displayModelId picked up from the AIRI extension.
    expect(runtime.avatar?.renderer).toBe('live2d')
    expect(runtime.avatar?.displayModelId).toBe('display-model-0-BFdupzrCE8y9q0Vofel')
  })

  it('returns the same immutable instance on repeat load (cache)', () => {
    const registry = new FileCharacterRegistry({
      resolvePath: () => ({ dir: CARD_DIR, json: KURISU_CARD_JSON }),
    })
    const a = registry.load('kurisu')
    const b = registry.load('kurisu')
    expect(b).toBe(a)
  })

  it('does NOT call Gemini / TTS / ASR / Discord / memory (pure data)', () => {
    // No provider imports happen; the only I/O is the card read, injected here.
    const calls: string[] = []
    const registry = new FileCharacterRegistry({
      resolvePath: () => {
        calls.push('read')
        return { dir: CARD_DIR, json: KURISU_CARD_JSON }
      },
    })
    registry.load('kurisu')
    expect(calls).toEqual(['read']) // exactly one read, nothing else.
  })
})

describe('fileCharacterRegistry — extensions.dc_bot present', () => {
  it('reads voice/asr/avatar/outputProtocol from extensions.dc_bot', () => {
    const json = JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: 3.0,
      data: {
        name: 'Test',
        system_prompt: 'be testy',
        extensions: {
          airi: { modules: {} },
          dc_bot: {
            outputProtocol: {
              type: 'act-v1',
              emotions: ['curious', 'neutral'],
              allowDelay: false,
            },
            voice: {
              provider: 'gpt-sovits',
              voiceId: 'kurisu',
              referenceAudio: 'voice/clip.wav',
              promptLanguage: 'ja',
            },
            asr: { hotwords: ['牧瀬紅莉栖', 'アマデウス'] },
            avatar: { renderer: 'live2d', displayModelId: 'dm-1' },
          },
        },
      },
    })
    const registry = new FileCharacterRegistry({
      resolvePath: () => ({ dir: '/cards/test', json }),
    })
    const runtime = registry.load('test')

    expect(runtime.outputProtocol?.emotions).toEqual(['curious', 'neutral'])
    expect(runtime.outputProtocol?.allowDelay).toBe(false)
    expect(runtime.voice.voiceId).toBe('kurisu')
    expect(runtime.voice.referenceAudio).toBe('voice/clip.wav')
    expect(runtime.asr.hotwords).toEqual(['牧瀬紅莉栖', 'アマデウス'])
    expect(runtime.avatar?.displayModelId).toBe('dm-1')
  })

  it('preserves unknown CCv3 fields through validation', () => {
    const json = JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: 3.0,
      data: {
        name: 'Test',
        system_prompt: 'be testy',
        unknown_future_field: { keep: 'me' },
      },
    })
    const registry = new FileCharacterRegistry({
      resolvePath: () => ({ dir: '/cards/test', json }),
    })
    // Loading must not throw on unknown fields.
    expect(() => registry.load('test')).not.toThrow()
  })
})

describe('fileCharacterRegistry — error handling', () => {
  it('throws CharacterLoadError for a missing required field', () => {
    const json = JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: 3.0,
      data: { name: 'NoPersona' }, // missing system_prompt
    })
    const registry = new FileCharacterRegistry({
      resolvePath: () => ({ dir: '/cards/bad', json }),
    })
    expect(() => registry.load('bad')).toThrow(CharacterLoadError)
    expect(() => registry.load('bad')).toThrow(/system_prompt/)
  })

  // ROOT CAUSE:
  //
  // This case originally asserted /No character root/ for any unregistered id,
  // because config().character did not exist yet and defaultCharacterRoot()
  // always threw. Wiring CHARACTER_PATH (default '../../..') gave the registry
  // a real default root, so an unknown id now resolves to a path and fails on
  // the read instead. Both branches are real, so both are asserted.
  it('throws CharacterLoadError with the resolved path when the id has no card', () => {
    const registry = new FileCharacterRegistry({}) // no roots, no resolver
    expect(() => registry.load('ghost')).toThrow(CharacterLoadError)
    expect(() => registry.load('ghost')).toThrow(/Could not read card for character 'ghost'/)
  })

  it('throws CharacterLoadError naming the missing config when no root is configured', () => {
    const previous = env.CHARACTER_PATH
    env.CHARACTER_PATH = ''
    resetConfigCache()
    try {
      const registry = new FileCharacterRegistry({})
      expect(() => registry.load('ghost')).toThrow(CharacterLoadError)
      expect(() => registry.load('ghost')).toThrow(/No character root/)
    }
    finally {
      if (previous === undefined)
        delete env.CHARACTER_PATH
      else
        env.CHARACTER_PATH = previous
      resetConfigCache()
    }
  })
})

describe('buildCharacterRuntime — reference text resolution', () => {
  it('loads referenceText from referenceTextFile relative to the card dir', () => {
    const json = JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: 3.0,
      data: {
        name: 'Test',
        system_prompt: 'be testy',
        extensions: {
          dc_bot: {
            voice: { referenceAudio: 'voice/clip.wav', referenceTextFile: 'reference.txt' },
          },
        },
      },
    })
    // Use a temp directory that has a reference.txt next to it.
    const dir = mkdtempSync(resolvePath(tmpdir(), 'char-ref-'))
    writeFileSync(resolvePath(dir, 'reference.txt'), 'これは参照テキストです。')
    try {
      const runtime = buildCharacterRuntime('test', dir, json)
      expect(runtime.voice.referenceText).toBe('これは参照テキストです。')
      expect(runtime.voice.referenceTextFile).toBe('reference.txt')
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves referenceText undefined when the file is absent', () => {
    const json = JSON.stringify({
      spec: 'chara_card_v3',
      spec_version: 3.0,
      data: {
        name: 'Test',
        system_prompt: 'be testy',
        extensions: { dc_bot: { voice: { referenceTextFile: 'missing.txt' } } },
      },
    })
    const runtime = buildCharacterRuntime('test', '/cards/no-such', json)
    expect(runtime.voice.referenceText).toBeUndefined()
  })
})

describe('resolveRelativeAsset — path containment', () => {
  it('keeps a simple relative path relative', () => {
    expect(resolveRelativeAsset('/cards/k', 'voice/clip.wav')).toBe('voice/clip.wav')
  })

  it('reduces a traversal attempt to the basename', () => {
    expect(resolveRelativeAsset('/cards/k', '../../../etc/passwd')).toBe('passwd')
  })

  it('reduces an absolute path to the basename', () => {
    expect(resolveRelativeAsset('/cards/k', '/etc/passwd')).toBe('passwd')
  })

  it('normalizes separators to posix', () => {
    expect(resolveRelativeAsset('/cards/k', 'voice\\clip.wav')).toBe('voice/clip.wav')
  })

  it('returns empty for an empty input', () => {
    expect(resolveRelativeAsset('/cards/k', '')).toBe('')
    expect(resolveRelativeAsset('/cards/k', '   ')).toBe('')
  })
})
