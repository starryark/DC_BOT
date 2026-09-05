import type { LiveArtifact } from './live-artifact'

import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { isBrainUsageLiveArtifact, liveArtifactDigest, liveArtifactSchema, parseLiveArtifact, scanLiveArtifactForProhibitedContent, summarizeLiveArtifactFile } from './live-artifact'
import { usageRecordSchema } from './provider-observability'

/**
 * Live-artifact import tests for the IMP-803 benchmark.
 *
 * These assert the strict summary schema, the content-free file summarization
 * (digest + size, never the payload), and the prohibited-content scan that
 * rejects paths, snowflakes, secret-bearing fields, and content markers.
 *
 * The kind-specific half pins the boundary the cost path depends on: a
 * `brain-usage-sample` must carry a structured usage record, and an ASR or TTS
 * sample must not be able to carry one.
 */

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function validSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: 1,
    kind: 'asr-sample',
    sampleId: 'asr-sample-001',
    fileDigest: 'a'.repeat(64),
    fileSizeBytes: 1024,
    hostProvenance: 'operator-host-a',
    configProvenance: 'asr-config-v1',
    observedAt: '2026-08-06T00:00:00Z',
    ...overrides,
  }
}

describe('live artifact schema', () => {
  it('accepts a well-formed content-free summary', () => {
    expect(() => v.parse(liveArtifactSchema, validSummary())).not.toThrow()
  })

  it('accepts optional metric fields', () => {
    expect(() => v.parse(liveArtifactSchema, validSummary({ metricName: 'inferenceMs', metricValue: 120, metricUnit: 'ms' }))).not.toThrow()
  })

  it('rejects an unknown kind', () => {
    expect(() => v.parse(liveArtifactSchema, validSummary({ kind: 'video-sample' }))).toThrow()
  })

  it('rejects a malformed digest', () => {
    expect(() => v.parse(liveArtifactSchema, validSummary({ fileDigest: 'short' }))).toThrow()
  })
})

/** A numeric-only usage record the cost calculator can consume. */
function validUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    correlationId: 'usage-probe-brain-usage-001',
    inputTokens: 1200,
    outputTokens: 340,
    thinkingTokens: null,
    totalTokens: 1540,
    disposition: 'complete',
    retryCount: 0,
    observedAt: '2026-08-16T00:30:00Z',
    ...overrides,
  }
}

/** A brain-usage summary whose artifact and usage timestamps agree. */
function validBrainSummary(overrides: Record<string, unknown> = {}, usageOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const usage = validUsage(usageOverrides)
  return validSummary({
    kind: 'brain-usage-sample',
    sampleId: 'brain-usage-001',
    observedAt: usage.observedAt,
    usage,
    ...overrides,
  })
}

