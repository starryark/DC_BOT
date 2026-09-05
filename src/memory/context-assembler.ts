import type { CharacterId, ContextEligibilityPolicy, DeliveryAttempt, EpisodicRecord, EventId, InboundEventEnvelope, LogicalRoomId, OutputSegment, Scope, SearchMemoryInput, SearchMemoryOutput, SemanticFact, SummaryRecord, Timestamp } from '@proj-airi/memory-domain'

import type { LayeredContextRequest, LayeredContextResult, LayeredSelectionManifestItem, RecentContextRequest, RecentContextResult } from './context-authority'
import type { MemoryFeatureFlags } from './feature-flags'
import type { PromptContextItem } from './prompt-context'

import { createHash } from 'node:crypto'

import { assertAuthorized, asTimestamp, needsCjkTokenizer } from '@proj-airi/memory-domain'

import { serializePromptContext } from './prompt-context'

type DerivedLayer = 'summary' | 'semantic' | 'episodic'
type DerivedRecord = SummaryRecord | SemanticFact | EpisodicRecord

interface ContextRepositories {
  readonly events: {
    recentForLogical: (scope: { logicalRoomId: LogicalRoomId, characterId: CharacterId, limit: number, excludeEventIds?: readonly EventId[] }) => readonly InboundEventEnvelope[]
  }
  readonly deliveries: {
    eligibleForLogical: (scope: { logicalRoomId: LogicalRoomId, characterId: CharacterId, limit: number, excludeEventIds?: readonly string[] }, policy: ContextEligibilityPolicy) => readonly { segment: OutputSegment, text: string, attempt: DeliveryAttempt }[]
  }
  readonly memories: {
    factsAsOf: (selector: { scopeKind: SemanticFact['scopeKind'], scopeId?: string, predicate: string }, at: Timestamp) => readonly SemanticFact[]
    currentFacts: (selector: { scopeKind: SemanticFact['scopeKind'], scopeId?: string, predicate: string }) => readonly SemanticFact[]
    currentEpisodes: (logicalRoomId: LogicalRoomId) => readonly EpisodicRecord[]
    episodesAsOf: (logicalRoomId: LogicalRoomId, at: Timestamp) => readonly EpisodicRecord[]
  }
  readonly policyData: {
    findExact: (input: { physicalRoomId: RecentContextRequest['physicalRoomId'], logicalRoomId: LogicalRoomId, characterId: CharacterId, at: Timestamp }) => { bindingRevision: number, authorizationRevision: number } | undefined
  }
  readonly search: { searchMemory: (input: SearchMemoryInput) => SearchMemoryOutput }
  readonly summaries: {
    listActive: (logicalRoomId: LogicalRoomId) => readonly SummaryRecord[]
    listAsOf: (logicalRoomId: LogicalRoomId, at: Timestamp) => readonly SummaryRecord[]
  }
  readonly currentRoomVersion: (logicalRoomId: LogicalRoomId) => number
}

interface RecentCandidate {
  readonly id: string
  readonly personKey?: string
  readonly prompt: Omit<PromptContextItem, 'personRef'>
  readonly at: string
  readonly manifest: Extract<LayeredSelectionManifestItem, { layer: 'recent' }>
}

interface DerivedCandidate {
  readonly id: string
  readonly personKey?: string
  readonly prompt: Omit<PromptContextItem, 'personRef'>
  readonly manifest: Extract<LayeredSelectionManifestItem, { layer: DerivedLayer }>
}

/**
 * Owns authorization-first G6 context selection for the SQLite runtime.
 *
 * Repository methods are never invoked until both the principal grant and the
 * current physical-to-logical scope projection have admitted the request.
 */
export class ContextAssembler {
  constructor(
    private readonly repositories: ContextRepositories,
    private readonly flags: MemoryFeatureFlags,
  ) {}

