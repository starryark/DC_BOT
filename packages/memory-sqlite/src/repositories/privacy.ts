import type { DatabaseSync } from 'node:sqlite'

import { createHash, randomUUID } from 'node:crypto'

import { MemoryError } from '@proj-airi/memory-domain'

import { applyDeletionTarget, verifyDeletionTarget } from '../deletion-targets.js'
import { DerivedInvalidationPlanner } from '../derived-invalidation.js'
import { DerivedRepairQueue } from '../derived-repair.js'

export interface ForgetResult { readonly forgetRequestId: string, readonly obligations: number, readonly deduplicated: boolean }

/** One age rule for one storage class; the durations are policy input, never checked in. */
export interface RetentionRule {
  readonly targetTable: 'inbound_event_records' | 'semantic_fact_repository_records' | 'summary_repository_records' | 'episodic_repository_records' | 'output_segment_records'
  readonly maxAgeMs: number
  readonly logicalRoomId?: string
  /** Narrows event rules to one retention class; ignored for other tables. */
  readonly retentionClass?: 'transcript' | 'command' | 'systemMetadata'
}

/** An explicit, versioned retention policy supplied by the operator or a test. */
export interface RetentionPolicy {
  readonly policyId: string
  readonly version: number
  readonly rules: readonly RetentionRule[]
}

export interface RetentionResult {
  readonly retentionRequestId: string
  readonly policyId: string
  readonly authoritative: number
  readonly derived: number
  readonly obligations: number
  readonly deduplicated: boolean
}

const RETENTION_EVENT_CLASSES = new Set(['transcript', 'command', 'systemMetadata'])

function validatePolicy(policy: RetentionPolicy): void {
  if (!/^[\w:.-]{1,128}$/.test(policy.policyId))
    throw new MemoryError('INVALID_PAYLOAD', 'retention policy identity must be content-free and bounded')
  if (!Number.isSafeInteger(policy.version) || policy.version < 1)
    throw new MemoryError('INVALID_PAYLOAD', 'retention policy version must be a positive integer')
  if (policy.rules.length === 0)
    throw new MemoryError('INVALID_PAYLOAD', 'retention policy requires at least one rule')
  const seen = new Set<string>()
  for (const rule of policy.rules) {
    if (!Number.isSafeInteger(rule.maxAgeMs) || rule.maxAgeMs < 0)
      throw new MemoryError('INVALID_PAYLOAD', 'retention rule maxAgeMs must be a non-negative integer')
    if (rule.targetTable === 'inbound_event_records' && rule.retentionClass != null && !RETENTION_EVENT_CLASSES.has(rule.retentionClass))
      throw new MemoryError('INVALID_PAYLOAD', 'unknown event retention class')
    if (rule.targetTable !== 'inbound_event_records' && rule.retentionClass != null)
      throw new MemoryError('INVALID_PAYLOAD', 'retentionClass applies to event rules only')
    const key = `${rule.targetTable}\0${rule.logicalRoomId ?? ''}\0${rule.retentionClass ?? ''}`
    if (seen.has(key))
      throw new MemoryError('POLICY_VIOLATION', 'retention policy rules must not overlap')
    seen.add(key)
  }
}

/**
 * The content-free identity of one retention operation.
 *
 * An idempotency key names one immutable operation, but the ledger can only
 * store what it is given, and `policyId`/`version` are caller-supplied labels:
 * two different rule sets can carry the same pair. The digest closes that gap
 * by covering every field that changes what the pass would remove, so a retry
 * either *is* the recorded operation or is refused.
 *
 * Rules are normalized to fixed-position tuples and sorted, because the same
 * policy written in a different order is the same operation. Only table names,
 * durations, room ids, and class labels enter the hash, and only the hash is
 * stored, so no subject content reaches the ledger.
 */
function retentionOperationDigest(policy: RetentionPolicy): string {
  const rules = policy.rules
    .map(rule => JSON.stringify([rule.targetTable, rule.maxAgeMs, rule.logicalRoomId ?? null, rule.retentionClass ?? null]))
    .sort()
  return createHash('sha256').update(JSON.stringify([policy.policyId, policy.version, rules]), 'utf8').digest('hex')
}

