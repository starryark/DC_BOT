import { Buffer } from 'node:buffer'
import { createHmac } from 'node:crypto'

import { digestSnapshotContextManifest, MemoryError } from '@proj-airi/memory-domain'

import * as v from 'valibot'

/**
 * Evidence model for the private active-memory soak (A8).
 *
 * This module owns the run identity, the identifier-redaction rule, the
 * machine assertions derived from durable records, and the acceptance rules a
 * reviewer relies on. The CLI in `scripts/memory/active-soak.ts` only supplies
 * process, filesystem, and git facts.
 *
 * The report is content-free by construction: every raw identifier is replaced
 * by a run-scoped HMAC, and no message text, transcript, display name, or
 * provider payload is read from the database at all.
 */

/** Scenario groups the runbook requires; a soak that omits any of these cannot qualify a commit. */
export const SOAK_SCENARIOS = Object.freeze([
  { id: 'startup-binding-reconciliation', title: 'Active startup, isolated root, and binding reconciliation' },
  { id: 'empty-history-text', title: 'Empty-history text mention' },
  { id: 'bound-text-voice-recall', title: 'Bound text-to-voice and voice-to-text recall' },
  { id: 'bound-thread', title: 'Bound parent channel and thread behavior' },
  { id: 'unbound-guild-isolation', title: 'Unbound guild-channel isolation' },
  { id: 'dm-isolation', title: 'DM isolation' },
  { id: 'restart-continuity', title: 'Restart continuity' },
  { id: 'multi-segment-text-delivery', title: 'Multi-segment text delivery' },
  { id: 'voice-playback-complete-cancel', title: 'Completed and cancelled voice playback' },
  { id: 'privacy-status-show-export', title: 'Privacy status, show, and export' },
  { id: 'disabled-remember-correct', title: 'Disabled remember and correct with zero semantic writes' },
  { id: 'forget-deletion-migration-replay', title: 'Forget, deletion verification, old-backup migration, and obligation replay' },
  { id: 'active-to-off-rollback', title: 'Stopped-process active-to-off rollback' },
] as const)

export type SoakScenarioId = typeof SOAK_SCENARIOS[number]['id']

const scenarioIds = SOAK_SCENARIOS.map(scenario => scenario.id)

const isoTimestamp = v.pipe(v.string(), v.isoTimestamp())
const hex = (length: number) => v.pipe(v.string(), v.regex(new RegExp(`^[0-9a-f]{${length}}$`), `expected ${length} lowercase hex characters`))

const runStateSchema = v.strictObject({
  format: v.literal(1),
  runId: v.pipe(v.string(), v.regex(/^[a-z0-9][\w-]{2,63}$/, 'run identity must be a short slug')),
  commitSha: hex(40),
  createdAt: isoTimestamp,
  runtimeRoot: v.string(),
  authorityPath: v.string(),
  bindingFileDigest: hex(64),
  memoryMode: v.literal('active'),
  schemaVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
  preSoakBackupPath: v.string(),
  preSoakBackupDigest: hex(64),
  /** Never committed: it is the only thing that links a redacted report back to real records. */
  redactionKey: hex(64),
  scenarios: v.pipe(v.array(v.picklist(scenarioIds)), v.minLength(scenarioIds.length)),
})

/** Private per-run state produced by `prepare`; it holds the redaction key and must stay out of version control. */
export type SoakRunState = v.InferOutput<typeof runStateSchema>

const attestationSchema = v.strictObject({
  format: v.literal(1),
  runId: v.string(),
  commitSha: hex(40),
  reviewerIndependent: v.literal(true),
  scenarios: v.array(v.strictObject({
    id: v.picklist(scenarioIds),
    from: isoTimestamp,
    to: isoTimestamp,
    /** The human observation is authoritative for anything a database cannot show: audible playback and semantic recall. */
    observed: v.picklist(['pass', 'fail']),
    note: v.optional(v.pipe(v.string(), v.maxLength(280))),
  })),
  rollbackDrillPassed: v.boolean(),
  deletionVerified: v.boolean(),
  oldBackupRestoreVerified: v.boolean(),
})

/** Operator-authored observations for facts no durable record can prove. */
export type SoakAttestation = v.InferOutput<typeof attestationSchema>

export function parseRunState(input: unknown): SoakRunState {
  try {
    return v.parse(runStateSchema, input)
  }
  catch (cause) {
    throw new MemoryError('INVALID_PAYLOAD', 'soak run state is invalid or was produced by a different tool version', { cause })
  }
}

