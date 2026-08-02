/* eslint-disable style/max-statements-per-line */
import type { DatabaseSync } from 'node:sqlite'

import type { AliasScope, PersonId, Timestamp } from '@proj-airi/memory-domain'

import { randomUUID } from 'node:crypto'

import { MemoryError, normalizeAlias } from '@proj-airi/memory-domain'

export type AliasStatus = 'proposed' | 'pending_confirmation' | 'active' | 'superseded' | 'rejected' | 'revoked' | 'expired' | 'quarantined'
export type AliasAuthority = 'self_explicit' | 'self_confirmed' | 'platform_observed' | 'target_confirmed_third_party' | 'operator_administrative' | 'migration' | 'llm_proposed' | 'third_party_unconfirmed'

export interface AliasCandidate {
  aliasId: string
  personId: PersonId
  scope: AliasScope
  scopeId: string
  characterId?: string
  displayValue: string
  spokenForm?: string
  normalizedValue: string
  preferred: boolean
  authority: AliasAuthority
  priority: number
  confidence: number
  validFrom: Timestamp
}

export interface ExactAliasQuery {
  scope: AliasScope
  scopeId: string
  characterId?: string
  normalizedValue: string
  at: Timestamp
}

function persistenceFailure(message: string, cause: unknown): never {
  if (cause instanceof MemoryError)
    throw cause
  throw new MemoryError('PERSISTENCE_FAILED', message, { cause })
}

export class AliasRepository {
  constructor(private readonly database: DatabaseSync, private readonly createId: () => string = randomUUID) {}

  findActiveCandidates(input: ExactAliasQuery): readonly AliasCandidate[] {
    if (!input.scopeId || (input.scope === 'character_global' && input.characterId !== input.scopeId))
      return []
    try {
      const rows = this.database.prepare(`
        SELECT a.alias_id, a.person_id, a.scope_type, a.scope_id, a.value, a.precedence, a.valid_from,
               r.normalization_key, r.spoken_form, r.character_id, r.preferred, r.authority, r.confidence
        FROM aliases a JOIN alias_repository_records r ON r.alias_id = a.alias_id
        WHERE a.scope_type = ? AND a.scope_id = ? AND r.normalization_key = ?
          AND r.status = 'active' AND a.valid_from <= ? AND (a.valid_to IS NULL OR a.valid_to > ?)
          AND (? <> 'character_global' OR r.character_id = ?)
        ORDER BY r.preferred DESC,
          CASE r.authority WHEN 'self_confirmed' THEN 0 WHEN 'self_explicit' THEN 1 WHEN 'target_confirmed_third_party' THEN 2
            WHEN 'platform_observed' THEN 3 WHEN 'migration' THEN 4 WHEN 'operator_administrative' THEN 5 ELSE 6 END,
          a.precedence DESC, r.confidence DESC, a.valid_from DESC, a.alias_id ASC
      `).all(input.scope, input.scopeId, normalizeAlias(input.normalizedValue), input.at, input.at, input.scope, input.characterId ?? '') as Array<Record<string, string | number | null>>
      return rows.map(row => ({
        aliasId: row.alias_id as string,
        personId: row.person_id as PersonId,
        scope: row.scope_type as AliasScope,
        scopeId: row.scope_id as string,
        characterId: row.character_id as string | undefined,
        displayValue: row.value as string,
        spokenForm: row.spoken_form as string | undefined,
        normalizedValue: row.normalization_key as string,
        preferred: row.preferred === 1,
        authority: row.authority as AliasAuthority,
        priority: row.precedence as number,
        confidence: row.confidence as number,
        validFrom: row.valid_from as Timestamp,
      }))
    }
    catch (error) {
      persistenceFailure('SQLite alias lookup failed', error)
    }
  }

  resolveExact(input: ExactAliasQuery): { outcome: 'unknown' } | { outcome: 'resolved', candidate: AliasCandidate } | { outcome: 'ambiguous', candidates: readonly AliasCandidate[] } {
    const candidates = this.findActiveCandidates(input)
    const persons = new Set(candidates.map(candidate => candidate.personId))
    if (persons.size === 0)
      return { outcome: 'unknown' }
    if (persons.size > 1)
      return { outcome: 'ambiguous', candidates }
    return { outcome: 'resolved', candidate: candidates[0] }
  }

  create(input: { personId: PersonId, scope: AliasScope, scopeId: string, characterId?: string, displayValue: string, spokenForm?: string, status: AliasStatus, preferred?: boolean, authority: AliasAuthority, priority: number, confidence: number, validFrom: Timestamp, validUntil?: Timestamp, evidence?: { kind: string, authorizationContext: string, dedupeKey: string } }): AliasCandidate {
    if (!input.scopeId || (input.scope === 'character_global') !== (input.characterId != null) || (input.characterId != null && input.characterId !== input.scopeId))
      throw new MemoryError('POLICY_VIOLATION', 'alias scope identifiers must be exact and character-global aliases require the exact character id')
    const aliasId = this.createId()
    try {
      this.database.exec('BEGIN IMMEDIATE')
      this.database.prepare('INSERT INTO aliases(alias_id, person_id, scope_type, scope_id, value, precedence, visibility, valid_from, valid_to, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(aliasId, input.personId, input.scope, input.scopeId, input.displayValue, input.priority, input.scope === 'private' ? 'private' : 'public', input.validFrom, input.validUntil ?? null, input.authority)
      this.database.prepare('INSERT INTO alias_repository_records(alias_id, normalization_key, normalization_version, spoken_form, character_id, status, preferred, confidence, authority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(aliasId, normalizeAlias(input.displayValue), 'nfkc-casefold-v1', input.spokenForm ?? null, input.characterId ?? null, input.status, input.preferred ? 1 : 0, input.confidence, input.authority, input.validFrom, input.validFrom)
      if (input.evidence) {
        const evidenceId = this.createId()
        this.database.prepare('INSERT INTO alias_evidence(evidence_id, evidence_kind, target_person_id, created_at, authorization_context, dedupe_key) VALUES (?, ?, ?, ?, ?, ?)').run(evidenceId, input.evidence.kind, input.personId, input.validFrom, input.evidence.authorizationContext, input.evidence.dedupeKey)
        this.database.prepare('INSERT INTO alias_evidence_links(alias_id, evidence_id, relation) VALUES (?, ?, \'supports\')').run(aliasId, evidenceId)
      }
      this.database.prepare('UPDATE people SET alias_revision = alias_revision + 1, updated_at = ? WHERE person_id = ?').run(input.validFrom, input.personId)
      this.database.exec('COMMIT')
      return this.findActiveCandidates({ scope: input.scope, scopeId: input.scopeId, characterId: input.characterId, normalizedValue: input.displayValue, at: input.validFrom }).find(candidate => candidate.aliasId === aliasId) ?? {
        aliasId,
        personId: input.personId,
        scope: input.scope,
        scopeId: input.scopeId,
        characterId: input.characterId,
        displayValue: input.displayValue,
        spokenForm: input.spokenForm,
        normalizedValue: normalizeAlias(input.displayValue),
        preferred: input.preferred ?? false,
        authority: input.authority,
        priority: input.priority,
        confidence: input.confidence,
        validFrom: input.validFrom,
      }
    }
    catch (error) {
      try { this.database.exec('ROLLBACK') }
      catch {}
      persistenceFailure('SQLite alias mutation failed and was rolled back', error)
    }
  }
}