  public assembleRecent(request: RecentContextRequest): RecentContextResult {
    const scope = this.authorizedScope(request)
    if (!scope)
      return this.emptyRecent(request)

    const candidateReadLimit = request.maxItems * 4
    const candidates = this.recentCandidates(request, candidateReadLimit)
    const chosen = candidates.slice(-request.maxItems)
    const promptItems = localizePeople(chosen)
    const serialized = serializePromptContext(promptItems, request.maxCharacters)
    const selected = chosen.slice(0, serialized.includedItems).map(candidate => candidate.manifest.source)
    const truncated = serialized.truncated || candidates.length > chosen.length || candidates.length >= candidateReadLimit

    return {
      sentinel: 'ok',
      ...serialized,
      manifest: {
        formatVersion: 1,
        logicalRoomVersion: this.repositories.currentRoomVersion(request.logicalRoomId),
        maxItems: request.maxItems,
        maxCharacters: request.maxCharacters,
        selected,
        truncated,
        bindingRevision: scope.bindingRevision,
        candidateReadLimit,
      },
    }
  }

  public assembleLayered(request: LayeredContextRequest): LayeredContextResult {
    const scope = this.authorizedScope(request)
    const queryDigest = createHash('sha256').update(request.query.normalize('NFC')).digest('hex')
    const exactPredicates = [...new Set((request.exactPredicates ?? []).map(predicate => predicate.trim()).filter(Boolean))].sort()
    const requestedLayers = Object.freeze([...new Set(request.includeLayers)])
    const baseManifest = {
      formatVersion: 1 as const,
      queryDigest,
      ...(exactPredicates.length > 0 ? { exactPredicateDigest: createHash('sha256').update(JSON.stringify(exactPredicates)).digest('hex') } : {}),
      logicalRoomVersion: scope ? this.repositories.currentRoomVersion(request.logicalRoomId) : 0,
      bindingRevision: scope?.bindingRevision ?? 0,
      authorizationRevision: scope?.authorizationRevision ?? 0,
      ...(request.asOf ? { asOf: request.asOf } : {}),
      maxItems: request.maxItems,
      maxCharacters: request.maxCharacters,
      requestedLayers,
    }
    if (!scope) {
      return {
        sentinel: 'noDurableContext',
        text: '',
        includedItems: 0,
        truncated: false,
        manifest: { ...baseManifest, appliedModes: [], selected: [], omittedLayers: requestedLayers, truncated: false },
      }
    }

    const enabledLayers = requestedLayers.filter(layer => this.layerEnabled(layer))
    const omittedLayers = requestedLayers.filter(layer => !enabledLayers.includes(layer))
    const candidates: Array<RecentCandidate | DerivedCandidate> = []
    const appliedModes: Array<'exact' | 'lexical' | 'current-summary'> = []

    if (enabledLayers.includes('recent')) {
      const recent = this.recentCandidates(request, request.maxItems * 4)
        .filter(candidate => !request.asOf || Date.parse(candidate.at) <= Date.parse(request.asOf))
      candidates.push(...recent.slice(-request.maxItems))
    }

    if (enabledLayers.includes('semantic') && exactPredicates.length > 0) {
      appliedModes.push('exact')
      for (const predicate of exactPredicates) {
        const facts = request.asOf
          ? this.repositories.memories.factsAsOf({ scopeKind: 'logical_room', scopeId: request.logicalRoomId, predicate }, request.asOf)
          : this.repositories.memories.currentFacts({ scopeKind: 'logical_room', scopeId: request.logicalRoomId, predicate })
        candidates.push(...facts.map(record => derivedCandidate(record, 'exact')))
      }
    }

    const searchableLayers = enabledLayers.filter((layer): layer is DerivedLayer => layer !== 'recent')
    if (this.flags.fulltextRetrieval && searchableLayers.length > 0 && request.query.trim()) {
      appliedModes.push('lexical')
      const result = this.repositories.search.searchMemory({
        query: request.query,
        scope: { kind: 'logical_room', id: request.logicalRoomId },
        layers: searchableLayers,
        modes: ['lexical'],
        ...(request.asOf ? { until: request.asOf } : {}),
        limit: request.maxItems * 4,
      })
      candidates.push(...result.hits.flatMap((hit, rank) => hit.record.layer === 'procedural' ? [] : [derivedCandidate(hit.record, 'lexical', rank + 1)]))
    }

    if (enabledLayers.includes('summary')) {
      appliedModes.push('current-summary')
      const summaries = request.asOf
        ? this.repositories.summaries.listAsOf(request.logicalRoomId, request.asOf)
        : this.repositories.summaries.listActive(request.logicalRoomId)
      candidates.push(...summaries.map(record => derivedCandidate(record, 'current-summary')))
    }

    if (enabledLayers.includes('episodic') && !this.flags.fulltextRetrieval) {
      const episodes = request.asOf
        ? this.repositories.memories.episodesAsOf(request.logicalRoomId, request.asOf)
        : this.repositories.memories.currentEpisodes(request.logicalRoomId)
      candidates.push(...episodes.map(record => derivedCandidate(record, 'exact')))
      if (episodes.length > 0 && !appliedModes.includes('exact'))
        appliedModes.push('exact')
    }

    // Exact and recent tiers are appended first. A record returned again by a
    // later ranker keeps its first position and first reason; BM25 never
    // demotes deterministic evidence.
    const seen = new Set<string>()
    const deduplicated = candidates.filter((candidate) => {
      const key = `${candidate.manifest.layer}:${candidate.id}`
      if (seen.has(key))
        return false
      seen.add(key)
      return true
    })
    const unique = deduplicated.slice(0, request.maxItems)
    const serialized = serializePromptContext(localizePeople(unique), request.maxCharacters)
    const selected = unique.slice(0, serialized.includedItems).map(candidate => candidate.manifest)
    const truncated = serialized.truncated || deduplicated.length > unique.length

    return {
      sentinel: 'ok',
      ...serialized,
      manifest: {
        ...baseManifest,
        appliedModes: Object.freeze([...new Set(appliedModes)]),
        ...(appliedModes.includes('lexical') ? { analyzerIdentity: needsCjkTokenizer(request.query) ? 'sqlite-fts5-cjk-trigram-v1' : 'sqlite-fts5-latin-unicode61-v1' } : {}),
        selected,
        omittedLayers,
        truncated,
      },
    }
  }

