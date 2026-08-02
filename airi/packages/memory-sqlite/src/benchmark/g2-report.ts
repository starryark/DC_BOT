/**
 * Evidence shapes and rendering for a G2 operational soak run.
 *
 * This module owns the contract between the harness and the humans who review
 * it: the JSON summary schema, the enumerated limitations, the operator
 * attestations a run cannot supply for itself, and the non-approval statement
 * that must appear on every report. It performs no measurement of its own.
 */

import type { G2Configuration, G2RequestedValue } from './g2-config.js'
import type { G2Environment, SqliteProfileEvidence } from './g2-environment.js'
import type { G2Counters, LatencySnapshot, LatencyStatistics } from './g2-metrics.js'
import type { ThresholdReport } from './g2-thresholds.js'

/** The sentence that must appear in every generated report and summary. */
export const nonApprovalStatement = 'This report does not automatically approve SQLite M1 or pass G2. Formal operator review and signatures are required.'

/** Terminal state of a run. */
export type G2RunStatus = 'completed' | 'failed' | 'interrupted' | 'invalid'

/** Outcome of the opt-in attempt to establish a second write-capable process. */
export type SecondWriterProbeResult = 'expected-ownership-refusal' | 'unexpectedly-succeeded' | 'not-tested' | 'probe-infrastructure-failure'

/**
 * What kind of restart evidence a run actually produced.
 *
 * The distinction is load-bearing: an in-process reopen is not an operating
 * system crash, and describing one as the other would overstate the durability
 * evidence.
 */
export type RestartKind = 'connection reopen' | 'graceful process restart' | 'forced process termination' | 'crash schedule not exercised'

/** One WAL checkpoint executed during or after load. */
export interface CheckpointRecord {
  readonly ordinal: number
  readonly mode: 'PASSIVE' | 'TRUNCATE'
  readonly startedAt: string
  readonly completedAt: string
  readonly durationMs: number
  readonly busy: number
  readonly walFrames: number
  readonly checkpointedFrames: number
  readonly walBytesBefore: number
  readonly walBytesAfter: number
  readonly failed: boolean
  readonly failureReason?: string
}

/** One verified online backup. */
export interface BackupRecord {
  readonly ordinal: number
  readonly backupPath: string
  readonly manifestPath: string
  readonly sourceDatabasePath: string
  readonly runId: string
  readonly repositoryRevision: string
  readonly sourceSchemaVersion: number
  readonly startedAt: string
  readonly completedAt: string
  readonly durationMs: number
  readonly bytes: number
  readonly integrityVerified: boolean
  readonly foreignKeysVerified: boolean
  readonly migrationChecksumsVerified: boolean
  readonly acknowledgedWritesAtStart: number
  readonly acknowledgedWritesAtCompletion: number
  /** Durable event rows when the copy started; the lower bound the restored candidate must satisfy. */
  readonly eventRowsAtStart: number
  /** Durable event rows when the copy finished; the upper bound the restored candidate must satisfy. */
  readonly eventRowsAtCompletion: number
  /** Wall clock of the last acknowledged write before the copy finished; the RPO anchor. */
  readonly lastAcknowledgedWriteAtCompletion: string | null
  /** The workload loop was still running when the copy began. */
  readonly startedUnderLoad: boolean
  /** Acknowledged writes actually landed while the copy was in flight; proven by the delta, not asserted. */
  readonly duringActiveWrites: boolean
  readonly failed: boolean
  readonly failureReason?: string
}

/** The restore drill for one selected backup. */
export interface RestoreRecord {
  readonly backupOrdinal: number
  readonly backupPath: string
  readonly restorePath: string
  readonly startedAt: string
  readonly completedAt: string
  readonly restoreDurationMs: number
  readonly totalRecoveryDurationMs: number
  readonly restoredBytes: number
  readonly integrityVerified: boolean
  readonly foreignKeysVerified: boolean
  readonly schemaVersionVerified: boolean
  readonly migrationChecksumsVerified: boolean
  readonly recordCountsVerified: boolean
  readonly restoredEventCount: number
  readonly expectedEventCountLowerBound: number
  readonly expectedEventCountUpperBound: number
  readonly deletionObligationReplay: 'applied' | 'unavailable'
  readonly deletionObligationNote: string
  readonly checkpointPerformed: boolean
  readonly achievedRpoMs: number | null
  readonly achievedRtoMs: number | null
  readonly rpoDefinition: string
  readonly rtoDefinition: string
  readonly valid: boolean
  readonly failures: readonly string[]
}

