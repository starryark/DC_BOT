import type { DatabaseSync } from 'node:sqlite'

import { MemoryError } from '@proj-airi/memory-domain'

export const DELETION_TARGET_TABLES = [
  'inbound_event_records',
  'semantic_fact_repository_records',
  'episodic_repository_records',
  'summary_repository_records',
  'output_segment_records',
] as const

export type DeletionTargetTable = typeof DELETION_TARGET_TABLES[number]
export interface DeletionTarget { readonly targetTable: DeletionTargetTable, readonly targetId: string }

const TARGETS: Record<DeletionTargetTable, { apply: string, verify: string }> = {
  inbound_event_records: { apply: `UPDATE inbound_event_records SET payload_json=json_object('redacted',json('true')) WHERE event_id=?`, verify: `SELECT count(*) count FROM inbound_event_records WHERE event_id=? AND json_extract(payload_json,'$.redacted') IS NOT 1` },
  semantic_fact_repository_records: { apply: `UPDATE semantic_fact_repository_records SET tombstoned_by=coalesce(tombstoned_by,?) WHERE fact_id=?`, verify: `SELECT count(*) count FROM semantic_fact_repository_records WHERE fact_id=? AND tombstoned_by IS NULL` },
  episodic_repository_records: { apply: `UPDATE episodic_repository_records SET tombstoned_by=coalesce(tombstoned_by,?) WHERE episodic_id=?`, verify: `SELECT count(*) count FROM episodic_repository_records WHERE episodic_id=? AND tombstoned_by IS NULL` },
  summary_repository_records: { apply: `UPDATE summary_repository_records SET stale=1,tombstoned_by=coalesce(tombstoned_by,?) WHERE summary_id=?`, verify: `SELECT count(*) count FROM summary_repository_records WHERE summary_id=? AND (stale<>1 OR tombstoned_by IS NULL)` },
  output_segment_records: { apply: `UPDATE output_segment_records SET exact_text='' WHERE segment_id=?`, verify: `SELECT count(*) count FROM output_segment_records WHERE segment_id=? AND exact_text<>''` },
}

export function isDeletionTargetTable(value: string): value is DeletionTargetTable {
  return Object.hasOwn(TARGETS, value)
}

/** Applies one registered content-removal operation; unknown targets are always refused. */
export function applyDeletionTarget(database: DatabaseSync, target: DeletionTarget, obligationId: string): void {
  const spec = TARGETS[target.targetTable]
  const values = target.targetTable === 'inbound_event_records' || target.targetTable === 'output_segment_records'
    ? [target.targetId]
    : [obligationId, target.targetId]
  database.prepare(spec.apply).run(...values)
}

/** Verifies that one registered target has no accessible content remaining. */
export function verifyDeletionTarget(database: DatabaseSync, target: DeletionTarget): void {
  const remaining = database.prepare(TARGETS[target.targetTable].verify).get(target.targetId) as { count: number }
  if (remaining.count !== 0)
    throw new MemoryError('PERSISTENCE_FAILED', `deletion verification failed for ${target.targetTable}:${target.targetId}`)
}

export function deletionTarget(targetTable: string, targetId: string): DeletionTarget {
  if (!isDeletionTargetTable(targetTable))
    throw new MemoryError('POLICY_VIOLATION', `unsupported deletion obligation target: ${targetTable}`)
  return { targetTable, targetId }
}
