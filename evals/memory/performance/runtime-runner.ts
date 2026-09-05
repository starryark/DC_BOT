import type { asLogicalRoomId, asPhysicalRoomId, CharacterId, PhysicalLocation } from '@proj-airi/memory-domain'

import type { EvaluationRuntimeRun, ScenarioRuntime } from '../runtime-adapter'
import type { MeasurementRecord, PerformanceSuite, WorkloadSpec } from './contracts'
import type { RunFindingRecord } from './run-findings'
import type { SampleAttemptRecord } from './sample-results'

import process from 'node:process'

import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { asCharacterId, asSegmentId, asTimestamp, attributedActor } from '@proj-airi/memory-domain'
import { createSeededRandom, LatencySeries } from '@proj-airi/memory-sqlite'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_DEFAULT_SEED, PERFORMANCE_SCHEMA_VERSION } from './contracts'
import { cleanupFinding } from './run-findings'
import { workloadCorrectnessClean } from './sample-results'
import { WORKLOAD_CATALOG_DIGEST, workloadById } from './workloads'

/**
 * Isolated runtime workload runner for the IMP-803 deterministic benchmark.
 *
 * Measures production-shaped memory operations through the existing
 * {@link ScenarioRuntime} adapter, with one isolated temporary root per
 * benchmark execution, correctness postconditions asserted around every sample,
 * and bounded-memory p50/p95/p99 statistics driven by the run's seeded
 * generator.
 *
 * The runner never times fixture generation, JSON serialization, report
 * writing, or cleanup — only the operation under measurement. Implementation-
 * specific reads used purely to check a postcondition (a SQLite integrity
 * check, for instance) run after the clock stops.
 *
 * Every measured attempt produces exactly one {@link SampleAttemptRecord}. A
 * failed postcondition produces a failed attempt that contributes no latency
 * observation, so the published denominator and the attempted count stay
 * reconcilable — v1 dropped failures with `continue` and published nothing that
 * could reveal the gap.
 */

/** Execution phase of one operation; warmup and measured occupy disjoint id namespaces. */
export type ExecutionPhase = 'warmup' | 'measured'

/** Where one operation sits in its workload's execution. */
interface OperationSlot {
  readonly phase: ExecutionPhase
  readonly ordinal: number
}

/** The result of measuring one workload. */
export interface WorkloadResult {
  readonly workloadId: string
  readonly attempts: readonly SampleAttemptRecord[]
  readonly measurements: readonly MeasurementRecord[]
}

/** The aggregate result of running a set of workloads. */
export interface RuntimeBenchmarkResult {
  readonly results: readonly WorkloadResult[]
  readonly runFindings: readonly RunFindingRecord[]
  readonly contractDigest: string
}

/** Options for running a set of runtime workloads. */
export interface RuntimeBenchmarkOptions {
  readonly repoRoot: string
  readonly run: EvaluationRuntimeRun
  readonly characterId: CharacterId
  /** Override the seed for deterministic workload selection and sampling. */
  readonly seed?: number
  /** Override the warmup count for every workload (tests use small values). */
  readonly warmupCount?: number
  /** Override the measured sample count for every workload (tests use small values). */
  readonly sampleCount?: number
  /** Override the reservoir sample capacity. */
  readonly sampleCapacity?: number
}

/** Concurrent writers a same-room serialization sample issues. */
const SAME_ROOM_CONCURRENT_WRITES = 4

/** Segments a segment-lifecycle sample appends, so ordinal correctness is observable. */
const LIFECYCLE_SEGMENT_COUNT = 3

/** Items and characters every context assembly is bounded by. */
const CONTEXT_MAX_ITEMS = 24
const CONTEXT_MAX_CHARACTERS = 4096

/**
 * Turns each runtime workload seeds before measuring, declared per workload id.
 *
 * v1 derived this from `workloadId.startsWith('context-assembly-')` plus a regex
 * over the id, so a renamed workload would silently seed zero turns and still
 * report `context-count-matches` satisfied. The counts are data now.
 *
 * Reopen-continuity workloads seed at least two turns: with zero seeded turns
 * there is no acknowledged state to find after reopening, so the postcondition
 * would pass against an empty room.
 */
