/* eslint-disable antfu/if-newline, perfectionist/sort-imports, perfectionist/sort-named-imports, style/brace-style, style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'
import type { CharacterId, ContextEligibilityPolicy, DeliveryAttempt, DeliveryEvidence, DeliveryId, DeliveryState, DeliveryTransition, LogicalRoomId, OutputSegment, PhysicalRoomId } from '@proj-airi/memory-domain'

import { createHash, randomUUID } from 'node:crypto'
import { asDeliveryId, asGenerationId, asRequestId, asSegmentId, asTimestamp, assertDeliveryTransition, eligibleSegmentText, MemoryError, STRICT_CONTEXT_ELIGIBILITY, UNRESOLVED_DELIVERY_STATES } from '@proj-airi/memory-domain'

export interface CreateDeliveryResult { attempt: DeliveryAttempt, deduplicated: boolean }
export interface EligibleAssistantOutput { segment: OutputSegment, text: string, attempt: DeliveryAttempt }
export interface ExactOutputScope { logicalRoomId: LogicalRoomId, physicalRoomId: PhysicalRoomId, characterId: CharacterId }
type Row = Record<string, string | number | null>

function persistence(message: string, cause: unknown): never { if (cause instanceof MemoryError) throw cause; throw new MemoryError('PERSISTENCE_FAILED', message, { cause }) }
const hash = (attempt: DeliveryAttempt): string => createHash('sha256').update(JSON.stringify(attempt)).digest('hex')
function attempt(row: Row): DeliveryAttempt { return { deliveryId: asDeliveryId(String(row.delivery_id)), segmentId: asSegmentId(String(row.segment_id)), transport: String(row.transport) as DeliveryAttempt['transport'], destinationId: String(row.destination_id), idempotencyKey: asRequestId(String(row.idempotency_key)), attemptNumber: Number(row.attempt_number), state: String(row.current_state) as DeliveryState, evidence: JSON.parse(String(row.current_evidence_json)) as DeliveryEvidence, startedAt: asTimestamp(String(row.started_at)), lastTransitionAt: asTimestamp(String(row.last_transition_at)) } }

/** Persists physical delivery attempts and append-only transition evidence without invoking a transport. */
export class DeliveryRepository {
  constructor(private readonly db: DatabaseSync, private readonly id: () => string = randomUUID) {}

