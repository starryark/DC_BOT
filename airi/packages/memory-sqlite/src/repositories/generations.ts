/* eslint-disable antfu/consistent-list-newline, antfu/if-newline, perfectionist/sort-imports, style/brace-style, style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'
import type { CharacterId, DeliveryState, GenerationAttempt, GenerationId, GenerationState, LogicalRoomId, SnapshotContextItem, SnapshotContextManifest, Timestamp } from '@proj-airi/memory-domain'

import { createHash, randomUUID } from 'node:crypto'
import { asCharacterId, asDeliveryId, asEventId, asGenerationId, asLogicalRoomId, asRequestId, asSegmentId, asTimestamp, digestSnapshotContextManifest, MemoryError, transitionGeneration } from '@proj-airi/memory-domain'

export interface GenerationLifecycleRecord { generationId: GenerationId, from: GenerationState, to: GenerationState, at: Timestamp }
export interface CreateGenerationResult { attempt: GenerationAttempt, deduplicated: boolean }
export interface ExactGenerationScope { logicalRoomId: LogicalRoomId, characterId: CharacterId }

type Row = Record<string, string | number | null>

function persistence(message: string, cause: unknown): never {
  if (cause instanceof MemoryError) throw cause
  throw new MemoryError('PERSISTENCE_FAILED', message, { cause })
}

function hash(attempt: GenerationAttempt): string {
  return createHash('sha256').update(JSON.stringify(attempt)).digest('hex')
}

function reconstruct(db: DatabaseSync, row: Row): GenerationAttempt {
  const observedEventIds = (db.prepare('SELECT event_id FROM generation_snapshot_events WHERE generation_id=? ORDER BY ordinal').all(row.generation_id) as Array<{ event_id: string }>).map(value => asEventId(value.event_id))
  const header = db.prepare('SELECT * FROM generation_context_manifests WHERE generation_id=?').get(row.generation_id) as Row
  const items = (db.prepare('SELECT * FROM generation_context_manifest_items WHERE generation_id=? ORDER BY ordinal').all(row.generation_id) as Row[]).map((item): SnapshotContextItem => item.source_type === 'inbound'
    ? { sourceType: 'inbound', eventId: asEventId(String(item.inbound_event_id)) }
    : { sourceType: 'assistant_output', segmentId: asSegmentId(String(item.output_segment_id)), deliveryId: asDeliveryId(String(item.delivery_id)), deliveryState: String(item.delivery_state) as DeliveryState, deliveryStateAt: asTimestamp(String(item.delivery_state_at)) })
  const contextManifest: SnapshotContextManifest = { formatVersion: 1, logicalRoomVersion: Number(header.logical_room_version), bindingRevision: Number(header.binding_revision), maxItems: Number(header.max_items), maxCharacters: Number(header.max_characters), candidateReadLimit: Number(header.candidate_read_limit), truncated: Boolean(header.truncated), items }
  return {
    generationId: asGenerationId(String(row.generation_id)), idempotencyKey: asRequestId(String(row.idempotency_key)), logicalRoomId: asLogicalRoomId(String(row.logical_room_id)), characterId: asCharacterId(String(row.character_id)), state: String(row.current_state) as GenerationState,
    evidence: { observedRoomVersion: Number(row.observed_room_version), observedEventIds, contextManifestHash: String(row.context_manifest_hash), contextManifest, observedBindingVersion: Number(row.observed_binding_version), capturedAt: asTimestamp(String(row.captured_at)) },
    modelRef: String(row.model_ref), startedAt: asTimestamp(String(row.started_at)), ...(row.completed_at == null ? {} : { completedAt: asTimestamp(String(row.completed_at)) }),
  }
}

/** Owns stable generation identity, exact snapshot evidence, and append-only lifecycle history. */
export class GenerationRepository {
  constructor(private readonly db: DatabaseSync, private readonly id: () => string = randomUUID) {}

