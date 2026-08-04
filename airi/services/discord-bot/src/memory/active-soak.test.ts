import type { DatabaseSync } from 'node:sqlite'

import type { GenerationAttempt } from '@proj-airi/memory-domain'

import type { SoakAttestation, SoakRunState, SoakScenarioId } from './active-soak'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asCharacterId, asGenerationId, asPersonId, asRequestId, asTimestamp, attributedActor } from '@proj-airi/memory-domain'
import { EventRepository, GenerationRepository, migrate, RoomRepository } from '@proj-airi/memory-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assertPrivateGuildSoakBinding, buildSoakReport, createRedactor, parseAttestation, parseRunState, scenarioCoverageFailures, SOAK_SCENARIOS, verifySoakReport } from './active-soak'

let db: DatabaseSync
let sequence: number
let room: ReturnType<typeof createRoom> | undefined

const time = (second: number) => asTimestamp(`2026-08-02T10:00:${String(second).padStart(2, '0')}.000Z`)
const characterId = asCharacterId('character-a')
const location = { platform: 'discord' as const, guildId: '99999999999999999', channelId: '18446744073709551615', channelKind: 'guildText' as const }
const commitSha = 'a'.repeat(40)
const redactionKey = 'b'.repeat(64)
const backupDigest = 'd'.repeat(64)

/** Scenarios the verifier does not expect to produce a durable generation. */
const GENERATION_FREE_SCENARIOS = new Set<string>(['startup-binding-reconciliation', 'disabled-remember-correct', 'active-to-off-rollback'])

const scenarioOrder = new Map<string, number>(SOAK_SCENARIOS.map((scenario, index) => [scenario.id, index]))

/**
 * Gives each scenario a distinct three-second window separated by a one-second
 * gap. Both window queries are inclusive, so touching windows would let one
 * durable record answer two scenario-presence checks.
 */
function scenarioWindow(id: string) {
  const start = (scenarioOrder.get(id) ?? 0) * 4
  return { from: time(start), to: time(start + 2) }
}

/** The instant inside a scenario's own window where that scenario's durable records are written. */
function scenarioInstant(id: string) {
  return time((scenarioOrder.get(id) ?? 0) * 4 + 1)
}

beforeEach(() => {
  db = new SQLiteDatabase(':memory:')
  migrate(db)
  db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run('person-a', '18446744073709551615', time(0), 'account_subject', time(0))
  sequence = 0
  room = undefined
})
afterEach(() => db.close())

function runState(overrides: Partial<SoakRunState> = {}): SoakRunState {
  return parseRunState({
    format: 1,
    runId: 'soak-001',
    commitSha,
    createdAt: time(0),
    runtimeRoot: '/isolated/memory',
    authorityPath: '/isolated/memory/authority/memory.sqlite',
    bindingFileDigest: 'c'.repeat(64),
    memoryMode: 'active',
    schemaVersion: 8,
    preSoakBackupPath: '/isolated/out/soak-001.pre-soak.db',
    preSoakBackupDigest: backupDigest,
    redactionKey,
    scenarios: SOAK_SCENARIOS.map(scenario => scenario.id),
    ...overrides,
  })
}

function attestedScenarios() {
  return SOAK_SCENARIOS.map(scenario => ({ id: scenario.id, ...scenarioWindow(scenario.id), observed: 'pass' as const }))
}

/** The attestation shape before parsing, so coverage rejections can be exercised. */
function rawAttestation(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    runId: 'soak-001',
    commitSha,
    scenarios: attestedScenarios(),
    rollbackDrillPassed: true,
    deletionVerified: true,
    oldBackupRestoreVerified: true,
    ...overrides,
  }
}

function attestation(overrides: Partial<SoakAttestation> = {}): SoakAttestation {
  return parseAttestation(rawAttestation(overrides))
}

function createRoom() {
  const rooms = new RoomRepository(db)
  return {
    physicalRoomId: rooms.observe({ location, observedAt: time(0) }).physicalRoomId,
    logicalRoomId: rooms.resolve(location, characterId, time(0)).logicalRoomId,
  }
}

/** Every seeded generation shares one bound room, so `manifest-items-stay-in-room` stays meaningful. */
function ensureRoom() {
  room ??= createRoom()
  return room
}

