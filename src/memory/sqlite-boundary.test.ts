import { globSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * One composition module owns the SQLite implementation, and the rest of the
 * runtime reaches persistence only through the authority surfaces it publishes.
 *
 * The rule that matters is about *runtime* dependency: a second module that
 * imports values from `@proj-airi/memory-sqlite` can open a connection, run a
 * statement, or bypass the sole-writer guard. An erased `import type` can do
 * none of those — it disappears at compile time — and forbidding it outright
 * would push modules into redeclaring the package's public contracts locally,
 * which is worse. Both sets are pinned, so neither can grow unnoticed.
 */
describe('sQLite runtime boundary', () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const referencing = globSync('**/*.ts', { cwd: sourceRoot })
    .map(path => resolve(sourceRoot, path))
    .filter(path => !path.endsWith('.test.ts'))
    .map(path => ({ path: relative(sourceRoot, path).replaceAll('\\', '/'), source: readFileSync(path, 'utf8') }))
    .filter(file => file.source.includes('@proj-airi/memory-sqlite'))

  // Any line naming the package that is not a bare `import type` counts as a
  // value use. That deliberately includes the inline `import { type X }` form,
  // so the check cannot be sidestepped by moving the keyword inside the braces.
  const valueImporters = referencing
    .filter(file => file.source.split('\n').some(line => line.includes('@proj-airi/memory-sqlite') && !/^\s*import\s+type\s/.test(line)))
    .map(file => file.path)

  it('allows memory-sqlite values only in the approved composition module', () => {
    expect(valueImporters).toEqual(['memory/runtime.ts'])
  })

  it('allows an erased type reference only where a published contract is being reported', () => {
    expect(referencing.map(file => file.path).filter(path => !valueImporters.includes(path))).toEqual(['memory/privacy-completeness.ts'])
  })
})
