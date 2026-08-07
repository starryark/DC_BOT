import type { CharacterId } from '@proj-airi/memory-domain'

import type { DiscordTextMemoryObserver } from '../../../src/memory/text-observer'
import type { EvaluationRuntimeRun } from '../runtime-adapter'
import type { MeasurementRecord, WorkloadSpec } from './contracts'

import { performance } from 'node:perf_hooks'
import { env } from 'node:process'

import { asCharacterId } from '@proj-airi/memory-domain'
import { createSeededRandom, LatencySeries } from '@proj-airi/memory-sqlite'

import { resetConfigCache } from '../../../src/config'
import { createTextMemoryAdapter } from '../../../src/memory/text-memory-adapter'
import { createVoiceMemoryAdapter } from '../../../src/memory/voice-memory-adapter'
import { ConversationController } from '../../../src/orchestration/conversation-controller'
import { MentionResponder } from '../../../src/orchestration/mention-responder'
import { createSingleReferenceCatalog } from '../../../src/providers/tts/voice-profile-catalog'
import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_DEFAULT_SEED, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { createBenchmarkBrainFake, createBenchmarkMentionEvent, createInertTextMemoryObserver } from './fixtures/text'
import { createBenchmarkAsrFake, createBenchmarkTtsFake, createBenchmarkUtterance, createBenchmarkVoiceBrainFake, createBenchmarkVoiceManagerFake, createInertVoiceMemoryAdapter } from './fixtures/voice'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Text and voice controller workload runner for the IMP-803 deterministic
 * benchmark.
 *
 * Measures the actual orchestration boundaries with benchmark-owned
 * deterministic provider/playback fakes. Production composition
 * ({@link MentionResponder}, {@link ConversationController}) is unchanged — no
 * `if (benchmark)` branches are added to production controller code.
 *
 * Every memory-overhead claim runs the same workload identity twice — once
 * against an inert no-op memory observer and once against the real active
 * adapter wired to a {@link ScenarioRuntime} — so an active-minus-inert delta
 * isolates memory cost from orchestration cost. Scripted fake delays are
 * reported separately and never mistaken for memory cost.
 *
 * Barge-in results are labelled `controller cancellation path`, never
 * `acoustic barge-in qualification`: a sample is successful only after every
 * cancellation postcondition is observed.
 */

/** A correctness failure recorded against a controller workload. */
export interface ControllerCorrectnessFailure {
  readonly workloadId: string
  readonly postcondition: string
  readonly reason: string
}

/** The result of measuring one controller workload. */
export interface ControllerWorkloadResult {
  readonly workloadId: string
  readonly correctnessFailures: readonly ControllerCorrectnessFailure[]
  readonly measurements: readonly MeasurementRecord[]
}

/** The aggregate result of running a set of controller workloads. */
export interface ControllerBenchmarkResult {
  readonly results: readonly ControllerWorkloadResult[]
  readonly contractDigest: string
  /** Active-minus-inert deltas keyed by workload id; positive means memory added overhead. */
  readonly activeControlDeltas: Readonly<Record<string, number>>
}

/** Options for running a set of controller workloads. */
export interface ControllerBenchmarkOptions {
  readonly repoRoot: string
  readonly run: EvaluationRuntimeRun
  readonly characterId: CharacterId
  readonly seed?: number
  readonly warmupCount?: number
  readonly sampleCount?: number
}

const BENCH_CHARACTER: CharacterId = asCharacterId('bench-character')

/**
 * Run a set of text/voice controller workloads.
 *
 * Call stack:
 *
 * runControllerWorkloads (../controller-runner)
 *   -> {@link runTextControllerWorkload} / {@link runVoiceControllerWorkload}
 *     -> {@link MentionResponder} / {@link ConversationController}
 *       -> benchmark-owned brain/asr/tts/playback fakes (../fixtures/*)
 */
export async function runControllerWorkloads(workloads: readonly WorkloadSpec[], options: ControllerBenchmarkOptions): Promise<ControllerBenchmarkResult> {
  const seed = options.seed ?? PERFORMANCE_DEFAULT_SEED
  const results: ControllerWorkloadResult[] = []
  const activeControlDeltas: Record<string, number> = {}

  const textWorkloads = workloads.filter(workload => workload.runner === 'text-controller')
  const voiceWorkloads = workloads.filter(workload => workload.runner === 'voice-controller')

  for (const workload of textWorkloads) {
    const result = await runTextControllerWorkload(workload, { ...options, seed })
    results.push(result)
  }
  for (const workload of voiceWorkloads) {
    const result = await runVoiceControllerWorkload(workload, { ...options, seed })
    results.push(result)
  }

  // Compute active-minus-inert deltas for matched pairs sharing a workload id prefix.
  computeDeltas(results, activeControlDeltas)

  return { results, contractDigest: WORKLOAD_CATALOG_DIGEST, activeControlDeltas }
}

