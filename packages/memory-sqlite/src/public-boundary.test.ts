import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

describe('memory-sqlite public authority boundary', () => {
  it('does not export the unguarded write-capable opener', () => {
    const publicIndex = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
    expect(publicIndex).not.toMatch(/\bopenSqliteDatabase\b/)
    expect(publicIndex).toContain('export * from \'./writer-ownership.js\'')
    expect(publicIndex).toContain('openReadOnlySqliteDatabase')
  })

  it('keeps Discord runtime free of direct SQLite construction and internal openers', () => {
    const runtimeRoot = fileURLToPath(new URL('../../../src/', import.meta.url))
    const files: string[] = []
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry)
        if (statSync(path).isDirectory())
          visit(path)
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts'))
          files.push(path)
      }
    }
    visit(runtimeRoot)

    for (const path of files) {
      const source = readFileSync(path, 'utf8')
      expect(source, path).not.toMatch(/node:sqlite|\bDatabaseSync\b|\bopenSqliteDatabase\b/)
    }
  })
})
