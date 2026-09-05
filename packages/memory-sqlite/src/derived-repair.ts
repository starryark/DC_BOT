import type { DatabaseSync } from 'node:sqlite'

import type { ReconciliationJob } from './reconciliation-queue.js'

import { ReconciliationQueue } from './reconciliation-queue.js'
import { SearchRepository } from './repositories/search.js'

export const LEXICAL_REPAIR_JOB_TYPE = 'derived_search_rebuild'

export interface EnqueueLexicalRepairInput {
  readonly jobId: string
  readonly dedupeKey: string
  readonly reason: 'forget' | 'correction' | 'retention' | 'repair'
  readonly policyVersion: string
  readonly availableAt: string
  readonly createdAt: string
  readonly maxAttempts: number
}

/** Typed, content-free access to executable derived-state work on `worker_jobs`. */
export class DerivedRepairQueue {
  private readonly queue: ReconciliationQueue

  constructor(private readonly db: DatabaseSync, id?: () => string) {
    this.queue = new ReconciliationQueue(db, id)
  }

  enqueueLexicalRepair(input: EnqueueLexicalRepairInput): { job: ReconciliationJob, deduplicated: boolean } {
    return this.queue.enqueue({
      jobId: input.jobId,
      jobType: LEXICAL_REPAIR_JOB_TYPE,
      dedupeKey: input.dedupeKey,
      payload: { operation: 'rebuild_lexical_search', policyVersion: input.policyVersion, reason: input.reason },
      availableAt: input.availableAt,
      createdAt: input.createdAt,
      maxAttempts: input.maxAttempts,
    })
  }

  claim(worker: string, now: string, leaseMs: number): ReconciliationJob | undefined {
    return this.queue.claim(worker, now, leaseMs, [LEXICAL_REPAIR_JOB_TYPE])
  }

  /** Claims and executes the only enabled derived repair handler in this increment. */
  executeNext(input: { worker: string, now: string, leaseMs: number, evidenceId: string, actorId: string, policyVersion: string, retryBaseMs: number, retryMaximumMs: number, random: () => number }): ReconciliationJob | undefined {
    const claimed = this.claim(input.worker, input.now, input.leaseMs)
    if (!claimed)
      return undefined
    try {
      new SearchRepository(this.db).rebuildSearch()
      this.queue.appendEvidence({ evidenceId: input.evidenceId, jobId: claimed.jobId, kind: 'decision', evidence: { operation: 'rebuild_lexical_search', outcome: 'succeeded' }, policyVersion: input.policyVersion, actorId: input.actorId, recordedAt: input.now })
      return this.queue.succeed(claimed.jobId, claimed.leaseToken!, input.now)
    }
    catch {
      return this.queue.retry(claimed.jobId, claimed.leaseToken!, input.now, { code: 'LEXICAL_REPAIR_FAILED', diagnostic: 'lexical repair failed' }, { baseMs: input.retryBaseMs, maximumMs: input.retryMaximumMs, random: input.random })
    }
  }
}
