import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import * as v from 'valibot'

import { type LiveArtifact, liveArtifactDigest, liveArtifactSchema, parseLiveArtifact, scanLiveArtifactForProhibitedContent, summarizeLiveArtifactFile } from './live-artifact'

/**
 * Live-artifact import tests for the IMP-803 benchmark.
 *
 * These assert the strict summary schema, the content-free file summarization
 * (digest + size, never the payload), and the prohibited-content scan that
 * rejects paths, snowflakes, secret-bearing fields, and content markers.
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
})
