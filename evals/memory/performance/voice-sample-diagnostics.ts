import type { VoiceSampleDiagnosticId } from './contracts'

import * as v from 'valibot'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_SCHEMA_VERSION, VOICE_SAMPLE_DIAGNOSTIC_IDS, WORKLOAD_ROLES } from './contracts'

/**
 * Per-sample timing diagnostics for the two condition-5 voice workloads.
 *
 * The measured evidence says a voice sample took 1836.157 ms and was
 * correctness-clean; it cannot say *where* that time went. The attempt row
 * carries a duration and, on failure, a closed diagnostic id, and neither
 * localises an interval. A warmup that stalled until the workload watchdog is
 * published as a `warmup-failure` finding, which names the workload and the
 * ordinal but not the stage the turn was sitting in.
 *
 * These records are the missing half: one row per condition-5 voice sample,
 * carrying the chronologically ordered stage and memory-call transitions the
 * benchmark already observes through its own fakes and decorators. A future
 * recurrence of either anomaly is then attributable to an interval rather than
 * to the whole sample.
 *
 * The artifact is strictly supplementary. It does not participate in
 * `deriveRunState`, it changes no attempt row, no measurement, no denominator,
 * and no threshold outcome, and it is deliberately absent from the baseline's
 * required artifact set so accepted baselines written before it remain
 * loadable.
 *
 * Content-free by construction, and more narrowly than the other artifacts: the
 * only free-form value a row carries is the contract digest. Every other field
 * is a closed enum, a bounded integer, or a duration. There is no turn id, no
 * channel id, no transcript, no chunk text, no exception message — a
 * `recordPlayback` pair is matched by {@link VoiceSampleTimingEvent} call
 * ordinal rather than by the turn it belonged to, and a rejection publishes
 * only that the call rejected.
 */

/**
 * The only workloads that may publish a timing record.
 *
 * Condition 5 is a claim about `voice-active-memory.activeControlDelta.mean`,
 * which is defined over exactly this pair. Instrumenting the other voice
 * workloads would add rows nothing reads, and instrumenting only the active arm
 * would make the two arms observably different work.
 */
export const VOICE_DIAGNOSTIC_WORKLOAD_IDS = Object.freeze(['voice-inert-control', 'voice-active-memory'] as const)
export type VoiceDiagnosticWorkloadId = typeof VOICE_DIAGNOSTIC_WORKLOAD_IDS[number]

/** Whether a workload id is one of the condition-5 pair. */
export function isVoiceDiagnosticWorkloadId(workloadId: string): workloadId is VoiceDiagnosticWorkloadId {
  return (VOICE_DIAGNOSTIC_WORKLOAD_IDS as readonly string[]).includes(workloadId)
}

/** Which section of a workload a sample belongs to; warmups never enter `attempts.jsonl`. */
export const VOICE_SAMPLE_PHASES = Object.freeze(['warmup', 'measured'] as const)
export type VoiceSamplePhase = typeof VOICE_SAMPLE_PHASES[number]

/**
 * The controller boundaries a nominal voice turn passes through.
 *
 * Each one is an existing benchmark signal the fakes already fire, so nothing
 * here is a new observation point in production code. The vocabulary is closed:
 * a stage the harness cannot observe is absent rather than approximated.
 */
export const VOICE_TIMING_STAGE_IDS = Object.freeze([
  /** The brain provider's `generate` was entered. */
  'provider-entered',
  /** The provider yielded its first chunk downstream. */
  'first-generated-chunk',
  /** TTS `synthesize` was entered. */
  'tts-entered',
  /** TTS `synthesize` returned a stream. */
  'tts-completed',
  /** `playAudioStream` was entered for the first time. */
  'playback-enqueued',
] as const)
export type VoiceTimingStageId = typeof VOICE_TIMING_STAGE_IDS[number]

/**
 * The durable memory calls a nominal voice turn makes.
 *
 * `cancelGeneration`, `failGeneration`, and `endSession` are deliberately
 * absent: a nominal sample does not make them, and the cancellation workloads
 * that do are outside condition 5.
 */
export const VOICE_TIMED_MEMORY_METHODS = Object.freeze(['admit', 'prepareGeneration', 'recordPlayback', 'completeGeneration'] as const)
export type VoiceTimedMemoryMethod = typeof VOICE_TIMED_MEMORY_METHODS[number]

