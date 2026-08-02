/**
 * G2 operational soak harness (OQ-BLOCK-003 evidence collection).
 *
 * Runs a deployment-shaped synthetic workload against a run-scoped SQLite
 * database on an operator-nominated volume, exercising checkpoints, online
 * backups, a restore drill, bounded lock contention, and connection reopen,
 * and emits machine-readable plus human-readable evidence.
 *
 * This is a test-only harness. It never opens a production database, never
 * enables a runtime memory flag, and never marks G2 as passed: a completed run
 * is input to an operator review, not a substitute for one.
 *
 * Call stack:
 *
 * main
 *   -> {@link resolveG2Configuration}         (g2-config)
 *   -> {@link assertSyntheticDirectory}       (g2-path-safety)
 *   -> openConnections
 *     -> {@link openSqliteDatabase}           (../connection-profile)
 *     -> {@link captureSqliteProfile}         (g2-environment)
 *   -> seedWorkload -> workload loop
 *     -> appendIngressEvent / runRead / runQueueCycle
 *     -> runCheckpoint / runBackup / runContentionProbe / runConnectionReopen
 *   -> runRestoreDrill -> runSecondWriterProbe
 *   -> {@link buildRunSummary} / {@link renderMarkdownReport}  (g2-report)
 */

import type { DatabaseSync } from 'node:sqlite'

import type { AppendEventInput, AttributedActor, LogicalRoomId, PersonId, PhysicalLocation, PhysicalRoomId } from '@proj-airi/memory-domain'

import type { SqliteWriterOwnership } from '../writer-ownership.js'
import type { G2Configuration } from './g2-config.js'
import type { SqliteProfileEvidence } from './g2-environment.js'
import type { G2RunPaths } from './g2-path-safety.js'
import type { BackupRecord, CheckpointRecord, G2RunEvidence, G2RunStatus, RestartRecord, RestoreRecord, SecondWriterProbeResult } from './g2-report.js'
import type { G2ThresholdDocument } from './g2-thresholds.js'

import process from 'node:process'

import { fork } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

import { asCharacterId, asEventId, asRequestId, asTimestamp, attributedActor, MemoryError } from '@proj-airi/memory-domain'

import { createVerifiedBackup, restoreVerifiedBackup, verifyDatabase } from '../backup.js'
import { classifySqliteFailure, openSqliteDatabase } from '../connection-profile.js'
import { latestSchemaVersion } from '../migrations/index.js'
import { ReconciliationQueue } from '../reconciliation-queue.js'
import { EventRepository } from '../repositories/events.js'
import { IdentityRepository } from '../repositories/identity.js'
import { RoomRepository } from '../repositories/rooms.js'
import { UnitOfWork } from '../unit-of-work.js'
import { openAuthoritativeSqliteDatabase, sqliteWriterOwnershipGuardVersion } from '../writer-ownership.js'
import { formatResolvedConfiguration, resolveG2Configuration } from './g2-config.js'
import { captureEnvironment, captureSqliteProfile } from './g2-environment.js'
import { createSeededRandom, MetricsCollector, observedMetricValues } from './g2-metrics.js'
import { assertDerivedArtifactPath, assertOutsideRepositoryCheckout, assertSyntheticDirectory, createRunId, createRunPaths, findRepositoryRoot, syntheticPurpose, writeSyntheticDirectoryMarker } from './g2-path-safety.js'
import { buildRunSummary, nonApprovalStatement, renderMarkdownReport } from './g2-report.js'
import { evaluateThresholds, loadThresholdDocument } from './g2-thresholds.js'

/** Scheduler granularity. Small enough to shape sub-second rates, large enough to leave the loop idle. */
const tickIntervalMs = 20

/** Upper bound on operations executed inside one tick, so a saturated writer shows up as queue depth rather than a stalled loop. */
const maximumWritesPerTick = 250

/** Recent events retained for authorized point reads. Bounded because a soak may append millions of rows. */
const recentEventWindow = 256

const moduleDirectory = dirname(fileURLToPath(import.meta.url))

interface SyntheticRoom {
  readonly index: number
  readonly location: PhysicalLocation
  readonly physicalRoomId: PhysicalRoomId
  readonly logicalRoomId: LogicalRoomId
}

interface SyntheticPerson {
  readonly personId: PersonId
  readonly discordUserId: string
  readonly displayName: string
  readonly ssrc: number
}

interface RecentEvent {
  readonly eventId: string
  readonly physicalRoomId: PhysicalRoomId
  readonly logicalRoomId: LogicalRoomId
}

/** All open connections plus the repositories bound to them; replaced wholesale on reopen. */
interface Connections {
  readonly ownership: SqliteWriterOwnership
  readonly writer: DatabaseSync
  readonly readers: readonly DatabaseSync[]
  readonly events: EventRepository
  readonly readerEvents: readonly EventRepository[]
  readonly rooms: RoomRepository
  readonly identity: IdentityRepository
  readonly queue: ReconciliationQueue
}

/** Streams evidence events to `events.jsonl` without retaining them in memory. */
class EventLog {
  private readonly stream: ReturnType<typeof createWriteStream>
  private sequence = 0

  constructor(path: string) {
    this.stream = createWriteStream(path, { encoding: 'utf8', flags: 'wx' })
  }

  write(type: string, payload: Record<string, unknown>): void {
    this.sequence += 1
    this.stream.write(`${JSON.stringify({ at: new Date().toISOString(), sequence: this.sequence, type, ...payload })}\n`)
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.stream.end((error?: Error | null) => (error == null ? resolve() : reject(error)))
    })
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const nowIso = (): string => new Date().toISOString()
const fileSize = async (path: string): Promise<number> => stat(path).then(value => value.size, () => 0)
/** Bounded, single-value error text for evidence records; long causes are truncated, never parsed. */
function shortMessage(error: unknown): string {
  if (error instanceof Error)
    return error.message.slice(0, 300)
  return String(error).slice(0, 300)
}