  create(attempt: GenerationAttempt): CreateGenerationResult {
    if (attempt.state !== 'prepared') throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'a generation must be created in prepared state')
    const canonicalAttempt = { ...attempt, evidence: { ...attempt.evidence, contextManifestHash: digestSnapshotContextManifest(attempt.evidence.contextManifest) } }
    const inputHash = hash(canonicalAttempt)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const retry = this.db.prepare('SELECT * FROM generation_attempt_records WHERE idempotency_key=?').get(attempt.idempotencyKey) as Row | undefined
      if (retry) {
        if (retry.input_hash !== inputHash) throw new MemoryError('POLICY_VIOLATION', 'generation idempotency key was reused with conflicting input')
        const saved = reconstruct(this.db, retry); this.db.exec('COMMIT'); return { attempt: saved, deduplicated: true }
      }
      if (this.db.prepare('SELECT 1 FROM generation_attempt_records WHERE generation_id=?').get(attempt.generationId)) throw new MemoryError('POLICY_VIOLATION', 'generation identity was reused')
      const room = this.db.prepare('SELECT r.character_id,l.current_version FROM logical_room_repository_records r JOIN logical_rooms l USING(logical_room_id) WHERE r.logical_room_id=?').get(attempt.logicalRoomId) as { character_id: string, current_version: number } | undefined
      if (!room || room.character_id !== attempt.characterId) throw new MemoryError('UNAUTHORIZED_ROOM', 'generation scope does not match an accessible logical room')
      const manifest = canonicalAttempt.evidence.contextManifest
      if (manifest.logicalRoomVersion !== canonicalAttempt.evidence.observedRoomVersion || manifest.bindingRevision !== canonicalAttempt.evidence.observedBindingVersion)
        throw new MemoryError('POLICY_VIOLATION', 'manifest header conflicts with generation evidence')
      if (manifest.logicalRoomVersion !== room.current_version)
        throw new MemoryError('POLICY_VIOLATION', 'manifest room version is not the current durable room version')
      for (const eventId of attempt.evidence.observedEventIds) {
        const event = this.db.prepare('SELECT logical_room_id FROM inbound_event_records WHERE event_id=?').get(eventId) as { logical_room_id: string } | undefined
        if (!event || event.logical_room_id !== attempt.logicalRoomId) throw new MemoryError('SCOPE_LEAK_DETECTED', 'snapshot event is outside the generation room')
      }
      for (const item of manifest.items) {
        if (item.sourceType === 'inbound') {
          if (!canonicalAttempt.evidence.observedEventIds.includes(item.eventId)) throw new MemoryError('POLICY_VIOLATION', 'manifest inbound event is absent from observedEventIds')
          const event = this.db.prepare('SELECT logical_room_id FROM inbound_event_records WHERE event_id=?').get(item.eventId) as { logical_room_id: string } | undefined
          if (!event || event.logical_room_id !== attempt.logicalRoomId) throw new MemoryError('SCOPE_LEAK_DETECTED', 'manifest inbound event is outside the generation room')
        }
        else {
          const output = this.db.prepare(`SELECT g.logical_room_id,g.character_id,d.segment_id FROM output_segment_records s JOIN generation_attempt_records g ON g.generation_id=s.generation_id JOIN delivery_attempt_records d ON d.delivery_id=? WHERE s.segment_id=?`).get(item.deliveryId, item.segmentId) as { logical_room_id: string, character_id: string, segment_id: string } | undefined
          if (!output || output.segment_id !== item.segmentId) throw new MemoryError('POLICY_VIOLATION', 'manifest delivery does not belong to its segment')
          if (output.logical_room_id !== attempt.logicalRoomId || output.character_id !== attempt.characterId) throw new MemoryError('SCOPE_LEAK_DETECTED', 'manifest assistant output is outside the generation scope')
          const lifecycle = this.db.prepare('SELECT 1 FROM delivery_lifecycle_records WHERE delivery_id=? AND to_state=? AND transitioned_at=?').get(item.deliveryId, item.deliveryState, item.deliveryStateAt)
          if (!lifecycle) throw new MemoryError('POLICY_VIOLATION', 'captured delivery lifecycle evidence does not exist')
        }
      }
      this.db.prepare('INSERT INTO generation_identifiers(generation_id) VALUES (?)').run(attempt.generationId)
      this.db.prepare('INSERT INTO generation_attempt_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attempt.generationId, attempt.idempotencyKey, attempt.logicalRoomId, attempt.characterId, attempt.state, canonicalAttempt.evidence.observedRoomVersion, canonicalAttempt.evidence.contextManifestHash, canonicalAttempt.evidence.observedBindingVersion, canonicalAttempt.evidence.capturedAt, attempt.modelRef, attempt.startedAt, attempt.completedAt ?? null, inputHash)
      attempt.evidence.observedEventIds.forEach((eventId, ordinal) => this.db.prepare('INSERT INTO generation_snapshot_events VALUES (?,?,?)').run(attempt.generationId, eventId, ordinal))
      this.db.prepare('INSERT INTO generation_context_manifests VALUES (?,?,?,?,?,?,?,?)').run(attempt.generationId, manifest.formatVersion, manifest.logicalRoomVersion, manifest.bindingRevision, manifest.maxItems, manifest.maxCharacters, manifest.candidateReadLimit, Number(manifest.truncated))
      manifest.items.forEach((item, ordinal) => this.db.prepare('INSERT INTO generation_context_manifest_items VALUES (?,?,?,?,?,?,?,?)').run(attempt.generationId, ordinal, item.sourceType, item.sourceType === 'inbound' ? item.eventId : null, item.sourceType === 'assistant_output' ? item.segmentId : null, item.sourceType === 'assistant_output' ? item.deliveryId : null, item.sourceType === 'assistant_output' ? item.deliveryState : null, item.sourceType === 'assistant_output' ? item.deliveryStateAt : null))
      this.db.prepare('INSERT INTO generation_lifecycle_records VALUES (?,?,?,?,?,0)').run(this.id(), attempt.generationId, 'prepared', 'prepared', attempt.startedAt)
      const saved = this.get({ logicalRoomId: attempt.logicalRoomId, characterId: attempt.characterId }, attempt.generationId)
      this.db.exec('COMMIT'); return { attempt: saved!, deduplicated: false }
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite generation creation failed and was rolled back', error) }
  }

