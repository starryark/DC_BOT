/**
 * Provenance, confidence, and temporal validity (IMP-108; ADR-009).
 *
 * The failure this prevents: the bot speculates "you probably like jazz", the
 * extractor stores that sentence, and three days later the bot states it as
 * something the user said. Provenance is what separates "the user told me" from
 * "I said it once", and the type system refuses to let the second become the
 * first (REQ-MEM-003, TEST-MEM-001).
 */

import type { EventId, Timestamp } from './ids'

import { MemoryError } from './errors'

/**
 * Where an assertion came from.
 *
 * - `userStated` — the subject said it themselves.
 * - `operator` — a human operator entered it through an admin surface.
 * - `assistantSpeculation` — the assistant produced it. Never durable alone.
 * - `derived` — produced by a job from other records; carries lineage to them.
 */
export type ProvenanceSource = 'userStated' | 'operator' | 'assistantSpeculation' | 'derived'

/** How the assertion was obtained. */
export type ExtractionMethod = 'explicitCommand' | 'llmExtraction' | 'ruleExtraction' | 'operatorEntry' | 'summarization'

/**
 * Where a record came from, and from what.
 *
 * `sourceEventIds` must be non-empty for everything except operator entry:
 * a derived memory with no lineage cannot be deleted when its sources are
 * (REQ-MEM-005, SCN-031).
 */
export interface Provenance {
  source: ProvenanceSource
  method: ExtractionMethod
  sourceEventIds: readonly EventId[]
  /** When the assertion was made, as opposed to when it was recorded. */
  statedAt: Timestamp
  /** Who entered it, for `operator` provenance. */
  authoredBy?: string
}

/**
 * Whether a record backed by this provenance may be treated as durable truth.
 *
 * Assistant speculation is always a `candidate`: it may be stored, retrieved
 * for review, and shown to an operator, but it must never be retrieved as
 * something the user asserted until a person confirms it (`09-…` OP-08).
 */
export function durabilityOf(provenance: Provenance): 'durable' | 'candidate' {
  return provenance.source === 'assistantSpeculation' ? 'candidate' : 'durable'
}

/** Reject storing assistant speculation as an asserted user fact. */
export function assertDurableProvenance(provenance: Provenance): void {
  if (durabilityOf(provenance) === 'candidate') {
    throw new MemoryError('ASSISTANT_FACT_NOT_DURABLE', 'assistant-generated statements are stored as candidates and require confirmation before becoming user facts', {
      retryable: false,
      details: { source: provenance.source, method: provenance.method },
    })
  }
  if (provenance.source !== 'operator' && provenance.sourceEventIds.length === 0) {
    throw new MemoryError('MISSING_PROVENANCE', 'a durable record must cite at least one source event so deletion can find it', {
      retryable: false,
      details: { source: provenance.source },
    })
  }
  if (provenance.source === 'operator' && !provenance.authoredBy) {
    throw new MemoryError('MISSING_PROVENANCE', 'operator-authored records must name their author', { retryable: false })
  }
}

/** Confidence in `[0, 1]`. */
export type Confidence = number

/**
 * Coarse bands, used in prompts.
 *
 * The model sees a band, never the number: a spurious "0.73" invites the model
 * to reason about a precision the extractor does not have.
 */
export type ConfidenceBand = 'low' | 'medium' | 'high'

export function asConfidence(value: number): Confidence {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new MemoryError('INVALID_CONFIDENCE', 'confidence must be a finite number in [0, 1]', {
      retryable: false,
      details: { value: String(value) },
    })
  }
  return value
}

/** Band thresholds. Versioned constants, not tuning knobs (REQ-EVAL-002). */
export function confidenceBand(confidence: Confidence): ConfidenceBand {
  if (confidence >= 0.8)
    return 'high'
  if (confidence >= 0.5)
    return 'medium'
  return 'low'
}

/**
 * Bitemporal validity.
 *
 * `validFrom`/`validUntil` describe when the fact was true in the world;
 * `recordedAt` describes when the system learned it. Both are needed: "what did
 * we believe on Tuesday" and "what was true on Tuesday" are different questions,
 * and correction handling depends on telling them apart (TEST-MEM-002).
 */
export interface TemporalValidity {
  validFrom: Timestamp
  validUntil?: Timestamp
  recordedAt: Timestamp
}

/** True when the record is valid at `at` in world time. */
export function isValidAt(validity: TemporalValidity, at: Timestamp): boolean {
  if (Date.parse(validity.validFrom) > Date.parse(at))
    return false
  return validity.validUntil == null || Date.parse(validity.validUntil) > Date.parse(at)
}

/** True when the system already knew the record at `at`. */
export function wasKnownAt(validity: TemporalValidity, at: Timestamp): boolean {
  return Date.parse(validity.recordedAt) <= Date.parse(at)
}
