import type { Readable } from 'node:stream'

import type { TtsProvider, TtsRequest } from './types'

import { Buffer } from 'node:buffer'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable as NodeReadable } from 'node:stream'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CachedTtsProvider, cacheKey, fingerprint, TTS_CACHE_KEY_VERSION } from './tts-cache'

const roots: string[] = []

function wav(durationMs = 200, sampleRate = 16_000): Buffer {
  const dataBytes = Math.floor(sampleRate * 2 * durationMs / 1000)
  const audio = Buffer.alloc(44 + dataBytes)
  audio.write('RIFF', 0)
  audio.writeUInt32LE(audio.length - 8, 4)
  audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16)
  audio.writeUInt16LE(1, 20)
  audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(sampleRate, 24)
  audio.writeUInt32LE(sampleRate * 2, 28)
  audio.writeUInt16LE(2, 32)
  audio.writeUInt16LE(16, 34)
  audio.write('data', 36)
  audio.writeUInt32LE(dataBytes, 40)
  return audio
}

async function bytes(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function fixture(overrides: Partial<ConstructorParameters<typeof CachedTtsProvider>[1]> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'tts-cache-'))
  roots.push(directory)
  const synthesize = vi.fn(async () => NodeReadable.from(wav()))
  const provider: TtsProvider = { synthesize }
  const identity = (request: TtsRequest) => ({
    normalizedText: request.text,
    textLanguage: request.language,
    pronunciationProfileVersion: request.pronunciationProfileVersion,
    voiceModelVersion: 'voice-v1',
    catalogVersion: request.conditioning?.catalogVersion ?? 'single-reference-v1',
    profileId: request.conditioning?.profileId ?? 'neutral',
    referenceAudioFingerprint: fingerprint('ref-a'),
    promptTextFingerprint: fingerprint('prompt'),
    promptLanguage: 'ja',
    topK: request.conditioning?.topK ?? 15,
    topP: request.conditioning?.topP ?? 1,
    temperature: request.conditioning?.temperature ?? 1,
    repetitionPenalty: request.conditioning?.repetitionPenalty ?? 1.35,
    speedFactor: request.conditioning?.speedFactor ?? 1,
    fragmentInterval: request.conditioning?.fragmentInterval ?? 0.3,
    seed: request.conditioning?.seed ?? -1,
    variationIndex: request.conditioning?.variationIndex ?? 0,
    mediaType: 'wav',
    streamingMode: 0,
    textSplitMethod: 'cut5',
  })
  const options = { enabled: true, directory, maxBytes: 1024 * 1024, maxItems: 10, ttlMs: 60_000, memoryItems: 2, identity, ...overrides }
  return { directory, synthesize, options, cache: new CachedTtsProvider(provider, options) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('cachedTtsProvider', () => {
  const request = { text: 'こんにちは', language: 'ja' } as const

  it('serves a memory hit without another provider request', async () => {
    const { cache, synthesize } = await fixture()
    await bytes(await cache.synthesize(request, new AbortController().signal))
    await bytes(await cache.synthesize(request, new AbortController().signal))
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('serves a disk hit in a fresh cache instance', async () => {
    const { cache, synthesize, options } = await fixture()
    await bytes(await cache.synthesize(request, new AbortController().signal))
    const fresh = new CachedTtsProvider({ synthesize }, options)
    await bytes(await fresh.synthesize(request, new AbortController().signal))
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('invalidates keys when configuration or reference audio changes', async () => {
    const { options } = await fixture()
    const base = options.identity(request)!
    expect(cacheKey({ ...base, voiceModelVersion: 'voice-v2' })).not.toBe(cacheKey(base))
    expect(cacheKey({ ...base, referenceAudioFingerprint: fingerprint('ref-b') })).not.toBe(cacheKey(base))
  })

  it('keys every audio-affecting conditioning field but ignores trace context', async () => {
    const { options } = await fixture()
    const conditioned = {
      ...request,
      conditioning: {
        profileId: 'analytical', catalogVersion: 'v2', referenceAudio: 'think.wav', referenceText: 'exact words', promptLanguage: 'ja' as const,
        topK: 12, topP: 0.9, temperature: 0.74, repetitionPenalty: 1.38, speedFactor: 0.99, fragmentInterval: 0.16,
        textSplitMethod: 'cut0', seed: 12002, variationIndex: 1,
      },
    }
    const base = options.identity(conditioned)!
    expect(cacheKey({ ...base, seed: 12003 })).not.toBe(cacheKey(base))
    expect(cacheKey({ ...base, temperature: 0.75 })).not.toBe(cacheKey(base))
    expect(options.identity({ ...conditioned, trace: { guildId: 'other', turnId: 'other', responseEpoch: 9, chunkIndex: 4 } })).toEqual(base)
  })

  it('does not read partial entries', async () => {
    const { directory, cache, synthesize, options } = await fixture()
    const key = cacheKey(options.identity(request)!)
    const folder = join(directory, key.slice(0, 2))
    await writeFile(join(directory, 'placeholder'), '')
    await rm(join(directory, 'placeholder'))
    await import('node:fs/promises').then(fs => fs.mkdir(folder, { recursive: true }))
    await writeFile(join(folder, `${key}.audio`), wav())
    await bytes(await cache.synthesize(request, new AbortController().signal))
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent misses and writes one valid pair', async () => {
    const { directory, cache, synthesize } = await fixture()
    await Promise.all([cache.synthesize(request, new AbortController().signal), cache.synthesize(request, new AbortController().signal)])
    expect(synthesize).toHaveBeenCalledTimes(1)
    const prefix = (await readdir(directory))[0]
    const files = await readdir(join(directory, prefix))
    expect(files.filter(name => name.endsWith('.audio'))).toHaveLength(1)
    expect(files.filter(name => name.endsWith('.json'))).toHaveLength(1)
  })

  it('evicts oldest disk entries to respect item and size limits', async () => {
    const { directory, cache } = await fixture({ maxItems: 1, maxBytes: wav().length + 10, memoryItems: 1 })
    await bytes(await cache.synthesize(request, new AbortController().signal))
    await bytes(await cache.synthesize({ ...request, text: '二番目' }, new AbortController().signal))
    const prefixes = await readdir(directory)
    const files = (await Promise.all(prefixes.map(prefix => readdir(join(directory, prefix))))).flat()
    expect(files.filter(name => name.endsWith('.audio'))).toHaveLength(1)
    expect(files.filter(name => name.endsWith('.json'))).toHaveLength(1)
  })

  it('falls back to synthesis when disk metadata is corrupt', async () => {
    const { directory, cache, synthesize, options } = await fixture()
    const key = cacheKey(options.identity(request)!)
    const folder = join(directory, key.slice(0, 2))
    await import('node:fs/promises').then(fs => fs.mkdir(folder, { recursive: true }))
    await writeFile(join(folder, `${key}.audio`), wav())
    await writeFile(join(folder, `${key}.json`), '{bad json')
    await expect(bytes(await cache.synthesize(request, new AbortController().signal))).resolves.toEqual(wav())
    expect(synthesize).toHaveBeenCalledTimes(1)
  })

  it('stores versioned metadata and never treats temporary files as entries', async () => {
    const { directory, cache } = await fixture()
    await bytes(await cache.synthesize(request, new AbortController().signal))
    const prefix = (await readdir(directory))[0]
    const names = await readdir(join(directory, prefix))
    expect(names.some(name => name.includes('.tmp-'))).toBe(false)
    const metadataName = names.find(name => name.endsWith('.json'))!
    const metadata = JSON.parse(await readFile(join(directory, prefix, metadataName), 'utf8'))
    expect(metadata.keyVersion).toBe(TTS_CACHE_KEY_VERSION)
    expect(metadata.durationMs).toBe(200)
  })
})
