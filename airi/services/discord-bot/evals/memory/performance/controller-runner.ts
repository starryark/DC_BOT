import type { CharacterId } from '@proj-airi/memory-domain'

import type { MemoryRuntime } from '../../../src/memory/runtime'
import type { DiscordTextMemoryObserver } from '../../../src/memory/text-observer'
import type { VoiceMemoryAdapter } from '../../../src/memory/voice-memory-adapter'
import type { BrainRequest } from '../../../src/providers/brain/types'
import type { EvaluationRuntimeRun } from '../runtime-adapter'
import type { MeasurementRecord, VoiceTriggerStage, WorkloadSpec } from './contracts'
import type { FixturePhase, TracedTextMemoryObserver } from './fixtures/text'
import type { BenchmarkTtsFake, TracedVoiceMemoryAdapter, VoiceBrainFake, VoiceBrainMode, VoiceManagerFake } from './fixtures/voice'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'

import process, { env } from 'node:process'

import { performance } from 'node:perf_hooks'

import { asCharacterId } from '@proj-airi/memory-domain'
import { createSeededRandom, LatencySeries } from '@proj-airi/memory-sqlite'

import { resetConfigCache } from '../../../src/config'
import { createTextMemoryAdapter } from '../../../src/memory/text-memory-adapter'
import { createVoiceMemoryAdapter } from '../../../src/memory/voice-memory-adapter'
import { ConversationController } from '../../../src/orchestration/conversation-controller'
import { MentionResponder } from '../../../src/orchestration/mention-responder'
import { createSingleReferenceCatalog } from '../../../src/providers/tts/voice-profile-catalog'
import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_DEFAULT_SEED, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { drainPendingContinuations } from './fixtures/barrier'
import { createBenchmarkBrainFake, createBenchmarkMentionEvent, createInertTextMemoryObserver, syntheticSnowflake, TEXT_LIFECYCLE_SEQUENCE, traceTextMemory } from './fixtures/text'
import { createBenchmarkAsrFake, createBenchmarkTtsFake, createBenchmarkUtterance, createBenchmarkVoiceBrainFake, createBenchmarkVoiceManagerFake, createInertVoiceMemoryAdapter, traceVoiceMemory } from './fixtures/voice'
import { cleanupFinding } from './run-findings'
import { workloadCorrectnessClean } from './sample-results'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * Text and voice controller workload runner for the IMP-803 deterministic
 * benchmark.
 *
 * Measures the actual orchestration boundaries with benchmark-owned
 * deterministic provider/playback fakes. Production composition
 * ({@link MentionResponder}, {@link ConversationController}) is unchanged — no
 * `if (benchmark)` branches are added to production controller code. Every
 * observation the postconditions need is taken through an existing dependency
 * seam or a benchmark-owned decorator around one.
 *
 * Every memory-overhead claim runs the same workload identity twice — once
 * against an inert no-op memory observer and once against the real active
 * adapter wired to an isolated runtime — so an active-minus-inert delta
 * isolates memory cost from orchestration cost. The delta is published only
 * when both arms are complete and correctness-clean.
 *
 * Barge-in results are labelled `controller cancellation path`, never
 * `acoustic barge-in qualification`: a sample is successful only after every
 * cancellation postcondition is observed against real evidence.
 */

/** The result of measuring one controller workload. */
export interface ControllerWorkloadResult {
  readonly workloadId: string
  readonly attempts: readonly SampleAttemptRecord[]
  readonly measurements: readonly MeasurementRecord[]
  /** Whether this workload's measured evidence is complete and clean. */
  readonly correctnessClean: boolean
}

/** The aggregate result of running a set of controller workloads. */
export interface ControllerBenchmarkResult {
  readonly results: readonly ControllerWorkloadResult[]
  readonly runFindings: readonly RunFindingRecord[]
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
  readonly sampleCapacity?: number
}

const BENCH_CHARACTER: CharacterId = asCharacterId('bench-character')

/**
 * Deadlock watchdog for every stage rendezvous, taken from the workload contract.
 *
 * A sample passes because its named stage was entered, never because a duration
 * elapsed; this bound exists only so a driver that will never be signalled fails
 * loudly instead of hanging the suite.
 *
 * NOTICE:
 * It is deliberately the workload's declared `timeoutMs` and not a small local
 * constant. An earlier 5s bound tripped on a first full-catalog run — after ~19
 * SQLite-backed runtime workloads the first voice turn exceeded it under load —
 * which turned the watchdog into a correctness mechanism that reported a
 * machine-speed artifact as a failed cancellation attempt. A watchdog that can
 * fail a healthy sample defeats the reproducibility the harness exists to
 * provide.
 * Removal condition: none; the bound belongs in the contract with the workload.
 */
