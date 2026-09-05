import type { PerformanceDriverCase, PerformanceSuite, VoiceTriggerStage, WorkloadSpec } from './contracts'

import { validateWorkloadCatalog, workloadCatalogDigest } from './contracts'

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
 * `performance-v2` suite measures every production-shaped memory operation and
 * controller boundary.
 *
 * Every entry names its own `driverCase` (and, for cancellation workloads, the
 * `triggerStage`). Nothing about execution is inferred from the workload id.
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
    driverCase: 'runtime-operation',
    triggerStage: null,
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'empty',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    // `runtime-closed-clean` is gone: a close failure is a run-level cleanup
    // finding, not a property of any one measured sample. v1 asserted it
    // per-sample from a branch that returned `true` unconditionally.
    postconditions: ['runtime-opened'],
  },
  {
    workloadId: 'smoke-text-ingress-append',
    runner: 'runtime',
    operation: 'one text ingress then append',
    role: 'active',
    driverCase: 'runtime-operation',
    triggerStage: null,
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
    driverCase: 'runtime-operation',
    triggerStage: null,
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
    driverCase: 'runtime-operation',
    triggerStage: null,
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
    driverCase: 'runtime-operation',
    triggerStage: null,
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'small',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: ['acknowledged-state-present-after-reopen'],
  },
  {
    workloadId: 'smoke-text-controller-inert-active-pair',
    runner: 'text-controller',
    operation: 'text controller inert/active matched pair',
    role: 'active',
    driverCase: 'text-memory-lifecycle',
    triggerStage: null,
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
    // Smoke runs the same cancellation driver as the full suite, at the playback
    // stage. In v1 this workload silently took the nominal path because the
    // driver was selected by `workloadId.startsWith('barge-in')`, so it asserted
    // cancellation postconditions against a turn that was never cancelled.
    workloadId: 'smoke-voice-controller-cancellation',
    runner: 'voice-controller',
    operation: 'voice controller cancellation path',
    role: 'active',
    driverCase: 'voice-barge-in',
    triggerStage: 'playback',
    suites: ['smoke'],
    warmupCount: 0,
    sampleCount: 1,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount: 1,
    payloadSizeClass: 'small',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: [...cancellationPostconditions()],
  },
]

/** Full `performance-v2` runtime workloads (§6.6). */
const performanceRuntimeWorkloads: readonly WorkloadSpec[] = [
  runtimeWorkload('runtime-cold-open', 'first durable read on an opened runtime', ['smoke', 'performance-v2'], 'small', ['runtime-opened']),
  runtimeWorkload('runtime-warm-reopen', 'warm close/reopen', ['performance-v2'], 'small', ['acknowledged-state-present-after-reopen']),
  runtimeWorkload('text-ingress', 'text ingress', ['performance-v2'], 'small', ['ingress-resolved-room']),
  runtimeWorkload('voice-ingress', 'voice ingress', ['performance-v2'], 'small', ['ingress-resolved-room']),
  runtimeWorkload('text-append', 'text append', ['smoke', 'performance-v2'], 'small', ['append-returned-event-id']),
  runtimeWorkload('voice-append', 'voice append', ['performance-v2'], 'small', ['append-returned-event-id']),
  contextWorkload('context-assembly-0', 'context assembly with 0 retained turns', 0, ['context-count-matches', 'truncation-matches-contract']),
  contextWorkload('context-assembly-8', 'context assembly with 8 retained turns', 8, ['context-count-matches', 'truncation-matches-contract']),
  contextWorkload('context-assembly-24', 'context assembly with 24 retained turns', 24, ['context-count-matches', 'truncation-matches-contract']),
  runtimeWorkload('generation-begin', 'generation begin', ['performance-v2'], 'medium', ['generation-began']),
  runtimeWorkload('generation-terminal-transition', 'generation terminal transition', ['performance-v2'], 'medium', ['generation-terminal-transition']),
  runtimeWorkload('text-segment-delivery-lifecycle', 'text segment/delivery lifecycle', ['performance-v2'], 'medium', ['segment-ordinals-correct', 'delivery-completed']),
  runtimeWorkload('voice-segment-delivery-lifecycle', 'voice segment/delivery lifecycle', ['performance-v2'], 'medium', ['segment-ordinals-correct', 'delivery-completed']),
  runtimeWorkload('same-room-serialized-load', 'same-room serialized load', ['performance-v2'], 'medium', ['same-room-writes-serialized'], 1),
  runtimeWorkload('eight-room-concurrent-load', 'eight-room concurrent load', ['performance-v2'], 'medium', ['multi-room-progress-independent'], 8),
  // NOTICE:
  // `active-writer-contention` is removed in v2 rather than renamed.
  //
  // In v1 its measured body was byte-identical to `same-room-serialized-load`
  // (one append, asserted by "an event id came back"), so it proved nothing the
  // serialization workload does not already prove.
  //
  // Real writer contention means two writers competing for one authority, which
  // requires a second runtime on the same root. The adapter opens exactly one
  // runtime per scenario, and the writer-ownership lease release is already
  // documented as racy on Windows inside a measured loop. Proving the named
  // behaviour would therefore need a production change made solely for the
  // benchmark, which the plan forbids.
  //
  // Removal condition: reinstate if the runtime grows a supported multi-writer
  // seam that can be driven deterministically from a test.
  runtimeWorkload('acknowledged-state-close-reopen-recovery', 'acknowledged-state close/reopen recovery', ['performance-v2'], 'medium', ['acknowledged-state-present-after-reopen', 'db-integrity-clean']),
  runtimeWorkload('interrupted-delivery-recovery', 'interrupted delivery recovery', ['performance-v2'], 'medium', ['interrupted-delivery-not-durably-completed']),
]

