/**
 * Operator-supplied pass/fail limits for a G2 soak.
 *
 * The repository contains candidate latency numbers (`artifacts/16-…` §10.1),
 * but that artifact states plainly that they are test hypotheses and must not
 * be published as promises or encoded as release gates until approved. The
 * harness therefore refuses to invent limits: with no threshold document every
 * measurement is reported as `measured-not-evaluated`, and a threshold document
 * is accepted only when it names who approved the numbers and where they came
 * from.
 */

import { readFile } from 'node:fs/promises'

import { MemoryError } from '@proj-airi/memory-domain'

/** Direction of an operator limit. */
export type ThresholdComparison = 'atMost' | 'atLeast'

/** One approved limit against a flat metric key from `observedMetricValues`. */
export interface G2Threshold {
  readonly metric: string
  readonly comparison: ThresholdComparison
  readonly value: number
  readonly unit: string
  readonly note?: string
}

/**
 * A reviewed set of limits.
 *
 * `approvedBy`, `approvedAt`, and `source` are mandatory because an evaluated
 * pass/fail verdict is only meaningful when the evidence records whose
 * judgement it represents.
 */
export interface G2ThresholdDocument {
  readonly format: 1
  readonly approvedBy: string
  readonly approvedAt: string
  readonly source: string
  readonly thresholds: readonly G2Threshold[]
}

/** Outcome for one limit. `measured-not-evaluated` is the default when no limits exist. */
export type ThresholdStatus = 'passed' | 'failed' | 'measured-not-evaluated' | 'metric-unavailable'

/** One evaluated limit, or one measurement recorded without a limit. */
export interface ThresholdEvaluation {
  readonly metric: string
  readonly comparison: ThresholdComparison | null
  readonly threshold: number | null
  readonly unit: string | null
  readonly observed: number | null
  readonly status: ThresholdStatus
  readonly note?: string
}

/** Whole-run threshold verdict. */
export interface ThresholdReport {
  readonly status: 'evaluated' | 'measured-not-evaluated'
  readonly approvedBy: string | null
  readonly approvedAt: string | null
  readonly source: string | null
  readonly evaluations: readonly ThresholdEvaluation[]
  readonly failures: number
}

function assertString(document: Record<string, unknown>, field: string): string {
  const value = document[field]
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new MemoryError('INVALID_PAYLOAD', `the threshold document requires a non-empty ${field}; unattributed limits are not operator approval`)
  return value
}

/** Validate a parsed threshold document, throwing on any structural defect. */
export function parseThresholdDocument(raw: unknown): G2ThresholdDocument {
  if (typeof raw !== 'object' || raw === null)
    throw new MemoryError('INVALID_PAYLOAD', 'the threshold document must be a JSON object')
  const document = raw as Record<string, unknown>
  if (document.format !== 1)
    throw new MemoryError('INVALID_PAYLOAD', 'the threshold document must declare "format": 1')
  const approvedBy = assertString(document, 'approvedBy')
  const approvedAt = assertString(document, 'approvedAt')
  const source = assertString(document, 'source')
  if (!Number.isFinite(Date.parse(approvedAt)))
    throw new MemoryError('INVALID_TIMESTAMP', 'approvedAt must be an ISO timestamp')
  if (!Array.isArray(document.thresholds) || document.thresholds.length === 0)
    throw new MemoryError('INVALID_PAYLOAD', 'the threshold document must contain at least one threshold')

  const thresholds = document.thresholds.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null)
      throw new MemoryError('INVALID_PAYLOAD', `threshold ${index} must be an object`)
    const item = entry as Record<string, unknown>
    const metric = assertString(item, 'metric')
    const unit = assertString(item, 'unit')
    if (item.comparison !== 'atMost' && item.comparison !== 'atLeast')
      throw new MemoryError('INVALID_PAYLOAD', `threshold ${metric} must use comparison "atMost" or "atLeast"`)
    if (typeof item.value !== 'number' || !Number.isFinite(item.value))
      throw new MemoryError('INVALID_PAYLOAD', `threshold ${metric} must carry a finite numeric value`)
    const note = typeof item.note === 'string' ? item.note : undefined
    return Object.freeze({ metric, comparison: item.comparison, value: item.value, unit, ...(note == null ? {} : { note }) }) as G2Threshold
  })

  return Object.freeze({ format: 1, approvedBy, approvedAt, source, thresholds: Object.freeze(thresholds) })
}

/** Read and validate a threshold document from disk. */
export async function loadThresholdDocument(path: string): Promise<G2ThresholdDocument> {
  const raw = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    throw new MemoryError('INVALID_PAYLOAD', `G2_THRESHOLDS_FILE ${path} could not be read`, { cause: error })
  })
  try {
    return parseThresholdDocument(JSON.parse(raw))
  }
  catch (error) {
    if (error instanceof MemoryError)
      throw error
    throw new MemoryError('INVALID_PAYLOAD', `G2_THRESHOLDS_FILE ${path} is not valid JSON`, { cause: error })
  }
}

/**
 * Compare observations against approved limits.
 *
 * With no document, every observation is listed with `measured-not-evaluated`
 * so the report still carries the numbers without implying a verdict. A
 * threshold naming a metric the run did not produce is reported as
 * `metric-unavailable`, never as a pass.
 */
export function evaluateThresholds(document: G2ThresholdDocument | undefined, observed: ReadonlyMap<string, number>): ThresholdReport {
  if (document == null) {
    const evaluations = [...observed.entries()].map(([metric, value]) => Object.freeze({
      metric,
      comparison: null,
      threshold: null,
      unit: null,
      observed: value,
      status: 'measured-not-evaluated' as const,
    }))
    return Object.freeze({ status: 'measured-not-evaluated', approvedBy: null, approvedAt: null, source: null, evaluations: Object.freeze(evaluations), failures: 0 })
  }

  const evaluations = document.thresholds.map((threshold) => {
    const value = observed.get(threshold.metric)
    if (value == null) {
      return Object.freeze({
        metric: threshold.metric,
        comparison: threshold.comparison,
        threshold: threshold.value,
        unit: threshold.unit,
        observed: null,
        status: 'metric-unavailable' as const,
        ...(threshold.note == null ? {} : { note: threshold.note }),
      })
    }
    const passed = threshold.comparison === 'atMost' ? value <= threshold.value : value >= threshold.value
    return Object.freeze({
      metric: threshold.metric,
      comparison: threshold.comparison,
      threshold: threshold.value,
      unit: threshold.unit,
      observed: value,
      status: (passed ? 'passed' : 'failed') as ThresholdStatus,
      ...(threshold.note == null ? {} : { note: threshold.note }),
    })
  })

  const unevaluated = [...observed.entries()]
    .filter(([metric]) => !document.thresholds.some(threshold => threshold.metric === metric))
    .map(([metric, value]) => Object.freeze({ metric, comparison: null, threshold: null, unit: null, observed: value, status: 'measured-not-evaluated' as const }))

  return Object.freeze({
    status: 'evaluated',
    approvedBy: document.approvedBy,
    approvedAt: document.approvedAt,
    source: document.source,
    evaluations: Object.freeze([...evaluations, ...unevaluated]),
    failures: evaluations.filter(evaluation => evaluation.status === 'failed').length,
  })
}
