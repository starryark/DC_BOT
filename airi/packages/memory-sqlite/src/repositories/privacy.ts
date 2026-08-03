import type { DatabaseSync } from 'node:sqlite'

import { randomUUID } from 'node:crypto'

export class PrivacyRepository {
  constructor(private readonly db: DatabaseSync) {}
  counts(personId: string, roomId: string): { events: number, facts: number } {
    const events = this.db.prepare(`SELECT count(*) count FROM inbound_event_records WHERE author_person_id=? AND logical_room_id=? AND json_extract(payload_json,'$.redacted') IS NOT 1`).get(personId, roomId) as { count: number }
    const facts = this.db.prepare(`SELECT count(*) count FROM semantic_fact_repository_records WHERE person_id=? AND scope_kind='logical_room' AND scope_id=? AND tombstoned_by IS NULL AND superseded_by IS NULL`).get(personId, roomId) as { count: number }
    return { events: events.count, facts: facts.count }
  }

  export(personId: string, roomId: string): { format: 1, scope: string, events: unknown[], facts: Array<{ factId: string, predicate: string, value: string, validFrom: string }> } {
    const events = (this.db.prepare(`SELECT event_kind,occurred_at,payload_json FROM inbound_event_records WHERE author_person_id=? AND logical_room_id=? AND json_extract(payload_json,'$.redacted') IS NOT 1 ORDER BY occurred_at`).all(personId, roomId) as Array<{ event_kind: string, occurred_at: string, payload_json: string }>).map(row => ({ kind: row.event_kind, occurredAt: row.occurred_at, payload: JSON.parse(row.payload_json) }))
    const facts = (this.db.prepare(`SELECT fact_id,predicate,value,valid_from FROM semantic_fact_repository_records WHERE person_id=? AND scope_kind='logical_room' AND scope_id=? AND tombstoned_by IS NULL AND superseded_by IS NULL ORDER BY valid_from`).all(personId, roomId) as Array<{ fact_id: string, predicate: string, value: string, valid_from: string }>).map(row => ({ factId: row.fact_id, predicate: row.predicate, value: row.value, validFrom: row.valid_from }))
    return { format: 1, scope: 'requester-current-room', events, facts }
  }

  forget(requestId: string, personId: string, roomId: string, at: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (?,'person',?,?,?,'processing',1,NULL,NULL,?)`).run(requestId, personId, JSON.stringify({ logicalRoomId: roomId }), at, requestId)
      const rows = this.db.prepare('SELECT event_id FROM inbound_event_records WHERE author_person_id=? AND logical_room_id=?').all(personId, roomId) as Array<{ event_id: string }>
      for (const row of rows) {
        this.db.prepare(`UPDATE inbound_event_records SET payload_json=json_object('redacted',json('true')) WHERE event_id=?`).run(row.event_id)
        this.db.prepare('UPDATE summary_repository_records SET stale=1,tombstoned_by=? WHERE summary_id IN (SELECT summary_id FROM summary_source_event_records WHERE source_event_id=?)').run(requestId, row.event_id)
        this.db.prepare(`UPDATE semantic_fact_repository_records SET tombstoned_by=? WHERE fact_id IN (SELECT memory_id FROM memory_source_event_records WHERE memory_kind='semantic' AND source_event_id=?)`).run(requestId, row.event_id)
        this.db.prepare(`UPDATE episodic_repository_records SET tombstoned_by=? WHERE episodic_id IN (SELECT memory_id FROM memory_source_event_records WHERE memory_kind='episodic' AND source_event_id=?)`).run(requestId, row.event_id)
        this.db.prepare(`INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,verified_at,evidence_json) VALUES (?,?,?,?,'verified',?,?,?)`).run(randomUUID(), requestId, 'inbound_event_records', row.event_id, at, at, JSON.stringify({ payloadRedacted: true }))
      }
      this.db.prepare(`UPDATE semantic_fact_repository_records SET tombstoned_by=? WHERE person_id=? AND scope_kind='logical_room' AND scope_id=?`).run(requestId, personId, roomId)
      const remaining = (this.db.prepare(`SELECT count(*) count FROM inbound_event_records WHERE author_person_id=? AND logical_room_id=? AND json_extract(payload_json,'$.redacted') IS NOT 1`).get(personId, roomId) as { count: number }).count
      if (remaining !== 0)
        throw new Error('Deletion verification found remaining requester payloads')
      this.db.prepare(`UPDATE forget_requests SET status='completed',completed_at=?,verification_json=? WHERE forget_request_id=?`).run(at, JSON.stringify({ remaining }), requestId)
      this.db.exec('COMMIT')
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