/** Full `performance-v2` controller workloads (§6.6). */
const performanceControllerWorkloads: readonly WorkloadSpec[] = [
  textControllerWorkload('text-inert-control', 'text inert control', 'inert-control', 'text-memory-lifecycle', 'medium', ['inert-memory-observed', 'lifecycle-sequence-complete']),
  textControllerWorkload('text-active-memory', 'text active memory', 'active', 'text-memory-lifecycle', 'medium', ['active-memory-terminal-state', 'lifecycle-sequence-complete']),
  textControllerWorkload('text-same-room-queue', 'text same-room queue', 'active', 'text-same-room-queue', 'medium', ['per-room-order-preserved']),
  textControllerWorkload('text-eight-room-parallelism', 'text eight-room parallelism', 'active', 'text-multi-room', 'medium', ['multi-room-generation-overlapped', 'no-cross-room-context'], 8),
  voiceControllerWorkload('voice-inert-control', 'voice inert control', 'inert-control', 'voice-nominal', null, 'medium', ['inert-memory-observed']),
  voiceControllerWorkload('voice-active-memory', 'voice active memory', 'active', 'voice-nominal', null, 'medium', ['active-memory-terminal-state']),
  voiceControllerWorkload('voice-first-generated-chunk', 'voice first generated chunk', 'active', 'voice-nominal', null, 'medium', ['first-chunk-observed']),
  voiceControllerWorkload('voice-first-tts-request', 'voice first TTS request', 'active', 'voice-nominal', null, 'medium', ['first-tts-request-observed']),
  voiceControllerWorkload('voice-first-playback-queue', 'voice first playback queue', 'active', 'voice-nominal', null, 'medium', ['first-playback-enqueued']),
  voiceControllerWorkload('voice-playback-drain', 'voice playback drain', 'active', 'voice-nominal', null, 'medium', ['playback-drained']),
  voiceControllerWorkload('barge-in-before-provider-response', 'barge-in before provider response', 'active', 'voice-barge-in', 'before-provider-response', 'small', cancellationPostconditions()),
  voiceControllerWorkload('barge-in-during-streamed-generation', 'barge-in during streamed generation', 'active', 'voice-barge-in', 'streamed-generation', 'medium', cancellationPostconditions()),
  voiceControllerWorkload('barge-in-during-tts', 'barge-in during TTS', 'active', 'voice-barge-in', 'tts', 'medium', cancellationPostconditions()),
  voiceControllerWorkload('barge-in-during-playback', 'barge-in during playback', 'active', 'voice-barge-in', 'playback', 'medium', cancellationPostconditions()),
  // The provider timeout is injected as the abort-shaped error a real timeout
  // surfaces, not waited out: what is measured is the controller's recovery
  // from that error, and a wall-clock wait would add nondeterministic latency.
  voiceControllerWorkload('provider-timeout', 'provider timeout (injected)', 'active', 'voice-provider-failure', null, 'small', ['provider-failure-injected', 'failure-recorded-without-crash', 'controller-accepts-next-turn']),
  voiceControllerWorkload('tts-failure', 'TTS failure', 'active', 'voice-tts-failure', null, 'small', ['tts-invoked', 'tts-failure-injected', 'failure-recorded-without-crash', 'controller-accepts-next-turn']),
]

