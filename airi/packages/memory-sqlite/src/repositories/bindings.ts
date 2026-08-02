/* eslint-disable style/max-statements-per-line, antfu/if-newline, style/brace-style */
import type { DatabaseSync } from 'node:sqlite'

import type { BindingId, BindingKind, BindingPolicy, CharacterId, LogicalRoomId, PhysicalRoomId, Timestamp } from '@proj-airi/memory-domain'

import { asBindingId, asLogicalRoomId, MemoryError } from '@proj-airi/memory-domain'

export type BindingStatus = 'active' | 'suspended' | 'retired' | 'superseded'
export interface BindingVersion { bindingId: BindingId, physicalRoomId: PhysicalRoomId, logicalRoomId: LogicalRoomId, characterId: CharacterId, version: number, status: BindingStatus, bindingKind: BindingKind, policy: BindingPolicy, validFrom: Timestamp, validUntil?: Timestamp, authorizedBy: string, authorizationRevision: number }
export interface CreateBinding { bindingId: BindingId, physicalRoomId: PhysicalRoomId, logicalRoomId: LogicalRoomId, characterId: CharacterId, idempotencyKey: string, bindingKind: BindingKind, policy: BindingPolicy, validFrom: Timestamp, validUntil?: Timestamp, authorizedBy: string }

function fail(message: string, cause: unknown): never { if (cause instanceof MemoryError) throw cause; throw new MemoryError('PERSISTENCE_FAILED', message, { cause }) }

/** Owns append-only binding versions and optimistic, transactional lifecycle changes. */
export class BindingRepository {
  constructor(private readonly db: DatabaseSync) {}

  ensureLogicalRoom(input: { logicalRoomId: LogicalRoomId, characterId: CharacterId, privacyDomain: 'guild' | 'dm', guildId?: string, createdAt: Timestamp }): LogicalRoomId {
    if ((input.privacyDomain === 'guild') !== (input.guildId != null)) throw new MemoryError('POLICY_VIOLATION', 'logical room privacy boundary is incomplete')
    try {
      this.db.prepare('INSERT OR IGNORE INTO logical_rooms(logical_room_id,isolation_scope_type,isolation_scope_id,room_kind,created_at) VALUES (?,\'logical_room\',?,\'logical\',?)').run(input.logicalRoomId, input.logicalRoomId, input.createdAt)
      this.db.prepare('INSERT OR IGNORE INTO logical_room_repository_records(logical_room_id,character_id,privacy_domain,guild_id) VALUES (?,?,?,?)').run(input.logicalRoomId, input.characterId, input.privacyDomain, input.guildId ?? null)
      const row = this.db.prepare('SELECT character_id,privacy_domain,guild_id FROM logical_room_repository_records WHERE logical_room_id=?').get(input.logicalRoomId) as Record<string, string | null>
      if (row.character_id !== input.characterId || row.privacy_domain !== input.privacyDomain || row.guild_id !== (input.guildId ?? null)) throw new MemoryError('POLICY_VIOLATION', 'logical room already belongs to a different exact scope')
      return input.logicalRoomId
    }
    catch (error) { fail('SQLite logical room ensure failed', error) }
  }