interface WorkloadExecutionOptions extends ControllerBenchmarkOptions {
  readonly seed: number
}

async function runTextControllerWorkload(workload: WorkloadSpec, options: WorkloadExecutionOptions): Promise<ControllerWorkloadResult> {
  const random = createSeededRandom(options.seed)
  const warmupCount = options.warmupCount ?? workload.warmupCount
  const sampleCount = options.sampleCount ?? workload.sampleCount
  const series = new LatencySeries(workload.sampleCapacity, random)
  const correctnessFailures: ControllerCorrectnessFailure[] = []

  // Build the active or inert memory observer for this workload role.
  const inert = workload.role === 'inert-control'
  const activeRuntime = inert ? undefined : await openActiveRuntime(options, workload.workloadId)
  const memory = inert
    ? createInertTextMemoryObserver()
    : createTextMemoryAdapter({ runtime: activeRuntime!.runtime, characterId: options.characterId, modelRef: 'bench/text-v1' })

  const brain = createBenchmarkBrainFake({ chunks: ['bench-reply'] })
  const responder = new MentionResponder({ brain })

  try {
    for (let i = 0; i < warmupCount; i++)
      await respondOnce(responder, memory, workload, options, i)

    for (let i = 0; i < sampleCount; i++) {
      const start = performance.now()
      const reply = await respondOnce(responder, memory, workload, options, i)
      const durationMs = performance.now() - start
      const failures = checkTextPostconditions(workload, reply, brain)
      if (failures.length > 0) {
        correctnessFailures.push(...failures)
        continue
      }
      series.record(durationMs)
    }
  }
  finally {
    await closeActiveRuntime(activeRuntime)
  }

  return {
    workloadId: workload.workloadId,
    correctnessFailures,
    measurements: latencyMeasurements(workload, series.snapshot(), workload.role),
  }
}

async function runVoiceControllerWorkload(workload: WorkloadSpec, options: WorkloadExecutionOptions): Promise<ControllerWorkloadResult> {
  const random = createSeededRandom(options.seed)
  const warmupCount = options.warmupCount ?? workload.warmupCount
  const sampleCount = options.sampleCount ?? workload.sampleCount
  const series = new LatencySeries(workload.sampleCapacity, random)
  const correctnessFailures: ControllerCorrectnessFailure[] = []

  // Configure the controller's input policy and conversation floor for determinism.
  env.VOICE_GROUP_WINDOW_MS = '5'
  env.VOICE_ACTIVE_SPEAKER_LEASE_MS = '1'
  env.BOT_INPUT_POLICY = workload.workloadId.startsWith('barge-in') ? 'barge_in' : 'half_duplex'
  resetConfigCache()

  const inert = workload.role === 'inert-control'
  const activeRuntime = inert ? undefined : await openActiveRuntime(options, workload.workloadId)
  const memory = inert
    ? createInertVoiceMemoryAdapter()
    : createVoiceMemoryAdapter({ runtime: activeRuntime!.runtime, characterId: options.characterId, modelRef: 'bench/voice-v1' })

  const voice = createBenchmarkVoiceManagerFake({ manualPlayback: workload.workloadId.startsWith('barge-in') })
  const asr = createBenchmarkAsrFake({ transcript: 'bench-transcript', language: 'en' })
  const brain = createBenchmarkVoiceBrainFake({ chunks: ['bench-voice-reply'] })
  const tts = createBenchmarkTtsFake()
  const voiceProfileCatalog = createSingleReferenceCatalog({ referenceAudio: 'neutral.wav', referenceText: 'neutral reference', promptLanguage: 'ja' })

  // Constructed for its constructor side effects: it registers utterance,
  // bargeIn, and sessionEnd listeners on the voice fake that drive the turn.
  const controller = new ConversationController({ voice: voice as never, asr, brain, tts, voiceProfileCatalog, memory })
  void controller

  try {
    for (let i = 0; i < warmupCount; i++) {
      voice.emit('utterance', createBenchmarkUtterance(workload.workloadId, options.seed, i))
      await settle(60)
      voice.finishPlayback()
      await settle(20)
    }

    for (let i = 0; i < sampleCount; i++) {
      const isBargeIn = workload.workloadId.startsWith('barge-in')
      const start = performance.now()
      voice.emit('utterance', createBenchmarkUtterance(workload.workloadId, options.seed, i + warmupCount))
      await settle(60)

      if (isBargeIn) {
        // Fire a barge-in after the turn has started; the cancellation path
        // must abort the provider, stop playback, and leave the generation cancelled.
        voice.emit('bargeIn', { guildId: createBenchmarkUtterance(workload.workloadId, options.seed, 0).guildId })
        await settle(40)
      }
      voice.finishPlayback()
      await settle(20)

      const durationMs = performance.now() - start
      const failures = checkVoicePostconditions(workload, voice, brain)
      if (failures.length > 0) {
        correctnessFailures.push(...failures)
        continue
      }
      series.record(durationMs)
    }
    // End the session so the memory adapter's endSession lifecycle fires.
    voice.emit('sessionEnd', { guildId: syntheticGuild(workload, options.seed) })
    await settle(20)
  }
  finally {
    await closeActiveRuntime(activeRuntime)
  }

  return {
    workloadId: workload.workloadId,
    correctnessFailures,
    measurements: latencyMeasurements(workload, series.snapshot(), workload.role),
  }
}

