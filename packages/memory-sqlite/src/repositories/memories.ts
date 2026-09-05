/* eslint-disable antfu/if-newline, import/consistent-type-specifier-style, perfectionist/sort-imports, perfectionist/sort-named-imports, style/brace-style, style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'
import type { EpisodicRecord, FactId, ProceduralRule, SemanticFact, Timestamp } from '@proj-airi/memory-domain'

import { asConfidence, asFactId, asGovernanceId, asLogicalRoomId, asPersonId, asTimestamp, assertWritableFact, assertWritableProcedure, MemoryError } from '@proj-airi/memory-domain'

import { immutableHash, insertProvenance, persistence, provenanceValues, reconstructProvenance, type SqlRow, validateProvenance, validateTemporal, validity } from './provenance.js'

export interface CreateMemoryResult<T> { record: T, deduplicated: boolean }
export interface FactSelector { scopeKind: SemanticFact['scopeKind'], scopeId?: string, predicate: string }

/** Owns semantic, episodic, and procedural records without collapsing their layer semantics. */
export class MemoryRepository {
  constructor(private readonly db: DatabaseSync) {}

  createFact(fact: SemanticFact): CreateMemoryResult<SemanticFact> {
    asConfidence(fact.confidence); validateTemporal(fact.validity); assertWritableFact(fact)
    return this.create('semantic_fact_repository_records', 'fact_id', fact.factId, fact, () => {
      this.db.prepare('INSERT INTO semantic_fact_repository_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(fact.factId, fact.personId ?? null, fact.scopeKind, fact.scopeId ?? null, fact.predicate, fact.value, fact.confidence, fact.supersedes ?? null, fact.supersededBy ?? null, fact.tombstonedBy ?? null, ...provenanceValues(fact), immutableHash(fact)); insertProvenance(this.db, 'semantic', fact.factId, fact.provenance.sourceEventIds)
    }, () => this.getFact(fact.factId))
  }

  createEpisodic(record: EpisodicRecord): CreateMemoryResult<EpisodicRecord> {
    validateTemporal(record.validity); validateProvenance(record.provenance)
    if (!record.summary.trim()) throw new MemoryError('MISSING_VALUE', 'an episodic record requires a summary')
    return this.create('episodic_repository_records', 'episodic_id', record.episodicId, record, () => {
      this.db.prepare('INSERT INTO episodic_repository_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(record.episodicId, record.personId ?? null, record.logicalRoomId, record.occurredAt, record.summary, record.tombstonedBy ?? null, ...provenanceValues(record), immutableHash(record)); insertProvenance(this.db, 'episodic', record.episodicId, record.provenance.sourceEventIds)
    }, () => this.getEpisodic(record.episodicId))
  }

  createProcedure(record: ProceduralRule): CreateMemoryResult<ProceduralRule> {
    validateTemporal(record.validity); assertWritableProcedure(record)
    if (!record.rule.trim()) throw new MemoryError('MISSING_VALUE', 'a procedural record requires a rule')
    return this.create('procedural_repository_records', 'proc_id', record.procId, record, () => {
      this.db.prepare('INSERT INTO procedural_repository_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(record.procId, record.rule, record.tombstonedBy ?? null, ...provenanceValues(record), immutableHash(record)); insertProvenance(this.db, 'procedural', record.procId, record.provenance.sourceEventIds)
    }, () => this.getProcedure(record.procId))
  }

  getFact(factId: FactId): SemanticFact | undefined { return this.one('semantic_fact_repository_records', 'fact_id', factId, row => this.fact(row)) }
  getEpisodic(id: FactId): EpisodicRecord | undefined { return this.one('episodic_repository_records', 'episodic_id', id, row => this.episodic(row)) }
  getProcedure(id: FactId): ProceduralRule | undefined { return this.one('procedural_repository_records', 'proc_id', id, row => this.procedure(row)) }

  factsAsOf(selector: FactSelector, at: Timestamp): readonly SemanticFact[] {
    asTimestamp(String(at))
    try {
      return (this.db.prepare(`SELECT * FROM semantic_fact_repository_records WHERE scope_kind=? AND scope_id IS ? AND predicate=? AND tombstoned_by IS NULL AND valid_from<=? AND (valid_until IS NULL OR valid_until>?) ORDER BY valid_from,fact_id`).all(selector.scopeKind, selector.scopeId ?? null, selector.predicate, at, at) as SqlRow[]).map(row => this.fact(row))
    }
    catch (error) { persistence('SQLite as-of fact query failed', error) }
  }

  currentFacts(selector: FactSelector): readonly SemanticFact[] {
    try { return (this.db.prepare('SELECT * FROM semantic_fact_repository_records WHERE scope_kind=? AND scope_id IS ? AND predicate=? AND tombstoned_by IS NULL AND superseded_by IS NULL ORDER BY valid_from,fact_id').all(selector.scopeKind, selector.scopeId ?? null, selector.predicate) as SqlRow[]).map(row => this.fact(row)) }
    catch (error) { persistence('SQLite current fact query failed', error) }
  }

  /** Lists current episodic records for one exact logical room. */
  currentEpisodes(logicalRoomId: EpisodicRecord['logicalRoomId']): readonly EpisodicRecord[] {
    try { return (this.db.prepare('SELECT * FROM episodic_repository_records WHERE logical_room_id=? AND tombstoned_by IS NULL AND valid_until IS NULL ORDER BY occurred_at,episodic_id').all(logicalRoomId) as SqlRow[]).map(row => this.episodic(row)) }
    catch (error) { persistence('SQLite current episodic listing failed', error) }
  }

  /** Lists episodic records eligible at a historical instant using half-open validity. */
  episodesAsOf(logicalRoomId: EpisodicRecord['logicalRoomId'], at: Timestamp): readonly EpisodicRecord[] {
    asTimestamp(String(at))
    try { return (this.db.prepare('SELECT * FROM episodic_repository_records WHERE logical_room_id=? AND tombstoned_by IS NULL AND valid_from<=? AND (valid_until IS NULL OR valid_until>?) ORDER BY occurred_at,episodic_id').all(logicalRoomId, at, at) as SqlRow[]).map(row => this.episodic(row)) }
    catch (error) { persistence('SQLite as-of episodic listing failed', error) }
  }

  private create<T>(table: string, idColumn: string, id: string, input: T, insert: () => void, get: () => T | undefined): CreateMemoryResult<T> {
    const hash = immutableHash(input)
    try {
      this.db.exec('BEGIN IMMEDIATE'); const existing = this.db.prepare(`SELECT input_hash FROM ${table} WHERE ${idColumn}=?`).get(id) as { input_hash: string } | undefined
      if (existing) { if (existing.input_hash !== hash) throw new MemoryError('POLICY_VIOLATION', 'memory identity was reused with conflicting input'); const record = get()!; this.db.exec('COMMIT'); return { record, deduplicated: true } }
      insert(); const record = get()!; this.db.exec('COMMIT'); return { record, deduplicated: false }
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite layered-memory creation failed and was rolled back', error) }
  }

  private one<T>(table: string, column: string, id: string, reconstruct: (row: SqlRow) => T): T | undefined {
    try { const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${column}=?`).get(id) as SqlRow | undefined; return row ? reconstruct(row) : undefined }
    catch (error) { persistence('SQLite layered-memory lookup failed', error) }
  }

  private fact(row: SqlRow): SemanticFact { const id = asFactId(String(row.fact_id)); return { layer: 'semantic', factId: id, ...(row.person_id == null ? {} : { personId: asPersonId(String(row.person_id)) }), scopeKind: String(row.scope_kind) as SemanticFact['scopeKind'], ...(row.scope_id == null ? {} : { scopeId: String(row.scope_id) }), predicate: String(row.predicate), value: String(row.value), confidence: asConfidence(Number(row.confidence)), provenance: reconstructProvenance(this.db, 'semantic', id, row), validity: validity(row), ...(row.supersedes == null ? {} : { supersedes: asFactId(String(row.supersedes)) }), ...(row.superseded_by == null ? {} : { supersededBy: asFactId(String(row.superseded_by)) }), ...(row.tombstoned_by == null ? {} : { tombstonedBy: asGovernanceId(String(row.tombstoned_by)) }) } }
  private episodic(row: SqlRow): EpisodicRecord { const id = asFactId(String(row.episodic_id)); return { layer: 'episodic', episodicId: id, ...(row.person_id == null ? {} : { personId: asPersonId(String(row.person_id)) }), logicalRoomId: asLogicalRoomId(String(row.logical_room_id)), occurredAt: asTimestamp(String(row.occurred_at)), summary: String(row.summary), provenance: reconstructProvenance(this.db, 'episodic', id, row), validity: validity(row), ...(row.tombstoned_by == null ? {} : { tombstonedBy: asGovernanceId(String(row.tombstoned_by)) }) } }
  private procedure(row: SqlRow): ProceduralRule { const id = asFactId(String(row.proc_id)); return { layer: 'procedural', procId: id, rule: String(row.rule), provenance: reconstructProvenance(this.db, 'procedural', id, row), validity: validity(row), ...(row.tombstoned_by == null ? {} : { tombstonedBy: asGovernanceId(String(row.tombstoned_by)) }) } }
}
