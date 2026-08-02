/* eslint-disable style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asPersonId, asTimestamp } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { AliasRepository } from './alias.js'

let db: DatabaseSync; let n: number
const id = () => `alias-test-${++n}`
const now = asTimestamp('2026-01-02T00:00:00Z')
function person(value: string) { db.prepare('INSERT INTO people(person_id,discord_user_id,created_at) VALUES (?,?,?)').run(value, value === 'p1' ? '11111111111111111' : '22222222222222222', now); return asPersonId(value) }
beforeEach(() => { n = 0; db = new SQLiteDatabase(':memory:'); migrate(db) })
afterEach(() => db.close())

describe('alias repository conformance (IMP-202)', () => {
  it('preserves duplicate-name ambiguity and stable ordering', () => {
    const repo = new AliasRepository(db, id); const p1 = person('p1'); const p2 = person('p2')
    for (const p of [p1, p2]) repo.create({ personId: p, scope: 'guild', scopeId: '33333333333333333', displayValue: 'Ａlex', status: 'active', authority: 'platform_observed', priority: 0, confidence: 90, validFrom: now })
    const result = repo.resolveExact({ scope: 'guild', scopeId: '33333333333333333', normalizedValue: 'alex', at: now })
    expect(result.outcome).toBe('ambiguous')
    if (result.outcome === 'ambiguous')
      expect(result.candidates.map(c => c.personId)).toEqual([p1, p2])
  })

  it('enforces exact platform, guild, room, private, and character predicates', () => {
    const repo = new AliasRepository(db, id); const p = person('p1')
    const scopes = [['platform', 'discord'], ['guild', 'guild-1'], ['logical_room', 'room-1'], ['private', 'dm-1'], ['character_global', 'char-1']] as const
    for (const [scope, scopeId] of scopes) repo.create({ personId: p, scope, scopeId, characterId: scope === 'character_global' ? scopeId : undefined, displayValue: 'Name', status: 'active', authority: 'self_explicit', priority: 100, confidence: 100, validFrom: now })
    for (const [scope, scopeId] of scopes) expect(repo.findActiveCandidates({ scope, scopeId, characterId: scope === 'character_global' ? scopeId : undefined, normalizedValue: 'name', at: now })).toHaveLength(1)
    expect(repo.findActiveCandidates({ scope: 'guild', scopeId: 'guild-1', normalizedValue: 'name', at: now })).toHaveLength(1)
    expect(repo.findActiveCandidates({ scope: 'guild', scopeId: 'dm-1', normalizedValue: 'name', at: now })).toHaveLength(0)
    expect(repo.findActiveCandidates({ scope: 'logical_room', scopeId: 'guild-1', normalizedValue: 'name', at: now })).toHaveLength(0)
    expect(repo.findActiveCandidates({ scope: 'character_global', scopeId: 'char-1', normalizedValue: 'name', at: now })).toHaveLength(0)
  })

  it('excludes every inactive or temporally invalid status', () => {
    const repo = new AliasRepository(db, id); const p = person('p1')
    for (const status of ['proposed', 'pending_confirmation', 'superseded', 'rejected', 'revoked', 'expired', 'quarantined'] as const) repo.create({ personId: p, scope: 'guild', scopeId: 'guild-1', displayValue: 'Nope', status, authority: 'operator_administrative', priority: 0, confidence: 80, validFrom: now })
    repo.create({ personId: p, scope: 'guild', scopeId: 'guild-1', displayValue: 'Future', status: 'active', authority: 'self_explicit', priority: 0, confidence: 100, validFrom: asTimestamp('2026-02-01T00:00:00Z') })
    expect(repo.findActiveCandidates({ scope: 'guild', scopeId: 'guild-1', normalizedValue: 'nope', at: now })).toEqual([])
    expect(repo.findActiveCandidates({ scope: 'guild', scopeId: 'guild-1', normalizedValue: 'future', at: now })).toEqual([])
  })

  it('rolls back alias, evidence, preference effect, and revision on constraint failure', () => {
    const repo = new AliasRepository(db, id); const p = person('p1')
    repo.create({ personId: p, scope: 'guild', scopeId: 'guild-1', displayValue: 'One', status: 'active', preferred: true, authority: 'self_explicit', priority: 100, confidence: 100, validFrom: now, evidence: { kind: 'explicit_command', authorizationContext: 'guild-1', dedupeKey: 'e1' } })
    expect(() => repo.create({ personId: p, scope: 'guild', scopeId: 'guild-1', displayValue: 'Two', status: 'active', preferred: true, authority: 'self_explicit', priority: 100, confidence: 100, validFrom: now, evidence: { kind: 'explicit_command', authorizationContext: 'guild-1', dedupeKey: 'e2' } })).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' }))
    expect((db.prepare('SELECT COUNT(*) count FROM aliases').get() as any).count).toBe(1)
    expect((db.prepare('SELECT COUNT(*) count FROM alias_evidence').get() as any).count).toBe(1)
    expect((db.prepare('SELECT alias_revision FROM people').get() as any).alias_revision).toBe(1)
  })
})