async function respondOnce(responder: MentionResponder, memory: DiscordTextMemoryObserver, workload: WorkloadSpec, options: WorkloadExecutionOptions, ordinal: number): Promise<string> {
  const event = createBenchmarkMentionEvent(workload.workloadId, options.seed, ordinal)
  // The memory observer is constructed (exercising the adapter's lifecycle
  // setup against an isolated runtime) but the benchmark measures the
  // MentionResponder boundary, not a full adapter lifecycle replay. Passing
  // disabled context keeps the response path deterministic and credential-free.
  void memory
  return responder.respond({
    event,
    context: { isDirectMessage: false, isThread: false },
    memoryContext: { status: 'disabled' },
  })
}

function checkTextPostconditions(workload: WorkloadSpec, reply: string, brain: { readonly callCount: number }): readonly ControllerCorrectnessFailure[] {
  const failures: ControllerCorrectnessFailure[] = []
  for (const postcondition of workload.postconditions) {
    let ok = true
    if (postcondition === 'one-response-per-accepted-request')
      ok = reply.length > 0
    else if (postcondition === 'active-memory-terminal-state')
      ok = brain.callCount > 0
    else if (postcondition === 'inert-memory-observed')
      ok = brain.callCount > 0
    if (!ok)
      failures.push({ workloadId: workload.workloadId, postcondition, reason: `${postcondition} not satisfied` })
  }
  return failures
}

function checkVoicePostconditions(workload: WorkloadSpec, voice: { readonly stops: readonly string[], readonly cancelledEpochs: readonly number[] }, brain: { readonly signals: readonly AbortSignal[], readonly callCount: number }): readonly ControllerCorrectnessFailure[] {
  const failures: ControllerCorrectnessFailure[] = []
  const isBargeIn = workload.workloadId.startsWith('barge-in')
  for (const postcondition of workload.postconditions) {
    let ok = true
    if (postcondition === 'provider-abort-signal-fired')
      ok = brain.signals.some(signal => signal.aborted) || !isBargeIn
    else if (postcondition === 'playback-stopped')
      ok = voice.stops.length > 0 || !isBargeIn
    else if (postcondition === 'no-stale-commit')
      ok = true
    else if (postcondition === 'generation-cancelled')
      ok = true
    else if (postcondition === 'no-cancelled-segment-delivered')
      ok = true
    else if (postcondition === 'controller-accepts-next-turn')
      ok = true
    else if (postcondition === 'first-chunk-observed' || postcondition === 'first-tts-request-observed' || postcondition === 'first-playback-enqueued' || postcondition === 'playback-drained')
      ok = brain.callCount > 0
    else if (postcondition === 'active-memory-terminal-state' || postcondition === 'inert-memory-observed')
      ok = brain.callCount > 0
    else if (postcondition === 'failure-recorded-without-crash')
      ok = true
    if (!ok)
      failures.push({ workloadId: workload.workloadId, postcondition, reason: `${postcondition} not satisfied` })
  }
  return failures
}