  private authorizedScope(request: RecentContextRequest): ReturnType<ContextRepositories['policyData']['findExact']> {
    validateRequestBudget(request)
    const targetScope: Scope = { kind: 'logical_room', id: request.logicalRoomId }
    assertAuthorized(request.authorization, { operation: 'context:read', targetScope })
    return this.repositories.policyData.findExact({
      physicalRoomId: request.physicalRoomId,
      logicalRoomId: request.logicalRoomId,
      characterId: request.characterId,
      at: asTimestamp(new Date().toISOString()),
    })
  }

  private recentCandidates(request: RecentContextRequest, candidateReadLimit: number): readonly RecentCandidate[] {
    const inbound: RecentCandidate[] = this.repositories.events.recentForLogical({ logicalRoomId: request.logicalRoomId, characterId: request.characterId, limit: candidateReadLimit, excludeEventIds: request.excludeEventIds })
      .flatMap(event => event.payload.redacted || !event.payload.content
        ? []
        : [{
            id: event.eventId,
            ...(event.actor.kind === 'attributed' ? { personKey: event.actor.personId } : {}),
            prompt: { layer: 'recent' as const, modality: event.kind === 'user_voice' ? 'voice' as const : 'text' as const, text: event.payload.content },
            at: event.occurredAt,
            manifest: { layer: 'recent' as const, reason: 'recent' as const, source: { sourceType: 'inbound' as const, eventId: event.eventId } },
          }])
    const assistant: RecentCandidate[] = this.repositories.deliveries.eligibleForLogical(
      { logicalRoomId: request.logicalRoomId, characterId: request.characterId, limit: candidateReadLimit, excludeEventIds: request.excludeEventIds },
      { allowPartialAssistantOutput: false, treatCompletedPlaybackAsEligible: true },
    ).map(output => ({
      id: output.segment.segmentId,
      prompt: { layer: 'recent', modality: output.segment.modality, text: output.text },
      at: output.attempt.lastTransitionAt,
      manifest: { layer: 'recent', reason: 'recent', source: { sourceType: 'assistant_output', segmentId: output.segment.segmentId, deliveryId: output.attempt.deliveryId, deliveryState: output.attempt.state, deliveryStateAt: output.attempt.lastTransitionAt } },
    }))
    return [...inbound, ...assistant].sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || left.id.localeCompare(right.id))
  }

  private layerEnabled(layer: LayeredContextRequest['includeLayers'][number]): boolean {
    if (layer === 'recent')
      return this.flags.sharedRecentContext
    if (layer === 'summary')
      return this.flags.summaries
    if (layer === 'semantic')
      return this.flags.explicitSemanticMemory || this.flags.autoExtraction
    return this.flags.autoExtraction
  }

  private emptyRecent(request: RecentContextRequest): RecentContextResult {
    return {
      sentinel: 'noDurableContext',
      text: '',
      includedItems: 0,
      truncated: false,
      manifest: { formatVersion: 1, logicalRoomVersion: 0, maxItems: request.maxItems, maxCharacters: request.maxCharacters, selected: [], truncated: false, bindingRevision: 0, candidateReadLimit: 0 },
    }
  }
}

