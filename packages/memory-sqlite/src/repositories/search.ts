import type { DatabaseSync } from 'node:sqlite'

import type { MemoryHit, MemoryRecord, SearchMemoryInput, SearchMemoryOutput } from '@proj-airi/memory-domain'

import { Buffer } from 'node:buffer'

import { asFactId, asSummaryId, capabilityForLexicalQuery } from '@proj-airi/memory-domain'

import { MemoryRepository } from './memories.js'
import { SummaryRepository } from './summaries.js'

/**
 * The two FTS5 indexes, interpolated into DDL/DML by name.
 *
 * A module constant of literals rather than a parameter: SQLite cannot bind a
 * table name, so these reach the statement by string interpolation and must
 * never be reachable from caller input. Keeping the list private to this module
 * is the whole safety argument — `rebuildSearch()` takes no arguments precisely
 * so there is nothing for a caller to inject.
 */
const SEARCH_INDEX_TABLES = ['memory_search_latin', 'memory_search_cjk'] as const

/**
 * What each durable record contributes to a lexical index: its searchable text,
 * its authorization scope, and its identity.
 *
 * Column order is fixed by the shared `INSERT` in {@link SearchRepository.rebuildSearch}:
 * `(text_content, auth_scope, target_table, target_id)`.
 *
 * `auth_scope` is `hex()`-encoded because it is matched as an FTS token, and the
 * raw scope strings contain `:` and other characters the tokenizer would split
 * on — a `logical_room:123` scope must match as one indivisible term or a query
 * could match half of it.
 */
const SEARCH_SOURCE_PROJECTIONS: readonly string[] = [
  `SELECT json_extract(payload_json, '$.content'), hex('logical_room:' || logical_room_id), 'inbound_event_records', event_id
   FROM inbound_event_records`,

  // Superseded facts keep their rows and are filtered at query time by
  // valid_until, so the rebuild indexes them all.
  `SELECT value, hex(scope_kind || ':' || ifnull(scope_id, '')), 'semantic_fact_repository_records', fact_id
   FROM semantic_fact_repository_records`,

  `SELECT summary, hex('logical_room:' || logical_room_id), 'episodic_repository_records', episodic_id
   FROM episodic_repository_records`,

  `SELECT text, hex('logical_room:' || logical_room_id), 'summary_repository_records', summary_id
   FROM summary_repository_records`,

  // Operator-authored rules are not room-scoped; they carry the global
  // 'operator:' scope with no id.
  `SELECT rule, hex('operator:'), 'procedural_repository_records', proc_id
   FROM procedural_repository_records`,

  // The bot's own output is searchable only once it actually reached someone.
  // A generated-but-undelivered segment is not conversational context, so the
  // delivery-state join is an eligibility rule, not an optimization — it is the
  // same condition the v9 fts_delivery_* triggers fire on.
  `SELECT o.exact_text, hex('logical_room:' || g.logical_room_id), 'output_segment_records', o.segment_id
   FROM output_segment_records o
   JOIN generation_attempt_records g ON g.generation_id = o.generation_id
   JOIN delivery_attempt_records d ON d.segment_id = o.segment_id
   WHERE d.current_state IN ('delivered', 'reconciled')`,
]

export class SearchRepository {
  private readonly memories: MemoryRepository
  private readonly summaries: SummaryRepository

  constructor(private readonly db: DatabaseSync) {
    this.memories = new MemoryRepository(db)
    this.summaries = new SummaryRepository(db)
  }

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

    // Search one exact authorized scope. A logical-room authorization does not
    // imply platform-wide or scope-kind-wide access; broader records require a
    // separately authorized call naming that broader scope.
    const authScope = `${input.scope.kind}:${input.scope.id ?? ''}`
    const authScopes = [`"${Buffer.from(authScope).toString('hex').toUpperCase()}"`]

    const authScopeTerms = authScopes.join(' OR ')
    const userTerms = input.query.split(/\s+/).filter(Boolean).map(t => `"${t.replace(/"/g, '""')}"`).join(' AND ')
    if (!userTerms)
      return { hits: [], appliedModes: [], abstained: 'noAuthorizedEvidence' }