/** One restart/recovery phase. */
export interface RestartRecord {
  readonly ordinal: number
  readonly kind: RestartKind
  readonly startedAt: string
  readonly completedAt: string
  readonly durationMs: number
  readonly acknowledgedWritesBefore: number
  readonly recordsAfterReopen: number
  readonly missingAfterReopen: number
  readonly queueJobsBefore: number
  readonly queueJobsAfter: number
  readonly integrityVerified: boolean
  readonly profileValidAfterReopen: boolean
}

/** Who may write, from how many processes and connections. */
export interface WriterTopology {
  readonly authoritativeProcesses: number
  readonly writeCapableConnections: number
  readonly transientWriteCapableConnections: number
  readonly readerConnections: number
  readonly processId: number
  readonly parentProcessId: number
  readonly writeSerialization: string
  readonly writerOwnershipGuardVersion: number
  readonly firstWriterHeldOwnership: boolean
  readonly ownershipAcquisitionTimeoutMs: number
  readonly secondWriterRefusalLatencyMs: number | null
  readonly firstOwnerRemainedOperational: boolean | null
  readonly cleanReleaseResult: string
  readonly crashRecoveryResult: string
  readonly intentionallyUnguardedConnections: string
  readonly secondWriterProbe: SecondWriterProbeResult
  readonly secondWriterProbeDetail: string
}

/** Everything one run produced. Input to both the JSON summary and the Markdown report. */
export interface G2RunEvidence {
  readonly runId: string
  readonly status: G2RunStatus
  readonly startedAt: string
  readonly completedAt: string
  readonly interrupted: boolean
  readonly failureReason: string | null
  readonly configuration: G2Configuration
  readonly requestedConfiguration: readonly G2RequestedValue[]
  readonly environment: G2Environment
  readonly profile: SqliteProfileEvidence
  readonly profileAfterFinalReopen: SqliteProfileEvidence | null
  readonly topology: WriterTopology
  readonly counters: G2Counters
  readonly latency: LatencySnapshot
  readonly checkpoints: readonly CheckpointRecord[]
  readonly backups: readonly BackupRecord[]
  readonly restore: RestoreRecord | null
  readonly restarts: readonly RestartRecord[]
  readonly thresholds: ThresholdReport
  readonly paths: { readonly databasePath: string, readonly runOutputDirectory: string, readonly backupsDirectory: string, readonly restoreDirectory: string }
}

/** The `summary.json` document. Field names are stable; consumers may depend on them. */
export interface G2RunSummary {
  readonly schema: 'dc-bot.g2-operational-soak.summary'
  readonly schemaVersion: 2
  readonly runId: string
  readonly status: G2RunStatus
  readonly validForOperatorReview: boolean
  readonly productionApprovalImplied: false
  readonly g2AutomaticallyPassed: false
  readonly statement: typeof nonApprovalStatement
  readonly startedAt: string
  readonly completedAt: string
  readonly repositoryRevision: string
  readonly correctness: G2Counters['correctness']
  readonly contention: G2Counters['contention']
  readonly performance: {
    readonly workload: G2Counters['workload']
    readonly latency: LatencySnapshot
    readonly thresholds: ThresholdReport
  }
  readonly wal: G2Counters['storage'] & { readonly checkpoints: readonly CheckpointRecord[] }
  readonly backup: { readonly records: readonly BackupRecord[], readonly verifiedDuringActiveWrites: number }
  readonly restore: RestoreRecord | null
  readonly restart: { readonly kindsExercised: readonly RestartKind[], readonly records: readonly RestartRecord[] }
  readonly topology: WriterTopology
  readonly sqliteProfile: SqliteProfileEvidence
  readonly limitations: readonly string[]
  readonly operatorAttestationsRequired: readonly string[]
}

