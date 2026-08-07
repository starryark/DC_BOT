import * as v from 'valibot'

import { sha256Canonical } from '../contracts'
import {
  MEASUREMENT_STATISTICS,
  MEASUREMENT_UNITS,
  PERFORMANCE_CONTRACT_ID,
  PERFORMANCE_SCHEMA_VERSION,
  type MeasurementRecord,
  type WorkloadSpec,
} from './contracts'

const workloadIdPattern = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{2,62}$/))
const metricIdPattern = v.pipe(v.string(), v.regex(/^[a-z][\w.-]{2,127}$/i))

export const performanceThresholdEntrySchema = v.strictObject({
  workloadId: workloadIdPattern,
  metricId: metricIdPattern,
  statistic: v.picklist(MEASUREMENT_STATISTICS),
  unit: v.picklist(MEASUREMENT_UNITS),
  comparator: v.picklist(['lte', 'gte'] as const),
  bound: v.pipe(v.number(), v.finite(), v.minValue(0)),
})

export type PerformanceThresholdEntry = v.InferOutput<typeof performanceThresholdEntrySchema>

export const performanceThresholdDocumentSchema = v.strictObject({
  format: v.literal('performance-thresholds'),
  schemaVersion: v.literal(PERFORMANCE_SCHEMA_VERSION),
  contractId: v.literal(PERFORMANCE_CONTRACT_ID),
  contractDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  source: v.pipe(v.string(), v.minLength(1)),
  approver: v.pipe(v.string(), v.minLength(1)),
  approvedAt: v.pipe(v.string(), v.minLength(1)),
  provenance: v.pipe(v.string(), v.minLength(1)),
  effectiveStart: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  effectiveEnd: v.optional(v.union([v.pipe(v.string(), v.minLength(1)), v.null()])),
  thresholds: v.array(performanceThresholdEntrySchema),
})

export type PerformanceThresholdDocument = v.InferOutput<typeof performanceThresholdDocumentSchema>

export function parsePerformanceThresholdDocument(input: unknown): PerformanceThresholdDocument {
  return v.parse(performanceThresholdDocumentSchema, input)
}

export function performanceThresholdDocumentDigest(document: PerformanceThresholdDocument): string {
  return sha256Canonical(document)
}

export function validatePerformanceThresholdCompatibility(document: PerformanceThresholdDocument, contractDigest: string, workloads: readonly WorkloadSpec[]): readonly string[] {
  const failures: string[] = []
  
  if (document.contractDigest !== contractDigest) {
    failures.push(`document contract digest ${document.contractDigest} does not match current contract digest ${contractDigest}`)
  }

  const knownWorkloads = new Set(workloads.map(w => w.workloadId))
  const seenIdentities = new Set<string>()

  for (const entry of document.thresholds) {
    const identity = `${entry.workloadId}:${entry.metricId}:${entry.statistic}:${entry.unit}`
    if (seenIdentities.has(identity)) {
      failures.push(`duplicate threshold identity ${identity}`)
    }
    seenIdentities.add(identity)

    if (!knownWorkloads.has(entry.workloadId)) {
      failures.push(`threshold entry references unknown workload ${entry.workloadId}`)
    }
  }

  return Object.freeze(failures)
}

export function applyPerformanceThresholds(measurements: readonly MeasurementRecord[], document: PerformanceThresholdDocument | undefined): MeasurementRecord[] {
  if (!document) {
    return measurements.map(m => ({ ...m, thresholdEvaluation: 'not_evaluated' as const }))
  }

  const thresholdMap = new Map<string, PerformanceThresholdEntry>()
  for (const entry of document.thresholds) {
    const identity = `${entry.workloadId}:${entry.metricId}:${entry.statistic}:${entry.unit}`
    thresholdMap.set(identity, entry)
  }

  return measurements.map(m => {
    const identity = `${m.workloadId}:${m.metricId}:${m.statistic}:${m.unit}`
    const threshold = thresholdMap.get(identity)

    if (!threshold) {
      return { ...m, thresholdEvaluation: 'not_evaluated' as const }
    }

    if (m.outcome.disposition === 'unavailable') {
      return { ...m, thresholdEvaluation: 'not_evaluated' as const }
    }

    const value = m.outcome.value
    let passed = false
    if (threshold.comparator === 'lte') {
      passed = value <= threshold.bound
    } else if (threshold.comparator === 'gte') {
      passed = value >= threshold.bound
    }

    return { ...m, thresholdEvaluation: passed ? 'passed' as const : 'failed' as const }
  })
}