/** Persists one durable generation with a complete pre-model manifest inside the given scenario's window. */
function seedGeneration(scenarioId: string = 'empty-history-text'): GenerationAttempt {
  const { physicalRoomId, logicalRoomId } = ensureRoom()
  const capturedAt = scenarioWindow(scenarioId).from
  const startedAt = scenarioInstant(scenarioId)
  const actor = attributedActor(asPersonId('person-a'), { platform: 'discord', platformUserId: '18446744073709551615', displayNameAtEvent: 'Alice', guildId: location.guildId, observedAt: time(0), source: 'gateway' })
  const events = new EventRepository(db, () => `event-${++sequence}`, () => capturedAt)
  const event = events.append({ idempotencyKey: asRequestId(`event-key-${scenarioId}`), kind: 'user_text', actor, physicalRoomId, logicalRoomId, occurredAt: capturedAt, payload: { content: 'hello' }, retentionClass: 'transcript' }).envelope
  // Each appended event advances the durable room version, and a generation may
  // only claim the current one; seeding several scenarios means re-reading it.
  const roomVersion = Number((db.prepare('SELECT current_version FROM logical_rooms WHERE logical_room_id=?').get(logicalRoomId) as { current_version: number }).current_version)
  const attempt: GenerationAttempt = {
    generationId: asGenerationId(`generation-${scenarioId}`),
    idempotencyKey: asRequestId(`generation-key-${scenarioId}`),
    logicalRoomId,
    characterId,
    state: 'prepared',
    evidence: {
      observedRoomVersion: roomVersion,
      observedEventIds: [event.eventId],
      contextManifestHash: '',
      contextManifest: { formatVersion: 1, logicalRoomVersion: roomVersion, bindingRevision: 0, maxItems: 24, maxCharacters: 8_000, candidateReadLimit: 96, truncated: false, items: [{ sourceType: 'inbound', eventId: event.eventId }] },
      observedBindingVersion: 0,
      capturedAt,
    },
    modelRef: 'provider/model/prompt-v1',
    startedAt,
  }
  return new GenerationRepository(db, () => `transition-${++sequence}`).create(attempt).attempt
}

/** Seeds one generation for every scenario the verifier expects durable generation evidence from. */
function seedScenarioGenerations(): void {
  for (const scenario of SOAK_SCENARIOS) {
    if (!GENERATION_FREE_SCENARIOS.has(scenario.id))
      seedGeneration(scenario.id)
  }
}

/** Writes the durable forget request and verified tombstone that scenario 12 must produce. */
function seedDeletionEvidence(at = scenarioInstant('forget-deletion-migration-replay')): void {
  db.prepare('INSERT INTO forget_requests(forget_request_id,subject_type,subject_id,scope_json,requested_at,status,version,completed_at,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?)')
    .run('forget-1', 'fact_id', 'memory-canary', '{}', at, 'completed', 1, at, 'forget-idem-1')
  db.prepare('INSERT INTO deletion_tombstones(tombstone_id,forget_request_id,target_table,target_id,redaction_state,created_at,verified_at) VALUES (?,?,?,?,?,?,?)')
    .run('tombstone-1', 'forget-1', 'semantic_memories', 'memory-canary', 'verified', at, at)
}

describe('active soak run state and attestation', () => {
  it('rejects a malformed run identity, a short commit, and an unknown scenario', () => {
    expect(() => runState({ runId: 'x' } as never)).toThrow(/invalid/i)
    expect(() => runState({ commitSha: 'abc' } as never)).toThrow(/invalid/i)
    expect(() => parseRunState({ ...runState(), scenarios: ['not-a-scenario'] })).toThrow(/invalid/i)
  })

  // The independence gate was removed for single-operator deployments. The
  // schema is strict, so a stale attestation still carrying the field is
  // refused rather than silently accepted — which keeps a report from being
  // produced from a document that still claims an independent review.
  it('refuses an attestation still carrying the removed independent-reviewer declaration', () => {
    expect(() => parseAttestation(rawAttestation({ reviewerIndependenceDeclared: true }))).toThrow(/invalid or incomplete/i)
  })

  it('accepts an attestation that makes no independence claim at all', () => {
    expect(() => parseAttestation(rawAttestation())).not.toThrow()
  })

  it('refuses to report when the attestation belongs to a different run or commit', () => {
    seedGeneration()
    expect(() => buildSoakReport({ database: db, runState: runState(), attestation: attestation({ runId: 'other-run' }), generatedAt: time(59) })).toThrow(/different soak run/)
    expect(() => buildSoakReport({ database: db, runState: runState(), attestation: attestation({ commitSha: 'f'.repeat(40) }), generatedAt: time(59) })).toThrow(/candidate commit/)
  })
})