    const matchQuery = `auth_scope:(${authScopeTerms}) AND text_content:(${userTerms})`
    const temporalEligibility = (alias: string, currentOnly: string): string => input.until == null
      ? currentOnly
      : `${alias}.valid_from<=? AND (${alias}.valid_until IS NULL OR ${alias}.valid_until>?)`
    const historicalBindings = input.until == null ? [] : [input.until, input.until]
    const allowedTableNames = [...allowedTables].sort()

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
        AND s.target_table IN (${allowedTableNames.map(() => '?').join(',')})
        AND (
          (s.target_table = 'inbound_event_records' AND r_evt.event_id IS NOT NULL AND json_extract(r_evt.payload_json,'$.redacted') IS NOT 1)
          OR (s.target_table = 'semantic_fact_repository_records' AND r_sem.fact_id IS NOT NULL AND r_sem.tombstoned_by IS NULL AND ${temporalEligibility('r_sem', 'r_sem.superseded_by IS NULL AND r_sem.valid_until IS NULL')})
          OR (s.target_table = 'episodic_repository_records' AND r_epi.episodic_id IS NOT NULL AND r_epi.tombstoned_by IS NULL AND ${temporalEligibility('r_epi', 'r_epi.valid_until IS NULL')})
          OR (s.target_table = 'summary_repository_records' AND r_sum.summary_id IS NOT NULL AND r_sum.tombstoned_by IS NULL AND r_sum.stale=0 AND ${temporalEligibility('r_sum', 'r_sum.superseded_by IS NULL AND r_sum.valid_until IS NULL')})
          OR (s.target_table = 'procedural_repository_records' AND r_pro.proc_id IS NOT NULL AND r_pro.tombstoned_by IS NULL AND ${temporalEligibility('r_pro', 'r_pro.valid_until IS NULL')})
          OR (s.target_table = 'output_segment_records' AND r_out.segment_id IS NOT NULL AND r_out.exact_text<>'' AND EXISTS (SELECT 1 FROM delivery_attempt_records eligible_delivery WHERE eligible_delivery.segment_id=r_out.segment_id AND eligible_delivery.current_state IN ('delivered','reconciled')))
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
      ...allowedTableNames,
      ...historicalBindings,
      ...historicalBindings,
      ...historicalBindings,
      ...historicalBindings,
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
      return this.memories.getFact(asFactId(id)) ?? null
    }
    if (table === 'episodic_repository_records') {
      return this.memories.getEpisodic(asFactId(id)) ?? null
    }
    if (table === 'summary_repository_records') {
      return this.summaries.get(asSummaryId(id)) ?? null
    }
    if (table === 'procedural_repository_records') {
      return this.memories.getProcedure(asFactId(id)) ?? null
    }
    return null
  }

  /**
   * Repopulate both lexical indexes from the durable records they mirror.
   *
   * The v9 triggers keep the indexes current during normal operation; this is
   * the recovery path for when they cannot have run — a database migrated from
   * before v9, or one whose index rows were lost. It is a full rebuild, so it
   * is O(corpus) and is not on any request path.
   */
  public rebuildSearch(): void {
    // Latin and CJK index the *same* rows under different tokenizers
    // (unicode61 vs trigram), so the projections below are shared and the
    // tokenizer is the only difference between the two rebuilds. The v9
    // triggers make exactly the same pairing per source table; keeping one
    // copy here is what stops a rebuilt index from disagreeing with a
    // trigger-maintained one about which rows or scopes exist.
    const rebuilds = SEARCH_INDEX_TABLES.map(table => `
      DELETE FROM ${table};
      INSERT INTO ${table}(${table}) VALUES('optimize');

      ${SEARCH_SOURCE_PROJECTIONS.map(projection => `
        INSERT INTO ${table} (text_content, auth_scope, target_table, target_id)
        ${projection};
      `).join('')}

      DELETE FROM ${table} WHERE target_table || ':' || target_id IN (SELECT target_table || ':' || target_id FROM deletion_tombstones);
    `)

    this.db.exec(`
      BEGIN TRANSACTION;
      ${rebuilds.join('')}
      COMMIT TRANSACTION;
    `)
  }
}
