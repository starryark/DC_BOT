import type { DatabaseSync } from 'node:sqlite'

import type { DeletionTarget } from '../deletion-targets.js'

import { randomUUID } from 'node:crypto'

import { applyDeletionTarget, verifyDeletionTarget } from '../deletion-targets.js'

export interface ForgetResult { readonly obligations: number, readonly deduplicated: boolean }

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

  /** Plans, records, applies, and verifies the complete requester-room deletion closure atomically. */
  forget(requestId: string, personId: string, roomId: string, at: string): ForgetResult {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const retry = this.db.prepare('SELECT status FROM forget_requests WHERE idempotency_key=?').get(requestId) as { status: string } | undefined
      if (retry) {
        if (retry.status !== 'completed')
          throw new Error('Existing forget request is not complete')
        const obligations = (this.db.prepare('SELECT count(*) count FROM deletion_tombstones WHERE forget_request_id=?').get(requestId) as { count: number }).count
        this.db.exec('COMMIT')
        return { obligations, deduplicated: true }
      }

      this.db.prepare(`INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (?,'person',?,?,?,'processing',1,NULL,NULL,?)`).run(requestId, personId, JSON.stringify({ logicalRoomId: roomId }), at, requestId)
      const plan = this.deletionPlan(personId, roomId)
      for (const target of plan)
        this.db.prepare(`INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,evidence_json) VALUES (?,?,?,?,'pending',?,'{}')`).run(randomUUID(), requestId, target.targetTable, target.targetId, at)
      for (const target of plan)
        applyDeletionTarget(this.db, target, requestId)
      for (const target of plan)
        verifyDeletionTarget(this.db, target)
      this.db.prepare(`UPDATE deletion_tombstones SET redaction_state='verified',verified_at=? WHERE forget_request_id=?`).run(at, requestId)
      this.db.prepare(`UPDATE forget_requests SET status='completed',completed_at=?,verification_json=? WHERE forget_request_id=?`).run(at, JSON.stringify({ remaining: 0, obligations: plan.length }), requestId)
      this.db.exec('COMMIT')
      return { obligations: plan.length, deduplicated: false }
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  private deletionPlan(personId: string, roomId: string): readonly DeletionTarget[] {
    const eventScope = `SELECT event_id FROM inbound_event_records WHERE author_person_id=? AND logical_room_id=? AND json_extract(payload_json,'$.redacted') IS NOT 1`
    const targets: DeletionTarget[] = []
    const add = (targetTable: DeletionTarget['targetTable'], rows: readonly Record<string, string>[], field: string) => {
      for (const row of rows)
        targets.push({ targetTable, targetId: row[field]! })
    }
    add('inbound_event_records', this.db.prepare(eventScope).all(personId, roomId) as Array<{ event_id: string }>, 'event_id')
    add('summary_repository_records', this.db.prepare(`SELECT summary_id FROM summary_repository_records WHERE tombstoned_by IS NULL AND summary_id IN (SELECT summary_id FROM summary_source_event_records WHERE source_event_id IN (${eventScope}))`).all(personId, roomId) as Array<{ summary_id: string }>, 'summary_id')
    add('semantic_fact_repository_records', this.db.prepare(`SELECT fact_id FROM semantic_fact_repository_records WHERE tombstoned_by IS NULL AND ((person_id=? AND scope_kind='logical_room' AND scope_id=?) OR fact_id IN (SELECT memory_id FROM memory_source_event_records WHERE memory_kind='semantic' AND source_event_id IN (${eventScope})))`).all(personId, roomId, personId, roomId) as Array<{ fact_id: string }>, 'fact_id')
    add('episodic_repository_records', this.db.prepare(`SELECT episodic_id FROM episodic_repository_records WHERE tombstoned_by IS NULL AND ((person_id=? AND logical_room_id=?) OR episodic_id IN (SELECT memory_id FROM memory_source_event_records WHERE memory_kind='episodic' AND source_event_id IN (${eventScope})))`).all(personId, roomId, personId, roomId) as Array<{ episodic_id: string }>, 'episodic_id')
    add('output_segment_records', this.db.prepare(`SELECT s.segment_id FROM output_segment_records s JOIN generation_attempt_records g ON g.generation_id=s.generation_id WHERE g.logical_room_id=? AND s.exact_text<>'' AND EXISTS (SELECT 1 FROM generation_causal_edges e WHERE e.generation_id=g.generation_id AND e.inbound_event_id IN (${eventScope}))`).all(roomId, personId, roomId) as Array<{ segment_id: string }>, 'segment_id')
    return [...new Map(targets.map(target => [`${target.targetTable}:${target.targetId}`, target])).values()]
  }
}