/**
 * Synthetic Discord snowflake.
 *
 * Seventeen digits keeps the value inside the domain's snowflake shape while
 * the fixed leading prefix keeps every generated identifier far away from any
 * real Discord identifier a reviewer might recognise. Values are derived from
 * the index, so one seed reproduces one identity set.
 */
function syntheticSnowflake(prefix: number, index: number): string {
  return `${prefix}${String(index).padStart(17 - String(prefix).length, '0')}`
}

function countOf(database: DatabaseSync, sql: string, ...parameters: readonly string[]): number {
  return Number((database.prepare(sql).get(...parameters) as { value: number }).value)
}

function eventRowCount(database: DatabaseSync): number {
  return countOf(database, 'SELECT count(*) AS value FROM inbound_event_records')
}

function openConnections(paths: G2RunPaths, config: G2Configuration, ownership?: SqliteWriterOwnership): Connections {
  const authority = ownership == null
    ? openAuthoritativeSqliteDatabase(paths.databasePath, { busyTimeoutMs: config.busyTimeoutMs, acquisitionTimeoutMs: config.busyTimeoutMs })
    : { database: openSqliteDatabase(paths.databasePath, { busyTimeoutMs: config.busyTimeoutMs }), ownership }
  const writer = authority.database
  const readers: DatabaseSync[] = []
  try {
    for (let index = 0; index < config.readerConcurrency; index++)
      readers.push(openSqliteDatabase(paths.databasePath, { busyTimeoutMs: config.busyTimeoutMs, readOnly: true }))
  }
  catch (error) {
    for (const reader of readers)
      reader.close()
    writer.close()
    if (ownership == null)
      authority.ownership.close()
    throw error
  }
  return {
    ownership: authority.ownership,
    writer,
    readers,
    events: new EventRepository(writer),
    readerEvents: readers.map(reader => new EventRepository(reader)),
    rooms: new RoomRepository(writer),
    identity: new IdentityRepository(writer),
    queue: new ReconciliationQueue(writer),
  }
}

function closeConnections(connections: Connections, releaseOwnership = true): void {
  for (const reader of connections.readers) {
    try {
      reader.close()
    }
    catch {
      // Shutdown is best-effort: an already-closed reader must not mask the
      // real outcome of the run.
    }
  }
  try {
    connections.writer.close()
  }
  catch {
    // Same rationale as the readers above.
  }
  if (releaseOwnership)
    connections.ownership.close()
}

