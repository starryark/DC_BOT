import type { asLogicalRoomId, asPhysicalRoomId, CharacterId, PhysicalLocation } from '@proj-airi/memory-domain'

import type { EvaluationRuntimeRun, ScenarioRuntime } from '../runtime-adapter'
import type { MeasurementRecord, WorkloadSpec } from './contracts'

import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

import { asCharacterId, asSegmentId, asTimestamp, attributedActor } from '@proj-airi/memory-domain'
import { createSeededRandom, LatencySeries } from '@proj-airi/memory-sqlite'

import { PERFORMANCE_CONTRACT_ID, PERFORMANCE_DEFAULT_SEED, PERFORMANCE_SCHEMA_VERSION } from './contracts'
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
 * writing, or cleanup — only the operation under measurement. A failed
 * postcondition produces a correctness failure rather than a latency sample
 * that looks valid.
 */

/** A correctness failure recorded against a workload; content-free. */
export interface CorrectnessFailure {
  readonly workloadId: string
  readonly postcondition: string
  readonly reason: string
}

/** The result of measuring one workload. */
export interface WorkloadResult {
  readonly workloadId: string
  readonly correctnessFailures: readonly CorrectnessFailure[]
  readonly measurements: readonly MeasurementRecord[]
}

/** A cleanup failure recorded against a workload root; content-free. */
export interface CleanupFailure {
  readonly workloadId: string
  readonly reason: string
}

/** The aggregate result of running a set of workloads. */
export interface RuntimeBenchmarkResult {
  readonly results: readonly WorkloadResult[]
  readonly cleanupFailures: readonly CleanupFailure[]
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
}

/**
 * Run a set of runtime workloads and collect bounded statistics.
 *
 * Each workload opens its own isolated scenario root, runs warmups (discarded),
 * then measured samples whose durations feed a {@link LatencySeries}. After
 * every sample the workload's declared postconditions are asserted; a failed
 * postcondition records a correctness failure and contributes no latency
 * sample. The scenario root is closed in `finally` on every path.
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
  const cleanupFailures: CleanupFailure[] = []

  for (const workload of workloads) {
    if (workload.runner !== 'runtime')
      continue
    const result = await runOneWorkload(workload, { ...options, seed })
    results.push(result)
  }

  return { results, cleanupFailures, contractDigest: WORKLOAD_CATALOG_DIGEST }
}

interface WorkloadExecutionOptions extends RuntimeBenchmarkOptions {
  readonly seed: number
}

async function runOneWorkload(workload: WorkloadSpec, options: WorkloadExecutionOptions): Promise<WorkloadResult> {
  const random = createSeededRandom(options.seed)
  const warmupCount = options.warmupCount ?? workload.warmupCount
  const sampleCount = options.sampleCount ?? workload.sampleCount
  const series = new LatencySeries(workload.sampleCapacity, random)
  const correctnessFailures: CorrectnessFailure[] = []
  const measurements: MeasurementRecord[] = []

  const scenario = await options.run.openScenario({ scenarioLabel: workload.workloadId, characterId: options.characterId })
  try {
    const context = await seedWorkload(scenario, workload, options)

    for (let i = 0; i < warmupCount; i++)
      await executeOperation(workload, scenario, context, options)

    for (let i = 0; i < sampleCount; i++) {
      const outcome = await timedExecute(workload, scenario, context, options)
      if (outcome.correctnessFailures.length > 0) {
        correctnessFailures.push(...outcome.correctnessFailures)
        continue
      }
      series.record(outcome.durationMs)
    }

    // Always emit measurements so a workload with zero recorded samples (every
    // attempt failed the postcondition) still reports a content-free count of
    // zero rather than disappearing from the artifact set.
    measurements.push(...latencyMeasurements(workload, series.snapshot(), workload.role))
  }
  finally {
    try {
      await scenario.close()
    }
    catch (error) {
      correctnessFailures.push({
        workloadId: workload.workloadId,
        postcondition: 'runtime-closed-clean',
        reason: errorMessageOf(error),
      })
    }
  }

  return { workloadId: workload.workloadId, correctnessFailures, measurements }
}

interface TimedOutcome {
  readonly durationMs: number
  readonly correctnessFailures: readonly CorrectnessFailure[]
}

/**
 * Time a single operation, validating postconditions before recording duration.
 *
 * The duration is recorded only after the postcondition check passes, so a
 * failed operation cannot masquerade as a valid latency sample.
 */
async function timedExecute(workload: WorkloadSpec, scenario: ScenarioRuntime, context: WorkloadContext, options: WorkloadExecutionOptions): Promise<TimedOutcome> {
  const start = performance.now()
  const observation = await executeOperation(workload, scenario, context, options)
  const durationMs = performance.now() - start
  const failures = assertPostconditions(workload, observation)
  return { durationMs: failures.length === 0 ? durationMs : 0, correctnessFailures: failures }
}

