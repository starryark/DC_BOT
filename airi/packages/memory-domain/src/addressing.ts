/**
 * Safe addressing and prompt-local person references (IMP-103; ADR-005, ADR-010).
 *
 * Two separate jobs live here because they are two halves of one guarantee:
 *
 * - Choosing *what to call someone* out loud, without leaking a private alias
 *   or guessing between two people who answer to the same name.
 * - Choosing *how to refer to someone inside a prompt*, using an opaque handle
 *   that carries no identity and must never be spoken back (REQ-PRIV-002).
 */

import type { AliasRecord, AliasScope, CallingScope } from './aliases'
import type { PersonId, Timestamp } from './ids'

import { aliasScopeRank, assertAliasRenderable, collidingPersons, isAliasActive, isAliasVisibleFrom } from './aliases'
import { MemoryError } from './errors'

/**
 * A prompt-local handle for a person, e.g. `p_1`.
 *
 * Generation-scoped and non-semantic: it encodes nothing about the person and
 * is meaningless outside the single prompt that minted it. It must never
 * appear in text the user reads or hears.
 */
export type OpaquePersonRef = `p_${number}`

/** Bidirectional map between persons and their handles for one generation. */
export interface OpaquePersonTable {
  refFor: ReadonlyMap<PersonId, OpaquePersonRef>
  personFor: ReadonlyMap<OpaquePersonRef, PersonId>
}

/**
 * Mint handles for the persons participating in one generation.
 *
 * Assignment is by position in `personIds`, which makes it deterministic and
 * therefore reproducible in a selection manifest. Duplicates collapse; two
 * distinct persons always get distinct handles even when they share every
 * display name they have (TEST-ALIAS-002).
 */
export function buildOpaquePersonTable(personIds: readonly PersonId[]): OpaquePersonTable {
  const refFor = new Map<PersonId, OpaquePersonRef>()
  const personFor = new Map<OpaquePersonRef, PersonId>()
  for (const personId of personIds) {
    if (refFor.has(personId))
      continue
    const ref: OpaquePersonRef = `p_${refFor.size + 1}`
    refFor.set(personId, ref)
    personFor.set(ref, personId)
  }
  return { refFor, personFor }
}

/**
 * Reject model output that echoed a prompt-local handle back at the user.
 *
 * The serializer removes handles on the way in, but the model can also invent
 * or repeat the pattern, and it reaches TTS as well as text. This is the last
 * gate before anything leaves the process (TEST-IDLEAK-001).
 */
export function assertNoOpaqueRefLeak(output: string): void {
  const leaked = output.match(/\bp_\d+\b/g)
  if (leaked) {
    throw new MemoryError('OPAQUE_REF_LEAK_DETECTED', 'model output contains a prompt-local person handle, which must never be printed or spoken', {
      retryable: false,
      details: { leaked },
    })
  }
}

/** The bot resolved an unambiguous, authorized way to address this person. */
export interface ResolvedAddress {
  outcome: 'resolved'
  personId: PersonId
  displayValue: string
  scope: AliasScope
}

/**
 * Two or more persons answer to the requested name in this scope.
 *
 * Not an error and never a merge: the caller must disambiguate or ask
 * (ADR-003, TEST-ID-001).
 */
export interface AmbiguousAddress {
  outcome: 'ambiguous'
  normalizedValue: string
  candidates: readonly PersonId[]
}

/**
 * No authorized alias exists for this person in this scope.
 *
 * The caller abstains rather than reaching for a less-scoped name; falling back
 * to "whatever we know" is exactly how a DM nickname reaches a guild.
 */
export interface AbstainedAddress {
  outcome: 'abstain'
  personId: PersonId
  reason: 'noAuthorizedAlias'
}

/** Nobody visible from this scope answers to the requested name. */
export interface UnknownAddress {
  outcome: 'unknown'
  normalizedValue: string
}

export type AddressResolution = ResolvedAddress | AmbiguousAddress | AbstainedAddress | UnknownAddress

export interface ResolveAddressInput {
  personId: PersonId
  /** Every alias the repository holds for this person; filtering happens here. */
  aliases: readonly AliasRecord[]
  callingScope: CallingScope
  at: Timestamp
}

/**
 * Choose how to address one person from one scope.
 *
 * Order of operations is the contract (`09-…` OP-09, REQ-SCOPE-002):
 * authorization first, then temporal validity, then precedence. Ranking before
 * filtering would let an unauthorized alias win and then be "downgraded",
 * which is how scope leaks survive code review.
 */
export function resolvePreferredAddress(input: ResolveAddressInput): AddressResolution {
  const authorized = input.aliases
    .filter(alias => alias.personId === input.personId)
    .filter(alias => isAliasVisibleFrom(alias, input.callingScope))
    .filter(alias => isAliasActive(alias, input.at))

  if (authorized.length === 0)
    return { outcome: 'abstain', personId: input.personId, reason: 'noAuthorizedAlias' }

  const best = [...authorized].sort((a, b) => {
    const byScope = aliasScopeRank(a.scope) - aliasScopeRank(b.scope)
    if (byScope !== 0)
      return byScope
    // Same scope: the more recently asserted alias is the current one.
    return Date.parse(b.validFrom) - Date.parse(a.validFrom)
  })[0]

  // Belt and braces: the chosen record is re-checked against the calling scope
  // before it can be rendered (§13.1 "scope must be checked on source records
  // and again on generated context bundles").
  assertAliasRenderable(best, input.callingScope)

  return { outcome: 'resolved', personId: input.personId, displayValue: best.displayValue, scope: best.scope }
}

export interface ResolvePersonByNameInput {
  normalizedValue: string
  /** Candidate aliases already narrowed to the readable scope, or all of them. */
  aliases: readonly AliasRecord[]
  callingScope: CallingScope
  at: Timestamp
}

/**
 * Resolve "who is called X here" — the inverse direction, used when a user
 * names someone.
 *
 * Returns `ambiguous` whenever more than one person matches. There is no
 * tie-break by recency, activity, or anything else: picking one would be a
 * silent identity merge, and the whole point of ADR-003 is that names do not
 * identify people.
 */
export function resolvePersonByName(input: ResolvePersonByNameInput): AddressResolution {
  const visible = input.aliases
    .filter(alias => isAliasVisibleFrom(alias, input.callingScope))
    .filter(alias => isAliasActive(alias, input.at))

  const candidates = collidingPersons(visible, input.normalizedValue)

  if (candidates.length === 0)
    return { outcome: 'unknown', normalizedValue: input.normalizedValue }
  if (candidates.length > 1)
    return { outcome: 'ambiguous', normalizedValue: input.normalizedValue, candidates }

  return resolvePreferredAddress({
    personId: candidates[0],
    aliases: visible,
    callingScope: input.callingScope,
    at: input.at,
  })
}
