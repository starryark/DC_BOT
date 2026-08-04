import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'

let db: DatabaseSync

beforeEach(() => {
  db = new SQLiteDatabase(':memory:')
  migrate(db)
})

afterEach(() => db.close())

function run(sql: string, ...values: Array<string | number | null>): void {
  db.prepare(sql).run(...values)
}

function tableNames(): string[] {
  return (db.prepare('SELECT name FROM sqlite_schema WHERE type = \'table\' AND name NOT LIKE \'sqlite_%\' ORDER BY name').all() as Array<{ name: string }>).map(row => row.name)
}

function insertPerson(id: string, discordId: string): void {
  run('INSERT INTO people(person_id, discord_user_id, created_at) VALUES (?, ?, ?)', id, discordId, '2026-01-01T00:00:00Z')
}

function insertRoom(id: string, scopeType = 'guild', scopeId = 'guild-1'): void {
  run('INSERT INTO logical_rooms(logical_room_id, isolation_scope_type, isolation_scope_id, room_kind, created_at) VALUES (?, ?, ?, ?, ?)', id, scopeType, scopeId, scopeType === 'logical_room' ? 'logical' : scopeType, '2026-01-01T00:00:00Z')
}

function insertEvent(id: string, room: string, sequence: number, person: string | null = null, snapshot: string | null = null): void {
  run(`INSERT INTO events(event_id, logical_room_id, room_sequence, event_kind, direction, modality, author_person_id, actor_snapshot_id, content_json, source_system, source_event_key, occurred_at, received_at, committed_at, immutability_hash, writer_version)
       VALUES (?, ?, ?, 'message', 'inbound', 'text', ?, ?, '{}', 'test', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'hash', 'test')`, id, room, sequence, person, snapshot, id)
}