describe('brain-usage live artifact', () => {
  it('accepts a structured usage payload', () => {
    const artifact = parseLiveArtifact(validBrainSummary())
    expect(artifact.kind).toBe('brain-usage-sample')
    expect(isBrainUsageLiveArtifact(artifact)).toBe(true)
    if (isBrainUsageLiveArtifact(artifact)) {
      expect(artifact.usage.inputTokens).toBe(1200)
      expect(artifact.usage.disposition).toBe('complete')
    }
  })

  it('produces a stable canonical digest', () => {
    const first = parseLiveArtifact(validBrainSummary())
    const second = parseLiveArtifact(validBrainSummary())
    expect(liveArtifactDigest(first)).toBe(liveArtifactDigest(second))
    expect(liveArtifactDigest(first)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects a brain sample with no usage record', () => {
    const withoutUsage = validBrainSummary()
    delete withoutUsage.usage
    expect(() => parseLiveArtifact(withoutUsage)).toThrow()
  })

  it('rejects a brain sample whose usage record is not the numeric contract', () => {
    expect(() => parseLiveArtifact(validBrainSummary({}, { inputTokens: 'many' }))).toThrow()
    expect(() => parseLiveArtifact(validBrainSummary({}, { disposition: 'partial' }))).toThrow()
  })

  it('rejects an ASR or TTS sample carrying brain usage', () => {
    // ROOT CAUSE:
    //
    // One permissive shape for all three kinds would let a usage payload ride
    // on a sample whose capture path never observed a provider call, and the
    // cost derivation reads usage by field presence.
    //
    // The kinds are separate strict shapes, so the field is unknown on the ASR
    // and TTS options and the parse fails.
    expect(() => parseLiveArtifact(validSummary({ kind: 'asr-sample', usage: validUsage() }))).toThrow()
    expect(() => parseLiveArtifact(validSummary({ kind: 'tts-sample', usage: validUsage() }))).toThrow()
  })

  it('rejects an unknown field inside the nested usage record', () => {
    expect(() => parseLiveArtifact(validBrainSummary({}, { promptChars: 42 }))).toThrow()
  })

  it('rejects prohibited content inside the nested usage record', () => {
    expect(() => parseLiveArtifact(validBrainSummary({}, { correlationId: '123456789012345678' }))).toThrow(/prohibited content/)
    expect(() => parseLiveArtifact(validBrainSummary({}, { model: '/opt/models/private' }))).toThrow(/prohibited content/)
  })

  it('rejects an artifact whose observedAt disagrees with its usage record', () => {
    expect(() => parseLiveArtifact(validBrainSummary({ observedAt: '2026-08-16T09:00:00Z' })))
      .toThrow(/observedAt must equal/)
  })

  it('represents a non-complete observation without making it usable', () => {
    // A failed call is still representable evidence; nothing here promotes it,
    // and the cost derivation refuses it (see cost-evidence.test.ts).
    const artifact = parseLiveArtifact(validBrainSummary({}, { disposition: 'failed' }))
    expect(isBrainUsageLiveArtifact(artifact) && artifact.usage.disposition).toBe('failed')
  })
})

describe('live artifact prohibited content scan', () => {
  it('rejects a snowflake-shaped identifier', () => {
    const artifact = { ...validSummary(), sampleId: '123456789012345678' } as unknown as LiveArtifact
    expect(scanLiveArtifactForProhibitedContent(artifact)).toContain('snowflake-shaped-identifier')
  })

  it('rejects an absolute path in a provenance field', () => {
    const artifact = { ...validSummary(), hostProvenance: '/Users/operator/runs' } as unknown as LiveArtifact
    expect(scanLiveArtifactForProhibitedContent(artifact)).toContain('absolute-or-relative-path')
  })

  it('rejects a secret-bearing field name', () => {
    const artifact = { ...validSummary(), secret: 'leak' } as unknown as LiveArtifact
    expect(scanLiveArtifactForProhibitedContent(artifact)).toContain('secret-bearing-field')
  })

  it('passes a clean summary', () => {
    const artifact = v.parse(liveArtifactSchema, validSummary()) as LiveArtifact
    expect(scanLiveArtifactForProhibitedContent(artifact)).toEqual([])
  })

  it('parseLiveArtifact rejects a summary carrying prohibited content', () => {
    expect(() => parseLiveArtifact({ ...validSummary(), hostProvenance: '/secret/path' })).toThrow(/prohibited content/)
  })
})

describe('summarizeLiveArtifactFile', () => {
  it('records the file digest and size without embedding contents', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-art-'))
    scratch.push(dir)
    const filePath = join(dir, 'sample.bin')
    const payload = Buffer.from('benchmark-payload-content')
    writeFileSync(filePath, payload)
    const summary = await summarizeLiveArtifactFile({
      path: filePath,
      kind: 'tts-sample',
      sampleId: 'tts-sample-001',
      hostProvenance: 'operator-host-a',
      configProvenance: 'tts-config-v1',
      observedAt: '2026-08-06T00:00:00Z',
      metricName: 'synthesisMs',
      metricValue: 200,
      metricUnit: 'ms',
    })
    expect(summary.fileSizeBytes).toBe(payload.length)
    expect(summary.fileDigest).toMatch(/^[0-9a-f]{64}$/)
    // The summary must not embed the file contents.
    expect(JSON.stringify(summary)).not.toContain('benchmark-payload-content')
    // The summary must not embed the file path.
    expect(JSON.stringify(summary)).not.toContain(filePath)
  })

  it('produces a stable digest for the same summary', () => {
    const artifact = v.parse(liveArtifactSchema, validSummary()) as LiveArtifact
    expect(liveArtifactDigest(artifact)).toMatch(/^[0-9a-f]{64}$/)
    expect(liveArtifactDigest(artifact)).toBe(liveArtifactDigest(artifact))
  })

  it('carries the captured usage record into a brain sample summary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-art-'))
    scratch.push(dir)
    const filePath = join(dir, 'usage-record.json')
    const usage = validUsage()
    writeFileSync(filePath, `${JSON.stringify(usage, null, 2)}
`)
    const summary = await summarizeLiveArtifactFile({
      path: filePath,
      kind: 'brain-usage-sample',
      sampleId: 'brain-usage-001',
      hostProvenance: 'operator-host-a',
      configProvenance: 'brain-capture-v1',
      observedAt: usage.observedAt as string,
      usage: v.parse(usageRecordSchema, usage),
    })
    expect(isBrainUsageLiveArtifact(summary) && summary.usage.totalTokens).toBe(1540)
    expect(summary.fileDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(summary)).not.toContain(filePath)
  })
})
