import type {
  CharaCardV3Data,
  NormalizedDcBotExtension,
} from './card-schema'
import type {
  AsrCharacterProfile,
  AvatarProfile,
  CharacterLorebook,
  CharacterRuntime,
  OutputProtocolProfile,
  VoiceProfile,
} from './types'

import { readFileSync } from 'node:fs'
import { basename, join, normalize, relative, resolve as resolvePath, sep } from 'node:path'

import { useLogg } from '@guiiai/logg'

import { config } from '../config'
import {
  normalizeDcBotExtension,
  normalizeLorebook,
  readAiriExtension,
  readDcBotExtension,
  validateCard,
} from './card-schema'

/**
 * Character registry (Runtime V2, `02-public-contracts.md` §5.2).
 *
 * Loads a Character Card V3 from disk, validates it, normalizes optional
 * fields, resolves `extensions.airi` (verbatim) + `extensions.dc_bot` (with
 * safe defaults), resolves asset paths relative to the card directory, and
 * returns an immutable {@link CharacterRuntime}.
 *
 * Hard invariants (`01-architecture.md` invariant #3, `02 §5.2`):
 * - MUST NOT call Gemini, TTS, ASR, Discord, or memory.
 * - MUST NOT throw on a card that simply lacks `extensions.dc_bot` — derive
 *   defaults so the LIVE card (which still keeps the ACT protocol in
 *   `creator_notes`) loads during the migration window.
 * - Asset paths are resolved relative to the card directory and surfaced as
 *   normalized relative strings; the registry never leaks absolute user paths.
 */

/** The frozen {@link CharacterRegistry} interface. */
export interface CharacterRegistry {
  /** Load + validate + normalize a CCv3 card; returns an immutable runtime. */
  load: (characterId: string) => CharacterRuntime
}

/**
 * Options for {@link FileCharacterRegistry}.
 *
 * `resolvePath` lets tests inject a virtual mapping `characterId → { dir,
 * json }` so no real filesystem is touched. In production the registry reads
 * `card.json` from `characterRoots[id]` (or a derived default) via
 * `readFileSync`.
 */
export interface FileCharacterRegistryOptions {
  /**
   * Map of `characterId → absolute directory` holding `card.json`. When a
   * character id is absent here, the registry derives a default root from
   * `config().characterRoot` (Integration-Lead-provided) if present, else
   * errors at load time with a clear message.
   */
  characterRoots?: Record<string, string>
  /**
   * Optional injected resolver for tests: given a character id, return the
   * card directory and the raw card JSON string. When provided, no filesystem
   * read happens for that id.
   */
  resolvePath?: (characterId: string) => { dir: string, json: string }
}

export class FileCharacterRegistry implements CharacterRegistry {
  private readonly logger = useLogg('CharacterRegistry').useGlobalConfig()
  private readonly characterRoots: Record<string, string>
  private readonly resolveInjected: ((characterId: string) => { dir: string, json: string }) | undefined
  /** Loaded runtimes are cached: the card never changes at runtime. */
  private readonly cache = new Map<string, CharacterRuntime>()

  constructor(options: FileCharacterRegistryOptions = {}) {
    this.characterRoots = { ...options.characterRoots }
    this.resolveInjected = options.resolvePath
  }

  load(characterId: string): CharacterRuntime {
    const cached = this.cache.get(characterId)
    if (cached)
      return cached

    const { dir, json } = this.readCard(characterId)
    const runtime = buildCharacterRuntime(characterId, dir, json, this.logger)
    this.cache.set(characterId, runtime)
    return runtime
  }

  /** Resolve a character id to its card directory and raw JSON. */
  private readCard(characterId: string): { dir: string, json: string } {
    if (this.resolveInjected)
      return this.resolveInjected(characterId)

    const dir = this.characterRoots[characterId] ?? defaultCharacterRoot(characterId)
    const cardPath = join(dir, 'card.json')
    try {
      const json = readFileSync(cardPath, 'utf8')
      return { dir, json }
    }
    catch (err) {
      throw new CharacterLoadError(
        `Could not read card for character '${characterId}' at ${cardPath}: ${(err as Error).message}`,
      )
    }
  }
}

/**
 * Thrown when a character card cannot be loaded (missing file or invalid
 * CCv3). Surfaces a single clear message so the bootstrap fails loudly.
 */
