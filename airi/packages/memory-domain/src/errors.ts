/**
 * The MemoryPort error taxonomy (IMP-101; `artifacts/09-memory-port-api-spec.md` §10.4).
 *
 * Codes are `SCREAMING_SNAKE` because they are protocol values: they appear in
 * audit records and, once the optional HTTP transport exists, on the wire.
 * Renaming one is a breaking contract change, not a refactor.
 */

/** Why a MemoryPort operation failed. */
export type MemoryErrorCode
  // Shape and identity
  = | 'INVALID_ID'
    | 'INVALID_TIMESTAMP'
    | 'INVALID_SNOWFLAKE'
    | 'INVALID_ACTOR'
    | 'SYNTHETIC_AUTHOR_FORBIDDEN'
    | 'ANONYMOUS_ACTOR_NOT_PERSON_SCOPED'
  // Rooms and bindings
    | 'INVALID_ROOM_REF'
    | 'INVALID_ROOM'
    | 'ROOM_NOT_FOUND'
    | 'DUPLICATE_BINDING'
    | 'DM_ISOLATION_VIOLATION'
  // Events, generation, delivery
    | 'INVALID_PAYLOAD'
    | 'EMPTY_CONTENT'
    | 'PAYLOAD_TOO_LARGE'
    | 'UNKNOWN_EVENT_KIND'
    | 'UNSUPPORTED_APPEND_PRECONDITION'
    | 'ILLEGAL_STATE_TRANSITION'
    | 'INVALID_TRIGGER_EVENTS'
    | 'DRAFT_NOT_FOUND'
    | 'INVALID_OUTCOME'
    | 'MISSING_MESSAGE_ID'
  // Memory records
    | 'INVALID_CONFIDENCE'
    | 'MISSING_PROVENANCE'
    | 'ASSISTANT_FACT_NOT_DURABLE'
    | 'INVALID_INTENT'
    | 'MISSING_VALUE'
    | 'PERSON_NOT_FOUND'
    | 'TARGET_NOT_FOUND'
  // Authorization and privacy
    | 'UNAUTHORIZED_ROOM'
    | 'UNAUTHORIZED_OBSERVE'
    | 'UNAUTHORIZED_WRITE'
    | 'UNAUTHORIZED_READ'
    | 'UNAUTHORIZED_SEARCH'
    | 'UNAUTHORIZED_INTENT'
    | 'UNAUTHORIZED_BIND'
    | 'UNAUTHORIZED_EXPORT'
    | 'UNAUTHORIZED_GOVERNANCE'
    | 'SCOPE_LEAK_DETECTED'
    | 'PRIVATE_ALIAS_IN_PUBLIC_SCOPE'
    | 'OPAQUE_REF_LEAK_DETECTED'
    | 'POLICY_VIOLATION'
    | 'PURGE_REQUIRES_LEGAL_BASIS'
  // Capability and availability
    | 'UNSUPPORTED_CAPABILITY'
    | 'EMBEDDING_FAILED'
    | 'PERSISTENCE_FAILED'
    | 'TIMEOUT'
    | 'UNAVAILABLE'

/** Extra machine-readable context attached to a failure. */
export type MemoryErrorDetails = Readonly<Record<string, string | number | boolean | readonly string[]>>

export interface MemoryErrorOptions {
  /**
   * Whether the caller may retry the identical request. Defaults to `false`:
   * a contract violation retried unchanged just fails again, and guessing
   * "retryable" wrongly turns one bad write into a retry storm.
   */
  retryable?: boolean
  details?: MemoryErrorDetails
  cause?: unknown
}

/**
 * The only error type the MemoryPort throws.
 *
 * Callers switch on {@link MemoryError.code}; they must not parse the message.
 * Messages are for operators, codes are for control flow.
 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  readonly retryable: boolean
  readonly details?: MemoryErrorDetails

  constructor(code: MemoryErrorCode, message: string, options: MemoryErrorOptions = {}) {
    super(message, options.cause == null ? undefined : { cause: options.cause })
    this.name = 'MemoryError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }
}

/** Narrow an unknown thrown value to a {@link MemoryError}. */
export function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError
}

/** Narrow to a {@link MemoryError} carrying a specific code. */
export function hasMemoryErrorCode(error: unknown, code: MemoryErrorCode): error is MemoryError {
  return isMemoryError(error) && error.code === code
}

/**
 * Codes that mean "the durable authority did not accept this write".
 *
 * A caller seeing one of these MUST NOT tell the user anything was remembered
 * (ADR-016; `09-memory-port-api-spec.md` F-1). This list is the machine-checkable
 * form of that rule.
 */
export const NON_DURABLE_WRITE_CODES: readonly MemoryErrorCode[] = Object.freeze([
  'PERSISTENCE_FAILED',
  'TIMEOUT',
  'UNAVAILABLE',
])

/** True when the failure means the write is not durable and must not be acknowledged. */
export function indicatesNonDurableWrite(error: unknown): boolean {
  return isMemoryError(error) && NON_DURABLE_WRITE_CODES.includes(error.code)
}
