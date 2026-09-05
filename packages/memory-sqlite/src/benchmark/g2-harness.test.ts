import type { G2Configuration } from './g2-config.js'
import type { G2RunEvidence, G2RunStatus } from './g2-report.js'

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { openSqliteDatabase } from '../connection-profile.js'
import { migrations } from '../migrations/index.js'
import { resolveG2Configuration } from './g2-config.js'
import { captureSqliteProfile } from './g2-environment.js'
import { latencyCategories, LatencySeries, MetricsCollector, percentileOf } from './g2-metrics.js'
import { assertDerivedArtifactPath, assertOutsideRepositoryCheckout, assertSyntheticDirectory, createRunId, createRunPaths, findRepositoryRoot, readSyntheticDirectoryMarker, resolveOperatorDirectory, syntheticDirectoryMarkerFilename, writeSyntheticDirectoryMarker } from './g2-path-safety.js'
import { buildRunSummary, nonApprovalStatement, renderMarkdownReport } from './g2-report.js'
import { evaluateThresholds, parseThresholdDocument } from './g2-thresholds.js'

// Temporary directories are used only by these automated tests. The operational
// harness rejects them, which is itself asserted below.
const roots: string[] = []
async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dc-bot-g2-'))
  roots.push(value)
  return value
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

const deploymentDatabaseDirectory = join(homedir(), 'dc-bot-g2-authority')
const deploymentOutputDirectory = join(homedir(), 'dc-bot-g2-evidence')
const baseEnvironment = { G2_DATABASE_DIRECTORY: deploymentDatabaseDirectory, G2_OUTPUT_DIRECTORY: deploymentOutputDirectory }

function configurationFixture(): G2Configuration {
  return resolveG2Configuration({ ...baseEnvironment, G2_DURATION_SECONDS: '30', G2_CHECKPOINT_INTERVAL_SECONDS: '5', G2_BACKUP_INTERVAL_SECONDS: '10' }).configuration
}

