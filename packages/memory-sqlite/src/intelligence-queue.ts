import type { CharacterId, EventId, LogicalRoomId, Timestamp } from '@proj-airi/memory-domain'

import type { ReconciliationJob } from './reconciliation-queue.js'

import { ReconciliationQueue } from './reconciliation-queue.js'

export const SUMMARY_JOB_TYPE = 'memory_summary_v1'
export const EXTRACTION_JOB_TYPE = 'memory_extraction_v1'
export const CONTRADICTION_REVIEW_JOB_TYPE = 'memory_contradiction_review_v1'

export interface EnqueueSummaryJobInput {
  readonly jobId: string
  readonly dedupeKey: string
  readonly logicalRoomId: LogicalRoomId
  readonly characterId: CharacterId
  readonly sourceEventIds: readonly EventId[]
  readonly modelRef: string
  readonly policyVersion: string
  readonly availableAt: Timestamp
  readonly createdAt: Timestamp
  readonly maxAttempts: number
}

export interface EnqueueExtractionJobInput {
  readonly jobId: string
  readonly dedupeKey: string
  readonly logicalRoomId: LogicalRoomId
  readonly characterId: CharacterId
  readonly sourceEventId: EventId
  readonly modelRef: string
  readonly policyVersion: string
  readonly availableAt: Timestamp
  readonly createdAt: Timestamp
  readonly maxAttempts: number
}

export interface EnqueueContradictionReviewInput {
  readonly jobId: string
  readonly dedupeKey: string
  readonly logicalRoomId: LogicalRoomId
  readonly characterId: CharacterId
  readonly sourceEventId: EventId
  readonly conflictingFactIds: readonly string[]
  readonly candidateDigests: readonly string[]
  readonly policyVersion: string
  readonly availableAt: Timestamp
  readonly createdAt: Timestamp
}

/** Durable, content-free scheduling for summary and extraction model work. */
export class MemoryIntelligenceQueue {
  private readonly queue: ReconciliationQueue

  constructor(database: ConstructorParameters<typeof ReconciliationQueue>[0], id?: ConstructorParameters<typeof ReconciliationQueue>[1]) {
    this.queue = new ReconciliationQueue(database, id)
  }

  public enqueueSummary(input: EnqueueSummaryJobInput): { job: ReconciliationJob, deduplicated: boolean } {
    if (input.sourceEventIds.length === 0)
      throw new RangeError('summary work requires at least one source event')
    return this.queue.enqueue({
      jobId: input.jobId,
      jobType: SUMMARY_JOB_TYPE,
      dedupeKey: input.dedupeKey,
      payload: { operation: 'summarize', logicalRoomId: input.logicalRoomId, characterId: input.characterId, sourceEventIds: [...input.sourceEventIds], modelRef: input.modelRef, policyVersion: input.policyVersion },
      availableAt: input.availableAt,
      createdAt: input.createdAt,
      maxAttempts: input.maxAttempts,
    })
  }

  public enqueueExtraction(input: EnqueueExtractionJobInput): { job: ReconciliationJob, deduplicated: boolean } {
    return this.queue.enqueue({
      jobId: input.jobId,
      jobType: EXTRACTION_JOB_TYPE,
      dedupeKey: input.dedupeKey,
      payload: { operation: 'extract', logicalRoomId: input.logicalRoomId, characterId: input.characterId, sourceEventId: input.sourceEventId, modelRef: input.modelRef, policyVersion: input.policyVersion },
      availableAt: input.availableAt,
      createdAt: input.createdAt,
      maxAttempts: input.maxAttempts,
    })
  }

  /** Leaves a content-free, unclaimed job for explicit operator review. */
  public enqueueContradictionReview(input: EnqueueContradictionReviewInput): { job: ReconciliationJob, deduplicated: boolean } {
    if (input.conflictingFactIds.length === 0 || input.candidateDigests.length === 0)
      throw new RangeError('contradiction review requires both existing facts and candidate digests')
    return this.queue.enqueue({
      jobId: input.jobId,
      jobType: CONTRADICTION_REVIEW_JOB_TYPE,
      dedupeKey: input.dedupeKey,
      payload: { operation: 'review_contradiction', logicalRoomId: input.logicalRoomId, characterId: input.characterId, sourceEventId: input.sourceEventId, conflictingFactIds: [...input.conflictingFactIds], candidateDigests: [...input.candidateDigests], policyVersion: input.policyVersion },
      availableAt: input.availableAt,
      createdAt: input.createdAt,
      maxAttempts: 1,
    })
  }

  public claim(worker: string, now: Timestamp, leaseMs: number): ReconciliationJob | undefined {
    return this.queue.claim(worker, now, leaseMs, [SUMMARY_JOB_TYPE, EXTRACTION_JOB_TYPE])
  }

  public succeed(jobId: string, leaseToken: string, now: Timestamp): ReconciliationJob {
    return this.queue.succeed(jobId, leaseToken, now)
  }

  public retry(jobId: string, leaseToken: string, now: Timestamp, failure: { code: string, diagnostic: string }, options: { baseMs: number, maximumMs: number, random: () => number }): ReconciliationJob {
    return this.queue.retry(jobId, leaseToken, now, failure, options)
  }
}