export function parseAttestation(input: unknown): SoakAttestation {
  try {
    return v.parse(attestationSchema, input)
  }
  catch (cause) {
    throw new MemoryError('INVALID_PAYLOAD', 'soak attestation is invalid or incomplete', { cause })
  }
}

/**
 * Rejects any binding specification that could carry soak traffic outside one
 * private guild.
 *
 * `parseRoomBindingFile` already refuses DM bindings and per-binding guild
 * crossing. This adds the soak-specific rule: the whole file must stay inside a
 * single guild, so evidence cannot mix a private test guild with a real one.
 */
export function assertPrivateGuildSoakBinding(bindings: readonly { readonly locations: readonly { readonly guildId?: string }[] }[]): void {
  if (bindings.length === 0)
    throw new MemoryError('POLICY_VIOLATION', 'the binding specification must declare at least one binding')
  const guilds = new Set(bindings.flatMap(binding => binding.locations.map(location => location.guildId ?? 'dm')))
  if (guilds.size !== 1 || guilds.has('dm'))
    throw new MemoryError('POLICY_VIOLATION', 'the soak binding specification must be confined to exactly one private guild and must not bind DMs')
}

/**
 * Builds the run-scoped identifier redactor.
 *
 * Raw identifiers are HMAC'd rather than plainly hashed so that a published
 * report cannot be attacked by hashing candidate Discord snowflakes, which come
 * from a small enough space to enumerate.
 *
 * Before:
 * - `"configured:logical-room:9f2c…"`
 *
 * After:
 * - `"room:1b7d4e0a9c3f5628"`
 */
export function createRedactor(redactionKey: string): (kind: string, rawId: string) => string {
  return (kind, rawId) => `${kind}:${createHmac('sha256', Buffer.from(redactionKey, 'hex')).update(`${kind}\0${rawId}`).digest('hex').slice(0, 16)}`
}

export interface SoakAssertion {
  readonly id: string
  readonly passed: boolean
  /** Redacted identifiers of the records that failed, so a reviewer can ask the operator to look them up privately. */
  readonly offenders: readonly string[]
}

export interface SoakReport {
  readonly format: 1
  readonly runId: string
  readonly commitSha: string
  readonly schemaVersion: number
  readonly memoryMode: 'active'
  readonly bindingFileDigest: string
  readonly generatedAt: string
  readonly window: { readonly from: string, readonly to: string }
  readonly counts: Readonly<Record<string, number>>
  readonly assertions: readonly SoakAssertion[]
  readonly scenarios: readonly {
    readonly id: SoakScenarioId
    readonly observed: 'pass' | 'fail'
    readonly window: { readonly from: string, readonly to: string }
    readonly generations: number
    readonly deliveries: number
  }[]
  readonly unresolvedDeliveries: readonly string[]
  readonly deletion: { readonly forgetRequests: number, readonly tombstones: number, readonly verified: boolean }
  readonly restore: { readonly oldBackupRestoreVerified: boolean }
  readonly rollback: { readonly drillPassed: boolean }
}

type Row = Record<string, string | number | null>

/**
 * The minimal read-only query surface the report needs.
 *
 * Declaring the port here rather than importing the SQLite driver keeps the
 * Discord runtime source free of a database dependency, which `memory-sqlite`'s
 * public boundary test enforces by scanning this directory. An opened
 * memory-sqlite handle satisfies the port structurally, so the operator CLI —
 * which lives outside that boundary — can pass one directly.
 */
export interface SoakEvidenceReader {
  prepare: (sql: string) => {
    get: (...params: readonly (string | number)[]) => unknown
    all: (...params: readonly (string | number)[]) => unknown[]
  }
}

function rows(reader: SoakEvidenceReader, sql: string, ...params: readonly (string | number)[]): Row[] {
  return reader.prepare(sql).all(...params) as Row[]
}

function row(reader: SoakEvidenceReader, sql: string, ...params: readonly (string | number)[]): Row | undefined {
  return reader.prepare(sql).get(...params) as Row | undefined
}

function count(reader: SoakEvidenceReader, table: string): number {
  return Number(row(reader, `SELECT count(*) count FROM ${table}`)?.count ?? 0)
}