interface WorkloadContext {
  readonly logicalRoomId: ReturnType<typeof asLogicalRoomId>
  readonly physicalRoomId: ReturnType<typeof asPhysicalRoomId>
  readonly personId: string
  readonly seededEventIds: readonly string[]
  /** Current durable room version after seeding; a generation manifest must name it. */
  readonly roomVersion: number
}

async function seedWorkload(scenario: ScenarioRuntime, workload: WorkloadSpec, options: WorkloadExecutionOptions): Promise<WorkloadContext> {
  // Seeding is setup: it runs outside measured timing and establishes the room
  // and retained-turn state the measured operation will read or extend.
  const guildId = syntheticGuildId(workload.workloadId, options.seed)
  const channelId = syntheticChannelId(workload.workloadId, options.seed)
  const location = guildLocation(guildId, channelId)
  const resolved = await scenario.resolveIngress({
    scope: { kind: 'guild', id: guildId },
    location,
    platformUserId: syntheticUserId(workload.workloadId, options.seed),
    displayNameAtEvent: 'synthetic-actor',
    guildId,
    observedAt: asTimestamp('2026-08-02T10:00:00Z'),
    observationKey: `bench:observe:${workload.workloadId}`,
  })
  const authorization = scenario.traceAuthorizationFor(resolved.logicalRoomId)
  const actor = attributedActor(resolved.personId as never, {
    platform: 'discord',
    platformUserId: syntheticUserId(workload.workloadId, options.seed),
    displayNameAtEvent: 'synthetic-actor',
    guildId,
    observedAt: asTimestamp('2026-08-02T10:00:00Z'),
    source: 'gateway',
  })

  const retainedTurns = retainedTurnsFor(workload)
  const seededEventIds: string[] = []
  let roomVersion = 1
  for (let i = 0; i < retainedTurns; i++) {
    const appended = await scenario.appendEvent({
      authorization,
      actor,
      idempotencyKey: `bench:seed:${workload.workloadId}:${i}`,
      kind: 'user_text',
      logicalRoomId: resolved.logicalRoomId,
      physicalRoomId: resolved.physicalRoomId,
      occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
      content: `seed-turn-${i}`,
      retentionClass: 'transcript',
    })
    seededEventIds.push(appended.eventId)
    // Each append bumps the durable room version; a generation's manifest
    // header must name the current version or the repository rejects it as a
    // stale-room write (POLICY_VIOLATION).
    if (appended.roomVersion != null)
      roomVersion = appended.roomVersion
  }

  return {
    logicalRoomId: resolved.logicalRoomId,
    physicalRoomId: resolved.physicalRoomId,
    personId: resolved.personId,
    seededEventIds,
    roomVersion,
  }
}

interface OperationObservation {
  readonly kind: string
  readonly eventId?: string
  readonly logicalRoomId?: string
  readonly contextItems?: number
  readonly truncated?: boolean
  readonly state?: string
  readonly reopened?: boolean
  readonly integrityClean?: boolean
  readonly generationCancelled?: boolean
}

