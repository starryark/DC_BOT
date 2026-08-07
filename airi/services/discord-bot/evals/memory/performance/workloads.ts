import type { WorkloadSpec } from './contracts'

import { workloadCatalogDigest } from './contracts'

/**
 * The frozen workload catalog for the IMP-803 deterministic performance
 * benchmark.
 *
 * Every workload is content-free: it names the operation, role, payload-size
 * class, and postconditions, but never a prompt, transcript, snowflake, or
 * path. The catalog is versioned through {@link PERFORMANCE_CONTRACT_ID} and
 * its digest ({@link workloadCatalogDigest}) so two matched runs can be proven
 * to exercise the same work even when their timings differ.
 *
 * The smoke suite is fast and credential-free; it exists to prove the harness
 * wires up end to end without claiming anything about live transport. The full
 * `performance-v1` suite measures every production-shaped memory operation and
 * controller boundary.
 */

/** Shared defaults for runtime workloads that stream p50/p95/p99 over measured samples. */
const DEFAULT_SAMPLE_CAPACITY = 256
const DEFAULT_TIMEOUT_MS = 30_000

/** Smoke suite: one of each essential path, fast and credential-free. */
const smokeWorkloads: readonly WorkloadSpec[] = [
  {
    workloadId: 'smoke-runtime-open-close',
    runner: 'runtime',
    operation: 'cold runtime open then close',
    role: 'active',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'empty',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['runtime-opened', 'runtime-closed-clean'],
  },
  {
    workloadId: 'smoke-text-ingress-append',
    runner: 'runtime',
    operation: 'one text ingress then append',
    role: 'active',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'small',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['ingress-resolved-room', 'append-returned-event-id'],
  },
  {
    workloadId: 'smoke-context-assembly-8',
    runner: 'runtime',
    operation: '8-item context assembly',
    role: 'active',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'small',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['context-count-matches', 'truncation-matches-contract'],
  },
  {
    workloadId: 'smoke-generation-segment-delivery',
    runner: 'runtime',
    operation: 'generation begin, one segment, delivery completion',
    role: 'active',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'small',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['generation-terminal-transition', 'segment-ordinals-correct', 'delivery-completed'],
  },
  {
    workloadId: 'smoke-close-reopen-continuity',
    runner: 'runtime',
    operation: 'close then reopen continuity check',
    role: 'active',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'empty',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['acknowledged-state-present-after-reopen'],
  },
  {
    workloadId: 'smoke-text-controller-inert-active-pair',
    runner: 'text-controller',
    operation: 'text controller inert/active matched pair',
    role: 'active',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'small',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['one-response-per-accepted-request', 'active-memory-terminal-state'],
  },
  {
    workloadId: 'smoke-voice-controller-cancellation',
    runner: 'voice-controller',
    operation: 'voice controller cancellation path',
    role: 'active',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'small',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['provider-abort-signal-fired', 'playback-stopped', 'no-stale-commit', 'generation-cancelled'],
  },
]