/**
 * Correlates durable records with operator attestations and returns a
 * content-free report.
 *
 * The database is only ever read for identifiers, states, timestamps, and
 * counts. Text-bearing columns (`payload_json`, `exact_text`, display names,
 * provider payloads) are never selected, so redaction cannot be defeated by a
 * column that was forgotten downstream.
 */
export function buildSoakReport(input: {
  database: SoakEvidenceReader
  runState: SoakRunState
  attestation: SoakAttestation
  generatedAt: string
}): SoakReport {
  const { database, runState, attestation, generatedAt } = input
  if (attestation.runId !== runState.runId)
    throw new MemoryError('POLICY_VIOLATION', 'attestation belongs to a different soak run')
  if (attestation.commitSha !== runState.commitSha)
    throw new MemoryError('POLICY_VIOLATION', 'attestation and run state disagree about the candidate commit')

  const redact = createRedactor(runState.redactionKey)
  const generations = rows(database, 'SELECT generation_id,logical_room_id,character_id,current_state,observed_room_version,context_manifest_hash,observed_binding_version,captured_at,started_at FROM generation_attempt_records ORDER BY started_at,generation_id')

  // A generation without a manifest row is exactly the failure A8 exists to
  // rule out: a model call that ran without durable pre-model evidence.
  const missingManifest: string[] = []
  const staleEvidence: string[] = []
  const badDigest: string[] = []
  const leakedScope: string[] = []

  for (const generation of generations) {
    const generationId = String(generation.generation_id)
    const header = row(database, 'SELECT format_version,logical_room_version,binding_revision,max_items,max_characters,candidate_read_limit,truncated FROM generation_context_manifests WHERE generation_id=?', generationId)
    if (!header) {
      missingManifest.push(redact('generation', generationId))
      continue
    }

    // Evidence must be captured before the model starts, never backfilled after it returns.
    if (Date.parse(String(generation.captured_at)) > Date.parse(String(generation.started_at)))
      staleEvidence.push(redact('generation', generationId))

    const items = rows(database, 'SELECT ordinal,source_type,inbound_event_id,output_segment_id,delivery_id,delivery_state,delivery_state_at FROM generation_context_manifest_items WHERE generation_id=? ORDER BY ordinal', generationId)
    const manifest = {
      formatVersion: 1 as const,
      logicalRoomVersion: Number(header.logical_room_version),
      bindingRevision: Number(header.binding_revision),
      maxItems: Number(header.max_items),
      maxCharacters: Number(header.max_characters),
      candidateReadLimit: Number(header.candidate_read_limit),
      truncated: Boolean(header.truncated),
      items: items.map(item => item.source_type === 'inbound'
        ? { sourceType: 'inbound' as const, eventId: String(item.inbound_event_id) as never }
        : { sourceType: 'assistant_output' as const, segmentId: String(item.output_segment_id) as never, deliveryId: String(item.delivery_id) as never, deliveryState: String(item.delivery_state) as never, deliveryStateAt: String(item.delivery_state_at) as never }),
    }
    if (digestSnapshotContextManifest(manifest) !== String(generation.context_manifest_hash))
      badDigest.push(redact('generation', generationId))

    // Every selected record must belong to the generation's own logical room;
    // a mismatch here is the cross-room leak the soak must fail on.
    for (const item of items) {
      const source = item.source_type === 'inbound'
        ? row(database, 'SELECT logical_room_id FROM inbound_event_records WHERE event_id=?', String(item.inbound_event_id))
        : row(database, 'SELECT g.logical_room_id FROM output_segment_records s JOIN generation_attempt_records g ON g.generation_id=s.generation_id WHERE s.segment_id=?', String(item.output_segment_id))
      if (source?.logical_room_id == null || String(source.logical_room_id) !== String(generation.logical_room_id)) {
        leakedScope.push(redact('generation', generationId))
        break
      }
    }
  }

  const unresolvedStates = ['pending', 'delivering', 'unknownAfterCrash']
  const unresolved = rows(database, `SELECT delivery_id FROM delivery_attempt_records WHERE current_state IN (${unresolvedStates.map(() => '?').join(',')}) ORDER BY delivery_id`, ...unresolvedStates)
    .map(record => redact('delivery', String(record.delivery_id)))

  const semanticWrites = count(database, 'semantic_memories')
  const forgetRequests = count(database, 'forget_requests')
  const tombstones = count(database, 'deletion_tombstones')
  const unverifiedTombstones = rows(database, 'SELECT tombstone_id FROM deletion_tombstones WHERE redaction_state<>\'verified\'').map(record => redact('tombstone', String(record.tombstone_id)))

  const scenarios = attestation.scenarios.map((scenario) => {
    const inWindow = (table: string, column: string) => Number(row(database, `SELECT count(*) count FROM ${table} WHERE ${column}>=? AND ${column}<=?`, scenario.from, scenario.to)?.count ?? 0)
    return {
      id: scenario.id,
      observed: scenario.observed,
      window: { from: scenario.from, to: scenario.to },
      generations: inWindow('generation_attempt_records', 'started_at'),
      deliveries: inWindow('delivery_attempt_records', 'started_at'),
    }
  })

  const windows = attestation.scenarios.flatMap(scenario => [scenario.from, scenario.to]).sort()

  return {
    format: 1,
    runId: runState.runId,
    commitSha: runState.commitSha,
    schemaVersion: runState.schemaVersion,
    memoryMode: runState.memoryMode,
    bindingFileDigest: runState.bindingFileDigest,
    generatedAt,
    window: { from: windows[0] ?? runState.createdAt, to: windows.at(-1) ?? generatedAt },
    counts: Object.freeze({
      inboundEvents: count(database, 'inbound_event_records'),
      generations: generations.length,
      manifests: count(database, 'generation_context_manifests'),
      manifestItems: count(database, 'generation_context_manifest_items'),
      outputSegments: count(database, 'output_segment_records'),
      deliveries: count(database, 'delivery_attempt_records'),
      roomBindings: count(database, 'room_binding_records'),
      semanticMemories: semanticWrites,
      privacyOperations: count(database, 'privacy_operation_records'),
    }),
    assertions: Object.freeze([
      { id: 'every-generation-has-pre-model-manifest', passed: missingManifest.length === 0, offenders: Object.freeze(missingManifest) },
      { id: 'evidence-captured-before-model-start', passed: staleEvidence.length === 0, offenders: Object.freeze(staleEvidence) },
      { id: 'manifest-digest-reconstructs', passed: badDigest.length === 0, offenders: Object.freeze(badDigest) },
      { id: 'manifest-items-stay-in-room', passed: leakedScope.length === 0, offenders: Object.freeze(leakedScope) },
      { id: 'no-unresolved-deliveries', passed: unresolved.length === 0, offenders: Object.freeze(unresolved) },
      { id: 'zero-semantic-writes', passed: semanticWrites === 0, offenders: Object.freeze([]) },
      { id: 'tombstones-verified', passed: unverifiedTombstones.length === 0, offenders: Object.freeze(unverifiedTombstones) },
    ]),
    scenarios: Object.freeze(scenarios),
    unresolvedDeliveries: Object.freeze(unresolved),
    deletion: { forgetRequests, tombstones, verified: attestation.deletionVerified && unverifiedTombstones.length === 0 },
    restore: { oldBackupRestoreVerified: attestation.oldBackupRestoreVerified },
    rollback: { drillPassed: attestation.rollbackDrillPassed },
  }
}