/**
 * The durable authority operations a condition-5 voice turn performs.
 *
 * These are the whole of {@link TraceMemoryAuthority}, one level below the
 * adapter methods in {@link VOICE_TIMED_MEMORY_METHODS}: a `recordPlayback`
 * that took 480 ms spent it in some subset of these, and the adapter-level
 * timing alone cannot say which.
 *
 * Observed only on the active arm, because only the active arm has a durable
 * authority — the inert control resolves its lifecycle without one. That
 * asymmetry is why this vocabulary is separate from the stage and memory
 * vocabularies, both of which the two arms share.
 */
export const VOICE_TIMED_AUTHORITY_OPERATIONS = Object.freeze([
  'appendEvent',
  'beginGeneration',
  'transitionGeneration',
  'appendSegments',
  'beginDelivery',
  'transitionDelivery',
] as const)
export type VoiceTimedAuthorityOperation = typeof VOICE_TIMED_AUTHORITY_OPERATIONS[number]

/**
 * The transaction-control statements a durable authority operation executes.
 *
 * One level below {@link VOICE_TIMED_AUTHORITY_OPERATIONS}. A
 * `transitionDelivery` that took 369 ms spent it in one of three places —
 * acquiring the write lock at `BEGIN IMMEDIATE`, in the reads and writes
 * between, or in the durable `COMMIT` — and the operation-level timing alone
 * cannot say which.
 *
 * Deliberately coarse and closed. Every repository writes through the same
 * `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` triple, and only those three run
 * through `DatabaseSync.exec`; the reads and writes between them are prepared
 * statements this vocabulary does not name, so the interval they occupy is what
 * is left after the three are subtracted rather than something separately
 * observed. Classifying to an enum instead of publishing the statement keeps
 * SQL text out of the artifact by construction, and `other` is the catch-all
 * that keeps an unexpected `exec` from widening the vocabulary.
 */
export const VOICE_DURABLE_STATEMENTS = Object.freeze(['begin', 'commit', 'rollback', 'other'] as const)
export type VoiceDurableStatement = typeof VOICE_DURABLE_STATEMENTS[number]

/**
 * The transitions a timed memory call publishes.
 *
 * `entered` without a matching `resolved` or `rejected` is the whole point: it
 * is how a partial trail says which durable boundary a wedged turn was sitting
 * inside when the watchdog fired.
 */
export const VOICE_MEMORY_TRANSITIONS = Object.freeze(['entered', 'resolved', 'rejected'] as const)
export type VoiceMemoryTransition = typeof VOICE_MEMORY_TRANSITIONS[number]

/** Whether the sample the record describes passed every postcondition. */
export const VOICE_SAMPLE_OUTCOMES = Object.freeze(['passed', 'failed'] as const)
export type VoiceSampleOutcome = typeof VOICE_SAMPLE_OUTCOMES[number]

/**
 * Bounds on the integer fields.
 *
 * A run's sample count is CLI-overridable, so the ordinal bound is generous
 * rather than tied to the catalog. The event bound is what keeps a wedged turn
 * that somehow looped from writing an unbounded artifact.
 */
const MAX_ORDINAL = 4096
const MAX_EVENTS = 512

const offsetMsSchema = v.pipe(v.number(), v.finite(), v.minValue(0))
const boundedOrdinalSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(MAX_ORDINAL))

/**
 * One observed transition, offset from the sample's own start.
 *
 * Offsets are relative because an absolute timestamp is content: it dates the
 * run to the millisecond. The sample start is implicit offset 0 and
 * `elapsedMs` is the end boundary, so the pair brackets every event without
 * publishing a clock reading.
 */
export const voiceSampleTimingEventSchema = v.variant('kind', [
  v.strictObject({
    kind: v.literal('stage'),
    stageId: v.picklist(VOICE_TIMING_STAGE_IDS),
    offsetMs: offsetMsSchema,
  }),
  v.strictObject({
    kind: v.literal('memory'),
    method: v.picklist(VOICE_TIMED_MEMORY_METHODS),
    /** Zero-based index among calls to this method within one sample; pairs a repeated call without a turn id. */
    callOrdinal: boundedOrdinalSchema,
    transition: v.picklist(VOICE_MEMORY_TRANSITIONS),
    offsetMs: offsetMsSchema,
  }),
  // Nested inside the `memory` call that issued it: an authority pair always
  // falls between one adapter method's `entered` and its exit. Additive to the
  // union, so a row published before this variant existed still parses.
  v.strictObject({
    kind: v.literal('authority'),
    operation: v.picklist(VOICE_TIMED_AUTHORITY_OPERATIONS),
    /** Zero-based index among calls to this operation within one sample. */
    callOrdinal: boundedOrdinalSchema,
    transition: v.picklist(VOICE_MEMORY_TRANSITIONS),
    offsetMs: offsetMsSchema,
  }),
  // Nested inside the `authority` operation that executed it, for the same
  // reason that variant nests inside a `memory` call. Additive to the union on
  // the same terms: a row published before it existed still parses.
  v.strictObject({
    kind: v.literal('durable'),
    statement: v.picklist(VOICE_DURABLE_STATEMENTS),
    /** Zero-based index among executions of this statement within one sample. */
    callOrdinal: boundedOrdinalSchema,
    transition: v.picklist(VOICE_MEMORY_TRANSITIONS),
    offsetMs: offsetMsSchema,
  }),
])

