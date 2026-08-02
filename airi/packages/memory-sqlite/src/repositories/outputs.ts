/* eslint-disable antfu/if-newline, perfectionist/sort-imports, style/brace-style, style/max-statements-per-line, ts/consistent-type-definitions */
import type { DatabaseSync } from 'node:sqlite'
import type { GenerationId, OutputSegment } from '@proj-airi/memory-domain'

import { createHash } from 'node:crypto'
import { asGenerationId, asSegmentId, MemoryError } from '@proj-airi/memory-domain'

export interface AppendOutputResult { segments: readonly OutputSegment[], deduplicated: boolean }
type Row = { segment_id: string, generation_id: string, ordinal: number, modality: OutputSegment['modality'], exact_text: string, content_hash: string }

const contentHash = (segment: OutputSegment): string => createHash('sha256').update(JSON.stringify(segment)).digest('hex')
const segment = (row: Row): OutputSegment => ({ segmentId: asSegmentId(row.segment_id), generationId: asGenerationId(row.generation_id), ordinal: row.ordinal, modality: row.modality, text: row.exact_text })
function persistence(message: string, cause: unknown): never { if (cause instanceof MemoryError) throw cause; throw new MemoryError('PERSISTENCE_FAILED', message, { cause }) }

/** Stores immutable, generation-owned output segments in deterministic ordinal order. */
export class OutputRepository {
  constructor(private readonly db: DatabaseSync) {}

  appendSet(generationId: GenerationId, values: readonly OutputSegment[]): AppendOutputResult {
    if (values.some(value => value.generationId !== generationId)) throw new MemoryError('POLICY_VIOLATION', 'every output segment must belong to the requested generation')
    const ordinals = new Set(values.map(value => value.ordinal)); const ids = new Set(values.map(value => value.segmentId))
    if (ordinals.size !== values.length || ids.size !== values.length || values.some(value => !Number.isSafeInteger(value.ordinal) || value.ordinal < 0)) throw new MemoryError('POLICY_VIOLATION', 'output segment identities and ordinals must be unique and non-negative')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      let inserted = 0
      for (const value of values) {
        const digest = contentHash(value)
        const byId = this.db.prepare('SELECT * FROM output_segment_records WHERE segment_id=?').get(value.segmentId) as Row | undefined
        const byOrdinal = this.db.prepare('SELECT * FROM output_segment_records WHERE generation_id=? AND ordinal=?').get(generationId, value.ordinal) as Row | undefined
        if (byId || byOrdinal) {
          const existing = byId ?? byOrdinal!
          if (existing.segment_id !== value.segmentId || existing.content_hash !== digest) throw new MemoryError('POLICY_VIOLATION', 'output segment identity or ordinal was reused with conflicting content')
          continue
        }
        this.db.prepare('INSERT INTO output_segment_records VALUES (?,?,?,?,?,?)').run(value.segmentId, generationId, value.ordinal, value.modality, value.text, digest); inserted++
      }
      const stored = this.list(generationId)
      if (stored.length !== values.length || stored.some((value, index) => value.segmentId !== [...values].sort((a, b) => a.ordinal - b.ordinal)[index]?.segmentId)) throw new MemoryError('POLICY_VIOLATION', 'output retry does not exactly match the durable generation segment set')
      this.db.exec('COMMIT'); return { segments: stored, deduplicated: inserted === 0 }
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite output-set append failed and was rolled back', error) }
  }

  list(generationId: GenerationId): readonly OutputSegment[] {
    try { return (this.db.prepare('SELECT * FROM output_segment_records WHERE generation_id=? ORDER BY ordinal,segment_id').all(generationId) as Row[]).map(segment) }
    catch (error) { persistence('SQLite output segment lookup failed', error) }
  }
}