/** Full `performance-v1` runtime workloads (§6.6). */
const performanceRuntimeWorkloads: readonly WorkloadSpec[] = [
  runtimeWorkload('runtime-cold-open', 'cold runtime open', ['smoke', 'performance-v1'], 'empty', ['runtime-opened']),
  runtimeWorkload('runtime-warm-reopen', 'warm close/reopen', ['performance-v1'], 'empty', ['acknowledged-state-present-after-reopen']),
  runtimeWorkload('text-ingress', 'text ingress', ['performance-v1'], 'small', ['ingress-resolved-room']),
  runtimeWorkload('voice-ingress', 'voice ingress', ['performance-v1'], 'small', ['ingress-resolved-room']),
  runtimeWorkload('text-append', 'text append', ['smoke', 'performance-v1'], 'small', ['append-returned-event-id']),
  runtimeWorkload('voice-append', 'voice append', ['performance-v1'], 'small', ['append-returned-event-id']),
  contextWorkload('context-assembly-0', 'context assembly with 0 retained turns', 0, ['context-count-matches', 'truncation-matches-contract']),
  contextWorkload('context-assembly-8', 'context assembly with 8 retained turns', 8, ['context-count-matches', 'truncation-matches-contract']),
  contextWorkload('context-assembly-24', 'context assembly with 24 retained turns', 24, ['context-count-matches', 'truncation-matches-contract']),
  runtimeWorkload('generation-begin', 'generation begin', ['performance-v1'], 'medium', ['generation-began']),
  runtimeWorkload('generation-terminal-transition', 'generation terminal transition', ['performance-v1'], 'medium', ['generation-terminal-transition']),
  runtimeWorkload('text-segment-delivery-lifecycle', 'text segment/delivery lifecycle', ['performance-v1'], 'medium', ['segment-ordinals-correct', 'delivery-completed']),
  runtimeWorkload('voice-segment-delivery-lifecycle', 'voice segment/delivery lifecycle', ['performance-v1'], 'medium', ['segment-ordinals-correct', 'delivery-completed']),
  runtimeWorkload('same-room-serialized-load', 'same-room serialized load', ['performance-v1'], 'medium', ['same-room-order-preserved'], 1),
  runtimeWorkload('eight-room-concurrent-load', 'eight-room concurrent load', ['performance-v1'], 'medium', ['multi-room-progress-independent'], 8),
  runtimeWorkload('active-writer-contention', 'active-writer contention', ['performance-v1'], 'medium', ['writer-contention-observed']),
  runtimeWorkload('acknowledged-state-close-reopen-recovery', 'acknowledged-state close/reopen recovery', ['performance-v1'], 'medium', ['acknowledged-state-present-after-reopen', 'db-integrity-clean']),
  runtimeWorkload('interrupted-delivery-recovery', 'interrupted delivery recovery', ['performance-v1'], 'medium', ['interrupted-delivery-not-durably-completed']),
]

/** Full `performance-v1` controller workloads (§6.6). */
const performanceControllerWorkloads: readonly WorkloadSpec[] = [
  textControllerWorkload('text-inert-control', 'text inert control', 'inert-control', 'medium', ['inert-memory-observed']),
  textControllerWorkload('text-active-memory', 'text active memory', 'active', 'medium', ['active-memory-terminal-state']),
  textControllerWorkload('text-same-room-queue', 'text same-room queue', 'active', 'medium', ['per-room-order-preserved']),
  textControllerWorkload('text-eight-room-parallelism', 'text eight-room parallelism', 'active', 'medium', ['no-cross-room-context'], 8),
  voiceControllerWorkload('voice-inert-control', 'voice inert control', 'inert-control', 'medium', ['inert-memory-observed']),
  voiceControllerWorkload('voice-active-memory', 'voice active memory', 'active', 'medium', ['active-memory-terminal-state']),
  voiceControllerWorkload('voice-first-generated-chunk', 'voice first generated chunk', 'active', 'medium', ['first-chunk-observed']),
  voiceControllerWorkload('voice-first-tts-request', 'voice first TTS request', 'active', 'medium', ['first-tts-request-observed']),
  voiceControllerWorkload('voice-first-playback-queue', 'voice first playback queue', 'active', 'medium', ['first-playback-enqueued']),
  voiceControllerWorkload('voice-playback-drain', 'voice playback drain', 'active', 'medium', ['playback-drained']),
  voiceControllerWorkload('barge-in-before-provider-response', 'barge-in before provider response', 'active', 'small', cancellationPostconditions()),
  voiceControllerWorkload('barge-in-during-streamed-generation', 'barge-in during streamed generation', 'active', 'medium', cancellationPostconditions()),
  voiceControllerWorkload('barge-in-during-tts', 'barge-in during TTS', 'active', 'medium', cancellationPostconditions()),
  voiceControllerWorkload('barge-in-during-playback', 'barge-in during playback', 'active', 'medium', cancellationPostconditions()),
  voiceControllerWorkload('provider-timeout', 'provider timeout', 'active', 'small', ['failure-recorded-without-crash']),
  voiceControllerWorkload('tts-failure', 'TTS failure', 'active', 'small', ['failure-recorded-without-crash']),
]

