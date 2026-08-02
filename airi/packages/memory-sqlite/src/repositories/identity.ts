/* eslint-disable style/max-statements-per-line */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

import type { PersonId, Timestamp } from '@proj-airi/memory-domain'

import { randomUUID } from 'node:crypto'

import { asPersonId, identityKeyFor, MemoryError, normalizeAlias } from '@proj-airi/memory-domain'

type Maybe<T> = T | null | undefined
export interface IdentityObservation {
  observationKey: string
  snapshotId: string
  discordUserId: string
  observedAt: Timestamp
  displayNameAtEvent: string
  sourceEventType: 'gateway' | 'guildMemberUpdate' | 'voiceState' | 'restFetch'
  completeness: 'user_complete' | 'user_partial' | 'member_complete' | 'member_partial'
  username?: Maybe<string>
  globalName?: Maybe<string>
  avatarHash?: Maybe<string>
  guildId?: string
  guildNickname?: Maybe<string>
  guildAvatarHash?: Maybe<string>
  bot?: boolean
  system?: boolean
  voiceCharacteristics?: Readonly<Record<string, string | number>>
}
export interface IdentityObservationResult { personId: PersonId, externalIdentityId: string, snapshotId: string, snapshotCreated: boolean, profileChanged: boolean, guildProfileChanged: boolean, aliasChanged: boolean, freshnessUpdated: boolean }

const owns = (o: IdentityObservation, k: string): boolean => Object.hasOwn(o, k) && o[k as keyof IdentityObservation] !== undefined
const fieldsJson = (o: IdentityObservation, keys: readonly string[]): string => JSON.stringify(keys.filter(k => owns(o, k)).sort())
function rethrow(cause: unknown): never {
  if (cause instanceof MemoryError)
    throw cause; throw new MemoryError('PERSISTENCE_FAILED', 'SQLite identity observation failed and was rolled back', { cause })
}

export class IdentityRepository {
  constructor(private readonly db: DatabaseSync, private readonly id: () => string = randomUUID) {}