function evidenceFixture(status: G2RunStatus, overrides: Partial<G2RunEvidence> = {}): G2RunEvidence {
  const configuration = configurationFixture()
  const metrics = new MetricsCollector(configuration.latencySampleCapacity, configuration.seed)
  metrics.record('append_text', 1.5)
  metrics.counters.correctness.attemptedWrites = 10
  metrics.counters.correctness.acknowledgedWrites = 10
  metrics.counters.workload.runDurationSeconds = 30
  metrics.counters.workload.operationsPerSecond = 0.33
  const profile = { foreignKeys: 1, journalMode: 'wal', synchronous: 2, busyTimeoutMs: configuration.busyTimeoutMs, schemaVersion: 7, walAutocheckpointPages: 1000, migrationVersions: migrations.map(item => item.version), expectedMigrationVersions: migrations.map(item => item.version), migrationChecksumsMatch: true, valid: true, violations: [] }
  return {
    runId: 'g2-20260802T000000Z-abcdef12',
    status,
    startedAt: '2026-08-02T00:00:00.000Z',
    completedAt: '2026-08-02T00:00:30.000Z',
    interrupted: status === 'interrupted',
    failureReason: null,
    configuration,
    requestedConfiguration: [{ variable: 'G2_DURATION_SECONDS', requested: '30', effective: '30', source: 'environment' }],
    environment: { nodeVersion: 'v24.0.0', platform: 'win32', osRelease: '10.0.0', architecture: 'x64', hostname: 'synthetic-host', cpuCount: 8, cpuModel: 'synthetic', totalMemoryBytes: 1024, sqliteVersion: '3.51.2', packageName: '@proj-airi/memory-sqlite', packageVersion: '0.0.0', repositoryRevision: 'abc123', repositoryDirty: false, processId: 1, parentProcessId: 0, databasePath: join(deploymentDatabaseDirectory, 'run.db'), databaseVolumeRoot: 'C:\\', storageLocalityVerification: 'unknown', storageAttestation: null, storageLocalityNote: 'note' },
    profile,
    profileAfterFinalReopen: profile,
    topology: { authoritativeProcesses: 1, writeCapableConnections: 1, transientWriteCapableConnections: 1, readerConnections: 3, processId: 1, parentProcessId: 0, writeSerialization: 'single connection', writerOwnershipGuardVersion: 1, firstWriterHeldOwnership: true, ownershipAcquisitionTimeoutMs: 250, secondWriterRefusalLatencyMs: null, firstOwnerRemainedOperational: null, cleanReleaseResult: 'tested', crashRecoveryResult: 'not-tested', intentionallyUnguardedConnections: 'read-only and probes', secondWriterProbe: 'not-tested', secondWriterProbeDetail: 'opt-in' },
    counters: metrics.counters,
    latency: metrics.latency(),
    checkpoints: [{ ordinal: 1, mode: 'TRUNCATE', startedAt: '2026-08-02T00:00:20.000Z', completedAt: '2026-08-02T00:00:20.010Z', durationMs: 10, busy: 0, walFrames: 12, checkpointedFrames: 12, walBytesBefore: 4096, walBytesAfter: 0, failed: false }],
    backups: [{ ordinal: 1, backupPath: join(deploymentOutputDirectory, 'backups', 'backup-0001.db'), manifestPath: 'manifest', sourceDatabasePath: join(deploymentDatabaseDirectory, 'run.db'), runId: 'g2-20260802T000000Z-abcdef12', repositoryRevision: 'abc123', sourceSchemaVersion: 7, startedAt: '2026-08-02T00:00:10.000Z', completedAt: '2026-08-02T00:00:11.000Z', durationMs: 1000, bytes: 4096, integrityVerified: true, foreignKeysVerified: true, migrationChecksumsVerified: true, acknowledgedWritesAtStart: 4, acknowledgedWritesAtCompletion: 8, eventRowsAtStart: 4, eventRowsAtCompletion: 8, lastAcknowledgedWriteAtCompletion: '2026-08-02T00:00:11.000Z', startedUnderLoad: true, duringActiveWrites: true, failed: false }],
    restore: { backupOrdinal: 1, backupPath: 'backup', restorePath: 'restore', startedAt: '2026-08-02T00:00:25.000Z', completedAt: '2026-08-02T00:00:26.000Z', restoreDurationMs: 500, totalRecoveryDurationMs: 1000, restoredBytes: 4096, integrityVerified: true, foreignKeysVerified: true, schemaVersionVerified: true, migrationChecksumsVerified: true, recordCountsVerified: true, restoredEventCount: 6, expectedEventCountLowerBound: 4, expectedEventCountUpperBound: 8, deletionObligationReplay: 'applied', deletionObligationNote: 'replayed', checkpointPerformed: true, achievedRpoMs: 19000, achievedRtoMs: 1000, rpoDefinition: 'rpo', rtoDefinition: 'rto', valid: true, failures: [] },
    restarts: [{ ordinal: 1, kind: 'connection reopen', startedAt: '2026-08-02T00:00:22.000Z', completedAt: '2026-08-02T00:00:22.100Z', durationMs: 100, acknowledgedWritesBefore: 10, recordsAfterReopen: 10, missingAfterReopen: 0, queueJobsBefore: 2, queueJobsAfter: 2, integrityVerified: true, profileValidAfterReopen: true }],
    thresholds: evaluateThresholds(undefined, new Map([['append.p95Ms', 1.5]])),
    paths: { databasePath: join(deploymentDatabaseDirectory, 'run.db'), runOutputDirectory: deploymentOutputDirectory, backupsDirectory: join(deploymentOutputDirectory, 'backups'), restoreDirectory: join(deploymentOutputDirectory, 'restore') },
    ...overrides,
  }
}

