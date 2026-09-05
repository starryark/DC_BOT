import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { PrivacyRepository } from './privacy.js'
import { SearchRepository } from './search.js'

describe('iMP-608 transactional forget invalidation', () => {
  let db: DatabaseSync
  let privacy: PrivacyRepository

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    migrate(db)
    privacy = new PrivacyRepository(db)
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO inbound_event_records(event_id,logical_room_id,idempotency_key,event_kind,actor_kind,actor_json,author_person_id,physical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash)
      VALUES ('event-delete','room-a','event-key-a','user_text','attributed','{}','person-a','physical-a',1,'2026-01-01','2026-01-01','{"content":"forgettable phrase"}','transcript','hash-a'),
             ('event-retain','room-a','event-key-b','user_text','attributed','{}','person-b','physical-a',2,'2026-01-02','2026-01-02','{"content":"retained phrase"}','transcript','hash-b');
      INSERT INTO summary_repository_records(summary_id,logical_room_id,text,model_ref,stale,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('summary-shared','room-a','forgettable summary','model',0,'2026-01-02','2026-01-02','derived','summarization','2026-01-02','summary-hash');
      INSERT INTO summary_source_event_records VALUES ('summary-shared','event-delete',0),('summary-shared','event-retain',1);
      INSERT INTO generation_attempt_records(generation_id,idempotency_key,logical_room_id,character_id,current_state,observed_room_version,context_manifest_hash,observed_binding_version,captured_at,model_ref,started_at,input_hash)
      VALUES ('generation-a','generation-key','room-a','character-a','persisted',1,'manifest',1,'2026-01-01','model','2026-01-01','generation-hash');
      INSERT INTO generation_causal_edges VALUES ('generation-a','event-delete','trigger');
      INSERT INTO output_segment_records VALUES ('segment-a','generation-a',0,'text','forgettable output','output-hash');
      INSERT INTO delivery_attempt_records(delivery_id,segment_id,transport,destination_id,idempotency_key,attempt_number,current_state,current_evidence_json,started_at,last_transition_at,input_hash)
      VALUES ('delivery-a','segment-a','discord_text','channel-a','delivery-key',1,'delivered','{}','2026-01-01','2026-01-01','delivery-hash');
      PRAGMA foreign_keys=ON;
    `)
  })

  afterEach(() => db.close())

  it('invalidates the full closure, including shared summaries and delivered output, then replays idempotently', () => {
    const first = privacy.forget('forget-a', 'person-a', 'room-a', '2026-01-03')
    const retry = privacy.forget('forget-a', 'person-a', 'room-a', '2026-01-03')

    expect(first).toEqual({ forgetRequestId: 'forget-a', obligations: 3, deduplicated: false })
    expect(retry).toEqual({ forgetRequestId: 'forget-a', obligations: 3, deduplicated: true })
    expect(db.prepare('SELECT payload_json FROM inbound_event_records WHERE event_id=\'event-delete\'').get()).toEqual({ payload_json: '{"redacted":true}' })
    expect(db.prepare('SELECT stale,tombstoned_by FROM summary_repository_records WHERE summary_id=\'summary-shared\'').get()).toEqual({ stale: 1, tombstoned_by: 'forget-a' })
    expect(db.prepare('SELECT exact_text FROM output_segment_records WHERE segment_id=\'segment-a\'').get()).toEqual({ exact_text: '' })
    expect(db.prepare('SELECT payload_json FROM inbound_event_records WHERE event_id=\'event-retain\'').get()).toEqual({ payload_json: '{"content":"retained phrase"}' })
    expect(new SearchRepository(db).searchMemory({ query: 'forgettable', modes: ['lexical'], layers: ['raw', 'summary'], scope: { kind: 'logical_room', id: 'room-a' }, limit: 10 }).hits).toEqual([])
  })

  it('succeeds when an FTS row is already absent', () => {
    db.prepare('DELETE FROM memory_search_latin WHERE target_table=\'inbound_event_records\' AND target_id=\'event-delete\'').run()

    expect(privacy.forget('forget-a', 'person-a', 'room-a', '2026-01-03').obligations).toBe(3)
  })

  it('rolls back the request and all mutations when invalidation fails', () => {
    db.exec('CREATE TRIGGER fail_summary_invalidation BEFORE UPDATE ON summary_repository_records BEGIN SELECT RAISE(ABORT,\'forced invalidation failure\'); END')

    expect(() => privacy.forget('forget-a', 'person-a', 'room-a', '2026-01-03')).toThrow('forced invalidation failure')
    expect(db.prepare('SELECT count(*) count FROM forget_requests').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT count(*) count FROM deletion_tombstones').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT payload_json FROM inbound_event_records WHERE event_id=\'event-delete\'').get()).toEqual({ payload_json: '{"content":"forgettable phrase"}' })
  })

  it('rolls back instead of recording false completion when verification fails', () => {
    db.exec('CREATE TRIGGER defeat_summary_invalidation AFTER UPDATE ON summary_repository_records BEGIN UPDATE summary_repository_records SET stale=0,tombstoned_by=NULL WHERE summary_id=new.summary_id; END')

    expect(() => privacy.forget('forget-a', 'person-a', 'room-a', '2026-01-03')).toThrow('deletion verification failed')
    expect(db.prepare('SELECT count(*) count FROM forget_requests').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT count(*) count FROM deletion_tombstones').get()).toEqual({ count: 0 })
  })
})
