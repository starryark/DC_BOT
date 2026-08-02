/* eslint-disable antfu/consistent-list-newline, antfu/if-newline, perfectionist/sort-imports, style/brace-style, style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'
import type { CharacterId, GenerationAttempt, GenerationId, GenerationState, LogicalRoomId, Timestamp } from '@proj-airi/memory-domain'

import { createHash, randomUUID } from 'node:crypto'
import { asCharacterId, asEventId, asGenerationId, asLogicalRoomId, asRequestId, asTimestamp, MemoryError, transitionGeneration } from '@proj-airi/memory-domain'

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
  return {
    generationId: asGenerationId(String(row.generation_id)), idempotencyKey: asRequestId(String(row.idempotency_key)), logicalRoomId: asLogicalRoomId(String(row.logical_room_id)), characterId: asCharacterId(String(row.character_id)), state: String(row.current_state) as GenerationState,
    evidence: { observedRoomVersion: Number(row.observed_room_version), observedEventIds, contextManifestHash: String(row.context_manifest_hash), observedBindingVersion: Number(row.observed_binding_version), capturedAt: asTimestamp(String(row.captured_at)) },
    modelRef: String(row.model_ref), startedAt: asTimestamp(String(row.started_at)), ...(row.completed_at == null ? {} : { completedAt: asTimestamp(String(row.completed_at)) }),
  }
}

/** Owns stable generation identity, exact snapshot evidence, and append-only lifecycle history. */
export class GenerationRepository {
  constructor(private readonly db: DatabaseSync, private readonly id: () => string = randomUUID) {}

  create(attempt: GenerationAttempt): CreateGenerationResult {
    if (attempt.state !== 'prepared') throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'a generation must be created in prepared state')
    const inputHash = hash(attempt)
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const retry = this.db.prepare('SELECT * FROM generation_attempt_records WHERE idempotency_key=?').get(attempt.idempotencyKey) as Row | undefined
      if (retry) {
        if (retry.input_hash !== inputHash) throw new MemoryError('POLICY_VIOLATION', 'generation idempotency key was reused with conflicting input')
        const saved = reconstruct(this.db, retry); this.db.exec('COMMIT'); return { attempt: saved, deduplicated: true }
      }
      if (this.db.prepare('SELECT 1 FROM generation_attempt_records WHERE generation_id=?').get(attempt.generationId)) throw new MemoryError('POLICY_VIOLATION', 'generation identity was reused')
      const room = this.db.prepare('SELECT character_id FROM logical_room_repository_records WHERE logical_room_id=?').get(attempt.logicalRoomId) as { character_id: string } | undefined
      if (!room || room.character_id !== attempt.characterId) throw new MemoryError('UNAUTHORIZED_ROOM', 'generation scope does not match an accessible logical room')
      for (const eventId of attempt.evidence.observedEventIds) {
        const event = this.db.prepare('SELECT logical_room_id FROM inbound_event_records WHERE event_id=?').get(eventId) as { logical_room_id: string } | undefined
        if (!event || event.logical_room_id !== attempt.logicalRoomId) throw new MemoryError('SCOPE_LEAK_DETECTED', 'snapshot event is outside the generation room')
      }
      this.db.prepare('INSERT INTO generation_identifiers(generation_id) VALUES (?)').run(attempt.generationId)
      this.db.prepare('INSERT INTO generation_attempt_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attempt.generationId, attempt.idempotencyKey, attempt.logicalRoomId, attempt.characterId, attempt.state, attempt.evidence.observedRoomVersion, attempt.evidence.contextManifestHash, attempt.evidence.observedBindingVersion, attempt.evidence.capturedAt, attempt.modelRef, attempt.startedAt, attempt.completedAt ?? null, inputHash)
      attempt.evidence.observedEventIds.forEach((eventId, ordinal) => this.db.prepare('INSERT INTO generation_snapshot_events VALUES (?,?,?)').run(attempt.generationId, eventId, ordinal))
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
