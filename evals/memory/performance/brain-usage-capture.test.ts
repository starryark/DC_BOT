import type { BrainProvider, BrainRequest } from '../../../src/providers/brain/types'
import type { BrainUsageSink, UsageDisposition, UsageRecord } from './provider-observability'

import { describe, expect, it } from 'vitest'

import { BrainUsageCaptureError, brainUsageProbeRequest, captureBrainUsageRecord } from './brain-usage-capture'

/**
 * Credential-free tests for the controlled brain-usage capture.
 *
 * A fake provider stands in for `GeminiBrainProvider` so the capture contract —
 * one completed record, generated text discarded, everything ambiguous refused
 * — is proven without a paid call. The real provider is wired only by the CLI.
 */

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    schemaVersion: 1,
    provider: 'gemini',
    model: 'gemini-3.6-flash',
    correlationId: 'usage-probe-brain-usage-001',
    inputTokens: 1000,
    outputTokens: 200,
    thinkingTokens: null,
    totalTokens: 1200,
    disposition: 'complete',
    retryCount: 0,
    observedAt: '2026-08-16T00:30:00Z',
    ...overrides,
  }
}

/** A provider that streams the supplied chunks, then emits the supplied records. */
function fakeProvider(options: {
  readonly chunks?: readonly string[]
  readonly emits?: readonly UsageRecord[]
  readonly throwAfterStream?: boolean
  readonly seen?: { requests: BrainRequest[] }
}) {
  return (usageSink: BrainUsageSink): BrainProvider => ({
    async* generate(request) {
      options.seen?.requests.push(request)
      for (const chunk of options.chunks ?? ['ok'])
        yield chunk
      for (const emitted of options.emits ?? [record()])
        usageSink(emitted)
      if (options.throwAfterStream)
        throw new Error('upstream said: <generated text that must never be retained>')
    },
  })
}

const CAPTURE = { correlationId: 'usage-probe-brain-usage-001', signal: new AbortController().signal }

describe('brain usage capture', () => {
  it('returns the single completed usage record', async () => {
    const captured = await captureBrainUsageRecord({ createProvider: fakeProvider({}), ...CAPTURE })
    expect(captured).toEqual(record())
  })

  it('drains the stream without retaining generated text', async () => {
    const captured = await captureBrainUsageRecord({
      createProvider: fakeProvider({ chunks: ['secret ', 'generated ', 'reply'] }),
      ...CAPTURE,
    })
    // The record is the only thing the capture returns, and it is numeric.
    expect(JSON.stringify(captured)).not.toContain('generated')
    expect(captured.totalTokens).toBe(1200)
  })

  it('sends one fixed synthetic request with no user content', async () => {
    const seen = { requests: [] as BrainRequest[] }
    await captureBrainUsageRecord({ createProvider: fakeProvider({ seen }), ...CAPTURE })
    expect(seen.requests).toHaveLength(1)
    const sent = seen.requests[0]!
    expect(sent.turnId).toBe(CAPTURE.correlationId)
    expect(sent.guildId).toBe('benchmark-usage-probe')
    expect(sent.userId).toBe('benchmark-usage-probe')
    expect(sent.contents).toEqual(brainUsageProbeRequest(CAPTURE.correlationId).contents)
  })

  it('fails closed when the sink emitted nothing', async () => {
    await expect(captureBrainUsageRecord({ createProvider: fakeProvider({ emits: [] }), ...CAPTURE }))
      .rejects
      .toMatchObject({ reason: 'no-usage-record' })
  })

  it('fails closed when the sink emitted more than one record', async () => {
    // Two records means the sink contract is ambiguous, and neither can be
    // called "the" observation this sample priced.
    await expect(captureBrainUsageRecord({ createProvider: fakeProvider({ emits: [record(), record({ inputTokens: 5 })] }), ...CAPTURE }))
      .rejects
      .toMatchObject({ reason: 'multiple-usage-records' })
  })

  it('fails closed on a call that did not complete', async () => {
    for (const disposition of ['failed', 'aborted', 'unavailable'] as UsageDisposition[]) {
      await expect(captureBrainUsageRecord({ createProvider: fakeProvider({ emits: [record({ disposition })] }), ...CAPTURE }))
        .rejects
        .toMatchObject({ reason: 'usage-not-complete' })
    }
  })

  it('fails closed when the provider exposed no token counts', async () => {
    await expect(captureBrainUsageRecord({
      createProvider: fakeProvider({ emits: [record({ inputTokens: null, outputTokens: null, thinkingTokens: null, totalTokens: null })] }),
      ...CAPTURE,
    })).rejects.toMatchObject({ reason: 'usage-tokens-unavailable' })
  })

  it('reports the observed disposition rather than the thrown provider error', async () => {
    // The thrown error's message may echo upstream payload text, so the failure
    // reason is decided by what the sink observed, not by the error.
    const failure = await captureBrainUsageRecord({
      createProvider: fakeProvider({ emits: [record({ disposition: 'failed' })], throwAfterStream: true }),
      ...CAPTURE,
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BrainUsageCaptureError)
    expect(failure).toMatchObject({ reason: 'usage-not-complete', generationFailed: true })
    expect(String(failure)).not.toContain('generated text')
  })
})
