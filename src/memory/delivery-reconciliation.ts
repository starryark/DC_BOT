import type { DeliveryAttempt, DeliveryEvidence, DeliveryId, DeliveryState, DeliveryTransition, DeliveryTransport } from '@proj-airi/memory-domain'

import { asTimestamp, MemoryError } from '@proj-airi/memory-domain'

/**
 * IMP-406: bounded, durable reconciliation of crash-ambiguous delivery attempts.
 *
 * The delivery state machine already owns the legal transitions
 * (`pending`/`delivering` -> `unknownAfterCrash` -> `delivered` | `failed` |
 * `partiallyDelivered` | `abandoned`) and the reconciliation queue already owns
 * durable dedupe, fenced leases, bounded retry, terminal dead-lettering, and
 * append-only evidence. This module owns the one decision that was missing: turning
 * stale prior-process ambiguity into durable, bounded, operator-actionable outcomes
 * without risking a duplicate external send.
 *
 * The M1 rule this module never breaks: a delivery may be marked `delivered` only
 * when durable evidence (a Discord platform message id) already proves the platform
 * accepted it. A crash-ambiguous attempt with no such receipt is left for operator
 * review as `abandoned`; it is never fabricated as success and never resent across
 * the ambiguous Discord side-effect boundary. See RUNBOOK-016-009/010 and
 * ADR-007 / REQ-DELIVERY-003 / REQ-DELIVERY-007.
 *
 * This module deliberately depends only on `@proj-airi/memory-domain` types plus the
 * structural store/queue interfaces below. The memory-sqlite implementation is
 * confined to `runtime.ts` by the SQLite boundary (sqlite-boundary.test.ts); that
 * composition module constructs the concrete repositories and passes them in.
 */

/** The queue job type this coordinator claims, so it never leases unrelated work. */
export const DELIVERY_RECONCILIATION_JOB_TYPE = 'delivery_reconcile'

/**
 * Content-free durable identity for one logical crash-ambiguous delivery.
 *
 * The index signature records that every value is a safe identifier (never message
 * or transcript content) and lets the object round-trip through the queue's
 * canonical JSON payload contract.
 */
export interface ReconcileDeliveryPayload {
  /** Stable per physical attempt; doubles as the queue dedupe key. */
  readonly deliveryId: string
  readonly segmentId: string
  readonly transport: DeliveryTransport
  /** Channel or voice channel id; safe to persist as an identifier, not content. */
  readonly destinationId: string
  readonly [extra: string]: string
}

/** A durable outcome chosen from current evidence alone — no external re-query. */
export type CrashAmbiguityDecision =
  | { readonly target: 'delivered', readonly reason: 'durable-receipt' }
  | { readonly target: 'failed', readonly reason: 'durable-error' }
  | { readonly target: 'abandoned', readonly reason: 'insufficient-evidence' }

/**
 * Decide a crash-ambiguous attempt's outcome from its durable evidence only.
 *
 * Pure and IO-free on purpose: the only facts available after a crash are what the
 * process already persisted. A platform message id is the one thing that proves a
 * text send landed; a transport error proves it did not; anything else (no evidence,
 * or local playback that proves nothing about human audibility) is genuinely
 * ambiguous and becomes operator review rather than a guess.
 */
export function classifyCrashAmbiguity(attempt: Pick<DeliveryAttempt, 'transport' | 'evidence'>): CrashAmbiguityDecision {
  // A durable Discord receipt is the only evidence that proves a text send landed.
  // Voice never carries one (voice has no platform receipt), so only text can land
  // here, and only when the receipt was durably recorded before the crash.
  if (attempt.transport === 'discord_text' && attempt.evidence.kind === 'platformMessageId')
    return { target: 'delivered', reason: 'durable-receipt' }
  // A durable transport error proves the attempt did not reach the transport.
  if (attempt.evidence.kind === 'transportError')
    return { target: 'failed', reason: 'durable-error' }
  // Crash with no outcome evidence, or local playback that proves nothing about
  // audibility: M1 does not resend and does not fabricate success, so the attempt
  // stays durable and operator-actionable as `abandoned`.
  return { target: 'abandoned', reason: 'insufficient-evidence' }
}

