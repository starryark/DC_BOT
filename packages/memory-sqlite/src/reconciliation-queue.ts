import type { DatabaseSync } from 'node:sqlite'

import type { CanonicalValue } from './idempotency.js'

import { randomUUID } from 'node:crypto'

import { MemoryError } from '@proj-airi/memory-domain'

import { canonicalHash, canonicalJson } from './idempotency.js'
import { UnitOfWork } from './unit-of-work.js'

export type JobStatus = 'ready' | 'leased' | 'succeeded' | 'dead_letter' | 'cancelled'
export interface ReconciliationJob { readonly jobId: string, readonly jobType: string, readonly dedupeKey: string, readonly payload: CanonicalValue, readonly status: JobStatus, readonly priority: number, readonly availableAt: string, readonly leaseOwner?: string, readonly leaseExpiresAt?: string, readonly leaseToken?: string, readonly attemptCount: number, readonly maxAttempts: number, readonly lastErrorCode?: string, readonly lastErrorRedacted?: string, readonly createdAt: string, readonly completedAt?: string }
export interface EnqueueJobInput { readonly jobId: string, readonly jobType: string, readonly dedupeKey: string, readonly payload: CanonicalValue, readonly priority?: number, readonly availableAt: string, readonly maxAttempts: number, readonly createdAt: string }
export interface QueueFailure { readonly code: string, readonly diagnostic: string }

type Row = Record<string, string | number | null>

function timestamp(value: string, field: string): string {
  if (!value || !Number.isFinite(Date.parse(value)))
    throw new MemoryError('INVALID_TIMESTAMP', `${field} must be an ISO timestamp`)
  return value
}

function boundedDiagnostic(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 512)
}

function job(row: Row): ReconciliationJob {
  let payload: CanonicalValue
  try {
    payload = JSON.parse(String(row.payload_json)) as CanonicalValue
  }
  catch (error) {
    throw new MemoryError('INVALID_PAYLOAD', 'durable reconciliation payload is malformed', { cause: error })
  }
  return Object.freeze({ jobId: String(row.job_id), jobType: String(row.job_type), dedupeKey: String(row.dedupe_key), payload, status: String(row.status) as JobStatus, priority: Number(row.priority), availableAt: String(row.available_at), ...(row.lease_owner == null ? {} : { leaseOwner: String(row.lease_owner) }), ...(row.lease_expires_at == null ? {} : { leaseExpiresAt: String(row.lease_expires_at) }), ...(row.lease_token == null ? {} : { leaseToken: String(row.lease_token) }), attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts), ...(row.last_error_code == null ? {} : { lastErrorCode: String(row.last_error_code) }), ...(row.last_error_redacted == null ? {} : { lastErrorRedacted: String(row.last_error_redacted) }), createdAt: String(row.created_at), ...(row.completed_at == null ? {} : { completedAt: String(row.completed_at) }) })
}

/** Full-jitter exponential retry delay, clamped before exponentiation to avoid overflow. */
export function retryDelayMs(attempt: number, baseMs: number, maximumMs: number, random: () => number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(baseMs) || baseMs < 0 || !Number.isSafeInteger(maximumMs) || maximumMs < baseMs)
    throw new MemoryError('INVALID_PAYLOAD', 'invalid retry backoff inputs')
  const ceiling = Math.min(maximumMs, baseMs * 2 ** Math.min(attempt - 1, 52))
  const sample = random()
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1)
    throw new MemoryError('INVALID_PAYLOAD', 'random sample must be in [0,1)')
  return Math.floor(sample * (ceiling + 1))
}

/** Durable persistence primitives for later reconciliation workers; this class never performs external work. */
export class ReconciliationQueue {
  constructor(private readonly db: DatabaseSync, private readonly id: () => string = randomUUID) {}

  enqueue(input: EnqueueJobInput): { job: ReconciliationJob, deduplicated: boolean } {
    if (!input.jobId || !input.jobType || !input.dedupeKey)
      throw new MemoryError('INVALID_PAYLOAD', 'job identity fields are required')
    if (!Number.isSafeInteger(input.priority ?? 0) || !Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1)
      throw new MemoryError('INVALID_PAYLOAD', 'priority and max attempts must be safe integers')
    timestamp(input.availableAt, 'availableAt')
    timestamp(input.createdAt, 'createdAt')
    const payloadJson = canonicalJson(input.payload)
    const payloadHash = canonicalHash(input.payload)
    const prior = this.db.prepare('SELECT * FROM worker_jobs WHERE job_type=? AND dedupe_key=?').get(input.jobType, input.dedupeKey) as Row | undefined
    if (prior) {
      if (prior.payload_hash !== payloadHash)
        throw new MemoryError('POLICY_VIOLATION', 'job identity was reused with a different canonical payload')
      return { job: job(prior), deduplicated: true }
    }
    try {
      this.db.prepare(`INSERT INTO worker_jobs(job_id,job_type,dedupe_key,payload_json,payload_hash,status,priority,available_at,attempt_count,max_attempts,created_at) VALUES (?,?,?,?,?,'ready',?,?,0,?,?)`).run(input.jobId, input.jobType, input.dedupeKey, payloadJson, payloadHash, input.priority ?? 0, input.availableAt, input.maxAttempts, input.createdAt)
    }
    catch (error) {
      const concurrent = this.db.prepare('SELECT * FROM worker_jobs WHERE job_type=? AND dedupe_key=?').get(input.jobType, input.dedupeKey) as Row | undefined
      if (!concurrent)
        throw new MemoryError('PERSISTENCE_FAILED', 'reconciliation enqueue failed', { cause: error })
      if (concurrent.payload_hash !== payloadHash)
        throw new MemoryError('POLICY_VIOLATION', 'job identity was reused with a different canonical payload')
      return { job: job(concurrent), deduplicated: true }
    }
    return { job: this.get(input.jobId)!, deduplicated: false }
  }