function watchdogFor(workload: WorkloadSpec): number {
  return workload.timeoutMs
}

/** Concurrent requests a same-room queue sample issues into one room. */
const SAME_ROOM_QUEUE_DEPTH = 4

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
  const runFindings: RunFindingRecord[] = []

  for (const workload of workloads.filter(workload => workload.runner === 'text-controller'))
    results.push(await runTextControllerWorkload(workload, { ...options, seed }, runFindings))
  for (const workload of workloads.filter(workload => workload.runner === 'voice-controller'))
    results.push(await runVoiceControllerWorkload(workload, { ...options, seed }, runFindings))

  return { results, runFindings, contractDigest: WORKLOAD_CATALOG_DIGEST, activeControlDeltas: computeDeltas(results) }
}

interface WorkloadExecutionOptions extends ControllerBenchmarkOptions {
  readonly seed: number
}

/** What one measured controller sample observed; postconditions read only these fields. */
interface SampleObservation {
  readonly replies?: readonly string[]
  /** Lifecycle method sequence observed for the measured turn. */
  readonly lifecycleSequence?: readonly string[]
  readonly contextStatus?: string
  /** Turn ids in provider entry order, for queue-ordering claims. */
  readonly providerEntryOrder?: readonly string[]
  readonly requestedOrder?: readonly string[]
  readonly maxConcurrentGenerations?: number
  readonly roomCount?: number
  readonly crossRoomContextLeaks?: number
  readonly providerAborted?: boolean
  readonly playbackStopped?: boolean
  readonly playbackEpochCancelled?: boolean
  readonly generationCancelled?: boolean
  readonly staleCommitObserved?: boolean
  readonly staleDeliveryObserved?: boolean
  readonly followUpAccepted?: boolean
  readonly firstChunkObserved?: boolean
  readonly ttsInvoked?: boolean
  readonly playbackEnqueued?: boolean
  readonly terminalMemoryStateReached?: boolean
  readonly providerFailureInjected?: boolean
  readonly ttsFailureInjected?: boolean
}

interface SampleOutcome {
  readonly durationMs: number
  readonly failedPostconditionIds: readonly string[]
}

// ---------------------------------------------------------------------------
// Text controller
// ---------------------------------------------------------------------------

async function runTextControllerWorkload(workload: WorkloadSpec, options: WorkloadExecutionOptions, runFindings: RunFindingRecord[]): Promise<ControllerWorkloadResult> {
  const random = createSeededRandom(options.seed)
  const warmupCount = options.warmupCount ?? workload.warmupCount
  const sampleCount = options.sampleCount ?? workload.sampleCount
  const sampleCapacity = options.sampleCapacity ?? workload.sampleCapacity
  const series = new LatencySeries(sampleCapacity, random)
  const attempts: SampleAttemptRecord[] = []
  const findingsBefore = runFindings.length

  const inert = workload.role === 'inert-control'
  const activeRuntime = inert ? undefined : await openActiveRuntime(options, workload.workloadId)
  const observer: DiscordTextMemoryObserver = inert || !activeRuntime
    ? createInertTextMemoryObserver()
    : createTextMemoryAdapter({ runtime: activeRuntime.runtime, characterId: options.characterId, modelRef: 'bench/text-v1' })
  // Both arms are wrapped identically so the delta compares two runs of the
  // same call sequence rather than one arm that skipped the lifecycle entirely.
  const memory = traceTextMemory(observer)

  try {
    for (let ordinal = 0; ordinal < warmupCount; ordinal++)
      await runTextSample(workload, memory, options, 'warmup', ordinal)

    for (let ordinal = 0; ordinal < sampleCount; ordinal++) {
      const outcome = await runTextSample(workload, memory, options, 'measured', ordinal)
      if (outcome.failedPostconditionIds.length > 0) {
        attempts.push(failedAttempt(workload.workloadId, ordinal, outcome.failedPostconditionIds))
        continue
      }
      attempts.push(passedAttempt(workload.workloadId, ordinal, outcome.durationMs))
      series.record(outcome.durationMs)
    }
  }
  finally {
    await closeActiveRuntime(activeRuntime, workload.workloadId, runFindings)
  }

  const correctnessClean = workloadCorrectnessClean(attempts, workload.workloadId, sampleCount, runFindings.length - findingsBefore)
  return {
    workloadId: workload.workloadId,
    attempts,
    measurements: latencyMeasurements(workload, series.snapshot(), workload.role, correctnessClean),
    correctnessClean,
  }
}

