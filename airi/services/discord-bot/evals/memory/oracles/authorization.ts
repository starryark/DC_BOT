import type { AssertionResult } from '../contracts'

/**
 * Authorization and scope-isolation oracle (IMP-802, T003).
 *
 * Zero-tolerance verdicts: cross-guild, cross-room, cross-character, and DM-
 * versus-guild scope must never leak. The oracle compares the *sets* of
 * selected context item ids and export fact counts, so a leak is a set
 * difference, not a judgement about text similarity.
 */

/** Observation of two rooms' assembled context, for cross-scope checks. */
export interface CrossScopeObservation {
  /** Logical room id of the room whose context was assembled (content-free). */
  readonly probeRoomId: string
  /** Item ids the probe room's context actually selected. */
  readonly probeSelectedItemIds: readonly string[]
  /** Item ids that belong to the *other* scope and must never appear. */
  readonly otherScopeItemIds: readonly string[]
}

/** Observation of an authorization denial, for fail-closed checks. */
export interface AuthorizationDenialObservation {
  /** Whether the unauthorized read threw (true) or returned data (false). */
  readonly denied: boolean
}

/** Observation of a cross-character isolation probe. */
export interface CrossCharacterObservation extends CrossScopeObservation {
  /** Character whose data must not appear in the other character's context. */
  readonly sourceCharacterId: string
}

/** Verdict for AUTH-001: cross-guild context/export must be empty of the other guild. */
export function crossGuildVerdict(observation: CrossScopeObservation): AssertionResult {
  const otherIds = new Set(observation.otherScopeItemIds)
  const leaked = observation.probeSelectedItemIds.filter(id => otherIds.has(id))
  return {
    assertionId: 'AUTH-001-A',
    passed: leaked.length === 0,
    diagnostic: leaked.length === 0
      ? 'no cross-guild items in probe context'
      : `${leaked.length} cross-guild item(s) leaked into probe context`,
  }
}

/** Verdict for AUTH-002: a room without scope grant must deny context reads. */
export function roomIsolationVerdict(observation: AuthorizationDenialObservation): AssertionResult {
  return {
    assertionId: 'AUTH-002-A',
    passed: observation.denied,
    diagnostic: observation.denied
      ? 'unauthorized context read denied'
      : 'unauthorized context read was not denied (fail-closed breach)',
  }
}

/** Verdict for AUTH-003: a second character must see no first-character context. */
export function crossCharacterVerdict(observation: CrossCharacterObservation): AssertionResult {
  const otherIds = new Set(observation.otherScopeItemIds)
  const leaked = observation.probeSelectedItemIds.filter(id => otherIds.has(id))
  return {
    assertionId: 'AUTH-003-A',
    passed: leaked.length === 0,
    diagnostic: leaked.length === 0
      ? 'no cross-character items in probe context'
      : `${leaked.length} cross-character item(s) leaked into probe context`,
  }
}

/** Verdict for AUTH-004: DM authority must not read guild context. */
export function dmIsolationVerdict(observation: CrossScopeObservation): AssertionResult {
  const guildIds = new Set(observation.otherScopeItemIds)
  const leaked = observation.probeSelectedItemIds.filter(id => guildIds.has(id))
  return {
    assertionId: 'AUTH-004-A',
    passed: leaked.length === 0,
    diagnostic: leaked.length === 0
      ? 'DM authority read no guild context'
      : `${leaked.length} guild item(s) leaked into DM authority context`,
  }
}