  get(jobId: string): ReconciliationJob | undefined {
    const row = this.db.prepare('SELECT * FROM worker_jobs WHERE job_id=?').get(jobId) as Row | undefined
    return row ? job(row) : undefined
  }

  claim(worker: string, now: string, leaseMs: number, jobTypes?: readonly string[]): ReconciliationJob | undefined {
    if (!worker || !Number.isSafeInteger(leaseMs) || leaseMs < 1)
      throw new MemoryError('INVALID_PAYLOAD', 'worker and positive lease duration are required')
    if (jobTypes?.some(jobType => !jobType))
      throw new MemoryError('INVALID_PAYLOAD', 'claimed job types must be non-empty')
    if (jobTypes?.length === 0)
      return undefined
    timestamp(now, 'now')
    const expires = new Date(Math.min(Date.parse(now) + leaseMs, 8640000000000000)).toISOString()
    const token = this.id()
    return new UnitOfWork(this.db).run((database) => {
      const typeFilter = jobTypes == null ? '' : ` AND job_type IN (${jobTypes.map(() => '?').join(',')})`
      const claimed = database.prepare(`UPDATE worker_jobs SET status='leased',lease_owner=?,lease_expires_at=?,lease_token=?,attempt_count=attempt_count+1 WHERE job_id=(SELECT job_id FROM worker_jobs WHERE ((status='ready' AND available_at<=?) OR (status='leased' AND lease_expires_at<=?))${typeFilter} ORDER BY priority DESC,available_at,job_id LIMIT 1) RETURNING *`).get(worker, expires, token, now, now, ...(jobTypes ?? [])) as Row | undefined
      return claimed ? job(claimed) : undefined
    })
  }

  succeed(jobId: string, token: string, now: string): ReconciliationJob { return this.transition(jobId, token, now, 'succeeded') }
  cancel(jobId: string, token: string, now: string, failure?: QueueFailure): ReconciliationJob { return this.transition(jobId, token, now, 'cancelled', failure) }
  deadLetter(jobId: string, token: string, now: string, failure: QueueFailure): ReconciliationJob { return this.transition(jobId, token, now, 'dead_letter', failure) }

  retry(jobId: string, token: string, now: string, failure: QueueFailure, options: { baseMs: number, maximumMs: number, random: () => number }): ReconciliationJob {
    const current = this.requireCurrentLease(jobId, token, now)
    if (current.attemptCount >= current.maxAttempts)
      return this.deadLetter(jobId, token, now, failure)
    const delay = retryDelayMs(current.attemptCount, options.baseMs, options.maximumMs, options.random)
    const availableAt = new Date(Math.min(Date.parse(now) + delay, 8640000000000000)).toISOString()
    const result = this.db.prepare(`UPDATE worker_jobs SET status='ready',available_at=?,lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,last_error_code=?,last_error_redacted=? WHERE job_id=? AND status='leased' AND lease_token=? AND lease_expires_at>?`).run(availableAt, failure.code, boundedDiagnostic(failure.diagnostic), jobId, token, now)
    if (result.changes !== 1)
      throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'lease is stale and cannot retry the job')
    return this.get(jobId)!
  }

  appendEvidence(input: { evidenceId: string, jobId: string, kind: 'observation' | 'decision', evidence: CanonicalValue, policyVersion: string, actorId: string, recordedAt: string }): void {
    if (!input.evidenceId || !input.policyVersion || !input.actorId)
      throw new MemoryError('INVALID_PAYLOAD', 'evidence identity, policy, and actor are required')
    timestamp(input.recordedAt, 'recordedAt')
    const ordinal = Number((this.db.prepare('SELECT COALESCE(MAX(ordinal),-1)+1 ordinal FROM reconciliation_evidence_records WHERE job_id=?').get(input.jobId) as { ordinal: number }).ordinal)
    this.db.prepare('INSERT INTO reconciliation_evidence_records(evidence_id,job_id,evidence_kind,evidence_json,policy_version,actor_id,recorded_at,ordinal) VALUES (?,?,?,?,?,?,?,?)').run(input.evidenceId, input.jobId, input.kind, canonicalJson(input.evidence), input.policyVersion, input.actorId, input.recordedAt, ordinal)
  }

  private requireCurrentLease(jobId: string, token: string, now: string): ReconciliationJob {
    timestamp(now, 'now')
    const current = this.get(jobId)
    if (!current || current.status !== 'leased' || current.leaseToken !== token || !current.leaseExpiresAt || current.leaseExpiresAt <= now)
      throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'lease is stale')
    return current
  }

  private transition(jobId: string, token: string, now: string, status: 'succeeded' | 'dead_letter' | 'cancelled', failure?: QueueFailure): ReconciliationJob {
    timestamp(now, 'now')
    const result = this.db.prepare(`UPDATE worker_jobs SET status=?,lease_owner=NULL,lease_expires_at=NULL,lease_token=NULL,last_error_code=?,last_error_redacted=?,completed_at=? WHERE job_id=? AND status='leased' AND lease_token=? AND lease_expires_at>?`).run(status, failure?.code ?? null, failure == null ? null : boundedDiagnostic(failure.diagnostic), now, jobId, token, now)
    if (result.changes !== 1)
      throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'lease is stale and cannot transition the job')
    return this.get(jobId)!
  }
}
