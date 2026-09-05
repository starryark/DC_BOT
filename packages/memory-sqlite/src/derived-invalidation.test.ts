import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DerivedInvalidationPlanner } from './derived-invalidation.js'
import { migrate } from './migration-runner.js'

describe('iMP-608 derived invalidation planning', () => {
  let db: DatabaseSync
  let planner: DerivedInvalidationPlanner

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    migrate(db)
    planner = new DerivedInvalidationPlanner(db)
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO inbound_event_records(event_id,logical_room_id,idempotency_key,event_kind,actor_kind,actor_json,author_person_id,physical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash)
      VALUES ('event-delete','room-a','event-key-a','user_text','attributed','{}','person-a','physical-a',1,'2026-01-01','2026-01-01','{"content":"private source text"}','transcript','hash-a'),
             ('event-retain','room-a','event-key-b','user_text','attributed','{}','person-b','physical-a',2,'2026-01-02','2026-01-02','{"content":"retained source text"}','transcript','hash-b');
      INSERT INTO summary_repository_records(summary_id,logical_room_id,text,model_ref,stale,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('summary-shared','room-a','derived summary text','model',0,'2026-01-02','2026-01-02','derived','summarization','2026-01-02','summary-hash'),
             ('summary-unrelated','room-a','unrelated summary text','model',0,'2026-01-02','2026-01-02','derived','summarization','2026-01-02','summary-other-hash'),
             ('summary-invalid','room-a','old summary text','model',1,'2026-01-02','2026-01-02','derived','summarization','2026-01-02','summary-old-hash');
      INSERT INTO summary_source_event_records VALUES ('summary-shared','event-delete',0),('summary-shared','event-retain',1),('summary-unrelated','event-retain',0),('summary-invalid','event-delete',0);
      UPDATE summary_repository_records SET tombstoned_by='prior-forget' WHERE summary_id='summary-invalid';
      INSERT INTO semantic_fact_repository_records(fact_id,person_id,scope_kind,scope_id,predicate,value,confidence,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('fact-owned','person-a','logical_room','room-a','likes','owned fact text',1,'2026-01-01','2026-01-01','userStated','explicitCommand','2026-01-01','fact-owned-hash'),
             ('fact-provenance',NULL,'guild','guild-a','likes','provenance fact text',1,'2026-01-01','2026-01-01','derived','llmExtraction','2026-01-01','fact-provenance-hash'),
             ('fact-unrelated',NULL,'guild','guild-a','likes','unrelated fact text',1,'2026-01-01','2026-01-01','derived','llmExtraction','2026-01-01','fact-unrelated-hash');
      INSERT INTO memory_source_event_records VALUES ('semantic','fact-owned','event-delete',0),('semantic','fact-provenance','event-delete',0);
      PRAGMA foreign_keys=ON;
    `)
  })

  afterEach(() => db.close())

  it('preserves the requester-room closure, deduplicates routes, and orders targets', () => {
    const plan = planner.plan({ kind: 'forget', requestId: 'forget-a', personId: 'person-a', logicalRoomId: 'room-a' })

    expect(plan.authoritativeTargets).toEqual([{ targetTable: 'inbound_event_records', targetId: 'event-delete' }])
    expect(plan.derivedTargets).toEqual([
      { targetTable: 'semantic_fact_repository_records', targetId: 'fact-owned' },
      { targetTable: 'semantic_fact_repository_records', targetId: 'fact-provenance' },
      { targetTable: 'summary_repository_records', targetId: 'summary-shared' },
    ])
    expect(plan.regenerationObligations).toEqual([{ kind: 'summary', recordId: 'summary-shared', reason: 'forget', runnable: false }])
  })

  it('uses multi-source membership, ignores already invalidated rows, and invents no missing edge', () => {
    const plan = planner.plan({ kind: 'forget', requestId: 'forget-a', personId: 'person-a', logicalRoomId: 'room-a' })
    const identifiers = JSON.stringify(plan)

    expect(identifiers).toContain('summary-shared')
    expect(identifiers).not.toContain('summary-unrelated')
    expect(identifiers).not.toContain('summary-invalid')
    expect(identifiers).not.toContain('fact-unrelated')
    expect(identifiers).not.toContain('private source text')
    expect(identifiers).not.toContain('derived summary text')
  })

  it('provides correction vocabulary without guessed dependencies and plans retention from explicit targets', () => {
    const correction = planner.plan({ kind: 'correction', correctionId: 'correction-a', supersededFactId: 'fact-owned', replacementFactId: 'fact-new' })

    expect(correction.derivedTargets).toEqual([])
    expect(correction.regenerationObligations).toEqual([])
  })

  it('discovers retention dependencies through provenance edges without ownership prefixes', () => {
    const retention = planner.plan({
      kind: 'retention',
      policyId: 'retention-test-v1',
      targets: [
        { targetTable: 'inbound_event_records', targetId: 'event-delete' },
        { targetTable: 'semantic_fact_repository_records', targetId: 'fact-provenance' },
      ],
    })

    expect(retention.authoritativeTargets).toEqual([
      { targetTable: 'inbound_event_records', targetId: 'event-delete' },
      { targetTable: 'semantic_fact_repository_records', targetId: 'fact-provenance' },
    ])
    expect(retention.derivedTargets).toEqual([
      { targetTable: 'semantic_fact_repository_records', targetId: 'fact-owned' },
      { targetTable: 'summary_repository_records', targetId: 'summary-shared' },
    ])
    expect(retention.regenerationObligations).toEqual([{ kind: 'summary', recordId: 'summary-shared', reason: 'retention', runnable: false }])
  })

  it('plans an empty retention closure when no authoritative events expire', () => {
    const retention = planner.plan({
      kind: 'retention',
      policyId: 'retention-test-v1',
      targets: [{ targetTable: 'semantic_fact_repository_records', targetId: 'fact-unrelated' }],
    })

    expect(retention.authoritativeTargets).toEqual([{ targetTable: 'semantic_fact_repository_records', targetId: 'fact-unrelated' }])
    expect(retention.derivedTargets).toEqual([])
    expect(retention.regenerationObligations).toEqual([])
  })
})
