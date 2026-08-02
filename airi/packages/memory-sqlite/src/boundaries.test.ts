import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globSync } from 'tinyglobby'
import { describe, expect, it } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('memory-sqlite package boundary', () => {
  it('does not import Discord, providers, transports, or service runtime modules', () => {
    const forbidden = /(?:from\s+|import\s*\()['"](?:discord(?:\.js)?|@discordjs\/|.*provider|.*transport|.*services\/discord-bot)/
    const violations = globSync('src/**/*.ts', { cwd: packageRoot })
      .filter(file => !file.endsWith('.test.ts'))
      .filter(file => forbidden.test(readFileSync(resolve(packageRoot, file), 'utf8')))
      .map(file => relative(packageRoot, file))

    expect(violations).toEqual([])
  })
})