/**
 * Shapes that can never legitimately appear anywhere in a report.
 *
 * These are matched against the whole serialized report, so they must not
 * collide with the tool's own static strings. Bare word fragments such as
 * `generation-` are deliberately excluded: assertion ids like
 * `every-generation-has-pre-model-manifest` would false-positive, which would
 * make the redaction check unusable and train reviewers to ignore it. Raw
 * identifier leakage is instead caught positively by {@link redactedShape}.
 */
const prohibited: readonly { readonly id: string, readonly pattern: RegExp }[] = Object.freeze([
  { id: 'discord-snowflake', pattern: /\b\d{17,20}\b/ },
  { id: 'uuid', pattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i },
  // `discord:guild:…`, `discord:dm:…`, and `configured:…` are the durable
  // identifier prefixes the runtime mints; they expose room and binding topology.
  { id: 'raw-durable-identifier', pattern: /(?:^|["\s])(?:configured:|discord:(?:guild|dm):)/ },
])

/** Every identifier a report publishes must be a run-scoped HMAC, never a raw durable id. */
const redactedShape = /^[a-z]+:[0-9a-f]{16}$/

export interface SoakVerdict { readonly ok: boolean, readonly failures: readonly string[] }

const reportSchema = v.strictObject({
  format: v.literal(1),
  runId: v.string(),
  commitSha: hex(40),
  schemaVersion: v.pipe(v.number(), v.integer()),
  memoryMode: v.string(),
  bindingFileDigest: hex(64),
  generatedAt: isoTimestamp,
  window: v.strictObject({ from: isoTimestamp, to: isoTimestamp }),
  counts: v.record(v.string(), v.number()),
  assertions: v.array(v.strictObject({ id: v.string(), passed: v.boolean(), offenders: v.array(v.string()) })),
  scenarios: v.array(v.strictObject({
    id: v.picklist(scenarioIds),
    observed: v.picklist(['pass', 'fail']),
    window: v.strictObject({ from: isoTimestamp, to: isoTimestamp }),
    generations: v.number(),
    deliveries: v.number(),
  })),
  unresolvedDeliveries: v.array(v.string()),
  deletion: v.strictObject({ forgetRequests: v.number(), tombstones: v.number(), verified: v.boolean() }),
  restore: v.strictObject({ oldBackupRestoreVerified: v.boolean() }),
  rollback: v.strictObject({ drillPassed: v.boolean() }),
})

/**
 * Applies the acceptance rules to a report a reviewer received.
 *
 * `expectedCommitSha` is supplied by the caller from the checkout being
 * promoted, so a report generated at a different commit can never qualify it.
 */
export function verifySoakReport(input: { report: unknown, expectedCommitSha: string, expectedSchemaVersion: number }): SoakVerdict {
  const failures: string[] = []
  let report: SoakReport
  try {
    report = v.parse(reportSchema, input.report) as SoakReport
  }
  catch {
    return { ok: false, failures: ['report does not match the expected schema'] }
  }

  if (report.commitSha !== input.expectedCommitSha)
    failures.push(`report commit ${report.commitSha} does not match the reviewed commit ${input.expectedCommitSha}`)
  if (report.schemaVersion !== input.expectedSchemaVersion)
    failures.push(`report schema version ${report.schemaVersion} does not match the current schema ${input.expectedSchemaVersion}`)
  if (report.memoryMode !== 'active')
    failures.push('report was not produced from an active-mode run')

  const attested = new Set(report.scenarios.map(scenario => scenario.id))
  for (const scenario of SOAK_SCENARIOS) {
    if (!attested.has(scenario.id))
      failures.push(`scenario ${scenario.id} has no human attestation`)
  }
  for (const scenario of report.scenarios) {
    if (scenario.observed !== 'pass')
      failures.push(`scenario ${scenario.id} was observed as failed`)
  }

  for (const assertion of report.assertions) {
    if (!assertion.passed)
      failures.push(`machine assertion ${assertion.id} failed for ${assertion.offenders.length} record(s)`)
  }

  // Durable evidence without a visible or audible delivery fails, and so does
  // the reverse: an attested scenario that produced no durable generation.
  for (const scenario of report.scenarios) {
    const expectsGeneration = scenario.id !== 'active-to-off-rollback' && scenario.id !== 'startup-binding-reconciliation' && scenario.id !== 'disabled-remember-correct'
    if (expectsGeneration && scenario.generations === 0)
      failures.push(`scenario ${scenario.id} was attested but produced no durable generation`)
  }
  const rollback = report.scenarios.find(scenario => scenario.id === 'active-to-off-rollback')
  if (rollback && rollback.generations > 0)
    failures.push('active-to-off rollback window contains durable generation evidence')

  if (report.unresolvedDeliveries.length > 0)
    failures.push(`${report.unresolvedDeliveries.length} delivery attempt(s) remain unresolved`)
  if (!report.deletion.verified)
    failures.push('deletion evidence was not verified')
  if (!report.restore.oldBackupRestoreVerified)
    failures.push('old-backup restore was not verified')
  if (!report.rollback.drillPassed)
    failures.push('active-to-off rollback drill did not pass')

  const publishedIdentifiers = [...report.assertions.flatMap(assertion => assertion.offenders), ...report.unresolvedDeliveries]
  for (const identifier of publishedIdentifiers) {
    if (!redactedShape.test(identifier))
      failures.push(`report publishes identifier ${JSON.stringify(identifier)} that is not a run-scoped redaction`)
  }

  const serialized = JSON.stringify(report)
  for (const rule of prohibited) {
    if (rule.pattern.test(serialized))
      failures.push(`report contains prohibited ${rule.id} content`)
  }

  return { ok: failures.length === 0, failures: Object.freeze(failures) }
}
