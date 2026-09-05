import { describe, expect, it } from 'vitest'

import { memoryProfile } from './profile'

describe('memoryProfile', () => {
  it('defaults to an entirely inert off profile', () => {
    const profile = memoryProfile(undefined, {})
    expect(profile.mode).toBe('off')
    expect(Object.values(profile.flags).every(value => !value)).toBe(true)
  })

  it('expands shadow to durable writes without prompt reads', () => {
    const profile = memoryProfile('shadow', {})
    expect(profile.flags.durableEvents).toBe(true)
    expect(profile.flags.sharedRecentContext).toBe(false)
  })

  it('rejects invalid and conflicting configuration', () => {
    expect(() => memoryProfile('shdaow', {})).toThrow('Invalid MEMORY_MODE')
    expect(() => memoryProfile('shadow', { durableEvents: false })).toThrow('conflicts')
    expect(() => memoryProfile('off', { summaries: true })).toThrow('conflicts')
  })
})