/**
 * Attestations the harness structurally cannot make for itself.
 *
 * These are the OQ-BLOCK-003 items that are deployment facts rather than
 * measurements; the acceptance template collects them.
 */
export function operatorAttestationsRequired(): readonly string[] {
  return Object.freeze([
    'The complete operating-system process inventory on the deployment host, proving exactly one write-capable DC_BOT process owns the authoritative database.',
    'That the authority path is on local, non-network, non-cloud-synchronised storage, with filesystem/ACL evidence.',
    'The real operational backup destination, its owner, encryption boundary, retention, and schedule.',
    'That the deployment-shaped workload used here matches expected peak Discord traffic.',
    'Approved latency, throughput, contention, WAL, RPO, and RTO limits for the deployment.',
    'Formal SQLite M1 acceptance and the G2 gate decision, with signatures.',
  ])
}

/** Limitations that are always true, plus the ones this particular run created. */
export function limitationsFor(evidence: Pick<G2RunEvidence, 'restarts' | 'topology' | 'backups' | 'restore' | 'counters' | 'environment' | 'thresholds' | 'interrupted'>): readonly string[] {
  const limitations: string[] = [
    'The harness cannot prove physical storage locality. Storage locality is recorded as an operator attestation or as unknown.',
    'The harness observes only its own process. It cannot prove that no other process opened the database outside its observation window.',
    'The harness stages backups locally. It does not perform, and does not simulate, an off-host or encrypted operational copy.',
    'The workload is synthetic. It contains no Discord tokens, user content, guild identifiers, or personal data, and is not proof of real Discord workload equivalence.',
    'Discord ingress adapters are not implemented until IMP-301, so synthetic ingress calls the existing SQLite persistence APIs directly rather than a Discord adapter.',
    'The package exposes no bounded recent-context read API yet, so bounded context reads use a direct ordered/limited query on a read-only connection.',
  ]
  if (evidence.restarts.every(record => record.kind === 'connection reopen')) {
    limitations.push('Restart coverage in this run is in-process connection reopen only. It is not an operating-system crash; forced-termination durability is covered by the existing IMP-208 child-process tests (`src/imp208.integration.test.ts`).')
  }
  if (evidence.topology.secondWriterProbe === 'not-tested')
    limitations.push('The second-writer probe was not run, so this run provides no evidence about second-instance behaviour.')
  if (evidence.topology.secondWriterProbe === 'unexpectedly-succeeded')
    limitations.push('A second process unexpectedly acquired guarded authoritative ownership. Treat this run as failed ownership evidence and investigate the guard or filesystem before deployment.')
  if (evidence.topology.secondWriterProbe === 'probe-infrastructure-failure')
    limitations.push('The second-writer probe infrastructure failed, so this run provides no valid ownership-refusal evidence.')
  if (evidence.counters.contention.busyRetryExhaustion === 0 && evidence.counters.contention.busyOutcomes === 0)
    limitations.push('No lock contention was observed. A single-threaded process cannot produce a blocked-then-successful writer; only bounded busy-timeout exhaustion is observable in-process.')
  if (evidence.backups.length === 0)
    limitations.push('No backup completed in this run.')
  else if (!evidence.backups.some(record => record.duringActiveWrites))
    limitations.push('Backups were started while the workload was running, but every copy finished before the next acknowledged write, so this evidence set does not prove a page copy interleaved with a committed write. A higher write rate or a larger database is needed to exercise that.')
  if (evidence.restore == null)
    limitations.push('No restore drill completed in this run.')
  if (evidence.thresholds.status === 'measured-not-evaluated')
    limitations.push('No operator threshold document was supplied, so every measurement is reported as measured-not-evaluated rather than passed.')
  if (evidence.interrupted)
    limitations.push('The run was interrupted before its configured duration elapsed and is incomplete.')
  if (evidence.environment.repositoryDirty === true)
    limitations.push('The repository checkout was dirty when the run started, so the recorded revision does not fully describe the code that ran.')
  return Object.freeze(limitations)
}

