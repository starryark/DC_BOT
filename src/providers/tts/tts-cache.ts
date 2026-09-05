import type { Readable } from 'node:stream'

import type { GptSoVitsLang, TtsProvider, TtsRequest } from './types'

import process from 'node:process'

import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable as NodeReadable } from 'node:stream'

import { useLogg } from '@guiiai/logg'

export const TTS_CACHE_KEY_VERSION = 3

export interface TtsCacheMetadata {
  keyVersion: number
  createdAt: string
  lastAccessedAt?: string
  sizeBytes: number
  mediaType: string
  sampleRate?: number
  durationMs?: number
}

export interface TtsCacheIdentity {
  normalizedText: string
  textLanguage: GptSoVitsLang
  pronunciationProfileVersion?: string
  voiceModelVersion: string
  catalogVersion: string
  profileId: string
  referenceAudioFingerprint: string
  promptTextFingerprint: string
  promptLanguage: string
  topK: number
  topP: number
  temperature: number
  repetitionPenalty: number
  speedFactor: number
  fragmentInterval: number
  seed: number
  variationIndex: number
  mediaType: string
  streamingMode: number
  textSplitMethod: string
}

export interface TtsCacheOptions {
  enabled: boolean
  directory: string
  maxBytes: number
  maxItems: number
  ttlMs: number
  memoryItems: number
  minimumDurationMs?: number
  identity: (request: TtsRequest) => TtsCacheIdentity | null
  now?: () => number
}

interface CacheEntry { audio: Buffer, metadata: TtsCacheMetadata }

function stableJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function cacheKey(identity: TtsCacheIdentity): string {
  return fingerprint(stableJson({ keyVersion: TTS_CACHE_KEY_VERSION, ...identity }))
}