/** A timer-control workload that measures raw clock overhead; never subtracted from samples (§6.7). */
const timerControlWorkload: WorkloadSpec = {
  workloadId: 'timer-control-overhead',
  runner: 'runtime',
  operation: 'raw clock overhead measurement',
  role: 'timer-control',
  driverCase: 'timer-control',
  triggerStage: null,
  suites: ['performance-v2'],
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

// Fail at import rather than mid-run: a catalog that declares a driver its
// runner cannot execute, or a barge-in suite missing a cancellation stage,
// would otherwise publish measurements under a contract digest that misstates
// what was exercised.
const catalogFailures = validateWorkloadCatalog(WORKLOAD_CATALOG)
if (catalogFailures.length > 0)
  throw new Error(`workload catalog is internally inconsistent: ${catalogFailures.join('; ')}`)

/** The canonical digest of the frozen catalog; identical for every matched run. */
export const WORKLOAD_CATALOG_DIGEST: string = workloadCatalogDigest(WORKLOAD_CATALOG)

/** All workloads that belong to a given suite (a workload may belong to several). */
export function workloadsForSuite(suite: PerformanceSuite): readonly WorkloadSpec[] {
  return Object.freeze(WORKLOAD_CATALOG.filter(workload => workload.suites.includes(suite)))
}

/** Look up a workload by id; throws if the catalog does not declare it. */
export function workloadById(workloadId: string): WorkloadSpec {
  const workload = WORKLOAD_CATALOG.find(candidate => candidate.workloadId === workloadId)
  if (!workload)
    throw new Error(`unknown workload id ${workloadId}`)
  return workload
}

function runtimeWorkload(workloadId: string, operation: string, suites: readonly PerformanceSuite[], payloadSizeClass: 'empty' | 'small' | 'medium', postconditions: readonly string[], roomCount = 1): WorkloadSpec {
  return {
    workloadId,
    runner: 'runtime',
    operation,
    role: 'active',
    driverCase: 'runtime-operation',
    triggerStage: null,
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
    driverCase: 'runtime-operation',
    triggerStage: null,
    suites: ['performance-v2'],
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

function textControllerWorkload(workloadId: string, operation: string, role: 'active' | 'inert-control', driverCase: PerformanceDriverCase, payloadSizeClass: 'small' | 'medium', postconditions: readonly string[], roomCount = 1): WorkloadSpec {
  return {
    workloadId,
    runner: 'text-controller',
    operation,
    role,
    driverCase,
    triggerStage: null,
    suites: ['performance-v2'],
    warmupCount: 2,
    sampleCount: 32,
    sampleCapacity: DEFAULT_SAMPLE_CAPACITY,
    roomCount,
    payloadSizeClass,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    postconditions: [...postconditions],
  }
}

function voiceControllerWorkload(workloadId: string, operation: string, role: 'active' | 'inert-control', driverCase: PerformanceDriverCase, triggerStage: VoiceTriggerStage | null, payloadSizeClass: 'small' | 'medium', postconditions: readonly string[], roomCount = 1): WorkloadSpec {
  return {
    workloadId,
    runner: 'voice-controller',
    operation,
    role,
    driverCase,
    triggerStage,
    suites: ['performance-v2'],
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