/** Selects the authoritative records whose age has expired under one rule. */
function selectExpired(db: DatabaseSync, rule: RetentionRule, boundary: string): readonly { targetTable: RetentionRule['targetTable'], targetId: string }[] {
  const room = rule.logicalRoomId
  if (rule.targetTable === 'inbound_event_records')
    return (db.prepare(`SELECT event_id targetId FROM inbound_event_records WHERE occurred_at<=? AND json_extract(payload_json,'$.redacted') IS NOT 1 ${rule.retentionClass ? 'AND retention_class=?' : ''} ${room ? 'AND logical_room_id=?' : ''} ORDER BY event_id`).all(boundary, ...(rule.retentionClass ? [rule.retentionClass] : []), ...(room ? [room] : [])) as Array<{ targetTable: string, targetId: string }>).map(row => ({ targetTable: rule.targetTable, targetId: row.targetId }))
  if (rule.targetTable === 'semantic_fact_repository_records')
    return (db.prepare(`SELECT fact_id targetId FROM semantic_fact_repository_records WHERE recorded_at<=? AND tombstoned_by IS NULL AND scope_kind='logical_room' ${room ? 'AND scope_id=?' : ''} ORDER BY fact_id`).all(boundary, ...(room ? [room] : [])) as Array<{ targetTable: string, targetId: string }>).map(row => ({ targetTable: rule.targetTable, targetId: row.targetId }))
  if (rule.targetTable === 'summary_repository_records')
    return (db.prepare(`SELECT summary_id targetId FROM summary_repository_records WHERE recorded_at<=? AND tombstoned_by IS NULL ${room ? 'AND logical_room_id=?' : ''} ORDER BY summary_id`).all(boundary, ...(room ? [room] : [])) as Array<{ targetTable: string, targetId: string }>).map(row => ({ targetTable: rule.targetTable, targetId: row.targetId }))
  if (rule.targetTable === 'episodic_repository_records')
    return (db.prepare(`SELECT episodic_id targetId FROM episodic_repository_records WHERE recorded_at<=? AND tombstoned_by IS NULL ${room ? 'AND logical_room_id=?' : ''} ORDER BY episodic_id`).all(boundary, ...(room ? [room] : [])) as Array<{ targetTable: string, targetId: string }>).map(row => ({ targetTable: rule.targetTable, targetId: row.targetId }))
  return (db.prepare(`SELECT s.segment_id targetId FROM output_segment_records s JOIN generation_attempt_records g ON g.generation_id=s.generation_id WHERE g.started_at<=? AND s.exact_text<>'' ${room ? 'AND g.logical_room_id=?' : ''} ORDER BY s.segment_id`).all(boundary, ...(room ? [room] : [])) as Array<{ targetTable: string, targetId: string }>).map(row => ({ targetTable: rule.targetTable, targetId: row.targetId }))
}

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
      const retry = this.db.prepare('SELECT subject_type,subject_id,scope_json,status FROM forget_requests WHERE idempotency_key=?').get(requestId) as { subject_type: string, subject_id: string, scope_json: string, status: string } | undefined
      if (retry) {
        if (retry.status !== 'completed')
          throw new Error('Existing forget request is not complete')
        // One unique idempotency key spans both subject forget and retention in
        // this ledger, so a reused key can name a completely different closure.
        // Answering out of it would report a verified deletion for a subject and
        // scope nothing was deleted for, which is the one thing forget must
        // never claim.
        const scope = JSON.parse(retry.scope_json) as { logicalRoomId?: unknown }
        if (retry.subject_type !== 'person' || retry.subject_id !== personId || scope.logicalRoomId !== roomId)
          throw new MemoryError('POLICY_VIOLATION', 'this idempotency key already records a different forget operation')
        const obligations = (this.db.prepare('SELECT count(*) count FROM deletion_tombstones WHERE forget_request_id=?').get(requestId) as { count: number }).count
        this.db.exec('COMMIT')
        return { forgetRequestId: requestId, obligations, deduplicated: true }
      }

      this.db.prepare(`INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (?,'person',?,?,?,'processing',1,NULL,NULL,?)`).run(requestId, personId, JSON.stringify({ logicalRoomId: roomId }), at, requestId)
      const plan = new DerivedInvalidationPlanner(this.db).plan({ kind: 'forget', requestId, personId, logicalRoomId: roomId })
      const targets = [...plan.authoritativeTargets, ...plan.derivedTargets]
      for (const target of targets)
        this.db.prepare(`INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,evidence_json) VALUES (?,?,?,?,'pending',?,'{}')`).run(randomUUID(), requestId, target.targetTable, target.targetId, at)
      for (const target of targets)
        applyDeletionTarget(this.db, target, requestId)
      for (const target of targets)
        verifyDeletionTarget(this.db, target)
      this.db.prepare(`UPDATE deletion_tombstones SET redaction_state='verified',verified_at=? WHERE forget_request_id=?`).run(at, requestId)
      this.db.prepare(`UPDATE forget_requests SET status='completed',completed_at=?,verification_json=? WHERE forget_request_id=?`).run(at, JSON.stringify({ remaining: 0, obligations: targets.length }), requestId)
      this.db.exec('COMMIT')
      return { forgetRequestId: requestId, obligations: targets.length, deduplicated: false }
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * Applies one versioned retention policy atomically: age-based selection of
   * authoritative room-scoped subject records, dependency-driven invalidation of
   * their representations, verified removal, and a lexical repair obligation.
   *
   * The request rides the same forget_requests/deletion_tombstones ledger as a
   * subject forget, so completed retention obligations are captured by
   * `captureDeletionObligations` and replayed into any restored backup.
   *
   * `requestId` names one immutable operation: a retry deduplicates only when
   * {@link retentionOperationDigest} proves the supplied policy is the recorded
   * one, and is refused otherwise. It never reports a newly supplied policy as
   * applied out of a stored operation that belongs to something else.
   */
  applyRetention(requestId: string, policy: RetentionPolicy, now: string): RetentionResult {
    validatePolicy(policy)
    const digest = retentionOperationDigest(policy)
    const boundary = (rule: RetentionRule): string => new Date(Date.parse(now) - rule.maxAgeMs).toISOString()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const retry = this.db.prepare('SELECT subject_type,scope_json,status,verification_json FROM forget_requests WHERE idempotency_key=?').get(requestId) as { subject_type: string, scope_json: string, status: string, verification_json: string | null } | undefined
      if (retry) {
        if (retry.status !== 'completed')
          throw new Error('Existing retention request is not complete')
        // Deduplicate only what is provably the recorded operation. A retry
        // carrying a changed policy is a different operation, and returning the
        // stored counts under the new policy's name would claim a policy was
        // applied that never ran. A row that carries no digest cannot prove
        // identity either, so it is refused for the same reason.
        const stored = JSON.parse(retry.scope_json) as { policyDigest?: unknown }
        if (retry.subject_type !== 'time_range' || stored.policyDigest !== digest)
          throw new MemoryError('POLICY_VIOLATION', 'this idempotency key already records a different retention operation')
        const prior = JSON.parse(retry.verification_json ?? '{}') as { obligations?: number, authoritative?: number, derived?: number }
        this.db.exec('COMMIT')
        return { retentionRequestId: requestId, policyId: policy.policyId, authoritative: prior.authoritative ?? 0, derived: prior.derived ?? 0, obligations: prior.obligations ?? 0, deduplicated: true }
      }

      const authoritative = [...new Map(policy.rules.flatMap(rule => selectExpired(this.db, rule, boundary(rule))).map(target => [`${target.targetTable}:${target.targetId}`, target])).values()]
        .map(target => ({ targetTable: target.targetTable, targetId: target.targetId }))
        .sort((left, right) => left.targetTable.localeCompare(right.targetTable) || left.targetId.localeCompare(right.targetId))
      const plan = new DerivedInvalidationPlanner(this.db).plan({ kind: 'retention', policyId: policy.policyId, targets: authoritative })
      const targets = [...plan.authoritativeTargets, ...plan.derivedTargets]
      this.db.prepare(`INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (?,'time_range',?,?,?,'processing',?,NULL,NULL,?)`).run(requestId, policy.policyId, JSON.stringify({ policyId: policy.policyId, policyVersion: policy.version, rules: policy.rules.length, policyDigest: digest }), now, policy.version, requestId)
      for (const target of targets)
        this.db.prepare(`INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,evidence_json) VALUES (?,?,?,?,'pending',?,'{}')`).run(randomUUID(), requestId, target.targetTable, target.targetId, now)
      for (const target of targets)
        applyDeletionTarget(this.db, target, requestId)
      for (const target of targets)
        verifyDeletionTarget(this.db, target)
      this.db.prepare(`UPDATE deletion_tombstones SET redaction_state='verified',verified_at=? WHERE forget_request_id=?`).run(now, requestId)
      this.db.prepare(`UPDATE forget_requests SET status='completed',completed_at=?,verification_json=? WHERE forget_request_id=?`).run(now, JSON.stringify({ remaining: 0, obligations: targets.length, policyId: policy.policyId, policyVersion: policy.version, authoritative: authoritative.length, derived: plan.derivedTargets.length }), requestId)
      new DerivedRepairQueue(this.db).enqueueLexicalRepair({ jobId: `lexical:${requestId}`, dedupeKey: `retention:${requestId}`, reason: 'retention', policyVersion: `retention:${policy.policyId}:v${policy.version}`, availableAt: now, createdAt: now, maxAttempts: 3 })
      this.db.exec('COMMIT')
      return { retentionRequestId: requestId, policyId: policy.policyId, authoritative: authoritative.length, derived: plan.derivedTargets.length, obligations: targets.length, deduplicated: false }
    }
    catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
