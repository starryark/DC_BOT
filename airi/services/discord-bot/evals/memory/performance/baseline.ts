import * as v from 'valibot'

import type { MeasurementRecord, RunManifest } from './contracts'

/**
 * Baseline comparison data structures for the IMP-803 deterministic benchmark.
 */

export const baselineComparisonResultSchema = v.strictObject({
  status: v.picklist(['compatible', 'incompatible', 'missing-metric']),
  message: v.optional(v.string()),
  deltas: v.optional(v.array(v.strictObject({
    metricId: v.string(),
    baselineValue: v.number(),
    candidateValue: v.number(),
    delta: v.number(),
    unit: v.string(),
    statistic: v.string(),
  }))),
})

export type BaselineComparisonResult = v.InferOutput<typeof baselineComparisonResultSchema>

/**
 * Compare candidate measurements against baseline measurements.
 */
export function compareAgainstBaseline(
  baselineManifest: RunManifest,
  baselineMeasurements: readonly MeasurementRecord[],
  candidateManifest: RunManifest,
  candidateMeasurements: readonly MeasurementRecord[]
): BaselineComparisonResult {
  if (baselineManifest.contractDigest !== candidateManifest.contractDigest) {
    return { status: 'incompatible', message: 'contractDigest mismatch between baseline and candidate' }
  }

  const baselineMap = new Map<string, MeasurementRecord>()
  for (const rec of baselineMeasurements) {
    baselineMap.set(rec.metricId, rec)
  }

  const deltas: NonNullable<BaselineComparisonResult['deltas']> = []

  for (const cand of candidateMeasurements) {
    const base = baselineMap.get(cand.metricId)
    if (!base) {
      // Missing metric in baseline
      continue
    }

    if (cand.outcome.disposition === 'observed' && base.outcome.disposition === 'observed') {
      deltas.push({
        metricId: cand.metricId,
        baselineValue: base.outcome.value,
        candidateValue: cand.outcome.value,
        delta: cand.outcome.value - base.outcome.value,
        unit: cand.unit,
        statistic: cand.statistic,
      })
    }
  }

  return { status: 'compatible', deltas }
}

export function loadRun(directory: string, readFileSync: (path: string, enc: 'utf8') => string, existsSync: (path: string) => boolean, join: (...paths: string[]) => string): { manifest: RunManifest, measurements: MeasurementRecord[] } {
  if (!existsSync(directory)) {
    throw new Error(`Directory not found: ${directory}`)
  }
  const manifestPath = join(directory, 'run-manifest.json')
  const measurementsPath = join(directory, 'measurements.jsonl')
  
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing run-manifest.json in ${directory}`)
  }
  if (!existsSync(measurementsPath)) {
    throw new Error(`Missing measurements.jsonl in ${directory}`)
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as RunManifest
  
  const measurements: MeasurementRecord[] = []
  const lines = readFileSync(measurementsPath, 'utf8').split('\n')
  for (const line of lines) {
    if (line.trim()) {
      measurements.push(JSON.parse(line))
    }
  }

  return { manifest, measurements }
}