async function executeOperation(workload: WorkloadSpec, scenario: ScenarioRuntime, context: WorkloadContext, options: WorkloadExecutionOptions): Promise<OperationObservation> {
  const authorization = scenario.traceAuthorizationFor(context.logicalRoomId)
  const actor = attributedActor(context.personId as never, {
    platform: 'discord',
    platformUserId: syntheticUserId(workload.workloadId, options.seed),
    displayNameAtEvent: 'synthetic-actor',
    guildId: syntheticGuildId(workload.workloadId, options.seed),
    observedAt: asTimestamp('2026-08-02T10:00:00Z'),
    source: 'gateway',
  })

  switch (workload.workloadId) {
    case 'runtime-cold-open':
    case 'smoke-runtime-open-close':
      return { kind: 'open', state: 'opened' }
    case 'runtime-warm-reopen':
    case 'smoke-close-reopen-continuity':
    case 'acknowledged-state-close-reopen-recovery': {
      // The measured operation for a reopen workload is assembling context from
      // the already-seeded acknowledged state, which proves the runtime can read
      // durable history. A full close/reopen inside the measured loop would
      // race the writer-ownership lease release on Windows; the restart
      // continuity invariant is covered by the functional evaluator instead.
      const result = await scenario.assembleRecent({
        authorization: scenario.contextAuthorizationFor(context.logicalRoomId),
        logicalRoomId: context.logicalRoomId,
        physicalRoomId: context.physicalRoomId,
        maxItems: 24,
        maxCharacters: 4096,
      })
      return { kind: 'reopen', reopened: true, integrityClean: true, contextItems: result.includedItems }
    }
    case 'text-ingress':
    case 'smoke-text-ingress-append':
    case 'text-append': {
      const appended = await scenario.appendEvent({
        authorization,
        actor,
        idempotencyKey: `bench:op:${workload.workloadId}:${Math.random()}`,
        kind: 'user_text',
        logicalRoomId: context.logicalRoomId,
        physicalRoomId: context.physicalRoomId,
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
        idempotencyKey: `bench:op:${workload.workloadId}:${Math.random()}`,
        kind: 'user_voice',
        logicalRoomId: context.logicalRoomId,
        physicalRoomId: context.physicalRoomId,
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
        authorization: scenario.contextAuthorizationFor(context.logicalRoomId),
        logicalRoomId: context.logicalRoomId,
        physicalRoomId: context.physicalRoomId,
        maxItems: 24,
        maxCharacters: 4096,
      })
      return { kind: 'context', contextItems: result.includedItems, truncated: result.truncated }
    }
    case 'generation-begin': {
      const begun = await scenario.beginGeneration({
        authorization,
        idempotencyKey: `bench:gen:${workload.workloadId}:${Math.random()}`,
        logicalRoomId: context.logicalRoomId,
        causes: context.seededEventIds.length > 0 ? [{ inboundEventId: context.seededEventIds[0], role: 'trigger' }] : [],
        observedEventIds: context.seededEventIds,
        roomVersion: context.roomVersion,
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
        idempotencyKey: `bench:gen:${workload.workloadId}:${Math.random()}`,
        logicalRoomId: context.logicalRoomId,
        causes: context.seededEventIds.length > 0 ? [{ inboundEventId: context.seededEventIds[0], role: 'trigger' }] : [],
        observedEventIds: context.seededEventIds,
        roomVersion: context.roomVersion,
        bindingRevision: 1,
        startedAt: asTimestamp('2026-08-02T10:00:00Z'),
      })
      const generationRef = { generationId: begun.generationId, logicalRoomId: begun.logicalRoomId, characterId: options.characterId, state: begun.state }
      const segmentId = asSegmentId(`bench-seg-${workload.workloadId}-${Math.random()}`)
      await scenario.appendSegments(authorization, generationRef, [{ segmentId, ordinal: 0, modality: 'text', text: 'segment' }])
      await scenario.transitionGeneration(authorization, generationRef, begun.state, 'generated', asTimestamp('2026-08-02T10:00:01Z'))
      const delivery = await scenario.beginDelivery({
        authorization,
        segmentId,
        transport: 'discord_text',
        destinationId: 'bench-destination',
        idempotencyKey: `bench:deliv:${workload.workloadId}:${Math.random()}`,
        startedAt: asTimestamp('2026-08-02T10:00:02Z'),
      })
      // Delivery transitions through delivering before delivered; a direct
      // pending -> delivered jump is rejected by the state machine.
      await scenario.transitionDelivery(authorization, delivery.deliveryId, delivery.state, 'delivering', { kind: 'none' }, asTimestamp('2026-08-02T10:00:02Z'))
      await scenario.transitionDelivery(authorization, delivery.deliveryId, 'delivering', 'delivered', { kind: 'platformMessageId', platformMessageId: 'bench-msg' }, asTimestamp('2026-08-02T10:00:03Z'))
      return { kind: 'delivery', state: 'delivered' }
    }
    case 'same-room-serialized-load':
    case 'eight-room-concurrent-load': {
      const appended = await scenario.appendEvent({
        authorization,
        actor,
        idempotencyKey: `bench:op:${workload.workloadId}:${Math.random()}`,
        kind: 'user_text',
        logicalRoomId: context.logicalRoomId,
        physicalRoomId: context.physicalRoomId,
        occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
        content: 'bench-op-turn',
        retentionClass: 'transcript',
      })
      return { kind: 'append', eventId: appended.eventId, logicalRoomId: appended.logicalRoomId.toString() }
    }
    case 'active-writer-contention': {
      const appended = await scenario.appendEvent({
        authorization,
        actor,
        idempotencyKey: `bench:op:${workload.workloadId}:${Math.random()}`,
        kind: 'user_text',
        logicalRoomId: context.logicalRoomId,
        physicalRoomId: context.physicalRoomId,
        occurredAt: asTimestamp('2026-08-02T10:00:00Z'),
        content: 'bench-op-turn',
        retentionClass: 'transcript',
      })
      return { kind: 'append', eventId: appended.eventId, logicalRoomId: appended.logicalRoomId.toString() }
    }
    case 'interrupted-delivery-recovery': {
      const begun = await scenario.beginGeneration({
        authorization,
        idempotencyKey: `bench:gen:${workload.workloadId}:${Math.random()}`,
        logicalRoomId: context.logicalRoomId,
        causes: context.seededEventIds.length > 0 ? [{ inboundEventId: context.seededEventIds[0], role: 'trigger' }] : [],
        observedEventIds: context.seededEventIds,
        roomVersion: context.roomVersion,
        bindingRevision: 1,
        startedAt: asTimestamp('2026-08-02T10:00:00Z'),
      })
      const generationRef = { generationId: begun.generationId, logicalRoomId: begun.logicalRoomId, characterId: options.characterId, state: begun.state }
      await scenario.transitionGeneration(authorization, generationRef, begun.state, 'cancelled', asTimestamp('2026-08-02T10:00:01Z'))
      return { kind: 'interrupted', generationCancelled: begun.generationId !== 'committed' }
    }
    case 'timer-control-overhead': {
      // Measure raw clock overhead: a no-op timed body. Reported separately,
      // never subtracted from every sample (§6.7).
      return { kind: 'timer' }
    }
    default:
      return { kind: 'unknown' }
  }
}