/**
 * The delivery-state operations the coordinator needs. Structurally satisfied by the
 * memory-sqlite `DeliveryRepository` constructed in `runtime.ts`; declared here so
 * this module does not import the implementation.
 */
export interface DeliveryReconciliationStore {
  inFlight(): readonly DeliveryAttempt[]
  unresolved(): readonly DeliveryAttempt[]
  get(deliveryId: DeliveryId): DeliveryAttempt | undefined
  transition(transition: DeliveryTransition): DeliveryAttempt
  countByState(state: DeliveryState): number
}

/** A claimed/queried queue job, as the coordinator reads it (payload is untrusted). */
export interface ReconcileJob {
  readonly jobId: string
  readonly leaseToken?: string
  readonly payload: unknown
  readonly status: string
}

/** Content-free evidence attached to a reconciliation observation or decision. */
export type ReconcileEvidence = Readonly<Record<string, string>>

/**
 * The queue operations the coordinator needs. Structurally satisfied by the
 * memory-sqlite `ReconciliationQueue` constructed in `runtime.ts`.
 */
export interface ReconciliationQueueLike {
  enqueue(input: { readonly jobId: string, readonly jobType: string, readonly dedupeKey: string, readonly payload: ReconcileDeliveryPayload, readonly availableAt: string, readonly maxAttempts: number, readonly createdAt: string }): { readonly job: { readonly jobId: string }, readonly deduplicated: boolean }
  claim(worker: string, now: string, leaseMs: number, jobTypes?: readonly string[]): ReconcileJob | undefined
  succeed(jobId: string, token: string, now: string): unknown
  retry(jobId: string, token: string, now: string, failure: { readonly code: string, readonly diagnostic: string }, options: { readonly baseMs: number, readonly maximumMs: number, readonly random: () => number }): ReconcileJob
  deadLetter(jobId: string, token: string, now: string, failure: { readonly code: string, readonly diagnostic: string }): unknown
  appendEvidence(input: { readonly evidenceId: string, readonly jobId: string, readonly kind: 'observation' | 'decision', readonly evidence: ReconcileEvidence, readonly policyVersion: string, readonly actorId: string, readonly recordedAt: string }): unknown
  get(jobId: string): ReconcileJob | undefined
}

/** External boundaries the coordinator runs against (real in the runtime, faked in tests). */
export interface DeliveryReconciliationDeps {
  readonly deliveries: DeliveryReconciliationStore
  readonly queue: ReconciliationQueueLike
  /** ISO timestamp; injected so tests are deterministic. */
  readonly now: () => string
  /** Stable id generator for queue jobs and evidence records. */
  readonly id: () => string
  /** Lease owner identity for this pass (one per process startup). */
  readonly workerId: string
  /** Full-jitter source for bounded retry; `Math.random` in the runtime. */
  readonly random: () => number
}

/** Bounded retry/fencing policy. Defaults are sized for a synchronous startup pass. */
export interface DeliveryReconciliationPolicy {
  readonly policyVersion: string
  readonly jobType: string
  readonly maxAttempts: number
  readonly leaseMs: number
  readonly retry: { readonly baseMs: number, readonly maximumMs: number }
}

/** Default M1 policy. A deterministic decision normally resolves on the first claim. */
export const DELIVERY_RECONCILIATION_POLICY: DeliveryReconciliationPolicy = Object.freeze({
  policyVersion: 'imp-406:1',
  jobType: DELIVERY_RECONCILIATION_JOB_TYPE,
  maxAttempts: 3,
  leaseMs: 5_000,
  retry: Object.freeze({ baseMs: 100, maximumMs: 1_000 }),
})

/** Content-free result surfaced through `memory_status` and the operator CLI. */
export interface DeliveryReconciliationSummary {
  /** Prior-process `pending`/`delivering` attempts moved to `unknownAfterCrash`. */
  readonly classified: number
  /** New reconciliation jobs enqueued for crash-ambiguous attempts. */
  readonly enqueued: number
  /** Enqueue calls that found an existing durable job for the same delivery. */
  readonly deduplicated: number
  /** Evidence-backed terminal resolutions applied this pass. */
  readonly resolved: { readonly delivered: number, readonly failed: number }
  /** Ambiguous attempts left as `abandoned` for operator review. */
  readonly awaitingOperatorReview: number
  /** Jobs whose delivery was already resolved by another path (no-op succeed). */
  readonly alreadyResolved: number
  /** Jobs retried after a transient persistence failure (reclaimed on a later pass). */
  readonly retried: number
  /** Poison jobs whose payload was malformed, terminal and operator-actionable. */
  readonly poison: number
  /** Jobs that exhausted bounded retries and now require operator attention. */
  readonly deadLetter: number
}

