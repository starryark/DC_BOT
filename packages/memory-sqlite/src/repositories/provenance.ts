/* eslint-disable perfectionist/sort-imports, perfectionist/sort-named-imports */
import type { DatabaseSync } from 'node:sqlite'
import type { EventId, MemoryRecord, Provenance, TemporalValidity } from '@proj-airi/memory-domain'

import { createHash } from 'node:crypto'
import { asEventId, asTimestamp, assertDurableProvenance, MemoryError } from '@proj-airi/memory-domain'

export type MemoryKind = MemoryRecord['layer']
export type SqlRow = Record<string, string | number | null>

export function persistence(message: string, cause: unknown): never {
  if (cause instanceof MemoryError)
    throw cause
  throw new MemoryError('PERSISTENCE_FAILED', message, { cause })
}

export function immutableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function validateTemporal(validity: TemporalValidity): void {
  asTimestamp(String(validity.validFrom))
  asTimestamp(String(validity.recordedAt))
  if (validity.validUntil != null) {
    asTimestamp(String(validity.validUntil))
    if (Date.parse(validity.validUntil) < Date.parse(validity.validFrom))
      throw new MemoryError('INVALID_INTENT', 'validUntil cannot precede validFrom', { retryable: false })
  }
}

export function validateProvenance(provenance: Provenance): void {
  asTimestamp(String(provenance.statedAt))
  assertDurableProvenance(provenance)
}

export function provenanceValues(record: MemoryRecord): readonly (string | number | null)[] {
  return [record.validity.validFrom, record.validity.validUntil ?? null, record.validity.recordedAt, record.provenance.source, record.provenance.method, record.provenance.statedAt, record.provenance.authoredBy ?? null]
}

export function reconstructProvenance(db: DatabaseSync, kind: MemoryKind, id: string, row: SqlRow): Provenance {
  const sourceEventIds = (db.prepare('SELECT source_event_id FROM memory_source_event_records WHERE memory_kind=? AND memory_id=? ORDER BY ordinal').all(kind, id) as Array<{ source_event_id: string }>).map(item => asEventId(item.source_event_id))
  return {
    source: String(row.provenance_source) as Provenance['source'],
    method: String(row.extraction_method) as Provenance['method'],
    sourceEventIds,
    statedAt: asTimestamp(String(row.stated_at)),
    ...(row.authored_by == null ? {} : { authoredBy: String(row.authored_by) }),
  }
}

export function insertProvenance(db: DatabaseSync, kind: MemoryKind, id: string, sourceEventIds: readonly EventId[]): void {
  sourceEventIds.forEach((eventId, ordinal) => db.prepare('INSERT INTO memory_source_event_records VALUES (?,?,?,?)').run(kind, id, eventId, ordinal))
}

export function validity(row: SqlRow): TemporalValidity {
  return { validFrom: asTimestamp(String(row.valid_from)), ...(row.valid_until == null ? {} : { validUntil: asTimestamp(String(row.valid_until)) }), recordedAt: asTimestamp(String(row.recorded_at)) }
}