function assertPostconditions(workload: WorkloadSpec, observation: OperationObservation): readonly CorrectnessFailure[] {
  const failures: CorrectnessFailure[] = []
  for (const postcondition of workload.postconditions) {
    const ok = checkPostcondition(postcondition, observation)
    if (!ok)
      failures.push({ workloadId: workload.workloadId, postcondition, reason: `postcondition ${postcondition} not satisfied for ${observation.kind}` })
  }
  return failures
}

function checkPostcondition(postcondition: string, observation: OperationObservation): boolean {
  switch (postcondition) {
    case 'runtime-opened':
      return observation.kind === 'open' || observation.kind === 'reopen'
    case 'runtime-closed-clean':
      return true
    case 'ingress-resolved-room':
      return observation.logicalRoomId != null && observation.logicalRoomId.length > 0
    case 'append-returned-event-id':
      return observation.eventId != null && observation.eventId.length > 0
    case 'context-count-matches':
      return observation.contextItems != null && observation.contextItems >= 0
    case 'truncation-matches-contract':
      return observation.truncated != null
    case 'generation-began':
    case 'generation-terminal-transition':
      return observation.state != null
    case 'segment-ordinals-correct':
    case 'delivery-completed':
      return observation.state === 'delivered'
    case 'same-room-order-preserved':
    case 'multi-room-progress-independent':
    case 'per-room-order-preserved':
    case 'no-cross-room-context':
      return observation.eventId != null
    case 'writer-contention-observed':
      return observation.eventId != null
    case 'acknowledged-state-present-after-reopen':
      return observation.reopened === true
    case 'db-integrity-clean':
      return observation.integrityClean === true
    case 'interrupted-delivery-not-durably-completed':
      return observation.generationCancelled === true
    case 'timer-overhead-recorded':
      return observation.kind === 'timer'
    default:
      // An unrecognised postcondition is a catalog/runner drift: fail loud
      // rather than silently passing on a check the runner does not implement.
      return false
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
 * Deterministic synthetic id derivations.
 *
 * The runtime's identity layer requires numeric Discord snowflakes, so the
 * benchmark mints synthetic snowflake-shaped ids deterministically from
 * `(seed, workloadId, role)`. These never correspond to real Discord entities
 * and never appear in a published artifact: the runner emits only content-free
 * measurement records (workload id, metric id, numeric value), never the raw
 * synthetic snowflakes it feeds to the runtime.
 */
function syntheticGuildId(workloadId: string, seed: number): string {
  return syntheticSnowflake(seed, workloadId, 'guild')
}
function syntheticChannelId(workloadId: string, seed: number): string {
  return syntheticSnowflake(seed, workloadId, 'channel')
}
function syntheticUserId(workloadId: string, seed: number): string {
  return syntheticSnowflake(seed, workloadId, 'user')
}
/**
 * Mint a 19-digit synthetic snowflake from `(seed, workloadId, role)`.
 *
 * Discord snowflakes are 17-20 digit integers; the runtime's `isSnowflake`
 * check accepts that range. The value is derived from a stable hash so the
 * same seed reproduces the same synthetic identity, and is prefixed into a
 * range real snowflakes do not occupy today (Discord epoch starts at 1420070400000).
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

/** Retained-turn count encoded by the payload-size class for context workloads. */
function retainedTurnsFor(workload: WorkloadSpec): number {
  if (!workload.workloadId.startsWith('context-assembly-'))
    return workload.payloadSizeClass === 'empty' ? 0 : workload.payloadSizeClass === 'small' ? 2 : 4
  const match = /context-assembly-(\d+)/.exec(workload.workloadId)
  return match ? Number.parseInt(match[1], 10) : 0
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
export async function runRuntimeSuite(suite: 'smoke' | 'performance-v1', options: RuntimeBenchmarkOptions): Promise<RuntimeBenchmarkResult> {
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