/** Type guard for a durable payload; a mismatched shape is poison, not a delivery. */
function isReconcilePayload(value: unknown): value is ReconcileDeliveryPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const record = value as Record<string, unknown>
  return typeof record.deliveryId === 'string'
    && typeof record.segmentId === 'string'
    && (record.transport === 'discord_text' || record.transport === 'discord_voice')
    && typeof record.destinationId === 'string'
}

/**
 * Run one bounded startup/operator reconciliation pass.
 *
 * Classification is idempotent: a second pass finds no `pending`/`delivering` and
 * deduplicates every enqueue by `deliveryId`. Resolution applies only already-legal
 * delivery transitions, fenced by the queue lease and the delivery `from`-precondition,
 * so a stale worker cannot mutate a terminal outcome. Every decision appends
 * content-free evidence with the policy version and the worker identity.
 */
export function reconcileDeliveries(
  deps: DeliveryReconciliationDeps,
  policy: DeliveryReconciliationPolicy = DELIVERY_RECONCILIATION_POLICY,
): DeliveryReconciliationSummary {
  const summary = {
    classified: 0,
    enqueued: 0,
    deduplicated: 0,
    resolved: { delivered: 0, failed: 0 },
    awaitingOperatorReview: 0,
    alreadyResolved: 0,
    retried: 0,
    poison: 0,
    deadLetter: 0,
  }

  // 1. Classify: any attempt still pending or delivering belongs to a dead prior
  //    process, because this pass runs at the moment sole writer ownership was
  //    acquired. Its outcome is genuinely unknown after the crash.
  for (const attempt of deps.deliveries.inFlight()) {
    deps.deliveries.transition({
      deliveryId: attempt.deliveryId,
      from: attempt.state,
      to: 'unknownAfterCrash',
      // The crash erased in-flight knowledge; record no outcome claim either way.
      evidence: { kind: 'none' },
      at: asTimestamp(deps.now()),
    })
    summary.classified += 1
  }

  // 2. Enqueue one durable job per crash-ambiguous attempt, content-free and
  //    deduplicated by delivery id. `unresolved()` includes the crash-ambiguous set;
  //    healthy completed playback (`unheard`) and known partial/interrupted outcomes
  //    are intentionally left untouched — they have their own eligibility/disposition.
  for (const attempt of deps.deliveries.unresolved()) {
    if (attempt.state !== 'unknownAfterCrash')
      continue
    const payload: ReconcileDeliveryPayload = {
      deliveryId: attempt.deliveryId,
      segmentId: attempt.segmentId,
      transport: attempt.transport,
      destinationId: attempt.destinationId,
    }
    const enqueued = deps.queue.enqueue({
      jobId: deps.id(),
      jobType: policy.jobType,
      dedupeKey: attempt.deliveryId,
      payload,
      availableAt: deps.now(),
      maxAttempts: policy.maxAttempts,
      createdAt: deps.now(),
    })
    if (enqueued.deduplicated)
      summary.deduplicated += 1
    else
      summary.enqueued += 1
    deps.queue.appendEvidence({
      evidenceId: deps.id(),
      jobId: enqueued.job.jobId,
      kind: 'observation',
      evidence: { deliveryId: attempt.deliveryId, transport: attempt.transport, observed: 'unknownAfterCrash' },
      policyVersion: policy.policyVersion,
      actorId: deps.workerId,
      recordedAt: deps.now(),
    })
  }

  // 3. Drain: claim and resolve every ready job of this type, bounded by the queue's
  //    own retry/dead-letter behavior. The decision is a pure read of durable
  //    evidence, so the happy path resolves on the first claim.
  let claimed: ReconcileJob | undefined
  while ((claimed = deps.queue.claim(deps.workerId, deps.now(), policy.leaseMs, [policy.jobType])) !== undefined)
    resolveJob(claimed, deps, policy, summary)

  return summary
}

