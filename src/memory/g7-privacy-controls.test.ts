import type { DatabaseSync } from 'node:sqlite'

import type { AuthorizationContext, EventId, LogicalRoomId, PhysicalRoomId } from '@proj-airi/memory-domain'

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId, asPersonId, asRequestId, asSegmentId, asTimestamp } from '@proj-airi/memory-domain'
import { AliasRepository, captureDeletionObligations, createVerifiedBackup, deletionCompletenessReport, openAuthoritativeSqliteDatabase, openReadOnlySqliteDatabase, PrivacyRepository, replayDeletionObligations, restoreVerifiedBackup, SearchRepository } from '@proj-airi/memory-sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import type { PrivacyCommandInput, PrivacyOperation } from './privacy-authority'
import { memoryProfile } from './profile'
import { resolveMemoryRuntimePaths } from './runtime-paths'
import { createMemoryRuntime } from './runtime'

const DAY = 86_400_000
const NOW = '2026-08-16T12:00:00.000Z'
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString()

const roots: string[] = []
const runtimes: Array<ReturnType<typeof createMemoryRuntime>> = []

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    try {
      await runtime.close()
    }
    catch {}
  }
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true })
    }
    catch {}
  }
})

function tempRoot(prefix: string): string {
  const value = mkdtempSync(join(tmpdir(), prefix))
  roots.push(value)
  return value
}

function makeRuntime(root: string) {
  const summarize = vi.fn().mockResolvedValue({ status: 'accepted' as const, text: 'condensed room summary' })
  const extract = vi.fn().mockResolvedValue({ status: 'abstained' as const })
  const profile = memoryProfile('active', {})
  const runtime = createMemoryRuntime({
    ...profile,
    flags: { ...profile.flags, explicitSemanticMemory: true, fulltextRetrieval: true, summaries: true },
    repoRoot: root,
    characterId: asCharacterId('kurisu'),
    intelligenceModels: { summarize, extract },
  })
  runtimes.push(runtime)
  return runtime
}

interface Turn {
  runtime: ReturnType<typeof makeRuntime>
  authorization: AuthorizationContext
  room: { logicalRoomId: LogicalRoomId, physicalRoomId: PhysicalRoomId }
  eventId: EventId
}

async function appendTurn(runtime: ReturnType<typeof makeRuntime>, input: { userId: string, name: string, guildId?: string, channelId: string, channelKind: 'guildText' | 'dm', content: string, occurredAt: string, idempotencyKey: string, observationKey: string }): Promise<Turn> {
  const location = input.channelKind === 'dm'
    ? { platform: 'discord' as const, channelId: input.channelId, channelKind: 'dm' as const }
    : { platform: 'discord' as const, guildId: input.guildId!, channelId: input.channelId, channelKind: input.channelKind }
  const targetScope = input.channelKind === 'dm' ? { kind: 'dm' as const, id: input.channelId } : { kind: 'guild' as const, id: input.guildId! }
  const actorEvidence = buildDiscordActorEvidence({ userId: input.userId, displayName: input.name, ...(input.guildId ? { guildId: input.guildId } : {}), observedAtEpochMs: Date.parse(input.occurredAt), source: 'gateway' })
  const resolved = await runtime.ingress!.resolve({
    authorization: { principal: { botUserId: 'bot', operations: ['identity:observe', 'room:read'], scopes: [targetScope], operator: false }, characterId: asCharacterId('kurisu'), ...(input.channelKind === 'dm' ? { dmParticipants: [asPersonId('requester')] } : {}) },
    actorEvidence,
    location,
    observationKey: input.observationKey,
  })
  const authorization: AuthorizationContext = { principal: { botUserId: 'bot', operations: ['event:write', 'context:read', 'draft:write', 'delivery:write'], scopes: [{ kind: 'logical_room', id: resolved.room.logicalRoomId }], operator: false }, characterId: asCharacterId('kurisu'), logicalRoomId: resolved.room.logicalRoomId, ...(input.channelKind === 'dm' && resolved.actor.kind === 'attributed' ? { dmParticipants: [resolved.actor.personId] } : {}) }
  const appended = await runtime.trace!.appendEvent(authorization, {
    idempotencyKey: asRequestId(input.idempotencyKey),
    kind: 'user_text',
    actor: resolved.actor,
    physicalRoomId: resolved.room.physicalRoomId,
    logicalRoomId: resolved.room.logicalRoomId,
    occurredAt: asTimestamp(input.occurredAt),
    payload: { content: input.content },
    retentionClass: 'transcript',
  })
  return { runtime, authorization, room: { logicalRoomId: resolved.room.logicalRoomId, physicalRoomId: resolved.room.physicalRoomId } as Turn['room'], eventId: appended.envelope.eventId }
}