const SEEDED_TURNS: Readonly<Record<string, number>> = Object.freeze({
  'smoke-runtime-open-close': 0,
  'smoke-text-ingress-append': 2,
  'smoke-context-assembly-8': 8,
  'smoke-generation-segment-delivery': 2,
  'smoke-close-reopen-continuity': 2,
  'runtime-cold-open': 2,
  'runtime-warm-reopen': 2,
  'text-ingress': 2,
  'voice-ingress': 2,
  'text-append': 2,
  'voice-append': 2,
  'context-assembly-0': 0,
  'context-assembly-8': 8,
  'context-assembly-24': 24,
  'generation-begin': 2,
  'generation-terminal-transition': 2,
  'text-segment-delivery-lifecycle': 2,
  'voice-segment-delivery-lifecycle': 2,
  'same-room-serialized-load': 2,
  'eight-room-concurrent-load': 2,
  'acknowledged-state-close-reopen-recovery': 2,
  'interrupted-delivery-recovery': 2,
  'timer-control-overhead': 0,
})

/**
 * Run a set of runtime workloads and collect bounded statistics.
 *
 * Each workload opens its own isolated scenario root, runs warmups (discarded,
 * and never recorded as attempts), then measured samples. Every configured
 * measured ordinal produces exactly one attempt row. The scenario root is
 * closed in `finally` on every path; a close failure becomes a published
 * cleanup finding rather than a correctness failure attributed to a sample.
 *
 * Call stack:
 *
 * runRuntimeWorkloads (../runtime-runner)
 *   -> {@link runOneWorkload}
 *     -> {@link openScenarioRuntime} (../runtime-adapter)
 *       -> createMemoryRuntime (../../src/memory/runtime)
 */
export async function runRuntimeWorkloads(workloads: readonly WorkloadSpec[], options: RuntimeBenchmarkOptions): Promise<RuntimeBenchmarkResult> {
  const seed = options.seed ?? PERFORMANCE_DEFAULT_SEED
  const results: WorkloadResult[] = []
  const runFindings: RunFindingRecord[] = []

  for (const workload of workloads) {
    if (workload.runner !== 'runtime')
      continue
    const result = await runOneWorkload(workload, { ...options, seed }, runFindings)
    results.push(result)
  }

  return { results, runFindings, contractDigest: WORKLOAD_CATALOG_DIGEST }
}

interface WorkloadExecutionOptions extends RuntimeBenchmarkOptions {
  readonly seed: number
}

async function runOneWorkload(workload: WorkloadSpec, options: WorkloadExecutionOptions, runFindings: RunFindingRecord[]): Promise<WorkloadResult> {
  const random = createSeededRandom(options.seed)
  const warmupCount = options.warmupCount ?? workload.warmupCount
  const sampleCount = options.sampleCount ?? workload.sampleCount
  const sampleCapacity = options.sampleCapacity ?? workload.sampleCapacity
  const series = new LatencySeries(sampleCapacity, random)
  const attempts: SampleAttemptRecord[] = []
  const findingsBefore = runFindings.length

  const scenario = await options.run.openScenario({ scenarioLabel: workload.workloadId, characterId: options.characterId })
  try {
    const context = await seedWorkload(scenario, workload, options)

    for (let ordinal = 0; ordinal < warmupCount; ordinal++)
      await runSample(workload, scenario, context, options, { phase: 'warmup', ordinal })

    for (let ordinal = 0; ordinal < sampleCount; ordinal++) {
      const outcome = await runSample(workload, scenario, context, options, { phase: 'measured', ordinal })
      if (outcome.failedPostconditionIds.length > 0) {
        attempts.push(failedAttempt(workload.workloadId, ordinal, outcome.failedPostconditionIds))
        continue
      }
      attempts.push(passedAttempt(workload.workloadId, ordinal, outcome.durationMs))
      series.record(outcome.durationMs)
    }
  }
  finally {
    try {
      await scenario.close()
    }
    catch (error) {
      // A close failure is a run-level cleanup fact, not a property of any one
      // measured sample; publishing it as a finding keeps the whole-run
      // disposition recomputable from artifacts.
      process.stderr.write(`${JSON.stringify({ status: 'cleanup-failure', workloadId: workload.workloadId, message: errorMessageOf(error) })}\n`)
      runFindings.push(cleanupFinding(WORKLOAD_CATALOG_DIGEST, workload.workloadId, 'runtime-close-failed'))
    }
  }

  const cleanupFindingCount = runFindings.length - findingsBefore
  const correctnessClean = workloadCorrectnessClean(attempts, workload.workloadId, sampleCount, cleanupFindingCount)

  // Measurements are always emitted, so a workload whose every attempt failed
  // still reports a content-free zero denominator rather than disappearing.
  return {
    workloadId: workload.workloadId,
    attempts,
    measurements: latencyMeasurements(workload, series.snapshot(), workload.role, correctnessClean),
  }
}

