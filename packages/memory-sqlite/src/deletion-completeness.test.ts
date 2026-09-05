import type { DatabaseSync } from 'node:sqlite'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { deletionCompletenessReport } from './deletion-completeness.js'
import { migrate } from './migration-runner.js'
import { PrivacyRepository } from './repositories/privacy.js'

const DAY = 86_400_000
const NOW = '2026-08-16T00:00:00.000Z'
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString()

describe('deletion completeness report', () => {
  let db: DatabaseSync

  beforeEach(() => {
    db = new SQLiteDatabase(':memory:')
    migrate(db)
    db.exec(`
      PRAGMA foreign_keys=OFF;
      INSERT INTO inbound_event_records(event_id,logical_room_id,idempotency_key,event_kind,actor_kind,actor_json,author_person_id,physical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash) VALUES
        ('event-a','room-a','key-a','user_text','attributed','{}','person-a','physical-a',1,'${ago(10)}','${ago(10)}','{"content":"subject text"}','transcript','hash-a'),
        ('event-b','room-a','key-b','user_text','attributed','{}','person-b','physical-a',2,'${ago(40)}','${ago(40)}','{"content":"expired text"}','transcript','hash-b');
      PRAGMA foreign_keys=ON;
    `)
  })

  afterEach(() => db.close())

  it('enumerates every storage class with a disposition rather than only mutated tables', () => {
    new PrivacyRepository(db).applyRetention('retention-a', { policyId: 'policy-v1', version: 1, rules: [{ targetTable: 'inbound_event_records', maxAgeMs: 30 * DAY }] }, NOW)

    const report = deletionCompletenessReport(db)
    const classes = report.classes.map(item => item.storageClass)

    expect(classes).toEqual([
      'inbound-subject-events',
      'semantic-facts',
      'episodic-records',
      'summaries',
      'output-segments',
      'lexical-indexes',
      'actor-and-identity-presentation',
      'aliases-and-preferences',
      'rooms-and-bindings',
      'procedural-rules',
      'deletion-governance-evidence',
      'job-and-lifecycle-evidence',
      'generation-and-delivery-state',
      'provenance-edges',
      'legacy-v1-contract-tables',
      'vector-and-graph-stores',
      'degraded-write-spool',
    ])
    expect(report.verifiedObligations).toEqual({ requests: 1, tombstones: 1, passed: true })
    expect(report.lexicalIndexConsistent).toBe(true)
    expect(report.optionalStoresAbsent).toBe(true)
    // A class with no tables is making a claim about somewhere other than this
    // schema, and there are exactly two honest ones: the store does not exist,
    // or it exists elsewhere and this report is not authoritative about it.
    expect(report.classes.every(item => item.tables.length > 0 || item.disposition === 'feature-absent' || item.disposition === 'external-content-bearing-storage')).toBe(true)
  })

  it('names the degraded write spool as external content-bearing storage, not as absent', () => {
    // ROOT CAUSE:
    //
    // The spool was reported `feature-absent` while its own reason said the
    // files live outside the database. `feature-absent` asserts there is nothing
    // there, so the census claimed completeness over a class that holds raw user
    // content this package cannot see, and `pnpm memory:verify-deletion` printed
    // a clean report while replayed spool bytes sat on disk.
    //
    // The class is now `external-content-bearing-storage` and is surfaced in
    // `externallyOwnedClasses`, so a caller must combine this report with the
    // spool's real state before claiming deletion completeness.
    const report = deletionCompletenessReport(db)
    const spool = report.classes.find(item => item.storageClass === 'degraded-write-spool')!

    expect(spool.disposition).toBe('external-content-bearing-storage')
    expect(spool.disposition).not.toBe('feature-absent')
    expect(report.externallyOwnedClasses).toEqual(['degraded-write-spool'])
    // The vector/graph class is genuinely absent and keeps its own disposition,
    // so the two cases stay distinguishable.
    expect(report.classes.find(item => item.storageClass === 'vector-and-graph-stores')!.disposition).toBe('feature-absent')
  })

  it('detects a lexical index row that outlived a completed deletion', () => {
    new PrivacyRepository(db).forget('forget-a', 'person-a', 'room-a', NOW)
    expect(deletionCompletenessReport(db).lexicalIndexConsistent).toBe(true)

    // Reconstruct the index row exactly as a lost-trigger or manual restore
    // would: canonical record stays redacted, the index row is back.
    db.prepare(`INSERT INTO memory_search_latin (text_content, auth_scope, target_table, target_id) VALUES ('resurrected copy', hex('logical_room:room-a'), 'inbound_event_records', 'event-a')`).run()

    expect(deletionCompletenessReport(db).lexicalIndexConsistent).toBe(false)
  })

  it('detects an obligation that no longer verifies', () => {
    new PrivacyRepository(db).forget('forget-a', 'person-a', 'room-a', NOW)
    expect(deletionCompletenessReport(db).verifiedObligations.passed).toBe(true)

    db.prepare(`UPDATE inbound_event_records SET payload_json='{"content":"resurrected"}' WHERE event_id='event-a'`).run()

    const report = deletionCompletenessReport(db)
    expect(report.verifiedObligations.passed).toBe(false)
    expect(report.classes.find(item => item.storageClass === 'inbound-subject-events')!.check!.passed).toBe(false)
  })

  it('reports an empty database as complete without treating absence as success evidence', () => {
    db.exec('DELETE FROM inbound_event_records')

    const report = deletionCompletenessReport(db)
    expect(report.verifiedObligations).toEqual({ requests: 0, tombstones: 0, passed: true })
    expect(report.lexicalIndexConsistent).toBe(true)
    expect(report.optionalStoresAbsent).toBe(true)
  })
})