describe('g2 configuration resolution', () => {
  it('resolves absolute paths, applies documented defaults, and records requested provenance', () => {
    const { configuration, requested } = resolveG2Configuration({ ...baseEnvironment, G2_DURATION_SECONDS: '600', G2_SEED: '7', G2_LOGICAL_ROOMS: '12' })
    expect(configuration.databaseDirectory).toBe(deploymentDatabaseDirectory)
    expect(configuration.outputDirectory).toBe(deploymentOutputDirectory)
    expect(configuration.durationSeconds).toBe(600)
    expect(configuration.seed).toBe(7)
    expect(configuration.logicalRooms).toBe(12)
    expect(configuration.busyTimeoutMs).toBe(250)
    expect(configuration.secondWriterProbe).toBe(false)
    expect(configuration.thresholdsFile).toBeUndefined()
    expect(requested.find(entry => entry.variable === 'G2_SEED')).toMatchObject({ requested: '7', effective: '7', source: 'environment' })
    expect(requested.find(entry => entry.variable === 'G2_LOGICAL_ROOMS')).toMatchObject({ source: 'environment' })
    expect(requested.find(entry => entry.variable === 'G2_READER_CONCURRENCY')).toMatchObject({ requested: undefined, source: 'default' })
  })

  it('requires both directories explicitly and rejects relative-only, network, and root paths', () => {
    expect(() => resolveG2Configuration({ G2_OUTPUT_DIRECTORY: deploymentOutputDirectory })).toThrow(/G2_DATABASE_DIRECTORY must be set/)
    expect(() => resolveG2Configuration({ G2_DATABASE_DIRECTORY: deploymentDatabaseDirectory })).toThrow(/G2_OUTPUT_DIRECTORY must be set/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_DATABASE_DIRECTORY: '   ' })).toThrow(/must be set/)
    expect(() => resolveOperatorDirectory('G2_DATABASE_DIRECTORY', '\\\\fileserver\\memory')).toThrow(/network share/)
    expect(() => resolveOperatorDirectory('G2_DATABASE_DIRECTORY', '//fileserver/memory')).toThrow(/network share/)
  })

  it('refuses the operating-system temporary directory for either path', () => {
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_DATABASE_DIRECTORY: join(tmpdir(), 'soak') })).toThrow(/temporary directory/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_OUTPUT_DIRECTORY: join(tmpdir(), 'evidence') })).toThrow(/temporary directory/)
  })

  it('requires the authority and evidence directories to be separate', () => {
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_OUTPUT_DIRECTORY: deploymentDatabaseDirectory })).toThrow(/must be separate directories/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_OUTPUT_DIRECTORY: join(deploymentDatabaseDirectory, 'evidence') })).toThrow(/must be separate directories/)
  })

  it('rejects zero, negative, fractional, non-finite, and out-of-range numeric settings', () => {
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_DURATION_SECONDS: '0' })).toThrow(/G2_DURATION_SECONDS must be an integer from 5/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_DURATION_SECONDS: '-30' })).toThrow(/must be an integer/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_SEED: '1.5' })).toThrow(/G2_SEED must be an integer/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_LOGICAL_ROOMS: 'many' })).toThrow(/G2_LOGICAL_ROOMS must be an integer/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_TEXT_WRITE_RATE: 'Infinity' })).toThrow(/must be a finite rate/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_TEXT_WRITE_RATE: '-1' })).toThrow(/must be a finite rate/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_BUSY_TIMEOUT_MS: '0' })).toThrow(/G2_BUSY_TIMEOUT_MS must be an integer from 1/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_READER_CONCURRENCY: '999' })).toThrow(/must be an integer from 0 through 64/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_TEXT_WRITE_RATE: '0', G2_VOICE_WRITE_RATE: '0' })).toThrow(/at least one of/)
  })

  it('refuses a run whose checkpoint or backup interval could never fire under load', () => {
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_DURATION_SECONDS: '30', G2_CHECKPOINT_INTERVAL_SECONDS: '31' })).toThrow(/checkpoints must be exercised during load/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_DURATION_SECONDS: '30', G2_CHECKPOINT_INTERVAL_SECONDS: '5', G2_BACKUP_INTERVAL_SECONDS: '31' })).toThrow(/at least one online backup/)
  })

  it('arms the second-writer probe only for the exact opt-in token', () => {
    expect(resolveG2Configuration({ ...baseEnvironment, G2_SECOND_WRITER_PROBE: 'enabled' }).configuration.secondWriterProbe).toBe(true)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_SECOND_WRITER_PROBE: 'true' })).toThrow(/must be unset or exactly/)
    expect(() => resolveG2Configuration({ ...baseEnvironment, G2_SECOND_WRITER_PROBE: '1' })).toThrow(/must be unset or exactly/)
  })
})

