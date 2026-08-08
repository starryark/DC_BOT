import type { DatabaseSync } from 'node:sqlite'

import type { MemoryHit, MemoryRecord, SearchMemoryInput, SearchMemoryOutput } from '@proj-airi/memory-domain'

import { Buffer } from 'node:buffer'

import { capabilityForLexicalQuery } from '@proj-airi/memory-domain'

export class SearchRepository {
  constructor(private readonly db: DatabaseSync) {}

  public searchMemory(input: SearchMemoryInput): SearchMemoryOutput {
    if (!input.modes.includes('lexical')) {
      return { hits: [], appliedModes: [], abstained: 'noAuthorizedEvidence' }
    }

    const capability = capabilityForLexicalQuery(input.query)
    const tableName = capability === 'fulltext_cjk' ? 'memory_search_cjk' : 'memory_search_latin'

    // Map domain layers to target tables
    const allowedTables = new Set<string>()
    if (input.layers.includes('raw')) {
      allowedTables.add('inbound_event_records')
      allowedTables.add('output_segment_records')
    }
    if (input.layers.includes('semantic')) {
      allowedTables.add('semantic_fact_repository_records')
    }
    if (input.layers.includes('episodic')) {
      allowedTables.add('episodic_repository_records')
    }
    if (input.layers.includes('summary')) {
      allowedTables.add('summary_repository_records')
    }
    if (input.layers.includes('procedural')) {
      allowedTables.add('procedural_repository_records')
    }

    if (allowedTables.size === 0) {
      return { hits: [], appliedModes: ['lexical'], abstained: 'noAuthorizedEvidence' }
    }

    const authScopes = []
    if (input.scope.kind === 'logical_room' && input.scope.id)
      authScopes.push(`"${Buffer.from(`logical_room:${input.scope.id}`).toString('hex').toUpperCase()}"`)
    if (input.scope.kind === 'character' && input.scope.id)
      authScopes.push(`"${Buffer.from(`character:${input.scope.id}`).toString('hex').toUpperCase()}"`)
    if (input.scope.kind === 'guild' && input.scope.id)
      authScopes.push(`"${Buffer.from(`guild:${input.scope.id}`).toString('hex').toUpperCase()}"`)
    if (input.scope.kind === 'dm' && input.scope.id)
      authScopes.push(`"${Buffer.from(`dm:${input.scope.id}`).toString('hex').toUpperCase()}"`)
    if (input.scope.kind === 'operator' && input.scope.id)
      authScopes.push(`"${Buffer.from(`operator:${input.scope.id}`).toString('hex').toUpperCase()}"`)
    authScopes.push(`"${Buffer.from(`${input.scope.kind}:`).toString('hex').toUpperCase()}"`) // Global for this kind
    authScopes.push(`"${Buffer.from(`platform:`).toString('hex').toUpperCase()}"`) // Platform wide

    const authScopeTerms = authScopes.join(' OR ')
    const userTerms = input.query.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ')
    if (!userTerms)
      return { hits: [], appliedModes: [], abstained: 'noAuthorizedEvidence' }

    const matchQuery = `auth_scope:(${authScopeTerms}) AND text_content:(${userTerms})`

    // Build the query
    // We join the source tables to enforce time boundaries and valid_until
    const sql = `
      SELECT
        s.target_id,
        s.target_table,
        bm25(${tableName}) AS score
      FROM ${tableName} s
      LEFT JOIN inbound_event_records r_evt ON s.target_table = 'inbound_event_records' AND s.target_id = r_evt.event_id
      LEFT JOIN semantic_fact_repository_records r_sem ON s.target_table = 'semantic_fact_repository_records' AND s.target_id = r_sem.fact_id
      LEFT JOIN episodic_repository_records r_epi ON s.target_table = 'episodic_repository_records' AND s.target_id = r_epi.episodic_id
      LEFT JOIN summary_repository_records r_sum ON s.target_table = 'summary_repository_records' AND s.target_id = r_sum.summary_id
      LEFT JOIN procedural_repository_records r_pro ON s.target_table = 'procedural_repository_records' AND s.target_id = r_pro.proc_id
      LEFT JOIN output_segment_records r_out ON s.target_table = 'output_segment_records' AND s.target_id = r_out.segment_id
      LEFT JOIN generation_attempt_records gen ON r_out.generation_id = gen.generation_id
      WHERE s.${tableName} MATCH ?
        AND (
          (s.target_table = 'semantic_fact_repository_records' AND r_sem.valid_until IS NULL)
          OR (s.target_table != 'semantic_fact_repository_records')
        )
        AND (
          (? IS NULL OR (
            (s.target_table = 'inbound_event_records' AND r_evt.occurred_at >= ?)
            OR (s.target_table = 'semantic_fact_repository_records' AND r_sem.valid_from >= ?)
            OR (s.target_table = 'episodic_repository_records' AND r_epi.valid_from >= ?)
            OR (s.target_table = 'summary_repository_records' AND r_sum.valid_from >= ?)
            OR (s.target_table = 'procedural_repository_records' AND r_pro.valid_from >= ?)
            OR (s.target_table = 'output_segment_records' AND gen.started_at >= ?)
          ))
        )
        AND (
          (? IS NULL OR (
            (s.target_table = 'inbound_event_records' AND r_evt.occurred_at <= ?)
            OR (s.target_table = 'semantic_fact_repository_records' AND r_sem.valid_from <= ?)
            OR (s.target_table = 'episodic_repository_records' AND r_epi.valid_from <= ?)
            OR (s.target_table = 'summary_repository_records' AND r_sum.valid_from <= ?)
            OR (s.target_table = 'procedural_repository_records' AND r_pro.valid_from <= ?)
            OR (s.target_table = 'output_segment_records' AND gen.started_at <= ?)
          ))
        )
      ORDER BY score ASC
      LIMIT ? OFFSET ?
    `

    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0
    const limit = input.limit

    const stmt = this.db.prepare(sql)
    const rows = stmt.all(
      matchQuery,
      // Since bindings
      input.since ?? null,
      input.since ?? null,
      input.since ?? null,
      input.since ?? null,
      input.since ?? null,
      input.since ?? null,
      input.since ?? null,
      // Until bindings
      input.until ?? null,
      input.until ?? null,
      input.until ?? null,
      input.until ?? null,
      input.until ?? null,
      input.until ?? null,
      input.until ?? null,
      limit,
      offset,
    ) as Array<{ target_id: string, target_table: string, score: number }>

    const hits: MemoryHit[] = []
    for (const row of rows) {
      if (!allowedTables.has(row.target_table))
        continue
      const record = this.loadRecord(row.target_table, row.target_id)
      if (!record)
        continue
      hits.push({
        mode: 'lexical',
        features: { bm25: row.score },
        record,
      })
    }

    return {
      hits,
      appliedModes: ['lexical'],
      nextCursor: rows.length === limit ? (offset + limit).toString() : undefined,
    }
  }

