import type { DeferredInboundEvent, SpoolEntry } from './write-spool'

import { indicatesNonDurableWrite, MemoryError } from '@proj-airi/memory-domain'

/**
 * Recovery for the degraded posture's deferred writes (artifact 09 §10.6;
 * artifact 16 REQ-OPS-001, TEST-OPS-006; ADR-016-009).
 *
 * This module owns one decision and nothing else: what to do with each outcome
 * the authority can return for a spooled write. The spool file mechanics live
 * in `write-spool.ts`, and the authority itself is supplied as {@link
 * SpoolReplayDeps.apply} by the composition module that is allowed to build it.
 *
 * Four outcomes, and confusing any two of them breaks a guarantee:
 *
 * - applied — the authority committed it; consume the record.
 * - deduplicated — the authority already had it, because a previous pass
 *   committed it and died before consuming the record. Consume it and count it
 *   separately, so recovery never reports durable growth that did not happen.
 * - permanently refused — the authority is healthy and still will not take it
 *   (a reused idempotency key, an unattributable DM). Retrying forever would
 *   wedge recovery, so the record is quarantined with its cause.
 * - temporarily unavailable — the store did not accept it *yet*. The pass halts
 *   with the record still pending; nothing later is applied out of order.
 *
 * The pass is idempotent by construction: every consume happens after the
 * authority commit it describes, so a crash in that window re-offers the
 * record and the authority's own idempotency key collapses it.
 */

/** What the authority did with one replayed write. */
export interface DeferredWriteApplication {
  /** True when the authority already held this write, so nothing new was appended. */
  readonly deduplicated: boolean
}

/** The spool operations recovery needs; satisfied by {@link import('./write-spool').DeferredWriteSpool}. */
export interface ReplayableSpool {
  pending: () => readonly SpoolEntry[]
  consume: (line: number) => void
  quarantine: (entry: SpoolEntry, reason: 'unreadable' | 'unreplayable', detail: string) => void
}

export interface SpoolReplayDeps {
  readonly spool: ReplayableSpool
  /** Applies one deferred write to the recovered authority. Throws to reject it. */
  readonly apply: (intent: DeferredInboundEvent) => DeferredWriteApplication
}

/** Content-free result surfaced through `memory_status`. */
export interface SpoolReplaySummary {
  /** Deferred writes the authority committed during this pass. */
  readonly applied: number
  /** Deferred writes the authority already held; no new durable state. */
  readonly deduplicated: number
  /** Records that left the spool without reaching the authority, each with a durable reason. */
  readonly quarantined: number
  /** Records still waiting after this pass. Non-zero means recovery is incomplete. */
  readonly pending: number
  /** Set when the pass stopped early; carries the failure that stopped it. */
  readonly halted?: string
}

/** Operator-facing one-liner for a failure, with the protocol code kept intact. */
function describeFailure(error: unknown): string {
  const detail = error instanceof MemoryError ? `${error.code}: ${error.message}` : String(error)
  return detail.replace(/\s+/g, ' ').slice(0, 300)
}

/**
 * Whether the authority's refusal means "not now" rather than "not ever".
 *
 * The domain already names the codes that mean a write did not reach durable
 * storage, and those are exactly the ones worth retrying. Anything else is a
 * contract violation that would fail identically on every future pass. An
 * error that is not a {@link MemoryError} is treated as retryable too: an
 * unrecognized failure is not evidence that the record is bad, and halting
 * loses nothing while quarantining would.
 */
function isTransient(error: unknown): boolean {
  if (!(error instanceof MemoryError))
    return true
  return error.retryable || indicatesNonDurableWrite(error)
}

/**
 * Run one bounded recovery pass over the deferred write spool.
 *
 * Returns rather than throws for every *authority* outcome, so a startup can
 * report incomplete recovery instead of refusing to boot. A failure of the
 * spool itself — an unwritable checkpoint, a quarantine that cannot be
 * recorded — still propagates, because continuing past one would silently
 * re-apply or silently drop writes.
 */
export function replayDeferredWrites(deps: SpoolReplayDeps): SpoolReplaySummary {
  const entries = deps.spool.pending()
  let applied = 0
  let deduplicated = 0
  let quarantined = 0

  for (const [index, entry] of entries.entries()) {
    if (entry.status === 'unreadable') {
      deps.spool.quarantine(entry, 'unreadable', entry.detail)
      quarantined += 1
      continue
    }
    let outcome: DeferredWriteApplication
    // Only the authority call is classified. A failure of the spool itself must
    // not be mistaken for the store refusing a write: treating an unwritable
    // checkpoint as "the authority is busy" would report a clean halt while the
    // commit it was supposed to record has already happened.
    try {
      outcome = deps.apply(entry.record.intent)
    }
    catch (error) {
      if (isTransient(error))
        return { applied, deduplicated, quarantined, pending: entries.length - index, halted: describeFailure(error) }
      deps.spool.quarantine(entry, 'unreplayable', describeFailure(error))
      quarantined += 1
      continue
    }
    if (outcome.deduplicated)
      deduplicated += 1
    else
      applied += 1
    // Consumed only after the authority committed, which is what makes the
    // crash window recoverable rather than lossy.
    deps.spool.consume(entry.line)
  }

  return { applied, deduplicated, quarantined, pending: 0 }
}