describe('g2 path safety', () => {
  it('admits absent, empty, and previously marked directories only', async () => {
    const directory = await root()
    expect(await assertSyntheticDirectory(join(directory, 'missing'), 'database-authority')).toBe('absent')
    expect(await assertSyntheticDirectory(directory, 'database-authority')).toBe('empty')
    const marker = await writeSyntheticDirectoryMarker(directory, 'database-authority', '2026-08-02T00:00:00.000Z')
    expect(marker).toMatchObject({ format: 1, purpose: 'DC_BOT G2 synthetic operational soak', syntheticDataOnly: true, role: 'database-authority' })
    expect(await assertSyntheticDirectory(directory, 'database-authority')).toBe('marked')
    await expect(assertSyntheticDirectory(directory, 'evidence-output')).rejects.toThrow(/must not be reused/)
  })

  it('refuses a directory holding an unrelated database and offers no override', async () => {
    const directory = await root()
    await writeFile(join(directory, 'memory.db'), 'not really a database', 'utf8')
    await expect(assertSyntheticDirectory(directory, 'database-authority')).rejects.toThrow(/may be a real database/)
    await expect(assertSyntheticDirectory(directory, 'database-authority')).rejects.toThrow(/no override/)
  })

  it('refuses any unmarked non-empty directory, and a marker that does not declare synthetic data', async () => {
    const directory = await root()
    await writeFile(join(directory, 'notes.txt'), 'operator notes', 'utf8')
    await expect(assertSyntheticDirectory(directory, 'evidence-output')).rejects.toThrow(/carries no G2 synthetic-run marker/)
    await writeFile(join(directory, syntheticDirectoryMarkerFilename), JSON.stringify({ format: 1, purpose: 'something else', syntheticDataOnly: false }), 'utf8')
    expect(await readSyntheticDirectoryMarker(directory)).toBeUndefined()
    await expect(assertSyntheticDirectory(directory, 'evidence-output')).rejects.toThrow(/carries no G2 synthetic-run marker/)
  })

  it('refuses run data anywhere inside an enclosing checkout, including past a nested .git', async () => {
    // ROOT CAUSE:
    //
    // The first implementation returned the *nearest* ancestor holding `.git`.
    // This monorepo carries a leftover `airi/.git`, so a database directory at
    // the repository root but outside `airi/` was accepted and created.
    //
    // Walking to the outermost enclosing checkout closes that gap: every inner
    // root is contained by the outermost one.
    const outer = await root()
    await mkdir(join(outer, '.git'), { recursive: true })
    await mkdir(join(outer, 'nested', '.git'), { recursive: true })
    await mkdir(join(outer, 'nested', 'package', 'src'), { recursive: true })
    const searchFrom = join(outer, 'nested', 'package', 'src')

    expect(await findRepositoryRoot(searchFrom)).toBe(outer)
    await expect(assertOutsideRepositoryCheckout('G2_DATABASE_DIRECTORY', join(outer, 'runs'), searchFrom)).rejects.toThrow(/must not live inside the repository checkout/)
    await expect(assertOutsideRepositoryCheckout('G2_DATABASE_DIRECTORY', join(outer, 'nested', 'runs'), searchFrom)).rejects.toThrow(/must not live inside the repository checkout/)
    await expect(assertOutsideRepositoryCheckout('G2_DATABASE_DIRECTORY', deploymentDatabaseDirectory, searchFrom)).resolves.toBeUndefined()
  })

  it('derives run-scoped paths that never collide with the authority', () => {
    const runId = createRunId(new Date('2026-08-02T03:04:05.678Z'))
    expect(runId).toMatch(/^g2-20260802T030405Z-[0-9a-f]{8}$/)
    const paths = createRunPaths({ databaseDirectory: deploymentDatabaseDirectory, outputDirectory: deploymentOutputDirectory }, runId)
    expect(paths.databasePath).toBe(join(deploymentDatabaseDirectory, `${runId}.db`))
    expect(paths.runOutputDirectory).toBe(join(deploymentOutputDirectory, runId))
    expect(paths.backupsDirectory).toBe(join(paths.runOutputDirectory, 'backups'))
    expect(paths.restoreDirectory).toBe(join(paths.runOutputDirectory, 'restore'))
    expect(paths.runManifestPath).toBe(join(paths.runOutputDirectory, 'run-manifest.json'))
    expect(paths.eventsPath).toBe(join(paths.runOutputDirectory, 'events.jsonl'))
  })

  it('keeps backup and restore destinations outside the authority directory', () => {
    const databasePath = join(deploymentDatabaseDirectory, 'run.db')
    expect(() => assertDerivedArtifactPath('backup', databasePath, databasePath)).toThrow(/must differ from the authority/)
    expect(() => assertDerivedArtifactPath('backup', databasePath, join(deploymentDatabaseDirectory, 'backup.db'))).toThrow(/outside the authority database directory/)
    expect(() => assertDerivedArtifactPath('restore', databasePath, join(deploymentDatabaseDirectory, 'restored.db'))).toThrow(/outside the authority database directory/)
    expect(() => assertDerivedArtifactPath('backup', databasePath, join(deploymentOutputDirectory, 'backups', 'backup-0001.db'))).not.toThrow()
    expect(() => assertDerivedArtifactPath('restore', databasePath, join(deploymentOutputDirectory, 'restore', 'restored-0001.db'))).not.toThrow()
  })
})

