/* eslint-disable antfu/if-newline, import/consistent-type-specifier-style, perfectionist/sort-imports, style/brace-style, style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'
import type { SummaryId, SummaryRecord } from '@proj-airi/memory-domain'

import { asEventId, asGovernanceId, asLogicalRoomId, asSummaryId, MemoryError } from '@proj-airi/memory-domain'

import { immutableHash, insertProvenance, persistence, provenanceValues, reconstructProvenance, type SqlRow, validateProvenance, validateTemporal, validity } from './provenance.js'

export interface CreateSummaryResult { record: SummaryRecord, deduplicated: boolean }

/** Persists summaries separately from asserted facts and retains both coverage and provenance lineage. */
export class SummaryRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(record: SummaryRecord): CreateSummaryResult {
    validateTemporal(record.validity); validateProvenance(record.provenance)
    if (record.sourceEventIds.length === 0) throw new MemoryError('MISSING_PROVENANCE', 'a summary must cite every source event')
    if (!record.text.trim() || !record.modelRef.trim()) throw new MemoryError('MISSING_VALUE', 'a summary requires text and modelRef')
    const hash = immutableHash(record)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const existing = this.db.prepare('SELECT input_hash FROM summary_repository_records WHERE summary_id=?').get(record.summaryId) as { input_hash: string } | undefined
      if (existing) {
        if (existing.input_hash !== hash) throw new MemoryError('POLICY_VIOLATION', 'summary identity was reused with conflicting input')
        const saved = this.get(record.summaryId)!; this.db.exec('COMMIT'); return { record: saved, deduplicated: true }
      }
      this.db.prepare('INSERT INTO summary_repository_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(record.summaryId, record.logicalRoomId, record.text, record.modelRef, record.stale ? 1 : 0, record.supersededBy ?? null, record.tombstonedBy ?? null, ...provenanceValues(record), hash)
      record.sourceEventIds.forEach((eventId, ordinal) => this.db.prepare('INSERT INTO summary_source_event_records VALUES (?,?,?)').run(record.summaryId, eventId, ordinal))
      insertProvenance(this.db, 'summary', record.summaryId, record.provenance.sourceEventIds)
      const saved = this.get(record.summaryId)!; this.db.exec('COMMIT'); return { record: saved, deduplicated: false }
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite summary creation failed and was rolled back', error) }
  }

  get(summaryId: SummaryId): SummaryRecord | undefined {
    try { const row = this.db.prepare('SELECT * FROM summary_repository_records WHERE summary_id=?').get(summaryId) as SqlRow | undefined; return row ? this.reconstruct(row) : undefined }
    catch (error) { persistence('SQLite summary lookup failed', error) }
  }

  list(logicalRoomId: SummaryRecord['logicalRoomId']): readonly SummaryRecord[] {
    try { return (this.db.prepare('SELECT * FROM summary_repository_records WHERE logical_room_id=? ORDER BY recorded_at,summary_id').all(logicalRoomId) as SqlRow[]).map(row => this.reconstruct(row)) }
    catch (error) { persistence('SQLite summary listing failed', error) }
  }

  private reconstruct(row: SqlRow): SummaryRecord {
    const summaryId = asSummaryId(String(row.summary_id)); const sourceEventIds = (this.db.prepare('SELECT source_event_id FROM summary_source_event_records WHERE summary_id=? ORDER BY ordinal').all(summaryId) as Array<{ source_event_id: string }>).map(item => asEventId(item.source_event_id))
    return { layer: 'summary', summaryId, logicalRoomId: asLogicalRoomId(String(row.logical_room_id)), sourceEventIds, text: String(row.text), modelRef: String(row.model_ref), stale: row.stale === 1, provenance: reconstructProvenance(this.db, 'summary', summaryId, row), validity: validity(row), ...(row.superseded_by == null ? {} : { supersededBy: asSummaryId(String(row.superseded_by)) }), ...(row.tombstoned_by == null ? {} : { tombstonedBy: asGovernanceId(String(row.tombstoned_by)) }) }
  }
}