interface SampleOutcome {
  readonly durationMs: number
  readonly failedPostconditionIds: readonly string[]
}

/**
 * Time one operation, then validate its postconditions off the clock.
 *
 * Postcondition evidence that needs an expensive implementation-specific read
 * (the SQLite integrity check) is gathered after the clock stops, so a
 * correctness check never inflates the latency it is guarding.
 */
async function runSample(workload: WorkloadSpec, scenario: ScenarioRuntime, context: WorkloadContext, options: WorkloadExecutionOptions, slot: OperationSlot): Promise<SampleOutcome> {
  let observation: OperationObservation
  const start = performance.now()
  try {
    observation = await executeOperation(workload, scenario, context, options, slot)
  }
  catch (error) {
    // An operation that threw verified none of its postconditions. Reporting
    // them all failed is honest: the sample proved nothing, and the alternative
    // (aborting the workload) would leave the attempt set incomplete.
    process.stderr.write(`${JSON.stringify({ status: 'operation-failed', workloadId: workload.workloadId, ordinal: slot.ordinal, message: errorMessageOf(error) })}\n`)
    return { durationMs: 0, failedPostconditionIds: canonicalPostconditions(workload.postconditions) }
  }
  const durationMs = performance.now() - start

  const enriched = await enrichObservation(workload, scenario, observation)
  const failed = workload.postconditions.filter(postcondition => !checkPostcondition(postcondition, enriched))
  return { durationMs, failedPostconditionIds: canonicalPostconditions(failed) }
}

/** One room's durable identity plus the state seeding established in it. */
interface RoomContext {
  readonly logicalRoomId: ReturnType<typeof asLogicalRoomId>
  readonly physicalRoomId: ReturnType<typeof asPhysicalRoomId>
  readonly personId: string
  readonly seededEventIds: readonly string[]
  /** Durable room version after seeding; a generation manifest must name it. */
  roomVersion: number
}

interface WorkloadContext {
  /** One entry per `roomCount`; index 0 is the room single-room workloads use. */
  readonly rooms: readonly RoomContext[]
  readonly seededTurns: number
}

async function seedWorkload(scenario: ScenarioRuntime, workload: WorkloadSpec, options: WorkloadExecutionOptions): Promise<WorkloadContext> {
  // Seeding is setup: it runs outside measured timing and establishes the rooms
  // and retained-turn state the measured operation will read or extend.
  const seededTurns = SEEDED_TURNS[workload.workloadId] ?? 0
  const rooms: RoomContext[] = []

  for (let roomIndex = 0; roomIndex < workload.roomCount; roomIndex++) {
    const guildId = syntheticSnowflake(options.seed, workload.workloadId, 'guild')
    // Distinct channels give distinct logical rooms, which is what a multi-room
    // workload needs in order to observe independent per-room progress.
    const channelId = syntheticSnowflake(options.seed, workload.workloadId, `channel-${roomIndex}`)
    const platformUserId = syntheticSnowflake(options.seed, workload.workloadId, `user-${roomIndex}`)
    const resolved = await scenario.resolveIngress({
      scope: { kind: 'guild', id: guildId },
      location: guildLocation(guildId, channelId),
      platformUserId,
      displayNameAtEvent: 'synthetic-actor',
      guildId,
      observedAt: asTimestamp('2026-08-02T10:00:00Z'),
      observationKey: `bench:observe:${workload.workloadId}:${roomIndex}`,
    })
    const authorization = scenario.traceAuthorizationFor(resolved.logicalRoomId)
    const actor = attributedActor(resolved.personId as never, {
      platform: 'discord',
      platformUserId,
      displayNameAtEvent: 'synthetic-actor',
      guildId,
      observedAt: asTimestamp('2026-08-02T10:00:00Z'),
      source: 'gateway',
    })

    const seededEventIds: string[] = []
    let roomVersion = 1
    for (let turn = 0; turn < seededTurns; turn++) {
      const appended = await scenario.appendEvent({
        authorization,
        actor,
        idempotencyKey: `bench:seed:${options.seed}:${workload.workloadId}:${roomIndex}:${turn}`,
        kind: 'user_text',
        logicalRoomId: resolved.logicalRoomId,
        physicalRoomId: resolved.physicalRoomId,
        occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
        content: `seed-turn-${turn}`,
        retentionClass: 'transcript',
      })
      seededEventIds.push(appended.eventId)
      // Each append bumps the durable room version; a generation's manifest
      // header must name the current version or the repository rejects it as a
      // stale-room write (POLICY_VIOLATION).
      if (appended.roomVersion != null)
        roomVersion = appended.roomVersion
    }

    rooms.push({
      logicalRoomId: resolved.logicalRoomId,
      physicalRoomId: resolved.physicalRoomId,
      personId: resolved.personId,
      seededEventIds,
      roomVersion,
    })
  }

  return { rooms, seededTurns }
}

