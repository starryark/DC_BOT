import type { MemoryFeatureFlags } from './feature-flags'

import { MEMORY_FLAGS_ALL_OFF, memoryPosture } from './feature-flags'

export type MemoryMode = 'off' | 'shadow' | 'active' | 'degraded'

export interface MemoryProfile {
  mode: MemoryMode
  flags: MemoryFeatureFlags
}

const PROFILE_FLAGS: Readonly<Record<MemoryMode, Readonly<MemoryFeatureFlags>>> = {
  off: MEMORY_FLAGS_ALL_OFF,
  shadow: { ...MEMORY_FLAGS_ALL_OFF, durableEvents: true },
  active: {
    ...MEMORY_FLAGS_ALL_OFF,
    durableEvents: true,
    actorSnapshots: true,
    roomBindings: true,
    sharedRecentContext: true,
    deliveryLifecycle: true,
  },
  degraded: {
    ...MEMORY_FLAGS_ALL_OFF,
    durableEvents: true,
    degradedStatelessMode: true,
    durableWriteSpool: true,
  },
}

/** Expands the operator-facing mode and rejects contradictory low-level overrides. */
export function memoryProfile(rawMode: string | undefined, overrides: Partial<MemoryFeatureFlags>): MemoryProfile {
  const normalized = rawMode?.trim().toLowerCase() || 'off'
  if (normalized !== 'off' && normalized !== 'shadow' && normalized !== 'active' && normalized !== 'degraded')
    throw new Error(`Invalid MEMORY_MODE: ${JSON.stringify(rawMode)}`)

  const flags = { ...PROFILE_FLAGS[normalized] }
  const conflicts = (Object.keys(overrides) as (keyof MemoryFeatureFlags)[])
    .filter(flag => overrides[flag] !== flags[flag])
  if (conflicts.length > 0)
    throw new Error(`MEMORY_MODE=${normalized} conflicts with low-level flags: ${conflicts.join(', ')}`)

  const violations = memoryPosture(flags).violations
  if (violations.length > 0)
    throw new Error(`Invalid memory profile: ${violations.map(item => item.detail).join('; ')}`)
  return { mode: normalized, flags }
}