  private loadRecord(table: string, id: string): MemoryRecord | null {
    if (table === 'inbound_event_records') {
      const row = this.db.prepare('SELECT event_id, payload_json, occurred_at FROM inbound_event_records WHERE event_id = ?').get(id) as any
      if (!row)
        return null
      return { layer: 'raw', eventId: row.event_id, occurredAt: row.occurred_at, ...JSON.parse(row.payload_json) } as unknown as MemoryRecord
    }
    if (table === 'output_segment_records') {
      const row = this.db.prepare('SELECT segment_id, exact_text, generation_id FROM output_segment_records WHERE segment_id = ?').get(id) as any
      if (!row)
        return null
      return { layer: 'raw', segmentId: row.segment_id, generationId: row.generation_id, text: row.exact_text } as unknown as MemoryRecord
    }
    if (table === 'semantic_fact_repository_records') {
      const row = this.db.prepare('SELECT fact_id, predicate, value, confidence, scope_kind, scope_id, valid_from, valid_until, provenance_source, extraction_method, stated_at, authored_by, input_hash FROM semantic_fact_repository_records WHERE fact_id = ?').get(id) as any
      if (!row)
        return null
      return {
        layer: 'semantic',
        factId: row.fact_id,
        predicate: row.predicate,
        value: row.value,
        confidence: row.confidence,
        scopeKind: row.scope_kind,
        scopeId: row.scope_id,
        validity: { validFrom: row.valid_from, validUntil: row.valid_until },
        provenance: { source: row.provenance_source, extractionMethod: row.extraction_method, statedAt: row.stated_at, authoredBy: row.authored_by, inputHash: row.input_hash, sourceEventIds: [] },
      } as unknown as MemoryRecord
    }
    if (table === 'episodic_repository_records') {
      const row = this.db.prepare('SELECT episodic_id, summary, occurred_at FROM episodic_repository_records WHERE episodic_id = ?').get(id) as any
      if (!row)
        return null
      return { layer: 'episodic', episodicId: row.episodic_id, summary: row.summary, occurredAt: row.occurred_at, validity: { validFrom: row.occurred_at }, provenance: { source: 'derived', sourceEventIds: [] } } as unknown as MemoryRecord
    }
    if (table === 'summary_repository_records') {
      const row = this.db.prepare('SELECT summary_id, text FROM summary_repository_records WHERE summary_id = ?').get(id) as any
      if (!row)
        return null
      return { layer: 'summary', summaryId: row.summary_id, text: row.text, validity: { validFrom: '' }, provenance: { source: 'derived', sourceEventIds: [] } } as unknown as MemoryRecord
    }
    if (table === 'procedural_repository_records') {
      const row = this.db.prepare('SELECT proc_id, rule FROM procedural_repository_records WHERE proc_id = ?').get(id) as any
      if (!row)
        return null
      return { layer: 'procedural', procId: row.proc_id, rule: row.rule, validity: { validFrom: '' }, provenance: { source: 'operator', sourceEventIds: [] } } as unknown as MemoryRecord
    }
    return null
  }