async function deliverReply(turn: Turn, text: string, key: string): Promise<void> {
  const recent = await turn.runtime.context!.assembleRecent({ authorization: turn.authorization, logicalRoomId: turn.room.logicalRoomId, physicalRoomId: turn.room.physicalRoomId, characterId: asCharacterId('kurisu'), maxItems: 24, maxCharacters: 8_000, excludeEventIds: [] })
  expect(recent.sentinel).toBe('ok')
  const manifest = { formatVersion: recent.manifest.formatVersion, logicalRoomVersion: recent.manifest.logicalRoomVersion, bindingRevision: recent.manifest.bindingRevision, maxItems: recent.manifest.maxItems, maxCharacters: recent.manifest.maxCharacters, candidateReadLimit: recent.manifest.candidateReadLimit, truncated: recent.manifest.truncated, items: recent.manifest.selected }
  const observedEventIds = [...new Set([turn.eventId, ...manifest.items.flatMap(item => item.sourceType === 'inbound' ? [item.eventId] : [])])]
  const begun = await turn.runtime.trace!.beginGeneration(turn.authorization, {
    idempotencyKey: asRequestId(`generation:${key}`),
    logicalRoomId: turn.room.logicalRoomId,
    characterId: asCharacterId('kurisu'),
    causes: [{ inboundEventId: turn.eventId, role: 'trigger' }],
    evidence: { observedRoomVersion: manifest.logicalRoomVersion, observedEventIds, contextManifestHash: '', contextManifest: manifest, observedBindingVersion: manifest.bindingRevision, capturedAt: asTimestamp(NOW) },
    modelRef: 'test-model',
    startedAt: asTimestamp(NOW),
  })
  const segments = await turn.runtime.trace!.appendSegments(turn.authorization, begun.generation, [{ segmentId: asSegmentId(`segment:${key}`), ordinal: 0, modality: 'text', text }])
  const delivery = await turn.runtime.trace!.beginDelivery(turn.authorization, { segmentId: segments[0]!.segmentId, transport: 'discord_text', destinationId: '30000000000000001', idempotencyKey: asRequestId(`delivery:${key}`), startedAt: asTimestamp(NOW) })
  await turn.runtime.trace!.transitionDelivery(turn.authorization, { deliveryId: delivery.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: asTimestamp(NOW) })
  await turn.runtime.trace!.transitionDelivery(turn.authorization, { deliveryId: delivery.deliveryId, from: 'delivering', to: 'delivered', evidence: { kind: 'platformMessageId', platformMessageId: `message:${key}` }, at: asTimestamp(NOW) })
}

function privacyInput(input: { userId: string, name: string, guildId?: string, channelId: string, channelKind: 'guildText' | 'dm' }, requestId: string, operation: PrivacyOperation): PrivacyCommandInput {
  return {
    requestId,
    operation,
    actorEvidence: buildDiscordActorEvidence({ userId: input.userId, displayName: input.name, ...(input.guildId ? { guildId: input.guildId } : {}), observedAtEpochMs: Date.parse(NOW), source: 'gateway' }),
    discordUserId: input.userId,
    ...(input.guildId ? { guildId: input.guildId } : {}),
    channelId: input.channelId,
    channelKind: input.channelKind,
    observedAt: Date.parse(NOW),
  }
}

