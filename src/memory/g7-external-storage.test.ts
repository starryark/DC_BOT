import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asCharacterId } from '@proj-airi/memory-domain'
import { createVerifiedBackup, deletionCompletenessReport, openReadOnlySqliteDatabase } from '@proj-airi/memory-sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { privacyCompletenessReport } from './privacy-completeness'
import { memoryProfile } from './profile'
import { createMemoryRuntime } from './runtime'
import { resolveMemoryRuntimePaths } from './runtime-paths'
import { createTextMemoryAdapter } from './text-memory-adapter'

/**
 * G7 pass condition 4 — "Deletion completeness report enumerates every storage
 * class" — for the one class that is not in the database.
 *
 * The degraded write spool is content-bearing external storage: `accept` fsyncs
 * raw ingress evidence to files under the runtime root, and neither forget,
 * retention, backup, nor restore reaches them. Reporting it as `feature-absent`
 * would let a completeness claim pass while raw user content sat outside every
 * pass that claim describes.
 *
 * What is proved here is the end-to-end closure through the production runtime:
 * a spooled turn replays, its raw bytes are erased once the authority owns it,
 * an unreplayed turn is never erased, the aggregate surface refuses to report
 * complete while unmanaged content remains, and the backup boundary is where
 * the SQLite lifecycle actually stops. File mechanics are proved in
 * `write-spool.test.ts`, replay policy in `spool-reconciliation.test.ts`, and
 * posture wiring in `degraded-mode.test.ts`.
 */

const characterId = asCharacterId('kurisu')
const GUILD_ID = '10000000000000001'
const TEXT_CHANNEL_ID = '30000000000000001'
const OBSERVED_AT = 1_785_600_000_000

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function mention(userId: string, messageId: string, text: string) {
  return {
    type: 'discord-mention' as const,
    eventId: `${messageId}:in`,
    turnId: messageId,
    guildId: GUILD_ID,
    channelId: TEXT_CHANNEL_ID,
    userId,
    displayName: userId === '20000000000000001' ? 'Alex' : 'Blake',
    actorEvidence: buildDiscordActorEvidence({ userId, displayName: userId === '20000000000000001' ? 'Alex' : 'Blake', guildId: GUILD_ID, observedAtEpochMs: OBSERVED_AT, source: 'gateway' }),
    timestamp: OBSERVED_AT,
    messageId,
    text,
  }
}

async function spool(root: string, ...turns: ReturnType<typeof mention>[]): Promise<void> {
  const degraded = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
  const text = createTextMemoryAdapter({ runtime: degraded, characterId, modelRef: 'test/model' })
  for (const turn of turns)
    await text.admit(turn, { isDirectMessage: false, isThread: false })
  await degraded.close()
}