describe('active soak scenario coverage', () => {
  it('accepts exactly one non-overlapping window per scenario', () => {
    expect(scenarioCoverageFailures(attestedScenarios())).toEqual([])
  })

  it('rejects a scenario attested twice', () => {
    const duplicated = [...attestedScenarios(), { id: 'dm-isolation' as SoakScenarioId, ...scenarioWindow('dm-isolation'), observed: 'pass' as const }]

    expect(() => parseAttestation(rawAttestation({ scenarios: duplicated }))).toThrow(/dm-isolation is attested 2 times/)
  })

  it('rejects a window that does not start before it ends', () => {
    const reversed = attestedScenarios().map(scenario => scenario.id === 'restart-continuity' ? { ...scenario, from: scenario.to, to: scenario.from } : scenario)

    expect(() => parseAttestation(rawAttestation({ scenarios: reversed }))).toThrow(/restart-continuity window does not start strictly before it ends/)
  })

  it('rejects two scenarios that share an execution window', () => {
    const overlapping = attestedScenarios().map(scenario => scenario.id === 'dm-isolation' ? { ...scenario, ...scenarioWindow('unbound-guild-isolation') } : scenario)

    expect(() => parseAttestation(rawAttestation({ scenarios: overlapping }))).toThrow(/overlap; each scenario needs its own execution window/)
  })

  it('rejects windows that merely touch, because both range queries are inclusive', () => {
    const touching = attestedScenarios().map(scenario => scenario.id === 'dm-isolation' ? { ...scenario, from: scenarioWindow('unbound-guild-isolation').to } : scenario)

    expect(scenarioCoverageFailures(touching)).toContainEqual(expect.stringContaining('overlap'))
  })
})

describe('active soak binding specification guard', () => {
  const guild = (guildId: string) => ({ locations: [{ guildId }, { guildId }] })

  it('accepts a specification confined to one private guild', () => {
    expect(() => assertPrivateGuildSoakBinding([guild('99999999999999999'), guild('99999999999999999')])).not.toThrow()
  })

  it('refuses an empty specification, a second guild, and any DM location', () => {
    expect(() => assertPrivateGuildSoakBinding([])).toThrow(/at least one binding/)
    expect(() => assertPrivateGuildSoakBinding([guild('99999999999999999'), guild('88888888888888888')])).toThrow(/exactly one private guild/)
    expect(() => assertPrivateGuildSoakBinding([{ locations: [{}] }])).toThrow(/must not bind DMs/)
  })
})

describe('active soak identifier redaction', () => {
  it('is stable within a run and unlinkable across runs', () => {
    const first = createRedactor(redactionKey)
    const second = createRedactor(redactionKey)
    const other = createRedactor('e'.repeat(64))

    expect(first('generation', 'generation-a')).toBe(second('generation', 'generation-a'))
    expect(first('generation', 'generation-a')).not.toBe(other('generation', 'generation-a'))
    // Kind is part of the HMAC input, so the same raw string in two roles does not correlate.
    expect(first('generation', 'shared-id')).not.toBe(first('delivery', 'shared-id'))
    expect(first('generation', 'generation-a')).toMatch(/^generation:[0-9a-f]{16}$/)
  })

  it('keeps raw identifiers out of the emitted report', () => {
    seedGeneration()
    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })
    const serialized = JSON.stringify(report)

    expect(serialized).not.toContain('generation-empty-history-text')
    expect(serialized).not.toContain('event-1')
    expect(serialized).not.toContain(location.guildId)
    expect(serialized).not.toContain(location.channelId)
    expect(serialized).not.toContain('hello')
  })

  it('publishes the pre-soak backup digest but never its path', () => {
    seedGeneration()
    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })

    expect(report.preSoakBackupDigest).toBe(backupDigest)
    expect(JSON.stringify(report)).not.toContain('pre-soak.db')
  })
})

describe('active soak machine assertions', () => {
  it('passes every assertion for a generation with complete pre-model evidence', () => {
    seedGeneration()
    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })

    expect(report.assertions.filter(item => !item.passed)).toEqual([])
    expect(report.counts.generations).toBe(1)
    expect(report.counts.manifests).toBe(1)
    expect(report.counts.manifestItems).toBe(1)
  })

  it('fails when a model call has no durable manifest', () => {
    const attempt = seedGeneration()
    db.exec('PRAGMA foreign_keys=OFF')
    db.prepare('DELETE FROM generation_context_manifest_items WHERE generation_id=?').run(attempt.generationId)
    db.prepare('DELETE FROM generation_context_manifests WHERE generation_id=?').run(attempt.generationId)

    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })
    const assertion = report.assertions.find(item => item.id === 'every-generation-has-pre-model-manifest')

    expect(assertion?.passed).toBe(false)
    expect(assertion?.offenders).toHaveLength(1)
  })

  it('fails when a persisted manifest no longer reconstructs its digest', () => {
    const attempt = seedGeneration()
    db.prepare('UPDATE generation_context_manifests SET max_items=? WHERE generation_id=?').run(999, attempt.generationId)

    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })

    expect(report.assertions.find(item => item.id === 'manifest-digest-reconstructs')?.passed).toBe(false)
  })

  it('fails when evidence was captured after the model started', () => {
    const attempt = seedGeneration()
    db.prepare('UPDATE generation_attempt_records SET captured_at=? WHERE generation_id=?').run(time(58), attempt.generationId)

    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })

    expect(report.assertions.find(item => item.id === 'evidence-captured-before-model-start')?.passed).toBe(false)
  })
})

