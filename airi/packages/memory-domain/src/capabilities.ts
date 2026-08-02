/**
 * Capability negotiation (IMP-101; `artifacts/09-memory-port-api-spec.md` §10.3, §10.5).
 *
 * A backend advertises only what it can satisfy *correctly*. The alternative —
 * accepting a CJK search against a Latin-only tokenizer and returning zero
 * hits — looks like "the user never said that" and is indistinguishable from a
 * correct empty result. Refusing loudly is the only honest option (RISK-M).
 */

import { MemoryError } from './errors'

/** Capability identifiers. Protocol values: snake_case, stable across versions. */
export type Capability
  = | 'durable_events'
    | 'alias_support'
    | 'summaries'
    | 'structured_memory'
    | 'fulltext_latin'
    | 'fulltext_cjk'
    | 'vector_search'
    | 'graph_search'
    | 'export'
    | 'deletion'
    | 'remote_transport'
    | 'degraded_read_cache'

/** Every capability the contract knows about, in advertisement order. */
export const ALL_CAPABILITIES: readonly Capability[] = Object.freeze([
  'durable_events',
  'alias_support',
  'summaries',
  'structured_memory',
  'fulltext_latin',
  'fulltext_cjk',
  'vector_search',
  'graph_search',
  'export',
  'deletion',
  'remote_transport',
  'degraded_read_cache',
])

/**
 * Capabilities that may never be advertised in milestone 1, with the decision
 * that holds them shut.
 *
 * These are gated on *evidence*, not configuration: a backend that flips them
 * on locally would bypass the benchmark gate the red team made release-blocking
 * (FIND-004) and the topology gate of ADR-001 (FIND-002).
 */
export const M1_FORBIDDEN_CAPABILITIES: Readonly<Partial<Record<Capability, string>>> = Object.freeze({
  vector_search: 'ADR-011: requires an accepted retrieval benchmark (IMP-607)',
  graph_search: 'ADR-011: requires an accepted retrieval benchmark (IMP-607)',
  remote_transport: 'ADR-001: milestone 1 is in-process only (IMP-806 owns the topology decision)',
})

/** What a backend claims it can do, plus the schema version those claims belong to. */
export interface CapabilityAdvertisement {
  schemaVersion: number
  capabilities: readonly Capability[]
  backend: 'sqlite' | 'postgresql' | 'fake' | 'remote'
}

/**
 * The milestone-1 SQLite capability set (`09-…` §10.3).
 *
 * `fulltext_cjk` is deliberately absent: no CJK tokenizer has been chosen
 * (OQ-B3), so a CJK query must fail with `UNSUPPORTED_CAPABILITY` rather than
 * return a confidently empty result.
 */
export const M1_SQLITE_CAPABILITIES: readonly Capability[] = Object.freeze([
  'durable_events',
  'alias_support',
  'summaries',
  'structured_memory',
  'fulltext_latin',
  'export',
  'deletion',
])

/** The deterministic test fake advertises the same set as SQLite (`09-…` AC-3). */
export const TEST_FAKE_CAPABILITIES: readonly Capability[] = M1_SQLITE_CAPABILITIES

/**
 * Reject an advertisement that claims a gated capability.
 *
 * Called when a backend is composed, so a misconfigured adapter fails at
 * startup instead of the first time someone runs a vector query in production.
 */
export function assertAdvertisementAllowed(advertisement: CapabilityAdvertisement): void {
  for (const capability of advertisement.capabilities) {
    const reason = M1_FORBIDDEN_CAPABILITIES[capability]
    if (reason) {
      throw new MemoryError('UNSUPPORTED_CAPABILITY', `${capability} may not be advertised: ${reason}`, {
        retryable: false,
        details: { capability, backend: advertisement.backend },
      })
    }
  }
}

/** True when the advertisement includes `capability`. */
export function hasCapability(advertisement: CapabilityAdvertisement, capability: Capability): boolean {
  return advertisement.capabilities.includes(capability)
}

/**
 * Gate an operation on an advertised capability.
 *
 * The port rejects rather than degrades (`09-…` §10.5 rule 3): a caller that
 * asked for structured memory and silently got recent-context text would
 * produce answers with no provenance.
 */
export function requireCapability(advertisement: CapabilityAdvertisement, capability: Capability, operation: string): void {
  if (!hasCapability(advertisement, capability)) {
    throw new MemoryError('UNSUPPORTED_CAPABILITY', `${operation} requires the ${capability} capability, which this backend does not advertise`, {
      retryable: false,
      details: { capability, operation, backend: advertisement.backend },
    })
  }
}

/** Retrieval modes a caller may request from `searchMemory`. */
export type RetrievalMode = 'structured' | 'lexical' | 'vector' | 'graph'

/**
 * The capability each retrieval mode depends on.
 *
 * `lexical` maps to `fulltext_latin`; a CJK query needs `fulltext_cjk` as well,
 * which is why {@link capabilityForLexicalQuery} exists separately.
 */
export const CAPABILITY_FOR_MODE: Readonly<Record<RetrievalMode, Capability>> = Object.freeze({
  structured: 'structured_memory',
  lexical: 'fulltext_latin',
  vector: 'vector_search',
  graph: 'graph_search',
})

/**
 * Unicode ranges that need a segmenting tokenizer because they are written
 * without spaces: CJK ideographs, kana, and Hangul.
 */
const CJK_PATTERN = /[\u1100-\u11FF\u2E80-\u2FDF\u3000-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFF66-\uFF9F]/

/** True when the query contains script that a whitespace tokenizer cannot segment. */
export function needsCjkTokenizer(query: string): boolean {
  return CJK_PATTERN.test(query)
}

/**
 * Resolve which full-text capability a specific query requires.
 *
 * Splitting this out of {@link CAPABILITY_FOR_MODE} is the whole point of
 * RISK-M: `lexical` is not one capability, it is two, and conflating them is
 * exactly how "PostgreSQL supports full-text search" becomes a false claim
 * about Japanese recall.
 */
export function capabilityForLexicalQuery(query: string): Capability {
  return needsCjkTokenizer(query) ? 'fulltext_cjk' : 'fulltext_latin'
}