async function runTextSample(workload: WorkloadSpec, memory: TracedTextMemoryObserver, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<SampleOutcome> {
  try {
    switch (workload.driverCase) {
      case 'text-memory-lifecycle':
        return await runTextLifecycleSample(workload, memory, options, phase, ordinal)
      case 'text-same-room-queue':
        return await runSameRoomQueueSample(workload, memory, options, phase, ordinal)
      case 'text-multi-room':
        return await runMultiRoomSample(workload, memory, options, phase, ordinal)
      default:
        // A text workload with no driver is catalog/runner drift; fail the
        // sample rather than silently measuring nothing.
        return { durationMs: 0, failedPostconditionIds: canonicalPostconditions(workload.postconditions) }
    }
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'sample-failed', workloadId: workload.workloadId, phase, ordinal, message: errorMessageOf(error) })}\n`)
    return { durationMs: 0, failedPostconditionIds: canonicalPostconditions(workload.postconditions) }
  }
}

/**
 * Drive the complete text controller + memory lifecycle for one turn.
 *
 * Both arms time the identical boundary: admit, prepare, respond, then the
 * generated/delivering/deliveredSegment/delivered tail. v1 constructed a memory
 * observer, discarded it with `void memory`, and passed `{ status: 'disabled' }`
 * to the responder in both arms — so `text-active-memory` never exercised the
 * active adapter and the "memory overhead" delta measured nothing but noise.
 */
async function runTextLifecycleSample(workload: WorkloadSpec, memory: TracedTextMemoryObserver, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<SampleOutcome> {
  const brain = createBenchmarkBrainFake({ chunks: ['bench-reply'] })
  const responder = new MentionResponder({ brain })
  const event = createBenchmarkMentionEvent({ workloadId: workload.workloadId, seed: options.seed, phase, ordinal })
  const context = { isDirectMessage: false, isThread: false }
  const traceStart = memory.trace.mark()

  const start = performance.now()
  let reply: string
  try {
    await memory.admit(event, context)
    const prepared = await memory.prepareForModel(event)
    reply = await responder.respond({ event, context, memoryContext: prepared.context })
    await memory.generated(event, [reply])
    await memory.delivering(event, 0)
    await memory.deliveredSegment(event, 0, `bench-msg-${phase}-${ordinal}`)
    await memory.delivered(event)
  }
  catch (error) {
    // The durable-active adapter is fail-closed: a write failure must surface as
    // a failed attempt, never be retried as a disabled-memory turn that then
    // reports a plausible latency.
    await memory.failed(event, error).catch(() => undefined)
    process.stderr.write(`${JSON.stringify({ status: 'lifecycle-failed', workloadId: workload.workloadId, phase, ordinal, message: errorMessageOf(error) })}\n`)
    return { durationMs: 0, failedPostconditionIds: canonicalPostconditions(workload.postconditions) }
  }
  const durationMs = performance.now() - start

  const own = memory.trace.since(traceStart).filter(call => call.turnId === event.turnId)
  const observation: SampleObservation = {
    replies: [reply],
    lifecycleSequence: own.map(call => call.method),
    contextStatus: own.find(call => call.method === 'prepareForModel')?.contextStatus,
  }
  return { durationMs, failedPostconditionIds: assertPostconditions(workload, observation) }
}

/**
 * Drive several concurrent requests into one room and observe the queue.
 *
 * `MentionResponder` chains same-room work through `roomQueues`, so the
 * observable properties are that the provider is entered in request order and
 * that no two generations for one room overlap.
 */
async function runSameRoomQueueSample(workload: WorkloadSpec, memory: TracedTextMemoryObserver, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<SampleOutcome> {
  const brain = createBenchmarkBrainFake({ chunks: ['bench-reply'] })
  const responder = new MentionResponder({ brain })
  const context = { isDirectMessage: false, isThread: false }
  // Distinct ordinals inside one sample keep the turn ids unique while every
  // request targets room index 0, which is what puts them on one queue.
  const events = Array.from({ length: SAME_ROOM_QUEUE_DEPTH }, (_, index) =>
    createBenchmarkMentionEvent({ workloadId: workload.workloadId, seed: options.seed, phase, ordinal: ordinal * SAME_ROOM_QUEUE_DEPTH + index }))

  const start = performance.now()
  const replies = await Promise.all(events.map(event => responder.respond({ event, context, memoryContext: { status: 'disabled' } })))
  const durationMs = performance.now() - start
  void memory

  const observation: SampleObservation = {
    replies,
    providerEntryOrder: brain.entryOrder,
    requestedOrder: events.map(event => event.turnId),
    maxConcurrentGenerations: brain.maxConcurrent,
  }
  return { durationMs, failedPostconditionIds: assertPostconditions(workload, observation) }
}

/**
 * Drive one request per room and observe that the rooms progress independently.
 *
 * The provider blocks on entry, so the number of generations in flight at once
 * is the discriminator: independent rooms all reach the provider, a shared
 * queue would admit exactly one and the watchdog would fire.
 */
async function runMultiRoomSample(workload: WorkloadSpec, memory: TracedTextMemoryObserver, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<SampleOutcome> {
  const brain = createBenchmarkBrainFake({ chunks: ['bench-reply'], blockUntilReleased: true })
  const responder = new MentionResponder({ brain })
  const context = { isDirectMessage: false, isThread: false }
  const events = Array.from({ length: workload.roomCount }, (_, roomIndex) =>
    createBenchmarkMentionEvent({ workloadId: workload.workloadId, seed: options.seed, phase, ordinal, roomIndex }))

  const start = performance.now()
  const pending = events.map(event => responder.respond({ event, context, memoryContext: { status: 'disabled' } }))
  await brain.waitForEntries(workload.roomCount, watchdogFor(workload))
  brain.release()
  const replies = await Promise.all(pending)
  const durationMs = performance.now() - start
  void memory

  const observation: SampleObservation = {
    replies,
    roomCount: workload.roomCount,
    maxConcurrentGenerations: brain.maxConcurrent,
    crossRoomContextLeaks: countCrossRoomLeaks(brain.requests, events.map(event => event.turnId)),
  }
  return { durationMs, failedPostconditionIds: assertPostconditions(workload, observation) }
}

/**
 * Count prompts that carry another room's mention marker.
 *
 * Each room's mention text embeds its own room index, so a compiled prompt
 * containing a different room's marker is a concrete cross-room context leak
 * rather than an inference from "the rooms looked separate".
 */
function countCrossRoomLeaks(requests: readonly BrainRequest[], turnIds: readonly string[]): number {
  let leaks = 0
  for (const request of requests) {
    const roomIndex = turnIds.findIndex(turnId => turnId === request.turnId)
    if (roomIndex < 0)
      continue
    const serialized = JSON.stringify(request.contents)
    for (let other = 0; other < turnIds.length; other++) {
      if (other !== roomIndex && serialized.includes(`bench-mention-r${other}-`))
        leaks += 1
    }
  }
  return leaks
}

// ---------------------------------------------------------------------------
// Voice controller
// ---------------------------------------------------------------------------

/** One sample's isolated controller and fakes; never shared across attempts. */
interface VoiceSampleHarness {
  readonly voice: VoiceManagerFake
  readonly brain: VoiceBrainFake
  readonly tts: BenchmarkTtsFake
  readonly memory: TracedVoiceMemoryAdapter
  readonly controller: ConversationController
}

async function runVoiceControllerWorkload(workload: WorkloadSpec, options: WorkloadExecutionOptions, runFindings: RunFindingRecord[]): Promise<ControllerWorkloadResult> {
  const random = createSeededRandom(options.seed)
  const warmupCount = options.warmupCount ?? workload.warmupCount
  const sampleCount = options.sampleCount ?? workload.sampleCount
  const sampleCapacity = options.sampleCapacity ?? workload.sampleCapacity
  const series = new LatencySeries(sampleCapacity, random)
  const attempts: SampleAttemptRecord[] = []
  const findingsBefore = runFindings.length

  // Cancellation requires an interrupting policy: `onBargeIn` returns early
  // under `half_duplex`. The policy is chosen from the declared driver, not from
  // a workload-id prefix — the prefix test is what made the smoke cancellation
  // workload silently run the nominal path in v1.
  env.VOICE_GROUP_WINDOW_MS = '5'
  env.VOICE_ACTIVE_SPEAKER_LEASE_MS = '1'
  env.BOT_INPUT_POLICY = workload.driverCase === 'voice-barge-in' ? 'barge_in' : 'half_duplex'
  resetConfigCache()

  const inert = workload.role === 'inert-control'
  const activeRuntime = inert ? undefined : await openActiveRuntime(options, workload.workloadId)
  const delegate: VoiceMemoryAdapter = inert || !activeRuntime
    ? createInertVoiceMemoryAdapter()
    : createVoiceMemoryAdapter({ runtime: activeRuntime.runtime, characterId: options.characterId, modelRef: 'bench/voice-v1' })

  let lastHarness: VoiceSampleHarness | undefined
  try {
    for (let ordinal = 0; ordinal < warmupCount; ordinal++)
      lastHarness = (await runVoiceSample(workload, delegate, options, 'warmup', ordinal)).harness

    for (let ordinal = 0; ordinal < sampleCount; ordinal++) {
      const { outcome, harness } = await runVoiceSample(workload, delegate, options, 'measured', ordinal)
      lastHarness = harness
      if (outcome.failedPostconditionIds.length > 0) {
        attempts.push(failedAttempt(workload.workloadId, ordinal, outcome.failedPostconditionIds))
        continue
      }
      attempts.push(passedAttempt(workload.workloadId, ordinal, outcome.durationMs))
      series.record(outcome.durationMs)
    }

    // End the session once, so the adapter's endSession lifecycle fires without
    // clearing per-guild state between samples. The controller dispatches it
    // detached (`void this.onSessionEnd(...)`), so it must be awaited here:
    // closing the runtime underneath an in-flight endSession makes its durable
    // write fail against an already-closed database.
    if (lastHarness) {
      lastHarness.voice.emit('sessionEnd', { guildId: syntheticSnowflake(options.seed, workload.workloadId, 'guild') })
      await lastHarness.memory.endSessionCompleted.wait(watchdogFor(workload), 'session end').catch(() => undefined)
    }
  }
  finally {
    await closeActiveRuntime(activeRuntime, workload.workloadId, runFindings)
  }

  const correctnessClean = workloadCorrectnessClean(attempts, workload.workloadId, sampleCount, runFindings.length - findingsBefore)
  return {
    workloadId: workload.workloadId,
    attempts,
    measurements: latencyMeasurements(workload, series.snapshot(), workload.role, correctnessClean),
    correctnessClean,
  }
}

/**
 * Build one sample's fakes and controller.
 *
 * Every measured attempt gets fresh observation state. v1 shared one voice fake,
 * one brain fake, and one controller across an entire workload, so
 * `brain.signals.some(s => s.aborted)` stayed true for every later sample once
 * any earlier sample had cancelled — the postcondition could not fail twice.
 */
function createVoiceSampleHarness(workload: WorkloadSpec, delegate: VoiceMemoryAdapter): VoiceSampleHarness {
  const stage = workload.triggerStage
  const voice = createBenchmarkVoiceManagerFake({ manualPlayback: stage === 'playback' })
  const asr = createBenchmarkAsrFake({ transcript: 'bench transcript', language: 'en' })
  const brain = createBenchmarkVoiceBrainFake({ chunks: ['bench voice reply.'], mode: brainModeFor(workload) })
  const tts = createBenchmarkTtsFake({
    blockFirstCall: stage === 'tts',
    failures: workload.driverCase === 'voice-tts-failure' ? 1 : 0,
  })
  const memory = traceVoiceMemory(delegate)
  const voiceProfileCatalog = createSingleReferenceCatalog({ referenceAudio: 'neutral.wav', referenceText: 'neutral reference', promptLanguage: 'ja' })

  // Constructed for its constructor side effects: it registers utterance,
  // bargeIn, and sessionEnd listeners on the voice fake that drive the turn.
  const controller = new ConversationController({ voice: voice as never, asr, brain, tts, voiceProfileCatalog, memory })
  return { voice, brain, tts, memory, controller }
}

/** Where the provider pauses or fails, derived from the declared driver and stage. */
function brainModeFor(workload: WorkloadSpec): VoiceBrainMode {
  if (workload.driverCase === 'voice-provider-failure')
    return 'fail-on-entry'
  if (workload.driverCase !== 'voice-barge-in')
    return 'normal'
  switch (workload.triggerStage) {
    case 'before-provider-response':
      return 'block-before-first-chunk'
    case 'streamed-generation':
      return 'block-after-first-chunk'
    // At the TTS and playback stages the provider must complete so the turn can
    // reach the stage being cancelled.
    default:
      return 'normal'
  }
}

async function runVoiceSample(workload: WorkloadSpec, delegate: VoiceMemoryAdapter, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<{ outcome: SampleOutcome, harness: VoiceSampleHarness }> {
  const harness = createVoiceSampleHarness(workload, delegate)
  try {
    switch (workload.driverCase) {
      case 'voice-barge-in':
        return { outcome: await runBargeInSample(workload, harness, options, phase, ordinal), harness }
      case 'voice-provider-failure':
      case 'voice-tts-failure':
        return { outcome: await runFailureInjectionSample(workload, harness, options, phase, ordinal), harness }
      default:
        return { outcome: await runNominalVoiceSample(workload, harness, options, phase, ordinal), harness }
    }
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'sample-failed', workloadId: workload.workloadId, phase, ordinal, message: errorMessageOf(error) })}\n`)
    releaseAll(harness)
    return { outcome: { durationMs: 0, failedPostconditionIds: canonicalPostconditions(workload.postconditions) }, harness }
  }
}

