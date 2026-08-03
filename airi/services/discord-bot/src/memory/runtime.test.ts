import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId, asRequestId, asSegmentId, asTimestamp } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'

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

describe('createMemoryRuntime', () => {
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
    const privacyInput = { actorEvidence: evidence, discordUserId: '20000000000000001', guildId: textLocation.guildId, channelId: textLocation.channelId, channelKind: 'guildText' as const, observedAt: Date.now() + 1_000 }
    const status = await runtime.privacy!.execute({ ...privacyInput, operation: { kind: 'status' } })
    expect(status.message).toContain('1 requester event')
    expect(status.message).toContain('Explicit semantic memory is disabled')
    const remember = await runtime.privacy!.execute({ ...privacyInput, operation: { kind: 'remember', predicate: 'favorite', value: 'Dr Pepper' } })
    expect(remember.code).toBe('capability_disabled')
    const afterDisabledWrite = await runtime.privacy!.execute({ ...privacyInput, operation: { kind: 'status' } })
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
      evidence: { observedRoomVersion: 1, observedEventIds: [first.envelope.eventId], contextManifestHash: 'manifest', observedBindingVersion: 0, capturedAt: asTimestamp('2026-08-02T10:00:01.000Z') },
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
})