  create(value: DeliveryAttempt): CreateDeliveryResult {
    if (value.state !== 'pending' || value.evidence.kind !== 'none' || value.lastTransitionAt !== value.startedAt) throw new MemoryError('INVALID_OUTCOME', 'a delivery attempt must begin pending with no evidence at its start time')
    const inputHash = hash(value)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const retry = this.db.prepare('SELECT * FROM delivery_attempt_records WHERE idempotency_key=?').get(value.idempotencyKey) as Row | undefined
      if (retry) { if (retry.input_hash !== inputHash) throw new MemoryError('POLICY_VIOLATION', 'delivery idempotency key was reused with conflicting input'); const saved = attempt(retry); this.db.exec('COMMIT'); return { attempt: saved, deduplicated: true } }
      this.db.prepare('INSERT INTO delivery_attempt_records VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(value.deliveryId, value.segmentId, value.transport, value.destinationId, value.idempotencyKey, value.attemptNumber, value.state, JSON.stringify(value.evidence), value.startedAt, value.lastTransitionAt, inputHash)
      this.db.prepare('INSERT INTO delivery_lifecycle_records VALUES (?,?,?,?,?,?,0)').run(this.id(), value.deliveryId, 'pending', 'pending', JSON.stringify(value.evidence), value.startedAt)
      const saved = attempt(this.db.prepare('SELECT * FROM delivery_attempt_records WHERE delivery_id=?').get(value.deliveryId) as Row)
      this.db.exec('COMMIT'); return { attempt: saved, deduplicated: false }
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite delivery creation failed and was rolled back', error) }
  }

  get(deliveryId: DeliveryId): DeliveryAttempt | undefined { try { const row = this.db.prepare('SELECT * FROM delivery_attempt_records WHERE delivery_id=?').get(deliveryId) as Row | undefined; return row ? attempt(row) : undefined } catch (error) { persistence('SQLite delivery lookup failed', error) } }
  forSegment(segmentId: OutputSegment['segmentId']): readonly DeliveryAttempt[] { try { return (this.db.prepare('SELECT * FROM delivery_attempt_records WHERE segment_id=? ORDER BY attempt_number,delivery_id').all(segmentId) as Row[]).map(attempt) } catch (error) { persistence('SQLite segment delivery lookup failed', error) } }
  unresolved(): readonly DeliveryAttempt[] { try { const marks = UNRESOLVED_DELIVERY_STATES.map(() => '?').join(','); return (this.db.prepare(`SELECT * FROM delivery_attempt_records WHERE current_state IN (${marks}) ORDER BY started_at,delivery_id`).all(...UNRESOLVED_DELIVERY_STATES) as Row[]).map(attempt) } catch (error) { persistence('SQLite unresolved delivery lookup failed', error) } }

  lifecycle(deliveryId: DeliveryId): readonly DeliveryTransition[] {
    try { return (this.db.prepare('SELECT from_state,to_state,evidence_json,transitioned_at FROM delivery_lifecycle_records WHERE delivery_id=? ORDER BY ordinal').all(deliveryId) as Array<{ from_state: DeliveryState, to_state: DeliveryState, evidence_json: string, transitioned_at: string }>).map(row => ({ deliveryId, from: row.from_state, to: row.to_state, evidence: JSON.parse(row.evidence_json) as DeliveryEvidence, at: asTimestamp(row.transitioned_at) })) }
    catch (error) { persistence('SQLite delivery lifecycle lookup failed', error) }
  }

  transition(value: DeliveryTransition): DeliveryAttempt {
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const row = this.db.prepare('SELECT * FROM delivery_attempt_records WHERE delivery_id=?').get(value.deliveryId) as Row | undefined
      if (!row) throw new MemoryError('TARGET_NOT_FOUND', 'delivery attempt does not exist')
      const current = attempt(row); assertDeliveryTransition(value, current.transport)
      if (current.state !== value.from) throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'delivery lifecycle precondition is stale')
      const ordinal = (this.db.prepare('SELECT MAX(ordinal) ordinal FROM delivery_lifecycle_records WHERE delivery_id=?').get(value.deliveryId) as { ordinal: number }).ordinal + 1
      this.db.prepare('UPDATE delivery_attempt_records SET current_state=?,current_evidence_json=?,last_transition_at=? WHERE delivery_id=?').run(value.to, JSON.stringify(value.evidence), value.at, value.deliveryId)
      this.db.prepare('INSERT INTO delivery_lifecycle_records VALUES (?,?,?,?,?,?,?)').run(this.id(), value.deliveryId, value.from, value.to, JSON.stringify(value.evidence), value.at, ordinal)
      const saved = attempt(this.db.prepare('SELECT * FROM delivery_attempt_records WHERE delivery_id=?').get(value.deliveryId) as Row); this.db.exec('COMMIT'); return saved
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite delivery transition failed and was rolled back', error) }
  }

  eligible(scope: ExactOutputScope, policy: ContextEligibilityPolicy = STRICT_CONTEXT_ELIGIBILITY): readonly EligibleAssistantOutput[] {
    try {
      const rows = this.db.prepare(`SELECT s.*,d.* FROM output_segment_records s JOIN generation_attempt_records g ON g.generation_id=s.generation_id JOIN logical_room_repository_records l ON l.logical_room_id=g.logical_room_id JOIN physical_room_records p ON p.physical_room_id=? JOIN delivery_attempt_records d ON d.delivery_id=(SELECT d2.delivery_id FROM delivery_attempt_records d2 WHERE d2.segment_id=s.segment_id ORDER BY d2.attempt_number DESC,d2.delivery_id DESC LIMIT 1) WHERE g.logical_room_id=? AND g.character_id=? AND p.lifecycle NOT IN ('inaccessible','deleted') AND ((l.singleton_physical_room_id=p.physical_room_id) OR EXISTS (SELECT 1 FROM room_binding_records b WHERE b.logical_room_id=l.logical_room_id AND b.physical_room_id=p.physical_room_id AND b.active_version IS NOT NULL)) ORDER BY s.ordinal,s.segment_id`).all(scope.physicalRoomId, scope.logicalRoomId, scope.characterId) as Row[]
      return rows.flatMap((row) => { const output: OutputSegment = { segmentId: asSegmentId(String(row.segment_id)), generationId: asGenerationId(String(row.generation_id)), ordinal: Number(row.ordinal), modality: String(row.modality) as OutputSegment['modality'], text: String(row.exact_text) }; const delivery = attempt(row); const text = eligibleSegmentText(output, delivery, policy); return text == null ? [] : [{ segment: output, text, attempt: delivery }] })
    }
    catch (error) { persistence('SQLite context-eligible output lookup failed', error) }
  }
}