/**
 * Emit one utterance for this sample.
 *
 * The speaker identity is derived from the phase and measured ordinal, so two
 * samples never reuse a speaker and the controller's duplicate-transcript
 * filter cannot silently discard everything after the first. Within a sample the
 * identity is stable: the follow-up turn is the same person speaking again,
 * which is also what keeps it clear of the conversation floor's active-speaker
 * lease — that lease exists to reject a *different* speaker cutting in.
 */
function emitUtterance(harness: VoiceSampleHarness, workload: WorkloadSpec, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): void {
  harness.voice.emit('utterance', createBenchmarkUtterance(workload.workloadId, options.seed, ordinal, `${phase}-speaker`))
}

/**
 * Emit the follow-up turn and observe whether the controller took it.
 *
 * A rejected follow-up is a real failure of `controller-accepts-next-turn`, so
 * the watchdog timeout is reported as "not accepted" rather than thrown.
 */
async function runFollowUpTurn(harness: VoiceSampleHarness, workload: WorkloadSpec, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<boolean> {
  // The controller returns to `idle` in the continuation after its terminal
  // memory call; emitting before that continuation runs would hit a busy phase.
  await drainPendingContinuations()
  emitUtterance(harness, workload, options, phase, ordinal)
  try {
    await harness.brain.followUpEntered.wait(watchdogFor(workload), 'follow-up provider entry')
    return true
  }
  catch {
    return false
  }
  finally {
    releaseAll(harness)
  }
}

/** Release every held stage so a cancelled or completed turn can unwind. */
function releaseAll(harness: VoiceSampleHarness): void {
  harness.brain.release()
  harness.tts.release()
  harness.voice.finishPlayback()
}

/**
 * Drive one cancellation sample at this workload's declared trigger stage.
 *
 * The driver waits for the named stage to be entered, fires the barge-in, then
 * waits for the controller's cancellation to reach durable memory. Nothing here
 * sleeps: v1 slept 60ms, fired, slept 40ms, and called the result four distinct
 * stages.
 */
async function runBargeInSample(workload: WorkloadSpec, harness: VoiceSampleHarness, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<SampleOutcome> {
  const { voice, brain, tts, memory } = harness
  const stage = workload.triggerStage as VoiceTriggerStage

  const start = performance.now()
  emitUtterance(harness, workload, options, phase, ordinal)
  await waitForStage(harness, workload, stage)

  const traceMark = memory.trace.mark()
  voice.emit('bargeIn', { guildId: syntheticSnowflake(options.seed, workload.workloadId, 'guild') })
  // `cancel()` bumps the epoch, aborts the provider, cancels the playback epoch,
  // and stops playback before it reaches memory, so observing the durable
  // cancellation means the whole sequence ran.
  await memory.cancelGenerationCalled.wait(watchdogFor(workload), `${stage} cancellation`)
  const durationMs = performance.now() - start

  releaseAll(harness)

  const cancelledTurnId = memory.trace.entries.find(call => call.method === 'cancelGeneration')?.turnId
  // A follow-up turn proves the controller returned to a usable state rather
  // than being left wedged by the cancellation.
  const followUpAccepted = await runFollowUpTurn(harness, workload, options, phase, ordinal)

  const afterCancel = memory.trace.since(traceMark)
  const observation: SampleObservation = {
    providerAborted: brain.signals.length > 0 && brain.signals[0]!.aborted,
    playbackStopped: voice.stops.length > 0,
    playbackEpochCancelled: voice.cancelledEpochs.length > 0,
    generationCancelled: cancelledTurnId != null,
    staleCommitObserved: memory.trace.entries.some(call => call.method === 'completeGeneration' && call.turnId === cancelledTurnId),
    staleDeliveryObserved: afterCancel.some(call => call.method === 'recordPlayback' && call.turnId === cancelledTurnId && call.playbackStatus === 'played'),
    followUpAccepted,
    ttsInvoked: tts.callCount > 0,
  }
  return { durationMs, failedPostconditionIds: assertPostconditions(workload, observation) }
}

/** Await the named stage's entry signal; the watchdog only catches a wedged turn. */
async function waitForStage(harness: VoiceSampleHarness, workload: WorkloadSpec, stage: VoiceTriggerStage): Promise<void> {
  const watchdog = watchdogFor(workload)
  switch (stage) {
    case 'before-provider-response':
      return harness.brain.entered.wait(watchdog, 'provider entry')
    case 'streamed-generation':
      return harness.brain.firstChunkYielded.wait(watchdog, 'first generated chunk')
    case 'tts':
      return harness.tts.entered.wait(watchdog, 'tts entry')
    case 'playback':
      return harness.voice.playbackEnqueued.wait(watchdog, 'playback enqueue')
  }
}

/** Drive one nominal turn to the stage this workload measures. */
async function runNominalVoiceSample(workload: WorkloadSpec, harness: VoiceSampleHarness, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<SampleOutcome> {
  const { voice, brain, tts, memory } = harness

  const start = performance.now()
  emitUtterance(harness, workload, options, phase, ordinal)
  const watchdog = watchdogFor(workload)
  switch (workload.workloadId) {
    case 'voice-first-generated-chunk':
      await brain.firstChunkYielded.wait(watchdog, 'first generated chunk')
      break
    case 'voice-first-tts-request':
      await tts.entered.wait(watchdog, 'first tts request')
      break
    case 'voice-first-playback-queue':
      await voice.playbackEnqueued.wait(watchdog, 'first playback enqueue')
      break
    default:
      // The turn is not over until its durable evidence is committed.
      await memory.completeGenerationCalled.wait(watchdog, 'generation completion')
  }
  const durationMs = performance.now() - start
  releaseAll(harness)

  const observation: SampleObservation = {
    firstChunkObserved: brain.firstChunkYielded.fired,
    ttsInvoked: tts.callCount > 0,
    playbackEnqueued: voice.played.length > 0,
    terminalMemoryStateReached: memory.completeGenerationCalled.fired,
    contextStatus: memory.trace.entries.find(call => call.method === 'prepareGeneration')?.contextStatus,
  }
  return { durationMs, failedPostconditionIds: assertPostconditions(workload, observation) }
}

/**
 * Drive one turn whose provider or TTS deterministically fails.
 *
 * v1 configured no failure at all and asserted `ok = true`, so both failure
 * workloads proved only that a workload id returned a result. The failure is
 * injected on the first call and confirmed to have been thrown.
 */
async function runFailureInjectionSample(workload: WorkloadSpec, harness: VoiceSampleHarness, options: WorkloadExecutionOptions, phase: FixturePhase, ordinal: number): Promise<SampleOutcome> {
  const { brain, tts, memory } = harness

  const start = performance.now()
  emitUtterance(harness, workload, options, phase, ordinal)
  // A provider failure ends the turn at `failGeneration`; a TTS failure is
  // swallowed per chunk, so that turn still reaches `completeGeneration`.
  await memory.terminalStateReached.wait(watchdogFor(workload), 'terminal memory state')
  const durationMs = performance.now() - start
  releaseAll(harness)

  const followUpAccepted = await runFollowUpTurn(harness, workload, options, phase, ordinal)

  const observation: SampleObservation = {
    providerFailureInjected: brain.failureInjected,
    ttsFailureInjected: tts.failureInjected,
    ttsInvoked: tts.callCount > 0,
    terminalMemoryStateReached: memory.terminalStateReached.fired,
    followUpAccepted,
  }
  return { durationMs, failedPostconditionIds: assertPostconditions(workload, observation) }
}

// ---------------------------------------------------------------------------
// Postconditions
// ---------------------------------------------------------------------------

function assertPostconditions(workload: WorkloadSpec, observation: SampleObservation): readonly string[] {
  return canonicalPostconditions(workload.postconditions.filter(postcondition => !checkPostcondition(postcondition, workload, observation)))
}

/**
 * Evaluate one controller postcondition against observed evidence.
 *
 * Every branch reads something the sample had to establish, and an
 * unrecognised predicate fails closed. v1 initialised `ok = true` and left four
 * of the six cancellation predicates on that default, so a barge-in sample was
 * successful whether or not anything was cancelled.
 */
function checkPostcondition(postcondition: string, workload: WorkloadSpec, observation: SampleObservation): boolean {
  switch (postcondition) {
    case 'one-response-per-accepted-request':
      return observation.replies != null && observation.replies.length > 0 && observation.replies.every(reply => reply.length > 0)
    case 'lifecycle-sequence-complete':
      return observation.lifecycleSequence != null
        && observation.lifecycleSequence.join('>') === TEXT_LIFECYCLE_SEQUENCE.join('>')
    case 'active-memory-terminal-state':
      // The active arm must have received real prepared memory; a `disabled`
      // context means the adapter was bypassed.
      return workload.runner === 'text-controller'
        ? observation.contextStatus === 'available'
        : observation.terminalMemoryStateReached === true && observation.contextStatus === 'available'
    case 'inert-memory-observed':
      return workload.runner === 'text-controller'
        ? observation.contextStatus === 'disabled'
        : observation.terminalMemoryStateReached === true && observation.contextStatus === 'disabled'
    case 'per-room-order-preserved':
      return observation.providerEntryOrder != null
        && observation.requestedOrder != null
        && observation.providerEntryOrder.join('>') === observation.requestedOrder.join('>')
        && observation.maxConcurrentGenerations === 1
    case 'multi-room-generation-overlapped':
      return observation.roomCount != null && observation.maxConcurrentGenerations === observation.roomCount
    case 'no-cross-room-context':
      return observation.crossRoomContextLeaks === 0
    case 'provider-abort-signal-fired':
      return observation.providerAborted === true
    case 'playback-stopped':
      return observation.playbackStopped === true && observation.playbackEpochCancelled === true
    case 'generation-cancelled':
      return observation.generationCancelled === true
    case 'no-stale-commit':
      return observation.staleCommitObserved === false
    case 'no-cancelled-segment-delivered':
      return observation.staleDeliveryObserved === false
    case 'controller-accepts-next-turn':
      return observation.followUpAccepted === true
    case 'first-chunk-observed':
      return observation.firstChunkObserved === true
    case 'first-tts-request-observed':
      return observation.ttsInvoked === true
    case 'first-playback-enqueued':
      return observation.playbackEnqueued === true
    case 'playback-drained':
      return observation.terminalMemoryStateReached === true
    case 'provider-failure-injected':
      return observation.providerFailureInjected === true
    case 'tts-invoked':
      return observation.ttsInvoked === true
    case 'tts-failure-injected':
      return observation.ttsFailureInjected === true
    case 'failure-recorded-without-crash':
      return observation.terminalMemoryStateReached === true
    default:
      // An unrecognised postcondition is catalog/runner drift: fail loud rather
      // than silently passing a check the runner does not implement.
      return false
  }
}

// ---------------------------------------------------------------------------
// Aggregation and shared helpers
// ---------------------------------------------------------------------------

/**
 * Publish an active-minus-inert delta only when both arms earned it.
 *
 * A delta computed from unequal denominators, or from an arm whose samples
 * failed, is a number with no meaning; omitting it is more honest than
 * publishing one that looks valid.
 */
function computeDeltas(results: readonly ControllerWorkloadResult[]): Record<string, number> {
  const deltas: Record<string, number> = {}
  const observedMean = (workloadId: string): number | undefined => {
    const result = results.find(candidate => candidate.workloadId === workloadId)
    if (!result || !result.correctnessClean)
      return undefined
    const measurement = result.measurements.find(candidate => candidate.statistic === 'mean')
    return measurement?.outcome.disposition === 'observed' ? measurement.outcome.value : undefined
  }
  const pairs: ReadonlyArray<[string, string]> = [
    ['text-active-memory', 'text-inert-control'],
    ['voice-active-memory', 'voice-inert-control'],
  ]
  for (const [active, inert] of pairs) {
    const activeMean = observedMean(active)
    const inertMean = observedMean(inert)
    if (activeMean != null && inertMean != null)
      deltas[active] = activeMean - inertMean
  }
  return deltas
}

/** Sorted, de-duplicated postcondition ids, as the attempt schema requires. */
function canonicalPostconditions(postconditions: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(postconditions)].sort())
}

function passedAttempt(workloadId: string, ordinal: number, durationMs: number): SampleAttemptRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId,
    ordinal,
    outcome: 'passed',
    durationMs,
  }
}

