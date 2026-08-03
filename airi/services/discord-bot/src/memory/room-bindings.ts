import type { CharacterId, PhysicalLocation } from '@proj-airi/memory-domain'

import { readFileSync } from 'node:fs'

import { asCharacterId, MemoryError, physicalRoomIdOf } from '@proj-airi/memory-domain'

import * as v from 'valibot'

const snowflake = v.pipe(v.string(), v.regex(/^\d{17,20}$/, 'Discord snowflakes must contain 17 through 20 digits'))

const locationSchema = v.variant('kind', [
  v.object({ kind: v.literal('guildText'), guildId: snowflake, channelId: snowflake }),
  v.object({ kind: v.literal('thread'), guildId: snowflake, channelId: snowflake }),
  v.object({ kind: v.literal('guildVoice'), guildId: snowflake, channelId: snowflake }),
  v.object({ kind: v.literal('dm'), channelId: snowflake }),
])

const fileSchema = v.strictObject({
  version: v.literal(1),
  bindings: v.array(v.strictObject({
    id: v.pipe(v.string(), v.regex(/^[\w.-]{1,64}$/)),
    characterId: v.pipe(v.string(), v.regex(/^[\w:.-]{1,128}$/)),
    locations: v.pipe(v.array(locationSchema), v.minLength(2)),
  })),
})

export interface ConfiguredRoomBinding {
  readonly id: string
  readonly characterId: CharacterId
  readonly locations: readonly PhysicalLocation[]
}

/** Parses the complete binding file atomically; any invalid or overlapping entry rejects the file. */
export function parseRoomBindingFile(input: unknown): readonly ConfiguredRoomBinding[] {
  let parsed: v.InferOutput<typeof fileSchema>
  try {
    parsed = v.parse(fileSchema, input)
  }
  catch (cause) {
    throw new MemoryError('INVALID_PAYLOAD', 'room binding file is invalid or uses an unsupported schema version', { cause })
  }

  const occupied = new Map<string, string>()
  return parsed.bindings.map((binding) => {
    const locations = binding.locations.map(location => ({
      platform: 'discord' as const,
      channelKind: location.kind,
      channelId: location.channelId,
      ...('guildId' in location ? { guildId: location.guildId } : {}),
    }))
    const guilds = new Set(locations.map(location => location.guildId ?? 'dm'))
    if (guilds.size !== 1)
      throw new MemoryError('DM_ISOLATION_VIOLATION', `binding ${binding.id} crosses a guild or DM boundary`)

    for (const location of locations) {
      const key = `${binding.characterId}:${physicalRoomIdOf(location)}`
      const existing = occupied.get(key)
      if (existing)
        throw new MemoryError('DUPLICATE_BINDING', `location overlaps bindings ${existing} and ${binding.id}`)
      occupied.set(key, binding.id)
    }
    return Object.freeze({ id: binding.id, characterId: asCharacterId(binding.characterId), locations: Object.freeze(locations) })
  })
}

/** Reads a local JSON binding file without accepting partial configuration. */
export function loadRoomBindingFile(path: string): readonly ConfiguredRoomBinding[] {
  try {
    return parseRoomBindingFile(JSON.parse(readFileSync(path, 'utf8')))
  }
  catch (cause) {
    if (cause instanceof MemoryError)
      throw cause
    throw new MemoryError('INVALID_PAYLOAD', 'room binding file could not be read as JSON', { cause })
  }
}
