import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { latestSchemaVersion } from '@proj-airi/memory-sqlite'
import { describe, expect, it } from 'vitest'

import { SOAK_SCENARIOS } from './active-soak'

/**
 * Governance tests for the shared-memory program docs (IMP-001).
 *
 * These assert the two properties the backlog names as IMP-001's completion
 * evidence: every repository fact carries a reference that still resolves, and
 * every doc cross-link resolves. A stale evidence index is worse than none —
 * downstream agents treat its rows as "confirmed" without re-checking.
 *
 * The active-soak runbook and its promotion targets are governed here too,
 * because those are the documents a reviewer reads to decide whether A8 may
 * close; a runbook that drifts from the tool is what would let an unqualified
 * commit be promoted.
 */

// src/memory -> src -> discord-bot -> services -> airi -> repository root
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const MEMORY_DOCS = join(REPO_ROOT, 'docs', 'memory')

const STATUS_PAGE = join(MEMORY_DOCS, 'CURRENT.md')
const EVIDENCE_INDEX = join(MEMORY_DOCS, 'evidence', 'evidence-index.md')
const ACTIVE_SOAK_RUNBOOK = join(REPO_ROOT, 'airi', 'docs', 'memory', 'runbooks', 'active-memory-soak-and-rollout.md')

const DOCS = [
  join(MEMORY_DOCS, 'implementation-status.md'),
  STATUS_PAGE,
  EVIDENCE_INDEX,
  join(MEMORY_DOCS, 'adr', 'README.md'),
  join(MEMORY_DOCS, 'adr', '0000-template.md'),
  join(REPO_ROOT, 'docs', 'runbooks', 'memory-rollout.md'),
  ACTIVE_SOAK_RUNBOOK,
]

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

describe('shared-memory program docs', () => {
  it.each(DOCS)('%s exists', (path) => {
    expect(existsSync(path)).toBe(true)
  })

  it('records the frozen DC_BOT baseline commit in both the evidence index and the status page', () => {
    const sha = '0ea3cbf5ec92f719e2b48066c3ada45aa50122ad'
    expect(read(join(MEMORY_DOCS, 'evidence', 'evidence-index.md'))).toContain(sha)
    expect(read(join(MEMORY_DOCS, 'implementation-status.md'))).toContain(sha)
  })

  it('every confirmed repository fact points at a path that still exists', () => {
    const index = read(join(MEMORY_DOCS, 'evidence', 'evidence-index.md'))
    const factRows = index
      .split('\n')
      .filter(line => /^\| LEV-\d+ \|/.test(line))

    expect(factRows.length).toBeGreaterThan(0)

    const missing: string[] = []
    for (const row of factRows) {
      const reference = row.split('|')[3] ?? ''
      const paths = [...reference.matchAll(/`([^`]+)`/g)].map(match => match[1])
      // Every fact must cite at least one location; a bare assertion is not evidence.
      expect(paths.length, `no path cited in: ${row.trim()}`).toBeGreaterThan(0)
      for (const cited of paths) {
        // Strip a trailing `:12` or `:12-34` line reference before resolving.
        const filePath = cited.replace(/:\d+(?:-\d+)?$/, '')
        if (!existsSync(join(REPO_ROOT, filePath)))
          missing.push(filePath)
      }
    }
    expect(missing).toEqual([])
  })

  it('every relative markdown link in the program docs resolves', () => {
    const broken: string[] = []
    for (const doc of DOCS) {
      const links = [...read(doc).matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)].map(match => match[1])
      for (const link of links) {
        if (/^(?:https?:|mailto:)/.test(link))
          continue
        const target = normalize(resolve(dirname(doc), link))
        if (!existsSync(target))
          broken.push(`${doc} -> ${link}`)
      }
    }
    expect(broken).toEqual([])
  })

  it('the status page carries a disposition for every red-team finding', () => {
    const status = read(join(MEMORY_DOCS, 'implementation-status.md'))
    for (let n = 1; n <= 26; n++)
      expect(status, `FIND-${String(n).padStart(3, '0')} has no disposition`).toContain(`FIND-${String(n).padStart(3, '0')}`)
  })

  it('the ADR registry lists every canonical decision ADR-001..ADR-016', () => {
    const registry = read(join(MEMORY_DOCS, 'adr', 'README.md'))
    for (let n = 1; n <= 16; n++)
      expect(registry).toContain(`ADR-${String(n).padStart(3, '0')}`)
  })
})

describe('active-memory soak governance', () => {
  it('the runbook documents every scenario the tool requires', () => {
    const runbook = read(ACTIVE_SOAK_RUNBOOK)
    for (const scenario of SOAK_SCENARIOS)
      expect(runbook, `scenario ${scenario.id} is not in the runbook`).toContain(scenario.id)
  })

  it('the runbook names its promotion targets so a reviewer knows which documents A8 may change', () => {
    const runbook = read(ACTIVE_SOAK_RUNBOOK)
    for (const target of ['docs/memory/CURRENT.md', 'docs/memory/evidence/evidence-index.md'])
      expect(runbook).toContain(target)
  })

  it('the status page records the current schema version and keeps A8 open until a soak is reviewed', () => {
    const status = read(STATUS_PAGE)
    expect(status).toContain(`Latest SQLite schema: v${latestSchemaVersion}.`)
    expect(status).toContain('A8 remains open')
    // Promotion may only be recorded against a reviewed candidate SHA and a
    // redacted report, neither of which exists in this repository yet.
    expect(status).toContain('Active-ready is not claimed')
  })

  it('the evidence index states that no live soak has been executed', () => {
    expect(read(EVIDENCE_INDEX)).toContain('No live soak has been executed')
  })
})
