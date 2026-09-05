import type { DatabaseSync } from 'node:sqlite'

import type { DeletionTarget } from './deletion-targets.js'

export type DerivedInvalidationCause
  = | { readonly kind: 'forget', readonly requestId: string, readonly personId: string, readonly logicalRoomId: string }
    | { readonly kind: 'correction', readonly correctionId: string, readonly supersededFactId: string, readonly replacementFactId: string }
    | { readonly kind: 'retention', readonly policyId: string, readonly targets: readonly DeletionTarget[] }
    | { readonly kind: 'repair', readonly repairId: string, readonly targetIds: readonly string[] }

export interface RegenerationObligation {
  readonly kind: 'summary'
  readonly recordId: string
  readonly reason: DerivedInvalidationCause['kind']
  readonly runnable: false
}

export interface UnresolvedInvalidationObligation {
  readonly kind: 'represented_dependency'
  readonly recordId: string
  readonly reason: DerivedInvalidationCause['kind']
}

/** A content-free, deterministic description of represented invalidation work. */
export interface DerivedInvalidationPlan {
  readonly cause: DerivedInvalidationCause
  readonly authoritativeTargets: readonly DeletionTarget[]
  readonly derivedTargets: readonly DeletionTarget[]
  readonly regenerationObligations: readonly RegenerationObligation[]
  readonly unresolvedObligations: readonly UnresolvedInvalidationObligation[]
}

function orderedUnique(targets: readonly DeletionTarget[]): readonly DeletionTarget[] {
  return [...new Map(targets.map(target => [`${target.targetTable}:${target.targetId}`, target])).values()]
    .sort((left, right) => left.targetTable.localeCompare(right.targetTable) || left.targetId.localeCompare(right.targetId))
}

/**
 * Discovers invalidation only through durable ownership and provenance edges.
 * Causes without a represented dependency intentionally produce an empty plan.
 */
export class DerivedInvalidationPlanner {
  constructor(private readonly db: DatabaseSync) {}

  plan(cause: DerivedInvalidationCause): DerivedInvalidationPlan {
    if (cause.kind === 'forget') {
      const eventScope = `SELECT event_id FROM inbound_event_records WHERE author_person_id=? AND logical_room_id=? AND json_extract(payload_json,'$.redacted') IS NOT 1`
      const params = [cause.personId, cause.logicalRoomId] as const
      const authoritativeTargets = orderedUnique((this.db.prepare(eventScope).all(...params) as Array<{ event_id: string }>).map(row => ({ targetTable: 'inbound_event_records', targetId: row.event_id })))
      return this.planFromEvents(cause, authoritativeTargets, eventScope, [...params], {
        facts: { sql: `(person_id=? AND scope_kind='logical_room' AND scope_id=?) OR `, bindings: [...params] },
        episodic: { sql: `(person_id=? AND logical_room_id=?) OR `, bindings: [...params] },
        segments: { sql: 'g.logical_room_id=? AND ', bindings: [cause.logicalRoomId] },
      })
    }
    if (cause.kind === 'retention') {
      // The authoritative targets were selected by age under a versioned policy.
      // Dependency discovery still runs so a representation of an expired
      // source record cannot survive it merely by being younger than the rule;
      // here ownership prefixes do not apply, because an expired event's
      // dependents are found by provenance edges regardless of who owns them.
      const authoritativeTargets = orderedUnique(cause.targets)
      const eventIds = authoritativeTargets.filter(target => target.targetTable === 'inbound_event_records').map(target => target.targetId)
      const eventScope = eventIds.length === 0 ? 'SELECT event_id FROM inbound_event_records WHERE 0' : `SELECT event_id FROM inbound_event_records WHERE event_id IN (${eventIds.map(() => '?').join(',')})`
      const planned = this.planFromEvents(cause, authoritativeTargets, eventScope, eventIds, {
        facts: { sql: '', bindings: [] },
        episodic: { sql: '', bindings: [] },
        segments: { sql: '', bindings: [] },
      })
      // An authoritative target can also be edge-discovered (an aged fact whose
      // aged source event drags it in); a target is removed exactly once.
      const authoritative = new Set(authoritativeTargets.map(target => `${target.targetTable}:${target.targetId}`))
      const derivedTargets = planned.derivedTargets.filter(target => !authoritative.has(`${target.targetTable}:${target.targetId}`))
      const regenerationObligations = derivedTargets
        .filter(target => target.targetTable === 'summary_repository_records')
        .map(target => Object.freeze({ kind: 'summary' as const, recordId: target.targetId, reason: 'retention' as const, runnable: false as const }))
      return Object.freeze({ cause, authoritativeTargets, derivedTargets, regenerationObligations, unresolvedObligations: [] })
    }
    return Object.freeze({ cause, authoritativeTargets: [], derivedTargets: [], regenerationObligations: [], unresolvedObligations: [] })
  }