  create(input: CreateBinding): BindingVersion {
    if (!input.idempotencyKey || !input.authorizedBy) throw new MemoryError('POLICY_VIOLATION', 'binding requires idempotency and actor evidence')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const retry = this.db.prepare('SELECT binding_id FROM room_binding_records WHERE idempotency_key=?').get(input.idempotencyKey) as { binding_id: string } | undefined
      if (retry) { const result = this.current(asBindingId(retry.binding_id)); this.db.exec('COMMIT'); return result! }
      this.assertCompatible(input.physicalRoomId, input.logicalRoomId, input.characterId)
      this.db.prepare('INSERT INTO room_binding_records(binding_id,physical_room_id,logical_room_id,character_id,idempotency_key,created_at,active_version) VALUES (?,?,?,?,?,?,1)').run(input.bindingId, input.physicalRoomId, input.logicalRoomId, input.characterId, input.idempotencyKey, input.validFrom)
      this.insert(input, 1, 'active', 1, input.validFrom)
      this.bump(input.logicalRoomId)
      this.db.exec('COMMIT'); return this.current(input.bindingId)!
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {} fail('SQLite binding creation failed and was rolled back', error) }
  }

  update(bindingId: BindingId, expectedVersion: number, input: { policy: BindingPolicy, validFrom: Timestamp, validUntil?: Timestamp, authorizedBy: string }): BindingVersion {
    try {
      this.db.exec('BEGIN IMMEDIATE'); const old = this.current(bindingId)
      if (!old || old.version !== expectedVersion) throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'binding version is stale')
      const next = expectedVersion + 1; this.db.prepare('UPDATE room_binding_versions SET status=\'superseded\' WHERE binding_id=? AND version=?').run(bindingId, expectedVersion)
      this.insert({ ...old, ...input, bindingKind: old.bindingKind }, next, 'active', old.authorizationRevision + 1, input.validFrom)
      this.db.prepare('UPDATE room_binding_records SET active_version=? WHERE binding_id=? AND active_version=?').run(next, bindingId, expectedVersion)
      this.bump(old.logicalRoomId); this.db.exec('COMMIT'); return this.current(bindingId)!
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {} fail('SQLite binding update failed and was rolled back', error) }
  }

  retire(bindingId: BindingId, expectedVersion: number, at: Timestamp, authorizedBy: string, status: 'retired' | 'suspended' = 'retired'): BindingVersion {
    try {
      this.db.exec('BEGIN IMMEDIATE'); const old = this.current(bindingId)
      if (!old || old.version !== expectedVersion) throw new MemoryError('ILLEGAL_STATE_TRANSITION', 'binding version is stale')
      this.db.prepare('UPDATE room_binding_versions SET status=\'superseded\' WHERE binding_id=? AND version=?').run(bindingId, expectedVersion)
      this.insert({ ...old, validFrom: at, validUntil: undefined, authorizedBy }, expectedVersion + 1, status, old.authorizationRevision + 1, at)
      this.db.prepare('UPDATE room_binding_records SET active_version=NULL WHERE binding_id=? AND active_version=?').run(bindingId, expectedVersion)
      this.bump(old.logicalRoomId); this.db.exec('COMMIT'); return this.history(bindingId).at(-1)!
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {} fail('SQLite binding removal failed and was rolled back', error) }
  }

  current(id: BindingId): BindingVersion | undefined { return this.rows('b.binding_id=? AND b.active_version=v.version', [id])[0] }
  history(id: BindingId): readonly BindingVersion[] { return this.rows('b.binding_id=?', [id]) }
  listForPhysical(id: PhysicalRoomId, characterId: CharacterId, at: Timestamp): readonly BindingVersion[] { return this.rows('b.physical_room_id=? AND b.character_id=? AND b.active_version=v.version AND v.status=\'active\' AND v.valid_from<=? AND (v.valid_until IS NULL OR v.valid_until>?)', [id, characterId, at, at]) }
  listForLogical(id: LogicalRoomId, characterId: CharacterId, at: Timestamp): readonly BindingVersion[] { return this.rows('b.logical_room_id=? AND b.character_id=? AND b.active_version=v.version AND v.status=\'active\' AND v.valid_from<=? AND (v.valid_until IS NULL OR v.valid_until>?)', [id, characterId, at, at]) }

  private assertCompatible(physical: PhysicalRoomId, logical: LogicalRoomId, character: CharacterId): void {
    const row = this.db.prepare('SELECT p.guild_id,p.lifecycle,l.character_id,l.privacy_domain,l.guild_id logical_guild FROM physical_room_records p JOIN logical_room_repository_records l ON l.logical_room_id=? WHERE p.physical_room_id=?').get(logical, physical) as Record<string, string | null> | undefined
    if (!row || row.lifecycle === 'deleted' || row.lifecycle === 'inaccessible' || row.character_id !== character) throw new MemoryError('UNAUTHORIZED_BIND', 'binding scope is missing, stale, inaccessible, or character-mismatched')
    const physicalDomain = row.guild_id == null ? 'dm' : 'guild'
    if (physicalDomain !== row.privacy_domain || (physicalDomain === 'guild' && row.guild_id !== row.logical_guild)) throw new MemoryError('DM_ISOLATION_VIOLATION', 'binding crosses a privacy or guild boundary')
  }

  private insert(input: Pick<CreateBinding, 'bindingId' | 'bindingKind' | 'policy' | 'validFrom' | 'validUntil' | 'authorizedBy'>, version: number, status: BindingStatus, revision: number, createdAt: Timestamp): void { this.db.prepare('INSERT INTO room_binding_versions(binding_id,version,status,binding_kind,cross_channel_history,direction,valid_from,valid_until,authorized_by,authorization_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(input.bindingId, version, status, input.bindingKind, input.policy.crossChannelHistory ? 1 : 0, input.policy.direction, input.validFrom, input.validUntil ?? null, input.authorizedBy, revision, createdAt) }
  private bump(id: LogicalRoomId): void { this.db.prepare('UPDATE logical_room_repository_records SET binding_revision=binding_revision+1 WHERE logical_room_id=?').run(id) }
  private rows(where: string, values: unknown[]): BindingVersion[] {
    try { return (this.db.prepare(`SELECT b.*,v.* FROM room_binding_records b JOIN room_binding_versions v USING(binding_id) WHERE ${where} ORDER BY v.version`).all(...values as any[]) as Array<Record<string, any>>).map(r => ({ bindingId: asBindingId(r.binding_id), physicalRoomId: r.physical_room_id, logicalRoomId: asLogicalRoomId(r.logical_room_id), characterId: r.character_id, version: r.version, status: r.status, bindingKind: r.binding_kind, policy: { crossChannelHistory: r.cross_channel_history === 1, direction: r.direction }, validFrom: r.valid_from, validUntil: r.valid_until ?? undefined, authorizedBy: r.authorized_by, authorizationRevision: r.authorization_revision })) }
    catch (error) { fail('SQLite exact binding lookup failed', error) }
  }
}
