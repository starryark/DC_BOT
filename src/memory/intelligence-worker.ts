import type { CharacterId, EpisodicRecord, EventId, InboundEventEnvelope, LogicalRoomId, SemanticFact, SummaryRecord, Timestamp } from '@proj-airi/memory-domain'

import { createHash } from 'node:crypto'

import { asCharacterId, asConfidence, asEventId, asFactId, asLogicalRoomId, asSummaryId, asTimestamp } from '@proj-airi/memory-domain'

const SUMMARY_JOB_TYPE = 'memory_summary_v1'

interface IntelligenceJob {
  readonly jobId: string
  readonly jobType: string
  readonly payload: unknown
  readonly createdAt: string
  readonly leaseToken?: string
}

interface IntelligenceQueuePort {
  claim: (worker: string, now: Timestamp, leaseMs: number) => IntelligenceJob | undefined
  enqueueContradictionReview: (input: { jobId: string, dedupeKey: string, logicalRoomId: LogicalRoomId, characterId: CharacterId, sourceEventId: EventId, conflictingFactIds: readonly string[], candidateDigests: readonly string[], policyVersion: string, availableAt: Timestamp, createdAt: Timestamp }) => unknown
  succeed: (jobId: string, leaseToken: string, now: Timestamp) => unknown
  retry: (jobId: string, leaseToken: string, now: Timestamp, failure: { code: string, diagnostic: string }, options: { baseMs: number, maximumMs: number, random: () => number }) => { status: string }
}

interface IntelligenceDependencies {
  readonly queue: IntelligenceQueuePort
  readonly events: { getForLogical: (scope: { logicalRoomId: LogicalRoomId, characterId: CharacterId }, eventId: EventId) => InboundEventEnvelope | undefined }
  readonly memories: {
    currentFacts: (selector: { scopeKind: SemanticFact['scopeKind'], scopeId?: string, predicate: string }) => readonly SemanticFact[]
    createFact: (record: SemanticFact) => { deduplicated: boolean }
    createEpisodic: (record: EpisodicRecord) => { deduplicated: boolean }
  }
  readonly summaries: { create: (record: SummaryRecord) => { deduplicated: boolean } }
  readonly models: MemoryIntelligenceModels
}

interface IntelligenceExecutionResult {
  readonly outcome: MemoryIntelligenceWorkerResult['outcome']
  readonly createdRecords: number
  readonly contradiction?: {
    readonly logicalRoomId: LogicalRoomId
    readonly characterId: CharacterId
    readonly sourceEventId: EventId
    readonly conflictingFactIds: readonly string[]
    readonly candidateDigests: readonly string[]
    readonly policyVersion: string
  }
}

/** Output from a summary model. An empty/unsafe result must abstain explicitly. */
export type SummaryModelResult
  = | { readonly status: 'abstained', readonly reason: string }
    | { readonly status: 'accepted', readonly text: string }

/** One attributable fact proposed by an extraction model. */
export interface ExtractedFactCandidate {
  readonly predicate: string
  readonly value: string
  readonly confidence: number
}

/** A source-linked recollection proposed from one attributable event. */
export interface ExtractedEpisodeCandidate {
  readonly summary: string
}

/** Extraction never uses an empty list as an implicit success. */
export type ExtractionModelResult
  = | { readonly status: 'abstained', readonly reason: string }
    | { readonly status: 'accepted', readonly facts: readonly ExtractedFactCandidate[], readonly episodes?: readonly ExtractedEpisodeCandidate[] }

export interface MemoryIntelligenceModels {
  readonly summarize: (input: { readonly events: readonly InboundEventEnvelope[], readonly modelRef: string }) => Promise<SummaryModelResult>
  readonly extract: (input: { readonly event: InboundEventEnvelope, readonly modelRef: string }) => Promise<ExtractionModelResult>
}

export interface MemoryIntelligenceWorkerOptions {
  readonly workerId: string
  readonly leaseMs: number
  readonly retryBaseMs: number
  readonly retryMaximumMs: number
  /** Policy-owned floor for auto-extracted assertions. */
  readonly extractionConfidenceFloor: number
  readonly now: () => Timestamp
  readonly random: () => number
}

export interface MemoryIntelligenceWorkerResult {
  readonly jobId: string
  readonly jobType: typeof SUMMARY_JOB_TYPE | 'memory_extraction_v1'
  readonly outcome: 'created' | 'deduplicated' | 'abstained' | 'conflicted' | 'retry_scheduled' | 'dead_letter'
  readonly createdRecords: number
}

/**
 * Executes at most one durable intelligence job outside request/voice paths.
 *
 * Model calls complete before repository writes begin, so neither network
 * latency nor generation time is held inside a SQLite transaction.
 */