  /** Shared forget/retention dependency closure over one authoritative event set. */
  private planFromEvents(
    cause: DerivedInvalidationCause,
    authoritativeTargets: readonly DeletionTarget[],
    eventScope: string,
    eventParams: readonly string[],
    owned: { facts: { sql: string, bindings: readonly string[] }, episodic: { sql: string, bindings: readonly string[] }, segments: { sql: string, bindings: readonly string[] } },
  ): DerivedInvalidationPlan {
    const derivedTargets: DeletionTarget[] = []
    const add = (targetTable: DeletionTarget['targetTable'], rows: readonly Record<string, string>[], field: string): void => {
      for (const row of rows)
        derivedTargets.push({ targetTable, targetId: row[field]! })
    }

    add('summary_repository_records', this.db.prepare(`SELECT summary_id FROM summary_repository_records WHERE tombstoned_by IS NULL AND summary_id IN (SELECT summary_id FROM summary_source_event_records WHERE source_event_id IN (${eventScope}))`).all(...eventParams) as Array<{ summary_id: string }>, 'summary_id')
    add('semantic_fact_repository_records', this.db.prepare(`SELECT fact_id FROM semantic_fact_repository_records WHERE tombstoned_by IS NULL AND (${owned.facts.sql}fact_id IN (SELECT memory_id FROM memory_source_event_records WHERE memory_kind='semantic' AND source_event_id IN (${eventScope})))`).all(...owned.facts.bindings, ...eventParams) as Array<{ fact_id: string }>, 'fact_id')
    add('episodic_repository_records', this.db.prepare(`SELECT episodic_id FROM episodic_repository_records WHERE tombstoned_by IS NULL AND (${owned.episodic.sql}episodic_id IN (SELECT memory_id FROM memory_source_event_records WHERE memory_kind='episodic' AND source_event_id IN (${eventScope})))`).all(...owned.episodic.bindings, ...eventParams) as Array<{ episodic_id: string }>, 'episodic_id')
    add('output_segment_records', this.db.prepare(`SELECT s.segment_id FROM output_segment_records s JOIN generation_attempt_records g ON g.generation_id=s.generation_id WHERE ${owned.segments.sql}s.exact_text<>'' AND EXISTS (SELECT 1 FROM generation_causal_edges e WHERE e.generation_id=g.generation_id AND e.inbound_event_id IN (${eventScope}))`).all(...owned.segments.bindings, ...eventParams) as Array<{ segment_id: string }>, 'segment_id')

    const orderedDerivedTargets = orderedUnique(derivedTargets)
    const regenerationObligations = orderedDerivedTargets
      .filter(target => target.targetTable === 'summary_repository_records')
      .map(target => Object.freeze({ kind: 'summary' as const, recordId: target.targetId, reason: cause.kind, runnable: false as const }))
    return Object.freeze({ cause, authoritativeTargets, derivedTargets: orderedDerivedTargets, regenerationObligations, unresolvedObligations: [] })
  }
}
