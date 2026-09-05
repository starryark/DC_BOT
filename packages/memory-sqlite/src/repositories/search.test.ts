import type { DatabaseSync } from 'node:sqlite'

import { Buffer } from 'node:buffer'
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

  it('does not widen a logical-room query to platform or kind-wide records', () => {
    db.exec(`
      INSERT INTO semantic_fact_repository_records(fact_id,scope_kind,scope_id,predicate,value,confidence,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('fact-room','logical_room','room-1','scope','scope needle room',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','operator','operatorEntry','2026-01-01T00:00:00Z','room-hash'),
             ('fact-global','platform',NULL,'scope','scope needle global',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','operator','operatorEntry','2026-01-01T00:00:00Z','global-hash');
    `)

    const output = repo.searchMemory({ query: 'needle', modes: ['lexical'], layers: ['semantic'], scope: { kind: 'logical_room', id: 'room-1' }, limit: 10 })
    expect(output.hits.map(hit => (hit.record as { factId: string }).factId)).toEqual(['fact-room'])
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

  it('rejects canonically invalid records even when matching FTS rows survive or are restored', () => {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO inbound_event_records(event_id,logical_room_id,idempotency_key,event_kind,actor_kind,actor_json,physical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash)
      VALUES ('event-redacted','room-1','raw-key','system','anonymous','{}','physical-1',1,'2026-01-01','2026-01-01','{"content":"lifecycle raw"}','transcript','raw-hash');
      UPDATE inbound_event_records SET payload_json='{"redacted":true}' WHERE event_id='event-redacted';
      INSERT INTO memory_search_latin(text_content,auth_scope,target_table,target_id) VALUES ('lifecycle raw',hex('logical_room:room-1'),'inbound_event_records','event-redacted');

      INSERT INTO semantic_fact_repository_records(fact_id,scope_kind,scope_id,predicate,value,confidence,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('fact-old','logical_room','room-1','state','lifecycle old',1,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','userStated','explicitCommand','2026-01-01T00:00:00Z','old-hash'),
             ('fact-current','logical_room','room-1','state','lifecycle current',1,'2026-01-02T00:00:00Z','2026-01-02T00:00:00Z','userStated','explicitCommand','2026-01-02T00:00:00Z','new-hash');
      UPDATE semantic_fact_repository_records SET valid_until='2026-01-02T00:00:00Z',superseded_by='fact-current' WHERE fact_id='fact-old';

      INSERT INTO summary_repository_records(summary_id,logical_room_id,text,model_ref,stale,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('summary-stale','room-1','lifecycle summary','model',1,'2026-01-01','2026-01-01','derived','summarization','2026-01-01','summary-hash');

      INSERT INTO generation_attempt_records(generation_id,idempotency_key,logical_room_id,character_id,current_state,observed_room_version,context_manifest_hash,observed_binding_version,captured_at,model_ref,started_at,input_hash)
      VALUES ('generation-1','generation-key','room-1','character-1','persisted',1,'manifest',1,'2026-01-01','model','2026-01-01','generation-hash');
      INSERT INTO output_segment_records VALUES ('segment-invalid','generation-1',0,'text','lifecycle output','output-hash');
      INSERT INTO delivery_attempt_records(delivery_id,segment_id,transport,destination_id,idempotency_key,attempt_number,current_state,current_evidence_json,started_at,last_transition_at,input_hash)
      VALUES ('delivery-1','segment-invalid','discord_text','channel-1','delivery-key',1,'delivered','{}','2026-01-01','2026-01-01','delivery-hash');
      UPDATE output_segment_records SET exact_text='' WHERE segment_id='segment-invalid';
      PRAGMA foreign_keys=ON;
    `)

    const output = repo.searchMemory({ query: 'lifecycle', modes: ['lexical'], layers: ['raw', 'semantic', 'summary'], scope: { kind: 'logical_room', id: 'room-1' }, limit: 20 })

    expect(output.hits).toHaveLength(1)
    expect((output.hits[0]!.record as { factId: string }).factId).toBe('fact-current')
  })

  it('retrieves the historically valid side of a supersession chain as of the requested instant', () => {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO semantic_fact_repository_records(fact_id,scope_kind,scope_id,predicate,value,confidence,valid_from,valid_until,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('fact-old','logical_room','room-1','home','historic Osaka',1,'2026-01-01T00:00:00Z','2026-02-01T00:00:00Z','2026-01-01T00:00:00Z','userStated','explicitCommand','2026-01-01T00:00:00Z','old-hash'),
             ('fact-new','logical_room','room-1','home','historic Tokyo',1,'2026-02-01T00:00:00Z',NULL,'2026-02-01T00:00:00Z','userStated','explicitCommand','2026-02-01T00:00:00Z','new-hash');
      UPDATE semantic_fact_repository_records SET superseded_by='fact-new' WHERE fact_id='fact-old';
      UPDATE semantic_fact_repository_records SET supersedes='fact-old' WHERE fact_id='fact-new';
      PRAGMA foreign_keys=ON;
    `)

    const historical = repo.searchMemory({ query: 'historic', modes: ['lexical'], layers: ['semantic'], scope: { kind: 'logical_room', id: 'room-1' }, until: asTimestamp('2026-01-15T00:00:00.000Z'), limit: 10 })
    const current = repo.searchMemory({ query: 'historic', modes: ['lexical'], layers: ['semantic'], scope: { kind: 'logical_room', id: 'room-1' }, limit: 10 })

    expect(historical.hits.map(hit => (hit.record as { factId: string }).factId)).toEqual(['fact-old'])
    expect(current.hits.map(hit => (hit.record as { factId: string }).factId)).toEqual(['fact-new'])
  })
})

/**
 * `rebuildSearch()` is the recovery path for indexes the v9 triggers could not
 * have maintained. Its correctness condition is therefore not "it inserts
 * plausible rows" but "it agrees with the triggers": a rebuilt index that
 * indexed one more table, or one fewer scope, than the trigger-maintained one
 * would make search results depend on whether a rebuild had happened.
 */
describe('searchRepository.rebuildSearch', () => {
  let db: DatabaseSync
  let repo: SearchRepository

  /** Every FTS row, ordered, for whichever index is asked for. */
  function indexRows(table: 'memory_search_latin' | 'memory_search_cjk'): unknown[] {
    return db
      .prepare(`SELECT text_content, auth_scope, target_table, target_id FROM ${table} ORDER BY target_table, target_id`)
      .all()
  }

  beforeEach(() => {
    db = new NativeDatabaseSync(':memory:')
    migrate(db)
    repo = new SearchRepository(db)

    // One row per indexed source table. Foreign keys are off because this
    // exercises the projections, not referential integrity: wiring up people,
    // rooms, and forget requests would not change what gets indexed.
    db.exec(`
      PRAGMA foreign_keys = OFF;

      INSERT INTO inbound_event_records (event_id, logical_room_id, idempotency_key, event_kind, actor_kind, actor_json, physical_room_id, room_sequence, occurred_at, recorded_at, payload_json, retention_class, envelope_hash)
      VALUES ('event-1', 'room-1', 'key1', 'system', 'anonymous', '{}', 'phys-1', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '{"content": "inbound corpus text"}', 'transcript', 'hash1');

      INSERT INTO semantic_fact_repository_records (fact_id, scope_kind, scope_id, predicate, value, confidence, valid_from, recorded_at, provenance_source, extraction_method, stated_at, input_hash)
      VALUES ('fact-1', 'guild', 'guild-1', 'likes', 'semantic corpus text', 1.0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'userStated', 'explicitCommand', '2026-01-01T00:00:00Z', 'h');

      INSERT INTO episodic_repository_records (episodic_id, logical_room_id, occurred_at, summary, valid_from, recorded_at, provenance_source, extraction_method, stated_at, input_hash)
      VALUES ('epi-1', 'room-1', '2026-01-01T00:00:00Z', 'episodic corpus text', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'derived', 'summarization', '2026-01-01T00:00:00Z', 'h');

      INSERT INTO summary_repository_records (summary_id, logical_room_id, text, model_ref, stale, valid_from, recorded_at, provenance_source, extraction_method, stated_at, input_hash)
      VALUES ('sum-1', 'room-1', 'summary corpus text', 'model', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'derived', 'summarization', '2026-01-01T00:00:00Z', 'h');

      INSERT INTO procedural_repository_records (proc_id, rule, valid_from, recorded_at, provenance_source, extraction_method, stated_at, authored_by, input_hash)
      VALUES ('proc-1', 'procedural corpus text', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'operator', 'operatorEntry', '2026-01-01T00:00:00Z', 'owner', 'h');

      INSERT INTO generation_attempt_records (generation_id, idempotency_key, logical_room_id, character_id, current_state, observed_room_version, context_manifest_hash, observed_binding_version, captured_at, model_ref, started_at, input_hash)
      VALUES ('gen-1', 'gen-key-1', 'room-1', 'char-1', 'persisted', 1, 'manifest', 1, '2026-01-01T00:00:00Z', 'model', '2026-01-01T00:00:00Z', 'h');

      INSERT INTO output_segment_records (segment_id, generation_id, ordinal, modality, exact_text, content_hash)
      VALUES ('seg-delivered', 'gen-1', 0, 'text', 'delivered output text', 'h1'),
             ('seg-pending', 'gen-1', 1, 'text', 'undelivered output text', 'h2');

      INSERT INTO delivery_attempt_records (delivery_id, segment_id, transport, destination_id, idempotency_key, attempt_number, current_state, current_evidence_json, started_at, last_transition_at, input_hash)
      VALUES ('del-1', 'seg-delivered', 'discord_text', 'chan-1', 'del-key-1', 1, 'delivered', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'h'),
             ('del-2', 'seg-pending', 'discord_text', 'chan-1', 'del-key-2', 1, 'pending', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'h');

      PRAGMA foreign_keys = ON;
    `)
  })

  afterEach(() => {
    db.close()
  })

  it('reproduces exactly what the v9 triggers maintained', () => {
    const latinFromTriggers = indexRows('memory_search_latin')
    const cjkFromTriggers = indexRows('memory_search_cjk')
    expect(latinFromTriggers.length).toBeGreaterThan(0)

    // Simulate an index that the triggers never populated — a database
    // migrated from before v9, or one whose FTS rows were lost.
    db.exec('DELETE FROM memory_search_latin; DELETE FROM memory_search_cjk;')
    expect(indexRows('memory_search_latin')).toEqual([])

    repo.rebuildSearch()

    expect(indexRows('memory_search_latin')).toEqual(latinFromTriggers)
    expect(indexRows('memory_search_cjk')).toEqual(cjkFromTriggers)
  })

  it('populates the Latin and CJK indexes with identical source rows', () => {
    db.exec('DELETE FROM memory_search_latin; DELETE FROM memory_search_cjk;')
    repo.rebuildSearch()

    // Same rows, different tokenizers. The tokenizer is the only thing that
    // may differ between the two indexes.
    expect(indexRows('memory_search_cjk')).toEqual(indexRows('memory_search_latin'))
    expect(db.prepare(`SELECT DISTINCT target_table FROM memory_search_latin ORDER BY target_table`).all()).toEqual([
      { target_table: 'episodic_repository_records' },
      { target_table: 'inbound_event_records' },
      { target_table: 'output_segment_records' },
      { target_table: 'procedural_repository_records' },
      { target_table: 'semantic_fact_repository_records' },
      { target_table: 'summary_repository_records' },
    ])
  })

  it('indexes delivered output but not output that never reached anyone', () => {
    db.exec('DELETE FROM memory_search_latin; DELETE FROM memory_search_cjk;')
    repo.rebuildSearch()

    const segments = db
      .prepare(`SELECT target_id FROM memory_search_latin WHERE target_table = 'output_segment_records'`)
      .all()
    expect(segments).toEqual([{ target_id: 'seg-delivered' }])
  })

  it('preserves each record its own authorization scope', () => {
    db.exec('DELETE FROM memory_search_latin; DELETE FROM memory_search_cjk;')
    repo.rebuildSearch()

    const scopeOf = (targetId: string): string => (db
      .prepare(`SELECT auth_scope FROM memory_search_latin WHERE target_id = ?`)
      .get(targetId) as { auth_scope: string }).auth_scope
    const hex = (scope: string): string => Buffer.from(scope).toString('hex').toUpperCase()

    expect(scopeOf('event-1')).toBe(hex('logical_room:room-1'))
    // A guild-scoped fact must not be rebuilt into its room's scope.
    expect(scopeOf('fact-1')).toBe(hex('guild:guild-1'))
    // Operator rules are global and carry no id.
    expect(scopeOf('proc-1')).toBe(hex('operator:'))
    // Output inherits the room of the generation that produced it.
    expect(scopeOf('seg-delivered')).toBe(hex('logical_room:room-1'))
  })

  it('excludes tombstoned records', () => {
    db.exec(`
      PRAGMA foreign_keys = OFF;
      INSERT INTO deletion_tombstones (tombstone_id, forget_request_id, target_table, target_id, redaction_state, created_at)
      VALUES ('tomb-1', 'forget-1', 'inbound_event_records', 'event-1', 'deleted', '2026-01-02T00:00:00Z');
      PRAGMA foreign_keys = ON;
      DELETE FROM memory_search_latin;
      DELETE FROM memory_search_cjk;
    `)

    repo.rebuildSearch()

    for (const table of ['memory_search_latin', 'memory_search_cjk'] as const) {
      const resurrected = db
        .prepare(`SELECT target_id FROM ${table} WHERE target_table = 'inbound_event_records' AND target_id = 'event-1'`)
        .all()
      expect(resurrected, `${table} resurrected a tombstoned record`).toEqual([])
    }
  })

  it('is idempotent, so a repeated rebuild does not duplicate rows', () => {
    repo.rebuildSearch()
    const once = indexRows('memory_search_latin')

    repo.rebuildSearch()

    expect(indexRows('memory_search_latin')).toEqual(once)
  })
})
