/* eslint-disable style/max-statements-per-line, antfu/if-newline, style/brace-style */
import type { DatabaseSync } from 'node:sqlite'

import type { BindingId, BindingKind, BindingPolicy, CharacterId, LogicalRoomId, PhysicalLocation, PhysicalRoomId, Timestamp } from '@proj-airi/memory-domain'

import { asBindingId, asLogicalRoomId, MemoryError, physicalRoomIdOf } from '@proj-airi/memory-domain'

export type BindingStatus = 'active' | 'suspended' | 'retired' | 'superseded'
export interface BindingVersion { bindingId: BindingId, physicalRoomId: PhysicalRoomId, logicalRoomId: LogicalRoomId, characterId: CharacterId, version: number, status: BindingStatus, bindingKind: BindingKind, policy: BindingPolicy, validFrom: Timestamp, validUntil?: Timestamp, authorizedBy: string, authorizationRevision: number }
export interface CreateBinding { bindingId: BindingId, physicalRoomId: PhysicalRoomId, logicalRoomId: LogicalRoomId, characterId: CharacterId, idempotencyKey: string, bindingKind: BindingKind, policy: BindingPolicy, validFrom: Timestamp, validUntil?: Timestamp, authorizedBy: string }
export interface ConfiguredBindingMember { bindingId: BindingId, logicalRoomId: LogicalRoomId, characterId: CharacterId, location: PhysicalLocation }
export interface BindingReconciliationManifest { created: readonly BindingId[], unchanged: readonly BindingId[], updated: readonly BindingId[], retired: readonly BindingId[] }

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

  /** Replaces one configuration owner's complete desired set in a single transaction. */
  reconcileConfigured(input: { owner: string, members: readonly ConfiguredBindingMember[], at: Timestamp }): BindingReconciliationManifest {
    if (!input.owner.startsWith('config:'))
      throw new MemoryError('POLICY_VIOLATION', 'configured binding owner must use the config namespace')
    const desired = new Map<string, ConfiguredBindingMember>()
    for (const member of input.members) {
      if (member.location.channelKind === 'dm')
        throw new MemoryError('DM_ISOLATION_VIOLATION', 'DM locations cannot participate in configured bindings')
      if (desired.has(member.bindingId))
        throw new MemoryError('DUPLICATE_BINDING', `duplicate configured binding id ${member.bindingId}`)
      desired.set(member.bindingId, member)
    }
    const physicalScopes = new Map<string, string>()
    for (const member of input.members) {
      const physical = physicalRoomIdOf(member.location)
      const scope = `${member.characterId}:${physical}`
      if (physicalScopes.has(scope))
        throw new MemoryError('DUPLICATE_BINDING', `configured physical room appears more than once: ${physical}`)
      physicalScopes.set(scope, member.bindingId)
    }

    const manifest = { created: [] as BindingId[], unchanged: [] as BindingId[], updated: [] as BindingId[], retired: [] as BindingId[] }
    try {
      this.db.exec('BEGIN IMMEDIATE')
      for (const member of input.members)
        this.ensureConfiguredScope(member, input.at)

      const managed = this.db.prepare(`SELECT DISTINCT b.binding_id,b.active_version FROM room_binding_records b JOIN room_binding_versions v ON v.binding_id=b.binding_id WHERE v.authorized_by=?`).all(input.owner) as Array<{ binding_id: string, active_version: number | null }>
      for (const member of input.members) {
        const existing = this.db.prepare('SELECT physical_room_id,logical_room_id,character_id,active_version FROM room_binding_records WHERE binding_id=?').get(member.bindingId) as { physical_room_id: string, logical_room_id: string, character_id: string, active_version: number | null } | undefined
        const physicalRoomId = physicalRoomIdOf(member.location)
        if (!existing) {
          this.db.prepare('INSERT INTO room_binding_records(binding_id,physical_room_id,logical_room_id,character_id,idempotency_key,created_at,active_version) VALUES (?,?,?,?,?,?,1)').run(member.bindingId, physicalRoomId, member.logicalRoomId, member.characterId, `configured:${member.bindingId}`, input.at)
          this.insert({ bindingId: member.bindingId, bindingKind: 'explicit', policy: { crossChannelHistory: true, direction: 'bidirectional' }, validFrom: input.at, authorizedBy: input.owner }, 1, 'active', 1, input.at)
          this.bump(member.logicalRoomId)
          manifest.created.push(member.bindingId)
          continue
        }
        if (existing.physical_room_id !== physicalRoomId || existing.logical_room_id !== member.logicalRoomId || existing.character_id !== member.characterId)
          throw new MemoryError('UNAUTHORIZED_BIND', `configured binding id collides with a different scope: ${member.bindingId}`)
        const current = existing.active_version == null ? undefined : this.current(member.bindingId)
        if (current?.authorizedBy !== input.owner && current)
          throw new MemoryError('UNAUTHORIZED_BIND', `configured binding id is managed by another authority: ${member.bindingId}`)
        if (current?.status === 'active' && current.policy.crossChannelHistory && current.policy.direction === 'bidirectional') {
          manifest.unchanged.push(member.bindingId)
          continue
        }
        const latest = this.history(member.bindingId).at(-1)
        if (!latest || latest.authorizedBy !== input.owner)
          throw new MemoryError('UNAUTHORIZED_BIND', `configured binding history is not owned by ${input.owner}`)
        const next = latest.version + 1
        this.insert({ bindingId: member.bindingId, bindingKind: 'explicit', policy: { crossChannelHistory: true, direction: 'bidirectional' }, validFrom: input.at, authorizedBy: input.owner }, next, 'active', latest.authorizationRevision + 1, input.at)
        this.db.prepare('UPDATE room_binding_records SET active_version=? WHERE binding_id=?').run(next, member.bindingId)
        this.bump(member.logicalRoomId)
        manifest.updated.push(member.bindingId)
      }

      for (const row of managed) {
        if (row.active_version == null || desired.has(row.binding_id))
          continue
        const bindingId = asBindingId(row.binding_id)
        const old = this.current(bindingId)!
        this.db.prepare('UPDATE room_binding_versions SET status=\'superseded\' WHERE binding_id=? AND version=?').run(bindingId, old.version)
        this.insert({ ...old, validFrom: input.at, validUntil: undefined, authorizedBy: input.owner }, old.version + 1, 'retired', old.authorizationRevision + 1, input.at)
        this.db.prepare('UPDATE room_binding_records SET active_version=NULL WHERE binding_id=?').run(bindingId)
        this.bump(old.logicalRoomId)
        manifest.retired.push(bindingId)
      }
      this.db.exec('COMMIT')
      return manifest
    }
    catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      fail('SQLite configured binding reconciliation failed and was rolled back', error)
    }
  }

  private ensureConfiguredScope(member: ConfiguredBindingMember, at: Timestamp): void {
    const physicalRoomId = physicalRoomIdOf(member.location)
    const channelKind = member.location.channelKind === 'guildText' ? 'guild_text' : member.location.channelKind === 'thread' ? 'thread' : 'guild_voice'
    this.db.prepare('INSERT OR IGNORE INTO physical_room_records(physical_room_id,locator_key,platform,channel_id,channel_kind,guild_id,lifecycle,observed_at) VALUES (?,?,\'discord\',?,?,?,\'active\',?)').run(physicalRoomId, String(physicalRoomId), member.location.channelId, channelKind, member.location.guildId!, at)
    this.db.prepare('INSERT OR IGNORE INTO logical_rooms(logical_room_id,isolation_scope_type,isolation_scope_id,room_kind,created_at) VALUES (?,\'logical_room\',?,\'logical\',?)').run(member.logicalRoomId, member.logicalRoomId, at)
    this.db.prepare('INSERT OR IGNORE INTO logical_room_repository_records(logical_room_id,character_id,privacy_domain,guild_id) VALUES (?,?,\'guild\',?)').run(member.logicalRoomId, member.characterId, member.location.guildId!)
    this.assertCompatible(physicalRoomId, member.logicalRoomId, member.characterId)
  }

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
