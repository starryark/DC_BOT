import type { DatabaseSync } from 'node:sqlite'

import { deletionTarget, verifyDeletionTarget } from './deletion-targets.js'

/**
 * How one storage class answers deletion, retention, and restore.
 *
 * The allowed dispositions are the census vocabulary: every durable class the
 * schema can hold appears in {@link deletionCompletenessReport} with exactly
 * one of these, so "complete" means every class is enumerated — never merely
 * that every row in DELETION_TARGET_TABLES passed.
 */
export type DeletionCompletenessDisposition
  = | 'redact-on-deletion'
    | 'tombstone-on-deletion'
    | 'content-emptied-on-deletion'
    | 'index-purged-and-canonically-gated'
    | 'retained-content-free-governance-evidence'
    | 'retained-identity-authority'
    | 'retained-addressing-authority'
    | 'retained-room-and-binding-authority'
    | 'retained-operator-policy'
    | 'dormant-legacy-not-served'
    | 'feature-absent'
    /**
     * A real, content-bearing store that exists outside this database and whose
     * lifecycle this package cannot observe. Distinct from `feature-absent`,
     * which asserts there is nothing there at all: naming an external store
     * absent would be the census claiming completeness it has not established.
     * Every class carrying this disposition is listed in
     * {@link DeletionCompletenessReport.externallyOwnedClasses}, and its owner
     * must be consulted before any completeness claim is made.
     */
    | 'external-content-bearing-storage'

export interface DeletionCompletenessClass {
  readonly storageClass: string
  readonly tables: readonly string[]
  readonly disposition: DeletionCompletenessDisposition
  readonly reason: string
  /** Machine-checked invariant for this class where one exists; absent otherwise. */
  readonly check?: { readonly name: string, readonly passed: boolean }
}

export interface DeletionCompletenessReport {
  readonly classes: readonly DeletionCompletenessClass[]
  /** Every completed forget/retention request's tombstones still verify. */
  readonly verifiedObligations: { readonly requests: number, readonly tombstones: number, readonly passed: boolean }
  /**
   * No lexical index row points at a canonical record whose deletion
   * completed (redacted, tombstoned, stale, emptied, or undelivered), at a
   * tombstoned target, or at no canonical record at all — so a surviving or
   * reconstructed index row cannot serve deleted content. Superseded and
   * time-expired rows are excluded here by design: they remain serveable only
   * to explicitly authorized as-of queries and never at current time.
   */
  readonly lexicalIndexConsistent: boolean
  /** No vector/graph store exists in this database. */
  readonly optionalStoresAbsent: boolean
  /**
   * Enumerated classes whose content lives outside this database.
   *
   * This report is authoritative for every other class and deliberately not for
   * these: their state is filesystem state, and a SQLite package that inspected
   * it would own knowledge it has no business holding. A caller that combines
   * this report with their owners' state can claim deletion completeness; this
   * report alone cannot.
   */
  readonly externallyOwnedClasses: readonly string[]
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count
}

function ftsInconsistentRows(db: DatabaseSync, table: 'memory_search_latin' | 'memory_search_cjk'): number {
  // Deletion-leak invariant, deliberately narrower than the serving filter:
  // superseded and time-expired canonical rows keep index rows for authorized
  // as-of queries and are excluded from current serving by the query-time
  // temporal filters. What must never remain indexed is content whose deletion
  // completed (redacted, tombstoned, stale, emptied, undelivered), content
  // under a deletion tombstone, or an index row with no canonical record.
  return count(db, `
    SELECT count(*) count FROM ${table} s
    WHERE EXISTS (
      SELECT 1 FROM inbound_event_records r WHERE s.target_table='inbound_event_records' AND s.target_id=r.event_id
        AND json_extract(r.payload_json,'$.redacted') IS 1
    )
    OR EXISTS (
      SELECT 1 FROM semantic_fact_repository_records r WHERE s.target_table='semantic_fact_repository_records' AND s.target_id=r.fact_id
        AND r.tombstoned_by IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM episodic_repository_records r WHERE s.target_table='episodic_repository_records' AND s.target_id=r.episodic_id
        AND r.tombstoned_by IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM summary_repository_records r WHERE s.target_table='summary_repository_records' AND s.target_id=r.summary_id
        AND r.tombstoned_by IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM procedural_repository_records r WHERE s.target_table='procedural_repository_records' AND s.target_id=r.proc_id
        AND r.tombstoned_by IS NOT NULL
    )
    OR EXISTS (
      SELECT 1 FROM output_segment_records r WHERE s.target_table='output_segment_records' AND s.target_id=r.segment_id
        AND (r.exact_text='' OR NOT EXISTS (SELECT 1 FROM delivery_attempt_records d WHERE d.segment_id=r.segment_id AND d.current_state IN ('delivered','reconciled')))
    )
    OR EXISTS (
      SELECT 1 FROM deletion_tombstones t WHERE t.target_table=s.target_table AND t.target_id=s.target_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM inbound_event_records r WHERE s.target_table='inbound_event_records' AND s.target_id=r.event_id
    ) AND NOT EXISTS (
      SELECT 1 FROM semantic_fact_repository_records r WHERE s.target_table='semantic_fact_repository_records' AND s.target_id=r.fact_id
    ) AND NOT EXISTS (
      SELECT 1 FROM episodic_repository_records r WHERE s.target_table='episodic_repository_records' AND s.target_id=r.episodic_id
    ) AND NOT EXISTS (
      SELECT 1 FROM summary_repository_records r WHERE s.target_table='summary_repository_records' AND s.target_id=r.summary_id
    ) AND NOT EXISTS (
      SELECT 1 FROM procedural_repository_records r WHERE s.target_table='procedural_repository_records' AND s.target_id=r.proc_id
    ) AND NOT EXISTS (
      SELECT 1 FROM output_segment_records r WHERE s.target_table='output_segment_records' AND s.target_id=r.segment_id
    )
  `)
}

