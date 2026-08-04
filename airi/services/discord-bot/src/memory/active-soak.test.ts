import type { DatabaseSync } from 'node:sqlite'

import type { GenerationAttempt } from '@proj-airi/memory-domain'

import type { SoakAttestation, SoakRunState } from './active-soak'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asCharacterId, asGenerationId, asPersonId, asRequestId, asTimestamp, attributedActor } from '@proj-airi/memory-domain'
import { EventRepository, GenerationRepository, migrate, RoomRepository } from '@proj-airi/memory-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { assertPrivateGuildSoakBinding, buildSoakReport, createRedactor, parseAttestation, parseRunState, SOAK_SCENARIOS, verifySoakReport } from './active-soak'

let db: DatabaseSync

const time = (second: number) => asTimestamp(`2026-08-02T10:00:${String(second).padStart(2, '0')}.000Z`)
const characterId = asCharacterId('character-a')
const location = { platform: 'discord' as const, guildId: '99999999999999999', channelId: '18446744073709551615', channelKind: 'guildText' as const }
const commitSha = 'a'.repeat(40)
const redactionKey = 'b'.repeat(64)

beforeEach(() => {
  db = new SQLiteDatabase(':memory:')
  migrate(db)
  db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run('person-a', '18446744073709551615', time(0), 'account_subject', time(0))
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
    preSoakBackupDigest: 'd'.repeat(64),
    redactionKey,
    scenarios: SOAK_SCENARIOS.map(scenario => scenario.id),
    ...overrides,
  })
}

/**
 * The rollback drill runs after the bot is reconfigured to `off`, so its window
 * must not overlap the active period. Overlapping windows would let active
 * generations be miscounted as post-rollback prompt use.
 */
function scenarioWindow(id: string) {
  return id === 'active-to-off-rollback' ? { from: time(30), to: time(40) } : { from: time(0), to: time(9) }
}

function attestation(overrides: Partial<SoakAttestation> = {}): SoakAttestation {
  return parseAttestation({
    format: 1,
    runId: 'soak-001',
    commitSha,
    reviewerIndependent: true,
    scenarios: SOAK_SCENARIOS.map(scenario => ({ id: scenario.id, ...scenarioWindow(scenario.id), observed: 'pass' as const })),
    rollbackDrillPassed: true,
    deletionVerified: true,
    oldBackupRestoreVerified: true,
    ...overrides,
  })
}

/** Persists one durable generation with a complete pre-model manifest. */
function seedGeneration(): GenerationAttempt {
  const rooms = new RoomRepository(db)
  const physicalRoomId = rooms.observe({ location, observedAt: time(0) }).physicalRoomId
  const logicalRoomId = rooms.resolve(location, characterId, time(0)).logicalRoomId
  const actor = attributedActor(asPersonId('person-a'), { platform: 'discord', platformUserId: '18446744073709551615', displayNameAtEvent: 'Alice', guildId: location.guildId, observedAt: time(0), source: 'gateway' })
  let eventNo = 0
  const events = new EventRepository(db, () => `event-${++eventNo}`, () => time(1))
  const event = events.append({ idempotencyKey: asRequestId('event-key'), kind: 'user_text', actor, physicalRoomId, logicalRoomId, occurredAt: time(1), payload: { content: 'hello' }, retentionClass: 'transcript' }).envelope
  const attempt: GenerationAttempt = {
    generationId: asGenerationId('generation-a'),
    idempotencyKey: asRequestId('generation-key'),
    logicalRoomId,
    characterId,
    state: 'prepared',
    evidence: {
      observedRoomVersion: 1,
      observedEventIds: [event.eventId],
      contextManifestHash: '',
      contextManifest: { formatVersion: 1, logicalRoomVersion: 1, bindingRevision: 0, maxItems: 24, maxCharacters: 8_000, candidateReadLimit: 96, truncated: false, items: [{ sourceType: 'inbound', eventId: event.eventId }] },
      observedBindingVersion: 0,
      capturedAt: time(2),
    },
    modelRef: 'provider/model/prompt-v1',
    startedAt: time(2),
  }
  let idNo = 0
  return new GenerationRepository(db, () => `transition-${++idNo}`).create(attempt).attempt
}

