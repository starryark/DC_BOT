import type { DatabaseSync } from 'node:sqlite'

import type { DeferredInboundEvent } from './write-spool'

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { asTimestamp } from '@proj-airi/memory-domain'
import { deletionCompletenessReport, migrate, PrivacyRepository } from '@proj-airi/memory-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { privacyCompletenessReport } from './privacy-completeness'
import { openDeferredWriteSpool } from './write-spool'

/**
 * The aggregate privacy census (G7 pass condition 4).
 *
 * `deletionCompletenessReport` is authoritative for the database and
 * deliberately not for the external write spool. What is decided here is the
 * combination: `complete` must be false whenever *either* half has outstanding
 * content, so a clean database can never carry a completeness claim over
 * unmanaged filesystem content.
 */

const NOW = '2026-08-16T00:00:00.000Z'

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'airi-privacy-completeness-'))
  directories.push(directory)
  return directory
}

function spooledTurn(content: string): DeferredInboundEvent {
  return {
    idempotencyKey: `message:${content.replaceAll(' ', '-')}`,
    observationKey: `message:${content.replaceAll(' ', '-')}`,
    kind: 'user_text',
    actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
    location: { platform: 'discord', guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' },
    occurredAt: asTimestamp('2026-08-13T10:00:00.000Z'),
    content,
    retentionClass: 'transcript',
  }
}

describe('privacyCompletenessReport', () => {
  let database: DatabaseSync

  beforeEach(() => {
    database = new SQLiteDatabase(':memory:')
    migrate(database)
    database.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO inbound_event_records(event_id,logical_room_id,idempotency_key,event_kind,actor_kind,actor_json,author_person_id,physical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash)
      VALUES ('event-a','room-a','key-a','user_text','attributed','{}','person-a','physical-a',1,'2026-01-01','2026-01-01','{"content":"forgettable phrase"}','transcript','hash-a');
      PRAGMA foreign_keys=ON;
    `)
  })

  afterEach(() => database.close())

  it('reports complete when the database is clean and the spool directory was never used', () => {
    new PrivacyRepository(database).forget('forget-a', 'person-a', 'room-a', NOW)

    const report = privacyCompletenessReport({ sqlite: deletionCompletenessReport(database), spoolDirectory: join(tempDirectory(), 'spool') })

    expect(report.complete).toBe(true)
    expect(report.blockers).toEqual([])
    expect(report.external.degradedWriteSpool.present).toBe(false)
    expect(report.sqlite.externallyOwnedClasses).toEqual(['degraded-write-spool'])
  })

  it('is incomplete while the spool holds an unreplayed record, even with a clean database', () => {
    const directory = tempDirectory()
    // A genuine accepted record, undisposed: the checkpoint counts zero, so this
    // line is the only durable copy of a write no deletion pass can reach.
    const spool = openDeferredWriteSpool(directory)
    spool.accept(spooledTurn('never replayed'))
    spool.close()

    const report = privacyCompletenessReport({ sqlite: deletionCompletenessReport(database), spoolDirectory: directory })

    expect(report.sqlite.verifiedObligations.passed).toBe(true)
    expect(report.external.degradedWriteSpool.pendingRecords).toBe(1)
    expect(report.complete).toBe(false)
    expect(report.blockers).toHaveLength(1)
    expect(report.blockers[0]).toContain('accepted write(s) are still unreplayed')
  })

  it('is incomplete while a line nobody has dispositioned is still unreadable', () => {
    const directory = tempDirectory()
    writeFileSync(join(directory, 'pending.ndjson'), 'not a spool record\n', 'utf8')

    const report = privacyCompletenessReport({ sqlite: deletionCompletenessReport(database), spoolDirectory: directory })

    expect(report.external.degradedWriteSpool.unreadableRecords).toBe(1)
    expect(report.complete).toBe(false)
    expect(report.blockers[0]).toContain('unreadable spool line')
  })

  it('is incomplete while replayed records still hold raw bytes on disk', () => {
    const directory = tempDirectory()
    const spool = openDeferredWriteSpool(directory)
    spool.accept(spooledTurn('already replayed'))
    spool.consume(1)
    // Deliberately not compacted: this is the state the runtime leaves behind if
    // compaction never runs, and it is exactly what must not read as complete.
    spool.close()

    const report = privacyCompletenessReport({ sqlite: deletionCompletenessReport(database), spoolDirectory: directory })

    expect(report.external.degradedWriteSpool.retainedConsumedRecords).toBe(1)
    expect(report.complete).toBe(false)
    expect(report.blockers[0]).toContain('have not been compacted')
  })

  it('is incomplete when a database invariant fails, independently of the spool', () => {
    new PrivacyRepository(database).forget('forget-a', 'person-a', 'room-a', NOW)
    database.prepare(`UPDATE inbound_event_records SET payload_json='{"content":"resurrected"}' WHERE event_id='event-a'`).run()

    const report = privacyCompletenessReport({ sqlite: deletionCompletenessReport(database), spoolDirectory: join(tempDirectory(), 'spool') })

    expect(report.complete).toBe(false)
    expect(report.blockers).toContain('a completed deletion obligation no longer verifies in the authority')
  })
})