  observe(o: IdentityObservation): IdentityObservationResult {
    identityKeyFor(o.discordUserId)
    if (!o.observationKey || !o.snapshotId || !o.displayNameAtEvent || o.displayNameAtEvent.trim().toLowerCase() === 'discord group')
      throw new MemoryError('INVALID_ACTOR', 'an attributable observation requires non-synthetic event evidence')
    try {
      this.db.exec('BEGIN IMMEDIATE')
      const retry = this.db.prepare(`SELECT s.person_id,d.snapshot_id,e.external_identity_id FROM actor_snapshot_details d JOIN actor_snapshots s USING(snapshot_id) JOIN external_identities e ON e.person_id=s.person_id WHERE d.observation_key=?`).get(o.observationKey) as any
      if (retry) { this.db.exec('COMMIT'); return { personId: asPersonId(retry.person_id), externalIdentityId: retry.external_identity_id, snapshotId: retry.snapshot_id, snapshotCreated: false, profileChanged: false, guildProfileChanged: false, aliasChanged: false, freshnessUpdated: false } }

      let ext = this.db.prepare('SELECT external_identity_id,person_id,last_seen_at FROM external_identities WHERE platform=\'discord\' AND external_subject_key=?').get(o.discordUserId) as any
      if (!ext) {
        const person = this.id(); const external = this.id()
        this.db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run(person, o.discordUserId, o.observedAt, o.bot ? 'bot_account' : o.system ? 'system_account' : 'account_subject', o.observedAt)
        this.db.prepare('INSERT INTO external_identities(external_identity_id,person_id,platform,external_subject_key,verification_method,verification_strength,verified_at,first_seen_at,last_seen_at,bot,system) VALUES (?,?,\'discord\',?,\'platform_event\',\'platform_asserted\',?,?,?,?,?)').run(external, person, o.discordUserId, o.observedAt, o.observedAt, o.observedAt, o.bot ? 1 : 0, o.system ? 1 : 0)
        ext = { external_identity_id: external, person_id: person, last_seen_at: o.observedAt }
      }
      this.db.prepare('INSERT INTO actor_snapshots(snapshot_id,person_id,username,global_name,guild_nick,avatar_url,voice_characteristics_json,captured_at) VALUES (?,?,?,?,?,?,?,?)').run(o.snapshotId, ext.person_id, owns(o, 'username') ? o.username ?? null : null, owns(o, 'globalName') ? o.globalName ?? null : null, owns(o, 'guildNickname') ? o.guildNickname ?? null : null, owns(o, 'avatarHash') ? o.avatarHash ?? null : null, o.voiceCharacteristics ? JSON.stringify(o.voiceCharacteristics, Object.keys(o.voiceCharacteristics).sort()) : null, o.observedAt)
      this.db.prepare('INSERT INTO actor_snapshot_details(snapshot_id,observation_key,discord_user_id,guild_id,display_name_at_event,guild_avatar_hash,bot,system,source_event_type,completeness,supplied_fields) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(o.snapshotId, o.observationKey, o.discordUserId, o.guildId ?? null, o.displayNameAtEvent, owns(o, 'guildAvatarHash') ? o.guildAvatarHash ?? null : null, owns(o, 'bot') ? o.bot ? 1 : 0 : null, owns(o, 'system') ? o.system ? 1 : 0 : null, o.sourceEventType, o.completeness, fieldsJson(o, ['username', 'globalName', 'avatarHash', 'guildNickname', 'guildAvatarHash', 'bot', 'system']))
      const profileChanged = this.platformProfile(ext.external_identity_id, o)
      const guildProfileChanged = o.guildId ? this.guildProfile(ext.external_identity_id, o) : false
      const aliasChanged = this.observedAliases(ext.person_id, ext.external_identity_id, o)
      const freshnessUpdated = Date.parse(o.observedAt) - Date.parse(ext.last_seen_at) >= 86_400_000
      if (freshnessUpdated)
        this.db.prepare('UPDATE external_identities SET last_seen_at=? WHERE external_identity_id=? AND last_seen_at<=?').run(o.observedAt, ext.external_identity_id, new Date(Date.parse(o.observedAt) - 86_400_000).toISOString())
      this.db.exec('COMMIT')
      return { personId: asPersonId(ext.person_id), externalIdentityId: ext.external_identity_id, snapshotId: o.snapshotId, snapshotCreated: true, profileChanged, guildProfileChanged, aliasChanged, freshnessUpdated }
    }
    catch (error) {
      try { this.db.exec('ROLLBACK') }
      catch {} rethrow(error)
    }
  }

  private platformProfile(external: string, o: IdentityObservation): boolean {
    const old = this.db.prepare('SELECT * FROM current_discord_profiles WHERE external_identity_id=?').get(external) as any
    const map = { username: 'username', globalName: 'global_name', avatarHash: 'avatar_hash', bot: 'bot', system: 'system' } as const
    const keys = Object.keys(map) as Array<keyof typeof map>
    const sqlValue = (k: keyof typeof map): SQLInputValue => k === 'bot' || k === 'system' ? (o[k] ? 1 : 0) : o[k] ?? null
    if (old && !keys.some(k => owns(o, k) && old[map[k]] !== sqlValue(k)))
      return false
    const value = (k: keyof typeof map): SQLInputValue => owns(o, k) ? sqlValue(k) : old?.[map[k]] as SQLInputValue ?? (k === 'bot' || k === 'system' ? 0 : null)
    this.db.prepare(`INSERT INTO current_discord_profiles(external_identity_id,username,global_name,avatar_hash,bot,system,observed_at,source_snapshot_id,supplied_fields) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(external_identity_id) DO UPDATE SET username=excluded.username,global_name=excluded.global_name,avatar_hash=excluded.avatar_hash,bot=excluded.bot,system=excluded.system,observed_at=excluded.observed_at,source_snapshot_id=excluded.source_snapshot_id,supplied_fields=excluded.supplied_fields,profile_revision=profile_revision+1`).run(external, value('username'), value('globalName'), value('avatarHash'), value('bot'), value('system'), o.observedAt, o.snapshotId, fieldsJson(o, keys))
    return true
  }

  private guildProfile(external: string, o: IdentityObservation): boolean {
    const old = this.db.prepare('SELECT * FROM current_discord_guild_profiles WHERE external_identity_id=? AND guild_id=?').get(external, o.guildId!) as any
    if (old && (!owns(o, 'guildNickname') || old.guild_nickname === (o.guildNickname ?? null)) && (!owns(o, 'guildAvatarHash') || old.guild_avatar_hash === (o.guildAvatarHash ?? null)))
      return false
    this.db.prepare(`INSERT INTO current_discord_guild_profiles(external_identity_id,guild_id,guild_nickname,guild_avatar_hash,observed_at,source_snapshot_id,supplied_fields) VALUES (?,?,?,?,?,?,?) ON CONFLICT(external_identity_id,guild_id) DO UPDATE SET guild_nickname=excluded.guild_nickname,guild_avatar_hash=excluded.guild_avatar_hash,observed_at=excluded.observed_at,source_snapshot_id=excluded.source_snapshot_id,supplied_fields=excluded.supplied_fields,profile_revision=profile_revision+1`).run(external, o.guildId!, owns(o, 'guildNickname') ? o.guildNickname ?? null : old?.guild_nickname ?? null, owns(o, 'guildAvatarHash') ? o.guildAvatarHash ?? null : old?.guild_avatar_hash ?? null, o.observedAt, o.snapshotId, fieldsJson(o, ['guildNickname', 'guildAvatarHash']))
    return true
  }

  private observedAliases(person: string, external: string, o: IdentityObservation): boolean {
    const values: Array<[string, 'platform' | 'guild', string, string, string]> = []
    if (owns(o, 'username') && o.username)
      values.push([o.username, 'platform', 'discord', 'discordUsername', 'discord_username_observation'])
    if (owns(o, 'globalName') && o.globalName)
      values.push([o.globalName, 'platform', 'discord', 'discordGlobalName', 'discord_global_name_observation'])
    if (o.guildId && owns(o, 'guildNickname') && o.guildNickname)
      values.push([o.guildNickname, 'guild', o.guildId, 'discordNickname', 'discord_guild_nick_observation'])
    let changed = false
    for (const [value, scope, scopeId, source, kind] of values) {
      const old = this.db.prepare('SELECT a.alias_id,a.value FROM aliases a JOIN alias_repository_records r USING(alias_id) WHERE a.person_id=? AND a.scope_type=? AND a.scope_id=? AND a.source=? AND r.status=\'active\' AND a.valid_to IS NULL').get(person, scope, scopeId, source) as any
      if (old?.value === value)
        continue
      if (old) { this.db.prepare('UPDATE aliases SET valid_to=? WHERE alias_id=?').run(o.observedAt, old.alias_id); this.db.prepare('UPDATE alias_repository_records SET status=\'superseded\',updated_at=?,revision=revision+1 WHERE alias_id=?').run(o.observedAt, old.alias_id) }
      const alias = this.id(); const evidence = this.id(); const normalized = normalizeAlias(value)
      this.db.prepare('INSERT INTO aliases(alias_id,person_id,scope_type,scope_id,value,precedence,visibility,valid_from,source) VALUES (?,?,?,?,?,0,?,?,?)').run(alias, person, scope, scopeId, value, 'public', o.observedAt, source)
      this.db.prepare('INSERT INTO alias_repository_records(alias_id,normalization_key,normalization_version,status,preferred,confidence,authority,created_at,updated_at) VALUES (?,?,?,\'active\',0,90,\'platform_observed\',?,?)').run(alias, normalized, 'nfkc-casefold-v1', o.observedAt, o.observedAt)
      this.db.prepare('INSERT INTO alias_evidence(evidence_id,evidence_kind,source_snapshot_id,target_person_id,source_external_identity_id,created_at,authorization_context,dedupe_key) VALUES (?,?,?,?,?,?,?,?)').run(evidence, kind, o.snapshotId, person, external, o.observedAt, scopeId, `${source}:${person}:${scopeId}:${old?.alias_id ?? 'initial'}:${normalized}`)
      this.db.prepare('INSERT INTO alias_evidence_links(alias_id,evidence_id,relation) VALUES (?,?,\'supports\')').run(alias, evidence)
      changed = true
    }
    if (changed)
      this.db.prepare('UPDATE people SET alias_revision=alias_revision+1,updated_at=? WHERE person_id=?').run(o.observedAt, person)
    return changed
  }
}
