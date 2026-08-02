/**
 * Deny-by-default authorization for every memory operation (IMP-105).
 *
 * The rule the red team made release-blocking: authorization runs **before**
 * candidates are produced, not as a filter afterwards (REQ-RETRIEVAL-001,
 * FIND-011, RISK-035). Unauthorized data must never become a candidate, a rank
 * feature, a log field, or a prompt fragment — filtering late means it already
 * was all four.
 *
 * Decisions are explainable: every deny carries a code an operator can act on
 * and an auditor can count.
 */

import type { MemoryErrorCode } from './errors'
import type { CharacterId, LogicalRoomId, PersonId } from './ids'

import { MemoryError } from './errors'

/** The scope dimensions that form the authorization lattice. */
export type ScopeKind
  = | 'dm'
    | 'guild'
    | 'person'
    | 'character'
    | 'logical_room'
    | 'unbound_channel'

/** One concrete scope the principal holds or the operation targets. */
export interface Scope {
  kind: ScopeKind
  /** The instance, e.g. a guild id or logical room id. Absent only for `character`-wide grants. */
  id?: string
}

/** Operations the MemoryPort authorizes. Protocol values (`09-…` §10.4). */
export type MemoryOperation
  = | 'room:read'
    | 'identity:observe'
    | 'event:write'
    | 'draft:write'
    | 'delivery:write'
    | 'context:read'
    | 'memory:search'
    | 'intent:write'
    | 'alias:read'
    | 'binding:write'
    | 'person:export'
    | 'governance:write'
    | 'system:read'

/** Operations only an operator principal may perform. */
export const OPERATOR_ONLY_OPERATIONS: readonly MemoryOperation[] = Object.freeze([
  'binding:write',
  'governance:write',
])

/** Who is asking. */
export interface AuthorizationPrincipal {
  /** The bot application's own Discord user id. */
  botUserId: string
  /** Granted operations. Absent means the principal may do nothing. */
  operations: readonly MemoryOperation[]
  /** Scopes the principal may act within. */
  scopes: readonly Scope[]
  /** True for a human operator acting through an admin surface. */
  operator: boolean
}

/** The full authorization context accompanying every port call. */
export interface AuthorizationContext {
  principal: AuthorizationPrincipal
  characterId: CharacterId
  /** The room the call is being made from, when there is one. */
  logicalRoomId?: LogicalRoomId
  /** For DM scopes: the participants. Used to check the caller belongs there. */
  dmParticipants?: readonly PersonId[]
}

/** What is being asked for. */
export interface AuthorizationRequest {
  operation: MemoryOperation
  /** The scope the data being touched belongs to. */
  targetScope: Scope
  /** For person-scoped reads and writes: whose data. */
  subjectPersonId?: PersonId
}

/** Why a request was denied. Stable codes; operators and dashboards read these. */
export type DenyCode
  = | 'noPrincipal'
    | 'operationNotGranted'
    | 'operatorRequired'
    | 'scopeNotGranted'
    | 'scopeInstanceMismatch'
    | 'dmParticipantRequired'
    | 'crossScopeRequest'

export type AuthorizationDecision
  = | { allowed: true, operation: MemoryOperation, scope: Scope }
    | { allowed: false, operation: MemoryOperation, scope: Scope, code: DenyCode, reason: string }

function deny(request: AuthorizationRequest, code: DenyCode, reason: string): AuthorizationDecision {
  return { allowed: false, operation: request.operation, scope: request.targetScope, code, reason }
}

/**
 * True when `granted` covers `target`.
 *
 * A grant without an `id` is scope-kind-wide (e.g. "any guild"), which is only
 * ever issued to the bot process itself. A grant *with* an id must match
 * exactly: a grant for guild A never covers guild B, and never covers a DM.
 */
function covers(granted: Scope, target: Scope): boolean {
  if (granted.kind !== target.kind)
    return false
  if (granted.id == null)
    return true
  return granted.id === target.id
}

