import type { NormalizedMeasurement, ThresholdDocument } from './contracts'

/**
 * Threshold evaluation for the G8-1 evaluator (IMP-802, T004).
 *
 * Measurements are `measured_not_evaluated` when no approved threshold document
 * is supplied, and an unavailable metric never passes. A threshold document
 * whose provenance does not match the running dataset is invalid, not ignored
 * (handled in {@link ./contracts.ts#parseThresholdDocument}).
 */

/** The outcome of evaluating one measurement against approved limits. */
export interface MeasurementEvaluation {
  readonly name: string
  /** `passed` only when an approved limit is satisfied; never from absence. */
  readonly status: 'passed' | 'failed' | 'measured_not_evaluated'
  readonly limit?: { readonly operation: string, readonly value: number }
}

/**
 * Evaluate measurements against an approved threshold document.
 *
 * With no document, every measurement is `measured_not_evaluated`. With one,
 * each named limit is applied; a measurement with no matching limit stays
 * `measured_not_evaluated`. This reuses the G2 rule: software evidence is
 * separate from approval.
 */
export function evaluateMeasurements(measurements: readonly NormalizedMeasurement[], thresholds: ThresholdDocument | undefined): readonly MeasurementEvaluation[] {
  if (!thresholds)
    return measurements.map(measurement => ({ name: measurement.name, status: 'measured_not_evaluated' as const }))

  return measurements.map((measurement) => {
    const limit = thresholds.limits.find(candidate => candidate.metric === measurement.name)
    if (!limit)
      return { name: measurement.name, status: 'measured_not_evaluated' as const }
    const ok = applies(measurement.value, limit.operation, limit.value)
    return { name: measurement.name, status: ok ? 'passed' as const : 'failed' as const, limit: { operation: limit.operation, value: limit.value } }
  })
}

function applies(value: number, operation: string, limit: number): boolean {
  switch (operation) {
    case '<=': return value <= limit
    case '>=': return value >= limit
    case '<': return value < limit
    case '>': return value > limit
    case '==': return value === limit
    default: return false
  }
}

/** True when every evaluated measurement passed (failures are gate-blocking). */
export function allMeasurementsPassed(evaluations: readonly MeasurementEvaluation[]): boolean {
  return evaluations.every(evaluation => evaluation.status !== 'failed')
}