describe('active soak deletion evidence', () => {
  it('counts only forget and tombstone records written inside the deletion scenario window', () => {
    seedScenarioGenerations()
    // Written during scenario 2's window, which is where an earlier run's
    // leftover deletion records would sit relative to this run's scenario 12.
    seedDeletionEvidence(scenarioInstant('empty-history-text'))

    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })

    expect(report.deletion.forgetRequests).toBe(0)
    expect(report.deletion.tombstones).toBe(0)
    expect(report.counts.forgetRequests).toBe(1)
    expect(report.counts.deletionTombstones).toBe(1)
  })
})

describe('active soak verification', () => {
  function seedCompleteRun(): void {
    seedScenarioGenerations()
    seedDeletionEvidence()
  }

  function buildReport(overrides: Partial<SoakAttestation> = {}) {
    return buildSoakReport({ database: db, runState: runState(), attestation: attestation(overrides), generatedAt: time(59) })
  }

  function reportFor(overrides: Partial<SoakAttestation> = {}) {
    seedCompleteRun()
    return buildReport(overrides)
  }

  it('accepts a complete, passing report at the reviewed commit', () => {
    expect(verifySoakReport({ report: reportFor(), expectedCommitSha: commitSha, expectedSchemaVersion: 8 })).toEqual({ ok: true, failures: [] })
  })

  it('rejects a report generated at a different commit or schema version', () => {
    const report = reportFor()

    expect(verifySoakReport({ report, expectedCommitSha: 'f'.repeat(40), expectedSchemaVersion: 8 }).failures).toContainEqual(expect.stringContaining('does not match the reviewed commit'))
    expect(verifySoakReport({ report, expectedCommitSha: commitSha, expectedSchemaVersion: 9 }).failures).toContainEqual(expect.stringContaining('does not match the current schema'))
  })

  it('rejects a report that omits a required scenario attestation', () => {
    const complete = reportFor()
    const report = { ...complete, scenarios: complete.scenarios.slice(0, 4) }

    const verdict = verifySoakReport({ report, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual(expect.stringContaining('has no human attestation'))
  })

  it('rejects a report whose scenario windows overlap', () => {
    const report = reportFor()
    const isolationWindow = report.scenarios.find(scenario => scenario.id === 'unbound-guild-isolation')!.window
    const overlapped = { ...report, scenarios: report.scenarios.map(scenario => scenario.id === 'dm-isolation' ? { ...scenario, window: isolationWindow } : scenario) }

    const verdict = verifySoakReport({ report: overlapped, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual(expect.stringContaining('overlap'))
  })

  it('rejects a scenario the human observed as failed even when machine evidence passes', () => {
    const report = reportFor({ scenarios: attestedScenarios().map(scenario => ({ ...scenario, observed: scenario.id === 'bound-text-voice-recall' ? 'fail' as const : 'pass' as const })) })

    const verdict = verifySoakReport({ report, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual('scenario bound-text-voice-recall was observed as failed')
  })

  it('rejects a deletion scenario that produced no forget request or tombstone', () => {
    seedScenarioGenerations()
    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(59) })

    const verdict = verifySoakReport({ report, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual('the deletion scenario window contains no durable forget request')
    expect(verdict.failures).toContainEqual('the deletion scenario window contains no durable deletion tombstone')
  })

  it('rejects unverified deletion, unverified old-backup restore, and a failed rollback drill', () => {
    seedCompleteRun()
    for (const [key, expected] of [['deletionVerified', 'deletion evidence was not verified'], ['oldBackupRestoreVerified', 'old-backup restore was not verified'], ['rollbackDrillPassed', 'active-to-off rollback drill did not pass']] as const) {
      const verdict = verifySoakReport({ report: buildReport({ [key]: false }), expectedCommitSha: commitSha, expectedSchemaVersion: 8 })
      expect(verdict.failures).toContainEqual(expected)
    }
  })

  it('rejects a report carrying raw Discord identifiers', () => {
    const report = { ...reportFor(), unresolvedDeliveries: ['18446744073709551615'] }

    const verdict = verifySoakReport({ report, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual('report contains prohibited discord-snowflake content')
  })

  it('rejects durable generation evidence recorded inside the active-to-off rollback window', () => {
    const report = reportFor()
    const rolled = { ...report, scenarios: report.scenarios.map(scenario => scenario.id === 'active-to-off-rollback' ? { ...scenario, generations: 1 } : scenario) }

    const verdict = verifySoakReport({ report: rolled, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual('active-to-off rollback window contains durable generation evidence')
  })

  it('rejects a structurally invalid report instead of trusting it', () => {
    expect(verifySoakReport({ report: { format: 1 }, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })).toEqual({ ok: false, failures: ['report does not match the expected schema'] })
  })
})
