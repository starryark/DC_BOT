import { describe, expect, it } from 'vitest'

import { compareAgainstBaseline } from './baseline'
import { MeasurementRecord, RunManifest } from './contracts'

describe('baseline comparison', () => {
  it('detects incompatible contract digests', () => {
    const baseManifest = { contractDigest: 'a'.repeat(64) } as RunManifest
    const candManifest = { contractDigest: 'b'.repeat(64) } as RunManifest
    const result = compareAgainstBaseline(baseManifest, [], candManifest, [])
    expect(result.status).toBe('incompatible')
    expect(result.message).toMatch(/mismatch/)
  })

  it('computes deltas for matching metrics', () => {
    const manifest = { contractDigest: 'a'.repeat(64) } as RunManifest
    const baseRec: MeasurementRecord = {
      metricId: 'test.p50',
      outcome: { disposition: 'observed', value: 100 },
      unit: 'milliseconds',
      statistic: 'p50'
    } as any
    const candRec: MeasurementRecord = {
      metricId: 'test.p50',
      outcome: { disposition: 'observed', value: 120 },
      unit: 'milliseconds',
      statistic: 'p50'
    } as any

    const result = compareAgainstBaseline(manifest, [baseRec], manifest, [candRec])
    expect(result.status).toBe('compatible')
    expect(result.deltas).toHaveLength(1)
    expect(result.deltas![0].delta).toBe(20)
  })
})
