/* eslint-disable style/max-statements-per-line, test/prefer-lowercase-title */
import type { DatabaseSync } from 'node:sqlite'
import type { DeliveryAttempt, DeliveryTransport, GenerationAttempt } from '@proj-airi/memory-domain'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asCharacterId, asDeliveryId, asGenerationId, asPersonId, asRequestId, asSegmentId, asTimestamp, attributedActor } from '@proj-airi/memory-domain'
import { DeliveryRepository, EventRepository, GenerationRepository, migrate, OutputRepository, ReconciliationQueue, RoomRepository } from '@proj-airi/memory-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { classifyCrashAmbiguity, DELIVERY_RECONCILIATION_JOB_TYPE, DELIVERY_RECONCILIATION_POLICY, reconcileDeliveries } from './delivery-reconciliation'

// IMP-406 (G4): the bounded delivery-reconciliation coordinator. These tests pin
// the M1 invariants the worker must hold: stale prior-process in-flight attempts
// become crash-ambiguous (never silently successful); crash-ambiguous attempts
// resolve only on durable evidence; ambiguous attempts become operator-review
// `abandoned` rather than a fabricated success or a blind resend; healthy
// completed playback is never disturbed; and every decision is deduplicated,
// fenced, bounded, and evidenced.

const characterId = asCharacterId('character-a')
const location = { platform: 'discord' as const, guildId: '99999999999999999', channelId: '18446744073709551615', channelKind: 'guildVoice' as const }
let db: DatabaseSync
let clockSecond: number
let idCounter: number
let tokenCounter: number

beforeEach(() => {
  db = new SQLiteDatabase(':memory:')
  migrate(db)
  db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run('person-a', '18446744073709551615', asTimestamp('2026-08-02T10:00:00.000Z'), 'account_subject', asTimestamp('2026-08-02T10:00:00.000Z'))
  clockSecond = 10
  idCounter = 0
  tokenCounter = 0
})
afterEach(() => db.close())

const time = (second: number) => asTimestamp(`2026-08-02T10:00:${String(second).padStart(2, '0')}.000Z`)

interface Context { deliveries: DeliveryRepository, queue: ReconciliationQueue, generation: GenerationAttempt, outputs: OutputRepository }

function setup(): Context {
  const rooms = new RoomRepository(db)
  const physicalRoomId = rooms.observe({ location, observedAt: time(0) }).physicalRoomId
  const logicalRoomId = rooms.resolve(location, characterId, time(0)).logicalRoomId
  const actor = attributedActor(asPersonId('person-a'), { platform: 'discord', platformUserId: '18446744073709551615', displayNameAtEvent: 'Alice', guildId: location.guildId, observedAt: time(0), source: 'gateway' })
  let eventNo = 0
  const events = new EventRepository(db, () => `event-${++eventNo}`, () => time(1))
  const event = events.append({ idempotencyKey: asRequestId('event-key'), kind: 'user_text', actor, physicalRoomId, logicalRoomId, occurredAt: time(1), payload: { content: 'hello' }, retentionClass: 'transcript' }).envelope
  const generation: GenerationAttempt = { generationId: asGenerationId('generation-a'), idempotencyKey: asRequestId('generation-key'), logicalRoomId, characterId, state: 'prepared', evidence: { observedRoomVersion: 1, observedEventIds: [event.eventId], contextManifestHash: '', contextManifest: { formatVersion: 1, logicalRoomVersion: 1, bindingRevision: 0, maxItems: 0, maxCharacters: 0, candidateReadLimit: 0, truncated: false, items: [] }, observedBindingVersion: 0, capturedAt: time(2) }, modelRef: 'provider/model/prompt-v1', startedAt: time(2) }
  let idNo = 0
  const generations = new GenerationRepository(db, () => `transition-${++idNo}`)
  const outputs = new OutputRepository(db)
  const deliveries = new DeliveryRepository(db, () => `delivery-transition-${++idNo}`)
  const queue = new ReconciliationQueue(db, () => `token-${++tokenCounter}`)
  generations.create(generation)
  return { deliveries, queue, generation, outputs }
}

