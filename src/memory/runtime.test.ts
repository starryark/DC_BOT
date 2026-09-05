import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { asCharacterId, asConfidence, asFactId, asRequestId, asSegmentId, asTimestamp } from '@proj-airi/memory-domain'
import { MemoryRepository, openReadOnlySqliteDatabase } from '@proj-airi/memory-sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { FileCharacterRegistry } from '../character/character-registry'
import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { memoryProfile } from './profile'
import { createMemoryRuntime, memoryCharacterIdOf } from './runtime'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'airi-memory-runtime-'))
  roots.push(root)
  return root
}

// The LIVE card lives under this project's characters directory.
// Its folder name is the configured CHARACTER_ID, spaces and
// all, which is exactly the condition these tests pin down.
const LIVE_CHARACTER_KEY = 'Makise Kurisu'
const LIVE_CARD_DIR = resolvePath(__dirname, '../../characters', LIVE_CHARACTER_KEY)

describe('memoryCharacterIdOf', () => {
  it('derives a valid memory id from a successfully loaded character whose folder id contains a space', () => {
    // ROOT CAUSE:
    //
    // The character registry returns the configured folder id verbatim as
    // `character.id`, so a card that loads successfully yields "Makise Kurisu".
    // `src/index.ts` passed that value straight into `asCharacterId`, and the
    // space-to-hyphen fallback only applied when NO character had loaded:
    //
    //   asCharacterId(character?.id ?? cfg.character.id.replaceAll(' ', '-'))
    //
    // Domain ids reject whitespace, so the healthy path — a card that loads —
    // threw INVALID_ID during argument evaluation, before createMemoryRuntime
    // ran, taking the bot down at boot even with memory off. The unhealthy path
    // produced "Makise-Kurisu" instead, so durable identity depended on whether
    // a JSON file parsed.
    //
    // We fixed this by deriving one id from the configured character key alone,
    // via memoryCharacterIdOf, and passing that single value to the runtime and
    // both adapters. The card keeps its own folder/display identity.
    const character = new FileCharacterRegistry({ characterRoots: { [LIVE_CHARACTER_KEY]: LIVE_CARD_DIR } }).load(LIVE_CHARACTER_KEY)
    expect(character.id).toBe(LIVE_CHARACTER_KEY)
    expect(() => asCharacterId(character.id)).toThrow('must be a non-empty token')
    expect(memoryCharacterIdOf(LIVE_CHARACTER_KEY)).toBe('Makise-Kurisu')
  })

  it('ignores surrounding whitespace so a stray space in CHARACTER_ID cannot fork the identity', () => {
    expect(memoryCharacterIdOf('  Makise Kurisu ')).toBe('Makise-Kurisu')
  })

  it('names CHARACTER_ID when the configured key cannot be normalized at all', () => {
    // Coercing this into some other token would silently isolate the run from
    // the operator's binding file, so it must fail loudly instead.
    expect(() => memoryCharacterIdOf('Makise/Kurisu')).toThrow('CHARACTER_ID')
  })
})