/**
 * Enumerates every storage class reachable from the migration manifest with
 * its deletion/retention/restore disposition and the machine-checked
 * invariants that make "complete" falsifiable. Content-free: counts and
 * booleans only, no subject content.
 *
 * Enumeration is complete; verification is not, and the difference is
 * deliberate. Classes marked `external-content-bearing-storage` are named here
 * and reported in {@link DeletionCompletenessReport.externallyOwnedClasses},
 * but their content is not in this database and their state must come from
 * whoever owns it before completeness is claimed.
 */
export function deletionCompletenessReport(db: DatabaseSync): DeletionCompletenessReport {
  let requests = 0
  let tombstones = 0
  let obligationsPassed = true
  const completed = db.prepare(`SELECT forget_request_id FROM forget_requests WHERE status='completed'`).all() as Array<{ forget_request_id: string }>
  requests = completed.length
  for (const request of completed) {
    const targets = db.prepare('SELECT target_table,target_id FROM deletion_tombstones WHERE forget_request_id=?').all(request.forget_request_id) as Array<{ target_table: string, target_id: string }>
    tombstones += targets.length
    for (const target of targets) {
      try {
        verifyDeletionTarget(db, deletionTarget(target.target_table, target.target_id))
      }
      catch {
        obligationsPassed = false
      }
    }
  }

  const retainedCounts = {
    identity: count(db, 'SELECT count(*) count FROM people') + count(db, 'SELECT count(*) count FROM actor_snapshots'),
    addressing: count(db, 'SELECT count(*) count FROM aliases'),
    operatorPolicy: count(db, 'SELECT count(*) count FROM procedural_repository_records'),
    legacy: count(db, 'SELECT count(*) count FROM events') + count(db, 'SELECT count(*) count FROM summaries') + count(db, 'SELECT count(*) count FROM semantic_memories') + count(db, 'SELECT count(*) count FROM episodic_memories'),
  }

  const classes: DeletionCompletenessClass[] = [
    { storageClass: 'inbound-subject-events', tables: ['inbound_event_records'], disposition: 'redact-on-deletion', reason: 'Forget and retention replace the payload with a content-free redaction marker; event identity, causality, and lifecycle evidence survive as governance evidence.', check: { name: 'no unredacted event inside completed obligations', passed: obligationsPassed } },
    { storageClass: 'semantic-facts', tables: ['semantic_fact_repository_records'], disposition: 'tombstone-on-deletion', reason: 'Correction supersedes; forget and retention tombstone. As-of/current reads and lexical serving exclude tombstoned, superseded, and expired facts.', check: { name: 'no live fact inside completed obligations', passed: obligationsPassed } },
    { storageClass: 'episodic-records', tables: ['episodic_repository_records'], disposition: 'tombstone-on-deletion', reason: 'Forget and retention tombstone; serving paths exclude tombstoned episodes.', check: { name: 'no live episode inside completed obligations', passed: obligationsPassed } },
    { storageClass: 'summaries', tables: ['summary_repository_records'], disposition: 'tombstone-on-deletion', reason: 'Shared summaries tombstone and mark stale when any persisted source member is deleted or expires; regeneration is an unrunnable obligation.', check: { name: 'no live summary inside completed obligations', passed: obligationsPassed } },
    { storageClass: 'output-segments', tables: ['output_segment_records'], disposition: 'content-emptied-on-deletion', reason: 'Segments causally linked to deleted or expired events have their text emptied; segment identity and delivery evidence survive.', check: { name: 'no non-empty segment inside completed obligations', passed: obligationsPassed } },
    { storageClass: 'lexical-indexes', tables: ['memory_search_latin', 'memory_search_cjk'], disposition: 'index-purged-and-canonically-gated', reason: 'Tombstone-insert triggers purge index rows, rebuildSearch prunes tombstoned targets, and query-time canonical lifecycle checks re-verify every hit independently.', check: { name: 'no index row over ineligible canonical record', passed: ftsInconsistentRows(db, 'memory_search_latin') === 0 && ftsInconsistentRows(db, 'memory_search_cjk') === 0 } },
    { storageClass: 'actor-and-identity-presentation', tables: ['people', 'external_identities', 'actor_snapshots', 'actor_snapshot_details', 'current_discord_profiles', 'current_discord_guild_profiles'], disposition: 'retained-identity-authority', reason: `Snowflake-keyed identity authority and event-time presentation snapshots; room-scoped deletion does not erase the identity record (${retainedCounts.identity} rows retained). Presentation is never an identity key.` },
    { storageClass: 'aliases-and-preferences', tables: ['aliases', 'alias_repository_records', 'alias_preferences', 'alias_evidence', 'alias_evidence_links'], disposition: 'retained-addressing-authority', reason: `Scoped addressing authority (${retainedCounts.addressing} rows retained); private aliases cannot enter guild predicates and duplicate aliases never merge people.` },
    { storageClass: 'rooms-and-bindings', tables: ['physical_room_records', 'logical_rooms', 'logical_room_repository_records', 'room_binding_records', 'room_binding_versions'], disposition: 'retained-room-and-binding-authority', reason: 'Room and authorization boundaries are control state, not subject content; physical-room display names are channel names.' },
    { storageClass: 'procedural-rules', tables: ['procedural_repository_records'], disposition: 'retained-operator-policy', reason: `Operator-authored rules (${retainedCounts.operatorPolicy} rows); not user-subject data, so subject deletion and retention leave them to operator policy.` },
    { storageClass: 'deletion-governance-evidence', tables: ['forget_requests', 'deletion_tombstones', 'privacy_operation_records', 'semantic_correction_records'], disposition: 'retained-content-free-governance-evidence', reason: 'Ids, hashes, states, and scope hashes only; intentionally survive subject deletion and are replayed into restored backups.', check: { name: 'all completed obligations verify', passed: obligationsPassed } },
    { storageClass: 'job-and-lifecycle-evidence', tables: ['worker_jobs', 'reconciliation_evidence_records', 'idempotency_records', 'inbound_event_lifecycle', 'generation_lifecycle_records', 'delivery_lifecycle_records'], disposition: 'retained-content-free-governance-evidence', reason: 'Content-free operation, lease, and transition evidence; payloads carry ids and policy versions only.' },
    { storageClass: 'generation-and-delivery-state', tables: ['generation_identifiers', 'generation_attempt_records', 'generation_snapshot_events', 'generation_causal_edges', 'generation_context_manifests', 'generation_context_manifest_items', 'generation_layered_context_manifests', 'delivery_attempt_records'], disposition: 'retained-content-free-governance-evidence', reason: 'Ids, hashes, revisions, states, and content-free selection manifests; they reference deleted records without carrying their content.' },
    { storageClass: 'provenance-edges', tables: ['memory_source_event_records', 'summary_source_event_records'], disposition: 'retained-content-free-governance-evidence', reason: 'Id-to-id derivation edges; they drive dependency invalidation and survive as audit.' },
    { storageClass: 'legacy-v1-contract-tables', tables: ['events', 'event_lifecycle', 'assistant_generations', 'context_snapshot_evidence', 'generation_causes', 'output_segments', 'delivery_attempts', 'voice_drains', 'summaries', 'semantic_memories', 'episodic_memories', 'procedural_memories', 'memory_provenance', 'corrections', 'physical_rooms', 'room_bindings', 'migration_runs', 'migration_source_records', 'legacy_unresolved_actors', 'identity_resolutions', 'legacy_room_resolutions', 'migration_record_maps'], disposition: 'dormant-legacy-not-served', reason: `Frozen v1 contract tables with no production reader or writer since the repository tables replaced them (${retainedCounts.legacy} rows); not on any serving or indexing path.` },
    { storageClass: 'vector-and-graph-stores', tables: [], disposition: 'feature-absent', reason: 'No vector or graph table exists in any schema version; the capabilities are hard-gated and rejected as UNSUPPORTED_CAPABILITY.', check: { name: 'no vector/graph tables present', passed: (db.prepare(`SELECT count(*) count FROM sqlite_master WHERE type='table' AND (name LIKE 'vector%' OR name LIKE '%embedding%' OR name LIKE 'graph%')`).get() as { count: number }).count === 0 } },
    { storageClass: 'degraded-write-spool', tables: [], disposition: 'external-content-bearing-storage', reason: 'Raw ingress evidence written to files under the runtime root while the authority is unusable. Replayed through the sole-writer boundary on recovery and erased by spool compaction once that is durable; unreplayed records are outside every deletion pass and are not backed up or restored with this database. Its state is filesystem state and is reported by the runtime that owns the directory.' },
  ]

  return {
    classes,
    verifiedObligations: { requests, tombstones, passed: obligationsPassed },
    lexicalIndexConsistent: classes.find(item => item.storageClass === 'lexical-indexes')!.check!.passed,
    optionalStoresAbsent: classes.find(item => item.storageClass === 'vector-and-graph-stores')!.check!.passed,
    externallyOwnedClasses: classes.filter(item => item.disposition === 'external-content-bearing-storage').map(item => item.storageClass),
  }
}
