/**
 * The memory layers (IMP-108; ADR-008).
 *
 * Six record types, deliberately not one table with a `type` column. A summary
 * is not a fact, an episodic recollection is not a transcript, and operator
 * procedure is not user truth. Collapsing them is how a model-written summary
 * ends up quoted as something a person said (REQ-MEM-001, AC-023).
 */

import type { EventId, FactId, GovernanceId, LogicalRoomId, PersonId, SummaryId, Timestamp } from './ids'
import type { Confidence, Provenance, TemporalValidity } from './provenance'

import { MemoryError } from './errors'
import { assertDurableProvenance } from './provenance'

/** The layers, in order of derivation distance from raw evidence. */
export type MemoryLayer = 'raw' | 'recent' | 'summary' | 'semantic' | 'episodic' | 'procedural'

export const MEMORY_LAYERS: readonly MemoryLayer[] = Object.freeze([
  'raw',
  'recent',
  'summary',
  'semantic',
  'episodic',
  'procedural',
])

/**
 * Layers that are *derived* and must be regenerated or dropped when their
 * sources change. The deletion cascade walks exactly this set (ADR-012).
 */
export const DERIVED_LAYERS: readonly MemoryLayer[] = Object.freeze(['recent', 'summary', 'semantic', 'episodic'])

/** Fields every non-raw memory record carries. */
interface MemoryRecordBase {
  provenance: Provenance
  validity: TemporalValidity
  /** Set once a governance action erased this record's content. */
  tombstonedBy?: GovernanceId
}

/** True when the record has been erased and must not be retrieved. */
export function isTombstoned(record: MemoryRecordBase): boolean {
  return record.tombstonedBy != null
}

/** A compressed view of a window of events, produced off the critical path. */
export interface SummaryRecord extends MemoryRecordBase {
  layer: 'summary'
  summaryId: SummaryId
  logicalRoomId: LogicalRoomId
  /** Every event the summary covers, so deletion can find and rebuild it. */
  sourceEventIds: readonly EventId[]
  text: string
  /** Model + prompt version, so a regenerated summary is comparable. */
  modelRef: string
  /** Set when a source changed and the summary has not been rebuilt yet. */
  stale: boolean
  supersededBy?: SummaryId
}

/** A durable assertion about a person, with a supersession chain. */
export interface SemanticFact extends MemoryRecordBase {
  layer: 'semantic'
  factId: FactId
  /** Absent only for room-scoped facts that assert nothing about a person. */
  personId?: PersonId
  /** Which scope the fact is authorized within. */
  scopeKind: 'platform' | 'character' | 'guild' | 'logical_room' | 'dm'
  scopeId?: string
  predicate: string
  value: string
  confidence: Confidence
  /** The fact this one replaces, forming the correction chain. */
  supersedes?: FactId
  supersededBy?: FactId
}

/** A structured recollection of a specific occurrence. */
export interface EpisodicRecord extends MemoryRecordBase {
  layer: 'episodic'
  episodicId: FactId
  personId?: PersonId
  logicalRoomId: LogicalRoomId
  occurredAt: Timestamp
  summary: string
}

/**
 * An operator-authored rule.
 *
 * Procedural memory is the only layer the model may treat as instruction, which
 * is exactly why its author is checked: user-stated text must never become
 * procedure by wording alone (`21-…` §15.11, FIND-021).
 */
export interface ProceduralRule extends MemoryRecordBase {
  layer: 'procedural'
  procId: FactId
  rule: string
}

export type MemoryRecord = SummaryRecord | SemanticFact | EpisodicRecord | ProceduralRule

/**
 * Validate a semantic fact before it is written.
 *
 * Checks the two things a schema cannot: that the provenance supports a durable
 * assertion, and that the fact says something. An empty predicate or value is
 * a extraction bug that would otherwise be retrieved as authoritative nothing.
 */
export function assertWritableFact(fact: SemanticFact): void {
  assertDurableProvenance(fact.provenance)
  if (fact.predicate.trim().length === 0 || fact.value.trim().length === 0) {
    throw new MemoryError('MISSING_VALUE', 'a semantic fact requires a non-empty predicate and value', {
      retryable: false,
      details: { factId: fact.factId },
    })
  }
}

/**
 * Validate a procedural rule.
 *
 * Only `operator` provenance may create procedure. A rule derived from user
 * text, however imperative it sounds, is a fact about what a user said — not an
 * instruction the bot must follow.
 */
export function assertWritableProcedure(rule: ProceduralRule): void {
  if (rule.provenance.source !== 'operator') {
    throw new MemoryError('POLICY_VIOLATION', 'procedural memory may only be authored by an operator', {
      retryable: false,
      details: { source: rule.provenance.source, procId: rule.procId },
    })
  }
  assertDurableProvenance(rule.provenance)
}

/**
 * Which derived records must be revisited when a source event is erased.
 *
 * Returns the summaries that cite the event and the facts whose provenance
 * cites it. This is the lineage closure the deletion manifest is built from —
 * a record that cannot be found here is a record that survives deletion
 * (FIND-020, TEST-DELETE-DERIVED-001).
 */
export function derivedFrom(records: readonly MemoryRecord[], eventId: EventId): readonly MemoryRecord[] {
  return records.filter((record) => {
    if (record.provenance.sourceEventIds.includes(eventId))
      return true
    return record.layer === 'summary' && record.sourceEventIds.includes(eventId)
  })
}
