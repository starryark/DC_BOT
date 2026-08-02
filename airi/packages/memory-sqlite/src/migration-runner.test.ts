/* eslint-disable style/max-statements-per-line, style/quotes, test/prefer-lowercase-title */
import type { DatabaseSync } from 'node:sqlite'

import type { Migration } from './migrations/index.js'

import { createHash } from 'node:crypto'
import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { MemoryError } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it } from 'vitest'

import { migrate } from './migration-runner.js'
import { latestSchemaVersion, migrations } from './migrations/index.js'

const databases: DatabaseSync[] = []

function database(): DatabaseSync {
  const value = new SQLiteDatabase(':memory:')
  databases.push(value)
  return value
}

function migration(version: number, name: string, sql: string): Migration {
  return {
    version,
    name,
    sql,
    checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
  }
}

function tables(db: DatabaseSync): string[] {
  return (db.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name').all() as Array<{ name: string }>).map(row => row.name)
}

afterEach(() => {
  for (const db of databases.splice(0))
    db.close()
})

describe('imp-201 forward-only migration runner', () => {
  it('migrates an empty SQLite database to the latest schema and records the checksum once', () => {
    const db = database()

    expect(migrate(db)).toEqual([1, 2, 3, 4])
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(db.prepare('SELECT version, name, checksum FROM memory_schema_migrations').all()).toEqual([
      { version: 1, name: 'initial_shared_memory_schema', checksum: migrations[0]?.checksum },
      { version: 2, name: 'identity_alias_repositories', checksum: migrations[1]?.checksum },
      { version: 3, name: 'room_binding_authorization_repositories', checksum: migrations[2]?.checksum },
      { version: 4, name: 'event_causality_repositories', checksum: migrations[3]?.checksum },
    ])
    expect(latestSchemaVersion).toBe(4)
  })

  it('is a no-op when every known migration is already applied', () => {
    const db = database()
    migrate(db)

    expect(migrate(db)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_schema_migrations').get()).toEqual({ count: 4 })
  })

  it('IMP-204 upgrades v3 while preserving identity, alias, room, binding, and authorization data', () => {
    const db = database(); migrate(db, migrations.slice(0, 3))
    db.prepare("INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES ('person','18446744073709551615','2026-01-01T00:00:00Z','account_subject','2026-01-01T00:00:00Z')").run()
    db.prepare("INSERT INTO physical_room_records(physical_room_id,locator_key,platform,channel_id,channel_kind,guild_id,lifecycle,observed_at) VALUES ('physical','discord:guild:1:2','discord','2','guild_text','1','active','2026-01-01T00:00:00Z')").run()
    db.prepare("INSERT INTO logical_rooms(logical_room_id,isolation_scope_type,isolation_scope_id,room_kind,created_at) VALUES ('logical','unbound_channel','logical','unbound_channel','2026-01-01T00:00:00Z')").run()
    db.prepare("INSERT INTO logical_room_repository_records(logical_room_id,character_id,privacy_domain,guild_id,singleton_physical_room_id) VALUES ('logical','character','guild','1','physical')").run()
    db.prepare("INSERT INTO aliases(alias_id,person_id,scope_type,scope_id,value,precedence,visibility,valid_from,source) VALUES ('alias','person','platform','discord','Alice',0,'public','2026-01-01T00:00:00Z','test')").run()
    db.prepare("INSERT INTO room_binding_records(binding_id,physical_room_id,logical_room_id,character_id,idempotency_key,created_at,active_version) VALUES ('binding','physical','logical','character','binding-key','2026-01-01T00:00:00Z',1)").run()
    db.prepare("INSERT INTO room_binding_versions(binding_id,version,status,binding_kind,cross_channel_history,direction,valid_from,authorized_by,authorization_revision,created_at) VALUES ('binding',1,'active','explicit',1,'bidirectional','2026-01-01T00:00:00Z','operator',7,'2026-01-01T00:00:00Z')").run()
    expect(migrate(db)).toEqual([4])
    expect(db.prepare('SELECT person_id FROM people').get()).toEqual({ person_id: 'person' }); expect(db.prepare('SELECT alias_id FROM aliases').get()).toEqual({ alias_id: 'alias' }); expect(db.prepare('SELECT physical_room_id FROM physical_room_records').get()).toEqual({ physical_room_id: 'physical' }); expect(db.prepare('SELECT binding_id,authorization_revision FROM room_binding_versions').get()).toEqual({ binding_id: 'binding', authorization_revision: 7 })
  })

  it('upgrades v2 in place without changing identity or alias records', () => {
    const db = database()
    migrate(db, migrations.slice(0, 2))
    db.prepare('INSERT INTO people(person_id,discord_user_id,created_at) VALUES (\'person\',\'18446744073709551615\',\'2026-01-01T00:00:00Z\')').run()
    db.prepare('INSERT INTO aliases(alias_id,person_id,scope_type,scope_id,value,precedence,visibility,valid_from,source) VALUES (\'alias\',\'person\',\'platform\',\'discord\',\'Alex\',0,\'public\',\'2026-01-01T00:00:00Z\',\'test\')').run()

    expect(migrate(db)).toEqual([3, 4])
    expect(db.prepare('SELECT person_id,discord_user_id FROM people').get()).toEqual({ person_id: 'person', discord_user_id: '18446744073709551615' })
    expect(db.prepare('SELECT alias_id,value FROM aliases').get()).toEqual({ alias_id: 'alias', value: 'Alex' })
  })

  it('applies supplied migrations in deterministic numeric order', () => {
    const db = database()
    const supplied = [
      migration(2, 'second', 'CREATE TABLE second (id INTEGER PRIMARY KEY) STRICT'),
      migration(1, 'first', 'CREATE TABLE first (id INTEGER PRIMARY KEY) STRICT'),
    ]

    expect(migrate(db, supplied)).toEqual([1, 2])
    expect(db.prepare('SELECT version FROM memory_schema_migrations ORDER BY version').all()).toEqual([{ version: 1 }, { version: 2 }])
  })

  it('rolls back schema and history when a migration statement fails', () => {
    const db = database()
    const failing = migration(1, 'failing', 'CREATE TABLE rolled_back (id INTEGER PRIMARY KEY) STRICT; CREATE TABLE rolled_back (id INTEGER);')

    expect(() => migrate(db, [failing])).toThrowError(MemoryError)
    expect(tables(db)).toEqual(['memory_schema_migrations'])
    expect(db.prepare('SELECT * FROM memory_schema_migrations').all()).toEqual([])
  })

  it('rejects duplicate migration versions before changing the database', () => {
    const db = database()
    const duplicate = [migration(1, 'first', 'SELECT 1'), migration(1, 'other', 'SELECT 2')]

    expect(() => migrate(db, duplicate)).toThrowError(/Duplicate migration version/)
    expect(tables(db)).toEqual([])
  })

  it('rejects a manifest whose migration source no longer matches its checksum', () => {
    const db = database()
    const altered = { ...migration(1, 'first', 'SELECT 1'), sql: 'SELECT 2' }

    expect(() => migrate(db, [altered])).toThrowError(/source checksum/)
    expect(tables(db)).toEqual([])
  })

  it('fails closed when the database contains an unsupported future schema version', () => {
    const db = database()
    migrate(db)
    db.prepare('INSERT INTO memory_schema_migrations(version, name, checksum) VALUES (99, \'future\', \'future\')').run()

    expect(() => migrate(db)).toThrowError(/newer than this application supports/)
  })

  it('fails closed when an applied migration checksum differs', () => {
    const db = database()
    migrate(db)
    db.prepare('UPDATE memory_schema_migrations SET checksum = \'altered\' WHERE version = 1').run()

    expect(() => migrate(db)).toThrowError(/checksum does not match/)
  })
})
