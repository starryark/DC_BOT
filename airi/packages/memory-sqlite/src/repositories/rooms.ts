/* eslint-disable style/max-statements-per-line, antfu/if-newline, style/brace-style */
import type { DatabaseSync } from 'node:sqlite'

import type { CharacterId, PhysicalLocation, PhysicalRoomId, RoomResolution, Timestamp } from '@proj-airi/memory-domain'

import { asLogicalRoomId, asPhysicalRoomId, isolatedLogicalRoomId, MemoryError, physicalRoomIdOf } from '@proj-airi/memory-domain'

export type RoomLifecycle = 'active' | 'archived' | 'inaccessible' | 'deleted'
export interface ObservedRoom { location: PhysicalLocation, observedAt: Timestamp, displayName?: string, parentChannelId?: string, lifecycle?: RoomLifecycle, participantPersonId?: string }
export interface StoredRoom { physicalRoomId: PhysicalRoomId, location: PhysicalLocation, displayName?: string, parentChannelId?: string, lifecycle: RoomLifecycle, revision: number }

function fail(message: string, cause: unknown): never { if (cause instanceof MemoryError) throw cause; throw new MemoryError('PERSISTENCE_FAILED', message, { cause }) }
const kind = (value: PhysicalLocation['channelKind']) => value === 'guildText' ? 'guild_text' : value === 'thread' ? 'thread' : value === 'guildVoice' ? 'guild_voice' : 'dm'
const domain = (location: PhysicalLocation) => location.channelKind === 'dm' ? 'dm' : 'guild'

/** Persists exact Discord locations and resolves character-isolated conversation rooms. */
export class RoomRepository {
  constructor(private readonly db: DatabaseSync) {}

