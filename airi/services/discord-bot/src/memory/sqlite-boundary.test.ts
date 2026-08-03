import { globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('sQLite runtime boundary', () => {
  it('allows memory-sqlite only in the approved composition module', () => {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const offenders = globSync('**/*.ts', { cwd: sourceRoot })
      .map(path => resolve(sourceRoot, path))
      .filter(path => !path.endsWith('.test.ts'))
      .filter(path => readFileSync(path, 'utf8').includes('@proj-airi/memory-sqlite'))
      .map(path => relative(sourceRoot, path).replaceAll('\\', '/'))
    expect(offenders).toEqual(['memory/runtime.ts'])
  })
})