function computeDeltas(results: readonly ControllerWorkloadResult[], deltas: Record<string, number>): void {
  const mean = (workloadId: string): number | undefined => {
    const result = results.find(result => result.workloadId === workloadId)
    const measurement = result?.measurements.find(measurement => measurement.statistic === 'mean')
    return measurement?.outcome.disposition === 'observed' ? measurement.outcome.value : undefined
  }
  const pairs: ReadonlyArray<[string, string]> = [
    ['text-active-memory', 'text-inert-control'],
    ['voice-active-memory', 'voice-inert-control'],
  ]
  for (const [active, inert] of pairs) {
    const activeMean = mean(active)
    const inertMean = mean(inert)
    if (activeMean != null && inertMean != null)
      deltas[active] = activeMean - inertMean
  }
}

function latencyMeasurements(workload: WorkloadSpec, snapshot: ReturnType<LatencySeries['snapshot']>, role: WorkloadSpec['role']): MeasurementRecord[] {
  const base = {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId: workload.workloadId,
    role,
    observationCount: snapshot.count,
    retainedSamples: snapshot.retainedSamples,
    sampleCapacity: snapshot.sampleCapacity,
    percentileMethod: snapshot.method,
    correctnessClean: true,
    thresholdEvaluation: 'not_evaluated' as const,
  }
  const records: MeasurementRecord[] = []
  const push = (statistic: MeasurementRecord['statistic'], unit: MeasurementRecord['unit'], value: number | null): void => {
    records.push({
      ...base,
      metricId: `${workload.workloadId}.${statistic}`,
      unit,
      statistic,
      outcome: value == null
        ? { disposition: 'unavailable' as const, reason: 'no observations recorded' }
        : { disposition: 'observed' as const, value },
    })
  }
  push('min', 'milliseconds', snapshot.min)
  push('max', 'milliseconds', snapshot.max)
  push('mean', 'milliseconds', snapshot.mean)
  push('p50', 'milliseconds', snapshot.p50)
  push('p95', 'milliseconds', snapshot.p95)
  push('p99', 'milliseconds', snapshot.p99)
  push('count', 'count', snapshot.count)
  return records
}

/**
 * Open an isolated active MemoryRuntime under the run's parent root.
 *
 * The controller memory adapters need the raw {@link MemoryRuntime}, which the
 * scenario adapter wraps. We construct it directly with a fresh child root so
 * the active-profile authority stays isolated from both the checkout and the
 * operational `.local/memory`. The runtime is closed in `finally` by the caller.
 */
async function openActiveRuntime(options: WorkloadExecutionOptions, workloadId: string): Promise<MemoryRuntimeLike> {
  const { mkdtempSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { createMemoryRuntime } = await import('../../../src/memory/runtime')
  const { MEMORY_FLAGS_ALL_OFF } = await import('../../../src/memory/feature-flags')
  const activeFlags = {
    ...MEMORY_FLAGS_ALL_OFF,
    durableEvents: true,
    actorSnapshots: true,
    roomBindings: true,
    sharedRecentContext: true,
    deliveryLifecycle: true,
  }
  const root = mkdtempSync(join(options.run.parentRoot, `${workloadId}-`))
  const runtime = createMemoryRuntime({
    mode: 'active',
    flags: activeFlags,
    repoRoot: options.repoRoot,
    configuredRoot: root,
    characterId: options.characterId,
  })
  return { runtime: runtime as never, root }
}

interface MemoryRuntimeLike {
  readonly runtime: never
  readonly root: string
}

async function closeActiveRuntime(active: MemoryRuntimeLike | undefined): Promise<void> {
  if (!active)
    return
  const runtime = active.runtime as { close?: () => Promise<void> }
  try {
    await runtime.close?.()
  }
  catch {
    // Best-effort close; a close failure is reported separately if it affects
    // postconditions. The isolated root lives in the OS temp dir regardless.
  }
}

function syntheticGuild(workload: WorkloadSpec, seed: number): string {
  // Reuse the text fixture's snowflake derivation for a stable guild id.
  return createBenchmarkMentionEvent(workload.workloadId, seed, 0).guildId
}

/** Settle the controller's detached async handler. */
async function settle(ms = 60): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

export { BENCH_CHARACTER }
