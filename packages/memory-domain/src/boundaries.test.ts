import { readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { globSync } from 'tinyglobby'
import { describe, expect, it } from 'vitest'

/**
 * Import-boundary enforcement (IMP-003; AC-002, AC-003).
 *
 * The dependency rule the backlog makes a merge gate: `memory-domain` imports
 * no Discord, database, transport, or model-provider package, and no adapter
 * defines a shadow copy of a contract this package owns. A red CI fixture is
 * required completion evidence, so this test is written to fail loudly with the
 * offending file rather than to be quietly satisfiable.
 */

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AIRI_ROOT = resolve(PACKAGE_ROOT, '../..')

/**
 * Import specifiers this package may never reach for.
 *
 * `node:` is included because a domain package that reads the filesystem or
 * opens a socket is no longer transport-neutral and cannot be reused by a
 * future remote runtime. The boundary test itself is exempt — it is not part of
 * the shipped surface.
 */
const FORBIDDEN_IMPORT_PATTERNS: readonly { pattern: RegExp, why: string }[] = Object.freeze([
  { pattern: /^discord\.js$|^@discordjs\//, why: 'Discord SDK types are an adapter concern (AC-003)' },
  { pattern: /^better-sqlite3$|^node:sqlite$|^drizzle-orm|^postgres$|^pg$/, why: 'database drivers are an adapter concern (AC-003)' },
  { pattern: /^@google\/genai$|^@xsai|^openai$/, why: 'model providers are an adapter concern (AC-003)' },
  { pattern: /^ofetch$|^axios$|^undici$|^ws$|^hono$/, why: 'transports are an adapter concern (ADR-001)' },
  { pattern: /^node:/, why: 'the domain package must run unchanged in any host' },
  { pattern: /^@proj-airi\//, why: 'the domain package sits at the bottom of the dependency graph' },
])

/** Files exempt from the `node:` rule because they never ship as contract surface. */
const TEST_FILE = /\.test\.ts$/

function sourceFiles(): readonly string[] {
  return globSync('src/**/*.ts', { cwd: PACKAGE_ROOT, absolute: true })
}

function importSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g))
    specifiers.push(match[1])
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g))
    specifiers.push(match[1])
  return specifiers
}

describe('memory-domain dependency direction (AC-003)', () => {
  it('finds source files to check', () => {
    expect(sourceFiles().length).toBeGreaterThan(10)
  })

  it('imports no Discord, database, provider, or transport package', () => {
    const violations: string[] = []
    for (const file of sourceFiles()) {
      if (TEST_FILE.test(file))
        continue
      const source = readFileSync(file, 'utf8')
      for (const specifier of importSpecifiers(source)) {
        const forbidden = FORBIDDEN_IMPORT_PATTERNS.find(rule => rule.pattern.test(specifier))
        if (forbidden)
          violations.push(`${relative(AIRI_ROOT, file)} imports "${specifier}" — ${forbidden.why}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('declares no runtime dependencies at all', () => {
    const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies ?? {}).toEqual({})
  })

  // The red fixture the backlog asks for: prove the rule can actually fail.
  it('would reject a forbidden import if one were introduced', () => {
    const smuggled = `import { Client } from 'discord.js'\nexport const x = 1\n`
    const found = importSpecifiers(smuggled)
      .filter(specifier => FORBIDDEN_IMPORT_PATTERNS.some(rule => rule.pattern.test(specifier)))
    expect(found).toEqual(['discord.js'])
  })

  it('would reject a dynamic forbidden import too', () => {
    const smuggled = `export async function load() { return import('better-sqlite3') }\n`
    const found = importSpecifiers(smuggled)
      .filter(specifier => FORBIDDEN_IMPORT_PATTERNS.some(rule => rule.pattern.test(specifier)))
    expect(found).toEqual(['better-sqlite3'])
  })
})

/**
 * Contract types the Discord service must import rather than redefine
 * (AC-002, RISK-003).
 *
 * Chosen because each one has a plausible local look-alike: the service already
 * has `ConversationTurn`, `ConversationRoomId`, and `InputEvent`, and the
 * migration is exactly the moment someone would write a second `ActorSnapshot`
 * "just for voice".
 */
const SINGLY_OWNED_CONTRACTS: readonly string[] = Object.freeze([
  'ActorSnapshot',
  'AttributedActor',
  'AnonymousActor',
  'InboundEventEnvelope',
  'CausalEdge',
  'DeliveryAttempt',
  'DeliveryState',
  'GenerationAttempt',
  'SnapshotEvidence',
  'AliasRecord',
  'RoomBinding',
  'AuthorizationContext',
  'MemoryPort',
])

describe('no shadow contracts in the Discord service (AC-002)', () => {
  const serviceFiles = globSync('services/discord-bot/src/**/*.ts', { cwd: AIRI_ROOT, absolute: true })

  it('finds the Discord service sources', () => {
    expect(serviceFiles.length).toBeGreaterThan(10)
  })

  it.each(SINGLY_OWNED_CONTRACTS)('does not redeclare %s', (contract) => {
    const declaration = new RegExp(`\\bexport\\s+(?:interface|type|class|enum)\\s+${contract}\\b`)
    const offenders = serviceFiles
      .filter(file => declaration.test(readFileSync(file, 'utf8')))
      .map(file => relative(AIRI_ROOT, file))
    expect(offenders).toEqual([])
  })
})
