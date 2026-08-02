/* eslint-disable antfu/if-newline, perfectionist/sort-imports, style/brace-style, style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'
import type { CorrectionInput, CorrectionResult, FactId } from '@proj-airi/memory-domain'

import { applyCorrection, asFactId, MemoryError } from '@proj-airi/memory-domain'

import { MemoryRepository } from './memories.js'
import { immutableHash, insertProvenance, persistence, provenanceValues } from './provenance.js'

/** Atomically closes one fact, appends its replacement, and records the immutable edge. */
export class CorrectionRepository {
  private readonly memories: MemoryRepository

  constructor(private readonly db: DatabaseSync) { this.memories = new MemoryRepository(db) }

  correct(correctionId: string, input: Omit<CorrectionInput, 'previous'> & { previousFactId: FactId }): CorrectionResult & { deduplicated: boolean } {
    const inputHash = immutableHash({ correctionId, ...input })
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const retry = this.db.prepare('SELECT input_hash,previous_fact_id,replacement_fact_id FROM semantic_correction_records WHERE correction_id=?').get(correctionId) as { input_hash: string, previous_fact_id: string, replacement_fact_id: string } | undefined
      if (retry) {
        if (retry.input_hash !== inputHash) throw new MemoryError('POLICY_VIOLATION', 'correction identity was reused with conflicting input')
        const result = this.result(asFactId(retry.previous_fact_id), asFactId(retry.replacement_fact_id)); this.db.exec('COMMIT'); return { ...result, deduplicated: true }
      }
      const previous = this.memories.getFact(input.previousFactId)
      if (!previous) throw new MemoryError('TARGET_NOT_FOUND', 'fact to correct does not exist')
      const result = applyCorrection({ ...input, previous })
      const replacementConflict = this.memories.getFact(result.replacement.factId)
      if (replacementConflict) throw new MemoryError('POLICY_VIOLATION', 'replacement fact identity was reused')
      const fact = result.replacement
      this.db.prepare('INSERT INTO semantic_fact_repository_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fact.factId, fact.personId ?? null, fact.scopeKind, fact.scopeId ?? null, fact.predicate, fact.value, fact.confidence, fact.supersedes ?? null, null, fact.tombstonedBy ?? null, ...provenanceValues(fact), immutableHash(fact))
      insertProvenance(this.db, 'semantic', fact.factId, fact.provenance.sourceEventIds)
      this.db.prepare('UPDATE semantic_fact_repository_records SET valid_until=?,superseded_by=? WHERE fact_id=? AND superseded_by IS NULL').run(result.superseded.validity.validUntil ?? null, result.superseded.supersededBy ?? null, previous.factId)
      if ((this.db.prepare('SELECT changes() changes').get() as { changes: number }).changes !== 1) throw new MemoryError('INVALID_INTENT', 'correction precondition is stale')
      this.db.prepare('INSERT INTO semantic_correction_records VALUES (?,?,?,?,?)').run(correctionId, previous.factId, fact.factId, input.effectiveAt, inputHash)
      const saved = this.result(previous.factId, fact.factId); this.db.exec('COMMIT'); return { ...saved, deduplicated: false }
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite fact correction failed and was rolled back', error) }
  }

  chain(factId: FactId): readonly import('@proj-airi/memory-domain').SemanticFact[] {
    try {
      let cursor = this.memories.getFact(factId); if (!cursor) return []
      const seen = new Set<string>()
      while (cursor.supersedes) { if (seen.has(cursor.factId)) throw new MemoryError('PERSISTENCE_FAILED', 'cyclic correction chain'); seen.add(cursor.factId); const prior = this.memories.getFact(cursor.supersedes); if (!prior || prior.supersededBy !== cursor.factId) throw new MemoryError('PERSISTENCE_FAILED', 'ambiguous correction chain'); cursor = prior }
      seen.clear()
      const result = []
      while (cursor) { if (seen.has(cursor.factId)) throw new MemoryError('PERSISTENCE_FAILED', 'cyclic correction chain'); seen.add(cursor.factId); result.push(cursor); if (!cursor.supersededBy) break; const next = this.memories.getFact(cursor.supersededBy); if (!next || next.supersedes !== cursor.factId) throw new MemoryError('PERSISTENCE_FAILED', 'ambiguous correction chain'); cursor = next }
      return result
    }
    catch (error) { persistence('SQLite correction-chain reconstruction failed', error) }
  }

  private result(previous: FactId, replacement: FactId): CorrectionResult {
    const superseded = this.memories.getFact(previous); const next = this.memories.getFact(replacement)
    if (!superseded || !next) throw new MemoryError('PERSISTENCE_FAILED', 'correction history references a missing fact')
    return { superseded, replacement: next }
  }
}