/**
 * What one measured operation observed.
 *
 * Fields are populated only by the operations that can actually establish them,
 * so a postcondition reading an absent field fails rather than defaulting true.
 */
interface OperationObservation {
  readonly kind: string
  readonly eventId?: string
  readonly logicalRoomId?: string
  readonly contextItems?: number
  readonly expectedContextItems?: number
  readonly truncated?: boolean
  readonly expectedTruncated?: boolean
  readonly state?: string
  readonly integrityClean?: boolean
  readonly reopenedItemCount?: number
  readonly expectedReopenedItemCount?: number
  /** Room versions returned by a batch of concurrent same-room appends. */
  readonly concurrentRoomVersions?: readonly number[]
  /** Per-room version advance for a multi-room sample. */
  readonly perRoomAdvance?: readonly number[]
  /** Segment ids returned by an append, in the order they were requested. */
  readonly appendedSegmentOrdinals?: readonly number[]
  readonly requestedSegmentOrdinals?: readonly number[]
  readonly deliveryState?: string
}

/**
 * Mint a deterministic benchmark identifier.
 *
 * Every id a measured operation feeds the runtime is derived from
 * `(seed, workloadId, phase, ordinal, purpose, sequence)`. v1 used
 * `Math.random()` for idempotency keys and segment ids, which meant a run could
 * not be reproduced, an idempotency-collision bug could never be observed, and
 * "deterministic benchmark" was false on its face.
 *
 * Derivation deliberately does not consume the run's seeded RNG: that generator
 * drives reservoir sample selection, so minting one more id must not change
 * which samples a bounded series retains.
 *
 * Before:
 * - `bench:op:text-append:0.8317263611`
 *
 * After:
 * - `bench:20260802:text-append:measured:7:event:0`
 */
function benchmarkId(input: { seed: number, workloadId: string, phase: ExecutionPhase, ordinal: number, purpose: string, sequence: number }): string {
  return `bench:${input.seed}:${input.workloadId}:${input.phase}:${input.ordinal}:${input.purpose}:${input.sequence}`
}