describe('g2 metrics', () => {
  it('computes nearest-rank percentiles so every reported value is an observation', () => {
    const ascending = Array.from({ length: 10 }, (_, index) => index + 1)
    expect(percentileOf(ascending, 0.5)).toBe(5)
    expect(percentileOf(ascending, 0.95)).toBe(10)
    expect(percentileOf(ascending, 0.99)).toBe(10)
    expect(percentileOf([], 0.95)).toBeNull()
    expect(percentileOf([42], 0.5)).toBe(42)
  })

  it('reports exact statistics while every sample is retained', () => {
    const series = new LatencySeries(1000, () => 0.5)
    for (let value = 1; value <= 100; value++)
      series.record(value)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(100)
    expect(snapshot.min).toBe(1)
    expect(snapshot.max).toBe(100)
    expect(snapshot.mean).toBe(50.5)
    expect(snapshot.p50).toBe(50)
    expect(snapshot.p95).toBe(95)
    expect(snapshot.p99).toBe(99)
    expect(snapshot.method).toBe('exact-nearest-rank')
    expect(snapshot.retainedSamples).toBe(100)
  })

  it('switches to a bounded reservoir past capacity while keeping exact count, min, max, and mean', () => {
    const series = new LatencySeries(10, () => 0.5)
    for (let value = 1; value <= 100; value++)
      series.record(value)
    const snapshot = series.snapshot()
    expect(snapshot.count).toBe(100)
    expect(snapshot.min).toBe(1)
    expect(snapshot.max).toBe(100)
    expect(snapshot.mean).toBe(50.5)
    expect(snapshot.retainedSamples).toBe(10)
    expect(snapshot.method).toBe('reservoir-nearest-rank')
    expect(series.snapshot().p95).not.toBeNull()
  })

  it('ignores negative and non-finite observations and starts every category empty', () => {
    const collector = new MetricsCollector(1000, 1)
    collector.record('append_text', Number.NaN)
    collector.record('append_text', -1)
    const latency = collector.latency()
    expect(Object.keys(latency)).toEqual([...latencyCategories])
    expect(latency.append_text.count).toBe(0)
    expect(latency.append_text.p95).toBeNull()
    expect(collector.counters.correctness.acknowledgedWrites).toBe(0)
  })
})

describe('g2 thresholds', () => {
  it('rejects a threshold document without provenance or with a malformed limit', () => {
    expect(() => parseThresholdDocument({ format: 2 })).toThrow(/"format": 1/)
    expect(() => parseThresholdDocument({ format: 1, approvedAt: '2026-08-02T00:00:00.000Z', source: 'soak', thresholds: [] })).toThrow(/non-empty approvedBy/)
    expect(() => parseThresholdDocument({ format: 1, approvedBy: 'ops', approvedAt: 'yesterday', source: 'soak', thresholds: [] })).toThrow(/ISO timestamp/)
    expect(() => parseThresholdDocument({ format: 1, approvedBy: 'ops', approvedAt: '2026-08-02T00:00:00.000Z', source: 'soak', thresholds: [] })).toThrow(/at least one threshold/)
    expect(() => parseThresholdDocument({ format: 1, approvedBy: 'ops', approvedAt: '2026-08-02T00:00:00.000Z', source: 'soak', thresholds: [{ metric: 'append.p95Ms', comparison: 'under', value: 25, unit: 'ms' }] })).toThrow(/atMost/)
    expect(() => parseThresholdDocument({ format: 1, approvedBy: 'ops', approvedAt: '2026-08-02T00:00:00.000Z', source: 'soak', thresholds: [{ metric: 'append.p95Ms', comparison: 'atMost', value: 'fast', unit: 'ms' }] })).toThrow(/finite numeric value/)
  })

  it('reports every measurement as measured-not-evaluated when no operator limits exist', () => {
    const report = evaluateThresholds(undefined, new Map([['append.p95Ms', 3], ['throughput.operationsPerSecond', 120]]))
    expect(report.status).toBe('measured-not-evaluated')
    expect(report.approvedBy).toBeNull()
    expect(report.failures).toBe(0)
    expect(report.evaluations.map(evaluation => evaluation.status)).toEqual(['measured-not-evaluated', 'measured-not-evaluated'])
    expect(report.evaluations.every(evaluation => evaluation.threshold === null)).toBe(true)
  })

  it('passes, fails, and marks unavailable metrics without silently approving them', () => {
    const document = parseThresholdDocument({
      format: 1,
      approvedBy: 'Operations lead',
      approvedAt: '2026-08-02T00:00:00.000Z',
      source: 'deployment soak run g2-20260802T000000Z-abcdef12',
      thresholds: [
        { metric: 'append.p95Ms', comparison: 'atMost', value: 25, unit: 'ms' },
        { metric: 'throughput.operationsPerSecond', comparison: 'atLeast', value: 100, unit: 'ops/s' },
        { metric: 'wal.maximumBytes', comparison: 'atMost', value: 1024, unit: 'bytes' },
      ],
    })
    const report = evaluateThresholds(document, new Map([['append.p95Ms', 3], ['throughput.operationsPerSecond', 42], ['restore.maxMs', 9]]))
    expect(report.status).toBe('evaluated')
    expect(report.approvedBy).toBe('Operations lead')
    expect(report.failures).toBe(1)
    expect(report.evaluations.find(evaluation => evaluation.metric === 'append.p95Ms')?.status).toBe('passed')
    expect(report.evaluations.find(evaluation => evaluation.metric === 'throughput.operationsPerSecond')?.status).toBe('failed')
    expect(report.evaluations.find(evaluation => evaluation.metric === 'wal.maximumBytes')?.status).toBe('metric-unavailable')
    expect(report.evaluations.find(evaluation => evaluation.metric === 'restore.maxMs')?.status).toBe('measured-not-evaluated')
  })
})

