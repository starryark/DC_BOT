import type { UsageRecord } from './provider-observability'

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import * as v from 'valibot'

import { sha256Canonical } from '../contracts'
import { usageRecordSchema } from './provider-observability'

/**
 * Live-artifact import contract for the IMP-803 deterministic benchmark.
 *
 * Optional controlled live samples (ASR, TTS, brain usage) may be imported into
 * a deterministic benchmark report as separately-digested evidence, but their
 * values are never merged into the deterministic contract digest. This module
 * defines the versioned artifact schema, validates provenance, records a
 * content-free file digest/size rather than a path, and ensures the imported
 * artifact is content-free in its summary fields.
 *
 * Prompt text, transcript, audio, provider secrets, and private paths must
 * never appear in an imported artifact's summary; the raw file stays at its
 * private external location and only its digest and size are recorded.
 *
 * The three kinds are separate strict shapes rather than one permissive shape.
 * A `brain-usage-sample` carries the numeric {@link UsageRecord} the cost
 * calculator needs; an ASR or TTS sample has no such field and rejects one, so
 * a usage payload cannot be smuggled onto a kind whose capture path never
 * observed a provider call.
 */

/** The kind of live sample an imported artifact represents. */
export const LIVE_ARTIFACT_KINDS = Object.freeze(['asr-sample', 'tts-sample', 'brain-usage-sample'] as const)
export type LiveArtifactKind = typeof LIVE_ARTIFACT_KINDS[number]

/** Provenance and file-identity fields every live artifact carries. */
const liveArtifactCommonEntries = {
  format: v.literal(1),
  /** Content-free sample id; never a guild/user id or prompt/transcript. */
  sampleId: v.pipe(v.string(), v.regex(/^[\w.-]{1,64}$/, 'sample id must be alphanumeric/dotted/kebab-case')),
  /** SHA-256 of the raw artifact file; the file itself is never embedded. */
  fileDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  fileSizeBytes: v.pipe(v.number(), v.integer(), v.minValue(0)),
  /** Host/config provenance; content-free. */
  hostProvenance: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  configProvenance: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  observedAt: v.pipe(v.string(), v.minLength(1)),
  /** Optional numeric metric the sample establishes (e.g. asr inference ms). */
  metricName: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(120))),
  metricValue: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  metricUnit: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(40))),
} as const

const asrSampleSchema = v.strictObject({ kind: v.literal('asr-sample'), ...liveArtifactCommonEntries })
const ttsSampleSchema = v.strictObject({ kind: v.literal('tts-sample'), ...liveArtifactCommonEntries })

/**
 * A brain usage sample: the one kind that carries structured provider usage.
 *
 * `usage` is the existing numeric-only {@link usageRecordSchema}, reused rather
 * than restated, so the cost calculator and the observability sink agree on
 * what a token count means by construction.
 */
export const brainUsageLiveArtifactSchema = v.strictObject({
  kind: v.literal('brain-usage-sample'),
  ...liveArtifactCommonEntries,
  usage: usageRecordSchema,
})

/** A strict, versioned live-artifact summary (never the raw payload). */
export const liveArtifactSchema = v.variant('kind', [asrSampleSchema, ttsSampleSchema, brainUsageLiveArtifactSchema])

export type LiveArtifact = v.InferOutput<typeof liveArtifactSchema>
export type BrainUsageLiveArtifact = v.InferOutput<typeof brainUsageLiveArtifactSchema>

/** Narrow an imported artifact to the one kind that carries provider usage. */
export function isBrainUsageLiveArtifact(artifact: LiveArtifact): artifact is BrainUsageLiveArtifact {
  return artifact.kind === 'brain-usage-sample'
}

/** Parse a live-artifact summary, rejecting any that carries a path or secret-bearing field. */
export function parseLiveArtifact(input: unknown): LiveArtifact {
  const parsed = v.parse(liveArtifactSchema, input)
  // One sample, one observation time. The artifact and its embedded usage record
  // both timestamp the same provider call, and the price window is evaluated at
  // that instant, so two disagreeing values would make the effective-window
  // question depend on which field a consumer happened to read.
  if (isBrainUsageLiveArtifact(parsed) && parsed.observedAt !== parsed.usage.observedAt)
    throw new Error('brain usage artifact observedAt must equal its usage record observedAt')
  const failures = scanLiveArtifactForProhibitedContent(parsed)
  if (failures.length > 0)
    throw new Error(`live artifact carries prohibited content: ${failures.join(', ')}`)
  return parsed
}

/**
 * Read a raw artifact file and produce its content-free summary.
 *
 * The file is read only to compute its digest and size; its contents are never
 * embedded in the returned summary. The caller supplies the content-free
 * provenance fields, and — for a brain usage sample — the numeric usage record
 * the capture observed.
 */
export async function summarizeLiveArtifactFile(params: {
  readonly path: string
  readonly kind: LiveArtifactKind
  readonly sampleId: string
  readonly hostProvenance: string
  readonly configProvenance: string
  readonly observedAt: string
  readonly usage?: UsageRecord
  readonly metricName?: string
  readonly metricValue?: number
  readonly metricUnit?: string
}): Promise<LiveArtifact> {
  const bytes = await readFile(params.path)
  const fileDigest = createHash('sha256').update(bytes).digest('hex')
  return parseLiveArtifact({
    format: 1,
    kind: params.kind,
    sampleId: params.sampleId,
    fileDigest,
    fileSizeBytes: bytes.length,
    hostProvenance: params.hostProvenance,
    configProvenance: params.configProvenance,
    observedAt: params.observedAt,
    ...(params.usage != null ? { usage: params.usage } : {}),
    ...(params.metricName != null ? { metricName: params.metricName } : {}),
    ...(params.metricValue != null ? { metricValue: params.metricValue } : {}),
    ...(params.metricUnit != null ? { metricUnit: params.metricUnit } : {}),
  })
}

/** Canonical digest of a live-artifact summary for imported-evidence tracking. */
export function liveArtifactDigest(artifact: LiveArtifact): string {
  return sha256Canonical(artifact)
}

/**
 * Scan a live-artifact summary for prohibited content.
 *
 * A path, snowflake, secret-bearing field name, or prompt/transcript marker
 * makes the artifact unsafe to import. The whole summary is serialized before
 * scanning, so a nested usage record is covered on the same terms as a
 * top-level provenance field. The raw file's contents are not scanned here —
 * the operator is responsible for not importing a file whose contents are not
 * safe to summarize.
 */
export function scanLiveArtifactForProhibitedContent(artifact: LiveArtifact): readonly string[] {
  const failures: string[] = []
  const serialized = JSON.stringify(artifact)
  if (/\b\d{17,20}\b/.test(serialized))
    failures.push('snowflake-shaped-identifier')
  // A JSON string value that is an absolute or relative path: "...":"/abs/..." ,
  // "...":"C:\\..." , "...":"./rel" . The leading quote anchors a value start
  // so a lone slash inside a phrase like "inert/active" is not a false positive.
  if (/":\s*"(?:\/[^"]*|[A-Z]:\\[^"]*|\.\.?\/[^"]*)"/i.test(serialized))
    failures.push('absolute-or-relative-path')
  if (/"(?:secret|apiKey|api_key|token|redactionKey)"\s*:/.test(serialized))
    failures.push('secret-bearing-field')
  if (/prompt text|transcript content|generated text/i.test(serialized))
    failures.push('content-bearing-field')
  return Object.freeze(failures)
}

export { sha256Canonical }