type SummaryAccumulator = {
  classified: number
  enqueued: number
  deduplicated: number
  resolved: { delivered: number, failed: number }
  awaitingOperatorReview: number
  alreadyResolved: number
  retried: number
  poison: number
  deadLetter: number
}

function resolveJob(job: ReconcileJob, deps: DeliveryReconciliationDeps, policy: DeliveryReconciliationPolicy, summary: SummaryAccumulator): void {
  const token = job.leaseToken
  if (!token)
    return // Defensive: a claimed job always carries a lease token.

  // Poison: the payload is not a delivery identity this coordinator produced. Dead-
  // letter it terminally so an operator sees it, without touching any delivery row.
  if (!isReconcilePayload(job.payload)) {
    deps.queue.deadLetter(job.jobId, token, deps.now(), { code: 'POISON_PAYLOAD', diagnostic: 'reconciliation payload is not a delivery identity' })
    summary.poison += 1
    return
  }

  const deliveryId = job.payload.deliveryId as DeliveryId
  try {
    const current = deps.deliveries.get(deliveryId)
    if (!current) {
      // The delivery row is gone (e.g., redacted/tombstoned). Nothing to reconcile.
      deps.queue.succeed(job.jobId, token, deps.now())
      summary.alreadyResolved += 1
      return
    }
    if (current.state !== 'unknownAfterCrash') {
      // Resolved by another path since enqueue; re-transitioning would violate the
      // delivery precondition. Treat as idempotent success and record why.
      deps.queue.appendEvidence({
        evidenceId: deps.id(),
        jobId: job.jobId,
        kind: 'decision',
        evidence: { deliveryId, outcome: 'already-resolved', state: current.state },
        policyVersion: policy.policyVersion,
        actorId: deps.workerId,
        recordedAt: deps.now(),
      })
      deps.queue.succeed(job.jobId, token, deps.now())
      summary.alreadyResolved += 1
      return
    }
    const decision = classifyCrashAmbiguity(current)
    const at = asTimestamp(deps.now())
    // Carry the durable evidence forward; the transition records it on the lifecycle.
    const evidence: DeliveryEvidence = current.evidence
    const transitioned = deps.deliveries.transition({ deliveryId, from: 'unknownAfterCrash', to: decision.target, evidence, at })
    deps.queue.appendEvidence({
      evidenceId: deps.id(),
      jobId: job.jobId,
      kind: 'decision',
      evidence: { deliveryId, target: decision.target, reason: decision.reason, transport: transitioned.transport },
      policyVersion: policy.policyVersion,
      actorId: deps.workerId,
      recordedAt: deps.now(),
    })
    deps.queue.succeed(job.jobId, token, deps.now())
    if (decision.target === 'delivered')
      summary.resolved.delivered += 1
    else if (decision.target === 'failed')
      summary.resolved.failed += 1
    else
      summary.awaitingOperatorReview += 1
  }
  catch (error) {
    // A persistence/precondition failure is transient and bounded: retry with full
    // jitter, and let the queue dead-letter once `maxAttempts` is exhausted.
    const failure = toQueueFailure(error)
    try {
      const result = deps.queue.retry(job.jobId, token, deps.now(), failure, { ...policy.retry, random: deps.random })
      summary[result.status === 'dead_letter' ? 'deadLetter' : 'retried'] += 1
    }
    catch {
      // The lease was stale (a newer worker owns the job) or the job moved on; the
      // next claim pass or the operator CLI will pick up the durable state.
      const final = deps.queue.get(job.jobId)
      summary[final?.status === 'dead_letter' ? 'deadLetter' : 'retried'] += 1
    }
  }
}

function toQueueFailure(error: unknown): { code: string, diagnostic: string } {
  const code = error instanceof MemoryError ? error.code : 'RECONCILIATION_ERROR'
  const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
    ? error.message
    : String(error)
  return { code, diagnostic: message.replace(/[\r\n\t]+/g, ' ').slice(0, 200) }
}
