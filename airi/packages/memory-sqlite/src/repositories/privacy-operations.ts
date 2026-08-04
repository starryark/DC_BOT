import type { DatabaseSync } from 'node:sqlite'

import { createHash, randomUUID } from 'node:crypto'

import { MemoryError } from '@proj-airi/memory-domain'

export type PrivacyOperationKind = 'status' | 'show' | 'export' | 'remember' | 'correct' | 'forget'
export type PrivacyOperationOutcome = 'succeeded' | 'capability_disabled' | 'failed'

export interface PrivacyOperationRecord {
  readonly operationId: string
  readonly requestId: string
  readonly operationKind: PrivacyOperationKind
  readonly requestedAt: string
  readonly completedAt?: string
  readonly outcomeCode?: PrivacyOperationOutcome
  readonly forgetRequestId?: string
}

// NOTICE:
// This must stay a type alias even though `ts/consistent-type-definitions`
// prefers an interface.
// Only type aliases receive TypeScript's implicit index signature, which is
// what makes `node:sqlite`'s `Record<string, SQLOutputValue>` rows assertable
// to this shape; an interface fails with TS2352 and would force an
// `as unknown as Row` launder instead.
// See `repositories/outputs.ts`, which uses a type alias for the same reason.
// Removal condition: when row mapping no longer casts raw driver records.
// eslint-disable-next-line ts/consistent-type-definitions
type Row = { operation_id: string, request_id: string, operation_kind: PrivacyOperationKind, scope_hash: string, input_hash: string, requested_at: string, completed_at: string | null, outcome_code: PrivacyOperationOutcome | null, forget_request_id: string | null }

function record(row: Row): PrivacyOperationRecord {
  return { operationId: row.operation_id, requestId: row.request_id, operationKind: row.operation_kind, requestedAt: row.requested_at, ...(row.completed_at == null ? {} : { completedAt: row.completed_at }), ...(row.outcome_code == null ? {} : { outcomeCode: row.outcome_code }), ...(row.forget_request_id == null ? {} : { forgetRequestId: row.forget_request_id }) }
}

function scopeHash(personId: string, logicalRoomId: string): string {
  return createHash('sha256').update(`dc-bot.privacy-operation-scope/v1\0${personId}\0${logicalRoomId}`).digest('hex')
}

/** Persists content-free command identity and terminal outcome independently of capability enablement. */
export class PrivacyOperationRepository {
  constructor(private readonly db: DatabaseSync, private readonly id: () => string = randomUUID) {}

  begin(input: { requestId: string, operationKind: PrivacyOperationKind, personId: string, logicalRoomId: string, inputHash: string, requestedAt: string }): { record: PrivacyOperationRecord, deduplicated: boolean } {
    if (!/^[\w:.-]{1,128}$/.test(input.requestId))
      throw new MemoryError('INVALID_PAYLOAD', 'privacy operation request identity must be content-free and bounded')
    const scope = scopeHash(input.personId, input.logicalRoomId)
    const existing = this.db.prepare('SELECT * FROM privacy_operation_records WHERE request_id=?').get(input.requestId) as Row | undefined
    if (existing) {
      if (existing.operation_kind !== input.operationKind || existing.scope_hash !== scope || existing.input_hash !== input.inputHash || existing.requested_at !== input.requestedAt)
        throw new MemoryError('POLICY_VIOLATION', 'privacy operation request identity was reused with conflicting input')
      return { record: record(existing), deduplicated: true }
    }
    const operationId = this.id()
    this.db.prepare('INSERT INTO privacy_operation_records(operation_id,request_id,operation_kind,scope_hash,input_hash,requested_at) VALUES (?,?,?,?,?,?)').run(operationId, input.requestId, input.operationKind, scope, input.inputHash, input.requestedAt)
    return { record: record(this.db.prepare('SELECT * FROM privacy_operation_records WHERE operation_id=?').get(operationId) as Row), deduplicated: false }
  }

  complete(operationId: string, input: { completedAt: string, outcomeCode: PrivacyOperationOutcome, forgetRequestId?: string }): PrivacyOperationRecord {
    const current = this.db.prepare('SELECT * FROM privacy_operation_records WHERE operation_id=?').get(operationId) as Row | undefined
    if (!current)
      throw new MemoryError('TARGET_NOT_FOUND', 'privacy operation does not exist')
    if (current.completed_at != null) {
      if (current.completed_at !== input.completedAt || current.outcome_code !== input.outcomeCode || (current.forget_request_id ?? undefined) !== input.forgetRequestId)
        throw new MemoryError('POLICY_VIOLATION', 'terminal privacy operation evidence cannot be changed')
      return record(current)
    }
    if (input.forgetRequestId != null && current.operation_kind !== 'forget')
      throw new MemoryError('POLICY_VIOLATION', 'only forget operations may link a forget request')
    this.db.prepare('UPDATE privacy_operation_records SET completed_at=?,outcome_code=?,forget_request_id=? WHERE operation_id=? AND completed_at IS NULL').run(input.completedAt, input.outcomeCode, input.forgetRequestId ?? null, operationId)
    return record(this.db.prepare('SELECT * FROM privacy_operation_records WHERE operation_id=?').get(operationId) as Row)
  }

  byRequestId(requestId: string): PrivacyOperationRecord | undefined {
    const row = this.db.prepare('SELECT * FROM privacy_operation_records WHERE request_id=?').get(requestId) as Row | undefined
    return row == null ? undefined : record(row)
  }
}