/**
 * Decide one request.
 *
 * Every branch denies unless something explicitly permits it. There is no
 * final `return allow` — the allow is reached only after each check passes,
 * so adding a new scope kind without a rule fails closed by construction.
 */
export function authorize(context: AuthorizationContext | undefined, request: AuthorizationRequest): AuthorizationDecision {
  // A missing context is the single most dangerous input: it usually means a
  // call site forgot to thread authorization through, and defaulting to
  // "allow" there would silently disable the whole lattice.
  if (!context?.principal)
    return deny(request, 'noPrincipal', 'no authorization context was supplied; memory operations deny by default')

  const { principal } = context

  if (!principal.operations.includes(request.operation))
    return deny(request, 'operationNotGranted', `principal does not hold ${request.operation}`)

  if (OPERATOR_ONLY_OPERATIONS.includes(request.operation) && !principal.operator)
    return deny(request, 'operatorRequired', `${request.operation} requires an operator principal`)

  const matching = principal.scopes.filter(scope => scope.kind === request.targetScope.kind)
  if (matching.length === 0)
    return deny(request, 'scopeNotGranted', `principal holds no ${request.targetScope.kind} scope`)

  if (!matching.some(scope => covers(scope, request.targetScope))) {
    return deny(request, 'scopeInstanceMismatch', `principal holds ${request.targetScope.kind} scope, but not for ${request.targetScope.id ?? '(unspecified)'}`)
  }

  // DM data is readable only by a participant. Holding a `dm` scope grant is
  // necessary but not sufficient — the bot holds it for every DM it is in.
  if (request.targetScope.kind === 'dm') {
    const participants = context.dmParticipants
    if (!participants || participants.length === 0)
      return deny(request, 'dmParticipantRequired', 'DM-scoped access requires a known participant set')
    if (request.subjectPersonId && !participants.includes(request.subjectPersonId))
      return deny(request, 'dmParticipantRequired', 'subject is not a participant in this DM')
  }

  // An unbound channel shares with nothing, so a request that names a room
  // other than the one being called from is a cross-scope read by definition.
  if (request.targetScope.kind === 'unbound_channel'
    && context.logicalRoomId != null
    && request.targetScope.id !== context.logicalRoomId) {
    return deny(request, 'crossScopeRequest', 'unbound channels do not share history with other rooms')
  }

  return { allowed: true, operation: request.operation, scope: request.targetScope }
}

/** The error code an operation should raise when its authorization check denies. */
const DENIAL_ERROR_CODE = {
  'room:read': 'UNAUTHORIZED_ROOM',
  'identity:observe': 'UNAUTHORIZED_OBSERVE',
  'event:write': 'UNAUTHORIZED_WRITE',
  'draft:write': 'UNAUTHORIZED_WRITE',
  'delivery:write': 'UNAUTHORIZED_WRITE',
  'context:read': 'UNAUTHORIZED_READ',
  'memory:search': 'UNAUTHORIZED_SEARCH',
  'intent:write': 'UNAUTHORIZED_INTENT',
  'alias:read': 'UNAUTHORIZED_READ',
  'binding:write': 'UNAUTHORIZED_BIND',
  'person:export': 'UNAUTHORIZED_EXPORT',
  'governance:write': 'UNAUTHORIZED_GOVERNANCE',
  'system:read': 'UNAUTHORIZED_READ',
} as const satisfies Record<MemoryOperation, MemoryErrorCode>

/**
 * Authorize or throw.
 *
 * The throwing form exists so a call site cannot accidentally ignore a deny by
 * forgetting to check `.allowed`. Read paths that need to *report* a denial
 * rather than fail should call {@link authorize} directly.
 */
export function assertAuthorized(context: AuthorizationContext | undefined, request: AuthorizationRequest): void {
  const decision = authorize(context, request)
  if (decision.allowed)
    return
  throw new MemoryError(DENIAL_ERROR_CODE[request.operation], decision.reason, {
    retryable: false,
    details: { operation: request.operation, scopeKind: request.targetScope.kind, denyCode: decision.code },
  })
}