function validateRequestBudget(request: RecentContextRequest): void {
  if (!Number.isSafeInteger(request.maxItems) || request.maxItems < 1 || request.maxItems > 250)
    throw new RangeError('context maxItems must be between 1 and 250')
  if (!Number.isSafeInteger(request.maxCharacters) || request.maxCharacters < 64)
    throw new RangeError('context maxCharacters must be an integer of at least 64')
}

function localizePeople(candidates: readonly (RecentCandidate | DerivedCandidate)[]): PromptContextItem[] {
  const localPeople = new Map<string, string>()
  return candidates.map((candidate) => {
    if (!candidate.personKey)
      return candidate.prompt
    let personRef = localPeople.get(candidate.personKey)
    if (!personRef) {
      personRef = `p_${localPeople.size + 1}`
      localPeople.set(candidate.personKey, personRef)
    }
    return { ...candidate.prompt, personRef }
  })
}

function derivedCandidate(record: DerivedRecord, reason: 'exact' | 'lexical' | 'current-summary', rank?: number): DerivedCandidate {
  const common = {
    reason,
    validFrom: record.validity.validFrom,
    recordedAt: record.validity.recordedAt,
    provenanceSource: record.provenance.source,
    extractionMethod: record.provenance.method,
    sourceEventIds: record.provenance.sourceEventIds,
    ...(rank == null ? {} : { rank }),
  }
  if (record.layer === 'summary') {
    return { id: record.summaryId, prompt: { layer: 'summary', text: record.text }, manifest: { layer: 'summary', recordId: record.summaryId, ...common } }
  }
  if (record.layer === 'semantic') {
    return { id: record.factId, ...(record.personId ? { personKey: record.personId } : {}), prompt: { layer: 'semantic', text: `${record.predicate}: ${record.value}` }, manifest: { layer: 'semantic', recordId: record.factId, ...common } }
  }
  if (record.layer === 'episodic') {
    return { id: record.episodicId, ...(record.personId ? { personKey: record.personId } : {}), prompt: { layer: 'episodic', text: record.summary }, manifest: { layer: 'episodic', recordId: record.episodicId, ...common } }
  }
  throw new Error('Procedural memory is not serialized as untrusted conversational context')
}