describe('g2 run summary', () => {
  it('emits a stable schema that never implies approval', () => {
    const summary = buildRunSummary(evidenceFixture('completed'))
    expect(summary.schema).toBe('dc-bot.g2-operational-soak.summary')
    expect(summary.schemaVersion).toBe(2)
    expect(summary.productionApprovalImplied).toBe(false)
    expect(summary.g2AutomaticallyPassed).toBe(false)
    expect(summary.statement).toBe(nonApprovalStatement)
    expect(summary.validForOperatorReview).toBe(true)
    expect(Object.keys(summary)).toEqual(['schema', 'schemaVersion', 'runId', 'status', 'validForOperatorReview', 'productionApprovalImplied', 'g2AutomaticallyPassed', 'statement', 'startedAt', 'completedAt', 'repositoryRevision', 'correctness', 'contention', 'performance', 'wal', 'backup', 'restore', 'restart', 'topology', 'sqliteProfile', 'limitations', 'operatorAttestationsRequired'])
    expect(summary.operatorAttestationsRequired.length).toBeGreaterThanOrEqual(6)
    expect(summary.limitations).toEqual(expect.arrayContaining([expect.stringContaining('cannot prove physical storage locality')]))
    expect(summary.restart.kindsExercised).toEqual(['connection reopen'])
  })

  it('marks an interrupted run as incomplete and not reviewable', () => {
    const summary = buildRunSummary(evidenceFixture('interrupted'))
    expect(summary.status).toBe('interrupted')
    expect(summary.validForOperatorReview).toBe(false)
    expect(summary.limitations).toEqual(expect.arrayContaining([expect.stringContaining('interrupted before its configured duration')]))
  })

  it('withholds reviewability when a correctness invariant, the profile, or the restore drill failed', () => {
    const lostWrite = evidenceFixture('invalid')
    lostWrite.counters.correctness.acknowledgedWritesMissingAfterReopen = 3
    expect(buildRunSummary(lostWrite).validForOperatorReview).toBe(false)

    const badProfile = evidenceFixture('completed', { profile: { ...evidenceFixture('completed').profile, valid: false, violations: ['journal mode is delete, not WAL (ADR-003 REQ-OPS-010)'] } })
    expect(buildRunSummary(badProfile).validForOperatorReview).toBe(false)

    const failedRestore = evidenceFixture('completed', { restore: { ...evidenceFixture('completed').restore!, valid: false, failures: ['candidate verification failed'] } })
    expect(buildRunSummary(failedRestore).validForOperatorReview).toBe(false)

    const noBackup = evidenceFixture('completed', { backups: [], restore: null })
    const noBackupSummary = buildRunSummary(noBackup)
    expect(noBackupSummary.validForOperatorReview).toBe(false)
    expect(noBackupSummary.limitations).toEqual(expect.arrayContaining([expect.stringContaining('No backup completed'), expect.stringContaining('No restore drill completed')]))
  })

  it('records an unexpected guarded second writer as an operational risk rather than a pass', () => {
    const evidence = evidenceFixture('completed')
    const summary = buildRunSummary({ ...evidence, topology: { ...evidence.topology, secondWriterProbe: 'unexpectedly-succeeded', secondWriterProbeDetail: 'acquired the write lock' } })
    expect(summary.limitations).toEqual(expect.arrayContaining([expect.stringContaining('unexpectedly acquired guarded authoritative ownership')]))
  })

  it('distinguishes expected refusal from probe infrastructure failure', () => {
    const evidence = evidenceFixture('completed')
    const refused = buildRunSummary({ ...evidence, topology: { ...evidence.topology, secondWriterProbe: 'expected-ownership-refusal', secondWriterProbeDetail: 'typed refusal' } })
    expect(refused.limitations.join('\n')).not.toContain('ownership-refusal evidence')
    const failed = buildRunSummary({ ...evidence, topology: { ...evidence.topology, secondWriterProbe: 'probe-infrastructure-failure', secondWriterProbeDetail: 'fixture failed' } })
    expect(failed.limitations).toEqual(expect.arrayContaining([expect.stringContaining('probe infrastructure failed')]))
  })

  it('renders a report that states it does not approve G2', () => {
    const evidence = evidenceFixture('completed')
    const report = renderMarkdownReport(evidence, buildRunSummary(evidence))
    expect(report).toContain(nonApprovalStatement)
    expect(report).toContain('# G2 operational soak report — g2-20260802T000000Z-abcdef12')
    expect(report).toContain('## Writer topology')
    expect(report).toContain('## SQLite profile (PRAGMA evidence)')
    expect(report).toContain('## Restore results')
    expect(report).toContain('## Required operator attestations')
    expect(report).toContain('measured-not-evaluated')
    expect(report).not.toContain('production-ready')
  })
})

