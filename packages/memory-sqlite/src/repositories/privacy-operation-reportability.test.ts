import type { DatabaseSync } from 'node:sqlite'

import type { PrivacyOperationKind, PrivacyOperationOutcome } from './privacy-operations.js'

import { createHmac } from 'node:crypto'
import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { PrivacyOperationRepository } from './privacy-operations.js'

interface ExpectedOperation {
  readonly requestId: string
  readonly operationId: string
  readonly operationKind: PrivacyOperationKind
  readonly outcomeCode: PrivacyOperationOutcome
}

let database: DatabaseSync
const at = '2026-08-04T10:00:00.000Z'

beforeEach(() => {
  database = new SQLiteDatabase(':memory:')
  migrate(database)
})

afterEach(() => database.close())

function insert(requestId: string, operationId: string, operationKind: PrivacyOperationKind, outcomeCode?: PrivacyOperationOutcome): ExpectedOperation {
  const operations = new PrivacyOperationRepository(database, () => operationId)
  const begun = operations.begin({ requestId, operationKind, personId: 'person-private', logicalRoomId: 'room-private', inputHash: `${operationKind}-input-hash`, requestedAt: at }).record
  if (outcomeCode != null)
    operations.complete(operationId, { completedAt: at, outcomeCode })
  return { requestId, operationId: begun.operationId, operationKind, outcomeCode: outcomeCode ?? 'failed' }
}

function pseudonym(key: string, kind: 'operation-id' | 'request-id', value: string): string {
  return createHmac('sha256', key).update(`dc-bot.active-soak/v1/${kind}\0${value}`).digest('hex')
}

function rejectRawIdentifiers(bytes: string, expected: readonly ExpectedOperation[]): void {
  for (const raw of expected.flatMap(item => [item.operationId, item.requestId])) {
    if (bytes.includes(raw))
      throw new Error('raw identifier leakage')
  }
}

function verifyAndBuild(expected: readonly ExpectedOperation[], key: string): { readonly operations: readonly Record<string, string>[] } {
  if (new Set(expected.map(item => item.operationId)).size !== expected.length)
    throw new Error('duplicate attested operation')
  const rows = database.prepare('SELECT operation_id,request_id,operation_kind,outcome_code,completed_at FROM privacy_operation_records WHERE requested_at>=? AND requested_at<=? ORDER BY operation_id').all(at, at) as Array<{ operation_id: string, request_id: string, operation_kind: string, outcome_code: string | null, completed_at: string | null }>
  if (rows.length !== expected.length)
    throw new Error('missing or unattested operation')
  const output = expected.map((item) => {
    const matches = rows.filter(row => row.operation_id === item.operationId && row.request_id === item.requestId)
    if (matches.length !== 1)
      throw new Error('operation correlation is missing or ambiguous')
    const row = matches[0]!
    if (row.completed_at == null || row.outcome_code == null)
      throw new Error('operation is nonterminal')
    if (row.operation_kind !== item.operationKind || row.outcome_code !== item.outcomeCode)
      throw new Error('operation evidence mismatches attestation')
    return { operation: pseudonym(key, 'operation-id', row.operation_id), request: pseudonym(key, 'request-id', row.request_id), kind: row.operation_kind, outcome: row.outcome_code }
  })
  const report = { operations: output }
  const bytes = JSON.stringify(report)
  rejectRawIdentifiers(bytes, expected)
  return report
}

describe('p0 privacy-operation reportability spike', () => {
  it('maps each marker to one terminal operation and emits only run-keyed HMAC identifiers', () => {
    const status = insert('dcsoak-status-marker', 'operation-status', 'status', 'succeeded')
    const remember = insert('dcsoak-remember-marker', 'operation-remember', 'remember', 'capability_disabled')
    const report = verifyAndBuild([status, remember], 'run-specific-secret')

    expect(report.operations).toHaveLength(2)
    expect(report.operations[0]?.operation).toHaveLength(64)
    expect(JSON.stringify(report)).not.toContain('operation-status')
    expect(JSON.stringify(report)).not.toContain('dcsoak-status-marker')
    expect(pseudonym('another-run-secret', 'operation-id', 'operation-status')).not.toBe(report.operations[0]?.operation)
  })

  it('rejects missing, duplicate, nonterminal, mismatched, and unattested records', () => {
    const status = insert('status-marker', 'status-operation', 'status', 'succeeded')
    expect(() => verifyAndBuild([{ ...status, operationId: 'missing' }], 'key')).toThrow('missing or ambiguous')
    expect(() => verifyAndBuild([status, status], 'key')).toThrow('duplicate attested')

    database.exec('DELETE FROM privacy_operation_records')
    const nonterminal = insert('remember-marker', 'remember-operation', 'remember')
    expect(() => verifyAndBuild([nonterminal], 'key')).toThrow('nonterminal')

    database.exec('DELETE FROM privacy_operation_records')
    const correct = insert('correct-marker', 'correct-operation', 'correct', 'capability_disabled')
    expect(() => verifyAndBuild([{ ...correct, operationKind: 'remember' }], 'key')).toThrow('mismatches')
    insert('extra-marker', 'extra-operation', 'status', 'succeeded')
    expect(() => verifyAndBuild([correct], 'key')).toThrow('missing or unattested')
  })

  it('fails the leakage guard if a raw identifier is added to the report shape', () => {
    const status = insert('raw-request-marker', 'raw-operation-id', 'status', 'succeeded')
    const safe = verifyAndBuild([status], 'key')
    const contaminated = JSON.stringify({ ...safe, operationId: status.operationId })
    expect(() => rejectRawIdentifiers(contaminated, [status])).toThrow('raw identifier leakage')
  })
})