  get(scope: ExactGenerationScope, generationId: GenerationId): GenerationAttempt | undefined {
    try {
      const row = this.db.prepare(`SELECT g.* FROM generation_attempt_records g JOIN logical_room_repository_records l ON l.logical_room_id=g.logical_room_id LEFT JOIN physical_room_records p ON p.physical_room_id=l.singleton_physical_room_id WHERE g.generation_id=? AND g.logical_room_id=? AND g.character_id=? AND (p.physical_room_id IS NULL OR p.lifecycle NOT IN ('inaccessible','deleted'))`).get(generationId, scope.logicalRoomId, scope.characterId) as Row | undefined
      return row ? reconstruct(this.db, row) : undefined
    }
    catch (error) { persistence('SQLite exact generation lookup failed', error) }
  }

  lifecycle(generationId: GenerationId): readonly GenerationLifecycleRecord[] {
    try { return (this.db.prepare('SELECT generation_id,from_state,to_state,transitioned_at FROM generation_lifecycle_records WHERE generation_id=? ORDER BY ordinal').all(generationId) as Array<{ generation_id: string, from_state: GenerationState, to_state: GenerationState, transitioned_at: string }>).map(row => ({ generationId: asGenerationId(row.generation_id), from: row.from_state, to: row.to_state, at: asTimestamp(row.transitioned_at) })) }
    catch (error) { persistence('SQLite generation lifecycle lookup failed', error) }
  }

  transition(generationId: GenerationId, from: GenerationState, to: GenerationState, at: Timestamp): GenerationAttempt {
    transitionGeneration(generationId, from, to)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const row = this.db.prepare('SELECT current_state,logical_room_id,character_id FROM generation_attempt_records WHERE generation_id=?').get(generationId) as { current_state: GenerationState, logical_room_id: string, character_id: string } | undefined
      if (!row) throw new MemoryError('TARGET_NOT_FOUND', 'generation does not exist')
      if (row.current_state !== from) throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'generation lifecycle precondition is stale')
      const ordinal = (this.db.prepare('SELECT MAX(ordinal) ordinal FROM generation_lifecycle_records WHERE generation_id=?').get(generationId) as { ordinal: number }).ordinal + 1
      this.db.prepare('UPDATE generation_attempt_records SET current_state=?,completed_at=CASE WHEN ? IN (\'persisted\',\'failed\',\'cancelled\',\'superseded\') THEN ? ELSE completed_at END WHERE generation_id=?').run(to, to, at, generationId)
      this.db.prepare('INSERT INTO generation_lifecycle_records VALUES (?,?,?,?,?,?)').run(this.id(), generationId, from, to, at, ordinal)
      const saved = reconstruct(this.db, this.db.prepare('SELECT * FROM generation_attempt_records WHERE generation_id=?').get(generationId) as Row)
      this.db.exec('COMMIT'); return saved
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {}; persistence('SQLite generation transition failed and was rolled back', error) }
  }
}