describe('active soak run state and attestation', () => {
  it('rejects a malformed run identity, a short commit, and an unknown scenario', () => {
    expect(() => runState({ runId: 'x' } as never)).toThrow(/invalid/i)
    expect(() => runState({ commitSha: 'abc' } as never)).toThrow(/invalid/i)
    expect(() => parseRunState({ ...runState(), scenarios: ['not-a-scenario'] })).toThrow(/invalid/i)
  })

  it('rejects an attestation that omits the independent-reviewer declaration', () => {
    expect(() => parseAttestation({ ...attestation(), reviewerIndependent: false })).toThrow(/invalid or incomplete/i)
  })

  it('refuses to report when the attestation belongs to a different run or commit', () => {
    seedGeneration()
    expect(() => buildSoakReport({ database: db, runState: runState(), attestation: attestation({ runId: 'other-run' }), generatedAt: time(9) })).toThrow(/different soak run/)
    expect(() => buildSoakReport({ database: db, runState: runState(), attestation: attestation({ commitSha: 'f'.repeat(40) }), generatedAt: time(9) })).toThrow(/candidate commit/)
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
    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(9) })
    const serialized = JSON.stringify(report)

    expect(serialized).not.toContain('generation-a')
    expect(serialized).not.toContain('event-1')
    expect(serialized).not.toContain(location.guildId)
    expect(serialized).not.toContain(location.channelId)
    expect(serialized).not.toContain('hello')
  })
})

describe('active soak machine assertions', () => {
  it('passes every assertion for a generation with complete pre-model evidence', () => {
    seedGeneration()
    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(9) })

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

    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(9) })
    const assertion = report.assertions.find(item => item.id === 'every-generation-has-pre-model-manifest')

    expect(assertion?.passed).toBe(false)
    expect(assertion?.offenders).toHaveLength(1)
  })

  it('fails when a persisted manifest no longer reconstructs its digest', () => {
    const attempt = seedGeneration()
    db.prepare('UPDATE generation_context_manifests SET max_items=? WHERE generation_id=?').run(999, attempt.generationId)

    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(9) })

    expect(report.assertions.find(item => item.id === 'manifest-digest-reconstructs')?.passed).toBe(false)
  })

  it('fails when evidence was captured after the model started', () => {
    const attempt = seedGeneration()
    db.prepare('UPDATE generation_attempt_records SET captured_at=? WHERE generation_id=?').run(time(8), attempt.generationId)

    const report = buildSoakReport({ database: db, runState: runState(), attestation: attestation(), generatedAt: time(9) })

    expect(report.assertions.find(item => item.id === 'evidence-captured-before-model-start')?.passed).toBe(false)
  })
})

describe('active soak verification', () => {
  function reportFor(overrides: Partial<SoakAttestation> = {}) {
    seedGeneration()
    return buildSoakReport({ database: db, runState: runState(), attestation: attestation(overrides), generatedAt: time(9) })
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
    const report = reportFor({ scenarios: SOAK_SCENARIOS.slice(0, 4).map(scenario => ({ id: scenario.id, ...scenarioWindow(scenario.id), observed: 'pass' as const })) })

    const verdict = verifySoakReport({ report, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual(expect.stringContaining('has no human attestation'))
  })

  it('rejects a scenario the human observed as failed even when machine evidence passes', () => {
    const report = reportFor({ scenarios: SOAK_SCENARIOS.map(scenario => ({ id: scenario.id, ...scenarioWindow(scenario.id), observed: scenario.id === 'bound-text-voice-recall' ? 'fail' as const : 'pass' as const })) })

    const verdict = verifySoakReport({ report, expectedCommitSha: commitSha, expectedSchemaVersion: 8 })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual('scenario bound-text-voice-recall was observed as failed')
  })

  it('rejects unverified deletion, unverified old-backup restore, and a failed rollback drill', () => {
    for (const [key, expected] of [['deletionVerified', 'deletion evidence was not verified'], ['oldBackupRestoreVerified', 'old-backup restore was not verified'], ['rollbackDrillPassed', 'active-to-off rollback drill did not pass']] as const) {
      const verdict = verifySoakReport({ report: reportFor({ [key]: false }), expectedCommitSha: commitSha, expectedSchemaVersion: 8 })
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
