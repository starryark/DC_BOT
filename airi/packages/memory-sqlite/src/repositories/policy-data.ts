/* eslint-disable style/max-statements-per-line, antfu/if-newline */
import type { DatabaseSync } from 'node:sqlite'

import type { CharacterId, LogicalRoomId, PhysicalRoomId, Timestamp } from '@proj-airi/memory-domain'

import { MemoryError } from '@proj-airi/memory-domain'

export interface PolicyScopeEvidence { physicalRoomId: PhysicalRoomId, logicalRoomId: LogicalRoomId, characterId: CharacterId, privacyDomain: 'guild' | 'dm', guildId?: string, lifecycle: 'active' | 'archived' | 'inaccessible' | 'deleted', bindingStatus: 'active' | 'isolated', bindingRevision: number, authorizationRevision: number }

/** Returns one exact, non-sensitive scope projection for the domain policy layer. */
export class PolicyDataRepository {
  constructor(private readonly db: DatabaseSync) {}

  findExact(input: { physicalRoomId: PhysicalRoomId, logicalRoomId: LogicalRoomId, characterId: CharacterId, at: Timestamp }): PolicyScopeEvidence | undefined {
    try {
      const room = this.db.prepare('SELECT lifecycle,guild_id FROM physical_room_records WHERE physical_room_id=?').get(input.physicalRoomId) as Record<string, string | null> | undefined
      const logical = this.db.prepare('SELECT privacy_domain,guild_id,binding_revision,singleton_physical_room_id FROM logical_room_repository_records WHERE logical_room_id=? AND character_id=?').get(input.logicalRoomId, input.characterId) as Record<string, any> | undefined
      if (!room || !logical || room.lifecycle === 'deleted' || room.lifecycle === 'inaccessible') return undefined
      if (logical.privacy_domain === 'guild' ? room.guild_id !== logical.guild_id : room.guild_id != null) return undefined
      if (logical.singleton_physical_room_id === input.physicalRoomId) return { physicalRoomId: input.physicalRoomId, logicalRoomId: input.logicalRoomId, characterId: input.characterId, privacyDomain: logical.privacy_domain, guildId: logical.guild_id ?? undefined, lifecycle: room.lifecycle as PolicyScopeEvidence['lifecycle'], bindingStatus: 'isolated', bindingRevision: logical.binding_revision, authorizationRevision: 0 }
      const bindings = this.db.prepare(`SELECT v.authorization_revision FROM room_binding_records b JOIN room_binding_versions v ON v.binding_id=b.binding_id AND v.version=b.active_version WHERE b.physical_room_id=? AND b.logical_room_id=? AND b.character_id=? AND v.status='active' AND v.valid_from<=? AND (v.valid_until IS NULL OR v.valid_until>?)`).all(input.physicalRoomId, input.logicalRoomId, input.characterId, input.at, input.at) as Array<{ authorization_revision: number }>
      if (bindings.length !== 1) return undefined
      return { physicalRoomId: input.physicalRoomId, logicalRoomId: input.logicalRoomId, characterId: input.characterId, privacyDomain: logical.privacy_domain, guildId: logical.guild_id ?? undefined, lifecycle: room.lifecycle as PolicyScopeEvidence['lifecycle'], bindingStatus: 'active', bindingRevision: logical.binding_revision, authorizationRevision: bindings[0].authorization_revision }
    }
    catch (cause) { if (cause instanceof MemoryError) throw cause; throw new MemoryError('PERSISTENCE_FAILED', 'SQLite policy scope lookup failed', { cause }) }
  }
}