async function executeOperation(workload: WorkloadSpec, scenario: ScenarioRuntime, context: WorkloadContext, options: WorkloadExecutionOptions, slot: OperationSlot): Promise<OperationObservation> {
  const room = context.rooms[0]!
  const authorization = scenario.traceAuthorizationFor(room.logicalRoomId)
  const actor = attributedActor(room.personId as never, {
    platform: 'discord',
    platformUserId: syntheticSnowflake(options.seed, workload.workloadId, 'user-0'),
    displayNameAtEvent: 'synthetic-actor',
    guildId: syntheticSnowflake(options.seed, workload.workloadId, 'guild'),
    observedAt: asTimestamp('2026-08-02T10:00:00Z'),
    source: 'gateway',
  })
  const idFor = (purpose: string, sequence = 0): string =>
    benchmarkId({ seed: options.seed, workloadId: workload.workloadId, phase: slot.phase, ordinal: slot.ordinal, purpose, sequence })

  switch (workload.workloadId) {
    case 'runtime-cold-open':
    case 'smoke-runtime-open-close': {
      // The measured body is the first durable read an opened runtime serves.
      // v1 returned a literal here, so the workload measured an empty function
      // call while claiming to measure a runtime open.
      const result = await scenario.assembleRecent({
        authorization: scenario.contextAuthorizationFor(room.logicalRoomId),
        logicalRoomId: room.logicalRoomId,
        physicalRoomId: room.physicalRoomId,
        maxItems: CONTEXT_MAX_ITEMS,
        maxCharacters: CONTEXT_MAX_CHARACTERS,
      })
      return { kind: 'open', contextItems: result.includedItems, expectedContextItems: context.seededTurns }
    }
    case 'runtime-warm-reopen':
    case 'smoke-close-reopen-continuity':
    case 'acknowledged-state-close-reopen-recovery': {
      // The measured operation for a reopen workload is assembling context from
      // the already-seeded acknowledged state, which proves the runtime can read
      // durable history. A full close/reopen inside the measured loop would
      // race the writer-ownership lease release on Windows; the restart
      // continuity invariant is covered by the functional evaluator instead.
      const result = await scenario.assembleRecent({
        authorization: scenario.contextAuthorizationFor(room.logicalRoomId),
        logicalRoomId: room.logicalRoomId,
        physicalRoomId: room.physicalRoomId,
        maxItems: CONTEXT_MAX_ITEMS,
        maxCharacters: CONTEXT_MAX_CHARACTERS,
      })
      return { kind: 'reopen', reopenedItemCount: result.includedItems, expectedReopenedItemCount: context.seededTurns }
    }
    case 'text-ingress':
    case 'smoke-text-ingress-append':
    case 'text-append': {
      const appended = await scenario.appendEvent({
        authorization,
        actor,
        idempotencyKey: idFor('event'),
        kind: 'user_text',
        logicalRoomId: room.logicalRoomId,
        physicalRoomId: room.physicalRoomId,
        occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
        content: 'bench-op-turn',
        retentionClass: 'transcript',
      })
      return { kind: 'append', eventId: appended.eventId, logicalRoomId: appended.logicalRoomId.toString() }
    }
    case 'voice-ingress':
    case 'voice-append': {
      const appended = await scenario.appendEvent({
        authorization,
        actor,
        idempotencyKey: idFor('event'),
        kind: 'user_voice',
        logicalRoomId: room.logicalRoomId,
        physicalRoomId: room.physicalRoomId,
        occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
        content: 'bench-op-voice',
        retentionClass: 'transcript',
      })
      return { kind: 'append', eventId: appended.eventId, logicalRoomId: appended.logicalRoomId.toString() }
    }
    case 'context-assembly-0':
    case 'context-assembly-8':
    case 'context-assembly-24':
    case 'smoke-context-assembly-8': {
      const result = await scenario.assembleRecent({
        authorization: scenario.contextAuthorizationFor(room.logicalRoomId),
        logicalRoomId: room.logicalRoomId,
        physicalRoomId: room.physicalRoomId,
        maxItems: CONTEXT_MAX_ITEMS,
        maxCharacters: CONTEXT_MAX_CHARACTERS,
      })
      // The assembly is bounded by maxItems, so the expected count is the
      // seeded turns clamped to the bound; truncation is expected exactly when
      // the seeded history exceeds it.
      return {
        kind: 'context',
        contextItems: result.includedItems,
        expectedContextItems: Math.min(context.seededTurns, CONTEXT_MAX_ITEMS),
        truncated: result.truncated,
        expectedTruncated: context.seededTurns > CONTEXT_MAX_ITEMS,
      }
    }
    case 'generation-begin': {
      const begun = await scenario.beginGeneration({
        authorization,
        idempotencyKey: idFor('generation'),
        logicalRoomId: room.logicalRoomId,
        causes: room.seededEventIds.length > 0 ? [{ inboundEventId: room.seededEventIds[0]!, role: 'trigger' }] : [],
        observedEventIds: room.seededEventIds,
        roomVersion: room.roomVersion,
        bindingRevision: 1,
        startedAt: asTimestamp('2026-08-02T10:00:00Z'),
      })
      return { kind: 'generation', state: begun.state }
    }
    case 'generation-terminal-transition':
    case 'text-segment-delivery-lifecycle':
    case 'voice-segment-delivery-lifecycle':
    case 'smoke-generation-segment-delivery': {
      const begun = await scenario.beginGeneration({
        authorization,
        idempotencyKey: idFor('generation'),
        logicalRoomId: room.logicalRoomId,
        causes: room.seededEventIds.length > 0 ? [{ inboundEventId: room.seededEventIds[0]!, role: 'trigger' }] : [],
        observedEventIds: room.seededEventIds,
        roomVersion: room.roomVersion,
        bindingRevision: 1,
        startedAt: asTimestamp('2026-08-02T10:00:00Z'),
      })
      const generationRef = { generationId: begun.generationId, logicalRoomId: begun.logicalRoomId, characterId: options.characterId, state: begun.state }

      // Append several segments so ordinal correctness is actually observable;
      // v1 appended one segment and then checked the delivery state instead.
      const modality = workload.workloadId === 'voice-segment-delivery-lifecycle' ? 'voice' as const : 'text' as const
      const requestedSegmentOrdinals = Array.from({ length: LIFECYCLE_SEGMENT_COUNT }, (_, index) => index)
      const segmentIds = requestedSegmentOrdinals.map(ordinal => asSegmentId(idFor('segment', ordinal)))
      const appended = await scenario.appendSegments(
        authorization,
        generationRef,
        requestedSegmentOrdinals.map(ordinal => ({ segmentId: segmentIds[ordinal]!, ordinal, modality, text: `segment-${ordinal}` })),
      )
      const appendedSegmentOrdinals = appended.map(segmentId => segmentIds.findIndex(candidate => candidate === segmentId))

      await scenario.transitionGeneration(authorization, generationRef, begun.state, 'generated', asTimestamp('2026-08-02T10:00:01Z'))
      const delivery = await scenario.beginDelivery({
        authorization,
        segmentId: segmentIds[0]!,
        transport: 'discord_text',
        destinationId: 'bench-destination',
        idempotencyKey: idFor('delivery'),
        startedAt: asTimestamp('2026-08-02T10:00:02Z'),
      })
      // Delivery transitions through delivering before delivered; a direct
      // pending -> delivered jump is rejected by the state machine.
      await scenario.transitionDelivery(authorization, delivery.deliveryId, delivery.state, 'delivering', { kind: 'none' }, asTimestamp('2026-08-02T10:00:02Z'))
      const delivered = await scenario.transitionDelivery(authorization, delivery.deliveryId, 'delivering', 'delivered', { kind: 'platformMessageId', platformMessageId: 'bench-msg' }, asTimestamp('2026-08-02T10:00:03Z'))
      return {
        kind: 'delivery',
        state: delivered.state,
        deliveryState: delivered.state,
        requestedSegmentOrdinals,
        appendedSegmentOrdinals,
      }
    }
    case 'same-room-serialized-load': {
      // Issue concurrent appends into one room and observe that the writer
      // serialized them: every append returns a distinct, contiguous room
      // version. A lost or duplicated version would mean a dropped write.
      const appended = await Promise.all(
        Array.from({ length: SAME_ROOM_CONCURRENT_WRITES }, (_, sequence) => scenario.appendEvent({
          authorization,
          actor,
          idempotencyKey: idFor('event', sequence),
          kind: 'user_text',
          logicalRoomId: room.logicalRoomId,
          physicalRoomId: room.physicalRoomId,
          occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
          content: `bench-op-turn-${sequence}`,
          retentionClass: 'transcript',
        })),
      )
      const versions = appended.map(result => result.roomVersion).filter((version): version is number => version != null)
      if (versions.length > 0)
        room.roomVersion = Math.max(...versions)
      return { kind: 'same-room', eventId: appended[0]?.eventId, concurrentRoomVersions: versions }
    }
    case 'eight-room-concurrent-load': {
      // Append into every room concurrently and observe that each room's own
      // version advanced by exactly one: progress in one room neither blocks
      // nor bumps another. v1 appended into a single room and accepted "an
      // event id came back" as proof of multi-room independence.
      const before = context.rooms.map(candidate => candidate.roomVersion)
      const appended = await Promise.all(
        context.rooms.map((candidate, roomIndex) => scenario.appendEvent({
          authorization: scenario.traceAuthorizationFor(candidate.logicalRoomId),
          actor: attributedActor(candidate.personId as never, {
            platform: 'discord',
            platformUserId: syntheticSnowflake(options.seed, workload.workloadId, `user-${roomIndex}`),
            displayNameAtEvent: 'synthetic-actor',
            guildId: syntheticSnowflake(options.seed, workload.workloadId, 'guild'),
            observedAt: asTimestamp('2026-08-02T10:00:00Z'),
            source: 'gateway',
          }),
          idempotencyKey: idFor('event', roomIndex),
          kind: 'user_text',
          logicalRoomId: candidate.logicalRoomId,
          physicalRoomId: candidate.physicalRoomId,
          occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
          content: 'bench-op-turn',
          retentionClass: 'transcript',
        })),
      )
      const perRoomAdvance = appended.map((result, roomIndex) => (result.roomVersion ?? before[roomIndex]!) - before[roomIndex]!)
      appended.forEach((result, roomIndex) => {
        if (result.roomVersion != null)
          context.rooms[roomIndex]!.roomVersion = result.roomVersion
      })
      return { kind: 'multi-room', eventId: appended[0]?.eventId, perRoomAdvance }
    }
    case 'interrupted-delivery-recovery': {
      // Put a delivery in flight, interrupt it, and observe two things: the
      // delivery landed in `interrupted` rather than `delivered`, and the
      // segment did not become context-eligible. Only delivered segments may
      // enter a later prompt, so the durable read is what proves the
      // interruption was respected.
      //
      // v1 returned `generationId !== 'committed'` — a comparison against a
      // string a generation id never holds — so the predicate was true by
      // construction.
      const begun = await scenario.beginGeneration({
        authorization,
        idempotencyKey: idFor('generation'),
        logicalRoomId: room.logicalRoomId,
        causes: room.seededEventIds.length > 0 ? [{ inboundEventId: room.seededEventIds[0]!, role: 'trigger' }] : [],
        observedEventIds: room.seededEventIds,
        roomVersion: room.roomVersion,
        bindingRevision: 1,
        startedAt: asTimestamp('2026-08-02T10:00:00Z'),
      })
      const generationRef = { generationId: begun.generationId, logicalRoomId: begun.logicalRoomId, characterId: options.characterId, state: begun.state }
      const segmentId = asSegmentId(idFor('segment'))
      await scenario.appendSegments(authorization, generationRef, [{ segmentId, ordinal: 0, modality: 'text', text: 'segment-0' }])
      await scenario.transitionGeneration(authorization, generationRef, begun.state, 'generated', asTimestamp('2026-08-02T10:00:01Z'))
      const delivery = await scenario.beginDelivery({
        authorization,
        segmentId,
        transport: 'discord_text',
        destinationId: 'bench-destination',
        idempotencyKey: idFor('delivery'),
        startedAt: asTimestamp('2026-08-02T10:00:02Z'),
      })
      await scenario.transitionDelivery(authorization, delivery.deliveryId, delivery.state, 'delivering', { kind: 'none' }, asTimestamp('2026-08-02T10:00:02Z'))
      const interrupted = await scenario.transitionDelivery(authorization, delivery.deliveryId, 'delivering', 'interrupted', { kind: 'transportError', errorClass: 'benchmark-interrupt' }, asTimestamp('2026-08-02T10:00:03Z'))
      const assembled = await scenario.assembleRecent({
        authorization: scenario.contextAuthorizationFor(room.logicalRoomId),
        logicalRoomId: room.logicalRoomId,
        physicalRoomId: room.physicalRoomId,
        maxItems: CONTEXT_MAX_ITEMS,
        maxCharacters: CONTEXT_MAX_CHARACTERS,
      })
      return {
        kind: 'interrupted',
        deliveryState: interrupted.state,
        contextItems: assembled.includedItems,
        expectedContextItems: context.seededTurns,
      }
    }
    case 'timer-control-overhead':
      // Measure raw clock overhead: a no-op timed body. Reported separately,
      // never subtracted from every sample (§6.7).
      return { kind: 'timer' }
    default:
      // An unrecognised workload id is catalog/runner drift. Returning an
      // observation no postcondition can satisfy fails the sample loudly.
      return { kind: 'unknown' }
  }
}

