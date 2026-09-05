import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { PrivacyOperationRepository } from './privacy-operations.js'

let database: DatabaseSync
let nextId = 0
const at = '2026-08-04T10:00:00.000Z'

beforeEach(() => {
  database = new SQLiteDatabase(':memory:')
  migrate(database)
  nextId = 0
})

afterEach(() => database.close())

describe('privacyOperationRepository', () => {
  it('persists one content-free terminal record for status and disabled writes', () => {
    const operations = new PrivacyOperationRepository(database, () => `operation-${++nextId}`)
    const status = operations.begin({ requestId: 'marker-status', operationKind: 'status', personId: 'person-a', logicalRoomId: 'room-a', inputHash: 'status-hash', requestedAt: at })
    operations.complete(status.record.operationId, { completedAt: at, outcomeCode: 'succeeded' })
    const remember = operations.begin({ requestId: 'marker-remember', operationKind: 'remember', personId: 'person-a', logicalRoomId: 'room-a', inputHash: 'remember-hash', requestedAt: at })
    operations.complete(remember.record.operationId, { completedAt: at, outcomeCode: 'capability_disabled' })
    const correct = operations.begin({ requestId: 'marker-correct', operationKind: 'correct', personId: 'person-a', logicalRoomId: 'room-a', inputHash: 'correct-hash', requestedAt: at })
    operations.complete(correct.record.operationId, { completedAt: at, outcomeCode: 'capability_disabled' })

    expect(operations.byRequestId('marker-status')).toMatchObject({ operationId: 'operation-1', outcomeCode: 'succeeded' })
    expect(operations.byRequestId('marker-remember')).toMatchObject({ operationId: 'operation-2', outcomeCode: 'capability_disabled' })
    expect(operations.byRequestId('marker-correct')).toMatchObject({ operationId: 'operation-3', outcomeCode: 'capability_disabled' })
    const bytes = JSON.stringify(database.prepare('SELECT * FROM privacy_operation_records ORDER BY operation_id').all())
    expect(bytes).not.toContain('favorite')
    expect(bytes).not.toContain('Dr Pepper')
    expect(bytes).not.toContain('display name')
  })

  it('deduplicates identical requests and rejects kind, scope, or input conflicts', () => {
    const operations = new PrivacyOperationRepository(database, () => `operation-${++nextId}`)
    const input = { requestId: 'marker-one', operationKind: 'remember' as const, personId: 'person-a', logicalRoomId: 'room-a', inputHash: 'same-input', requestedAt: at }
    const first = operations.begin(input)
    const retry = operations.begin(input)

    expect(retry.deduplicated).toBe(true)
    expect(retry.record.operationId).toBe(first.record.operationId)
    expect(() => operations.begin({ ...input, operationKind: 'correct' })).toThrow('conflicting input')
    expect(() => operations.begin({ ...input, personId: 'person-b' })).toThrow('conflicting input')
    expect(() => operations.begin({ ...input, inputHash: 'different-input' })).toThrow('conflicting input')
    expect(() => operations.begin({ ...input, requestedAt: '2026-08-04T10:00:01.000Z' })).toThrow('conflicting input')
    expect(() => operations.begin({ ...input, requestId: 'message text is forbidden' })).toThrow('content-free and bounded')
    expect(database.prepare('SELECT count(*) count FROM privacy_operation_records').get()).toEqual({ count: 1 })
  })

  it('links forget terminal evidence to its request and survives target redaction', () => {
    const operations = new PrivacyOperationRepository(database, () => `operation-${++nextId}`)
    const begun = operations.begin({ requestId: 'marker-forget', operationKind: 'forget', personId: 'person-a', logicalRoomId: 'room-a', inputHash: 'forget-hash', requestedAt: at })
    database.prepare('INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (\'forget-1\',\'person\',\'person-a\',\'{}\',?,\'completed\',1,?,\'{}\',\'forget-1\')').run(at, at)
    database.prepare('INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,verified_at,evidence_json) VALUES (\'tombstone-1\',\'forget-1\',\'inbound_event_records\',\'event-redacted\',\'verified\',?,?,\'{}\')').run(at, at)
    operations.complete(begun.record.operationId, { completedAt: at, outcomeCode: 'succeeded', forgetRequestId: 'forget-1' })

    const correlated = database.prepare('SELECT o.operation_id,f.forget_request_id,t.target_id FROM privacy_operation_records o JOIN forget_requests f ON f.forget_request_id=o.forget_request_id JOIN deletion_tombstones t ON t.forget_request_id=f.forget_request_id WHERE o.request_id=?').all('marker-forget')
    expect(correlated).toEqual([{ operation_id: 'operation-1', forget_request_id: 'forget-1', target_id: 'event-redacted' }])
  })

  it('keeps terminal evidence immutable and rejects invalid forget linkage', () => {
    const operations = new PrivacyOperationRepository(database, () => `operation-${++nextId}`)
    const status = operations.begin({ requestId: 'status', operationKind: 'status', personId: 'person-a', logicalRoomId: 'room-a', inputHash: 'status-hash', requestedAt: at }).record
    operations.complete(status.operationId, { completedAt: at, outcomeCode: 'succeeded' })
    expect(() => operations.complete(status.operationId, { completedAt: at, outcomeCode: 'failed' })).toThrow('cannot be changed')
    expect(() => operations.complete('missing', { completedAt: at, outcomeCode: 'failed' })).toThrow('does not exist')
  })
})
