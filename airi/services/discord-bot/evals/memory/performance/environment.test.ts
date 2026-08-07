import { describe, expect, it } from 'vitest'

import { collectEnvironmentFingerprint } from './environment'

describe('environment metadata collector', () => {
  it('collects real environment data without synthetic placeholders', () => {
    const env = collectEnvironmentFingerprint('10.33.0')
    expect(env.nodeVersion).toMatch(/^v\d+\./)
    expect(env.pnpmVersion).toBe('10.33.0')
    expect(env.platform).toBe(process.platform)
    expect(env.architecture).toBe(process.arch)
    expect(env.cpuModel).not.toBe('synthetic')
    expect(env.cpuCount).toBeGreaterThan(0)
    expect(env.totalMemoryBytes).toBeGreaterThan(0)
    expect(env.sqliteVersion).not.toBe('unknown')
  })
})
