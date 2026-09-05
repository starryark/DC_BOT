import type { DatabaseSync } from 'node:sqlite'

import type { RetentionPolicy } from './repositories/privacy.js'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deletionCompletenessReport } from './deletion-completeness.js'
import { LEXICAL_REPAIR_JOB_TYPE } from './derived-repair.js'
import { migrate } from './migration-runner.js'
import { PrivacyRepository } from './repositories/privacy.js'
import { SearchRepository } from './repositories/search.js'

// Deterministic test time. All fixture rows are written relative to this
// instant so boundary behavior is exact, not wall-clock dependent.
const NOW = '2026-08-16T00:00:00.000Z'
const DAY = 86_400_000

function ago(days: number, ms = 0): string {
  return new Date(Date.parse(NOW) - days * DAY - ms).toISOString()
}

function policy(rules: RetentionPolicy['rules'], version = 1): RetentionPolicy {
  return { policyId: 'retention-test-v1', version, rules }
}

describe('retention lifecycle', () => {
  let db: DatabaseSync
  let privacy: PrivacyRepository

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    migrate(db)
    privacy = new PrivacyRepository(db)
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO inbound_event_records(event_id,logical_room_id,idempotency_key,event_kind,actor_kind,actor_json,author_person_id,physical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash) VALUES
        ('event-expired','room-a','key-a','user_text','attributed','{}','person-a','physical-a',1,'${ago(40)}','${ago(40)}','{"content":"expired source text"}','transcript','hash-a'),
        ('event-boundary','room-a','key-b','user_text','attributed','{}','person-a','physical-a',2,'${ago(30)}','${ago(30)}','{"content":"boundary source text"}','transcript','hash-b'),
        ('event-young','room-a','key-c','user_text','attributed','{}','person-a','physical-a',3,'${ago(30, -1)}','${ago(30, -1)}','{"content":"young source text"}','transcript','hash-c'),
        ('event-other-room','room-b','key-d','user_text','attributed','{}','person-b','physical-b',1,'${ago(40)}','${ago(40)}','{"content":"other room text"}','transcript','hash-d'),
        ('event-command','room-a','key-e','command','attributed','{}','person-a','physical-a',4,'${ago(40)}','${ago(40)}','{"content":"Remember x: y"}','command','hash-e');
      INSERT INTO summary_repository_records(summary_id,logical_room_id,text,model_ref,stale,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash) VALUES
        ('summary-shared','room-a','shared summary of expired and young sources','model',0,'${ago(5)}','${ago(5)}','derived','summarization','${ago(5)}','summary-hash'),
        ('summary-aged-stale','room-a','aged stale summary','model',1,'${ago(35)}','${ago(35)}','derived','summarization','${ago(35)}','summary-stale-hash'),
        ('summary-young','room-a','young summary','model',0,'${ago(5)}','${ago(5)}','derived','summarization','${ago(5)}','summary-young-hash');
      INSERT INTO summary_source_event_records VALUES
        ('summary-shared','event-expired',0),('summary-shared','event-young',1),
        ('summary-young','event-young',0),
        ('summary-aged-stale','event-young',0);
      INSERT INTO semantic_fact_repository_records(fact_id,person_id,scope_kind,scope_id,predicate,value,confidence,supersedes,superseded_by,tombstoned_by,valid_from,valid_until,recorded_at,provenance_source,extraction_method,stated_at,input_hash) VALUES
        ('fact-current','person-a','logical_room','room-a','likes','current value',1,NULL,NULL,NULL,'${ago(5)}',NULL,'${ago(5)}','userStated','explicitCommand','${ago(5)}','fact-current-hash'),
        ('fact-superseded-prior','person-a','logical_room','room-a','likes','old value',1,NULL,'fact-current',NULL,'${ago(40)}','${ago(5)}','${ago(40)}','userStated','explicitCommand','${ago(40)}','fact-prior-hash'),
        ('fact-aged','person-a','logical_room','room-a','hates','aged value',1,NULL,NULL,NULL,'${ago(40)}',NULL,'${ago(40)}','userStated','explicitCommand','${ago(40)}','fact-aged-hash');
      INSERT INTO episodic_repository_records(episodic_id,person_id,logical_room_id,occurred_at,summary,tombstoned_by,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash) VALUES
        ('episodic-aged','person-a','room-a','${ago(40)}','aged episode',NULL,'${ago(40)}','${ago(40)}','derived','llmExtraction','${ago(40)}','episodic-aged-hash');
      INSERT INTO memory_source_event_records VALUES ('semantic','fact-aged','event-expired',0);
      INSERT INTO generation_attempt_records(generation_id,idempotency_key,logical_room_id,character_id,current_state,observed_room_version,context_manifest_hash,observed_binding_version,captured_at,model_ref,started_at,input_hash) VALUES
        ('generation-aged','generation-key','room-a','character-a','persisted',1,'manifest',1,'${ago(40)}','model','${ago(40)}','generation-hash');
      INSERT INTO generation_causal_edges VALUES ('generation-aged','event-expired','trigger');
      INSERT INTO output_segment_records VALUES ('segment-aged','generation-aged',0,'text','aged bot output','output-hash');
      INSERT INTO delivery_attempt_records(delivery_id,segment_id,transport,destination_id,idempotency_key,attempt_number,current_state,current_evidence_json,started_at,last_transition_at,input_hash) VALUES
        ('delivery-aged','segment-aged','discord_text','channel-a','delivery-key',1,'delivered','{}','${ago(40)}','${ago(40)}','delivery-hash');
      PRAGMA foreign_keys=ON;
    `)
  })

  afterEach(() => db.close())

  it('expires records at the exact boundary and retains everything younger', () => {
    const result = privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)

    // A global event rule covers every room and every retention class:
    // event-expired (40d), event-boundary (exactly 30d), event-command (40d),
    // and event-other-room (40d) expire. event-young (30d minus 1ms) survives.
    expect(result.authoritative).toBe(4)
    expect(db.prepare('SELECT payload_json FROM inbound_event_records WHERE event_id=\'event-expired\'').get()).toEqual({ payload_json: '{"redacted":true}' })
    expect(db.prepare('SELECT payload_json FROM inbound_event_records WHERE event_id=\'event-boundary\'').get()).toEqual({ payload_json: '{"redacted":true}' })
    expect(db.prepare('SELECT json_extract(payload_json,\'$.content\') content FROM inbound_event_records WHERE event_id=\'event-young\'').get()).toEqual({ content: 'young source text' })
    // The young shared summary was invalidated because an expired source member is gone.
    expect(db.prepare('SELECT stale,tombstoned_by FROM summary_repository_records WHERE summary_id=\'summary-shared\'').get()).toEqual({ stale: 1, tombstoned_by: 'retention-a' })
    expect(db.prepare('SELECT stale,tombstoned_by FROM summary_repository_records WHERE summary_id=\'summary-young\'').get()).toEqual({ stale: 0, tombstoned_by: null })
  })

  it('isolates scope: a room-scoped rule leaves other rooms untouched', () => {
    privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY, logicalRoomId: 'room-a' }]), NOW)

    expect(db.prepare('SELECT json_extract(payload_json,\'$.content\') content FROM inbound_event_records WHERE event_id=\'event-other-room\'').get()).toEqual({ content: 'other room text' })
  })

  it('handles facts, stale summaries, episodic records, and delivered output by age', () => {
    const result = privacy.applyRetention('retention-a', policy([
      { targetTable: 'semantic_fact_repository_records', maxAgeMs: 30 * DAY },
      { targetTable: 'summary_repository_records', maxAgeMs: 30 * DAY },
      { targetTable: 'episodic_repository_records', maxAgeMs: 30 * DAY },
      { targetTable: 'output_segment_records', maxAgeMs: 30 * DAY },
    ]), NOW)

    // Aged: fact-superseded-prior, fact-aged, summary-aged-stale, episodic-aged, segment-aged.
    // Young: fact-current, summary-young. fact-aged is also edge-discovered from
    // event-expired but is authoritative here, so it is removed exactly once.
    expect(result.authoritative).toBe(5)
    expect(result.obligations).toBe(5)
    expect(db.prepare('SELECT tombstoned_by FROM semantic_fact_repository_records WHERE fact_id=\'fact-superseded-prior\'').get()).toEqual({ tombstoned_by: 'retention-a' })
    expect(db.prepare('SELECT tombstoned_by FROM semantic_fact_repository_records WHERE fact_id=\'fact-current\'').get()).toEqual({ tombstoned_by: null })
    expect(db.prepare('SELECT tombstoned_by FROM summary_repository_records WHERE summary_id=\'summary-aged-stale\'').get()).toEqual({ tombstoned_by: 'retention-a' })
    expect(db.prepare('SELECT tombstoned_by FROM episodic_repository_records WHERE episodic_id=\'episodic-aged\'').get()).toEqual({ tombstoned_by: 'retention-a' })
    expect(db.prepare('SELECT exact_text FROM output_segment_records WHERE segment_id=\'segment-aged\'').get()).toEqual({ exact_text: '' })
    expect(db.prepare('SELECT text FROM summary_repository_records WHERE summary_id=\'summary-young\'').get()).toEqual({ text: 'young summary' })
  })

  it('is idempotent: same request deduplicates, and a fresh request finds nothing left', () => {
    const first = privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)
    const retry = privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)
    const second = privacy.applyRetention('retention-b', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)

    expect(first.deduplicated).toBe(false)
    expect(retry).toEqual({ retentionRequestId: 'retention-a', policyId: 'retention-test-v1', authoritative: first.authoritative, derived: first.derived, obligations: first.obligations, deduplicated: true })
    expect(second).toEqual({ retentionRequestId: 'retention-b', policyId: 'retention-test-v1', authoritative: 0, derived: 0, obligations: 0, deduplicated: false })
  })

  it('enqueues a content-free lexical repair job with the retention reason', () => {
    privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)

    const job = db.prepare('SELECT job_type,dedupe_key,payload_json FROM worker_jobs WHERE job_id=?').get('lexical:retention-a') as { job_type: string, dedupe_key: string, payload_json: string }
    expect(job.job_type).toBe(LEXICAL_REPAIR_JOB_TYPE)
    expect(job.dedupe_key).toBe('retention:retention-a')
    expect(JSON.parse(job.payload_json)).toEqual({ operation: 'rebuild_lexical_search', policyVersion: 'retention:retention-test-v1:v1', reason: 'retention' })
  })

  it('cannot serve expired content through lexical search after retention', () => {
    const before = new SearchRepository(db).searchMemory({ query: 'expired', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: 'room-a' }, limit: 10 })
    expect(before.hits.length).toBeGreaterThan(0)

    privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)

    expect(new SearchRepository(db).searchMemory({ query: 'expired', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: 'room-a' }, limit: 10 }).hits).toEqual([])
    expect(new SearchRepository(db).searchMemory({ query: 'young', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: 'room-a' }, limit: 10 }).hits.length).toBeGreaterThan(0)
  })

  it('rolls back the request and all mutations when verification is defeated', () => {
    // The defeating trigger replaces the whole payload, clearing the redaction
    // marker itself; merely adding content beside the flag would still verify,
    // because event redaction is defined by the marker.
    db.exec('CREATE TRIGGER defeat_retention AFTER UPDATE ON inbound_event_records BEGIN UPDATE inbound_event_records SET payload_json=json_object(\'content\',\'resurrected\') WHERE event_id=new.event_id; END')

    expect(() => privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)).toThrow('deletion verification failed')
    expect(db.prepare('SELECT count(*) count FROM forget_requests').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT count(*) count FROM deletion_tombstones').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT json_extract(payload_json,\'$.content\') content FROM inbound_event_records WHERE event_id=\'event-expired\'').get()).toEqual({ content: 'expired source text' })
    expect(db.prepare('SELECT count(*) count FROM worker_jobs').get()).toEqual({ count: 0 })
  })

  it('applies a changed policy version to newly expired records only', () => {
    privacy.applyRetention('retention-a', policy([{ targetTable: 'semantic_fact_repository_records', maxAgeMs: 30 * DAY }]), NOW)

    const unchanged = privacy.applyRetention('retention-b', policy([{ targetTable: 'semantic_fact_repository_records', maxAgeMs: 30 * DAY }], 2), NOW)
    expect(unchanged.authoritative).toBe(0)

    // Shortening the duration under a new version schedules removal for
    // records that only now cross the expiry boundary.
    const tightened = privacy.applyRetention('retention-c', policy([{ targetTable: 'semantic_fact_repository_records', maxAgeMs: 3 * DAY }], 3), NOW)
    expect(tightened.authoritative).toBe(1)
    expect(db.prepare('SELECT tombstoned_by FROM semantic_fact_repository_records WHERE fact_id=\'fact-current\'').get()).toEqual({ tombstoned_by: 'retention-c' })
  })

  it('rejects invalid and overlapping policies without opening a transaction', () => {
    expect(() => privacy.applyRetention('retention-a', { policyId: '', version: 1, rules: [{ targetTable: 'inbound_event_records', maxAgeMs: DAY }] }, NOW)).toThrow('content-free and bounded')
    expect(() => privacy.applyRetention('retention-a', policy([{ targetTable: 'summary_repository_records', maxAgeMs: DAY }, { targetTable: 'summary_repository_records', maxAgeMs: 2 * DAY }]), NOW)).toThrow('must not overlap')
    expect(() => privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: DAY, retentionClass: 'nope' as 'transcript' }]), NOW)).toThrow('unknown event retention class')
    expect(db.prepare('SELECT count(*) count FROM forget_requests').get()).toEqual({ count: 0 })
  })

  it('rides the forget ledger so obligations replay into restored backups and completeness enumerates every class', () => {
    privacy.applyRetention('retention-a', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]), NOW)

    const request = db.prepare('SELECT subject_type,subject_id,scope_json,status FROM forget_requests WHERE forget_request_id=\'retention-a\'').get() as { subject_type: string, subject_id: string, scope_json: string, status: string }
    expect(request.subject_type).toBe('time_range')
    expect(request.subject_id).toBe('retention-test-v1')
    // The stored scope is labels, a count, and the operation digest — the digest
    // is what a retry is checked against, and it carries no subject content.
    expect(JSON.parse(request.scope_json)).toEqual({ policyId: 'retention-test-v1', policyVersion: 1, rules: 1, policyDigest: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(request.status).toBe('completed')

    const report = deletionCompletenessReport(db)
    expect(report.verifiedObligations).toEqual({ requests: 1, tombstones: 7, passed: true })
    expect(report.lexicalIndexConsistent).toBe(true)
    expect(report.optionalStoresAbsent).toBe(true)
    const dispositions = new Map(report.classes.map(item => [item.storageClass, item.disposition]))
    expect(dispositions.size).toBeGreaterThanOrEqual(16)
    expect(dispositions.get('inbound-subject-events')).toBe('redact-on-deletion')
    expect(dispositions.get('summaries')).toBe('tombstone-on-deletion')
    expect(dispositions.get('vector-and-graph-stores')).toBe('feature-absent')
  })
})

/**
 * One idempotency key represents one immutable retention operation.
 *
 * The ledger row is the operation. A retry that supplies a different policy is
 * not the same operation, and answering it out of the stored row would report a
 * policy that was never applied — the one failure mode a deduplicating
 * destructive operation must not have.
 */
describe('retention policy identity', () => {
  let db: DatabaseSync
  let privacy: PrivacyRepository

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    migrate(db)
    privacy = new PrivacyRepository(db)
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO inbound_event_records(event_id,logical_room_id,idempotency_key,event_kind,actor_kind,actor_json,author_person_id,physical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash) VALUES
        ('event-expired','room-a','key-a','user_text','attributed','{}','person-a','physical-a',1,'${ago(40)}','${ago(40)}','{"content":"expired source text"}','transcript','hash-a'),
        ('event-other-room','room-b','key-d','user_text','attributed','{}','person-b','physical-b',1,'${ago(40)}','${ago(40)}','{"content":"other room text"}','transcript','hash-d');
      PRAGMA foreign_keys=ON;
    `)
  })

  afterEach(() => db.close())

  const base: RetentionPolicy['rules'] = [{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }]

  it('deduplicates a retry that is byte-for-byte the same operation', () => {
    const first = privacy.applyRetention('retention-a', policy(base), NOW)
    const retry = privacy.applyRetention('retention-a', policy(base), NOW)

    expect(first.deduplicated).toBe(false)
    expect(retry).toEqual({ ...first, deduplicated: true })
  })

  it('deduplicates a retry whose rules are supplied in a different order', () => {
    const rules: RetentionPolicy['rules'] = [
      { targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY, logicalRoomId: 'room-a' },
      { targetTable: 'summary_repository_records', maxAgeMs: 30 * DAY },
    ]
    const first = privacy.applyRetention('retention-a', policy(rules), NOW)
    const retry = privacy.applyRetention('retention-a', policy([rules[1]!, rules[0]!]), NOW)

    expect(retry).toEqual({ ...first, deduplicated: true })
  })

  it.each([
    ['a different policy id', { policyId: 'retention-test-v2', version: 1, rules: base }],
    ['a different version', { policyId: 'retention-test-v1', version: 2, rules: base }],
    ['a changed duration', { policyId: 'retention-test-v1', version: 1, rules: [{ targetTable: 'inbound_event_records' as const, maxAgeMs: 3 * DAY }] }],
    ['a different target table', { policyId: 'retention-test-v1', version: 1, rules: [{ targetTable: 'summary_repository_records' as const, maxAgeMs: 30 * DAY }] }],
    ['a narrowed room scope', { policyId: 'retention-test-v1', version: 1, rules: [{ targetTable: 'inbound_event_records' as const, maxAgeMs: 30 * DAY, logicalRoomId: 'room-a' }] }],
    ['a narrowed retention class', { policyId: 'retention-test-v1', version: 1, rules: [{ targetTable: 'inbound_event_records' as const, maxAgeMs: 30 * DAY, retentionClass: 'transcript' as const }] }],
    ['an added rule', { policyId: 'retention-test-v1', version: 1, rules: [...base, { targetTable: 'episodic_repository_records' as const, maxAgeMs: 30 * DAY }] }],
  ])('refuses to answer a retry carrying %s out of the stored operation', (_label, changed: RetentionPolicy) => {
    const first = privacy.applyRetention('retention-a', policy(base), NOW)

    expect(() => privacy.applyRetention('retention-a', changed, NOW)).toThrow('different retention operation')
    // The stored operation is untouched: no second ledger row, no new tombstone.
    expect(db.prepare('SELECT count(*) count FROM forget_requests').get()).toEqual({ count: 1 })
    expect(db.prepare('SELECT count(*) count FROM deletion_tombstones').get()).toEqual({ count: first.obligations })
  })

  it('lets a different request id apply a newer policy version as a real retention pass', () => {
    privacy.applyRetention('retention-a', policy(base), NOW)
    const next = privacy.applyRetention('retention-b', policy([{ targetTable: 'inbound_event_records', maxAgeMs: 0 }], 2), NOW)

    expect(next.deduplicated).toBe(false)
    expect(db.prepare('SELECT count(*) count FROM forget_requests').get()).toEqual({ count: 2 })
  })

  it('refuses to answer a retention retry out of a subject forget that reused the key', () => {
    // forget_requests carries both operations under one unique idempotency key,
    // so an unchecked retry would report a retention pass that never ran.
    privacy.forget('shared-key', 'person-a', 'room-a', NOW)

    expect(() => privacy.applyRetention('shared-key', policy(base), NOW)).toThrow('different retention operation')
  })

  it('refuses to answer a subject forget out of a retention pass that reused the key', () => {
    privacy.applyRetention('shared-key', policy(base), NOW)

    expect(() => privacy.forget('shared-key', 'person-a', 'room-a', NOW)).toThrow('different forget operation')
  })

  it('refuses to answer a subject forget for one person out of another person\'s completed request', () => {
    privacy.forget('forget-a', 'person-a', 'room-a', NOW)

    expect(() => privacy.forget('forget-a', 'person-b', 'room-a', NOW)).toThrow('different forget operation')
    expect(() => privacy.forget('forget-a', 'person-a', 'room-b', NOW)).toThrow('different forget operation')
  })
})