describe('g2 sqlite profile verification', () => {
  it('accepts the production-representative profile and reports the migration manifest', async () => {
    const path = join(await root(), 'profile.db')
    const database = openSqliteDatabase(path, { busyTimeoutMs: 250 })
    try {
      const profile = captureSqliteProfile(database, 250)
      expect(profile.valid).toBe(true)
      expect(profile.violations).toEqual([])
      expect(profile.foreignKeys).toBe(1)
      expect(profile.journalMode).toBe('wal')
      expect(profile.synchronous).toBe(2)
      expect(profile.busyTimeoutMs).toBe(250)
      expect(profile.schemaVersion).toBeGreaterThan(0)
      expect(profile.migrationChecksumsMatch).toBe(true)
      expect(profile.migrationVersions).toEqual(migrations.map(migration => migration.version))
    }
    finally {
      database.close()
    }
  })

  it('invalidates a connection whose busy timeout or durability pragmas drifted', async () => {
    const path = join(await root(), 'drifted.db')
    const database = openSqliteDatabase(path, { busyTimeoutMs: 250 })
    try {
      expect(captureSqliteProfile(database, 500).valid).toBe(false)
      expect(captureSqliteProfile(database, 500).violations).toEqual([expect.stringContaining('busy timeout is 250 ms, not the configured 500 ms')])
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA foreign_keys = OFF')
      const drifted = captureSqliteProfile(database, 250)
      expect(drifted.valid).toBe(false)
      expect(drifted.violations).toEqual(expect.arrayContaining([expect.stringContaining('foreign keys are not enabled'), expect.stringContaining('synchronous is 1, not FULL')]))
    }
    finally {
      database.close()
    }
  })

  it('detects a migration history that does not match the application manifest', async () => {
    const path = join(await root(), 'history.db')
    const database = openSqliteDatabase(path, { busyTimeoutMs: 250 })
    try {
      database.prepare('DELETE FROM memory_schema_migrations WHERE version=?').run(migrations.at(-1)!.version)
      const profile = captureSqliteProfile(database, 250)
      expect(profile.migrationChecksumsMatch).toBe(false)
      expect(profile.valid).toBe(false)
      expect(profile.violations).toEqual([expect.stringContaining('migration history does not match')])
    }
    finally {
      database.close()
    }
  })
})