  observe(input: ObservedRoom): StoredRoom {
    const id = physicalRoomIdOf(input.location); const locator = String(id)
    if (input.location.channelKind === 'dm' && !input.participantPersonId)
      throw new MemoryError('INVALID_ROOM_REF', 'a DM observation requires its participant person id')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const existing = this.db.prepare('SELECT physical_room_id FROM physical_room_records WHERE locator_key=?').get(locator) as { physical_room_id: string } | undefined
      if (!existing) {
        this.db.prepare('INSERT INTO physical_room_records(physical_room_id,locator_key,platform,channel_id,channel_kind,guild_id,participant_person_id,display_name,parent_channel_id,lifecycle,observed_at) VALUES (?,?,\'discord\',?,?,?,?,?,?,?,?)').run(id, locator, input.location.channelId, kind(input.location.channelKind), input.location.guildId ?? null, input.participantPersonId ?? null, input.displayName ?? null, input.parentChannelId ?? null, input.lifecycle ?? 'active', input.observedAt)
      }
      else {
        const prior = this.db.prepare('SELECT display_name,parent_channel_id,lifecycle FROM physical_room_records WHERE physical_room_id=?').get(id) as { display_name: string | null, parent_channel_id: string | null, lifecycle: RoomLifecycle }
        const displayName = input.displayName ?? prior.display_name
        const parentChannelId = input.parentChannelId ?? prior.parent_channel_id
        const lifecycle = input.lifecycle ?? prior.lifecycle
        this.db.prepare('UPDATE physical_room_records SET display_name=?,parent_channel_id=?,lifecycle=?,observed_at=?,revision=revision+CASE WHEN display_name IS NOT ? OR parent_channel_id IS NOT ? OR lifecycle<>? THEN 1 ELSE 0 END WHERE physical_room_id=?').run(displayName, parentChannelId, lifecycle, input.observedAt, displayName, parentChannelId, lifecycle, id)
        if (lifecycle === 'deleted' || lifecycle === 'inaccessible')
          this.invalidateBindings(id, input.observedAt)
      }
      this.db.exec('COMMIT'); return this.get(id)!
    }
    catch (error) { try { this.db.exec('ROLLBACK') } catch {} fail('SQLite room observation failed and was rolled back', error) }
  }

  get(id: PhysicalRoomId): StoredRoom | undefined {
    try {
      const row = this.db.prepare('SELECT * FROM physical_room_records WHERE physical_room_id=?').get(id) as Record<string, any> | undefined
      if (!row) return undefined
      const channelKind = row.channel_kind === 'dm' ? 'dm' : row.channel_kind === 'thread' ? 'thread' : row.channel_kind === 'guild_voice' ? 'guildVoice' : 'guildText'
      return { physicalRoomId: asPhysicalRoomId(row.physical_room_id), location: { platform: 'discord', channelId: row.channel_id, channelKind, ...(row.guild_id == null ? {} : { guildId: row.guild_id }) }, displayName: row.display_name ?? undefined, parentChannelId: row.parent_channel_id ?? undefined, lifecycle: row.lifecycle, revision: row.revision }
    }
    catch (error) { fail('SQLite exact room lookup failed', error) }
  }

  resolve(location: PhysicalLocation, characterId: CharacterId, at: Timestamp): RoomResolution {
    const physicalRoomId = physicalRoomIdOf(location); const room = this.get(physicalRoomId)
    if (!room || room.lifecycle === 'deleted' || room.lifecycle === 'inaccessible') throw new MemoryError('UNAUTHORIZED_ROOM', 'room is missing or inaccessible')
    try {
      const rows = this.db.prepare(`SELECT b.binding_id,b.logical_room_id,v.authorization_revision FROM room_binding_records b JOIN room_binding_versions v ON v.binding_id=b.binding_id AND v.version=b.active_version WHERE b.physical_room_id=? AND b.character_id=? AND v.status='active' AND v.cross_channel_history=1 AND v.valid_from<=? AND (v.valid_until IS NULL OR v.valid_until>?)`).all(physicalRoomId, characterId, at, at) as Array<Record<string, any>>
      if (rows.length > 1) throw new MemoryError('DUPLICATE_BINDING', 'multiple applicable bindings deny resolution')
      if (rows.length === 1) return { physicalRoomId, logicalRoomId: asLogicalRoomId(rows[0].logical_room_id), roomKind: 'bound', bindingId: rows[0].binding_id, bindingVersion: rows[0].authorization_revision }
      const logicalRoomId = isolatedLogicalRoomId(physicalRoomId, characterId)
      this.db.prepare('INSERT OR IGNORE INTO logical_rooms(logical_room_id,isolation_scope_type,isolation_scope_id,room_kind,created_at) VALUES (?,\'unbound_channel\',?,\'unbound_channel\',?)').run(logicalRoomId, logicalRoomId, at)
      this.db.prepare('INSERT OR IGNORE INTO logical_room_repository_records(logical_room_id,character_id,privacy_domain,guild_id,singleton_physical_room_id) VALUES (?,?,?,?,?)').run(logicalRoomId, characterId, domain(location), location.guildId ?? null, physicalRoomId)
      return { physicalRoomId, logicalRoomId, roomKind: 'isolated', bindingVersion: 0 }
    }
    catch (error) { fail('SQLite room resolution failed', error) }
  }

  private invalidateBindings(id: PhysicalRoomId, at: Timestamp): void {
    const rows = this.db.prepare('SELECT binding_id,active_version FROM room_binding_records WHERE physical_room_id=? AND active_version IS NOT NULL').all(id) as Array<{ binding_id: string, active_version: number }>
    for (const row of rows) {
      const next = row.active_version + 1
      this.db.prepare('UPDATE room_binding_versions SET status=\'superseded\' WHERE binding_id=? AND version=?').run(row.binding_id, row.active_version)
      this.db.prepare(`INSERT INTO room_binding_versions SELECT binding_id,?,'suspended',binding_kind,cross_channel_history,direction,?,NULL,authorized_by,authorization_revision+1,? FROM room_binding_versions WHERE binding_id=? AND version=?`).run(next, at, at, row.binding_id, row.active_version)
      this.db.prepare('UPDATE room_binding_records SET active_version=NULL WHERE binding_id=?').run(row.binding_id)
    }
  }
}