export async function runMemoryIntelligenceWorkerOnce(
  dependencies: IntelligenceDependencies,
  options: MemoryIntelligenceWorkerOptions,
): Promise<MemoryIntelligenceWorkerResult | undefined> {
  asConfidence(options.extractionConfidenceFloor)
  const claimed = dependencies.queue.claim(options.workerId, options.now(), options.leaseMs)
  if (!claimed)
    return undefined
  const leaseToken = claimed.leaseToken
  if (!leaseToken)
    throw new Error('claimed intelligence work has no lease token')

  try {
    const result = claimed.jobType === SUMMARY_JOB_TYPE
      ? await executeSummary(claimed, dependencies)
      : await executeExtraction(claimed, dependencies, options)
    if (result.contradiction) {
      dependencies.queue.enqueueContradictionReview({
        jobId: stableId('contradiction-review', claimed.jobId),
        dedupeKey: `contradiction:${claimed.jobId}`,
        ...result.contradiction,
        availableAt: asTimestamp(claimed.createdAt),
        createdAt: asTimestamp(claimed.createdAt),
      })
    }
    dependencies.queue.succeed(claimed.jobId, leaseToken, options.now())
    return { jobId: claimed.jobId, jobType: claimed.jobType as MemoryIntelligenceWorkerResult['jobType'], outcome: result.outcome, createdRecords: result.createdRecords }
  }
  catch (error) {
    const retried = dependencies.queue.retry(claimed.jobId, leaseToken, options.now(), { code: 'MEMORY_INTELLIGENCE_FAILED', diagnostic: errorMessage(error) }, { baseMs: options.retryBaseMs, maximumMs: options.retryMaximumMs, random: options.random })
    return { jobId: claimed.jobId, jobType: claimed.jobType as MemoryIntelligenceWorkerResult['jobType'], outcome: retried.status === 'dead_letter' ? 'dead_letter' : 'retry_scheduled', createdRecords: 0 }
  }
}

async function executeSummary(
  job: IntelligenceJob,
  dependencies: Pick<Parameters<typeof runMemoryIntelligenceWorkerOnce>[0], 'events' | 'summaries' | 'models'>,
): Promise<IntelligenceExecutionResult> {
  const payload = summaryPayload(job)
  const events = payload.sourceEventIds.map((eventId) => {
    const event = dependencies.events.getForLogical({ logicalRoomId: payload.logicalRoomId, characterId: payload.characterId }, eventId)
    if (!event)
      throw new Error(`summary source event ${eventId} is unavailable`)
    return event
  })
  const generated = await dependencies.models.summarize({ events, modelRef: payload.modelRef })
  if (generated.status === 'abstained' || !generated.text.trim())
    return { outcome: 'abstained', createdRecords: 0 }

  const recordedAt = asTimestamp(job.createdAt)
  const summaryId = asSummaryId(stableId('summary', `${payload.policyVersion}:${payload.sourceEventIds.join(':')}`))
  const saved = dependencies.summaries.create({
    layer: 'summary',
    summaryId,
    logicalRoomId: payload.logicalRoomId,
    sourceEventIds: payload.sourceEventIds,
    text: generated.text,
    modelRef: payload.modelRef,
    stale: false,
    provenance: { source: 'derived', method: 'summarization', sourceEventIds: payload.sourceEventIds, statedAt: latestTimestamp(events.map(event => event.occurredAt)) },
    validity: { validFrom: earliestTimestamp(events.map(event => event.occurredAt)), recordedAt },
  })
  return { outcome: saved.deduplicated ? 'deduplicated' : 'created', createdRecords: saved.deduplicated ? 0 : 1 }
}