function failedAttempt(workloadId: string, ordinal: number, failedPostconditionIds: readonly string[]): SampleAttemptRecord {
  return {
    schemaVersion: PERFORMANCE_SCHEMA_VERSION,
    contractId: PERFORMANCE_CONTRACT_ID,
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    workloadId,
    ordinal,
    outcome: 'failed',
    failedPostconditionIds: [...failedPostconditionIds],
  }
}

function latencyMeasurements(workload: WorkloadSpec, snapshot: ReturnType<LatencySeries['snapshot']>, role: WorkloadSpec['role'], correctnessClean: boolean): MeasurementRecord[] {
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
    correctnessClean,
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

/** One isolated active memory runtime plus the root it owns. */
interface ActiveRuntimeHandle {
  readonly runtime: MemoryRuntime
  readonly root: string
}

/**
 * Open an isolated active MemoryRuntime under the run's parent root.
 *
 * The controller memory adapters need the raw {@link MemoryRuntime}, which the
 * scenario adapter wraps. It is constructed directly with a fresh child root so
 * the active-profile authority stays isolated from both the checkout and the
 * operational `.local/memory`. The runtime is closed by the caller in `finally`.
 */
async function openActiveRuntime(options: WorkloadExecutionOptions, workloadId: string): Promise<ActiveRuntimeHandle> {
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
  return { runtime, root }
}

async function closeActiveRuntime(active: ActiveRuntimeHandle | undefined, workloadId: string, runFindings: RunFindingRecord[]): Promise<void> {
  if (!active)
    return
  try {
    await active.runtime.close()
  }
  catch (error) {
    // A close failure is a run-level cleanup fact, published as a finding so the
    // whole-run disposition stays recomputable from artifacts.
    process.stderr.write(`${JSON.stringify({ status: 'cleanup-failure', workloadId, message: errorMessageOf(error) })}\n`)
    runFindings.push(cleanupFinding(WORKLOAD_CATALOG_DIGEST, workloadId, 'active-runtime-close-failed'))
  }
}

function errorMessageOf(error: unknown): string {
  // NOTICE:
  // @moeru/std's errorMessageFrom is not a direct dependency of discord-bot,
  // so the error message is extracted manually here. The lint rule that
  // suggests errorMessageFrom does not apply because the package is absent.
  return error instanceof Error ? error.message : String(error)
}

export { BENCH_CHARACTER }