export class CharacterLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CharacterLoadError'
  }
}

/**
 * Build an immutable {@link CharacterRuntime} from a validated card. Pure:
 * no provider/Discord/memory side effects. Asset paths are normalized to be
 * relative to `cardDir` and never absolute.
 *
 * Exported so tests can build a runtime from an in-memory card without going
 * through the filesystem.
 */
export function buildCharacterRuntime(
  characterId: string,
  cardDir: string,
  cardJson: string,
  logger?: { warn?: (msg: string) => void },
): CharacterRuntime {
  const result = validateCard(cardJson)
  if (!result.ok || !result.card) {
    throw new CharacterLoadError(
      `Character card '${characterId}' failed validation: ${result.errors.join('; ')}`,
    )
  }
  for (const w of result.warnings)
    logger?.warn?.(`Character card '${characterId}' warning: ${w}`)

  const card = result.card
  const data = card.data as CharaCardV3Data

  const dcBotRaw = readDcBotExtension(card)
  const dcBot = normalizeDcBotExtension(dcBotRaw)
  const airiRaw = readAiriExtension(card)

  const voice = resolveVoiceProfile(cardDir, dcBot, airiRaw)
  const asr: AsrCharacterProfile = { hotwords: resolveHotwords(dcBot) }
  const avatar = resolveAvatarProfile(dcBot, airiRaw)
  const outputProtocol: OutputProtocolProfile = {
    type: dcBot.outputProtocol.type,
    emotions: dcBot.outputProtocol.emotions,
    allowDelay: dcBot.outputProtocol.allowDelay,
  }
  const lorebook: CharacterLorebook | undefined = normalizeLorebook(data.character_book)

  return {
    id: characterId,
    name: asNonEmptyString(data.name, characterId),
    identity: {
      description: asString(data.description, ''),
      personality: asString(data.personality, ''),
      scenario: asString(data.scenario, ''),
      systemPrompt: asNonEmptyString(data.system_prompt, ''),
      postHistoryInstructions: asString(data.post_history_instructions, ''),
    },
    voice,
    asr,
    avatar,
    lorebook,
    outputProtocol,
  }
}

/**
 * Resolve a {@link VoiceProfile}. Prefers `extensions.dc_bot.voice`; when that
 * is absent, derives from the AIRI `speech` module (`gpt-sovits` + voice id)
 * so the LIVE card produces a usable profile without `extensions.dc_bot`.
 *
 * `referenceAudio` is normalized relative to the card directory; the AIRI
 * extension never carries a ref-audio path, so it is left empty when the
 * `dc_bot` block is absent (the TTS provider falls back to its env-configured
 * `GPT_SOVITS_REF_AUDIO`). `referenceText` is loaded from
 * `referenceTextFile` relative to the card dir when present.
 */
function resolveVoiceProfile(
  cardDir: string,
  dcBot: NormalizedDcBotExtension,
  airiExt: unknown,
): VoiceProfile {
  const voice = dcBot.voice
  const airiSpeech = extractAiriSpeech(airiExt)

  // Provider/voice fallback chain: explicit dc_bot value → AIRI speech module
  // → hard default. The LIVE card has no dc_bot, so the AIRI `speech` block
  // (provider `gpt-sovits`, voice_id `kurisu`) supplies the real values.
  const provider = voice.provider || airiSpeech.provider || 'gpt-sovits'
  const voiceId = voice.voiceId || airiSpeech.voiceId || 'default'

  const referenceAudio = voice.referenceAudio
    ? resolveRelativeAsset(cardDir, voice.referenceAudio)
    : ''
  const referenceTextFile = voice.referenceTextFile
    ? resolveRelativeAsset(cardDir, voice.referenceTextFile)
    : undefined

  const referenceText = referenceTextFile
    ? tryReadSiblingText(cardDir, referenceTextFile)
    : undefined

  return {
    provider,
    voiceId,
    referenceAudio,
    referenceTextFile,
    referenceText,
    promptLanguage: voice.promptLanguage || 'ja',
  }
}

