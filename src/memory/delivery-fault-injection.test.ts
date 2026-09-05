/* eslint-disable style/max-statements-per-line, test/prefer-lowercase-title */
import type { ChildProcess } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'

import type { MemoryRuntimeHealth } from './runtime'

import { fork } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asCharacterId, asDeliveryId, asGenerationId, asPersonId, asRequestId, asSegmentId, asTimestamp, attributedActor, isolatedLogicalRoomId, physicalRoomIdOf, provesAudibility } from '@proj-airi/memory-domain'
import { DeliveryRepository, EventRepository, GenerationRepository, openReadOnlySqliteDatabase, OutputRepository, RoomRepository } from '@proj-airi/memory-sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'

/**
 * G4 row 3 — the executable delivery fault-injection suite (artifact 18 §11.5
 * `TEST-FI-007`…`TEST-FI-013`, §11.6 `TEST-CON-011`).
 *
 * Scope note: this is deliberately *not* all 21 failure cases and 13 concurrency
 * cases from artifact 18. It is the delivery/restart subset that G4 row 3 names,
 * and nothing else. Case IDs appear in the test titles so a future audit can grep
 * an artifact-18 identifier and land on its executable counterpart.
 *
 * Controlling contract: the artifact-18 §11.5 M1 delivery-contract amendment
 * (2026-08-13). The catalog's automatic same-nonce resend is superseded for M1;
 * the invariants it protected are not. What must still hold, and what this suite
 * proves, is:
 *
 * ```text
 * no duplicate external text send
 * no blind voice replay
 * no fabricated delivered state
 * no ambiguous output admitted as an ordinary completed assistant turn
 * durable, operator-visible disposition for unresolved ambiguity
 * hard-process termination must actually be tested
 * ```
 *
 * Method. Each scenario forks a real child process (`fixtures/delivery-crash-child.ts`)
 * that drives the real adapters against a real authoritative SQLite store in a temp
 * root, reaches a named delivery boundary, parks, and is `SIGKILL`ed with no
 * graceful cleanup — artifact 18 §10.3 rules out a function that merely throws.
 * Recovery is then the *production* startup path: `createMemoryRuntime` against
 * the same store, which is where `reconcileDeliveries` runs. Nothing in the test
 * writes a delivery state, so no fake can hand the suite its own expectation.
 *
 * The fake platform and the fake player keep their own append-only logs in the
 * temp root. Those files are the independent external oracle: they survive the
 * kill, and comparing them byte-for-byte across recovery is what proves the
 * recovered process sent nothing and replayed nothing.
 */

const characterId = asCharacterId('kurisu')
const childFixture = new URL('./fixtures/delivery-crash-child.ts', import.meta.url)

const roots: string[] = []
const children: ChildProcess[] = []

afterAll(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null)
      child.kill('SIGKILL')
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function nextMessage<T extends { type: string }>(child: ChildProcess, expected: string, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`crash fixture did not report '${expected}' within ${timeoutMs} ms`)), timeoutMs)
    function settle(error?: Error, value?: T) {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('error', onError)
      error ? reject(error) : resolve(value!)
    }
    function onError(error: Error) { settle(error) }
    function onMessage(message: unknown) {
      const payload = message as T & { message?: string }
      if (payload.type === 'fixture-error')
        settle(new Error(`crash fixture failed before reaching '${expected}': ${payload.message}`))
      else if (payload.type === expected)
        settle(undefined, payload)
    }
    child.on('message', onMessage)
    child.once('error', onError)
  })
}

function exited(child: ChildProcess, timeoutMs = 30_000): Promise<{ code: number | null, signal: NodeJS.Signals | null }> {
  if (child.exitCode != null || child.signalCode != null)
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`crash fixture did not exit within ${timeoutMs} ms`)), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

