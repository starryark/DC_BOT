/* eslint-disable style/max-statements-per-line, test/prefer-lowercase-title */
import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { MemoryError } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it } from 'vitest'

import { canonicalHash, executeIdempotently } from './idempotency.js'
import { migrate } from './migration-runner.js'
import { ReconciliationQueue, retryDelayMs } from './reconciliation-queue.js'
import { UnitOfWork } from './unit-of-work.js'

const databases: DatabaseSync[] = []
const at = (seconds: number): string => `2026-01-01T00:00:${String(seconds).padStart(2, '0')}.000Z`
function database(): DatabaseSync { const db = new SQLiteDatabase(':memory:'); databases.push(db); migrate(db); return db }
function input(jobId: string, priority = 0) { return { jobId, jobType: 'delivery_reconcile', dedupeKey: `dedupe-${jobId}`, payload: { privateContent: false, generationId: 'generation' }, priority, availableAt: at(0), maxAttempts: 2, createdAt: at(0) } as const }
afterEach(() => databases.splice(0).forEach(db => db.close()))

describe('IMP-207 unit of work and idempotency', () => {
  it('commits a source mutation, idempotency result, job, and evidence atomically', () => {
    const db = database(); const queue = new ReconciliationQueue(db, () => 'token')
    const result = new UnitOfWork(db).run(database => executeIdempotently(database, { namespace: 'source', key: 'safe-key', request: { b: 2, a: 1 }, createdAt: at(0) }, () => {
      database.prepare('INSERT INTO people(person_id,discord_user_id,created_at) VALUES (\'source\',\'1\',?)').run(at(0))
      queue.enqueue(input('job'))
      queue.appendEvidence({ evidenceId: 'evidence', jobId: 'job', kind: 'observation', evidence: { observed: 'locally-persisted' }, policyVersion: 'v1', actorId: 'process:test', recordedAt: at(0) })
      return { sourceId: 'source', jobId: 'job' }
    }))
    expect(result.result).toEqual({ sourceId: 'source', jobId: 'job' }); expect(result.deduplicated).toBe(false)
    expect(db.prepare('SELECT COUNT(*) count FROM people').get()).toEqual({ count: 1 }); expect(db.prepare('SELECT COUNT(*) count FROM worker_jobs').get()).toEqual({ count: 1 }); expect(db.prepare('SELECT COUNT(*) count FROM reconciliation_evidence_records').get()).toEqual({ count: 1 })
    const retry = new UnitOfWork(db).run(database => executeIdempotently(database, { namespace: 'source', key: 'safe-key', request: { a: 1, b: 2 }, createdAt: at(1) }, () => ({ sourceId: 'other', jobId: 'other' })))
    expect(retry).toEqual({ result: { sourceId: 'source', jobId: 'job' }, deduplicated: true })
  })

  it('rolls back at every injected checkpoint and preserves the original domain error', () => {
    for (const checkpoint of ['before_source', 'after_source', 'after_job'] as const) {
      const db = database(); const queue = new ReconciliationQueue(db); const failure = new MemoryError('UNAUTHORIZED_WRITE', checkpoint)
      expect(() => new UnitOfWork(db).run(database => executeIdempotently(database, { namespace: 'source', key: checkpoint, request: { checkpoint }, createdAt: at(0) }, () => {
        if (checkpoint === 'before_source')
          throw failure
        database.prepare('INSERT INTO people(person_id,discord_user_id,created_at) VALUES (\'source\',\'1\',?)').run(at(0))
        if (checkpoint === 'after_source')
          throw failure
        queue.enqueue(input('job'))
        throw failure
      }))).toThrow(failure)
      expect(db.prepare('SELECT COUNT(*) count FROM people').get()).toEqual({ count: 0 }); expect(db.prepare('SELECT COUNT(*) count FROM worker_jobs').get()).toEqual({ count: 0 }); expect(db.prepare('SELECT COUNT(*) count FROM idempotency_records').get()).toEqual({ count: 0 }); expect(db.prepare('SELECT COUNT(*) count FROM reconciliation_evidence_records').get()).toEqual({ count: 0 })
    }
  })

  it('rejects nested work and mismatched retries without changing durable state', () => {
    const db = database(); const uow = new UnitOfWork(db)
    expect(() => uow.run(() => uow.run(() => undefined))).toThrowError(/nested/)
    uow.run(database => executeIdempotently(database, { namespace: 'n', key: 'key', request: { value: 1 }, createdAt: at(0) }, () => ({ id: 'stable' })))
    expect(() => uow.run(database => executeIdempotently(database, { namespace: 'n', key: 'key', request: { value: 2 }, createdAt: at(1) }, () => ({ id: 'changed' })))).toThrowError(MemoryError)
    expect(db.prepare('SELECT request_hash,result_json FROM idempotency_records').get()).toEqual({ request_hash: canonicalHash({ value: 1 }), result_json: '{"id":"stable"}' })
    expect(JSON.stringify(db.prepare('SELECT idempotency_key,request_hash,result_json FROM idempotency_records').all())).not.toContain('private transcript')
  })

  it('rejects asynchronous callbacks and reports commit plus rollback failure honestly', () => {
    const db = database()
    expect(() => new UnitOfWork(db).run(() => Promise.resolve('external work'))).toThrowError(/synchronous and database-only/)

    const closing = new SQLiteDatabase(':memory:')
    expect(() => new UnitOfWork(closing).run(() => {
      closing.close()
      return 'cannot commit'
    })).toThrowError(/rollback also failed/)
  })
})

