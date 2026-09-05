/* eslint-disable style/max-statements-per-line */
import type { ChildProcess } from 'node:child_process'

import type { VoiceInputEvent } from '../orchestration/events'

import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { openReadOnlySqliteDatabase } from '@proj-airi/memory-sqlite'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'
import { createTextMemoryAdapter } from './text-memory-adapter'
import { createVoiceMemoryAdapter } from './voice-memory-adapter'

/**
 * G5 pass condition 4 — "Database failure produces a visible degraded state and
 * no false success" (artifact 21 §11.2).
 *
 * Controlling text: artifact 19 §S3 (degraded stateless mode halts memory reads
 * and spools writes for later backfill), artifact 09 §10.6 and F-1 (a spooled
 * write is never reported as durable), artifact 16 REQ-OPS-001/002 and
 * TEST-OPS-006 (a successful append means the authority committed *or* an
 * approved durable spool synchronously accepted it; recovery replays
 * idempotently), and ADR-016 (no silent ephemeral fallback).
 *
 * Existing tests were not sufficient. `feature-flags.test.ts` proves the
 * degraded *posture* is computed correctly, which is a pure function over
 * flags; `runtime.test.ts` covered only off/shadow/active, and
 * `createMemoryRuntime` refused `degraded` outright. Nothing executed the
 * posture, so nothing could show what the bot does when the authority is gone.
 *
 * Scope note: this file proves condition 4 only. It says nothing about the
 * other four G5 conditions, about live Discord transport, or about any gate
 * decision.
 */

const characterId = asCharacterId('kurisu')
const childFixture = new URL('./fixtures/degraded-spool-child.ts', import.meta.url)

const GUILD_ID = '10000000000000001'
const TEXT_CHANNEL_ID = '30000000000000001'
const VOICE_CHANNEL_ID = '70000000000000001'
const USER_ID = '20000000000000001'
const OBSERVED_AT = 1_785_600_000_000

const roots: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

afterAll(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null)
      child.kill('SIGKILL')
  }
})

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const actorEvidence = () => buildDiscordActorEvidence({ userId: USER_ID, displayName: 'Alex', guildId: GUILD_ID, observedAtEpochMs: OBSERVED_AT, source: 'gateway' })

function mention(messageId: string, text: string) {
  return { type: 'discord-mention' as const, eventId: `${messageId}:in`, turnId: messageId, guildId: GUILD_ID, channelId: TEXT_CHANNEL_ID, userId: USER_ID, displayName: 'Alex', actorEvidence: actorEvidence(), timestamp: OBSERVED_AT, messageId, text }
}

function utterance(eventId: string): VoiceInputEvent {
  return { type: 'voice', eventId, turnId: eventId, guildId: GUILD_ID, channelId: VOICE_CHANNEL_ID, voiceChannelId: VOICE_CHANNEL_ID, userId: USER_ID, displayName: 'Alex', actorEvidence: actorEvidence(), timestamp: OBSERVED_AT + 1_000, pcm: Buffer.alloc(0), sampleRate: 16000 }
}

function spoolFileOf(root: string): string {
  return join(root, '.local', 'memory', 'spool', 'pending.ndjson')
}

function spoolDirectoryOf(root: string): string {
  return join(root, '.local', 'memory', 'spool')
}

function durableEvents(authority: string): { idempotencyKey: string, content: string, kind: string }[] {
  const database = openReadOnlySqliteDatabase(authority)
  try {
    return (database.prepare('SELECT idempotency_key,event_kind,payload_json FROM inbound_event_records ORDER BY recorded_at,event_id').all() as { idempotency_key: string, event_kind: string, payload_json: string }[])
      .map(row => ({ idempotencyKey: row.idempotency_key, kind: row.event_kind, content: String(JSON.parse(row.payload_json).content) }))
  }
  finally {
    database.close()
  }
}

