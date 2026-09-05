/**
 * Scoped aliases (IMP-103; ADR-005).
 *
 * An alias is a name a person is called *somewhere*. The scope is not a UI
 * hint — it is part of the authorization query. A DM-only nickname spoken in a
 * guild voice channel is a privacy incident (FIND-009, SCN-015), so scope and
 * visibility travel with the record and are checked at read time.
 */

import type { AliasId, PersonId, Timestamp } from './ids'

import { MemoryError } from './errors'

/**
 * The five alias scopes (`22-integrated-specification.md` §10.2).
 *
 * NOTICE:
 * Artifact 09 §10.2 spells these `character-global` / `logical-room` /
 * `private-conversation`. The integrated specification's SQL enum
 * (`character_global` / `logical_room` / `private`) wins by source-of-truth
 * precedence. Recorded as CON-107 in `docs/memory/adr/README.md`.
 * Removal condition: a superseding ADR that fixes one spelling everywhere.
 */
export type AliasScope
  = | 'platform'
    | 'character_global'
    | 'guild'
    | 'logical_room'
    | 'private'

/**
 * Resolution precedence, most specific first
 * (`22-…` §10.2: private > logical_room > guild > character_global > platform).
 */
export const ALIAS_SCOPE_PRECEDENCE: readonly AliasScope[] = Object.freeze([
  'private',
  'logical_room',
  'guild',
  'character_global',
  'platform',
])

/** Lower rank wins. Unknown scopes sort last rather than throwing. */
export function aliasScopeRank(scope: AliasScope): number {
  const rank = ALIAS_SCOPE_PRECEDENCE.indexOf(scope)
  return rank === -1 ? ALIAS_SCOPE_PRECEDENCE.length : rank
}

/**
 * Whether an alias may be rendered outside the scope that created it.
 *
 * `private` is not merely "scoped to a DM" — it is "must not be emitted
 * anywhere else", including logs an operator might read (TEST-ALIAS-001).
 */
export type AliasVisibility = 'public' | 'private'

export interface AliasRecord {
  aliasId: AliasId
  personId: PersonId
  scope: AliasScope
  /**
   * The concrete scope instance: a guild id for `guild`, a logical room id for
   * `logical_room`, a DM room id for `private`. `undefined` only for
   * `platform` and `character_global`, which have no instance.
   */
  scopeId?: string
  /** Case- and width-normalized form, used for comparison and collision checks. */
  normalizedValue: string
  /** Exactly what should be rendered, if this alias is chosen. */
  displayValue: string
  visibility: AliasVisibility
  validFrom: Timestamp
  validUntil?: Timestamp
  /** Who asserted this alias. */
  source: 'discordUsername' | 'discordGlobalName' | 'discordNickname' | 'userStated' | 'operator'
}

/**
 * The scope a read is being performed *from*.
 *
 * Every alias read carries one. There is no "default" calling scope, because a
 * default would inevitably be the permissive one.
 */
export interface CallingScope {
  kind: AliasScope
  scopeId?: string
}

/**
 * Normalize an alias for comparison.
 *
 * NFKC folds full-width and compatibility forms so that `Ａｌｅｘ` and `Alex`
 * collide as they should; casefolding makes the comparison case-insensitive.
 * Zero-width and bidi controls are stripped because they are invisible and
 * would otherwise let two aliases look identical while comparing unequal —
 * the confusable-alias attack in TEST-UNICODE-001.
 *
 * Before:
 * - `"‮Ａlex​"`
 *
 * After:
 * - `"alex"`
 */
export function normalizeAlias(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .trim()
    .toLowerCase()
}

/** True when `alias` is in force at `at`. */
export function isAliasActive(alias: AliasRecord, at: Timestamp): boolean {
  if (Date.parse(alias.validFrom) > Date.parse(at))
    return false
  return alias.validUntil == null || Date.parse(alias.validUntil) > Date.parse(at)
}

/**
 * Whether an alias may be *considered* by a read performed from `callingScope`.
 *
 * Deny-by-default and instance-exact: a private alias is visible only from the
 * same private conversation, a guild alias only inside that guild, a
 * logical-room alias only inside that room. Platform and character-global
 * aliases are visible everywhere because they have no instance to leak across.
 */
export function isAliasVisibleFrom(alias: AliasRecord, callingScope: CallingScope): boolean {
  if (alias.visibility === 'private' && callingScope.kind !== 'private')
    return false

  switch (alias.scope) {
    case 'platform':
    case 'character_global':
      return true
    case 'guild':
    case 'logical_room':
    case 'private':
      // An instance-scoped alias requires the reader to be inside that exact
      // instance. A missing scopeId on either side denies rather than matches.
      return alias.scopeId != null
        && callingScope.kind === alias.scope
        && callingScope.scopeId === alias.scopeId
  }
}

/**
 * Assert that a chosen alias is legal to render in `callingScope`.
 *
 * A second check on the way out, after selection. Projection bugs are the
 * realistic failure mode here, and the red team asked for scope to be verified
 * on the source record *and* on the assembled output (§13.1).
 */
export function assertAliasRenderable(alias: AliasRecord, callingScope: CallingScope): void {
  if (!isAliasVisibleFrom(alias, callingScope)) {
    throw new MemoryError('PRIVATE_ALIAS_IN_PUBLIC_SCOPE', `alias scoped to ${alias.scope} may not be rendered from ${callingScope.kind}`, {
      retryable: false,
      details: { aliasScope: alias.scope, callingScope: callingScope.kind },
    })
  }
}

/**
 * Group aliases by their normalized value to find collisions.
 *
 * A collision is two *different* persons answering to the same text. It is not
 * an error and must never trigger a merge (ADR-003, TEST-ID-001); it makes the
 * alias unusable as an unambiguous address, which is what
 * `addressing.resolvePreferredAddress` reports.
 */
export function collidingPersons(aliases: readonly AliasRecord[], normalizedValue: string): readonly PersonId[] {
  const persons = new Set<PersonId>()
  for (const alias of aliases) {
    if (alias.normalizedValue === normalizedValue)
      persons.add(alias.personId)
  }
  return [...persons]
}