function inspectWav(audio: Buffer): { sampleRate?: number, durationMs?: number } {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE')
    return {}
  const sampleRate = audio.readUInt32LE(24)
  const byteRate = audio.readUInt32LE(28)
  const dataBytes = audio.readUInt32LE(40)
  if (!sampleRate || !byteRate || dataBytes > audio.length - 44)
    return {}
  return { sampleRate, durationMs: Math.round(dataBytes / byteRate * 1000) }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

/**
 * Cache states are deliberately narrow: memory entries are complete buffers,
 * disk entries become visible only after both atomic renames, and in-flight
 * entries are promises for validated complete audio. Temporary files are never
 * candidates for reads.
 */
export class CachedTtsProvider implements TtsProvider {
  private readonly memory = new Map<string, CacheEntry>()
  private readonly inFlight = new Map<string, Promise<CacheEntry>>()
  private readonly logger = useLogg('TtsCache').useGlobalConfig()

  constructor(private readonly provider: TtsProvider, private readonly options: TtsCacheOptions) {}

  /** Warm standard/localized prompts through the same validation and key path. */
  async prewarm(requests: TtsRequest[]): Promise<void> {
    await Promise.all(requests.map(async (request) => {
      try {
        await this.synthesize(request, new AbortController().signal)
      }
      catch (error) {
        // Prewarming is an optimization; startup/operation remains safe because
        // a later live request will retry the provider normally.
        this.logger.withError(error).warn('TTS cache prewarm failed')
      }
    }))
  }

  async synthesize(request: TtsRequest, signal: AbortSignal): Promise<Readable> {
    const identity = this.options.enabled ? this.options.identity(request) : null
    if (!identity)
      return this.provider.synthesize(request, signal)

    const key = cacheKey(identity)
    const memoryHit = this.memory.get(key)
    if (memoryHit) {
      this.touchMemory(key, memoryHit)
      this.logger.withFields({ cacheTier: 'memory', durationMs: memoryHit.metadata.durationMs }).log('tts_cache_hit')
      return NodeReadable.from(memoryHit.audio)
    }

    const diskHit = await this.readDisk(key).catch((error) => {
      this.logger.withError(error).warn('TTS disk cache read failed; synthesizing')
      return null
    })
    if (diskHit) {
      this.putMemory(key, diskHit)
      this.logger.withFields({ cacheTier: 'disk', durationMs: diskHit.metadata.durationMs }).log('tts_cache_hit')
      return NodeReadable.from(diskHit.audio)
    }

    this.logger.withFields({ cacheTier: 'provider' }).log('tts_cache_miss')
    let shared = this.inFlight.get(key)
    if (!shared) {
      const internalController = new AbortController()
      shared = this.synthesizeAndStore(key, request, internalController.signal)
      this.inFlight.set(key, shared)
      void shared.finally(() => this.inFlight.delete(key)).catch(() => {})
    }
    const entry = await this.waitForCaller(shared, signal)
    return NodeReadable.from(entry.audio)
  }

  private async synthesizeAndStore(key: string, request: TtsRequest, signal: AbortSignal): Promise<CacheEntry> {
    const audio = await streamToBuffer(await this.provider.synthesize(request, signal))
    const wav = inspectWav(audio)
    const minimumDurationMs = this.options.minimumDurationMs ?? 100
    const now = new Date((this.options.now ?? Date.now)()).toISOString()
    const entry: CacheEntry = {
      audio,
      metadata: { keyVersion: TTS_CACHE_KEY_VERSION, createdAt: now, lastAccessedAt: now, sizeBytes: audio.length, mediaType: 'audio/wav', ...wav },
    }
    // Invalid/short output remains the provider's responsibility to play or
    // reject. The cache only declines ownership; it must never turn an
    // otherwise successful provider response into a cache-induced failure.
    if (!audio.length || wav.durationMs == null || wav.durationMs < minimumDurationMs)
      return entry
    this.putMemory(key, entry)
    await this.writeDisk(key, entry).then(() => this.evictDisk()).catch(error => this.logger.withError(error).warn('TTS disk cache write failed; using synthesized audio'))
    return entry
  }

  private waitForCaller<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted)
      return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
      signal.addEventListener('abort', abort, { once: true })
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
    })
  }

  private paths(key: string) {
    const root = join(this.options.directory, key.slice(0, 2))
    return { root, audio: join(root, `${key}.audio`), metadata: join(root, `${key}.json`) }
  }

  private async readDisk(key: string): Promise<CacheEntry | null> {
    const paths = this.paths(key)
    let metadata: TtsCacheMetadata
    let audio: Buffer
    try {
      [metadata, audio] = await Promise.all([
        readFile(paths.metadata, 'utf8').then(raw => JSON.parse(raw) as TtsCacheMetadata),
        readFile(paths.audio),
      ])
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return null
      throw error
    }
    const age = (this.options.now ?? Date.now)() - Date.parse(metadata.createdAt)
    const wav = inspectWav(audio)
    if (metadata.keyVersion !== TTS_CACHE_KEY_VERSION || metadata.sizeBytes !== audio.length || !Number.isFinite(age) || age > this.options.ttlMs || wav.durationMs == null) {
      await Promise.allSettled([rm(paths.audio, { force: true }), rm(paths.metadata, { force: true })])
      return null
    }
    metadata.lastAccessedAt = new Date((this.options.now ?? Date.now)()).toISOString()
    return { audio, metadata }
  }

  private async writeDisk(key: string, entry: CacheEntry): Promise<void> {
    const paths = this.paths(key)
    await mkdir(paths.root, { recursive: true })
    const suffix = `.tmp-${process.pid}-${randomUUID()}`
    const audioTemp = `${paths.audio}${suffix}`
    const metadataTemp = `${paths.metadata}${suffix}`
    try {
      await this.writeAndSync(audioTemp, entry.audio)
      await this.writeAndSync(metadataTemp, Buffer.from(JSON.stringify(entry.metadata)))
      await rename(audioTemp, paths.audio)
      await rename(metadataTemp, paths.metadata)
    }
    finally {
      await Promise.allSettled([rm(audioTemp, { force: true }), rm(metadataTemp, { force: true })])
    }
  }

  private async writeAndSync(path: string, bytes: Buffer): Promise<void> {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(bytes)
      await handle.sync()
    }
    finally {
      await handle.close()
    }
  }

  private putMemory(key: string, entry: CacheEntry): void {
    this.memory.delete(key)
    this.memory.set(key, entry)
    while (this.memory.size > this.options.memoryItems)
      this.memory.delete(this.memory.keys().next().value!)
  }

  private touchMemory(key: string, entry: CacheEntry): void {
    entry.metadata.lastAccessedAt = new Date((this.options.now ?? Date.now)()).toISOString()
    this.putMemory(key, entry)
  }

  private async evictDisk(): Promise<void> {
    const entries: Array<{ audio: string, metadata: string, size: number, accessed: number }> = []
    let prefixes: string[] = []
    try {
      prefixes = await readdir(this.options.directory)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return
      throw error
    }
    for (const prefix of prefixes) {
      const folder = join(this.options.directory, prefix)
      if (!(await stat(folder)).isDirectory())
        continue
      for (const name of await readdir(folder)) {
        if (!name.endsWith('.json'))
          continue
        const metadataPath = join(folder, name)
        try {
          const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as TtsCacheMetadata
          entries.push({ audio: join(folder, name.replace(/\.json$/, '.audio')), metadata: metadataPath, size: metadata.sizeBytes, accessed: Date.parse(metadata.lastAccessedAt ?? metadata.createdAt) })
        }
        catch { /* A corrupt metadata file is ignored by reads and never blocks synthesis. */ }
      }
    }
    entries.sort((a, b) => a.accessed - b.accessed)
    let bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    while (entries.length > this.options.maxItems || bytes > this.options.maxBytes) {
      const victim = entries.shift()!
      bytes -= victim.size
      await Promise.allSettled([rm(victim.audio, { force: true }), rm(victim.metadata, { force: true })])
    }
  }
}
