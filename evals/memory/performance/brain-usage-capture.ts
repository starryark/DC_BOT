import type { BrainProvider, BrainRequest } from '../../../src/providers/brain/types'
import type { BrainUsageSink, UsageRecord } from './provider-observability'

/**
 * Controlled brain-usage capture for the IMP-803 cost-evidence path.
 *
 * The deterministic benchmark never calls a provider. This is the one place a
 * paid call is made, and only when an operator deliberately runs
 * `memory:capture-brain-usage` with credentials. It exists because
 * `calculateCost()` needs real observed token counts, and no offline workload
 * can produce them.
 *
 * What it captures is numeric only: the provider's own {@link BrainUsageSink}
 * emits at most one content-free {@link UsageRecord} per call, and the streamed
 * text is discarded chunk by chunk rather than accumulated. The probe request
 * is fixed and carries synthetic identifiers, so no guild, user, turn, or
 * conversation content is involved on either side of the call.
 *
 * Every ambiguity fails closed. A capture that observed nothing, observed more
 * than one record, or observed a call that did not complete is not evidence,
 * and returning a partial record would put unfinished-call token counts on the
 * path to a priced amount.
 */

/** Why a capture produced no usable usage evidence; stable and content-free. */
export const BRAIN_USAGE_CAPTURE_FAILURES = Object.freeze([
  'no-usage-record',
  'multiple-usage-records',
  'usage-not-complete',
  'usage-tokens-unavailable',
] as const)
export type BrainUsageCaptureFailure = typeof BRAIN_USAGE_CAPTURE_FAILURES[number]

/**
 * The synthetic identity every probe request carries.
 *
 * The provider derives its correlation id from `turnId ?? guildId:userId`, so
 * these must never be real ids: a capture writes its correlation id into an
 * importable artifact.
 */
const PROBE_IDENTITY = 'benchmark-usage-probe'

/** A capture that observed no trustworthy completed usage record. */
export class BrainUsageCaptureError extends Error {
  constructor(readonly reason: BrainUsageCaptureFailure, readonly generationFailed: boolean) {
    super(`brain usage capture failed: ${reason}`)
    this.name = 'BrainUsageCaptureError'
  }
}

/**
 * The one fixed probe request a capture sends.
 *
 * It is deliberately not configurable: an operator-supplied prompt would make
 * the capture a generation tool, and its text would then be an input worth
 * recording — which is exactly what this path must never retain.
 */
export function brainUsageProbeRequest(correlationId: string): BrainRequest {
  return {
    guildId: PROBE_IDENTITY,
    userId: PROBE_IDENTITY,
    turnId: correlationId,
    systemInstruction: 'You are a token-usage metering probe. Answer with one short word.',
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
    generationProfile: { thinkingLevel: 'minimal', maxOutputTokens: 64, responseLengthClass: 'casual' },
  }
}

/**
 * Run one probe generation and return the single completed usage record.
 *
 * `createProvider` receives the usage sink to install, so a credential-free
 * test can supply a fake provider and the CLI can supply the real
 * `GeminiBrainProvider` without this module importing the SDK.
 *
 * The stream is drained to completion because the final usage metadata rides
 * the last chunk; a caller that stopped early would observe partial counts.
 */
export async function captureBrainUsageRecord(params: {
  readonly createProvider: (usageSink: BrainUsageSink) => BrainProvider
  readonly correlationId: string
  readonly signal: AbortSignal
}): Promise<UsageRecord> {
  const records: UsageRecord[] = []
  const provider = params.createProvider(record => void records.push(record))

  let generationFailed = false
  try {
    for await (const _chunk of provider.generate(brainUsageProbeRequest(params.correlationId), params.signal)) {
      // Generated text is discarded the instant it arrives. The loop exists
      // only to drain the stream so the provider reaches its terminal emit.
    }
  }
  catch {
    // The provider still emits a terminal record on the failure path, so the
    // reason is decided below by what was observed rather than by the thrown
    // error — whose message may echo upstream payload text.
    generationFailed = true
  }

  if (records.length === 0)
    throw new BrainUsageCaptureError('no-usage-record', generationFailed)
  if (records.length > 1)
    throw new BrainUsageCaptureError('multiple-usage-records', generationFailed)

  const record = records[0]!
  if (record.disposition !== 'complete')
    throw new BrainUsageCaptureError('usage-not-complete', generationFailed)
  if (record.inputTokens == null && record.outputTokens == null && record.thinkingTokens == null)
    throw new BrainUsageCaptureError('usage-tokens-unavailable', generationFailed)
  return record
}