async function main(): Promise<void> {
  const startedAtDate = new Date()
  const startedAt = startedAtDate.toISOString()
  const resolved = resolveG2Configuration()
  const config = resolved.configuration

  console.info(`DC_BOT G2 operational soak\n${nonApprovalStatement}\n\nResolved configuration:\n${formatResolvedConfiguration(resolved)}\n`)

  const thresholds: G2ThresholdDocument | undefined = config.thresholdsFile == null ? undefined : await loadThresholdDocument(config.thresholdsFile)

  const runId = createRunId(startedAtDate)
  const paths = createRunPaths(config, runId)
  await assertOutsideRepositoryCheckout('G2_DATABASE_DIRECTORY', config.databaseDirectory, moduleDirectory)
  await assertOutsideRepositoryCheckout('G2_OUTPUT_DIRECTORY', config.outputDirectory, moduleDirectory)
  await assertSyntheticDirectory(config.databaseDirectory, 'database-authority')
  await assertSyntheticDirectory(config.outputDirectory, 'evidence-output')
  if (await stat(paths.databasePath).then(() => true, () => false))
    throw new MemoryError('POLICY_VIOLATION', `${paths.databasePath} already exists; the harness never reuses a run database`)

  await mkdir(config.databaseDirectory, { recursive: true })
  await mkdir(paths.backupsDirectory, { recursive: true })
  await mkdir(paths.restoreDirectory, { recursive: true })
  await mkdir(paths.logsDirectory, { recursive: true })
  await writeSyntheticDirectoryMarker(config.databaseDirectory, 'database-authority', startedAt)
  await writeSyntheticDirectoryMarker(config.outputDirectory, 'evidence-output', startedAt)
  await writeFile(paths.runManifestPath, `${JSON.stringify({
    format: 1,
    purpose: syntheticPurpose,
    syntheticDataOnly: true,
    runId,
    startedAt,
    databasePath: paths.databasePath,
    outputDirectory: paths.runOutputDirectory,
    harness: '@proj-airi/memory-sqlite g2-operational-soak',
    productionApprovalImplied: false,
    g2AutomaticallyPassed: false,
  }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  await writeFile(join(paths.runOutputDirectory, 'configuration.json'), `${JSON.stringify({ runId, configuration: config, requested: resolved.requested }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })

  const log = new EventLog(paths.eventsPath)
  const metrics = new MetricsCollector(config.latencySampleCapacity, config.seed)
  const random = createSeededRandom(config.seed)
  const repositoryRoot = await findRepositoryRoot(moduleDirectory)

  let interrupted = false
  const signals: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGBREAK']
  for (const signal of signals) {
    process.on(signal, () => {
      if (interrupted)
        return
      interrupted = true
      console.warn(`\n${signal} received; stopping the workload and flushing the final report.`)
    })
  }

  let connections = openConnections(paths, config)
  const profile = captureSqliteProfile(connections.writer, config.busyTimeoutMs)
  const environment = captureEnvironment(connections.writer, paths.databasePath, config.storageAttestation, repositoryRoot)
  await writeFile(join(paths.runOutputDirectory, 'environment.json'), `${JSON.stringify({ runId, environment, sqliteProfile: profile }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  log.write('run.start', { runId, startedAt, databasePath: paths.databasePath, profile, environment })
  if (!profile.valid)
    log.write('profile.invalid', { violations: profile.violations })

  const checkpoints: CheckpointRecord[] = []
  const backups: BackupRecord[] = []
  const restarts: RestartRecord[] = []
  const rooms: SyntheticRoom[] = []
  const people: SyntheticPerson[] = []
  const recent: RecentEvent[] = []
  const activeRooms = new Set<number>()
  const characterId = asCharacterId('g2-synthetic-character')

  /** Held in a record because the restore drill assigns it from a nested closure. */
  const drill: { restore: RestoreRecord | null } = { restore: null }
  let profileAfterFinalReopen: SqliteProfileEvidence | null = null
  let secondWriterProbe: SecondWriterProbeResult = 'not-tested'
  let secondWriterProbeDetail = 'The second-writer probe is opt-in and was not armed for this run (set G2_SECOND_WRITER_PROBE=enabled).'
  let secondWriterRefusalLatencyMs: number | null = null
  let transientWriteCapableConnections = 0
  let failureReason: string | null = null
  let lastAcknowledgedWriteAt: string | null = null
  let firstEventId: string | null = null

  /** Retain the newest acknowledged events for bounded point reads. */
  function remember(event: RecentEvent): void {
    recent.push(event)
    if (recent.length > recentEventWindow)
      recent.shift()
    firstEventId ??= event.eventId
  }

  function seedWorkload(): void {
    const observedAt = asTimestamp(nowIso())
    for (let index = 0; index < config.logicalRooms; index++) {
      // Alternate text and voice channels so both ingress shapes exercise the
      // same durable path, matching the deployed text/voice split.
      const location: PhysicalLocation = {
        platform: 'discord',
        guildId: syntheticSnowflake(90, index % 8),
        channelId: syntheticSnowflake(91, index),
        channelKind: index % 2 === 0 ? 'guildText' : 'guildVoice',
      }
      const physicalRoomId = connections.rooms.observe({ location, observedAt }).physicalRoomId
      const logicalRoomId = connections.rooms.resolve(location, characterId, observedAt).logicalRoomId
      rooms.push({ index, location, physicalRoomId, logicalRoomId })
    }

    const personCount = Math.min(Math.max(4, config.logicalRooms), 128)
    for (let index = 0; index < personCount; index++) {
      const discordUserId = syntheticSnowflake(92, index)
      const displayName = `synthetic-actor-${index}`
      const started = performance.now()
      const observation = connections.identity.observe({
        observationKey: `${runId}-identity-${index}`,
        snapshotId: `${runId}-snapshot-${index}`,
        discordUserId,
        observedAt,
        displayNameAtEvent: displayName,
        sourceEventType: 'gateway',
        completeness: 'user_complete',
        username: displayName,
      })
      metrics.record('identity_observe', performance.now() - started)
      metrics.counters.workload.identityObservations += 1
      people.push({ personId: observation.personId, discordUserId, displayName, ssrc: index + 1 })
    }
    metrics.counters.workload.logicalRoomCount = rooms.length
  }

  function actorFor(person: SyntheticPerson, room: SyntheticRoom, at: string): AttributedActor {
    return attributedActor(person.personId, {
      platform: 'discord',
      platformUserId: person.discordUserId,
      displayNameAtEvent: person.displayName,
      username: person.displayName,
      guildId: room.location.guildId,
      observedAt: asTimestamp(at),
      source: room.location.channelKind === 'guildVoice' ? 'voiceState' : 'gateway',
      ...(room.location.channelKind === 'guildVoice' ? { voiceCharacteristics: { ssrc: person.ssrc } } : {}),
    })
  }

  /**
   * Build one ingress append.
   *
   * The input is returned rather than appended in place so an idempotent retry
   * can replay the byte-identical command; the repository hashes the envelope,
   * so a retry that differed in timestamp or actor would be rejected as key
   * reuse instead of exercising deduplication.
   */
  function buildIngressInput(kind: 'user_text' | 'user_voice', sequence: number, room: SyntheticRoom): AppendEventInput {
    const person = people[Math.floor(random() * people.length)]!
    const at = nowIso()
    return {
      idempotencyKey: asRequestId(`${runId}-${kind}-${sequence}`),
      kind,
      actor: actorFor(person, room, at),
      physicalRoomId: room.physicalRoomId,
      logicalRoomId: room.logicalRoomId,
      occurredAt: asTimestamp(at),
      payload: { content: `synthetic ${kind} ${sequence} in room ${room.index}`, lang: 'en' },
      retentionClass: 'transcript',
    }
  }

  function appendIngressEvent(input: AppendEventInput, room: SyntheticRoom, retry: boolean): void {
    metrics.counters.correctness.attemptedWrites += 1
    const started = performance.now()
    try {
      const result = connections.events.append(input)
      metrics.record(input.kind === 'user_text' ? 'append_text' : 'append_voice', performance.now() - started)
      metrics.counters.correctness.acknowledgedWrites += 1
      lastAcknowledgedWriteAt = nowIso()
      activeRooms.add(room.index)
      if (input.kind === 'user_text')
        metrics.counters.workload.textWrites += 1
      else
        metrics.counters.workload.voiceWrites += 1

      if (retry) {
        metrics.counters.correctness.idempotentRetries += 1
        // A replayed command that produced a second durable effect is exactly
        // the failure idempotency exists to prevent, so it is counted.
        if (!result.deduplicated)
          metrics.counters.correctness.duplicateEffects += 1
      }
      else if (result.deduplicated) {
        metrics.counters.correctness.duplicateEffects += 1
      }
      else {
        remember({ eventId: String(result.envelope.eventId), physicalRoomId: room.physicalRoomId, logicalRoomId: room.logicalRoomId })
      }
    }
    catch (error) {
      metrics.counters.correctness.failedWrites += 1
      log.write('write.failed', { kind: input.kind, code: error instanceof MemoryError ? error.code : 'UNKNOWN', message: shortMessage(error) })
    }
  }

  function runRead(sequence: number): void {
    if (connections.readerEvents.length === 0 || recent.length === 0)
      return
    const slot = sequence % connections.readerEvents.length
    const target = recent[Math.floor(random() * recent.length)]!
    const started = performance.now()
    try {
      if (sequence % 10 === 0) {
        // The package exposes no bounded recent-context read yet — that is
        // MemoryPort work — so a bounded ordered query stands in for it and the
        // report records the substitution as a limitation.
        connections.readers[slot]!
          .prepare('SELECT event_id FROM inbound_event_records WHERE logical_room_id=? ORDER BY room_sequence DESC LIMIT 20')
          .all(target.logicalRoomId)
      }
      else {
        connections.readerEvents[slot]!.get({ physicalRoomId: target.physicalRoomId, logicalRoomId: target.logicalRoomId }, asEventId(target.eventId))
      }
      metrics.record('read', performance.now() - started)
      metrics.counters.workload.reads += 1
    }
    catch (error) {
      log.write('read.failed', { message: shortMessage(error) })
    }
  }

  function enqueueReconciliation(sequence: number): void {
    const at = nowIso()
    const jobId = `${runId}-job-${sequence}`
    const started = performance.now()
    try {
      new UnitOfWork(connections.writer).run(() => {
        connections.queue.enqueue({ jobId, jobType: 'g2_synthetic_reconciliation', dedupeKey: `${runId}-dedupe-${sequence}`, payload: { sequence, synthetic: true }, availableAt: at, createdAt: at, maxAttempts: 3 })
        connections.queue.appendEvidence({ evidenceId: `${runId}-evidence-${sequence}`, jobId, kind: 'observation', evidence: { synthetic: true, sequence }, policyVersion: 'g2-soak', actorId: 'g2-soak-harness', recordedAt: at })
      })
      metrics.record('transaction', performance.now() - started)
      metrics.counters.workload.multiMutationTransactions += 1
    }
    catch (error) {
      metrics.counters.correctness.failedWrites += 1
      log.write('enqueue.failed', { sequence, message: shortMessage(error) })
    }
  }

  function runQueueCycle(worker: number): void {
    const started = performance.now()
    try {
      const job = connections.queue.claim(`g2-claimer-${worker}`, nowIso(), 30_000)
      metrics.record('queue_claim', performance.now() - started)
      if (job?.leaseToken == null)
        return
      metrics.counters.workload.queueClaims += 1
      connections.queue.succeed(job.jobId, job.leaseToken, nowIso())
    }
    catch (error) {
      log.write('queue.failed', { worker, message: shortMessage(error) })
    }
  }

  /**
   * Abandon a multi-mutation transaction on purpose and prove nothing survived.
   *
   * A clean run never rolls back by itself, so without this probe the
   * partial-transaction counter would be vacuously zero.
   */
  function runRollbackProbe(sequence: number): void {
    const at = nowIso()
    const jobId = `${runId}-rollback-${sequence}`
    metrics.counters.workload.rollbackProbes += 1
    try {
      new UnitOfWork(connections.writer).run(() => {
        connections.queue.enqueue({ jobId, jobType: 'g2_rollback_probe', dedupeKey: jobId, payload: { synthetic: true }, availableAt: at, createdAt: at, maxAttempts: 1 })
        throw new MemoryError('POLICY_VIOLATION', 'deliberate rollback probe')
      })
    }
    catch {
      // Expected: the probe always throws so the unit of work rolls back.
    }
    if (connections.queue.get(jobId) != null) {
      metrics.counters.correctness.partialTransactionDetections += 1
      log.write('rollback.residue', { jobId })
    }
  }

  async function runCheckpoint(mode: 'PASSIVE' | 'TRUNCATE'): Promise<void> {
    const walBytesBefore = await fileSize(`${paths.databasePath}-wal`)
    const startedAtCheckpoint = nowIso()
    const started = performance.now()
    let record: CheckpointRecord
    try {
      const result = connections.writer.prepare(`PRAGMA wal_checkpoint(${mode})`).get() as { busy: number, log: number, checkpointed: number }
      const durationMs = performance.now() - started
      metrics.record('checkpoint', durationMs)
      metrics.counters.storage.checkpointCount += 1
      record = { ordinal: checkpoints.length + 1, mode, startedAt: startedAtCheckpoint, completedAt: nowIso(), durationMs, busy: Number(result.busy), walFrames: Number(result.log), checkpointedFrames: Number(result.checkpointed), walBytesBefore, walBytesAfter: await fileSize(`${paths.databasePath}-wal`), failed: false }
    }
    catch (error) {
      // A checkpoint failure is operational evidence, not a reason to abandon
      // the run: a failed checkpoint commits nothing, so correctness is intact.
      const durationMs = performance.now() - started
      metrics.counters.storage.checkpointFailures += 1
      record = { ordinal: checkpoints.length + 1, mode, startedAt: startedAtCheckpoint, completedAt: nowIso(), durationMs, busy: 0, walFrames: 0, checkpointedFrames: 0, walBytesBefore, walBytesAfter: await fileSize(`${paths.databasePath}-wal`), failed: true, failureReason: shortMessage(error) }
    }
    checkpoints.push(record)
    log.write('checkpoint', { ...record })
  }

  async function runBackup(duringLoad: boolean): Promise<void> {
    const ordinal = backups.length + 1
    const backupPath = join(paths.backupsDirectory, `backup-${String(ordinal).padStart(4, '0')}.db`)
    assertDerivedArtifactPath('backup', paths.databasePath, backupPath)
    const acknowledgedWritesAtStart = metrics.counters.correctness.acknowledgedWrites
    const eventRowsAtStart = eventRowCount(connections.writer)
    const startedAtBackup = nowIso()
    const started = performance.now()
    const common = {
      ordinal,
      backupPath,
      manifestPath: `${backupPath}.manifest.json`,
      sourceDatabasePath: paths.databasePath,
      runId,
      repositoryRevision: environment.repositoryRevision,
      startedAt: startedAtBackup,
      acknowledgedWritesAtStart,
      eventRowsAtStart,
      startedUnderLoad: duringLoad,
    }
    let record: BackupRecord
    try {
      const manifest = await createVerifiedBackup(connections.writer, paths.databasePath, backupPath, nowIso())
      const durationMs = performance.now() - started
      metrics.record('backup', durationMs)
      const acknowledgedWritesAtCompletion = metrics.counters.correctness.acknowledgedWrites
      record = {
        ...common,
        sourceSchemaVersion: manifest.schemaVersion,
        completedAt: nowIso(),
        durationMs,
        bytes: manifest.bytes,
        // createVerifiedBackup runs integrity_check, foreign_key_check, and an
        // exact migration-history comparison before publishing, so a returned
        // manifest is itself the verification evidence.
        integrityVerified: true,
        foreignKeysVerified: true,
        migrationChecksumsVerified: true,
        acknowledgedWritesAtCompletion,
        eventRowsAtCompletion: eventRowCount(connections.writer),
        lastAcknowledgedWriteAtCompletion: lastAcknowledgedWriteAt,
        duringActiveWrites: duringLoad && acknowledgedWritesAtCompletion > acknowledgedWritesAtStart,
        failed: false,
      }
      metrics.counters.storage.backupBytes = record.bytes
      log.write('backup', { ...record })
    }
    catch (error) {
      record = {
        ...common,
        sourceSchemaVersion: latestSchemaVersion,
        completedAt: nowIso(),
        durationMs: performance.now() - started,
        bytes: 0,
        integrityVerified: false,
        foreignKeysVerified: false,
        migrationChecksumsVerified: false,
        acknowledgedWritesAtCompletion: metrics.counters.correctness.acknowledgedWrites,
        eventRowsAtCompletion: eventRowCount(connections.writer),
        lastAcknowledgedWriteAtCompletion: lastAcknowledgedWriteAt,
        duringActiveWrites: duringLoad,
        failed: true,
        failureReason: shortMessage(error),
      }
      log.write('backup.failed', { ...record })
    }
    backups.push(record)
  }

  /**
   * Hold the reserved write lock on a second in-process connection and measure
   * what the authoritative writer does about it.
   *
   * Node's SQLite binding is synchronous, so a single-threaded process cannot
   * observe "blocked, then succeeded": the holder cannot release while the
   * writer waits. What this probe does establish is the bounded-contention
   * contract from ADR-003 REQ-OPS-014 — the busy timeout is finite, exhaustion
   * surfaces as a typed failure, and the blocked write persists nothing.
   */
  function runContentionProbe(): void {
    transientWriteCapableConnections += 1
    const holder = openSqliteDatabase(paths.databasePath, { busyTimeoutMs: config.busyTimeoutMs })
    try {
      holder.exec('BEGIN IMMEDIATE')
      const started = performance.now()
      try {
        new UnitOfWork(connections.writer).run(database => database.prepare('UPDATE logical_rooms SET current_version=current_version WHERE logical_room_id=?').run(rooms[0]!.logicalRoomId))
        log.write('contention.probe', { outcome: 'writer-acquired-lock-unexpectedly', waitedMs: performance.now() - started })
      }
      catch (error) {
        const waitedMs = performance.now() - started
        metrics.counters.contention.busyRetries += 1
        metrics.counters.contention.totalBusyWaitMs += waitedMs
        metrics.counters.contention.maximumSingleBusyWaitMs = Math.max(metrics.counters.contention.maximumSingleBusyWaitMs, waitedMs)
        let classification = 'unclassified'
        try {
          classifySqliteFailure(error)
        }
        catch (classified) {
          classification = classified instanceof MemoryError ? String(classified.details?.classification ?? classified.code) : 'unclassified'
        }
        const message = shortMessage(error)
        if (/table is locked/i.test(message))
          metrics.counters.contention.lockedOutcomes += 1
        if (classification === 'SQLITE_BUSY_EXHAUSTED' || /database is locked|database is busy/i.test(message)) {
          metrics.counters.contention.busyOutcomes += 1
          metrics.counters.contention.busyRetryExhaustion += 1
        }
        log.write('contention.probe', { outcome: 'writer-blocked', classification, waitedMs, busyTimeoutMs: config.busyTimeoutMs })
      }
    }
    finally {
      try {
        holder.exec('ROLLBACK')
      }
      catch {
        // The holder never wrote anything, so a failed rollback affects only the probe.
      }
      holder.close()
    }
  }

  function runConnectionReopen(): void {
    const acknowledgedWritesBefore = metrics.counters.correctness.acknowledgedWrites
    const durableRowsBefore = eventRowCount(connections.writer)
    const queueJobsBefore = countOf(connections.writer, 'SELECT count(*) AS value FROM worker_jobs')
    const startedAtRestart = nowIso()
    const started = performance.now()
    const ownership = connections.ownership
    closeConnections(connections, false)
    connections = openConnections(paths, config, ownership)
    const reopenedProfile = captureSqliteProfile(connections.writer, config.busyTimeoutMs)
    const recordsAfterReopen = eventRowCount(connections.writer)
    const queueJobsAfter = countOf(connections.writer, 'SELECT count(*) AS value FROM worker_jobs')
    let integrityVerified = true
    try {
      verifyDatabase(connections.writer)
    }
    catch {
      integrityVerified = false
      metrics.counters.correctness.integrityFailures += 1
    }
    const missingAfterReopen = Math.max(0, durableRowsBefore - recordsAfterReopen)
    metrics.counters.correctness.acknowledgedWritesMissingAfterReopen += missingAfterReopen
    if (queueJobsAfter !== queueJobsBefore)
      metrics.counters.correctness.unexpectedRecordCountDifferences += 1
    const record: RestartRecord = {
      ordinal: restarts.length + 1,
      kind: 'connection reopen',
      startedAt: startedAtRestart,
      completedAt: nowIso(),
      durationMs: performance.now() - started,
      acknowledgedWritesBefore,
      recordsAfterReopen,
      missingAfterReopen,
      queueJobsBefore,
      queueJobsAfter,
      integrityVerified,
      profileValidAfterReopen: reopenedProfile.valid,
    }
    restarts.push(record)
    profileAfterFinalReopen = reopenedProfile
    log.write('restart', { ...record })
  }

  async function runRestoreDrill(): Promise<void> {
    const source = [...backups].reverse().find(record => !record.failed)
    if (source == null)
      return
    const restorePath = join(paths.restoreDirectory, `restored-${String(source.ordinal).padStart(4, '0')}.db`)
    assertDerivedArtifactPath('restore', paths.databasePath, restorePath)
    const startedAtRestore = nowIso()
    const drillStarted = performance.now()
    const failures: string[] = []
    const replayTarget = firstEventId
    let restoreDurationMs = 0
    let replayApplied = false

    try {
      const restoreStarted = performance.now()
      await restoreVerifiedBackup(source.backupPath, restorePath, (database) => {
        if (replayTarget == null)
          return
        // Deletion obligations raised after the snapshot must be re-applied
        // before a candidate may be published (docs/memory/sqlite-backup-restore.md).
        database.exec('BEGIN IMMEDIATE')
        try {
          const at = nowIso()
          database.prepare('UPDATE inbound_event_records SET payload_json=json_object(\'redacted\',json(\'true\')) WHERE event_id=?').run(replayTarget)
          database.prepare('INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,verification_json,idempotency_key) VALUES (?,\'fact_id\',?,\'{}\',?,\'completed\',1,?,\'{}\',?)').run(`${runId}-forget`, replayTarget, at, at, `${runId}-forget`)
          database.prepare('INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,verified_at,evidence_json) VALUES (?,?,\'inbound_event_records\',?,\'verified\',?,?,\'{}\')').run(`${runId}-tombstone`, `${runId}-forget`, replayTarget, at, at)
          database.exec('COMMIT')
          replayApplied = true
        }
        catch (error) {
          database.exec('ROLLBACK')
          throw error
        }
      })
      restoreDurationMs = performance.now() - restoreStarted
      metrics.record('restore', restoreDurationMs)
    }
    catch (error) {
      failures.push(`restore failed: ${shortMessage(error)}`)
    }

    let restoredEventCount = 0
    let integrityVerified = false
    let foreignKeysVerified = false
    let schemaVersionVerified = false
    let migrationChecksumsVerified = false
    let checkpointPerformed = false
    if (failures.length === 0) {
      const candidate = openSqliteDatabase(restorePath, { busyTimeoutMs: config.busyTimeoutMs })
      try {
        const candidateProfile = captureSqliteProfile(candidate, config.busyTimeoutMs)
        schemaVersionVerified = candidateProfile.schemaVersion > 0 && candidateProfile.migrationVersions.length === candidateProfile.expectedMigrationVersions.length
        migrationChecksumsVerified = candidateProfile.migrationChecksumsMatch
        try {
          verifyDatabase(candidate)
          integrityVerified = true
          foreignKeysVerified = true
        }
        catch (error) {
          metrics.counters.correctness.integrityFailures += 1
          failures.push(`candidate verification failed: ${shortMessage(error)}`)
        }
        restoredEventCount = eventRowCount(candidate)
        if (replayTarget != null && countOf(candidate, 'SELECT count(*) AS value FROM deletion_tombstones WHERE target_id=?', replayTarget) !== 1)
          failures.push('deletion-obligation replay evidence is missing from the restored candidate')
        candidate.exec('PRAGMA wal_checkpoint(TRUNCATE)')
        checkpointPerformed = true
      }
      finally {
        candidate.close()
      }
    }

    const recordCountsVerified = restoredEventCount >= source.eventRowsAtStart && restoredEventCount <= source.eventRowsAtCompletion
    if (!recordCountsVerified) {
      metrics.counters.correctness.unexpectedRecordCountDifferences += 1
      failures.push(`restored event count ${restoredEventCount} is outside the backup window ${source.eventRowsAtStart}–${source.eventRowsAtCompletion}`)
    }
    const totalRecoveryDurationMs = performance.now() - drillStarted
    const lastAcknowledged = lastAcknowledgedWriteAt == null ? null : Date.parse(lastAcknowledgedWriteAt)
    metrics.counters.storage.restoredDatabaseBytes = await fileSize(restorePath)

    drill.restore = {
      backupOrdinal: source.ordinal,
      backupPath: source.backupPath,
      restorePath,
      startedAt: startedAtRestore,
      completedAt: nowIso(),
      restoreDurationMs,
      totalRecoveryDurationMs,
      restoredBytes: metrics.counters.storage.restoredDatabaseBytes,
      integrityVerified,
      foreignKeysVerified,
      schemaVersionVerified,
      migrationChecksumsVerified,
      recordCountsVerified,
      restoredEventCount,
      expectedEventCountLowerBound: source.eventRowsAtStart,
      expectedEventCountUpperBound: source.eventRowsAtCompletion,
      deletionObligationReplay: replayApplied ? 'applied' : 'unavailable',
      deletionObligationNote: replayApplied
        ? 'A synthetic forget request, tombstone, and payload redaction were replayed into the candidate before publication and verified afterwards. Derived-store deletion closure remains IMP-702/IMP-703.'
        : 'No acknowledged event was available to replay a deletion obligation against.',
      checkpointPerformed,
      achievedRpoMs: lastAcknowledged == null ? null : Math.max(0, lastAcknowledged - Date.parse(source.completedAt)),
      achievedRtoMs: totalRecoveryDurationMs,
      rpoDefinition: 'Wall-clock interval between completion of the restored backup and the last acknowledged write before the drill began: the data-loss window this drill demonstrates for a failure at drill time.',
      rtoDefinition: 'Monotonic interval from the start of the drill to a verified, deletion-obligation-replayed, checkpointed candidate opened through the production-representative connection profile.',
      valid: failures.length === 0 && integrityVerified && foreignKeysVerified && schemaVersionVerified && migrationChecksumsVerified && recordCountsVerified,
      failures: Object.freeze(failures),
    }
    log.write('restore', { ...drill.restore })
  }

  async function runSecondWriterProbe(): Promise<void> {
    const fixture = new URL('../fixtures/writer-ownership-child.ts', import.meta.url)
    const outcome = await new Promise<{ result: SecondWriterProbeResult, detail: string }>((resolve) => {
      const child = fork(fixture, ['try-acquire', paths.databasePath, String(config.busyTimeoutMs)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
      let reported = false
      child.once('message', (message) => {
        reported = true
        const payload = message as { type: string, classification?: string, errorName?: string, code?: string, acquisitionTimeoutMs?: number, refusalLatencyMs?: number }
        const result: SecondWriterProbeResult = payload.type === 'acquired'
          ? 'unexpectedly-succeeded'
          : payload.type === 'refused' && payload.classification === 'SQLITE_WRITER_OWNERSHIP_UNAVAILABLE' ? 'expected-ownership-refusal' : 'probe-infrastructure-failure'
        if (result === 'expected-ownership-refusal')
          secondWriterRefusalLatencyMs = payload.refusalLatencyMs ?? null
        resolve({ result, detail: payload.type === 'refused' ? `${payload.classification}; typed ${payload.errorName}/${payload.code}; timeout ${payload.acquisitionTimeoutMs} ms` : 'the second process unexpectedly acquired guarded authoritative ownership' })
      })
      child.once('error', error => resolve({ result: 'probe-infrastructure-failure', detail: `probe process failed to start: ${error.message}` }))
      child.once('exit', () => {
        if (!reported)
          resolve({ result: 'probe-infrastructure-failure', detail: 'probe process exited without reporting an outcome' })
      })
    })
    secondWriterProbe = outcome.result
    secondWriterProbeDetail = outcome.detail
    if (outcome.result !== 'expected-ownership-refusal')
      secondWriterRefusalLatencyMs = null
    log.write('second-writer.probe', { ...outcome })
  }

  const runStarted = performance.now()
  try {
    seedWorkload()
    log.write('workload.seeded', { rooms: rooms.length, people: people.length })

    const readRate = config.readerConcurrency * 2
    let pendingText = 0
    let pendingVoice = 0
    let pendingReads = 0
    let textSequence = 0
    let voiceSequence = 0
    let readSequence = 0
    let lastTick = performance.now()
    let nextCheckpointAt = config.checkpointIntervalSeconds
    let nextBackupAt = config.backupIntervalSeconds
    let nextRestartAt = config.restartIntervalSeconds
    let nextContentionProbeAt = config.contentionProbeIntervalSeconds
    let nextWalSampleAt = 1
    let nextQueueCycleAt = 1
    let nextProgressAt = 5
    let activeBackup: Promise<void> | null = null

    for (;;) {
      const elapsedSeconds = (performance.now() - runStarted) / 1000
      if (interrupted || elapsedSeconds >= config.durationSeconds)
        break

      const tickNow = performance.now()
      const deltaSeconds = (tickNow - lastTick) / 1000
      lastTick = tickNow
      pendingText += deltaSeconds * config.textWriteRate
      pendingVoice += deltaSeconds * config.voiceWriteRate
      pendingReads += deltaSeconds * readRate

      let budget = maximumWritesPerTick
      while (pendingText >= 1 && budget > 0) {
        pendingText -= 1
        budget -= 1
        textSequence += 1
        const room = rooms[Math.floor(random() * rooms.length)]!
        const input = buildIngressInput('user_text', textSequence, room)
        appendIngressEvent(input, room, false)
        // Bursts concentrate several appends on one room: the shape a busy
        // Discord channel produces and the one that stresses per-room sequence
        // allocation inside a single logical room.
        if (random() < 0.08) {
          metrics.counters.workload.burstCount += 1
          const burst = 2 + Math.floor(random() * 5)
          for (let index = 0; index < burst && budget > 0; index++) {
            budget -= 1
            textSequence += 1
            appendIngressEvent(buildIngressInput('user_text', textSequence, room), room, false)
          }
        }
        if (textSequence % 17 === 0)
          appendIngressEvent(input, room, true)
        if (textSequence % 5 === 0)
          enqueueReconciliation(textSequence)
        if (textSequence % 211 === 0)
          runRollbackProbe(textSequence)
      }
      while (pendingVoice >= 1 && budget > 0) {
        pendingVoice -= 1
        budget -= 1
        voiceSequence += 1
        const room = rooms[Math.floor(random() * rooms.length)]!
        appendIngressEvent(buildIngressInput('user_voice', voiceSequence, room), room, false)
      }
      while (pendingReads >= 1 && budget > 0) {
        pendingReads -= 1
        budget -= 1
        readSequence += 1
        runRead(readSequence)
      }
      metrics.counters.contention.maximumWriterQueueDepth = Math.max(metrics.counters.contention.maximumWriterQueueDepth, Math.floor(pendingText + pendingVoice))

      if (elapsedSeconds >= nextQueueCycleAt) {
        nextQueueCycleAt = elapsedSeconds + 1
        for (let worker = 0; worker < config.queueClaimers; worker++)
          runQueueCycle(worker)
      }
      if (elapsedSeconds >= nextWalSampleAt) {
        nextWalSampleAt = elapsedSeconds + 1
        metrics.counters.storage.maximumWalBytes = Math.max(metrics.counters.storage.maximumWalBytes, await fileSize(`${paths.databasePath}-wal`))
      }
      if (elapsedSeconds >= nextCheckpointAt) {
        nextCheckpointAt += config.checkpointIntervalSeconds
        await runCheckpoint('PASSIVE')
      }
      if (elapsedSeconds >= nextBackupAt && activeBackup == null) {
        nextBackupAt += config.backupIntervalSeconds
        // Deliberately not awaited: the online backup copies pages while the
        // workload keeps writing, which is what makes the artifact evidence of
        // a backup taken under load rather than at a quiet point. runBackup
        // records its own failures, so the catch here only guards the path
        // assertions that run before its try block.
        activeBackup = runBackup(true)
          .catch((error: unknown) => {
            log.write('backup.rejected', { message: shortMessage(error) })
          })
          .finally(() => {
            activeBackup = null
          })
      }
      if (elapsedSeconds >= nextContentionProbeAt) {
        nextContentionProbeAt += config.contentionProbeIntervalSeconds
        if (activeBackup != null)
          await activeBackup
        runContentionProbe()
      }
      if (elapsedSeconds >= nextRestartAt) {
        nextRestartAt += config.restartIntervalSeconds
        if (activeBackup != null)
          await activeBackup
        runConnectionReopen()
      }
      if (elapsedSeconds >= nextProgressAt) {
        nextProgressAt += 5
        log.write('progress', { elapsedSeconds: Number(elapsedSeconds.toFixed(3)), acknowledgedWrites: metrics.counters.correctness.acknowledgedWrites, failedWrites: metrics.counters.correctness.failedWrites, reads: metrics.counters.workload.reads, queueClaims: metrics.counters.workload.queueClaims, maximumWalBytes: metrics.counters.storage.maximumWalBytes })
      }

      await sleep(tickIntervalMs)
    }

    if (activeBackup != null)
      await activeBackup
    metrics.counters.workload.runDurationSeconds = (performance.now() - runStarted) / 1000

    // Shutdown order follows docs/memory/sqlite-backup-restore.md: quiesce,
    // checkpoint, take the final verified snapshot, prove the authority reopens
    // through the production-representative profile, then drill the restore.
    await runCheckpoint('TRUNCATE')
    await runBackup(false)
    runConnectionReopen()
    await runRestoreDrill()
    if (config.secondWriterProbe)
      await runSecondWriterProbe()
  }
  catch (error) {
    failureReason = shortMessage(error)
    log.write('run.failed', { message: failureReason })
  }
  finally {
    if (metrics.counters.workload.runDurationSeconds === 0)
      metrics.counters.workload.runDurationSeconds = (performance.now() - runStarted) / 1000
    metrics.counters.storage.databaseBytes = await fileSize(paths.databasePath)
    metrics.counters.storage.finalWalBytes = await fileSize(`${paths.databasePath}-wal`)
    metrics.counters.workload.activeRoomCount = activeRooms.size
    const operations = metrics.counters.correctness.acknowledgedWrites + metrics.counters.workload.reads + metrics.counters.workload.queueClaims
    metrics.counters.workload.operationsPerSecond = metrics.counters.workload.runDurationSeconds === 0 ? 0 : operations / metrics.counters.workload.runDurationSeconds

    const writerOwnershipHeldDuringRun = connections.ownership.held
    closeConnections(connections)

    const latency = metrics.latency()
    const thresholdReport = evaluateThresholds(thresholds, observedMetricValues(latency, metrics.counters, { achievedRpoMs: drill.restore?.achievedRpoMs ?? null, achievedRtoMs: drill.restore?.achievedRtoMs ?? null }))
    const correctness = metrics.counters.correctness
    const correctnessBreached = correctness.acknowledgedWritesMissingAfterReopen > 0 || correctness.duplicateEffects > 0 || correctness.partialTransactionDetections > 0 || correctness.integrityFailures > 0 || correctness.foreignKeyFailures > 0 || correctness.migrationChecksumFailures > 0 || correctness.unexpectedRecordCountDifferences > 0

    let status: G2RunStatus = 'completed'
    if (failureReason != null)
      status = 'failed'
    else if (interrupted)
      status = 'interrupted'
    else if (!profile.valid || correctnessBreached || drill.restore == null || !drill.restore.valid)
      status = 'invalid'

    const evidence: G2RunEvidence = {
      runId,
      status,
      startedAt,
      completedAt: nowIso(),
      interrupted,
      failureReason,
      configuration: config,
      requestedConfiguration: resolved.requested,
      environment,
      profile,
      profileAfterFinalReopen,
      topology: {
        authoritativeProcesses: 1,
        writeCapableConnections: 1,
        transientWriteCapableConnections,
        readerConnections: config.readerConcurrency,
        processId: process.pid,
        parentProcessId: process.ppid,
        writeSerialization: 'One guarded authoritative process and one write-capable authority connection. The bounded contention probe alone deliberately uses the low-level unguarded opener to test SQLite busy-timeout behavior.',
        writerOwnershipGuardVersion: sqliteWriterOwnershipGuardVersion,
        firstWriterHeldOwnership: writerOwnershipHeldDuringRun,
        ownershipAcquisitionTimeoutMs: config.busyTimeoutMs,
        secondWriterRefusalLatencyMs,
        firstOwnerRemainedOperational: secondWriterRefusalLatencyMs == null ? null : true,
        cleanReleaseResult: 'connection reopen retained the same live ownership; focused cross-process tests cover clean release and reacquisition',
        crashRecoveryResult: config.secondWriterProbe ? 'covered by the focused forced-termination cross-process test; not repeated inside this workload process' : 'not-tested',
        intentionallyUnguardedConnections: 'Read-only connections do not claim ownership. Backup verification and restore candidates are isolated artifacts. The transient contention holder is intentionally unguarded to measure SQLite lock exhaustion.',
        secondWriterProbe,
        secondWriterProbeDetail,
      },
      counters: metrics.counters,
      latency,
      checkpoints,
      backups,
      restore: drill.restore,
      restarts,
      thresholds: thresholdReport,
      paths: { databasePath: paths.databasePath, runOutputDirectory: paths.runOutputDirectory, backupsDirectory: paths.backupsDirectory, restoreDirectory: paths.restoreDirectory },
    }

    const summary = buildRunSummary(evidence)
    await writeFile(join(paths.runOutputDirectory, 'metrics.json'), `${JSON.stringify({ runId, counters: metrics.counters, latency, checkpoints, backups, restore: drill.restore, restarts, thresholds: thresholdReport }, null, 2)}\n`, 'utf8')
    await writeFile(join(paths.runOutputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8')
    await writeFile(join(paths.runOutputDirectory, 'g2-soak-report.md'), renderMarkdownReport(evidence, summary), 'utf8')
    log.write('run.end', { status, validForOperatorReview: summary.validForOperatorReview })
    await log.close()

    console.info(`\nRun ${runId} finished with status ${status}.`)
    console.info(`Evidence: ${paths.runOutputDirectory}`)
    console.info(`Valid for operator review: ${summary.validForOperatorReview}`)
    console.info(nonApprovalStatement)
    process.exitCode = status === 'completed' ? 0 : status === 'interrupted' ? 130 : 1
  }
}

main().catch((error: unknown) => {
  // Startup refusals (missing paths, unsafe directories, malformed thresholds)
  // land here before any run directory exists, so there is nothing to flush.
  console.error(`G2 operational soak did not start: ${shortMessage(error)}`)
  process.exitCode = 1
})
