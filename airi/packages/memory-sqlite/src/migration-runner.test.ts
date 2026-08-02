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

    expect(migrate(db)).toEqual([1, 2, 3])
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(db.prepare('SELECT version, name, checksum FROM memory_schema_migrations').all()).toEqual([
      { version: 1, name: 'initial_shared_memory_schema', checksum: migrations[0]?.checksum },
      { version: 2, name: 'identity_alias_repositories', checksum: migrations[1]?.checksum },
      { version: 3, name: 'room_binding_authorization_repositories', checksum: migrations[2]?.checksum },
    ])
    expect(latestSchemaVersion).toBe(3)
  })

  it('is a no-op when every known migration is already applied', () => {
    const db = database()
    migrate(db)

    expect(migrate(db)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS count FROM memory_schema_migrations').get()).toEqual({ count: 3 })
  })

  it('upgrades v2 in place without changing identity or alias records', () => {
    const db = database()
    migrate(db, migrations.slice(0, 2))
    db.prepare('INSERT INTO people(person_id,discord_user_id,created_at) VALUES (\'person\',\'18446744073709551615\',\'2026-01-01T00:00:00Z\')').run()
    db.prepare('INSERT INTO aliases(alias_id,person_id,scope_type,scope_id,value,precedence,visibility,valid_from,source) VALUES (\'alias\',\'person\',\'platform\',\'discord\',\'Alex\',0,\'public\',\'2026-01-01T00:00:00Z\',\'test\')').run()

    expect(migrate(db)).toEqual([3])
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