// The output repository stores a complete segment set per generation, not an append
// log, so every delivery for one generation must be seeded by a single appendSet.
function seedDeliveries(ctx: Context, specs: Array<{ transport?: DeliveryTransport, destination?: string }>): DeliveryAttempt[] {
  const segments = specs.map((spec, index) => {
    const transport = spec.transport ?? 'discord_text'
    return { segmentId: asSegmentId(`seg-${index + 1}`), generationId: ctx.generation.generationId, ordinal: index, modality: transport === 'discord_voice' ? 'voice' as const : 'text' as const, text: `clause-${index + 1}` }
  })
  ctx.outputs.appendSet(ctx.generation.generationId, segments)
  return specs.map((spec, index) => {
    const transport = spec.transport ?? 'discord_text'
    return ctx.deliveries.create({ deliveryId: asDeliveryId(`delivery-${index + 1}`), segmentId: segments[index]!.segmentId, transport, destinationId: spec.destination ?? (transport === 'discord_voice' ? 'voice-channel' : 'text-channel'), idempotencyKey: asRequestId(`delivery-key-${index + 1}`), attemptNumber: 1, state: 'pending', evidence: { kind: 'none' }, startedAt: time(5), lastTransitionAt: time(5) }).attempt
  })
}

function reconcile(ctx: Context, workerId = 'test-worker') {
  return reconcileDeliveries(
    {
      deliveries: ctx.deliveries,
      queue: ctx.queue,
      now: () => { const t = time(clockSecond); clockSecond += 1; return t },
      id: () => `id-${++idCounter}`,
      workerId,
      random: () => 0.5,
    },
    DELIVERY_RECONCILIATION_POLICY,
  )
}

describe('IMP-406 classifyCrashAmbiguity', () => {
  it('resolves a text attempt to delivered only when a durable receipt was recorded', () => {
    expect(classifyCrashAmbiguity({ transport: 'discord_text', evidence: { kind: 'platformMessageId', platformMessageId: '950000000000000001' } })).toMatchObject({ target: 'delivered' })
  })

  it('resolves any attempt with a durable transport error to failed', () => {
    expect(classifyCrashAmbiguity({ transport: 'discord_text', evidence: { kind: 'transportError', errorClass: 'send-timeout' } })).toMatchObject({ target: 'failed' })
    expect(classifyCrashAmbiguity({ transport: 'discord_voice', evidence: { kind: 'transportError', errorClass: 'tts' } })).toMatchObject({ target: 'failed' })
  })

  it('leaves ambiguous and local-playback-only attempts for operator review rather than guessing', () => {
    // Text crash with no outcome evidence: no receipt, so neither success nor a resend.
    expect(classifyCrashAmbiguity({ transport: 'discord_text', evidence: { kind: 'none' } })).toMatchObject({ target: 'abandoned' })
    // Voice that only proved local playback: proves nothing about audibility, and voice
    // has no receipt, so it cannot become delivered or be safely replayed.
    expect(classifyCrashAmbiguity({ transport: 'discord_voice', evidence: { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 1400 } } })).toMatchObject({ target: 'abandoned' })
    expect(classifyCrashAmbiguity({ transport: 'discord_voice', evidence: { kind: 'none' } })).toMatchObject({ target: 'abandoned' })
  })
})

