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

/**
 * The commit the live private-guild soak qualified on 2026-08-05, run
 * `t002-86ca5cfc-20260805b`. Promotion documents must name this exact SHA: the
 * soak qualifies one commit and one configuration, never "active" in general.
 */
const QUALIFIED_COMMIT = '86ca5cfc674997820fe4d1f235d1d16f30ce1470'

/** Tracked runtime configuration; the soak qualifies a configuration, not just a commit. */
const SERVICE_CONFIG = join(REPO_ROOT, 'airi', 'services', 'discord-bot', '.config')

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

  it('the status page records the current schema version and the qualified commit', () => {
    const status = read(STATUS_PAGE)
    expect(status).toContain(`Latest SQLite schema: v${latestSchemaVersion}.`)
    // A8 closed on 2026-08-05. Promotion may only ever be recorded against the
    // exact SHA a live soak qualified, so the SHA itself is pinned here: a
    // later edit cannot quietly generalise the claim to "active is ready".
    expect(status).toContain(QUALIFIED_COMMIT)
  })

  it('the evidence index records the qualification against the same commit', () => {
    expect(read(EVIDENCE_INDEX)).toContain(QUALIFIED_COMMIT)
  })

  // The independent-review gate was deleted in 7a3fd5e rather than defaulted to
  // true, precisely so that no document could assert a review that never
  // happened. The guard is stated positively: a scan for forbidden phrases
  // cannot distinguish a document *claiming* independent review from one
  // *prohibiting* the claim, and both promotion documents do the latter.
  it('promotion documents qualify the result as operator-attested', () => {
    for (const doc of [STATUS_PAGE, EVIDENCE_INDEX])
      expect(read(doc).toLowerCase(), `${doc} does not say operator-qualified`).toContain('operator-qualified')
  })

  it('the runbook records that the attestation carries no independence declaration', () => {
    expect(read(ACTIVE_SOAK_RUNBOOK)).toContain('The attestation carries no independence declaration')
  })

  // The soak qualifies a configuration as well as a commit, so the shipped
  // input policy must not drift away from the promotion documents in silence.
  // Flipping BOT_INPUT_POLICY without saying so would leave the status page
  // implying the running voice behaviour was qualified when it was not.
  it('the status page records the input policy that .config actually ships', () => {
    const shipped = /^BOT_INPUT_POLICY=(\S+)$/m.exec(read(SERVICE_CONFIG))?.[1]
    expect(shipped, 'BOT_INPUT_POLICY is not set in .config').toBeTruthy()
    expect(
      read(STATUS_PAGE),
      `.config ships BOT_INPUT_POLICY=${shipped} but the status page does not mention it`,
    ).toContain(`BOT_INPUT_POLICY=${shipped}`)
  })

  it('the runbook does not require a scenario the tool would reject', () => {
    const ids = new Set(SOAK_SCENARIOS.map(scenario => scenario.id))
    // dm-isolation was removed from the matrix in 6694c5a: a user-installed app
    // never receives MESSAGE_CREATE for DMs, so verify no longer accepts the id
    // and a runbook still listing it would send an operator to produce evidence
    // that cannot be reported.
    expect(ids.has('dm-isolation' as never)).toBe(false)
    expect(read(ACTIVE_SOAK_RUNBOOK)).not.toMatch(/^\|\s*\d+\s*\|\s*`dm-isolation`/m)
  })
})