/** Assemble the machine-readable summary. */
export function buildRunSummary(evidence: G2RunEvidence): G2RunSummary {
  return Object.freeze({
    schema: 'dc-bot.g2-operational-soak.summary',
    schemaVersion: 2,
    runId: evidence.runId,
    status: evidence.status,
    // A run is reviewable only when it completed on a valid profile with a
    // verified backup and restore. Anything else is evidence of a harness or
    // host problem, not evidence about the deployment.
    validForOperatorReview: evidence.status === 'completed' && evidence.profile.valid && evidence.restore?.valid === true && evidence.backups.some(record => !record.failed),
    productionApprovalImplied: false,
    g2AutomaticallyPassed: false,
    statement: nonApprovalStatement,
    startedAt: evidence.startedAt,
    completedAt: evidence.completedAt,
    repositoryRevision: evidence.environment.repositoryRevision,
    correctness: evidence.counters.correctness,
    contention: evidence.counters.contention,
    performance: { workload: evidence.counters.workload, latency: evidence.latency, thresholds: evidence.thresholds },
    wal: { ...evidence.counters.storage, checkpoints: evidence.checkpoints },
    backup: { records: evidence.backups, verifiedDuringActiveWrites: evidence.backups.filter(record => !record.failed && record.duringActiveWrites).length },
    restore: evidence.restore,
    restart: {
      kindsExercised: Object.freeze(evidence.restarts.length === 0 ? ['crash schedule not exercised' as const] : [...new Set(evidence.restarts.map(record => record.kind))]),
      records: evidence.restarts,
    },
    topology: evidence.topology,
    sqliteProfile: evidence.profile,
    limitations: limitationsFor(evidence),
    operatorAttestationsRequired: operatorAttestationsRequired(),
  })
}

const dash = '—'

function ms(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? dash : `${value.toFixed(3)} ms`
}

function bytes(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? dash : `${value.toLocaleString('en-US')} bytes`
}

function yesNo(value: boolean | null | undefined): string {
  return value == null ? 'unknown' : value ? 'yes' : 'no'
}

function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const head = `| ${headers.join(' | ')} |`
  const rule = `|${headers.map(() => '---').join('|')}|`
  const body = rows.map(row => `| ${row.join(' | ')} |`).join('\n')
  return rows.length === 0 ? `${head}\n${rule}\n| ${headers.map(() => dash).join(' | ')} |` : `${head}\n${rule}\n${body}`
}

function latencyRow(name: string, statistics: LatencyStatistics): readonly string[] {
  return [name, String(statistics.count), ms(statistics.min), ms(statistics.max), ms(statistics.mean), ms(statistics.p50), ms(statistics.p95), ms(statistics.p99), statistics.method]
}

