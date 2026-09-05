/* eslint-disable antfu/if-newline, style/brace-style, style/max-statements-per-line, ts/consistent-type-definitions */
import type { DatabaseSync } from 'node:sqlite'

import type { CausalEdge, CauseDeclaration, EventId, GenerationId } from '@proj-airi/memory-domain'

import { asEventId, asGenerationId, buildCausalEdges, MemoryError } from '@proj-airi/memory-domain'

type EdgeRow = { generation_id: string, inbound_event_id: string, cause_role: CausalEdge['role'] }
const edge = (row: EdgeRow): CausalEdge => ({ generationId: asGenerationId(row.generation_id), inboundEventId: asEventId(row.inbound_event_id), role: row.cause_role })

/** Persists validated many-to-many generation causes without owning generation creation. */
export class CausalEdgeRepository {
  constructor(private readonly db: DatabaseSync) {}

  appendSet(generationId: GenerationId, causes: readonly CauseDeclaration[]): readonly CausalEdge[] {
    const edges = buildCausalEdges(generationId, causes)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      for (const value of edges) this.db.prepare('INSERT OR IGNORE INTO generation_causal_edges(generation_id,inbound_event_id,cause_role) VALUES (?,?,?)').run(value.generationId, value.inboundEventId, value.role)
      this.db.exec('COMMIT'); return this.forGeneration(generationId)
    }
    catch (cause) { try { this.db.exec('ROLLBACK') } catch {}; if (cause instanceof MemoryError) throw cause; throw new MemoryError('PERSISTENCE_FAILED', 'SQLite causal-set append failed and was rolled back', { cause }) }
  }

  forGeneration(generationId: GenerationId): readonly CausalEdge[] {
    try { return (this.db.prepare('SELECT generation_id,inbound_event_id,cause_role FROM generation_causal_edges WHERE generation_id=? ORDER BY inbound_event_id,cause_role').all(generationId) as EdgeRow[]).map(edge) }
    catch (cause) { throw new MemoryError('PERSISTENCE_FAILED', 'SQLite forward causal traversal failed', { cause }) }
  }

  forEvent(eventId: EventId): readonly CausalEdge[] {
    try { return (this.db.prepare('SELECT generation_id,inbound_event_id,cause_role FROM generation_causal_edges WHERE inbound_event_id=? ORDER BY generation_id,cause_role').all(eventId) as EdgeRow[]).map(edge) }
    catch (cause) { throw new MemoryError('PERSISTENCE_FAILED', 'SQLite reverse causal traversal failed', { cause }) }
  }
}