describe('imp-201 schema v1', () => {
  it('creates every normalized schema object assigned to the persistence foundation', () => {
    expect(tableNames()).toEqual([
      'actor_snapshot_details',
      'actor_snapshots',
      'alias_evidence',
      'alias_evidence_links',
      'alias_preferences',
      'alias_repository_records',
      'aliases',
      'assistant_generations',
      'context_snapshot_evidence',
      'corrections',
      'current_discord_guild_profiles',
      'current_discord_profiles',
      'deletion_tombstones',
      'delivery_attempt_records',
      'delivery_attempts',
      'delivery_lifecycle_records',
      'episodic_memories',
      'episodic_repository_records',
      'event_lifecycle',
      'events',
      'external_identities',
      'forget_requests',
      'generation_attempt_records',
      'generation_causal_edges',
      'generation_causes',
      'generation_context_manifest_items',
      'generation_context_manifests',
      'generation_identifiers',
      'generation_lifecycle_records',
      'generation_snapshot_events',
      'idempotency_records',
      'identity_resolutions',
      'inbound_event_lifecycle',
      'inbound_event_records',
      'legacy_room_resolutions',
      'legacy_unresolved_actors',
      'logical_room_repository_records',
      'logical_rooms',
      'memory_provenance',
      'memory_schema_migrations',
      'memory_source_event_records',
      'migration_record_maps',
      'migration_runs',
      'migration_source_records',
      'output_segment_records',
      'output_segments',
      'people',
      'physical_room_records',
      'physical_rooms',
      'privacy_operation_records',
      'procedural_memories',
      'procedural_repository_records',
      'reconciliation_evidence_records',
      'room_binding_records',
      'room_binding_versions',
      'room_bindings',
      'semantic_correction_records',
      'semantic_fact_repository_records',
      'semantic_memories',
      'summaries',
      'summary_repository_records',
      'summary_source_event_records',
      'voice_drains',
      'worker_jobs',
    ])
  })

  it('creates the required uniqueness, retrieval, reconciliation, and job indexes', () => {
    const indexes = (db.prepare('SELECT name FROM sqlite_schema WHERE type = \'index\' AND name NOT LIKE \'sqlite_%\' ORDER BY name').all() as Array<{ name: string }>).map(row => row.name)

    expect(indexes).toEqual(expect.arrayContaining([
      'ix_aliases_resolution',
      'ix_delivery_generation',
      'ix_delivery_reconcile',
      'ix_events_person_time',
      'ix_events_room_kind_sequence',
      'ix_events_room_sequence',
      'ix_generation_causes_trigger',
      'ix_jobs_claim',
      'ix_jobs_lease',
      'ix_provenance_source_event',
      'ix_semantic_scope_predicate',
      'uq_alias_preference_current',
      'uq_room_binding_current',
      'uq_summary_active_slot',
    ]))
  })

  it('anchors identity only on Discord ID while allowing equal display names', () => {
    insertPerson('person-1', '111')
    insertPerson('person-2', '222')
    run('INSERT INTO actor_snapshots(snapshot_id, person_id, username, captured_at) VALUES (\'snap-1\', \'person-1\', \'same-name\', \'2026-01-01\')')
    run('INSERT INTO actor_snapshots(snapshot_id, person_id, username, captured_at) VALUES (\'snap-2\', \'person-2\', \'same-name\', \'2026-01-01\')')

    expect(() => insertPerson('person-3', '111')).toThrow()
    expect(db.prepare('SELECT person_id, username FROM actor_snapshots ORDER BY person_id').all()).toEqual([
      { person_id: 'person-1', username: 'same-name' },
      { person_id: 'person-2', username: 'same-name' },
    ])
  })

  it('preserves historical snapshots when current aliases change', () => {
    insertPerson('person-1', '111')
    run('INSERT INTO actor_snapshots(snapshot_id, person_id, username, captured_at) VALUES (\'snapshot-old\', \'person-1\', \'old-name\', \'2026-01-01\')')
    run('INSERT INTO aliases(alias_id, person_id, scope_type, scope_id, value, precedence, visibility, valid_from, valid_to) VALUES (\'alias-old\', \'person-1\', \'guild\', \'guild-1\', \'old-name\', 1, \'public\', \'2026-01-01\', \'2026-02-01\')')
    run('INSERT INTO aliases(alias_id, person_id, scope_type, scope_id, value, precedence, visibility, valid_from) VALUES (\'alias-new\', \'person-1\', \'guild\', \'guild-1\', \'new-name\', 1, \'public\', \'2026-02-01\')')

    expect(db.prepare('SELECT username FROM actor_snapshots WHERE snapshot_id = \'snapshot-old\'').get()).toEqual({ username: 'old-name' })
  })

  it('enforces foreign keys and attributable inbound voice authors', () => {
    insertRoom('room-1')
    expect(() => insertEvent('bad-event', 'missing-room', 1)).toThrow()
    expect(() => run(`INSERT INTO events(event_id, logical_room_id, room_sequence, event_kind, direction, modality, content_json, source_system, source_event_key, occurred_at, received_at, committed_at, immutability_hash, writer_version)
      VALUES ('voice', 'room-1', 1, 'utterance', 'inbound', 'voice', '{}', 'discord', 'voice', '2026-01-01', '2026-01-01', '2026-01-01', 'hash', 'test')`)).toThrow()
  })

  it('isolates identical scope keys across DM, guild, character, person, logical, and unbound dimensions', () => {
    for (const [type, kind] of [['dm', 'dm'], ['guild', 'guild'], ['person', 'person'], ['character', 'character'], ['logical_room', 'logical'], ['unbound_channel', 'unbound_channel']] as const)
      run('INSERT INTO logical_rooms(logical_room_id, isolation_scope_type, isolation_scope_id, room_kind, created_at) VALUES (?, ?, ?, ?, ?)', `room-${type}`, type, 'same-key', kind, '2026-01-01')

    expect(db.prepare('SELECT COUNT(*) AS count FROM logical_rooms').get()).toEqual({ count: 6 })
  })

  it('supports many triggering events for one assistant generation without inferring causality from sequence', () => {
    insertRoom('room-1')
    insertEvent('event-1', 'room-1', 1)
    insertEvent('event-2', 'room-1', 2)
    run(`INSERT INTO events(event_id, logical_room_id, room_sequence, event_kind, direction, modality, content_json, source_system, source_event_key, occurred_at, received_at, committed_at, immutability_hash, writer_version)
      VALUES ('assistant-event', 'room-1', 3, 'assistant', 'outbound', 'text', '{}', 'internal', 'assistant-event', '2026-01-01', '2026-01-01', '2026-01-01', 'hash', 'test')`)
    run('INSERT INTO assistant_generations(generation_id, assistant_event_id, generation_idempotency_key, context_snapshot_version, generation_started_at, generation_status, context_eligibility) VALUES (\'generation-1\', \'assistant-event\', \'idem-1\', 2, \'2026-01-01\', \'generated\', \'eligible\')')
    run('INSERT INTO generation_causes(generation_id, triggering_event_id, ordinal) VALUES (\'generation-1\', \'event-1\', 0)')
    run('INSERT INTO generation_causes(generation_id, triggering_event_id, ordinal) VALUES (\'generation-1\', \'event-2\', 1)')

    expect(db.prepare('SELECT triggering_event_id FROM generation_causes WHERE generation_id = \'generation-1\' ORDER BY ordinal').all()).toEqual([{ triggering_event_id: 'event-1' }, { triggering_event_id: 'event-2' }])
  })

  it('represents crash-ambiguous delivery and forbids claiming voice was delivered', () => {
    insertRoom('room-1')
    run(`INSERT INTO events(event_id, logical_room_id, room_sequence, event_kind, direction, modality, content_json, source_system, source_event_key, occurred_at, received_at, committed_at, immutability_hash, writer_version)
      VALUES ('assistant-event', 'room-1', 1, 'assistant', 'outbound', 'voice', '{}', 'internal', 'assistant-event', '2026-01-01', '2026-01-01', '2026-01-01', 'hash', 'test')`)
    run('INSERT INTO assistant_generations(generation_id, assistant_event_id, generation_idempotency_key, context_snapshot_version, generation_started_at, generation_status, context_eligibility) VALUES (\'generation-1\', \'assistant-event\', \'idem-1\', 0, \'2026-01-01\', \'generated\', \'eligible\')')
    run('INSERT INTO delivery_attempts(delivery_attempt_id, generation_id, medium, destination_key, attempt_no, idempotency_key, started_at, result) VALUES (\'delivery-1\', \'generation-1\', \'discord_voice\', \'channel-1\', 1, \'delivery-idem\', \'2026-01-01\', \'unknown_after_crash\')')

    expect(() => run('INSERT INTO delivery_attempts(delivery_attempt_id, generation_id, medium, destination_key, attempt_no, idempotency_key, started_at, result) VALUES (\'delivery-2\', \'generation-1\', \'discord_voice\', \'channel-1\', 2, \'delivery-idem-2\', \'2026-01-01\', \'delivered\')')).toThrow()
  })

  it('represents provenance, correction/supersession, and deletion without erasing audit shells', () => {
    insertRoom('room-1')
    insertEvent('source-event', 'room-1', 1)
    run('INSERT INTO semantic_memories(memory_id, scope_type, scope_id, predicate_key, value_json, confidence, status, created_at) VALUES (\'memory-old\', \'guild\', \'guild-1\', \'name\', \'{"value":"old"}\', 0.8, \'superseded\', \'2026-01-01\')')
    run('INSERT INTO semantic_memories(memory_id, scope_type, scope_id, predicate_key, value_json, confidence, status, created_at) VALUES (\'memory-new\', \'guild\', \'guild-1\', \'name\', \'{"value":"new"}\', 1, \'active\', \'2026-01-02\')')
    run('UPDATE semantic_memories SET superseded_by_id = \'memory-new\' WHERE memory_id = \'memory-old\'')
    run('INSERT INTO memory_provenance(provenance_id, memory_kind, memory_id, source_event_id, role) VALUES (\'prov-1\', \'semantic\', \'memory-new\', \'source-event\', \'correction\')')
    run('INSERT INTO corrections(correction_id, target_kind, target_id, replacement_id, reason, evidence_event_id, requested_by, created_at, idempotency_key) VALUES (\'correction-1\', \'semantic\', \'memory-old\', \'memory-new\', \'updated\', \'source-event\', \'person-1\', \'2026-01-02\', \'correction-idem\')')
    run('INSERT INTO forget_requests(forget_request_id, subject_type, subject_id, scope_json, requested_at, status, version, idempotency_key) VALUES (\'forget-1\', \'fact_id\', \'memory-old\', \'{}\', \'2026-01-03\', \'processing\', 1, \'forget-idem\')')
    run('INSERT INTO deletion_tombstones(tombstone_id, forget_request_id, target_table, target_id, redaction_state, created_at) VALUES (\'tomb-1\', \'forget-1\', \'semantic_memories\', \'memory-old\', \'redacted\', \'2026-01-03\')')
    run('UPDATE semantic_memories SET status = \'tombstoned\', value_json = NULL WHERE memory_id = \'memory-old\'')

    expect(db.prepare('SELECT status, value_json, superseded_by_id FROM semantic_memories WHERE memory_id = \'memory-old\'').get()).toEqual({ status: 'tombstoned', value_json: null, superseded_by_id: 'memory-new' })
  })

  it('enforces idempotency and current-head uniqueness constraints', () => {
    insertPerson('person-1', '111')
    run('INSERT INTO aliases(alias_id, person_id, scope_type, scope_id, value, precedence, visibility, valid_from) VALUES (\'alias-1\', \'person-1\', \'guild\', \'guild-1\', \'name\', 1, \'public\', \'2026-01-01\')')
    run('INSERT INTO alias_preferences(alias_preference_id, person_id, scope_type, scope_id, alias_id, version, valid_from) VALUES (\'pref-1\', \'person-1\', \'guild\', \'guild-1\', \'alias-1\', 1, \'2026-01-01\')')

    expect(() => run('INSERT INTO alias_preferences(alias_preference_id, person_id, scope_type, scope_id, alias_id, version, valid_from) VALUES (\'pref-2\', \'person-1\', \'guild\', \'guild-1\', \'alias-1\', 2, \'2026-01-02\')')).toThrow()
  })

  it('exposes intended nullability and defaults through SQLite metadata', () => {
    const eventColumns = db.prepare('PRAGMA table_info(\'events\')').all() as Array<{ name: string, notnull: number, dflt_value: string | null }>
    const byName = new Map(eventColumns.map(column => [column.name, column]))

    expect(byName.get('author_person_id')?.notnull).toBe(0)
    expect(byName.get('content_json')?.notnull).toBe(1)
    expect(byName.get('redaction_state')?.dflt_value).toBe('\'active\'')
    expect(byName.get('schema_version')?.dflt_value).toBe('1')
  })
})