const GUILD = { guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' as const }

describe('g7 privacy controls', () => {
  it('correction supersedes the current fact, keeps provenance, excludes the prior value from serving, and denies other users', async () => {
    const runtime = makeRuntime(tempRoot('airi-g7-correction-'))
    const turn = await appendTurn(runtime, { userId: '20000000000000001', name: 'Alex', ...GUILD, content: 'hello', occurredAt: ago(1), idempotencyKey: 'g7:correction:event', observationKey: 'g7:correction:actor' })
    const input = privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:correction:remember', { kind: 'remember', predicate: 'favorite_color', value: 'sapphire blue' })
    await runtime.privacy!.execute(input)

    const shown = await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:correction:show', { kind: 'show' }))
    const factId = shown.message.slice(0, shown.message.indexOf(': '))
    expect(shown.message).toContain('sapphire blue')

    const corrected = await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:correction:correct', { kind: 'correct', factId, value: 'emerald green' }))
    expect(corrected.message).toContain('Correction completed')

    // Prior value is no longer current anywhere the user or the model can read.
    const after = await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:correction:show2', { kind: 'show' }))
    expect(after.message).toContain('emerald green')
    expect(after.message).not.toContain('sapphire blue')
    expect((await runtime.context!.searchMemory(turn.authorization, { query: 'sapphire', modes: ['lexical'], layers: ['semantic'], scope: { kind: 'logical_room', id: turn.room.logicalRoomId }, limit: 10 })).hits).toEqual([])
    expect((await runtime.context!.searchMemory(turn.authorization, { query: 'emerald', modes: ['lexical'], layers: ['semantic'], scope: { kind: 'logical_room', id: turn.room.logicalRoomId }, limit: 10 })).hits.length).toBe(1)

    // Provenance: the correction is evidenced by a command event and an immutable chain row.
    const authority = openReadOnlySqliteDatabase(runtime.health.authority!)
    const chain = authority.prepare('SELECT count(*) count FROM semantic_correction_records').get() as { count: number }
    const commandEvents = authority.prepare(`SELECT count(*) count FROM inbound_event_records WHERE event_kind='command'`).get() as { count: number }
    authority.close()
    expect(chain.count).toBe(1)
    expect(commandEvents.count).toBeGreaterThanOrEqual(2)

    // A different attributable user cannot correct Alex's current fact.
    const currentFactId = after.message.slice(0, after.message.indexOf(': '))
    const intruder = privacyInput({ userId: '20000000000000099', name: 'Mallory', ...GUILD }, 'g7:correction:intruder', { kind: 'correct', factId: currentFactId, value: 'malicious value' })
    await expect(runtime.privacy!.execute(intruder)).rejects.toThrow('active fact to correct does not exist')
    await runtime.close()
  })

  it('export returns only the requester current-room content and never another user\'s', async () => {
    const runtime = makeRuntime(tempRoot('airi-g7-export-'))
    const alex = await appendTurn(runtime, { userId: '20000000000000001', name: 'Alex', ...GUILD, content: 'alex export secret', occurredAt: ago(1), idempotencyKey: 'g7:export:alex', observationKey: 'g7:export:alex-actor' })
    await appendTurn(runtime, { userId: '20000000000000002', name: 'Blake', ...GUILD, content: 'blake export secret', occurredAt: ago(1), idempotencyKey: 'g7:export:blake', observationKey: 'g7:export:blake-actor' })
    await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:export:remember', { kind: 'remember', predicate: 'city', value: 'Reykjavik' }))

    const exported = await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:export:run', { kind: 'export' }))
    expect(exported.attachment).toBeDefined()
    const payload = JSON.parse(exported.attachment!.data) as { scope: string, events: Array<{ payload: { content?: string } }>, facts: Array<{ value: string, validFrom: string, factId: string, predicate: string }> }
    expect(payload.scope).toBe('requester-current-room')
    expect(payload.events.map(event => event.payload.content)).toEqual(['alex export secret', 'Remember city: Reykjavik'])
    expect(payload.facts.map(fact => fact.value)).toEqual(['Reykjavik'])
    expect(exported.attachment!.data).not.toContain('blake export secret')
    await runtime.close()
  })

  it('forget closes the requester-room scope, verifies before completing, keeps governance evidence, and replays idempotently', async () => {
    const runtime = makeRuntime(tempRoot('airi-g7-forget-'))
    const alex = await appendTurn(runtime, { userId: '20000000000000001', name: 'Alex', ...GUILD, content: 'alex forget secret', occurredAt: ago(1), idempotencyKey: 'g7:forget:alex', observationKey: 'g7:forget:alex-actor' })
    await appendTurn(runtime, { userId: '20000000000000002', name: 'Blake', ...GUILD, content: 'blake keeps this', occurredAt: ago(1), idempotencyKey: 'g7:forget:blake', observationKey: 'g7:forget:blake-actor' })
    await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:forget:remember', { kind: 'remember', predicate: 'city', value: 'Oslo' }))
    await deliverReply(alex, 'a delivered reply about alex forget secret', 'g7:forget')

    const forgotten = await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:forget:run', { kind: 'forget' }))
    expect(forgotten.message).toMatch(/verified/i)

    const authority = openReadOnlySqliteDatabase(runtime.health.authority!)
    const redacted = authority.prepare(`SELECT json_extract(payload_json,'$.redacted') redacted FROM inbound_event_records WHERE author_person_id=(SELECT person_id FROM external_identities WHERE external_subject_key='20000000000000001')`).all() as Array<{ redacted: number }>
    expect(redacted).toEqual([{ redacted: 1 }, { redacted: 1 }])
    const tombstones = authority.prepare('SELECT redaction_state FROM deletion_tombstones').all() as Array<{ redaction_state: string }>
    expect(tombstones.length).toBeGreaterThan(0)
    expect(tombstones.every(row => row.redaction_state === 'verified')).toBe(true)
    const segment = authority.prepare(`SELECT exact_text FROM output_segment_records WHERE segment_id='segment:g7:forget'`).get() as { exact_text: string }
    expect(segment.exact_text).toBe('')
    authority.close()

    // Blake's data and the governance ledger survive.
    const second = await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:forget:run', { kind: 'forget' }))
    expect(second.message).toMatch(/verified/i)
    const after = openReadOnlySqliteDatabase(runtime.health.authority!)
    expect((after.prepare('SELECT count(*) count FROM deletion_tombstones').get() as { count: number }).count).toBe(tombstones.length)
    expect((after.prepare('SELECT count(*) count FROM forget_requests WHERE status=\'completed\'').get() as { count: number }).count).toBe(1)
    after.close()
    const blake = await runtime.context!.searchMemory(alex.authorization, { query: 'keeps', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: alex.room.logicalRoomId }, limit: 10 })
    expect(blake.hits.length).toBe(1)
    await runtime.close()
  })

  it('retention applies a versioned test policy to expired content only and is storage-class complete', async () => {
    const root = tempRoot('airi-g7-retention-')
    const runtime = makeRuntime(root)
    const oldTurn = await appendTurn(runtime, { userId: '20000000000000001', name: 'Alex', ...GUILD, content: 'expired retention secret', occurredAt: ago(40), idempotencyKey: 'g7:retention:old', observationKey: 'g7:retention:old-actor' })
    await appendTurn(runtime, { userId: '20000000000000002', name: 'Blake', ...GUILD, content: 'young retention keeps', occurredAt: ago(1), idempotencyKey: 'g7:retention:young', observationKey: 'g7:retention:young-actor' })
    for (let attempt = 0; attempt < 4; attempt++) {
      const outcome = await runtime.intelligence!.runOnce()
      if (!outcome)
        break
    }
    await runtime.close()

    const authorityPath = resolveMemoryRuntimePaths(root, undefined).authority
    const handle = openAuthoritativeSqliteDatabase(authorityPath)
    const result = new PrivacyRepository(handle.database).applyRetention('g7:retention:run', { policyId: 'g7-test-retention', version: 1, rules: [{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }] }, NOW)
    expect(result.authoritative).toBe(1)
    // The worker summary sourced the expired event, so it is invalidated too.
    expect(result.derived).toBe(1)
    const summary = handle.database.prepare('SELECT stale, tombstoned_by FROM summary_repository_records').get() as { stale: number, tombstoned_by: string }
    expect(summary).toEqual({ stale: 1, tombstoned_by: 'g7:retention:run' })
    const report = deletionCompletenessReport(handle.database)
    expect(report.verifiedObligations.passed).toBe(true)
    expect(report.lexicalIndexConsistent).toBe(true)
    expect(report.optionalStoresAbsent).toBe(true)
    expect(report.classes.length).toBe(17)
    handle.close()

    const reader = openReadOnlySqliteDatabase(authorityPath)
    const search = new SearchRepository(reader)
    expect(search.searchMemory({ query: 'expired', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: oldTurn.room.logicalRoomId }, limit: 10 }).hits).toEqual([])
    expect(search.searchMemory({ query: 'keeps', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: oldTurn.room.logicalRoomId }, limit: 10 }).hits.length).toBe(1)
    reader.close()
  })

  it('restore-and-redelete: a backup taken before forget and retention cannot resurrect removed content', async () => {
    const root = tempRoot('airi-g7-restore-')
    const outside = tempRoot('airi-g7-restore-artifacts-')
    const runtime = makeRuntime(root)
    const alex = await appendTurn(runtime, { userId: '20000000000000001', name: 'Alex', ...GUILD, content: 'alex restore secret', occurredAt: ago(1), idempotencyKey: 'g7:restore:alex', observationKey: 'g7:restore:alex-actor' })
    await appendTurn(runtime, { userId: '20000000000000002', name: 'Blake', ...GUILD, content: 'blake restore keeps', occurredAt: ago(1), idempotencyKey: 'g7:restore:blake', observationKey: 'g7:restore:blake-actor' })
    await appendTurn(runtime, { userId: '20000000000000003', name: 'Casey', ...GUILD, content: 'expired restore secret', occurredAt: ago(40), idempotencyKey: 'g7:restore:casey', observationKey: 'g7:restore:casey-actor' })
    await deliverReply(alex, 'delivered restore reply', 'g7:restore')
    await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:restore:remember', { kind: 'remember', predicate: 'city', value: 'Tokyo' }))

    // Backup predates both the forget and the retention pass, so it still contains everything.
    const authorityPath = runtime.health.authority!
    const backupSource = openReadOnlySqliteDatabase(authorityPath)
    await createVerifiedBackup(backupSource, authorityPath, join(outside, 'pre-deletion.bak'), NOW)
    backupSource.close()

    await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:restore:forget', { kind: 'forget' }))
    await runtime.close()

    const handle = openAuthoritativeSqliteDatabase(authorityPath)
    new PrivacyRepository(handle.database).applyRetention('g7:restore:retention', { policyId: 'g7-test-retention', version: 1, rules: [{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }] }, NOW)
    const obligations = captureDeletionObligations(handle.database)
    expect(obligations.length).toBeGreaterThan(3)
    handle.close()

    await restoreVerifiedBackup(join(outside, 'pre-deletion.bak'), join(outside, 'restored.sqlite'), database => replayDeletionObligations(database, obligations))

    const restored = openReadOnlySqliteDatabase(join(outside, 'restored.sqlite'))
    const restoredForget = restored.prepare(`SELECT count(*) count FROM inbound_event_records WHERE json_extract(payload_json,'$.redacted') IS NOT 1 AND json_extract(payload_json,'$.content') IN ('alex restore secret','expired restore secret')`).get() as { count: number }
    expect(restoredForget.count).toBe(0)
    const restoredKeeps = restored.prepare(`SELECT count(*) count FROM inbound_event_records WHERE json_extract(payload_json,'$.redacted') IS NOT 1 AND json_extract(payload_json,'$.content')='blake restore keeps'`).get() as { count: number }
    expect(restoredKeeps.count).toBe(1)
    const emptiedSegment = restored.prepare('SELECT exact_text FROM output_segment_records WHERE segment_id=\'segment:g7:restore\'').get() as { exact_text: string }
    expect(emptiedSegment.exact_text).toBe('')
    const report = deletionCompletenessReport(restored)
    expect(report.verifiedObligations.passed).toBe(true)
    expect(report.lexicalIndexConsistent).toBe(true)
    expect(new SearchRepository(restored).searchMemory({ query: 'secret', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: alex.room.logicalRoomId }, limit: 10 }).hits.length).toBe(0)
    expect(new SearchRepository(restored).searchMemory({ query: 'keeps', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: alex.room.logicalRoomId }, limit: 10 }).hits.length).toBe(1)
    restored.close()

    // The drill has teeth: without obligation replay, the same backup serves
    // the removed content again, which is exactly what replay exists to prevent.
    await restoreVerifiedBackup(join(outside, 'pre-deletion.bak'), join(outside, 'restored-without-replay.sqlite'), () => {})
    const unsafe = openReadOnlySqliteDatabase(join(outside, 'restored-without-replay.sqlite'))
    const resurrected = unsafe.prepare(`SELECT count(*) count FROM inbound_event_records WHERE json_extract(payload_json,'$.redacted') IS NOT 1 AND json_extract(payload_json,'$.content') IN ('alex restore secret','expired restore secret')`).get() as { count: number }
    expect(resurrected.count).toBe(2)
    unsafe.close()
  })

  it('deleted content cannot reappear through search, layered context, export, or output history; scopes stay isolated', async () => {
    const runtime = makeRuntime(tempRoot('airi-g7-leakage-'))
    const guildTurn = await appendTurn(runtime, { userId: '20000000000000001', name: 'Alex', ...GUILD, content: 'guild leak secret', occurredAt: ago(1), idempotencyKey: 'g7:leak:guild', observationKey: 'g7:leak:guild-actor' })
    await appendTurn(runtime, { userId: '20000000000000002', name: 'Blake', ...GUILD, content: 'blake leak control', occurredAt: ago(1), idempotencyKey: 'g7:leak:blake', observationKey: 'g7:leak:blake-actor' })
    const dmTurn = await appendTurn(runtime, { userId: '20000000000000001', name: 'Alex', channelId: '40000000000000001', channelKind: 'dm', content: 'dm leak secret', occurredAt: ago(1), idempotencyKey: 'g7:leak:dm', observationKey: 'g7:leak:dm-actor' })
    await deliverReply(guildTurn, 'delivered leak reply', 'g7:leak')

    // DM content never enters the guild logical room's authorized context or search.
    const layered = await runtime.context!.assembleLayered({ authorization: guildTurn.authorization, logicalRoomId: guildTurn.room.logicalRoomId, physicalRoomId: guildTurn.room.physicalRoomId, characterId: asCharacterId('kurisu'), query: 'leak secret', exactPredicates: [], includeLayers: ['recent', 'summary', 'semantic', 'episodic'], maxItems: 24, maxCharacters: 8_000, excludeEventIds: [] })
    expect(layered.sentinel).toBe('ok')
    expect(layered.text).toContain('guild leak secret')
    expect(layered.text).not.toContain('dm leak secret')

    const beforeForget = await runtime.context!.searchMemory(guildTurn.authorization, { query: 'secret', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: guildTurn.room.logicalRoomId }, limit: 10 })
    expect(beforeForget.hits.map(hit => (hit.record as { content?: string }).content)).toEqual(['guild leak secret'])

    await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:leak:forget', { kind: 'forget' }))

    // Blake's retained event still matches its own terms; Alex's deleted content matches none.
    expect((await runtime.context!.searchMemory(guildTurn.authorization, { query: 'secret', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: guildTurn.room.logicalRoomId }, limit: 10 })).hits).toEqual([])
    expect((await runtime.context!.searchMemory(guildTurn.authorization, { query: 'control', modes: ['lexical'], layers: ['raw'], scope: { kind: 'logical_room', id: guildTurn.room.logicalRoomId }, limit: 10 })).hits.length).toBe(1)
    const afterForget = await runtime.context!.assembleLayered({ authorization: guildTurn.authorization, logicalRoomId: guildTurn.room.logicalRoomId, physicalRoomId: guildTurn.room.physicalRoomId, characterId: asCharacterId('kurisu'), query: 'leak secret', exactPredicates: [], includeLayers: ['recent', 'summary', 'semantic', 'episodic'], maxItems: 24, maxCharacters: 8_000, excludeEventIds: [] })
    expect(afterForget.text).not.toContain('guild leak secret')
    const exported = await runtime.privacy!.execute(privacyInput({ userId: '20000000000000001', name: 'Alex', ...GUILD }, 'g7:leak:export', { kind: 'export' }))
    expect(exported.attachment!.data).not.toContain('guild leak secret')
    // Output history: the delivered reply segment was emptied by the forget closure.
    const authority = openReadOnlySqliteDatabase(runtime.health.authority!)
    expect((authority.prepare('SELECT exact_text FROM output_segment_records WHERE segment_id=\'segment:g7:leak\'').get() as { exact_text: string }).exact_text).toBe('')
    authority.close()

    // The same user's DM room is a different logical room and was not touched.
    const dmLayered = await runtime.context!.assembleLayered({ authorization: dmTurn.authorization, logicalRoomId: dmTurn.room.logicalRoomId, physicalRoomId: dmTurn.room.physicalRoomId, characterId: asCharacterId('kurisu'), query: 'leak secret', exactPredicates: [], includeLayers: ['recent', 'summary', 'semantic', 'episodic'], maxItems: 24, maxCharacters: 8_000, excludeEventIds: [] })
    expect(dmLayered.text).toContain('dm leak secret')

    await runtime.close()

    // Private aliases never resolve in guild scope, and duplicate aliases never merge people.
    const handle = openAuthoritativeSqliteDatabase(runtimePathsOf(runtime))
    const db: DatabaseSync = handle.database
    const alexId = (db.prepare(`SELECT person_id FROM external_identities WHERE external_subject_key='20000000000000001'`).get() as { person_id: string }).person_id
    const blakeId = (db.prepare(`SELECT person_id FROM external_identities WHERE external_subject_key='20000000000000002'`).get() as { person_id: string }).person_id
    const aliases = new AliasRepository(db)
    aliases.create({ personId: alexId as never, scope: 'private', scopeId: alexId, displayValue: 'Ghost', status: 'active', authority: 'self_explicit', priority: 100, confidence: 100, validFrom: asTimestamp(ago(2)) })
    aliases.create({ personId: alexId as never, scope: 'guild', scopeId: GUILD.guildId, displayValue: 'Ghost', status: 'active', authority: 'self_explicit', priority: 50, confidence: 100, validFrom: asTimestamp(ago(2)) })
    aliases.create({ personId: blakeId as never, scope: 'guild', scopeId: GUILD.guildId, displayValue: 'Ghost', status: 'active', authority: 'self_explicit', priority: 50, confidence: 100, validFrom: asTimestamp(ago(2)) })
    // The private alias resolves only in its private scope, never in the guild.
    expect(aliases.findActiveCandidates({ scope: 'private', scopeId: alexId, normalizedValue: 'Ghost', at: asTimestamp(NOW) }).map(candidate => candidate.personId)).toEqual([alexId])
    expect(aliases.findActiveCandidates({ scope: 'guild', scopeId: GUILD.guildId, normalizedValue: 'Ghost', at: asTimestamp(NOW) }).map(candidate => candidate.personId).sort()).toEqual([alexId, blakeId].sort())
    handle.close()
  })

  it('degraded privacy commands claim no durable success and mint no operation identity', async () => {
    const runtime = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: tempRoot('airi-g7-degraded-'), characterId: asCharacterId('kurisu') })
    runtimes.push(runtime)

    const answer = await runtime.privacy!.execute({ requestId: 'g7:degraded:forget', operation: { kind: 'forget' }, actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', ...GUILD, observedAtEpochMs: Date.parse(NOW), source: 'gateway' }), discordUserId: '20000000000000001', ...GUILD, observedAt: Date.parse(NOW) })
    expect(answer.code).toBe('memory_degraded')
    expect(answer.operationId).toBeUndefined()
    expect(answer.message).not.toMatch(/Forget completed|successfully deleted|has been verified for/i)
    expect(answer.message).toMatch(/nothing could be deleted/i)
    await runtime.close()
  })
})

function runtimePathsOf(runtime: { health: { authority?: string } }): string {
  if (!runtime.health.authority)
    throw new Error('authority path missing')
  return runtime.health.authority
}