/** A timer-control workload that measures raw clock overhead; never subtracted from samples (§6.7). */
const timerControlWorkload: WorkloadSpec = {
  workloadId: 'timer-control-overhead',
  runner: 'runtime',
  operation: 'raw clock overhead measurement',
  role: 'timer-control',
  suites: ['performance-v1'],
  warmupCount: 1,
  sampleCount: 32,
  sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
  roomCount: 1,
  payloadSizeClass: 'empty',
  timeoutMs: DEFAULT_TIMEOUT_MS,
  postconditions: ['timer-overhead-recorded'],
}

/** The complete frozen workload catalog, in stable order. */
export const WORKLOAD_CATALOG: readonly WorkloadSpec[] = Object.freeze([
  ...smokeWorkloads,
  ...performanceRuntimeWorkloads,
  ...performanceControllerWorkloads,
  timerControlWorkload,
])

/** The canonical digest of the frozen catalog; identical for every matched run. */
export const WORKLOAD_CATALOG_DIGEST: string = workloadCatalogDigest(WORKLOAD_CATALOG)

/** All workloads that belong to a given suite (a workload may belong to several). */
export function workloadsForSuite(suite: 'smoke' | 'performance-v1'): readonly WorkloadSpec[] {
  return Object.freeze(WORKLOAD_CATALOG.filter(workload => workload.suites.includes(suite)))
}

/** Look up a workload by id; throws if the catalog does not declare it. */
export function workloadById(workloadId: string): WorkloadSpec {
  const workload = WORKLOAD_CATALOG.find(candidate => candidate.workloadId === workloadId)
  if (!workload)
    throw new Error(`unknown workload id ${workloadId}`)
  return workload
}

function runtimeWorkload(workloadId: string, operation: string, suites: readonly ('smoke' | 'performance-v1')[], payloadSizeClass: 'empty' | 'small' | 'medium', postconditions: readonly string[], roomCount = 1): WorkloadSpec {
  return {
    workloadId,
    runner: 'runtime',
    operation,
    role: 'active',
    suites: [...suites],
    warmupCount: 2,
    sampleCount: 64,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount,
    payloadSizeClass,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: [...postconditions],
  }
}

function contextWorkload(workloadId: string, operation: string, retainedTurns: number, postconditions: readonly string[]): WorkloadSpec {
  return {
    workloadId,
    runner: 'runtime',
    operation,
    role: 'active',
    suites: ['performance-v1'],
    warmupCount: 2,
    sampleCount: 64,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    // The retained-turn count is encoded in the payload class so the catalog
    // stays content-free; the runner expands it deterministically.
    payloadSizeClass: retainedTurns === 0 ? 'empty' : retainedTurns <= 8 ? 'small' : 'medium',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: [...postconditions],
  }
}

function textControllerWorkload(workloadId: string, operation: string, role: 'active' | 'inert-control', payloadSizeClass: 'small' | 'medium', postconditions: readonly string[], roomCount = 1): WorkloadSpec {
  return {
    workloadId,
    runner: 'text-controller',
    operation,
    role,
    suites: ['performance-v1'],
    warmupCount: 2,
    sampleCount: 32,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount,
    payloadSizeClass,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: [...postconditions],
  }
}

function voiceControllerWorkload(workloadId: string, operation: string, role: 'active' | 'inert-control', payloadSizeClass: 'small' | 'medium', postconditions: readonly string[], roomCount = 1): WorkloadSpec {
  return {
    workloadId,
    runner: 'voice-controller',
    operation,
    role,
    suites: ['performance-v1'],
    warmupCount: 2,
    sampleCount: 32,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount,
    payloadSizeClass,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: [...postconditions],
  }
}

/**
 * The full barge-in success predicate (§8.5).
 *
 * A barge-in sample is successful only after every cancellation postcondition
 * is observed; measuring cancellation completion at playback stop alone would
 * let a stale generation commit after the abort. Results are always labelled
 * `controller cancellation path`, never `acoustic barge-in qualification`.
 */
function cancellationPostconditions(): readonly string[] {
  return Object.freeze([
    'provider-abort-signal-fired',
    'playback-stopped',
    'no-stale-commit',
    'generation-cancelled',
    'no-cancelled-segment-delivered',
    'controller-accepts-next-turn',
  ])
}