/** Render the human-readable evidence report. */
export function renderMarkdownReport(evidence: G2RunEvidence, summary: G2RunSummary): string {
  const { configuration: config, environment, profile, counters, latency, topology } = evidence
  const sections: string[] = []

  sections.push(`# G2 operational soak report — ${evidence.runId}`)
  sections.push(`> ${nonApprovalStatement}`)
  sections.push([
    `- Status: **${evidence.status}**${evidence.failureReason == null ? '' : ` (${evidence.failureReason})`}`,
    `- Valid for operator review: **${yesNo(summary.validForOperatorReview)}**`,
    `- Repository revision: \`${environment.repositoryRevision}\`${environment.repositoryDirty === true ? ' (working tree dirty)' : ''}`,
    `- Started: ${evidence.startedAt}`,
    `- Completed: ${evidence.completedAt}`,
    `- Output directory: \`${evidence.paths.runOutputDirectory}\``,
  ].join('\n'))

  sections.push(`## Effective configuration\n\n${table(['Variable', 'Effective value', 'Source'], evidence.requestedConfiguration.map(entry => [entry.variable, `\`${entry.effective}\``, entry.source]))}`)

  sections.push(`## Host and environment\n\n${table(['Field', 'Value'], [
    ['Node', environment.nodeVersion],
    ['Platform / release / architecture', `${environment.platform} ${environment.osRelease} ${environment.architecture}`],
    ['Hostname', environment.hostname],
    ['CPU', `${environment.cpuModel} (${environment.cpuCount} logical processors)`],
    ['Total memory', bytes(environment.totalMemoryBytes)],
    ['SQLite', environment.sqliteVersion],
    ['Package', `${environment.packageName}@${environment.packageVersion}`],
    ['Process id / parent process id', `${environment.processId} / ${environment.parentProcessId}`],
  ])}`)

  sections.push(`## Storage path and verification status\n\n${table(['Field', 'Value'], [
    ['Authority database path', `\`${environment.databasePath}\``],
    ['Volume root', `\`${environment.databaseVolumeRoot}\``],
    ['Evidence output directory', `\`${evidence.paths.runOutputDirectory}\``],
    ['Storage locality verification', environment.storageLocalityVerification],
    ['Operator attestation', environment.storageAttestation ?? dash],
  ])}\n\n${environment.storageLocalityNote}`)

  sections.push(`## Writer topology\n\n${table(['Field', 'Value'], [
    ['Authoritative write-owning processes', String(topology.authoritativeProcesses)],
    ['Write-capable connections', String(topology.writeCapableConnections)],
    ['Transient write-capable connections (contention probe)', String(topology.transientWriteCapableConnections)],
    ['Read-only connections', String(topology.readerConnections)],
    ['Write serialization', topology.writeSerialization],
    ['Writer-ownership guard version', String(topology.writerOwnershipGuardVersion)],
    ['First writer held ownership', yesNo(topology.firstWriterHeldOwnership)],
    ['Configured ownership timeout', ms(topology.ownershipAcquisitionTimeoutMs)],
    ['Observed refusal latency', ms(topology.secondWriterRefusalLatencyMs)],
    ['First owner remained operational', yesNo(topology.firstOwnerRemainedOperational)],
    ['Second-writer probe', `\`${topology.secondWriterProbe}\``],
    ['Second-writer probe detail', topology.secondWriterProbeDetail],
    ['Clean-release result', topology.cleanReleaseResult],
    ['Crash-recovery result', topology.crashRecoveryResult],
    ['Intentionally outside authority guard', topology.intentionallyUnguardedConnections],
  ])}`)

  sections.push(`## SQLite profile (PRAGMA evidence)\n\n${table(['Pragma', 'Observed', 'Required'], [
    ['foreign_keys', String(profile.foreignKeys), '1 (ADR-003 REQ-OPS-014)'],
    ['journal_mode', profile.journalMode, 'wal (REQ-OPS-010)'],
    ['synchronous', String(profile.synchronous), '2 / FULL (REQ-OPS-015)'],
    ['busy_timeout', `${profile.busyTimeoutMs} ms`, `${config.busyTimeoutMs} ms (bounded, REQ-OPS-014)`],
    ['schema_version', String(profile.schemaVersion), '> 0'],
    ['wal_autocheckpoint', String(profile.walAutocheckpointPages), 'SQLite default retained'],
    ['migration history', profile.migrationVersions.join(', '), profile.expectedMigrationVersions.join(', ')],
  ])}\n\nProfile valid: **${yesNo(profile.valid)}**${profile.violations.length === 0 ? '' : `\n\nViolations:\n${profile.violations.map(violation => `- ${violation}`).join('\n')}`}${evidence.profileAfterFinalReopen == null ? '' : `\n\nProfile after the final reopen through \`openSqliteDatabase\`: **${yesNo(evidence.profileAfterFinalReopen.valid)}**.`}`)

  sections.push(`## Workload summary\n\n${table(['Metric', 'Value'], [
    ['Run duration', `${counters.workload.runDurationSeconds.toFixed(3)} s`],
    ['Logical rooms', String(counters.workload.logicalRoomCount)],
    ['Active rooms', String(counters.workload.activeRoomCount)],
    ['Text ingress writes', String(counters.workload.textWrites)],
    ['Voice ingress writes', String(counters.workload.voiceWrites)],
    ['Same-room bursts', String(counters.workload.burstCount)],
    ['Authorized reads', String(counters.workload.reads)],
    ['Queue claims', String(counters.workload.queueClaims)],
    ['Identity observations', String(counters.workload.identityObservations)],
    ['Multi-mutation transactions', String(counters.workload.multiMutationTransactions)],
    ['Deliberate rollback probes', String(counters.workload.rollbackProbes)],
    ['Operations per second', counters.workload.operationsPerSecond.toFixed(3)],
  ])}`)

  sections.push(`## Correctness results\n\n${table(['Counter', 'Value'], Object.entries(counters.correctness).map(([key, value]) => [key, String(value)]))}`)

  sections.push(`## Latency and throughput\n\n${table(['Category', 'Count', 'Min', 'Max', 'Mean', 'p50', 'p95', 'p99', 'Percentile method'], [
    latencyRow('append (text)', latency.append_text),
    latencyRow('append (voice)', latency.append_voice),
    latencyRow('read', latency.read),
    latencyRow('queue claim', latency.queue_claim),
    latencyRow('multi-mutation transaction', latency.transaction),
    latencyRow('identity observation', latency.identity_observe),
    latencyRow('checkpoint', latency.checkpoint),
    latencyRow('backup', latency.backup),
    latencyRow('restore', latency.restore),
  ])}\n\nPercentiles use the nearest-rank definition, so every reported value is an observation that actually occurred. When a category exceeds ${config.latencySampleCapacity.toLocaleString('en-US')} samples the percentiles are computed over a uniform reservoir of that size and the method column says so; counts, minima, maxima, and means are always exact.`)

  sections.push(`## Contention results\n\n${table(['Counter', 'Value'], Object.entries(counters.contention).map(([key, value]) => [key, String(value)]))}`)

  sections.push(`## WAL and checkpoint results\n\n${table(['Metric', 'Value'], [
    ['Database size', bytes(counters.storage.databaseBytes)],
    ['Maximum WAL size', bytes(counters.storage.maximumWalBytes)],
    ['Final WAL size', bytes(counters.storage.finalWalBytes)],
    ['Checkpoints', String(counters.storage.checkpointCount)],
    ['Checkpoint failures', String(counters.storage.checkpointFailures)],
  ])}\n\n${table(['#', 'Mode', 'Started', 'Duration', 'Busy', 'WAL frames', 'Frames checkpointed', 'WAL before', 'WAL after', 'Failed'], evidence.checkpoints.map(record => [
    String(record.ordinal),
    record.mode,
    record.startedAt,
    ms(record.durationMs),
    String(record.busy),
    String(record.walFrames),
    String(record.checkpointedFrames),
    bytes(record.walBytesBefore),
    bytes(record.walBytesAfter),
    yesNo(record.failed),
  ]))}`)

  sections.push(`## Backup results\n\n${table(['#', 'Path', 'Started', 'Duration', 'Size', 'Schema', 'Integrity', 'Foreign keys', 'Migration checksums', 'Started under load', 'Writes during copy', 'Failed'], evidence.backups.map(record => [
    String(record.ordinal),
    `\`${record.backupPath}\``,
    record.startedAt,
    ms(record.durationMs),
    bytes(record.bytes),
    String(record.sourceSchemaVersion),
    yesNo(record.integrityVerified),
    yesNo(record.foreignKeysVerified),
    yesNo(record.migrationChecksumsVerified),
    yesNo(record.startedUnderLoad),
    `${record.acknowledgedWritesAtCompletion - record.acknowledgedWritesAtStart}`,
    yesNo(record.failed),
  ]))}\n\nBackups use Node's SQLite online backup API through \`createVerifiedBackup\`; no live main database file is copied on its own. Every artifact is written to a run-scoped directory outside the authority directory. Copying a verified artifact to the real operational destination remains an operator step.`)

  const restore = evidence.restore
  sections.push(`## Restore results\n\n${restore == null
    ? 'No restore drill completed in this run.'
    : `${table(['Field', 'Value'], [
      ['Backup restored', `\`${restore.backupPath}\``],
      ['Restore destination', `\`${restore.restorePath}\``],
      ['Restore duration', ms(restore.restoreDurationMs)],
      ['Total recovery duration', ms(restore.totalRecoveryDurationMs)],
      ['Restored size', bytes(restore.restoredBytes)],
      ['Integrity verified', yesNo(restore.integrityVerified)],
      ['Foreign keys verified', yesNo(restore.foreignKeysVerified)],
      ['Schema version verified', yesNo(restore.schemaVersionVerified)],
      ['Migration checksums verified', yesNo(restore.migrationChecksumsVerified)],
      ['Record counts verified', `${yesNo(restore.recordCountsVerified)} (${restore.restoredEventCount} restored; expected ${restore.expectedEventCountLowerBound}–${restore.expectedEventCountUpperBound})`],
      ['Deletion-obligation replay', `${restore.deletionObligationReplay} — ${restore.deletionObligationNote}`],
      ['Checkpoint before publication', yesNo(restore.checkpointPerformed)],
      ['Achieved RPO', ms(restore.achievedRpoMs)],
      ['Achieved RTO', ms(restore.achievedRtoMs)],
      ['Restore valid', yesNo(restore.valid)],
    ])}\n\n- RPO definition: ${restore.rpoDefinition}\n- RTO definition: ${restore.rtoDefinition}${restore.failures.length === 0 ? '' : `\n\nFailures:\n${restore.failures.map(failure => `- ${failure}`).join('\n')}`}`}`)

  sections.push(`## Restart and recovery results\n\n${table(['#', 'Kind', 'Started', 'Duration', 'Acknowledged before', 'Records after reopen', 'Missing after reopen', 'Queue jobs before/after', 'Integrity', 'Profile valid'], evidence.restarts.map(record => [
    String(record.ordinal),
    record.kind,
    record.startedAt,
    ms(record.durationMs),
    String(record.acknowledgedWritesBefore),
    String(record.recordsAfterReopen),
    String(record.missingAfterReopen),
    `${record.queueJobsBefore} / ${record.queueJobsAfter}`,
    yesNo(record.integrityVerified),
    yesNo(record.profileValidAfterReopen),
  ]))}\n\nKinds exercised: ${summary.restart.kindsExercised.map(kind => `\`${kind}\``).join(', ')}. An in-process connection reopen is not an operating-system crash; forced-termination durability is covered separately by the IMP-208 child-process kill schedules.`)

  sections.push(`## Threshold evaluation\n\n${evidence.thresholds.status === 'measured-not-evaluated'
    ? 'No operator threshold document was supplied. Every measurement below is reported as `measured-not-evaluated`; nothing in this run is a pass or a fail.'
    : `Thresholds approved by **${evidence.thresholds.approvedBy}** on ${evidence.thresholds.approvedAt} (source: ${evidence.thresholds.source}). Failures: **${evidence.thresholds.failures}**.`}\n\n${table(['Metric', 'Comparison', 'Threshold', 'Observed', 'Status'], evidence.thresholds.evaluations.map(evaluation => [
    `\`${evaluation.metric}\``,
    evaluation.comparison ?? dash,
    evaluation.threshold == null ? dash : `${evaluation.threshold}${evaluation.unit == null ? '' : ` ${evaluation.unit}`}`,
    evaluation.observed == null ? dash : String(Number(evaluation.observed.toFixed(6))),
    `\`${evaluation.status}\``,
  ]))}`)

  sections.push(`## Known limitations\n\n${summary.limitations.map(limitation => `- ${limitation}`).join('\n')}`)

  sections.push(`## Required operator attestations\n\n${summary.operatorAttestationsRequired.map(attestation => `- ${attestation}`).join('\n')}\n\nRecord them in \`docs/memory/evidence/g2-operational-acceptance-template.md\`.`)

  sections.push(`## Decision status\n\n${nonApprovalStatement}\n\n- \`productionApprovalImplied\`: false\n- \`g2AutomaticallyPassed\`: false\n- OQ-BLOCK-003 remains open until an operator records the acceptance document and signs it.`)

  return `${sections.join('\n\n')}\n`
}