  public rebuildSearch(): void {
    this.db.exec(`
      BEGIN TRANSACTION;

      DELETE FROM memory_search_latin;
      INSERT INTO memory_search_latin(memory_search_latin) VALUES('optimize');

      INSERT INTO memory_search_latin (text_content, auth_scope, target_table, target_id)
      SELECT json_extract(payload_json, '$.content'), hex('logical_room:' || logical_room_id), 'inbound_event_records', event_id
      FROM inbound_event_records;

      INSERT INTO memory_search_latin (text_content, auth_scope, target_table, target_id)
      SELECT value, hex(scope_kind || ':' || ifnull(scope_id, '')), 'semantic_fact_repository_records', fact_id
      FROM semantic_fact_repository_records;

      INSERT INTO memory_search_latin (text_content, auth_scope, target_table, target_id)
      SELECT summary, hex('logical_room:' || logical_room_id), 'episodic_repository_records', episodic_id
      FROM episodic_repository_records;

      INSERT INTO memory_search_latin (text_content, auth_scope, target_table, target_id)
      SELECT text, hex('logical_room:' || logical_room_id), 'summary_repository_records', summary_id
      FROM summary_repository_records;

      INSERT INTO memory_search_latin (text_content, auth_scope, target_table, target_id)
      SELECT rule, hex('operator:'), 'procedural_repository_records', proc_id
      FROM procedural_repository_records;

      INSERT INTO memory_search_latin (text_content, auth_scope, target_table, target_id)
      SELECT o.exact_text, hex('logical_room:' || g.logical_room_id), 'output_segment_records', o.segment_id
      FROM output_segment_records o
      JOIN generation_attempt_records g ON g.generation_id = o.generation_id
      JOIN delivery_attempt_records d ON d.segment_id = o.segment_id
      WHERE d.current_state IN ('delivered', 'reconciled');

      DELETE FROM memory_search_latin WHERE target_table || ':' || target_id IN (SELECT target_table || ':' || target_id FROM deletion_tombstones);

      DELETE FROM memory_search_cjk;
      INSERT INTO memory_search_cjk(memory_search_cjk) VALUES('optimize');

      INSERT INTO memory_search_cjk (text_content, auth_scope, target_table, target_id)
      SELECT json_extract(payload_json, '$.content'), hex('logical_room:' || logical_room_id), 'inbound_event_records', event_id
      FROM inbound_event_records;

      INSERT INTO memory_search_cjk (text_content, auth_scope, target_table, target_id)
      SELECT value, hex(scope_kind || ':' || ifnull(scope_id, '')), 'semantic_fact_repository_records', fact_id
      FROM semantic_fact_repository_records;

      INSERT INTO memory_search_cjk (text_content, auth_scope, target_table, target_id)
      SELECT summary, hex('logical_room:' || logical_room_id), 'episodic_repository_records', episodic_id
      FROM episodic_repository_records;

      INSERT INTO memory_search_cjk (text_content, auth_scope, target_table, target_id)
      SELECT text, hex('logical_room:' || logical_room_id), 'summary_repository_records', summary_id
      FROM summary_repository_records;

      INSERT INTO memory_search_cjk (text_content, auth_scope, target_table, target_id)
      SELECT rule, hex('operator:'), 'procedural_repository_records', proc_id
      FROM procedural_repository_records;

      INSERT INTO memory_search_cjk (text_content, auth_scope, target_table, target_id)
      SELECT o.exact_text, hex('logical_room:' || g.logical_room_id), 'output_segment_records', o.segment_id
      FROM output_segment_records o
      JOIN generation_attempt_records g ON g.generation_id = o.generation_id
      JOIN delivery_attempt_records d ON d.segment_id = o.segment_id
      WHERE d.current_state IN ('delivered', 'reconciled');

      DELETE FROM memory_search_cjk WHERE target_table || ':' || target_id IN (SELECT target_table || ':' || target_id FROM deletion_tombstones);

      COMMIT TRANSACTION;
    `)
  }
}