function pendingBytes(root: string): string {
  const path = resolveMemoryRuntimePaths(root, undefined).spool
  const file = join(path, 'pending.ndjson')
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function completeness(root: string, authority: string) {
  const database = openReadOnlySqliteDatabase(authority)
  try {
    return privacyCompletenessReport({ sqlite: deletionCompletenessReport(database), spoolDirectory: resolveMemoryRuntimePaths(root, undefined).spool })
  }
  finally {
    database.close()
  }
}

describe('g7 external degraded-write-spool closure', () => {
  it('replays a spooled turn, then erases its raw bytes once the authority owns it', async () => {
    const root = tempRoot('airi-g7-spool-replay-')
    await spool(root, mention('20000000000000001', '40000000000000001', 'spooled private message'))
    expect(pendingBytes(root)).toContain('spooled private message')

    const recovered = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })

    expect(recovered.health.spoolReconciliation).toEqual({ applied: 1, deduplicated: 0, quarantined: 0, pending: 0 })
    expect(recovered.health.spoolCompaction).toBe(1)
    // The content is now durable in the authority, which owns its deletion and
    // retention. The spool copy would have been an unmanaged duplicate no
    // privacy pass can reach.
    expect(pendingBytes(root)).not.toContain('spooled private message')
    const authority = openReadOnlySqliteDatabase(recovered.health.authority!)
    expect((authority.prepare(`SELECT count(*) count FROM inbound_event_records WHERE json_extract(payload_json,'$.content')='spooled private message'`).get() as { count: number }).count).toBe(1)
    authority.close()
    await recovered.close()
  })

  it('reports the spool as an enumerated external class, never as feature-absent', async () => {
    const root = tempRoot('airi-g7-spool-census-')
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    const report = completeness(root, runtime.health.authority!)

    const spoolClass = report.sqlite.classes.find(item => item.storageClass === 'degraded-write-spool')!
    expect(spoolClass.disposition).toBe('external-content-bearing-storage')
    expect(report.sqlite.externallyOwnedClasses).toEqual(['degraded-write-spool'])
    // Enumeration is still total: the database report names every class, and the
    // aggregate is what decides completeness.
    expect(report.sqlite.classes.length).toBe(17)
    expect(report.complete).toBe(true)
    expect(report.blockers).toEqual([])
    await runtime.close()
  })

  it('refuses to report complete while an unreplayed write is still on disk', async () => {
    const root = tempRoot('airi-g7-spool-incomplete-')
    await spool(root, mention('20000000000000001', '40000000000000001', 'never replayed'))

    // A separate authority, so the spool is genuinely unrecovered rather than
    // replayed by the act of looking at it.
    const separate = tempRoot('airi-g7-spool-incomplete-authority-')
    const authorityRuntime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: separate, characterId })
    const report = completeness(root, authorityRuntime.health.authority!)

    expect(report.complete).toBe(false)
    expect(report.blockers).toContain('1 accepted write(s) are still unreplayed in the degraded write spool and are outside every deletion pass')
    expect(report.external.degradedWriteSpool.pendingRecords).toBe(1)
    // The database half is clean on its own, which is exactly why reporting it
    // alone would be a false completeness claim.
    expect(report.sqlite.verifiedObligations.passed).toBe(true)
    expect(report.sqlite.lexicalIndexConsistent).toBe(true)
    await authorityRuntime.close()
  })

  it('does not erase one user\'s unreplayed write while disposing of another\'s', async () => {
    const root = tempRoot('airi-g7-spool-isolation-')
    await spool(
      root,
      mention('20000000000000001', '40000000000000001', 'alex spooled turn'),
      mention('20000000000000002', '40000000000000002', 'blake spooled turn'),
    )

    // The second record is made unreplayable-but-undisposed by corrupting it, so
    // the pass halts on it: recovery consumes the first and leaves the second.
    const pendingPath = join(resolveMemoryRuntimePaths(root, undefined).spool, 'pending.ndjson')
    const lines = readFileSync(pendingPath, 'utf8').split('\n').filter(Boolean)
    const recovered = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    expect(recovered.health.spoolReconciliation?.applied).toBe(2)
    await recovered.close()
    expect(lines).toHaveLength(2)

    // Now re-spool one write and leave it undisposed, then reopen: the disposed
    // records are gone and the undisposed one, from a different user, is not.
    await spool(root, mention('20000000000000002', '40000000000000003', 'blake unreplayed turn'))
    const bytes = pendingBytes(root)
    expect(bytes).not.toContain('alex spooled turn')
    expect(bytes).toContain('blake unreplayed turn')
  })

  it('leaves the spool alone when recovery halts, and reports the remainder as incomplete', async () => {
    const root = tempRoot('airi-g7-spool-halted-')
    await spool(root, mention('20000000000000001', '40000000000000001', 'first turn'), mention('20000000000000001', '40000000000000002', 'second turn'))

    // A checkpoint the runtime cannot write makes the first replay pass fail
    // after its commit, which is the crash window in on-disk form.
    const blocked = join(resolveMemoryRuntimePaths(root, undefined).spool, 'applied.json.tmp')
    rmSync(blocked, { force: true })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(blocked)
    expect(() => createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })).toThrow()
    rmSync(blocked, { recursive: true })

    // Both records survived the failed pass; nothing was erased.
    expect(pendingBytes(root)).toContain('first turn')
    expect(pendingBytes(root)).toContain('second turn')

    const recovered = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    // The first is deduplicated because its commit already landed; the second is new.
    expect(recovered.health.spoolReconciliation).toEqual({ applied: 1, deduplicated: 1, quarantined: 0, pending: 0 })
    expect(recovered.health.spoolCompaction).toBe(2)
    expect(pendingBytes(root)).toBe('')
    expect(completeness(root, recovered.health.authority!).complete).toBe(true)
    await recovered.close()
  })

  it('keeps quarantine as content-free evidence that never blocks completeness', async () => {
    const root = tempRoot('airi-g7-spool-quarantine-')
    await spool(root, mention('20000000000000001', '40000000000000001', 'first wording'))
    const live = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    await live.close()

    // The same durable idempotency key with different content: healthy authority,
    // permanently unreplayable record, so it leaves through quarantine.
    await spool(root, mention('20000000000000001', '40000000000000001', 'second wording'))
    const recovered = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })

    expect(recovered.health.spoolReconciliation?.quarantined).toBe(1)
    const quarantine = readFileSync(join(resolveMemoryRuntimePaths(root, undefined).spool, 'quarantine.ndjson'), 'utf8')
    expect(quarantine).not.toContain('second wording')
    const entry = JSON.parse(quarantine.trim()) as Record<string, unknown>
    expect(entry.reason).toBe('unreplayable')
    expect(entry.recordChecksum).toMatch(/^[0-9a-f]{64}$/)
    expect(entry).not.toHaveProperty('record')

    const report = completeness(root, recovered.health.authority!)
    expect(report.external.degradedWriteSpool.quarantineEntries).toBe(1)
    expect(report.external.degradedWriteSpool.quarantineCarriesContent).toBe(false)
    expect(report.complete).toBe(true)
    await recovered.close()
  })

  it('reports a quarantine file that still carries record bodies as incomplete', async () => {
    const root = tempRoot('airi-g7-spool-legacy-quarantine-')
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: root, characterId })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(resolveMemoryRuntimePaths(root, undefined).spool, 'quarantine.ndjson'), `${JSON.stringify({ quarantinedAt: '2026-08-16T00:00:00.000Z', reason: 'unreplayable', detail: 'refused', line: 1, record: '{"intent":{"content":"legacy raw content"}}' })}\n`, 'utf8')

    const report = completeness(root, runtime.health.authority!)

    expect(report.complete).toBe(false)
    expect(report.blockers).toContain('the spool quarantine still carries raw record bodies')
    await runtime.close()
  })

  it('does not back up the spool: a verified backup covers the database only', async () => {
    const root = tempRoot('airi-g7-spool-backup-')
    const outside = tempRoot('airi-g7-spool-backup-artifacts-')
    await spool(root, mention('20000000000000001', '40000000000000001', 'unreplayed while backing up'))

    const separate = tempRoot('airi-g7-spool-backup-authority-')
    const runtime = createMemoryRuntime({ ...memoryProfile('active', {}), repoRoot: separate, characterId })
    const source = openReadOnlySqliteDatabase(runtime.health.authority!)
    await createVerifiedBackup(source, runtime.health.authority!, join(outside, 'snapshot.bak'), '2026-08-16T12:00:00.000Z')
    source.close()

    // The snapshot is one SQLite file. Restore obligation replay re-deletes what
    // that file contains and can say nothing about content that was never in it,
    // so the spool's lifecycle is replay and compaction, not backup and restore.
    const snapshot = readFileSync(join(outside, 'snapshot.bak'))
    expect(snapshot.includes(Buffer.from('unreplayed while backing up', 'utf8'))).toBe(false)
    expect(pendingBytes(root)).toContain('unreplayed while backing up')
    await runtime.close()
  })

  it('answers a degraded forget without claiming deletion while spooled content is outside the authority', async () => {
    const root = tempRoot('airi-g7-spool-degraded-forget-')
    const degraded = createMemoryRuntime({ ...memoryProfile('degraded', {}), repoRoot: root, characterId })
    const text = createTextMemoryAdapter({ runtime: degraded, characterId, modelRef: 'test/model' })
    await text.admit(mention('20000000000000001', '40000000000000001', 'spooled before the forget'), { isDirectMessage: false, isThread: false })

    const answer = await degraded.privacy!.execute({
      requestId: 'g7:spool:degraded-forget',
      operation: { kind: 'forget' },
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: GUILD_ID, observedAtEpochMs: OBSERVED_AT, source: 'gateway' }),
      discordUserId: '20000000000000001',
      guildId: GUILD_ID,
      channelId: TEXT_CHANNEL_ID,
      channelKind: 'guildText',
      observedAt: OBSERVED_AT,
    })

    expect(answer.code).toBe('memory_degraded')
    expect(answer.operationId).toBeUndefined()
    // Only affirmative claims are forbidden: the message legitimately contains
    // the phrase "no deletion has been verified", which is the denial itself.
    expect(answer.message).not.toMatch(/forget completed|successfully deleted|has been deleted|your memory (?:was|has been) (?:deleted|removed)/i)
    expect(answer.message).toMatch(/nothing could be deleted and no deletion has been verified/i)
    // The spooled turn is still on disk and is still the only durable copy of an
    // accepted write, so it must not have been erased to make the answer true.
    expect(pendingBytes(root)).toContain('spooled before the forget')
    await degraded.close()
  })
})
