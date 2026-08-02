import type { DatabaseSync } from 'node:sqlite'

import { createHash } from 'node:crypto'

import { MemoryError } from '@proj-airi/memory-domain'

export type CanonicalValue = null | boolean | number | string | readonly CanonicalValue[] | { readonly [key: string]: CanonicalValue }

/** Deterministically serializes JSON values by recursively sorting object keys. */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new MemoryError('INVALID_PAYLOAD', 'canonical JSON numbers must be finite')
    return JSON.stringify(value)
  }
  if (Array.isArray(value))
    return `[${value.map(canonicalJson).join(',')}]`
  const object = value as { readonly [key: string]: CanonicalValue }
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key]!)}`).join(',')}}`
}

/** Returns a stable SHA-256 digest without retaining private request material. */
export function canonicalHash(value: CanonicalValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

/** Persists a successful result in the caller's transaction and rejects conflicting key reuse. */
export function executeIdempotently<Result extends CanonicalValue>(database: DatabaseSync, input: { namespace: string, key: string, request: CanonicalValue, createdAt: string }, operation: () => Result): { result: Result, deduplicated: boolean } {
  if (!input.namespace || !input.key || !input.createdAt)
    throw new MemoryError('INVALID_PAYLOAD', 'idempotency namespace, key, and timestamp are required')
  const requestHash = canonicalHash(input.request)
  const prior = database.prepare('SELECT request_hash,result_json FROM idempotency_records WHERE namespace=? AND idempotency_key=?').get(input.namespace, input.key) as { request_hash: string, result_json: string } | undefined
  if (prior) {
    if (prior.request_hash !== requestHash)
      throw new MemoryError('POLICY_VIOLATION', 'idempotency key was reused with a different canonical request')
    try {
      return { result: JSON.parse(prior.result_json) as Result, deduplicated: true }
    }
    catch (error) {
      throw new MemoryError('PERSISTENCE_FAILED', 'stored idempotency result is malformed', { cause: error })
    }
  }
  const result = operation()
  database.prepare('INSERT INTO idempotency_records(namespace,idempotency_key,request_hash,result_json,created_at) VALUES (?,?,?,?,?)').run(input.namespace, input.key, requestHash, canonicalJson(result), input.createdAt)
  return { result, deduplicated: false }
}