describe('IMP-406 reconcileDeliveries', () => {
  it('classifies stale prior-process pending and delivering attempts as crash-ambiguous and never silently successful', () => {
    const ctx = setup()
    const [pending, delivering] = seedDeliveries(ctx, [{}, {}])
    ctx.deliveries.transition({ deliveryId: delivering.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) })

    const summary = reconcile(ctx)

    // Both in-flight attempts were classified; with no durable evidence they become
    // operator-review `abandoned`, never `delivered`.
    expect(summary.classified).toBe(2)
    expect(summary.resolved).toEqual({ delivered: 0, failed: 0 })
    expect(summary.awaitingOperatorReview).toBe(2)
    expect(ctx.deliveries.get(pending.deliveryId)?.state).toBe('abandoned')
    expect(ctx.deliveries.get(delivering.deliveryId)?.state).toBe('abandoned')
    // No in-flight attempts remain for the next process to misread.
    expect(ctx.deliveries.inFlight()).toHaveLength(0)
  })

  it('resolves a crash-ambiguous text attempt to delivered only when a durable receipt was recorded before the crash', () => {
    const ctx = setup()
    const [text] = seedDeliveries(ctx, [{ transport: 'discord_text' }])
    ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) })
    // The receipt landed durably just before the crash erased the in-flight outcome.
    ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'delivering', to: 'unknownAfterCrash', evidence: { kind: 'platformMessageId', platformMessageId: '50000000000000001' }, at: time(7) })

    const summary = reconcile(ctx)

    expect(summary.resolved.delivered).toBe(1)
    expect(summary.awaitingOperatorReview).toBe(0)
    expect(ctx.deliveries.get(text.deliveryId)?.state).toBe('delivered')
  })

  it('resolves a crash-ambiguous attempt carrying a durable transport error to failed', () => {
    const ctx = setup()
    const [voice] = seedDeliveries(ctx, [{ transport: 'discord_voice' }])
    ctx.deliveries.transition({ deliveryId: voice.deliveryId, from: 'pending', to: 'unknownAfterCrash', evidence: { kind: 'transportError', errorClass: 'tts' }, at: time(6) })

    const summary = reconcile(ctx)

    expect(summary.resolved.failed).toBe(1)
    expect(ctx.deliveries.get(voice.deliveryId)?.state).toBe('failed')
  })

  it('does not blindly resend a text send that may have reached Discord but lacks a durable receipt', () => {
    const ctx = setup()
    // The process crashed after asking Discord to send but before recording any message
    // id. The honest state is unknown, and M1 neither fabricates success nor resends.
    const [text] = seedDeliveries(ctx, [{ transport: 'discord_text' }])
    ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) })
    ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'delivering', to: 'unknownAfterCrash', evidence: { kind: 'none' }, at: time(7) })

    const summary = reconcile(ctx)

    expect(summary.resolved.delivered).toBe(0)
    expect(summary.awaitingOperatorReview).toBe(1)
    expect(ctx.deliveries.get(text.deliveryId)?.state).toBe('abandoned')
  })

  it('leaves healthy completed voice playback untouched (never downgrades eligible context)', () => {
    const ctx = setup()
    const [completed] = seedDeliveries(ctx, [{ transport: 'discord_voice' }])
    ctx.deliveries.transition({ deliveryId: completed.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) })
    ctx.deliveries.transition({ deliveryId: completed.deliveryId, from: 'delivering', to: 'unheard', evidence: { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 1400 } }, at: time(7) })

    const summary = reconcile(ctx)

    // `unheard` is neither in-flight nor crash-ambiguous, so the worker must not touch
    // it — reconciling it would only remove it from context (see delivery.test.ts).
    expect(summary.classified).toBe(0)
    expect(summary.awaitingOperatorReview).toBe(0)
    expect(ctx.deliveries.get(completed.deliveryId)?.state).toBe('unheard')
    expect(ctx.deliveries.unresolved().map(attempt => attempt.state)).toEqual(['unheard'])
  })

  it('leaves an earlier completed voice segment alone while a later crash-ambiguous segment becomes operator review', () => {
    const ctx = setup()
    const [earlier, later] = seedDeliveries(ctx, [{ transport: 'discord_voice' }, { transport: 'discord_voice' }])
    // Earlier segment completed local playback; the later segment was still in-flight
    // when the process died. This is the FIND-013 mixed-outcome shape: completed
    // playback stays recall-eligible while the interrupted segment does not.
    ctx.deliveries.transition({ deliveryId: earlier.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) })
    ctx.deliveries.transition({ deliveryId: earlier.deliveryId, from: 'delivering', to: 'unheard', evidence: { kind: 'localPlaybackCompleted', deliveredRange: { playedMs: 1400 } }, at: time(7) })
    ctx.deliveries.transition({ deliveryId: later.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: time(6) })

    const summary = reconcile(ctx)

    // Only the in-flight later segment was classified; the completed earlier segment
    // keeps its eligible `unheard` state, and the later one becomes operator-review.
    expect(summary.classified).toBe(1)
    expect(summary.awaitingOperatorReview).toBe(1)
    expect(ctx.deliveries.get(earlier.deliveryId)?.state).toBe('unheard')
    expect(ctx.deliveries.get(later.deliveryId)?.state).toBe('abandoned')
  })

  it('enqueues one durable job per crash-ambiguous delivery and deduplicates a repeated pass', () => {
    const ctx = setup()
    const [a, b] = seedDeliveries(ctx, [{}, {}])
    ctx.deliveries.transition({ deliveryId: a.deliveryId, from: 'pending', to: 'unknownAfterCrash', evidence: { kind: 'none' }, at: time(6) })
    ctx.deliveries.transition({ deliveryId: b.deliveryId, from: 'pending', to: 'unknownAfterCrash', evidence: { kind: 'none' }, at: time(6) })

    const first = reconcile(ctx)
    expect(first.enqueued).toBe(2)
    expect(first.awaitingOperatorReview).toBe(2)
    expect(db.prepare('SELECT COUNT(*) count FROM worker_jobs WHERE job_type=?').get(DELIVERY_RECONCILIATION_JOB_TYPE)).toEqual({ count: 2 })

    // A second pass finds nothing new in-flight and no new crash-ambiguous attempts;
    // the durable jobs already terminalized, so nothing is re-enqueued or re-resolved.
    const second = reconcile(ctx)
    expect(second.classified).toBe(0)
    expect(second.enqueued).toBe(0)
    expect(second.awaitingOperatorReview).toBe(0)
    expect(second.alreadyResolved).toBe(0)
    expect(db.prepare('SELECT COUNT(*) count FROM worker_jobs WHERE job_type=?').get(DELIVERY_RECONCILIATION_JOB_TYPE)).toEqual({ count: 2 })
  })

  it('records append-only observation and decision evidence with the policy version and worker', () => {
    const ctx = setup()
    const [text] = seedDeliveries(ctx, [{ transport: 'discord_text' }])
    ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'pending', to: 'unknownAfterCrash', evidence: { kind: 'transportError', errorClass: 'send' }, at: time(6) })

    reconcile(ctx, 'test-worker')

    const evidence = db.prepare('SELECT evidence_kind, policy_version, actor_id FROM reconciliation_evidence_records ORDER BY ordinal').all() as Array<{ evidence_kind: string, policy_version: string, actor_id: string }>
    // One observation (enqueue) and one decision (resolution) per crash-ambiguous job.
    expect(evidence.map(row => row.evidence_kind)).toEqual(['observation', 'decision'])
    expect(evidence.every(row => row.policy_version === DELIVERY_RECONCILIATION_POLICY.policyVersion)).toBe(true)
    expect(evidence.every(row => row.actor_id === 'test-worker')).toBe(true)
    // Evidence is append-only.
    expect(() => db.prepare('UPDATE reconciliation_evidence_records SET evidence_json=\'{}\' WHERE evidence_id=(SELECT evidence_id FROM reconciliation_evidence_records LIMIT 1)').run()).toThrow(/append-only/)
    // And content-free: no segment text leaks into the durable evidence.
    expect(JSON.stringify(db.prepare('SELECT evidence_json FROM reconciliation_evidence_records').all())).not.toContain('clause-1')
  })

  it('dead-letters a poison job without touching any delivery row', () => {
    const ctx = setup()
    // Inject a malformed job directly into the queue, bypassing the coordinator's
    // payload shape, to simulate corrupt or foreign work of the same job type.
    ctx.queue.enqueue({ jobId: `id-${++idCounter}`, jobType: DELIVERY_RECONCILIATION_JOB_TYPE, dedupeKey: 'poison', payload: { notADelivery: true }, availableAt: time(10), maxAttempts: 2, createdAt: time(10) })

    const summary = reconcile(ctx)

    expect(summary.poison).toBe(1)
    const poisonJobId = (db.prepare('SELECT job_id FROM worker_jobs WHERE dedupe_key=?').get('poison') as { job_id: string }).job_id
    expect(ctx.queue.get(poisonJobId)?.status).toBe('dead_letter')
    expect(db.prepare('SELECT COUNT(*) count FROM delivery_attempt_records').get()).toEqual({ count: 0 })
  })

  it('fences a stale worker so it cannot mutate a terminal outcome resolved by the current worker', () => {
    const ctx = setup()
    const [text] = seedDeliveries(ctx, [{ transport: 'discord_text' }])
    ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'pending', to: 'unknownAfterCrash', evidence: { kind: 'transportError', errorClass: 'send' }, at: time(6) })

    // The current process resolves the attempt in one bounded pass.
    const summary = reconcile(ctx, 'current-worker')
    expect(summary.resolved.failed).toBe(1)
    expect(ctx.deliveries.get(text.deliveryId)?.state).toBe('failed')

    // `failed` is terminal; even if a stale worker tried to re-resolve, the delivery
    // precondition and the queue lease fence prevent any further mutation.
    expect(() => ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'unknownAfterCrash', to: 'abandoned', evidence: { kind: 'none' }, at: time(20) })).toThrow()
    expect(ctx.deliveries.get(text.deliveryId)?.state).toBe('failed')
  })

  it('keeps concurrent competing workers safe: a second worker reconciles the same state without duplicating outcomes', () => {
    const ctx = setup()
    const [text] = seedDeliveries(ctx, [{}])
    ctx.deliveries.transition({ deliveryId: text.deliveryId, from: 'pending', to: 'unknownAfterCrash', evidence: { kind: 'none' }, at: time(6) })

    // Worker A runs the full pass first.
    const a = reconcile(ctx, 'worker-a')
    // Worker B then runs against the same durable state (e.g. a racing startup that
    // acquired ownership after A). There is nothing left to classify or resolve.
    const b = reconcile(ctx, 'worker-b')

    expect(a.awaitingOperatorReview).toBe(1)
    expect(b.classified).toBe(0)
    expect(b.awaitingOperatorReview).toBe(0)
    expect(ctx.deliveries.get(text.deliveryId)?.state).toBe('abandoned')
    // Exactly one durable job exists for the one logical ambiguity.
    expect(db.prepare('SELECT COUNT(*) count FROM worker_jobs WHERE job_type=?').get(DELIVERY_RECONCILIATION_JOB_TYPE)).toEqual({ count: 1 })
  })
})
