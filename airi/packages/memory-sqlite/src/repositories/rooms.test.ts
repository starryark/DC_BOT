/* eslint-disable style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asBindingId, asCharacterId, asLogicalRoomId, asTimestamp, MemoryError } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { BindingRepository } from './bindings.js'
import { PolicyDataRepository } from './policy-data.js'
import { RoomRepository } from './rooms.js'

let db: DatabaseSync
const at = (day: number) => asTimestamp(`2026-01-${String(day).padStart(2, '0')}T00:00:00Z`)
const character = asCharacterId('character-a')
const guild = (channelId: string, channelKind: 'guildText' | 'guildVoice' | 'thread' = 'guildText', guildId = '99999999999999999') => ({ platform: 'discord' as const, guildId, channelId, channelKind })
const dm = (channelId: string) => ({ platform: 'discord' as const, channelId, channelKind: 'dm' as const })

beforeEach(() => { db = new SQLiteDatabase(':memory:'); migrate(db); db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (\'person-a\',\'18446744073709551615\',?,\'account_subject\',?)').run(at(1), at(1)) })
afterEach(() => db.close())

describe('imp-203 real SQLite scope matrix', () => {
  it('preserves exact snowflakes, locator domains, kinds, rename identity, and observation idempotency', () => {
    const rooms = new RoomRepository(db); const huge = guild('18446744073709551615')
    const first = rooms.observe({ location: huge, observedAt: at(1), displayName: 'general' })
    expect(rooms.observe({ location: huge, observedAt: at(2), displayName: 'renamed' }).physicalRoomId).toBe(first.physicalRoomId)
    expect(rooms.get(first.physicalRoomId)?.location.channelId).toBe('18446744073709551615')
    expect(rooms.observe({ location: guild('18446744073709551614'), observedAt: at(1), displayName: 'general' }).physicalRoomId).not.toBe(first.physicalRoomId)
    expect(rooms.observe({ location: dm('18446744073709551615'), participantPersonId: 'person-a', observedAt: at(1) }).physicalRoomId).not.toBe(first.physicalRoomId)
    const thread = rooms.observe({ location: guild('3', 'thread'), parentChannelId: huge.channelId, observedAt: at(1) })
    const voice = rooms.observe({ location: guild('4', 'guildVoice'), observedAt: at(1) })
    expect(thread.physicalRoomId).not.toBe(first.physicalRoomId); expect(voice.physicalRoomId).not.toBe(first.physicalRoomId)
    expect((db.prepare('SELECT COUNT(*) count FROM physical_room_records').get() as any).count).toBe(5)
  })

  it('isolates unbound rooms and character contexts deterministically without parent or name fallback', () => {
    const rooms = new RoomRepository(db); const a = guild('1'); const b = guild('2')
    rooms.observe({ location: a, displayName: 'same', observedAt: at(1) }); rooms.observe({ location: b, displayName: 'same', observedAt: at(1) })
    const aa = rooms.resolve(a, character, at(1)); const aa2 = rooms.resolve(a, character, at(2)); const ab = rooms.resolve(a, asCharacterId('character-b'), at(1)); const ba = rooms.resolve(b, character, at(1))
    expect(aa).toEqual(aa2); expect(aa.logicalRoomId).not.toBe(ab.logicalRoomId); expect(aa.logicalRoomId).not.toBe(ba.logicalRoomId)
    expect(aa.roomKind).toBe('isolated')
  })

  it('creates idempotent active bindings, retains history, increments evidence, rejects stale updates, and restores fallback', () => {
    const rooms = new RoomRepository(db); const bindings = new BindingRepository(db); const location = guild('1'); const physical = rooms.observe({ location, observedAt: at(1) }).physicalRoomId; const logical = asLogicalRoomId('logical-a')
    bindings.ensureLogicalRoom({ logicalRoomId: logical, characterId: character, privacyDomain: 'guild', guildId: location.guildId, createdAt: at(1) })
    const input = { bindingId: asBindingId('binding-a'), physicalRoomId: physical, logicalRoomId: logical, characterId: character, idempotencyKey: 'request-a', bindingKind: 'explicit' as const, policy: { crossChannelHistory: true, direction: 'bidirectional' as const }, validFrom: at(1), authorizedBy: 'operator-a' }
    expect(bindings.create(input).version).toBe(1); expect(bindings.create({ ...input, bindingId: asBindingId('binding-other') }).bindingId).toBe(input.bindingId)
    expect(rooms.resolve(location, character, at(1)).logicalRoomId).toBe(logical)
    const updated = bindings.update(input.bindingId, 1, { policy: { crossChannelHistory: true, direction: 'physicalToLogical' }, validFrom: at(2), authorizedBy: 'operator-b' })
    expect(updated.authorizationRevision).toBe(2); expect(bindings.history(input.bindingId).map(v => v.status)).toEqual(['superseded', 'active'])
    expect(() => bindings.update(input.bindingId, 1, { policy: input.policy, validFrom: at(3), authorizedBy: 'operator' })).toThrowError(MemoryError)
    expect(bindings.history(input.bindingId)).toHaveLength(2)
    const retired = bindings.retire(input.bindingId, 2, at(3), 'operator-c'); expect(retired.authorizationRevision).toBe(3)
    expect(rooms.resolve(location, character, at(3)).roomKind).toBe('isolated'); expect(bindings.history(input.bindingId)).toHaveLength(3)
  })

  it('applies temporal and lifecycle predicates and invalidates authorization evidence', () => {
    const rooms = new RoomRepository(db); const bindings = new BindingRepository(db); const policies = new PolicyDataRepository(db); const location = guild('1'); const physical = rooms.observe({ location, observedAt: at(1) }).physicalRoomId; const logical = asLogicalRoomId('logical-a')
    bindings.ensureLogicalRoom({ logicalRoomId: logical, characterId: character, privacyDomain: 'guild', guildId: location.guildId, createdAt: at(1) })
    const binding = bindings.create({ bindingId: asBindingId('binding-a'), physicalRoomId: physical, logicalRoomId: logical, characterId: character, idempotencyKey: 'key', bindingKind: 'explicit', policy: { crossChannelHistory: true, direction: 'bidirectional' }, validFrom: at(2), validUntil: at(4), authorizedBy: 'operator' })
    expect(rooms.resolve(location, character, at(1)).roomKind).toBe('isolated'); expect(rooms.resolve(location, character, at(2)).roomKind).toBe('bound'); expect(rooms.resolve(location, character, at(4)).roomKind).toBe('isolated')
    expect(policies.findExact({ physicalRoomId: physical, logicalRoomId: logical, characterId: character, at: at(2) })?.authorizationRevision).toBe(binding.authorizationRevision)
    rooms.observe({ location, observedAt: at(3), lifecycle: 'deleted' })
    expect(policies.findExact({ physicalRoomId: physical, logicalRoomId: logical, characterId: character, at: at(3) })).toBeUndefined()
    expect(bindings.history(binding.bindingId).at(-1)?.authorizationRevision).toBe(2)
    expect(() => rooms.resolve(location, character, at(3))).toThrowError(MemoryError)
  })

  it('rejects DM/guild, cross-guild, character, and inaccessible-room bindings without partial writes', () => {
    const rooms = new RoomRepository(db); const bindings = new BindingRepository(db); const guildRoom = rooms.observe({ location: guild('1'), observedAt: at(1) }); const privateRoom = rooms.observe({ location: dm('1'), participantPersonId: 'person-a', observedAt: at(1) })
    const guildLogical = asLogicalRoomId('guild-logical'); const dmLogical = asLogicalRoomId('dm-logical'); const otherGuild = asLogicalRoomId('other-guild')
    bindings.ensureLogicalRoom({ logicalRoomId: guildLogical, characterId: character, privacyDomain: 'guild', guildId: '99999999999999999', createdAt: at(1) }); bindings.ensureLogicalRoom({ logicalRoomId: dmLogical, characterId: character, privacyDomain: 'dm', createdAt: at(1) }); bindings.ensureLogicalRoom({ logicalRoomId: otherGuild, characterId: character, privacyDomain: 'guild', guildId: '88888888888888888', createdAt: at(1) })
    const create = (physicalRoomId: any, logicalRoomId: any, key: string) => bindings.create({ bindingId: asBindingId(`binding-${key}`), physicalRoomId, logicalRoomId, characterId: character, idempotencyKey: key, bindingKind: 'explicit', policy: { crossChannelHistory: true, direction: 'bidirectional' }, validFrom: at(1), authorizedBy: 'operator' })
    expect(() => create(privateRoom.physicalRoomId, guildLogical, 'dm-guild')).toThrowError(MemoryError); expect(() => create(guildRoom.physicalRoomId, dmLogical, 'guild-dm')).toThrowError(MemoryError); expect(() => create(guildRoom.physicalRoomId, otherGuild, 'cross-guild')).toThrowError(MemoryError)
    rooms.observe({ location: guild('1'), lifecycle: 'inaccessible', observedAt: at(2) }); expect(() => create(guildRoom.physicalRoomId, guildLogical, 'inaccessible')).toThrowError(MemoryError)
    expect((db.prepare('SELECT COUNT(*) count FROM room_binding_records').get() as any).count).toBe(0); expect((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys).toBe(1)
  })

  it('enforces active-membership uniqueness and rolls back forced create/update/remove failures', () => {
    const rooms = new RoomRepository(db); const bindings = new BindingRepository(db); const location = guild('1'); const physical = rooms.observe({ location, observedAt: at(1) }).physicalRoomId; const logical = asLogicalRoomId('logical-a')
    bindings.ensureLogicalRoom({ logicalRoomId: logical, characterId: character, privacyDomain: 'guild', guildId: location.guildId, createdAt: at(1) })
    const base = { physicalRoomId: physical, logicalRoomId: logical, characterId: character, bindingKind: 'explicit' as const, policy: { crossChannelHistory: true, direction: 'bidirectional' as const }, validFrom: at(1), authorizedBy: 'operator' }
    db.exec('CREATE TRIGGER fail_create BEFORE INSERT ON room_binding_versions BEGIN SELECT RAISE(ABORT,\'forced\'); END')
    expect(() => bindings.create({ ...base, bindingId: asBindingId('binding-fail'), idempotencyKey: 'fail' })).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(db.prepare('SELECT * FROM room_binding_records').all()).toEqual([]); db.exec('DROP TRIGGER fail_create')
    const current = bindings.create({ ...base, bindingId: asBindingId('binding-a'), idempotencyKey: 'ok' })
    expect(() => bindings.create({ ...base, bindingId: asBindingId('binding-b'), idempotencyKey: 'other' })).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' }))
    db.exec('CREATE TRIGGER fail_update BEFORE INSERT ON room_binding_versions WHEN NEW.version>1 BEGIN SELECT RAISE(ABORT,\'forced\'); END')
    expect(() => bindings.update(current.bindingId, 1, { policy: base.policy, validFrom: at(2), authorizedBy: 'operator' })).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(bindings.current(current.bindingId)?.version).toBe(1)
    expect(() => bindings.retire(current.bindingId, 1, at(2), 'operator')).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(bindings.current(current.bindingId)?.version).toBe(1)
  })
})