describe('createMemoryRuntime', () => {
  it('corrects only the attributable requester current-room fact with new command provenance', async () => {
    const repo = tempRoot()
    const profile = memoryProfile('active', {})
    const runtime = createMemoryRuntime({ ...profile, flags: { ...profile.flags, explicitSemanticMemory: true }, repoRoot: repo, characterId: asCharacterId('kurisu') })
    const evidence = buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_786_262_400_000, source: 'gateway' })
    const location = { platform: 'discord' as const, guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' as const }
    const resolved = await runtime.ingress!.resolve({
      authorization: { principal: { botUserId: 'bot', operations: ['identity:observe', 'room:read'] as const, scopes: [{ kind: 'guild' as const, id: location.guildId }], operator: false }, characterId: asCharacterId('kurisu') },
      actorEvidence: evidence,
      location,
      observationKey: 'seed:correction',
    })
    if (resolved.actor.kind !== 'attributed')
      throw new Error('expected attributed actor')
    const source = await runtime.trace!.appendEvent({ principal: { botUserId: 'bot', operations: ['event:write'] as const, scopes: [{ kind: 'logical_room' as const, id: resolved.room.logicalRoomId }], operator: false }, characterId: asCharacterId('kurisu'), logicalRoomId: resolved.room.logicalRoomId }, { idempotencyKey: asRequestId('seed:fact'), kind: 'command', actor: resolved.actor, physicalRoomId: resolved.room.physicalRoomId, logicalRoomId: resolved.room.logicalRoomId, occurredAt: asTimestamp('2026-08-08T00:00:00.000Z'), payload: { content: 'My home is Osaka' }, retentionClass: 'command' })
    const writable = new DatabaseSync(runtime.health.authority!)
    const memories = new MemoryRepository(writable)
    memories.createFact({ layer: 'semantic', factId: asFactId('fact-a'), personId: resolved.actor.personId, scopeKind: 'logical_room', scopeId: resolved.room.logicalRoomId, predicate: 'home', value: 'Osaka', confidence: asConfidence(1), provenance: { source: 'userStated', method: 'explicitCommand', sourceEventIds: [source.envelope.eventId], statedAt: asTimestamp('2026-08-08T00:00:00.000Z') }, validity: { validFrom: asTimestamp('2026-08-08T00:00:00.000Z'), recordedAt: asTimestamp('2026-08-08T00:00:00.000Z') } })
    writable.close()

    const request = { requestId: 'privacy-correct-1', operation: { kind: 'correct' as const, factId: 'fact-a', value: 'Tokyo' }, actorEvidence: evidence, discordUserId: '20000000000000001', guildId: location.guildId, channelId: location.channelId, channelKind: 'guildText' as const, observedAt: 1_786_348_800_000 }
    const corrected = await runtime.privacy!.execute(request)
    const retry = await runtime.privacy!.execute(request)
    expect(retry.operationId).toBe(corrected.operationId)

    const inspection = openReadOnlySqliteDatabase(runtime.health.authority!)
    const facts = inspection.prepare('SELECT fact_id,value,supersedes,superseded_by,valid_until FROM semantic_fact_repository_records ORDER BY valid_from,fact_id').all() as Array<Record<string, string | null>>
    expect(facts).toHaveLength(2)
    expect(facts[0]).toMatchObject({ fact_id: 'fact-a', value: 'Osaka', superseded_by: facts[1]!.fact_id, valid_until: new Date(request.observedAt).toISOString() })
    expect(facts[1]).toMatchObject({ value: 'Tokyo', supersedes: 'fact-a', superseded_by: null })
    const provenance = inspection.prepare("SELECT e.event_kind,e.author_person_id,e.logical_room_id FROM memory_source_event_records p JOIN inbound_event_records e ON e.event_id=p.source_event_id WHERE p.memory_kind='semantic' AND p.memory_id=?").all(facts[1]!.fact_id)
    expect(provenance).toEqual([{ event_kind: 'command', author_person_id: resolved.actor.personId, logical_room_id: resolved.room.logicalRoomId }])
    expect(inspection.prepare("SELECT COUNT(*) count FROM inbound_event_records WHERE event_kind='command' AND retention_class='command'").get()).toEqual({ count: 2 })
    expect(JSON.stringify(inspection.prepare('SELECT * FROM privacy_operation_records WHERE request_id=?').get(request.requestId))).not.toContain('Tokyo')
    inspection.close()
    await runtime.close()
  })

  it('starts active and reconciles a binding written with the normalized memory id', async () => {
    const repo = tempRoot()
    const bindingFile = join(repo, 'bindings.json')
    const characterId = memoryCharacterIdOf(LIVE_CHARACTER_KEY)
    // Written as a literal, not from `characterId`: this is the exact string an
    // operator must put in `binding.characterId`, and the binding file schema
    // rejects the whitespace-bearing folder name outright.
    const binding = (character: string) => JSON.stringify({
      version: 1,
      bindings: [{
        id: 'lab',
        characterId: character,
        locations: [
          { kind: 'guildText', guildId: '10000000000000001', channelId: '30000000000000001' },
          { kind: 'guildVoice', guildId: '10000000000000001', channelId: '30000000000000002' },
        ],
      }],
    })

    writeFileSync(bindingFile, binding('Makise-Kurisu'))
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: repo, characterId, bindingFile })
    expect(runtime.health.mode).toBe('active')
    expect(runtime.health.status).toBe('healthy')
    expect(runtime.health.bindingReconciliation?.created).toBe(2)
    await runtime.close()

    const rawFolderBinding = join(repo, 'raw-folder-bindings.json')
    writeFileSync(rawFolderBinding, binding(LIVE_CHARACTER_KEY))
    expect(() => createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: repo, characterId, bindingFile: rawFolderBinding }))
      .toThrow('room binding file is invalid')
  })

  it('shares authorized logical-room history across configured text and voice members and retires removed members on restart', async () => {
    const repo = tempRoot()
    const bindingFile = join(repo, 'bindings.json')
    const characterId = asCharacterId('kurisu')
    const textLocation = { platform: 'discord' as const, guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' as const }
    const voiceLocation = { platform: 'discord' as const, guildId: '10000000000000001', channelId: '30000000000000002', channelKind: 'guildVoice' as const }
    writeFileSync(bindingFile, JSON.stringify({ version: 1, bindings: [{ id: 'lab', characterId, locations: [{ kind: 'guildText', guildId: textLocation.guildId, channelId: textLocation.channelId }, { kind: 'guildVoice', guildId: voiceLocation.guildId, channelId: voiceLocation.channelId }] }] }))
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: repo, characterId, bindingFile })
    expect(runtime.health.bindingReconciliation?.created).toBe(2)
    const ingressAuthorization = { principal: { botUserId: 'bot', operations: ['identity:observe', 'room:read'] as const, scopes: [{ kind: 'guild' as const, id: textLocation.guildId }], operator: false }, characterId }
    const evidence = buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: textLocation.guildId, observedAtEpochMs: Date.now() + 1_000, source: 'gateway' })
    const text = await runtime.ingress!.resolve({ authorization: ingressAuthorization, actorEvidence: evidence, location: textLocation, observationKey: 'bound:text' })
    const voice = await runtime.ingress!.resolve({ authorization: ingressAuthorization, actorEvidence: evidence, location: voiceLocation, observationKey: 'bound:voice' })
    expect(voice.room.logicalRoomId).toBe(text.room.logicalRoomId)
    const authorization = { principal: { botUserId: 'bot', operations: ['event:write', 'context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: text.room.logicalRoomId }], operator: false }, characterId, logicalRoomId: text.room.logicalRoomId }
    await runtime.trace!.appendEvent(authorization, { idempotencyKey: asRequestId('bound-event'), kind: 'user_text', actor: text.actor, physicalRoomId: text.room.physicalRoomId, logicalRoomId: text.room.logicalRoomId, occurredAt: asTimestamp('2026-08-02T10:00:00.000Z'), payload: { content: 'cross-room durable history' }, retentionClass: 'transcript' })
    const context = await runtime.context!.assembleRecent({ authorization, logicalRoomId: voice.room.logicalRoomId, physicalRoomId: voice.room.physicalRoomId, characterId, maxItems: 10, maxCharacters: 500 })
    expect(context.text).toContain('cross-room durable history')
    expect(context.manifest.bindingRevision).toBeGreaterThan(0)
    const privacyInput = { requestId: 'privacy-status-1', actorEvidence: evidence, discordUserId: '20000000000000001', guildId: textLocation.guildId, channelId: textLocation.channelId, channelKind: 'guildText' as const, observedAt: Date.now() + 1_000 }
    const status = await runtime.privacy!.execute({ ...privacyInput, operation: { kind: 'status' } })
    expect(status.message).toContain('1 requester event')
    expect(status.message).toContain('Explicit semantic memory is disabled')
    const remember = await runtime.privacy!.execute({ ...privacyInput, requestId: 'privacy-remember-1', operation: { kind: 'remember', predicate: 'favorite', value: 'Dr Pepper' } })
    expect(remember.code).toBe('capability_disabled')
    const rememberRetry = await runtime.privacy!.execute({ ...privacyInput, requestId: 'privacy-remember-1', operation: { kind: 'remember', predicate: 'favorite', value: 'Dr Pepper' } })
    expect(rememberRetry.operationId).toBe(remember.operationId)
    await expect(runtime.privacy!.execute({ ...privacyInput, requestId: 'privacy-remember-1', operation: { kind: 'remember', predicate: 'favorite', value: 'conflicting value' } })).rejects.toThrow('conflicting input')
    const inspection = openReadOnlySqliteDatabase(runtime.health.authority!)
    const operationBytes = JSON.stringify(inspection.prepare('SELECT * FROM privacy_operation_records WHERE operation_id=?').get(remember.operationId))
    inspection.close()
    expect(operationBytes).not.toContain('favorite')
    expect(operationBytes).not.toContain('Dr Pepper')
    const afterDisabledWrite = await runtime.privacy!.execute({ ...privacyInput, requestId: 'privacy-status-2', operation: { kind: 'status' } })
    expect(afterDisabledWrite.message).toContain('0 existing explicit fact')
    expect(afterDisabledWrite.message).toContain('1 requester event')
    await runtime.close()

    writeFileSync(bindingFile, JSON.stringify({ version: 1, bindings: [] }))
    const restarted = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: repo, characterId, bindingFile })
    expect(restarted.health.bindingReconciliation?.retired).toBe(2)
    const isolatedVoice = await restarted.ingress!.resolve({ authorization: ingressAuthorization, actorEvidence: evidence, location: voiceLocation, observationKey: 'bound:voice:retired' })
    expect(isolatedVoice.room.logicalRoomId).not.toBe(text.room.logicalRoomId)
    await restarted.close()
  })

  it('does no filesystem work in off mode', async () => {
    const repo = tempRoot()
    const expected = join(repo, '.local', 'memory')
    const profile = memoryProfile('off', {})
    const runtime = createMemoryRuntime({ ...profile, repoRoot: repo, characterId: asCharacterId('kurisu') })
    expect(runtime.health.status).toBe('off')
    expect(existsSync(expected)).toBe(false)
    await runtime.close()
  })

  it('opens shadow authority and releases writer ownership on close', async () => {
    const repo = tempRoot()
    const profile = memoryProfile('shadow', {})
    const first = createMemoryRuntime({ ...profile, repoRoot: repo, characterId: asCharacterId('kurisu') })
    expect(existsSync(join(repo, '.local', 'memory', 'authority', 'memory.sqlite'))).toBe(true)
    expect(() => createMemoryRuntime({ ...profile, repoRoot: repo, characterId: asCharacterId('kurisu') })).toThrow('ownership')
    await first.close()
    const replacement = createMemoryRuntime({ ...profile, repoRoot: repo, characterId: asCharacterId('kurisu') })
    await replacement.close()
  })

  it('resolves one Discord identity across text and voice without merging names', async () => {
    const repo = tempRoot()
    const runtime = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: repo, characterId: asCharacterId('kurisu') })
    const authorization = {
      principal: {
        botUserId: '99999999999999999',
        operations: ['identity:observe', 'room:read'] as const,
        scopes: [{ kind: 'guild' as const, id: '10000000000000001' }],
        operator: false,
      },
      characterId: asCharacterId('kurisu'),
    }
    const evidence = (userId: string, displayName: string, at: number) => buildDiscordActorEvidence({
      userId,
      displayName,
      guildId: '10000000000000001',
      observedAtEpochMs: at,
      source: 'gateway',
    })
    const text = await runtime.ingress!.resolve({
      authorization,
      actorEvidence: evidence('20000000000000001', 'Alex', 1_785_600_000_000),
      location: { platform: 'discord', guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' },
      observationKey: 'message:1',
    })
    const voice = await runtime.ingress!.resolve({
      authorization,
      actorEvidence: evidence('20000000000000001', 'Renamed Alex', 1_785_600_001_000),
      location: { platform: 'discord', guildId: '10000000000000001', channelId: '30000000000000002', channelKind: 'guildVoice' },
      observationKey: 'voice:1',
    })
    const namesake = await runtime.ingress!.resolve({
      authorization,
      actorEvidence: evidence('20000000000000002', 'Alex', 1_785_600_002_000),
      location: { platform: 'discord', guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' },
      observationKey: 'message:2',
    })
    expect(text.actor.kind).toBe('attributed')
    expect(voice.actor.kind).toBe('attributed')
    expect(namesake.actor.kind).toBe('attributed')
    if (text.actor.kind === 'attributed' && voice.actor.kind === 'attributed' && namesake.actor.kind === 'attributed') {
      expect(voice.actor.personId).toBe(text.actor.personId)
      expect(namesake.actor.personId).not.toBe(text.actor.personId)
      expect(voice.actor.snapshot.displayNameAtEvent).toBe('Renamed Alex')
    }
    expect(text.room.logicalRoomId).not.toBe(voice.room.logicalRoomId)
    await runtime.close()
  })

  it('denies ingress before creating identity or room records', async () => {
    const repo = tempRoot()
    const runtime = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: repo, characterId: asCharacterId('kurisu') })
    const input = {
      authorization: {
        principal: { botUserId: '99999999999999999', operations: [] as const, scopes: [] as const, operator: false },
        characterId: asCharacterId('kurisu'),
      },
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' as const }),
      location: { platform: 'discord' as const, guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' as const },
      observationKey: 'message:denied',
    }
    await expect(runtime.ingress!.resolve(input)).rejects.toMatchObject({ code: 'UNAUTHORIZED_OBSERVE' })
    await runtime.close()
  })

  it('persists idempotent events, multi-cause generations, and evidenced text delivery', async () => {
    const repo = tempRoot()
    const runtime = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: repo, characterId: asCharacterId('kurisu') })
    const characterId = asCharacterId('kurisu')
    const ingressAuthorization = {
      principal: { botUserId: '99999999999999999', operations: ['identity:observe', 'room:read'] as const, scopes: [{ kind: 'guild' as const, id: '10000000000000001' }], operator: false },
      characterId,
    }
    const resolved = await runtime.ingress!.resolve({
      authorization: ingressAuthorization,
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
      location: { platform: 'discord', guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' },
      observationKey: 'message:trace',
    })
    const authorization = {
      principal: { botUserId: '99999999999999999', operations: ['event:write', 'draft:write', 'delivery:write', 'context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: resolved.room.logicalRoomId }], operator: false },
      characterId,
      logicalRoomId: resolved.room.logicalRoomId,
    }
    const eventInput = {
      idempotencyKey: asRequestId('message:40000000000000001'),
      kind: 'user_text' as const,
      actor: resolved.actor,
      physicalRoomId: resolved.room.physicalRoomId,
      logicalRoomId: resolved.room.logicalRoomId,
      occurredAt: asTimestamp('2026-08-02T10:00:00.000Z'),
      payload: { content: 'hello' },
      retentionClass: 'transcript' as const,
    }
    const first = await runtime.trace!.appendEvent(authorization, eventInput)
    const retry = await runtime.trace!.appendEvent(authorization, eventInput)
    expect(retry.envelope.eventId).toBe(first.envelope.eventId)
    expect(retry.deduplicated).toBe(true)

    const generation = await runtime.trace!.beginGeneration(authorization, {
      idempotencyKey: asRequestId('turn:1'),
      logicalRoomId: resolved.room.logicalRoomId,
      characterId,
      causes: [{ inboundEventId: first.envelope.eventId, role: 'trigger' }],
      evidence: { observedRoomVersion: 1, observedEventIds: [first.envelope.eventId], contextManifestHash: '', contextManifest: { formatVersion: 1, logicalRoomVersion: 1, bindingRevision: 0, maxItems: 0, maxCharacters: 0, candidateReadLimit: 0, truncated: false, items: [] }, observedBindingVersion: 0, capturedAt: asTimestamp('2026-08-02T10:00:01.000Z') },
      modelRef: 'test/model',
      startedAt: asTimestamp('2026-08-02T10:00:01.000Z'),
    })
    expect(generation.edges).toHaveLength(1)
    const [segment] = await runtime.trace!.appendSegments(authorization, generation.generation, [{ segmentId: asSegmentId('segment:1'), ordinal: 0, modality: 'text', text: 'hi' }])
    const delivery = await runtime.trace!.beginDelivery(authorization, { segmentId: segment!.segmentId, transport: 'discord_text', destinationId: '30000000000000001', idempotencyKey: asRequestId('delivery:1'), startedAt: asTimestamp('2026-08-02T10:00:02.000Z') })
    const delivering = await runtime.trace!.transitionDelivery(authorization, { deliveryId: delivery.deliveryId, from: 'pending', to: 'delivering', evidence: { kind: 'none' }, at: asTimestamp('2026-08-02T10:00:03.000Z') })
    const delivered = await runtime.trace!.transitionDelivery(authorization, { deliveryId: delivery.deliveryId, from: delivering.state, to: 'delivered', evidence: { kind: 'platformMessageId', platformMessageId: '50000000000000001' }, at: asTimestamp('2026-08-02T10:00:04.000Z') })
    expect(delivered.state).toBe('delivered')
    const context = await runtime.context!.assembleRecent({ authorization, logicalRoomId: resolved.room.logicalRoomId, physicalRoomId: resolved.room.physicalRoomId, characterId, maxItems: 10, maxCharacters: 500 })
    expect(context.text).toContain('hello')
    expect(context.text).toContain('hi')
    expect(context.text).not.toContain(String(resolved.actor.kind === 'attributed' ? resolved.actor.personId : ''))
    await runtime.privacy!.execute({
      requestId: 'privacy-forget-1',
      operation: { kind: 'forget' },
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: Date.now(), source: 'gateway' }),
      discordUserId: '20000000000000001',
      guildId: '10000000000000001',
      channelId: '30000000000000001',
      channelKind: 'guildText',
      observedAt: Date.now(),
    })
    const forgotten = await runtime.context!.assembleRecent({ authorization, logicalRoomId: resolved.room.logicalRoomId, physicalRoomId: resolved.room.physicalRoomId, characterId, maxItems: 10, maxCharacters: 500 })
    expect(forgotten.text).not.toContain('hello')
    expect(forgotten.text).not.toContain('hi')
    await runtime.close()
  })

  it('runs IMP-406 delivery reconciliation at startup and classifies stale prior-process deliveries', async () => {
    const repo = tempRoot()
    const characterId = asCharacterId('kurisu')
    const runtime = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: repo, characterId })
    const ingressAuthorization = {
      principal: { botUserId: '99999999999999999', operations: ['identity:observe', 'room:read'] as const, scopes: [{ kind: 'guild' as const, id: '10000000000000001' }], operator: false },
      characterId,
    }
    const resolved = await runtime.ingress!.resolve({
      authorization: ingressAuthorization,
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
      location: { platform: 'discord', guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' },
      observationKey: 'message:reconcile',
    })
    const authorization = {
      principal: { botUserId: '99999999999999999', operations: ['event:write', 'draft:write', 'delivery:write', 'context:read'] as const, scopes: [{ kind: 'logical_room' as const, id: resolved.room.logicalRoomId }], operator: false },
      characterId,
      logicalRoomId: resolved.room.logicalRoomId,
    }
    const event = await runtime.trace!.appendEvent(authorization, { idempotencyKey: asRequestId('event:reconcile'), kind: 'user_text', actor: resolved.actor, physicalRoomId: resolved.room.physicalRoomId, logicalRoomId: resolved.room.logicalRoomId, occurredAt: asTimestamp('2026-08-02T10:00:00.000Z'), payload: { content: 'hello' }, retentionClass: 'transcript' })
    const generation = await runtime.trace!.beginGeneration(authorization, {
      idempotencyKey: asRequestId('turn:reconcile'),
      logicalRoomId: resolved.room.logicalRoomId,
      characterId,
      causes: [{ inboundEventId: event.envelope.eventId, role: 'trigger' }],
      evidence: { observedRoomVersion: 1, observedEventIds: [event.envelope.eventId], contextManifestHash: '', contextManifest: { formatVersion: 1, logicalRoomVersion: 1, bindingRevision: 0, maxItems: 0, maxCharacters: 0, candidateReadLimit: 0, truncated: false, items: [] }, observedBindingVersion: 0, capturedAt: asTimestamp('2026-08-02T10:00:01.000Z') },
      modelRef: 'test/model',
      startedAt: asTimestamp('2026-08-02T10:00:01.000Z'),
    })
    const [segment] = await runtime.trace!.appendSegments(authorization, generation.generation, [{ segmentId: asSegmentId('segment:reconcile'), ordinal: 0, modality: 'text', text: 'hi' }])
    // Begin a delivery, then "crash" (close) before any outcome is recorded. The
    // attempt is left pending for the next process to misread as in-flight.
    await runtime.trace!.beginDelivery(authorization, { segmentId: segment!.segmentId, transport: 'discord_text', destinationId: '30000000000000001', idempotencyKey: asRequestId('delivery:reconcile'), startedAt: asTimestamp('2026-08-02T10:00:02.000Z') })
    await runtime.close()

    // Restart: startup acquires sole writer ownership and runs the IMP-406 pass
    // before normal operation can treat the stale pending attempt as current work.
    const restarted = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: repo, characterId })
    expect(restarted.health.deliveryReconciliation?.classified).toBe(1)
    // No durable receipt existed, so the attempt became operator-review `abandoned` —
    // never a fabricated `delivered`, and no resend was attempted.
    expect(restarted.health.deliveryReconciliation?.awaitingOperatorReview).toBe(1)
    expect(restarted.health.deliveryReconciliation?.operatorReviewTotal).toBe(1)
    await restarted.close()

    // Re-restart is idempotent: nothing is left in-flight or crash-ambiguous, and the
    // durable operator-review count is preserved.
    const again = createMemoryRuntime({ ...memoryProfile('shadow', {}), repoRoot: repo, characterId })
    expect(again.health.deliveryReconciliation?.classified).toBe(0)
    expect(again.health.deliveryReconciliation?.operatorReviewTotal).toBe(1)
    await again.close()
  })
})