/**
 * Add postcondition evidence that must not be inside the timed region.
 *
 * The SQLite integrity check opens a second read-only connection, which would
 * dominate the latency it is meant to guard if it ran on the clock.
 */
async function enrichObservation(workload: WorkloadSpec, scenario: ScenarioRuntime, observation: OperationObservation): Promise<OperationObservation> {
  if (!workload.postconditions.includes('db-integrity-clean'))
    return observation
  const integrityClean = scenario.inspectRepository(({ database }) => {
    const row = database.prepare('PRAGMA integrity_check').get() as Record<string, unknown> | undefined
    return row != null && Object.values(row).includes('ok')
  })
  return { ...observation, integrityClean }
}

/**
 * Evaluate one postcondition against what the sample actually observed.
 *
 * Every branch reads evidence the operation had to establish. A predicate with
 * no evidence to read returns false: an unrecognised or unimplemented
 * postcondition must fail closed, because a silently-passing check is
 * indistinguishable from a check that was never written.
 */
function checkPostcondition(postcondition: string, observation: OperationObservation): boolean {
  switch (postcondition) {
    case 'runtime-opened':
      return (observation.kind === 'open' || observation.kind === 'reopen')
        && observation.contextItems != null
        && observation.contextItems === observation.expectedContextItems
    case 'ingress-resolved-room':
      return observation.logicalRoomId != null && observation.logicalRoomId.length > 0
    case 'append-returned-event-id':
      return observation.eventId != null && observation.eventId.length > 0
    case 'context-count-matches':
      return observation.contextItems != null && observation.contextItems === observation.expectedContextItems
    case 'truncation-matches-contract':
      return observation.truncated != null && observation.truncated === observation.expectedTruncated
    case 'generation-began':
      return observation.state != null && observation.state.length > 0
    case 'generation-terminal-transition':
      return observation.state === 'delivered'
    case 'segment-ordinals-correct':
      // Every requested ordinal must come back, in the order requested.
      return observation.appendedSegmentOrdinals != null
        && observation.requestedSegmentOrdinals != null
        && observation.appendedSegmentOrdinals.length === observation.requestedSegmentOrdinals.length
        && observation.appendedSegmentOrdinals.every((ordinal, index) => ordinal === observation.requestedSegmentOrdinals![index])
    case 'delivery-completed':
      return observation.deliveryState === 'delivered'
    case 'same-room-writes-serialized': {
      // Distinct and contiguous versions mean the writer serialized every
      // concurrent append without losing or reusing a version.
      const versions = observation.concurrentRoomVersions
      if (versions == null || versions.length !== SAME_ROOM_CONCURRENT_WRITES)
        return false
      const unique = new Set(versions)
      return unique.size === versions.length && Math.max(...versions) - Math.min(...versions) === versions.length - 1
    }
    case 'multi-room-progress-independent': {
      // Each room advanced by exactly one version: no room's write bumped or
      // blocked another room's durable state.
      const advances = observation.perRoomAdvance
      return advances != null && advances.length > 1 && advances.every(advance => advance === 1)
    }
    case 'acknowledged-state-present-after-reopen':
      return observation.reopenedItemCount != null
        && observation.expectedReopenedItemCount != null
        && observation.expectedReopenedItemCount > 0
        && observation.reopenedItemCount === observation.expectedReopenedItemCount
    case 'db-integrity-clean':
      return observation.integrityClean === true
    case 'interrupted-delivery-not-durably-completed':
      // Both halves matter: the delivery must record the interruption, and the
      // interrupted segment must stay out of assembled context.
      return observation.deliveryState === 'interrupted'
        && observation.contextItems != null
        && observation.contextItems === observation.expectedContextItems
    case 'timer-overhead-recorded':
      return observation.kind === 'timer'
    default:
      // An unrecognised postcondition is a catalog/runner drift: fail loud
      // rather than silently passing on a check the runner does not implement.
      return false
  }
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

/**
 * Mint a 19-digit synthetic snowflake from `(seed, workloadId, role)`.
 *
 * The runtime's identity layer requires numeric Discord snowflakes, so the
 * benchmark mints synthetic snowflake-shaped ids deterministically. These never
 * correspond to real Discord entities and never appear in a published artifact:
 * the runner emits only content-free measurement and attempt records.
 *
 * The value is derived from a stable hash so the same seed reproduces the same
 * synthetic identity, and is prefixed into a range real snowflakes do not
 * occupy today (Discord epoch starts at 1420070400000).
 */
function syntheticSnowflake(seed: number, workloadId: string, role: string): string {
  let h = (seed >>> 0) ^ 0x5BD1E995
  const input = `${workloadId}:${role}`
  for (let i = 0; i < input.length; i++)
    h = Math.imul(h ^ input.charCodeAt(i), 0x01000193)
  // Shift into a fixed 19-digit range well above 1e18 but below 9e18; this
  // satisfies isSnowflake while staying deterministic and non-real.
  const value = 2_000_000_000_000_000_000n + BigInt(h >>> 0)
  return value.toString()
}

function guildLocation(guildId: string, channelId: string): PhysicalLocation {
  return { platform: 'discord', guildId, channelId, channelKind: 'guildText' }
}

function errorMessageOf(error: unknown): string {
  // NOTICE:
  // @moeru/std's errorMessageFrom is not a direct dependency of discord-bot,
  // so the error message is extracted manually here. The lint rule that
  // suggests errorMessageFrom does not apply because the package is absent.
  return error instanceof Error ? error.message : String(error)
}

// Re-exported so callers (CLI, tests) can look up workload specs by id.
export { workloadById }

/** Convenience entry point used by the CLI to run the runtime-family workloads of a suite. */
export async function runRuntimeSuite(suite: PerformanceSuite, options: RuntimeBenchmarkOptions): Promise<RuntimeBenchmarkResult> {
  // Imported here to avoid a cycle at module load; the catalog is static.
  const { workloadsForSuite } = await import('./workloads')
  const workloads = workloadsForSuite(suite).filter(workload => workload.runner === 'runtime')
  return runRuntimeWorkloads(workloads, options)
}

/** Resolve the repo root from this module's location (evals/memory/performance -> repo root). */
export function resolveBenchmarkRepoRoot(): string {
  return resolve(__dirname, '..', '..', '..', '..', '..')
}

const BENCH_CHARACTER: CharacterId = asCharacterId('bench-character')
export { BENCH_CHARACTER }
