/* eslint-disable style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asTimestamp, MemoryError } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { IdentityRepository } from './identity.js'

let db: DatabaseSync
let n: number
const id = (): string => `id-${++n}`
const at = (day: number, second = 0) => asTimestamp(`2026-01-${String(day).padStart(2, '0')}T00:00:${String(second).padStart(2, '0')}Z`)
const input = (overrides: Record<string, unknown> = {}) => ({ observationKey: 'event-1', snapshotId: 'snapshot-1', discordUserId: '18446744073709551615', observedAt: at(1), displayNameAtEvent: 'Alex', sourceEventType: 'gateway' as const, completeness: 'member_complete' as const, username: 'alex', globalName: 'Alex', guildId: '11111111111111111', guildNickname: 'Al', bot: false, ...overrides })
const count = (table: string) => (db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count

beforeEach(() => { n = 0; db = new SQLiteDatabase(':memory:'); migrate(db) })
afterEach(() => db.close())

describe('identity repository conformance (IMP-202)', () => {
  it('creates one snowflake identity and converges text, voice, and bot observations', () => {
    const repo = new IdentityRepository(db, id)
    const first = repo.observe(input())
    const voice = repo.observe(input({ observationKey: 'voice-2', snapshotId: 'snapshot-2', sourceEventType: 'voiceState', bot: true }))
    expect(voice.personId).toBe(first.personId)
    expect(voice.externalIdentityId).toBe(first.externalIdentityId)
    expect(count('people')).toBe(1); expect(count('external_identities')).toBe(1); expect(count('actor_snapshots')).toBe(2)
    expect((db.prepare('SELECT external_subject_key FROM external_identities').get() as any).external_subject_key).toBe('18446744073709551615')
    expect(() => repo.observe(input({ discordUserId: 'Alex' }))).toThrowError(MemoryError)
  })

  it('never merges equal presentation and preserves ambiguity', () => {
    const repo = new IdentityRepository(db, id)
    const a = repo.observe(input())
    const b = repo.observe(input({ discordUserId: '18446744073709551614', observationKey: 'event-2', snapshotId: 'snapshot-2' }))
    expect(a.personId).not.toBe(b.personId); expect(count('people')).toBe(2)
  })

  it('preserves rename history, guild isolation, missing fields, and explicit null', () => {
    const repo = new IdentityRepository(db, id); repo.observe(input())
    repo.observe(input({ observationKey: 'event-2', snapshotId: 'snapshot-2', observedAt: at(2), username: 'alex2', guildNickname: 'A2' }))
    repo.observe(input({ observationKey: 'event-3', snapshotId: 'snapshot-3', observedAt: at(3), guildId: '22222222222222222', guildNickname: 'Other', username: undefined, globalName: undefined }))
    repo.observe(input({ observationKey: 'event-4', snapshotId: 'snapshot-4', observedAt: at(4), guildId: '11111111111111111', globalName: null, username: undefined, guildNickname: undefined }))
    expect(db.prepare('SELECT username FROM actor_snapshots WHERE snapshot_id=?').get('snapshot-1')).toEqual({ username: 'alex' })
    expect((db.prepare('SELECT username,global_name FROM current_discord_profiles').get() as any)).toEqual({ username: 'alex2', global_name: null })
    expect(db.prepare('SELECT guild_id,guild_nickname FROM current_discord_guild_profiles ORDER BY guild_id').all()).toEqual([{ guild_id: '11111111111111111', guild_nickname: 'A2' }, { guild_id: '22222222222222222', guild_nickname: 'Other' }])
  })

  it('distinguishes retry from a separate equal snapshot and throttles freshness', () => {
    const repo = new IdentityRepository(db, id); const first = repo.observe(input())
    expect(repo.observe(input()).snapshotCreated).toBe(false)
    const second = repo.observe(input({ observationKey: 'event-2', snapshotId: 'snapshot-2', observedAt: at(1, 1) }))
    expect(second.profileChanged).toBe(false); expect(second.aliasChanged).toBe(false); expect(second.freshnessUpdated).toBe(false)
    const later = repo.observe(input({ observationKey: 'event-3', snapshotId: 'snapshot-3', observedAt: at(2) }))
    expect(later.freshnessUpdated).toBe(true); expect(later.profileChanged).toBe(false)
    expect((db.prepare('SELECT profile_revision FROM current_discord_profiles').get() as any).profile_revision).toBe(1)
    expect(first.personId).toBe(later.personId)
  })

  it('rolls back every identity row when snapshot persistence fails', () => {
    const repo = new IdentityRepository(db, id)
    db.exec('CREATE TRIGGER fail_snapshot BEFORE INSERT ON actor_snapshots BEGIN SELECT RAISE(ABORT,\'forced\'); END')
    expect(() => repo.observe(input())).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' }))
    expect(count('people')).toBe(0); expect(count('external_identities')).toBe(0)
    expect((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys).toBe(1)
  })

  it('bounds current writes for 10,000 unchanged observations while retaining snapshots', () => {
    const repo = new IdentityRepository(db, id)
    for (let i = 0; i < 10_000; i++) repo.observe(input({ observationKey: `event-${i}`, snapshotId: `snapshot-${i}`, observedAt: asTimestamp(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()) }))
    expect(count('actor_snapshots')).toBe(10_000)
    expect(count('current_discord_profiles')).toBe(1); expect(count('current_discord_guild_profiles')).toBe(1)
    expect(count('aliases')).toBe(3); expect(count('alias_evidence')).toBe(3)
    expect((db.prepare('SELECT profile_revision FROM current_discord_profiles').get() as any).profile_revision).toBe(1)
    expect((db.prepare('SELECT alias_revision FROM people').get() as any).alias_revision).toBe(1)
    expect((db.prepare('SELECT last_seen_at FROM external_identities').get() as any).last_seen_at).toBe('2026-01-01T00:00:00.000Z')
  }, 30_000)
})
