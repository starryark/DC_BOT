import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { resolveMemoryRuntimePaths } from './runtime-paths'

describe('resolveMemoryRuntimePaths', () => {
  it('uses the repository-local layout by default', () => {
    const repo = resolve('fixture-repo')
    const paths = resolveMemoryRuntimePaths(repo, undefined)
    expect(paths.authority).toBe(join(repo, '.local', 'memory', 'authority', 'memory.sqlite'))
    expect(paths.roomBindings).toBe(join(repo, '.local', 'memory', 'room-bindings.json'))
  })

  it('accepts an explicit absolute external root', () => {
    const external = resolve('external-memory')
    expect(resolveMemoryRuntimePaths(resolve('repo'), external).root).toBe(external)
  })

  it('rejects relative, repository, and filesystem roots', () => {
    const repo = resolve('repo')
    expect(() => resolveMemoryRuntimePaths(repo, 'relative')).toThrow('absolute')
    expect(() => resolveMemoryRuntimePaths(repo, repo)).toThrow('dedicated')
    expect(() => resolveMemoryRuntimePaths(repo, `${resolve(repo).split(/[\\/]/)[0]}\\`)).toThrow('dedicated')
  })
})