export type VoiceSampleTimingEvent = v.InferOutput<typeof voiceSampleTimingEventSchema>

/**
 * One condition-5 voice sample's timing record.
 *
 * A partial event stream is valid. A sample that a watchdog ended, or whose
 * `prepareGeneration` rejected, stops emitting at the point it stopped
 * progressing, and that truncation is the evidence.
 */
export const voiceSampleDiagnosticRecordSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(PERFORMANCE_SCHEMA_VERSION),
    contractId: v.literal(PERFORMANCE_CONTRACT_ID),
    contractDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
    workloadId: v.picklist(VOICE_DIAGNOSTIC_WORKLOAD_IDS),
    role: v.picklist(WORKLOAD_ROLES),
    phase: v.picklist(VOICE_SAMPLE_PHASES),
    /** Zero-based index within its own phase; warmup and measured are separate spaces. */
    ordinal: boundedOrdinalSchema,
    outcome: v.picklist(VOICE_SAMPLE_OUTCOMES),
    /** The sample's own elapsed duration; for a passed sample this is the measured latency. */
    elapsedMs: v.pipe(v.number(), v.finite(), v.minValue(0)),
    /** The same closed diagnostics the attempt or warmup finding published, when the sample was classified. */
    diagnosticIds: v.optional(v.pipe(v.array(v.picklist(VOICE_SAMPLE_DIAGNOSTIC_IDS)), v.minLength(1))),
    events: v.pipe(v.array(voiceSampleTimingEventSchema), v.maxLength(MAX_EVENTS)),
  }),
  // Serialized order is chronological order. A consumer that had to sort before
  // reading a trail could not tell a genuinely out-of-order observation from a
  // producer that emitted its events in the wrong sequence.
  v.check(record => offsetsNondecreasing(record.events), 'timing events must be nondecreasing in serialized order'),
  v.check(record => record.diagnosticIds == null || isCanonical(record.diagnosticIds), 'diagnostics must be unique and canonically sorted'),
)

export type VoiceSampleDiagnosticRecord = v.InferOutput<typeof voiceSampleDiagnosticRecordSchema>

function offsetsNondecreasing(events: readonly VoiceSampleTimingEvent[]): boolean {
  for (let index = 1; index < events.length; index++) {
    if (events[index]!.offsetMs < events[index - 1]!.offsetMs)
      return false
  }
  return true
}

function isCanonical(diagnosticIds: readonly VoiceSampleDiagnosticId[]): boolean {
  return canonicalVoiceDiagnostics(diagnosticIds).join('\0') === diagnosticIds.join('\0')
}

/**
 * Sorted, de-duplicated diagnostics, as the attempt and finding rows already
 * publish them.
 *
 * The same failure must serialize to the same bytes in all three artifacts, or
 * a diff between two artifact sets stops meaning a difference in evidence.
 */
export function canonicalVoiceDiagnostics(diagnosticIds: readonly VoiceSampleDiagnosticId[]): readonly VoiceSampleDiagnosticId[] {
  return Object.freeze([...new Set(diagnosticIds)].sort())
}

/** Parse one serialized diagnostic row; throws on any schema violation. */
export function parseVoiceSampleDiagnostic(input: unknown): VoiceSampleDiagnosticRecord {
  return v.parse(voiceSampleDiagnosticRecordSchema, input)
}

/** Parse a whole `voice-sample-diagnostics.jsonl` body, ignoring blank lines. */
export function parseVoiceSampleDiagnosticsJsonl(jsonl: string): VoiceSampleDiagnosticRecord[] {
  const records: VoiceSampleDiagnosticRecord[] = []
  for (const line of jsonl.split('\n')) {
    if (line.trim().length === 0)
      continue
    records.push(parseVoiceSampleDiagnostic(JSON.parse(line)))
  }
  return records
}

/** Serialize rows to the published JSONL body; an empty set writes an empty file. */
export function voiceSampleDiagnosticsJsonl(records: readonly VoiceSampleDiagnosticRecord[]): string {
  return records.length === 0 ? '' : `${records.map(record => JSON.stringify(record)).join('\n')}\n`
}