function nextMessage<T extends { type: string }>(child: ChildProcess, expected: string, timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`degraded fixture did not report '${expected}' within ${timeoutMs} ms`)), timeoutMs)
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
        settle(new Error(`degraded fixture failed before reaching '${expected}': ${payload.message}`))
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
    const timer = setTimeout(() => reject(new Error(`degraded fixture did not exit within ${timeoutMs} ms`)), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

describe('degraded memory posture', () => {
  it('composes, reports a visible degraded state, and opens no durable authority', async () => {
    const root = tempRoot('airi-degraded-compose-')

    const runtime = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })

    expect(runtime.health.mode).toBe('degraded')
    expect(runtime.health.status).toBe('degraded')
    expect(runtime.health.state).toBe('degradedStateless')
    expect(runtime.health.promptUseEnabled).toBe(false)
    expect(runtime.health.durableWritesEnabled).toBe(true)
    expect(runtime.health.spool?.directory).toBe(spoolDirectoryOf(root))
    expect(runtime.health.spool?.pendingDepth).toBe(0)
    // The authority is what failed. Composing one here would either succeed and
    // contradict the operator's declaration, or fail and take the bot down.
    expect(runtime.health.authority).toBeUndefined()
    expect(existsSync(join(root, '.local', 'memory', 'authority', 'memory.sqlite'))).toBe(false)
    expect(runtime.ingress).toBeUndefined()
    expect(runtime.trace).toBeUndefined()
    expect(runtime.context).toBeUndefined()
    expect(runtime.deferred).toBeDefined()
    await runtime.close()
  })

  it('spools text and voice turns through the one shared runtime without fabricating durable identity', async () => {
    const root = tempRoot('airi-degraded-shared-')
    const runtime = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
    const failures: unknown[] = []
    const text = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure: error => failures.push(error) })
    const voice = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure: error => failures.push(error) })

    await text.admit(mention('40000000000000001', 'typed while degraded'), { isDirectMessage: false, isThread: false })
    await voice.admit(utterance('60000000000000001'), 'spoken while degraded')

    expect(failures).toEqual([])
    const spooled = readFileSync(spoolFileOf(root), 'utf8').trim().split('\n').map(line => JSON.parse(line).record)
    expect(spooled).toHaveLength(2)
    expect(spooled[0].intent.kind).toBe('user_text')
    expect(spooled[0].intent.idempotencyKey).toBe('message:40000000000000001')
    expect(spooled[0].intent.content).toBe('typed while degraded')
    expect(spooled[1].intent.kind).toBe('user_voice')
    expect(spooled[1].intent.idempotencyKey).toBe('voice:60000000000000001')
    expect(spooled[1].intent.content).toBe('spoken while degraded')
    // Requirement 9: the record carries replayable intent and correlation keys.
    // Every id family the authority owns is absent, so recovery resolves them
    // rather than adopting something this process invented.
    for (const record of spooled) {
      expect(Object.keys(record.intent).sort()).toEqual(['actorEvidence', 'content', 'idempotencyKey', 'kind', 'location', 'observationKey', 'occurredAt', 'retentionClass'])
      expect(JSON.stringify(record.intent)).not.toContain('personId')
      expect(JSON.stringify(record.intent)).not.toContain('logicalRoomId')
      expect(JSON.stringify(record.intent)).not.toContain('physicalRoomId')
      expect(JSON.stringify(record.intent)).not.toContain('eventId')
    }
    expect(runtime.health.spool?.pendingDepth).toBe(0)
    await runtime.close()
  })

  it('contributes no durable prior memory to either prompt while the turn still runs', async () => {
    const root = tempRoot('airi-degraded-prompt-')
    const runtime = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
    const failures: unknown[] = []
    const text = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure: error => failures.push(error) })
    const voice = createVoiceMemoryAdapter({ runtime, characterId, modelRef: 'test/model', onFailure: error => failures.push(error) })
    const turn = mention('40000000000000001', 'typed while degraded')
    const spoken = utterance('60000000000000001')
    await text.admit(turn, { isDirectMessage: false, isThread: false })
    await voice.admit(spoken, 'spoken while degraded')

    const preparedText = await text.prepareForModel(turn)
    const preparedVoice = await voice.prepareGeneration(spoken.turnId, [spoken])

    // `disabled`, not `required_unavailable`: the turn is allowed to proceed
    // without durable prior memory, and not allowed to proceed *with* it.
    expect(preparedText.context.status).toBe('disabled')
    expect(preparedText.generation).toBeUndefined()
    expect(preparedVoice.context.status).toBe('disabled')
    expect(preparedVoice.generation).toBeUndefined()
    expect(failures).toEqual([])

    // The rest of the turn is also inert rather than failing: nothing downstream
    // may report a durable generation or delivery that does not exist.
    await text.generated(turn, ['a reply'])
    await text.delivering(turn, 0)
    await text.deliveredSegment(turn, 0, '95000000000000001')
    await text.delivered(turn)
    await voice.completeGeneration(spoken.turnId)
    expect(failures).toEqual([])
    await runtime.close()
  })

  it('answers privacy commands without claiming anything was durably remembered or forgotten', async () => {
    const root = tempRoot('airi-degraded-privacy-')
    const runtime = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
    const text = createTextMemoryAdapter({ runtime, characterId, modelRef: 'test/model' })
    await text.admit(mention('40000000000000001', 'typed while degraded'), { isDirectMessage: false, isThread: false })
    const request = { actorEvidence: actorEvidence(), discordUserId: USER_ID, guildId: GUILD_ID, channelId: TEXT_CHANNEL_ID, channelKind: 'guildText' as const, observedAt: OBSERVED_AT }

    const status = await runtime.privacy!.execute({ ...request, requestId: 'privacy-1', operation: { kind: 'status' } })
    const remember = await runtime.privacy!.execute({ ...request, requestId: 'privacy-2', operation: { kind: 'remember', predicate: 'favorite', value: 'Dr Pepper' } })
    const forget = await runtime.privacy!.execute({ ...request, requestId: 'privacy-3', operation: { kind: 'forget' } })
    const show = await runtime.privacy!.execute({ ...request, requestId: 'privacy-4', operation: { kind: 'show' } })

    expect(status.code).toBe('memory_degraded')
    expect(status.message).toContain('degraded')
    expect(status.message).toContain('1 write is waiting to be replayed')
    expect(remember.code).toBe('memory_degraded')
    expect(remember.message).toContain('Nothing was stored')
    expect(forget.code).toBe('memory_degraded')
    expect(forget.message).not.toContain('completed')
    expect(show.code).toBe('memory_degraded')
    // No durable privacy-operation row exists, so there is no operation id to
    // report. Minting one would be a fabricated durable identifier.
    expect(status.operationId).toBeUndefined()
    expect(remember.operationId).toBeUndefined()
    await runtime.close()
  })

  it('keeps an acknowledged write across a hard process kill and replays it into the authority on recovery', async () => {
    const root = tempRoot('airi-degraded-crash-')
    const child = fork(childFixture, ['spool-and-park', root], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    children.push(child)

    const spooled = await nextMessage<{ type: 'spooled', status: string, promptUseEnabled: boolean, contextStatus: string, failures: string[] }>(child, 'spooled')
    await nextMessage(child, 'parked')
    child.kill('SIGKILL')
    const { signal } = await exited(child)

    expect(spooled.status).toBe('degraded')
    expect(spooled.promptUseEnabled).toBe(false)
    expect(spooled.contextStatus).toBe('disabled')
    expect(spooled.failures).toEqual([])
    expect(signal).toBe('SIGKILL')
    // The kill skipped every graceful path, so anything present here was
    // fsynced by `accept` before the acknowledgement the parent received.
    expect(readFileSync(spoolFileOf(root), 'utf8').trim().split('\n')).toHaveLength(2)

    const recovered = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    expect(recovered.health.status).toBe('healthy')
    expect(recovered.health.spoolReconciliation).toEqual({ applied: 2, deduplicated: 0, quarantined: 0, pending: 0 })
    const events = durableEvents(recovered.health.authority!)
    expect(events).toEqual([
      { idempotencyKey: 'message:40000000000000001', kind: 'user_text', content: 'spooled while degraded' },
      { idempotencyKey: 'voice:60000000000000001', kind: 'user_voice', content: 'spoken while degraded' },
    ])
    await recovered.close()
  }, 120_000)

  it('creates no duplicate durable state when the authority commit lands but the spool checkpoint does not', async () => {
    // ROOT CAUSE:
    //
    // Replay is two writes to two stores: the authority commit, then the spool
    // checkpoint that records the commit happened. A crash between them is
    // unavoidable, and on restart the record is offered again. Without an
    // idempotency key on the replayed append, that second offer would create a
    // second durable event for one real utterance.
    //
    // The spooled record therefore carries the same idempotency key the live
    // path would have used, so the authority's own dedupe collapses the retry.
    // This case reproduces the window by making the checkpoint physically
    // unwritable at the moment the commit has already landed, which leaves
    // exactly the on-disk state a crash in that window leaves.
    const root = tempRoot('airi-degraded-window-')
    const degraded = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
    const text = createTextMemoryAdapter({ runtime: degraded, characterId, modelRef: 'test/model' })
    await text.admit(mention('40000000000000001', 'typed while degraded'), { isDirectMessage: false, isThread: false })
    await degraded.close()

    // The checkpoint is written to a temporary file and renamed into place, so
    // occupying that path with a directory makes the durable checkpoint write
    // fail after the authority has already accepted the event.
    const blocked = join(spoolDirectoryOf(root), 'applied.json.tmp')
    mkdirSync(blocked)
    expect(() => createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })).toThrow()
    rmSync(blocked, { recursive: true })

    const authority = join(root, '.local', 'memory', 'authority', 'memory.sqlite')
    expect(durableEvents(authority)).toHaveLength(1)

    const recovered = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })

    expect(recovered.health.spoolReconciliation).toEqual({ applied: 0, deduplicated: 1, quarantined: 0, pending: 0 })
    expect(durableEvents(recovered.health.authority!)).toEqual([
      { idempotencyKey: 'message:40000000000000001', kind: 'user_text', content: 'typed while degraded' },
    ])
    await recovered.close()
  })

  it('quarantines a spooled write the authority permanently refuses instead of dropping it', async () => {
    // A conflicting idempotency key is the one case where the authority is
    // healthy and the record is still unreplayable: the same key already
    // describes a different event. Retrying forever would wedge recovery, and
    // skipping silently would lose a write, so the record leaves the spool
    // through a durable, operator-readable quarantine.
    const root = tempRoot('airi-degraded-conflict-')
    const degraded = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
    const text = createTextMemoryAdapter({ runtime: degraded, characterId, modelRef: 'test/model' })
    await text.admit(mention('40000000000000001', 'first wording'), { isDirectMessage: false, isThread: false })
    await degraded.close()

    const live = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    expect(live.health.spoolReconciliation?.applied).toBe(1)
    await live.close()

    // The same durable idempotency key, now carrying different content.
    const conflicting = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
    const conflictingText = createTextMemoryAdapter({ runtime: conflicting, characterId, modelRef: 'test/model' })
    await conflictingText.admit(mention('40000000000000001', 'second wording'), { isDirectMessage: false, isThread: false })
    await conflicting.close()

    const recovered = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })

    expect(recovered.health.spoolReconciliation).toEqual({ applied: 0, deduplicated: 0, quarantined: 1, pending: 0 })
    expect(durableEvents(recovered.health.authority!)).toEqual([
      { idempotencyKey: 'message:40000000000000001', kind: 'user_text', content: 'first wording' },
    ])
    const quarantined = JSON.parse(readFileSync(join(spoolDirectoryOf(root), 'quarantine.ndjson'), 'utf8').trim())
    expect(quarantined.reason).toBe('unreplayable')
    expect(quarantined.detail).toContain('conflicting')
    await recovered.close()
  })

  it('leaves shadow and active startups with an empty spool untouched', async () => {
    const root = tempRoot('airi-degraded-absent-')

    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })

    expect(runtime.health.spoolReconciliation).toEqual({ applied: 0, deduplicated: 0, quarantined: 0, pending: 0 })
    expect(existsSync(spoolFileOf(root))).toBe(false)
    await runtime.close()
  })
})
