import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DerivedRepairQueue, LEXICAL_REPAIR_JOB_TYPE } from './derived-repair.js'
import { migrate } from './migration-runner.js'
import { ReconciliationQueue } from './reconciliation-queue.js'

const at = (seconds: number): string => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`

describe('iMP-608 derived repair queue', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    migrate(db)
  })

  afterEach(() => db.close())

  it('isolates derived claims from unrelated reconciliation work', () => {
    const generic = new ReconciliationQueue(db)
    generic.enqueue({ jobId: 'delivery', jobType: 'delivery_reconcile', dedupeKey: 'delivery', payload: { generationId: 'generation-a' }, priority: 100, availableAt: at(0), createdAt: at(0), maxAttempts: 2 })
    const derived = new DerivedRepairQueue(db, () => 'derived-token')
    derived.enqueueLexicalRepair({ jobId: 'repair', dedupeKey: 'repair', reason: 'repair', policyVersion: 'lexical-v1', availableAt: at(0), createdAt: at(0), maxAttempts: 2 })

    expect(derived.claim('derived-worker', at(0), 1000)?.jobId).toBe('repair')
    expect(generic.get('delivery')?.status).toBe('ready')
  })

  it('deduplicates canonical payloads and rejects mismatched reuse', () => {
    const derived = new DerivedRepairQueue(db)
    const input = { jobId: 'repair', dedupeKey: 'repair-key', reason: 'repair' as const, policyVersion: 'lexical-v1', availableAt: at(0), createdAt: at(0), maxAttempts: 2 }

    expect(derived.enqueueLexicalRepair(input).deduplicated).toBe(false)
    expect(derived.enqueueLexicalRepair({ ...input, jobId: 'other-id' }).deduplicated).toBe(true)
    expect(() => derived.enqueueLexicalRepair({ ...input, jobId: 'mismatch', reason: 'correction' })).toThrow('different canonical payload')
  })

  it('reclaims expired derived leases and fences stale consumers', () => {
    let token = 0
    const derived = new DerivedRepairQueue(db, () => `token-${++token}`)
    derived.enqueueLexicalRepair({ jobId: 'repair', dedupeKey: 'repair', reason: 'repair', policyVersion: 'lexical-v1', availableAt: at(0), createdAt: at(0), maxAttempts: 3 })
    const stale = derived.claim('worker', at(0), 1000)!
    const current = derived.claim('worker', at(2), 1000)!
    const generic = new ReconciliationQueue(db)

    expect(current.attemptCount).toBe(2)
    expect(() => generic.succeed('repair', stale.leaseToken!, at(2))).toThrow('stale')
    expect(generic.succeed('repair', current.leaseToken!, at(2)).status).toBe('succeeded')
  })

  it('executes tombstone-safe lexical repair with content-free payload and evidence only', () => {
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO semantic_fact_repository_records(fact_id,scope_kind,scope_id,predicate,value,confidence,tombstoned_by,valid_from,recorded_at,provenance_source,extraction_method,stated_at,input_hash)
      VALUES ('fact-deleted','logical_room','room-a','secret','memory content must not enter queue',1,'forget-a','2026-01-01','2026-01-01','userStated','explicitCommand','2026-01-01','fact-hash');
      INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,idempotency_key)
      VALUES ('forget-a','person','person-a','{}','2026-01-01','processing',1,'forget-a');
      INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,evidence_json)
      VALUES ('tombstone-a','forget-a','semantic_fact_repository_records','fact-deleted','verified','2026-01-01','{}');
      INSERT INTO memory_search_latin(text_content,auth_scope,target_table,target_id)
      VALUES ('memory content must not enter queue',hex('logical_room:room-a'),'semantic_fact_repository_records','fact-deleted');
      PRAGMA foreign_keys=ON;
    `)
    const derived = new DerivedRepairQueue(db, () => 'lease-token')
    const enqueued = derived.enqueueLexicalRepair({ jobId: 'repair', dedupeKey: 'repair', reason: 'repair', policyVersion: 'lexical-v1', availableAt: at(0), createdAt: at(0), maxAttempts: 2 })
    const completed = derived.executeNext({ worker: 'derived-worker', now: at(1), leaseMs: 5000, evidenceId: 'evidence-a', actorId: 'process:derived-repair', policyVersion: 'lexical-v1', retryBaseMs: 10, retryMaximumMs: 100, random: () => 0 })

    expect(enqueued.job.payload).toEqual({ operation: 'rebuild_lexical_search', policyVersion: 'lexical-v1', reason: 'repair' })
    expect(completed?.status).toBe('succeeded')
    expect(db.prepare('SELECT count(*) count FROM memory_search_latin WHERE target_id=\'fact-deleted\'').get()).toEqual({ count: 0 })
    const operationalBytes = JSON.stringify({ jobs: db.prepare('SELECT job_type,dedupe_key,payload_json,last_error_redacted FROM worker_jobs').all(), evidence: db.prepare('SELECT evidence_json,policy_version,actor_id FROM reconciliation_evidence_records').all() })
    expect(operationalBytes).not.toContain('memory content must not enter queue')
    expect(db.prepare('SELECT count(*) count FROM worker_jobs WHERE job_type IN (\'summary_regenerate\',\'vector_rebuild\',\'graph_rebuild\')').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT job_type FROM worker_jobs').get()).toEqual({ job_type: LEXICAL_REPAIR_JOB_TYPE })
  })
})
