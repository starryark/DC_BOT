import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite'

import { asTimestamp } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner'
import { SearchRepository } from './search'

describe('searchRepository', () => {
  let db: DatabaseSync
  let repo: SearchRepository

  beforeEach(() => {
    db = new NativeDatabaseSync(':memory:')
    migrate(db)
    repo = new SearchRepository(db)
  })

  afterEach(() => {
    db.close()
  })

  it('declines lexical search if lexical mode is not requested', () => {
    const output = repo.searchMemory({
      query: 'test',
      modes: ['structured'],
      layers: ['semantic'],
      scope: { kind: 'guild', id: 'guild-1' },
      limit: 10,
    })
    expect(output.abstained).toBe('noAuthorizedEvidence')
    expect(output.hits).toEqual([])
  })

  it('filters results exactly by the provided scope (authorization lock)', () => {
    // Insert into logical room, events, and FTS
    db.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO inbound_event_records (event_id, logical_room_id, idempotency_key, event_kind, actor_kind, actor_json, physical_room_id, room_sequence, occurred_at, recorded_at, payload_json, retention_class, envelope_hash) 
      VALUES 
        ('event-1', 'room-1', 'key1', 'system', 'anonymous', '{}', 'phys-1', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{"content": "hello world"}', 'transcript', 'hash1'),
        ('event-2', 'room-2', 'key2', 'system', 'anonymous', '{}', 'phys-2', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{"content": "hello world"}', 'transcript', 'hash2');
      PRAGMA foreign_keys = ON;
    `)

    const output = repo.searchMemory({
      query: 'hello',
      modes: ['lexical'],
      layers: ['raw'],
      scope: { kind: 'logical_room', id: 'room-1' },
      limit: 10,
    })

    expect(output.hits).toHaveLength(1)
    expect((output.hits[0]!.record as any).eventId).toBe('event-1')
  })

  it('filters by temporal boundaries', () => {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO inbound_event_records (event_id, logical_room_id, idempotency_key, event_kind, actor_kind, actor_json, physical_room_id, room_sequence, occurred_at, recorded_at, payload_json, retention_class, envelope_hash) 
      VALUES 
        ('event-old', 'room-1', 'key1', 'system', 'anonymous', '{}', 'phys-1', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{"content": "test message"}', 'transcript', 'hash1'),
        ('event-new', 'room-1', 'key2', 'system', 'anonymous', '{}', 'phys-1', 2, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', '{"content": "test message"}', 'transcript', 'hash2');
      PRAGMA foreign_keys = ON;
    `)

    const output = repo.searchMemory({
      query: 'test',
      modes: ['lexical'],
      layers: ['raw'],
      scope: { kind: 'logical_room', id: 'room-1' },
      since: asTimestamp('2026-01-01T12:00:00.000Z'),
      limit: 10,
    })

    expect(output.hits).toHaveLength(1)
    expect((output.hits[0]!.record as any).eventId).toBe('event-new')
  })
})