/** Reach the named boundary in a real child process, then terminate it abruptly. */
async function crashAt(mode: string, root: string): Promise<{ boundary: string, code: number | null, signal: NodeJS.Signals | null }> {
  const child = fork(childFixture, [mode, root], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  children.push(child)
  const parked = await nextMessage<{ type: 'parked', boundary: string }>(child, 'parked')
  child.kill('SIGKILL')
  const { code, signal } = await exited(child)
  return { boundary: parked.boundary, code, signal }
}

interface DeliveryRow { delivery_id: string, segment_id: string, transport: string, current_state: string, current_evidence_json: string, exact_text: string }
interface Recovery {
  health: MemoryRuntimeHealth['deliveryReconciliation']
  contextText: string
  deliveries: DeliveryRow[]
  lifecycle: Record<string, string[]>
  jobs: Array<{ job_type: string, status: string, dedupe_key: string }>
  evidence: Array<{ evidence_kind: string, evidence_json: string, policy_version: string }>
  platform: string
  player: string
}

function externalLog(root: string, file: string): string {
  const path = join(root, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function rows<T>(db: DatabaseSync, sql: string, ...params: string[]): T[] {
  return db.prepare(sql).all(...params) as T[]
}

/**
 * One recovery cycle: the production startup path against the same durable store,
 * followed by a read-only inspection of what it left behind.
 *
 * The external logs are read *after* recovery finished, so a comparison against
 * the pre-crash snapshot is a real no-resend / no-replay proof rather than a
 * statement about timing.
 */
async function recover(root: string, channelKind: 'guildText' | 'guildVoice', channelId: string): Promise<Recovery> {
  const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
  const location = channelKind === 'guildVoice'
    ? { platform: 'discord' as const, guildId: '10000000000000001', channelId, channelKind: 'guildVoice' as const }
    : { platform: 'discord' as const, guildId: '10000000000000001', channelId, channelKind: 'guildText' as const }
  const physicalRoomId = physicalRoomIdOf(location)
  const logicalRoomId = isolatedLogicalRoomId(physicalRoomId, characterId)
  const authorization = { principal: { botUserId: 'discord-bot', operations: ['context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: logicalRoomId }], operator: false }, characterId, logicalRoomId }
  const context = await runtime.context!.assembleRecent({ authorization, logicalRoomId, physicalRoomId, characterId, maxItems: 50, maxCharacters: 8_000 })
  const health = runtime.health.deliveryReconciliation
  const authority = runtime.health.authority!
  await runtime.close()

  const db = openReadOnlySqliteDatabase(authority)
  const deliveries = rows<DeliveryRow>(db, 'SELECT d.delivery_id,d.segment_id,d.transport,d.current_state,d.current_evidence_json,s.exact_text FROM delivery_attempt_records d JOIN output_segment_records s ON s.segment_id=d.segment_id ORDER BY d.delivery_id')
  const lifecycle: Record<string, string[]> = {}
  for (const row of rows<{ delivery_id: string, to_state: string }>(db, 'SELECT delivery_id,to_state FROM delivery_lifecycle_records ORDER BY delivery_id,ordinal'))
    (lifecycle[row.delivery_id] ??= []).push(row.to_state)
  const jobs = rows<{ job_type: string, status: string, dedupe_key: string }>(db, 'SELECT job_type,status,dedupe_key FROM worker_jobs ORDER BY job_id')
  const evidence = rows<{ evidence_kind: string, evidence_json: string, policy_version: string }>(db, 'SELECT evidence_kind,evidence_json,policy_version FROM reconciliation_evidence_records ORDER BY job_id,ordinal')
  db.close()

  return { health, contextText: context.text, deliveries, lifecycle, jobs, evidence, platform: externalLog(root, 'fake-discord.jsonl'), player: externalLog(root, 'fake-player.jsonl') }
}

function bySegment(recovery: Recovery, segmentId: string): DeliveryRow {
  const row = recovery.deliveries.find(candidate => candidate.segment_id === segmentId)
  if (!row)
    throw new Error(`no delivery row for segment '${segmentId}'; have ${recovery.deliveries.map(d => d.segment_id).join(', ')}`)
  return row
}

// ---------------------------------------------------------------------------
// Text delivery
// ---------------------------------------------------------------------------

describe('g4 row 3 — text delivery fault injection (TEST-FI-007, TEST-FI-008, TEST-CON-011)', () => {
  let crash: { boundary: string, code: number | null, signal: NodeJS.Signals | null }
  let platformAtCrash: string
  let first: Recovery
  let second: Recovery

  beforeAll(async () => {
    const root = tempRoot('airi-fi-text-')
    crash = await crashAt('text-delivery-matrix', root)
    platformAtCrash = externalLog(root, 'fake-discord.jsonl')
    first = await recover(root, 'guildText', '30000000000000001')
    second = await recover(root, 'guildText', '30000000000000001')
  }, 180_000)

  it('TEST-FI-008 — terminates a real child process hard at discord.send.after_response_before_record', () => {
    expect(crash.boundary).toBe('discord.send.after_response_before_record')
    // A clean exit would mean the fixture unwound instead of dying mid-flight,
    // which artifact 18 §10.3 says does not count. TerminateProcess reports
    // exit code 1 on Windows; POSIX reports the signal.
    expect([crash.signal, crash.code]).not.toEqual([null, 0])
    expect(crash.signal === 'SIGKILL' || crash.code === 1).toBe(true)
  })

  it('TEST-FI-008 — the fake platform accepted the ambiguous message exactly once before the crash', () => {
    const accepted = platformAtCrash.trim().split('\n').map(line => JSON.parse(line) as { turnId: string, messageId: string })
    expect(accepted.map(entry => entry.messageId)).toEqual(['95000000000000101', '95000000000000103'])
    expect(accepted.filter(entry => entry.turnId === '40000000000000103')).toHaveLength(1)
  })

  it('TEST-FI-008 — recovery does not resend: the visible-message set is byte-identical after reconciliation', () => {
    expect(first.platform).toBe(platformAtCrash)
    expect(second.platform).toBe(platformAtCrash)
  })

  it('TEST-FI-008 — the crash-ambiguous attempt becomes unknownAfterCrash and then abandoned, never delivered', () => {
    const ambiguous = bySegment(first, 'text:40000000000000103:0')
    expect(ambiguous.exact_text).toBe('reply-gamma-ambiguous')
    expect(first.lifecycle[ambiguous.delivery_id]).toEqual(['pending', 'delivering', 'unknownAfterCrash', 'abandoned'])
    expect(ambiguous.current_state).toBe('abandoned')
    // The platform id was in the crashed process's memory and nowhere else, so
    // no recovery path may claim it as evidence.
    expect(JSON.parse(ambiguous.current_evidence_json)).toEqual({ kind: 'none' })
    expect(ambiguous.current_evidence_json).not.toContain('95000000000000103')
  })

  it('TEST-FI-008 — the ambiguous output is not admitted as an ordinary completed assistant turn', () => {
    expect(first.contextText).not.toContain('reply-gamma-ambiguous')
    expect(second.contextText).not.toContain('reply-gamma-ambiguous')
  })

  it('TEST-FI-007 — a durable platform receipt keeps its delivered outcome and stays context-eligible', () => {
    const delivered = first.deliveries.find(row => row.exact_text === 'reply-alpha-delivered')!
    expect(delivered.current_state).toBe('delivered')
    expect(JSON.parse(delivered.current_evidence_json)).toEqual({ kind: 'platformMessageId', platformMessageId: '95000000000000101' })
    expect(first.lifecycle[delivered.delivery_id]).toEqual(['pending', 'delivering', 'delivered'])
    expect(first.contextText).toContain('reply-alpha-delivered')
  })

  it('TEST-FI-007 — a durable transport error stays failed, sent nothing, and never enters context', () => {
    const failed = first.deliveries.find(row => row.exact_text === 'reply-beta-failed')!
    expect(failed.current_state).toBe('failed')
    expect(JSON.parse(failed.current_evidence_json)).toMatchObject({ kind: 'transportError' })
    // Rejected before the platform accepted anything: zero visible messages.
    expect(platformAtCrash).not.toContain('reply-beta-failed')
    expect(first.contextText).not.toContain('reply-beta-failed')
  })

  it('TEST-CON-011 — recovery is operator-visible and enqueues exactly one durable job for the ambiguous delivery', () => {
    expect(first.health).toMatchObject({ classified: 1, enqueued: 1, deduplicated: 0, awaitingOperatorReview: 1, operatorReviewTotal: 1 })
    expect(first.health!.resolved).toEqual({ delivered: 0, failed: 0 })
    const reconcileJobs = first.jobs.filter(job => job.job_type === 'delivery_reconcile')
    expect(reconcileJobs).toHaveLength(1)
    expect(reconcileJobs[0]!.status).toBe('succeeded')
    expect(first.evidence.map(row => row.evidence_kind)).toEqual(['observation', 'decision'])
    expect(first.evidence.every(row => row.policy_version === 'imp-406:1')).toBe(true)
    // Content-free: the decision trail carries identifiers, never message text.
    expect(first.evidence.map(row => row.evidence_json).join(' ')).not.toContain('reply-gamma-ambiguous')
  })

  it('TEST-CON-011 — a second restart is idempotent: no new classification, no new job, no new send', () => {
    expect(second.health).toMatchObject({ classified: 0, enqueued: 0, deduplicated: 0, awaitingOperatorReview: 0, operatorReviewTotal: 1 })
    expect(second.jobs.filter(job => job.job_type === 'delivery_reconcile')).toHaveLength(1)
    expect(second.evidence).toEqual(first.evidence)
    expect(second.deliveries.map(row => [row.exact_text, row.current_state])).toEqual(first.deliveries.map(row => [row.exact_text, row.current_state]))
  })
})

// ---------------------------------------------------------------------------
// Voice delivery
// ---------------------------------------------------------------------------

describe('g4 row 3 — voice delivery fault injection (TEST-FI-010…013, TEST-CON-011)', () => {
  let crash: { boundary: string, code: number | null, signal: NodeJS.Signals | null }
  let playerAtCrash: string
  let first: Recovery
  let second: Recovery

  beforeAll(async () => {
    const root = tempRoot('airi-fi-voice-')
    crash = await crashAt('voice-delivery-matrix', root)
    playerAtCrash = externalLog(root, 'fake-player.jsonl')
    first = await recover(root, 'guildVoice', '70000000000000001')
    second = await recover(root, 'guildVoice', '70000000000000001')
  }, 180_000)

  it('TEST-FI-013 — terminates a real child process hard at playback.after_drain_before_finalize', () => {
    expect(crash.boundary).toBe('playback.after_drain_before_finalize')
    expect([crash.signal, crash.code]).not.toEqual([null, 0])
    expect(crash.signal === 'SIGKILL' || crash.code === 1).toBe(true)
  })

  it('TEST-FI-013 — a drained but unfinalized chunk resolves to abandoned, never to unheard or delivered', () => {
    const ambiguous = bySegment(first, 'voice:60000000000000101:2')
    expect(ambiguous.exact_text).toBe('voice-chunk-two-ambiguous')
    expect(first.lifecycle[ambiguous.delivery_id]).toEqual(['pending', 'delivering', 'unknownAfterCrash', 'abandoned'])
    expect(ambiguous.current_state).toBe('abandoned')
    expect(JSON.parse(ambiguous.current_evidence_json)).toEqual({ kind: 'none' })
    // The fake player observed a local drain. That observation died with the
    // process and is not durable evidence, so it may not become a completed turn.
    expect(playerAtCrash).toContain('"turnId":"60000000000000101","chunkIndex":2,"audibleMs":130')
    expect(first.contextText).not.toContain('voice-chunk-two-ambiguous')
    expect(second.contextText).not.toContain('voice-chunk-two-ambiguous')
  })

  it('TEST-FI-013 — a durably checkpointed drain keeps its unheard outcome, which still proves no audibility', () => {
    const heard = bySegment(first, 'voice:60000000000000101:0')
    expect(heard.exact_text).toBe('voice-chunk-zero-heard')
    expect(heard.current_state).toBe('unheard')
    const evidence = JSON.parse(heard.current_evidence_json)
    expect(evidence).toMatchObject({ kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 120 } })
    // `unheard` is the honest terminal state for completed playback: the runtime
    // admits it to context, and the domain still refuses to call it audible.
    expect(first.contextText).toContain('voice-chunk-zero-heard')
    expect(provesAudibility(evidence)).toBe(false)
    // Reconciliation must leave healthy completed playback alone.
    expect(first.lifecycle[heard.delivery_id]).toEqual(['pending', 'delivering', 'unheard'])
  })

  it('TEST-FI-012 — a durably recorded interruption stays interrupted and never enters context', () => {
    const partial = bySegment(first, 'voice:60000000000000101:1')
    expect(partial.exact_text).toBe('voice-chunk-one-cut')
    expect(partial.current_state).toBe('interrupted')
    expect(JSON.parse(partial.current_evidence_json)).toMatchObject({ kind: 'transportError', errorClass: 'playback-cancelled' })
    expect(first.lifecycle[partial.delivery_id]).toEqual(['pending', 'delivering', 'interrupted'])
    expect(first.contextText).not.toContain('voice-chunk-one-cut')
  })

  it('TEST-FI-010 — a turn that never reached playback leaves no delivery and no output segment', () => {
    // The turn was admitted and its generation prepared, so the inbound side is
    // durable; the assistant side never existed and recovery must not invent it.
    expect(first.contextText).toContain('second utterance')
    expect(first.deliveries.filter(row => row.segment_id.includes('60000000000000102'))).toEqual([])
  })

  it('TEST-FI-011 — audible playback lost to the crash leaves no durable delivery and is never replayed', () => {
    // The fake device proves audio was playing when the process died.
    expect(playerAtCrash).toContain('"event":"chunk","turnId":"60000000000000103"')
    // `recordPlayback` had not run, so M1 has no durable trace of it. That is a
    // conservative loss of trace, not a safety violation: with no delivery row
    // there is nothing to replay and nothing that could become a completed turn.
    expect(first.deliveries.filter(row => row.segment_id.includes('60000000000000103'))).toEqual([])
    expect(first.contextText).toContain('third utterance')
  })

  it('TEST-FI-010…013 — recovery replays nothing: the fake player log is byte-identical after reconciliation', () => {
    expect(first.player).toBe(playerAtCrash)
    expect(second.player).toBe(playerAtCrash)
  })

  it('TEST-CON-011 — one crash-ambiguous voice delivery is classified, made operator-visible, and stays idempotent', () => {
    expect(first.health).toMatchObject({ classified: 1, enqueued: 1, awaitingOperatorReview: 1, operatorReviewTotal: 1 })
    expect(first.health!.resolved).toEqual({ delivered: 0, failed: 0 })
    expect(first.jobs.filter(job => job.job_type === 'delivery_reconcile')).toHaveLength(1)
    expect(second.health).toMatchObject({ classified: 0, enqueued: 0, awaitingOperatorReview: 0, operatorReviewTotal: 1 })
    expect(second.deliveries.map(row => [row.exact_text, row.current_state])).toEqual(first.deliveries.map(row => [row.exact_text, row.current_state]))
    expect(second.evidence).toEqual(first.evidence)
  })
})

// ---------------------------------------------------------------------------
// Restart matrix
// ---------------------------------------------------------------------------

/**
 * `TEST-CON-011` in its catalog form: a durable fixture holding one delivery in
 * every non-terminal state artifact 18 enumerates, one whole-process restart, and
 * a state-by-state oracle.
 *
 * The hard-kill scenarios above establish crash ambiguity the way production does
 * — and in the shipped adapters that always means `{ kind: 'none' }`, because
 * state and evidence commit in the same transaction. The two evidence-backed
 * recovery branches of the approved M1 contract ("durable receipt may reconcile to
 * `delivered`", "durable transport error may reconcile to `failed`") therefore
 * need a prior process that got further than the shipped adapters can. Seeding
 * them here is exactly artifact 18's "Initial durable state" column: every row is
 * written through the real `DeliveryRepository` using only legal transitions, and
 * every *outcome* is produced by the real `createMemoryRuntime` reconciliation
 * pass. No terminal state is ever written by the test.
 */
describe('g4 row 3 — whole-process restart with unfinished deliveries (TEST-CON-011)', () => {
  const location = { platform: 'discord' as const, guildId: '10000000000000001', channelId: '30000000000000009', channelKind: 'guildText' as const }
  let recovered: Map<string, { state: string, evidence: string }>
  let health: MemoryRuntimeHealth['deliveryReconciliation']
  let contextText: string

  beforeAll(async () => {
    const root = tempRoot('airi-fi-restart-')
    // Pass 1 exists only to create the authority and migrate it; the fixture is
    // then written directly, as a dead prior process would have left it.
    const scaffold = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    const authority = scaffold.health.authority!
    await scaffold.close()

    const db = new SQLiteDatabase(authority)
    const rooms = new RoomRepository(db)
    const observedAt = asTimestamp('2026-08-13T10:00:00.000Z')
    const physicalRoomId = rooms.observe({ location, observedAt }).physicalRoomId
    const logicalRoomId = rooms.resolve(location, characterId, observedAt).logicalRoomId
    db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run('person-restart', '20000000000000001', observedAt, 'account_subject', observedAt)
    const actor = attributedActor(asPersonId('person-restart'), { platform: 'discord', platformUserId: '20000000000000001', displayNameAtEvent: 'Alex', guildId: location.guildId, observedAt, source: 'gateway' })
    new EventRepository(db).append({ idempotencyKey: asRequestId('restart-matrix-event'), kind: 'user_text', actor, physicalRoomId, logicalRoomId, occurredAt: asTimestamp('2026-08-13T10:00:01.000Z'), payload: { content: 'restart matrix trigger' }, retentionClass: 'transcript' })

    const generationId = asGenerationId('generation-restart-matrix')
    new GenerationRepository(db).create({ generationId, idempotencyKey: asRequestId('generation-restart-matrix'), logicalRoomId, characterId, state: 'prepared', evidence: { observedRoomVersion: 1, observedEventIds: [], contextManifest: { formatVersion: 1, logicalRoomVersion: 1, bindingRevision: 0, maxItems: 0, maxCharacters: 0, candidateReadLimit: 0, truncated: false, items: [] }, contextManifestHash: '', observedBindingVersion: 0, capturedAt: asTimestamp('2026-08-13T10:00:02.000Z') }, modelRef: 'test/model', startedAt: asTimestamp('2026-08-13T10:00:02.000Z') })

    /**
     * Each row is one artifact-18 delivery state. `evidence` is what the dead
     * prior process had durably committed at the moment it died.
     */
    const fixture = [
      { key: 'text-send-pending', transport: 'discord_text' as const, to: 'pending' as const, evidence: { kind: 'none' as const } },
      { key: 'text-sending', transport: 'discord_text' as const, to: 'delivering' as const, evidence: { kind: 'none' as const } },
      { key: 'text-unknown-with-receipt', transport: 'discord_text' as const, to: 'unknownAfterCrash' as const, evidence: { kind: 'platformMessageId' as const, platformMessageId: '95000000000000201' } },
      { key: 'text-unknown-with-error', transport: 'discord_text' as const, to: 'unknownAfterCrash' as const, evidence: { kind: 'transportError' as const, errorClass: 'discord-send-failed' } },
      { key: 'text-unknown-no-evidence', transport: 'discord_text' as const, to: 'unknownAfterCrash' as const, evidence: { kind: 'none' as const } },
      { key: 'text-delivered', transport: 'discord_text' as const, to: 'delivered' as const, evidence: { kind: 'platformMessageId' as const, platformMessageId: '95000000000000202' } },
      { key: 'voice-playback-queued', transport: 'discord_voice' as const, to: 'pending' as const, evidence: { kind: 'none' as const } },
      { key: 'voice-playback-started', transport: 'discord_voice' as const, to: 'delivering' as const, evidence: { kind: 'none' as const } },
      { key: 'voice-drain-observed', transport: 'discord_voice' as const, to: 'unheard' as const, evidence: { kind: 'localPlaybackCompleted' as const, deliveredRange: { characters: 10, playedMs: 90 } } },
      { key: 'voice-partial', transport: 'discord_voice' as const, to: 'interrupted' as const, evidence: { kind: 'transportError' as const, errorClass: 'playback-cancelled' } },
      { key: 'voice-unknown-after-drain', transport: 'discord_voice' as const, to: 'unknownAfterCrash' as const, evidence: { kind: 'localPlaybackCompleted' as const, deliveredRange: { characters: 10, playedMs: 95 } } },
    ]

    // One `appendSet` for the whole generation: the output authority stores a
    // complete segment set, not an append log.
    new OutputRepository(db).appendSet(generationId, fixture.map((row, ordinal) => ({ segmentId: asSegmentId(`seg-${row.key}`), generationId, ordinal, modality: row.transport === 'discord_voice' ? 'voice' as const : 'text' as const, text: `body-${row.key}` })))

    const deliveries = new DeliveryRepository(db)
    for (const [index, row] of fixture.entries()) {
      const deliveryId = asDeliveryId(`delivery-${row.key}`)
      const at = asTimestamp(`2026-08-13T10:00:${String(10 + index).padStart(2, '0')}.000Z`)
      deliveries.create({ deliveryId, segmentId: asSegmentId(`seg-${row.key}`), transport: row.transport, destinationId: row.transport === 'discord_voice' ? '70000000000000009' : location.channelId, idempotencyKey: asRequestId(`delivery-key-${row.key}`), attemptNumber: 1, state: 'pending', evidence: { kind: 'none' }, startedAt: at, lastTransitionAt: at })
      if (row.to === 'pending')
        continue
      deliveries.transition({ deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at })
      if (row.to !== 'delivering')
        deliveries.transition({ deliveryId, from: 'delivering', to: row.to, evidence: row.evidence, at })
    }
    db.close()

    // Pass 2 is the restart under test: real startup, real reconciliation.
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    health = runtime.health.deliveryReconciliation
    const physical = physicalRoomIdOf(location)
    const logical = isolatedLogicalRoomId(physical, characterId)
    const authorization = { principal: { botUserId: 'discord-bot', operations: ['context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: logical }], operator: false }, characterId, logicalRoomId: logical }
    contextText = (await runtime.context!.assembleRecent({ authorization, logicalRoomId: logical, physicalRoomId: physical, characterId, maxItems: 50, maxCharacters: 8_000 })).text
    await runtime.close()

    const inspect = openReadOnlySqliteDatabase(authority)
    recovered = new Map(rows<{ delivery_id: string, current_state: string, current_evidence_json: string }>(inspect, 'SELECT delivery_id,current_state,current_evidence_json FROM delivery_attempt_records')
      .map(row => [row.delivery_id.replace('delivery-', ''), { state: row.current_state, evidence: row.current_evidence_json }]))
    inspect.close()
  }, 120_000)

  it('resolves a crash-ambiguous text attempt to delivered only on a durable platform receipt', () => {
    expect(recovered.get('text-unknown-with-receipt')!.state).toBe('delivered')
    expect(JSON.parse(recovered.get('text-unknown-with-receipt')!.evidence)).toEqual({ kind: 'platformMessageId', platformMessageId: '95000000000000201' })
    expect(contextText).toContain('body-text-unknown-with-receipt')
  })

  it('resolves a crash-ambiguous text attempt to failed on a durable transport error', () => {
    expect(recovered.get('text-unknown-with-error')!.state).toBe('failed')
    expect(contextText).not.toContain('body-text-unknown-with-error')
  })

  it('sends nothing and abandons every attempt whose external outcome is unprovable', () => {
    // Local playback completion is not evidence of anything external, so the
    // voice row lands here too rather than in `delivered`.
    for (const key of ['text-send-pending', 'text-sending', 'text-unknown-no-evidence', 'voice-playback-queued', 'voice-playback-started', 'voice-unknown-after-drain']) {
      expect(recovered.get(key)!.state, `${key} must await operator review`).toBe('abandoned')
      expect(contextText).not.toContain(`body-${key}`)
    }
  })

  it('leaves already-resolved and healthy-playback deliveries exactly as it found them', () => {
    expect(recovered.get('text-delivered')!.state).toBe('delivered')
    expect(recovered.get('voice-drain-observed')!.state).toBe('unheard')
    expect(recovered.get('voice-partial')!.state).toBe('interrupted')
    expect(contextText).toContain('body-text-delivered')
    expect(contextText).toContain('body-voice-drain-observed')
    expect(contextText).not.toContain('body-voice-partial')
  })

  it('reports the whole matrix through the operator-visible startup summary', () => {
    // Four `pending`/`delivering` rows are classified; they join the four rows
    // already `unknownAfterCrash`, for eight jobs and six abandoned outcomes.
    expect(health).toMatchObject({ classified: 4, enqueued: 8, deduplicated: 0, awaitingOperatorReview: 6, poison: 0, deadLetter: 0, retried: 0 })
    expect(health!.resolved).toEqual({ delivered: 1, failed: 1 })
    expect(health!.operatorReviewTotal).toBe(6)
  })
})