/** Pull the AIRI `speech` module provider/voice if the extension has one. */
function extractAiriSpeech(airiExt: unknown): {
  provider?: string
  voiceId?: string
} {
  if (!isRecord(airiExt))
    return {}
  const modules = airiExt.modules
  if (!isRecord(modules))
    return {}
  const speech = modules.speech
  if (!isRecord(speech))
    return {}
  return {
    provider: typeof speech.provider === 'string' && speech.provider.trim() !== ''
      ? speech.provider.trim()
      : undefined,
    voiceId: typeof speech.voice_id === 'string' && speech.voice_id.trim() !== ''
      ? speech.voice_id.trim()
      : undefined,
  }
}

/** ASR hotwords come from `dc_bot.asr.hotwords` (already normalized). */
function resolveHotwords(dcBot: NormalizedDcBotExtension): string[] {
  return dcBot.asr.hotwords
}

/**
 * Resolve an {@link AvatarProfile}. `renderer` from `dc_bot.avatar` (default
 * `live2d`); `displayModelId` prefers `dc_bot.avatar.displayModelId`, then
 * falls back to the AIRI extension's `modules.displayModelId` (the LIVE card
 * keeps it there today).
 */
function resolveAvatarProfile(dcBot: NormalizedDcBotExtension, airiExt: unknown): AvatarProfile {
  const airiDisplayModelId = extractAiriDisplayModelId(airiExt)
  return {
    renderer: dcBot.avatar.renderer,
    displayModelId: dcBot.avatar.displayModelId ?? airiDisplayModelId,
  }
}

function extractAiriDisplayModelId(airiExt: unknown): string | undefined {
  if (!isRecord(airiExt))
    return undefined
  const modules = airiExt.modules
  if (!isRecord(modules))
    return undefined
  const id = modules.displayModelId
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : undefined
}

/**
 * Normalize a user-supplied asset path so it (a) is expressed relative to the
 * card directory and (b) can never escape it via `..` traversal. The returned
 * string uses POSIX separators so it is stable across Windows/POSIX hosts.
 *
 * Absolute paths and traversal that escapes the card dir are reduced to a
 * basename inside the card dir (we do not propagate absolute user paths per
 * `02 §7`).
 */
export function resolveRelativeAsset(cardDir: string, relPath: string): string {
  const cleaned = (relPath ?? '').trim()
  if (cleaned === '')
    return ''

  // Anchor the input under the card dir, then compute the path relative to it.
  const base = resolvePath(normalize(cardDir))
  const combined = resolvePath(base, normalize(cleaned))
  let rel = relative(base, combined)

  // If the resolved path escapes the card dir, or the input was absolute,
  // keep only the basename so nothing leaks above the card dir.
  const escaped = rel.startsWith('..') || isAbsolutePath(cleaned)
  if (escaped)
    rel = basename(cleaned)

  return toPosix(rel)
}

/** Best-effort read of a sibling text file (e.g. reference transcript). */
function tryReadSiblingText(cardDir: string, relPath: string): string | undefined {
  try {
    const abs = resolvePath(cardDir, relPath)
    const text = readFileSync(abs, 'utf8')
    const trimmed = text.trim()
    return trimmed === '' ? undefined : trimmed
  }
  catch {
    return undefined
  }
}

/**
 * Default character root, derived from `config().character?.root` when the
 * Integration Lead has wired it; otherwise throws a clear, actionable error.
 */
function defaultCharacterRoot(characterId: string): string {
  const root = readConfigCharacterRoot()
  if (typeof root === 'string' && root.trim() !== '')
    return resolvePath(root, characterId)

  throw new CharacterLoadError(
    `No character root registered for '${characterId}'. The Integration Lead must `
    + `add CHARACTER_PATH/CHARACTER_ID to config (D007), or pass characterRoots to the registry.`,
  )
}

/**
 * Read the optional `character.root` from `config()` without depending on the
 * field existing yet (config.ts is Integration-Lead-owned and has not added it).
 * The double cast through `unknown` is the documented compatibility seam — it
 * lets the registry adopt `config().character.root` once the Integration Lead
 * adds it without this module needing an edit.
 */
function readConfigCharacterRoot(): string | undefined {
  const cfg = config() as unknown as { character?: { root?: string } }
  const root = cfg.character?.root
  return typeof root === 'string' ? root : undefined
}

function asString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

function asNonEmptyString(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() !== '' ? v : fallback
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isAbsolutePath(p: string): boolean {
  if (p === '')
    return false
  if (/^[a-z]:[\\/]/i.test(p))
    return true
  if (p.startsWith('\\\\') || p.startsWith('//'))
    return true
  return p.startsWith('/')
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}