async function executeExtraction(
  job: IntelligenceJob,
  dependencies: Pick<Parameters<typeof runMemoryIntelligenceWorkerOnce>[0], 'events' | 'memories' | 'models'>,
  options: MemoryIntelligenceWorkerOptions,
): Promise<IntelligenceExecutionResult> {
  const payload = extractionPayload(job)
  const event = dependencies.events.getForLogical({ logicalRoomId: payload.logicalRoomId, characterId: payload.characterId }, payload.sourceEventId)
  if (!event || event.actor.kind !== 'attributed' || event.kind === 'system' || !event.payload.content)
    return { outcome: 'abstained', createdRecords: 0 }

  const extracted = await dependencies.models.extract({ event, modelRef: payload.modelRef })
  if (extracted.status === 'abstained' || (extracted.facts.length === 0 && (extracted.episodes?.length ?? 0) === 0))
    return { outcome: 'abstained', createdRecords: 0 }

  let createdRecords = 0
  let deduplicated = 0
  const facts = extracted.facts.flatMap((candidate) => {
    const normalized = { predicate: candidate.predicate.trim(), value: candidate.value.trim(), confidence: candidate.confidence }
    return normalized.predicate && normalized.value && normalized.confidence >= options.extractionConfidenceFloor ? [normalized] : []
  })
  const currentFacts = facts.map(candidate => dependencies.memories.currentFacts({ scopeKind: 'logical_room', scopeId: payload.logicalRoomId, predicate: candidate.predicate }))
  if (facts.some((candidate, index) => (currentFacts[index] ?? []).some(fact => fact.value !== candidate.value))) {
    return {
      outcome: 'conflicted',
      createdRecords: 0,
      contradiction: {
        logicalRoomId: payload.logicalRoomId,
        characterId: payload.characterId,
        sourceEventId: payload.sourceEventId,
        conflictingFactIds: currentFacts.flatMap(records => records.map(fact => fact.factId)),
        candidateDigests: facts.map(candidate => createHash('sha256').update(`${candidate.predicate.normalize('NFC')}\0${candidate.value.normalize('NFC')}`).digest('hex')),
        policyVersion: payload.policyVersion,
      },
    }
  }

  for (const [index, candidate] of facts.entries()) {
    const { predicate, value } = candidate
    const current = currentFacts[index] ?? []
    if (current.some(fact => fact.value === value)) {
      deduplicated += 1
      continue
    }
    const factId = asFactId(stableId('fact', `${payload.policyVersion}:${payload.sourceEventId}:${predicate.normalize('NFC')}:${value.normalize('NFC')}`))
    const saved = dependencies.memories.createFact({
      layer: 'semantic',
      factId,
      personId: event.actor.personId,
      scopeKind: 'logical_room',
      scopeId: payload.logicalRoomId,
      predicate,
      value,
      confidence: asConfidence(candidate.confidence),
      provenance: { source: 'userStated', method: 'llmExtraction', sourceEventIds: [event.eventId], statedAt: event.occurredAt },
      validity: { validFrom: event.occurredAt, recordedAt: asTimestamp(job.createdAt) },
    })
    if (saved.deduplicated)
      deduplicated += 1
    else
      createdRecords += 1
  }
  for (const episode of extracted.episodes ?? []) {
    const summary = episode.summary.trim()
    if (!summary)
      continue
    const episodicId = asFactId(stableId('episode', `${payload.policyVersion}:${payload.sourceEventId}:${summary.normalize('NFC')}`))
    const saved = dependencies.memories.createEpisodic({
      layer: 'episodic',
      episodicId,
      personId: event.actor.personId,
      logicalRoomId: payload.logicalRoomId,
      occurredAt: event.occurredAt,
      summary,
      provenance: { source: 'derived', method: 'llmExtraction', sourceEventIds: [event.eventId], statedAt: event.occurredAt },
      validity: { validFrom: event.occurredAt, recordedAt: asTimestamp(job.createdAt) },
    })
    if (saved.deduplicated)
      deduplicated += 1
    else
      createdRecords += 1
  }
  if (createdRecords > 0)
    return { outcome: 'created', createdRecords }
  return { outcome: deduplicated > 0 ? 'deduplicated' : 'abstained', createdRecords: 0 }
}

interface SummaryPayload {
  readonly logicalRoomId: LogicalRoomId
  readonly characterId: CharacterId
  readonly sourceEventIds: readonly EventId[]
  readonly modelRef: string
  readonly policyVersion: string
}

interface ExtractionPayload {
  readonly logicalRoomId: LogicalRoomId
  readonly characterId: CharacterId
  readonly sourceEventId: EventId
  readonly modelRef: string
  readonly policyVersion: string
}

function summaryPayload(job: IntelligenceJob): SummaryPayload {
  const payload = recordPayload(job)
  if (payload.operation !== 'summarize' || !Array.isArray(payload.sourceEventIds) || payload.sourceEventIds.length === 0)
    throw new Error('summary job payload is invalid')
  return {
    logicalRoomId: asLogicalRoomId(requiredString(payload, 'logicalRoomId')),
    characterId: asCharacterId(requiredString(payload, 'characterId')),
    sourceEventIds: payload.sourceEventIds.map((value) => {
      if (typeof value !== 'string')
        throw new Error('summary sourceEventIds must contain strings')
      return asEventId(value)
    }),
    modelRef: requiredString(payload, 'modelRef'),
    policyVersion: requiredString(payload, 'policyVersion'),
  }
}

function extractionPayload(job: IntelligenceJob): ExtractionPayload {
  const payload = recordPayload(job)
  if (payload.operation !== 'extract')
    throw new Error('extraction job payload is invalid')
  return {
    logicalRoomId: asLogicalRoomId(requiredString(payload, 'logicalRoomId')),
    characterId: asCharacterId(requiredString(payload, 'characterId')),
    sourceEventId: asEventId(requiredString(payload, 'sourceEventId')),
    modelRef: requiredString(payload, 'modelRef'),
    policyVersion: requiredString(payload, 'policyVersion'),
  }
}

function recordPayload(job: IntelligenceJob): Record<string, unknown> {
  if (!isRecord(job.payload))
    throw new Error('intelligence job payload must be an object')
  return job.payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null && !Array.isArray(value)
}

function requiredString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field]
  if (typeof value !== 'string' || !value)
    throw new Error(`intelligence job ${field} must be a non-empty string`)
  return value
}

function stableId(prefix: string, input: string): string {
  return `${prefix}:${createHash('sha256').update(input).digest('hex')}`
}

function earliestTimestamp(values: readonly Timestamp[]): Timestamp {
  return values.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest)
}

function latestTimestamp(values: readonly Timestamp[]): Timestamp {
  return values.reduce((latest, value) => Date.parse(value) > Date.parse(latest) ? value : latest)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message
  return 'memory intelligence worker failed'
}