describe('IMP-207 durable reconciliation queue', () => {
  it('deduplicates exact enqueue, rejects payload mismatch, and reconstructs fields', () => {
    const db = database(); const queue = new ReconciliationQueue(db)
    const first = queue.enqueue(input('a', 7)); const retry = queue.enqueue({ ...input('different-id', 7), dedupeKey: 'dedupe-a' })
    expect(first.deduplicated).toBe(false); expect(retry.deduplicated).toBe(true); expect(retry.job.jobId).toBe('a'); expect(retry.job.priority).toBe(7)
    expect(() => queue.enqueue({ ...input('other'), dedupeKey: 'dedupe-a', payload: { changed: true } })).toThrowError(MemoryError)
    expect(queue.get('a')?.payload).toEqual({ generationId: 'generation', privateContent: false })
  })

  it('claims deterministically, excludes unavailable and terminal jobs, and lets poison work yield', () => {
    const db = database(); let token = 0; const queue = new ReconciliationQueue(db, () => `token-${++token}`)
    queue.enqueue(input('low', 0)); queue.enqueue(input('z-high', 5)); queue.enqueue(input('a-high', 5)); queue.enqueue({ ...input('future', 99), availableAt: at(20) })
    const first = queue.claim('worker', at(1), 5000)!; expect(first.jobId).toBe('a-high'); queue.deadLetter(first.jobId, first.leaseToken!, at(2), { code: 'POISON', diagnostic: 'safe classification' })
    const second = queue.claim('worker', at(2), 5000)!; expect(second.jobId).toBe('z-high'); queue.succeed(second.jobId, second.leaseToken!, at(3))
    expect(queue.claim('worker', at(3), 5000)?.jobId).toBe('low'); expect(queue.get('a-high')?.leaseToken).toBeUndefined(); expect(queue.get('z-high')?.leaseOwner).toBeUndefined()
  })

  it('fences stale consumers across expiry and same-name reclamation', () => {
    const db = database(); let token = 0; const queue = new ReconciliationQueue(db, () => `token-${++token}`); queue.enqueue(input('job'))
    const old = queue.claim('same-worker', at(0), 1000)!; expect(queue.claim('other', at(0), 1000)).toBeUndefined()
    const current = queue.claim('same-worker', at(2), 1000)!; expect(current.attemptCount).toBe(2); expect(current.leaseToken).not.toBe(old.leaseToken)
    expect(() => queue.succeed('job', old.leaseToken!, at(2))).toThrowError(MemoryError)
    expect(() => queue.retry('job', old.leaseToken!, at(2), { code: 'TEMP', diagnostic: 'safe' }, { baseMs: 10, maximumMs: 100, random: () => 0 })).toThrowError(MemoryError)
    expect(() => queue.deadLetter('job', old.leaseToken!, at(2), { code: 'OLD', diagnostic: 'safe' })).toThrowError(MemoryError)
    expect(queue.get('job')?.leaseToken).toBe(current.leaseToken); expect(queue.succeed('job', current.leaseToken!, at(2)).status).toBe('succeeded')
  })

  it('uses bounded deterministic retry and dead-letters exhausted attempts with redacted bounded diagnostics', () => {
    const db = database(); let token = 0; const queue = new ReconciliationQueue(db, () => `t-${++token}`); queue.enqueue(input('job'))
    const first = queue.claim('worker', at(0), 5000)!; const ready = queue.retry('job', first.leaseToken!, at(1), { code: 'TRANSIENT', diagnostic: `${'x'.repeat(700)}\nsecret-like-line` }, { baseMs: 100, maximumMs: 1000, random: () => 0.5 })
    expect(ready.status).toBe('ready'); expect(Date.parse(ready.availableAt) - Date.parse(at(1))).toBe(50); expect(ready.lastErrorRedacted?.length).toBe(512); expect(ready.leaseToken).toBeUndefined()
    const second = queue.claim('worker', at(2), 5000)!; const dead = queue.retry('job', second.leaseToken!, at(3), { code: 'EXHAUSTED', diagnostic: 'classification only' }, { baseMs: 100, maximumMs: 1000, random: () => 0 })
    expect(dead.status).toBe('dead_letter'); expect(dead.attemptCount).toBe(2); expect(dead.leaseOwner).toBeUndefined(); expect(retryDelayMs(1000, 100, 1000, () => 0.999)).toBeLessThanOrEqual(1000)
  })

  it('appends deterministic reconciliation observations and decisions', () => {
    const db = database(); const queue = new ReconciliationQueue(db); queue.enqueue(input('job'))
    queue.appendEvidence({ evidenceId: 'one', jobId: 'job', kind: 'observation', evidence: { receiptKnown: false }, policyVersion: 'delivery-v1', actorId: 'process:reconciler', recordedAt: at(1) })
    queue.appendEvidence({ evidenceId: 'two', jobId: 'job', kind: 'decision', evidence: { outcome: 'unknown' }, policyVersion: 'delivery-v1', actorId: 'process:reconciler', recordedAt: at(2) })
    expect(db.prepare('SELECT evidence_id,evidence_kind,policy_version,actor_id,ordinal FROM reconciliation_evidence_records ORDER BY ordinal').all()).toEqual([{ evidence_id: 'one', evidence_kind: 'observation', policy_version: 'delivery-v1', actor_id: 'process:reconciler', ordinal: 0 }, { evidence_id: 'two', evidence_kind: 'decision', policy_version: 'delivery-v1', actor_id: 'process:reconciler', ordinal: 1 }])
    expect(() => db.prepare('UPDATE reconciliation_evidence_records SET evidence_json=\'{}\' WHERE evidence_id=\'one\'').run()).toThrow(/append-only/)
  })
})
