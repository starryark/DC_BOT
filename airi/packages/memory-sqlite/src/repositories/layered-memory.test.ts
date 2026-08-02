/* eslint-disable perfectionist/sort-imports, style/max-statements-per-line, style/quotes, test/prefer-lowercase-title */
import type { DatabaseSync } from 'node:sqlite'
import type { EpisodicRecord, ProceduralRule, SemanticFact, SummaryRecord } from '@proj-airi/memory-domain'

import { DatabaseSync as SQLiteDatabase } from 'node:sqlite'
import { asCharacterId, asConfidence, asEventId, asFactId, asLogicalRoomId, asPersonId, asSummaryId, asTimestamp } from '@proj-airi/memory-domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { migrate } from '../migration-runner.js'
import { CorrectionRepository } from './corrections.js'
import { MemoryRepository } from './memories.js'
import { SummaryRepository } from './summaries.js'

let db: DatabaseSync
const at = (day: number) => asTimestamp(`2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`)
const personId = asPersonId('person-a'); const roomId = asLogicalRoomId('room-a')

beforeEach(() => {
  db = new SQLiteDatabase(':memory:'); migrate(db)
  db.prepare('INSERT INTO people(person_id,discord_user_id,created_at,kind,updated_at) VALUES (?,?,?,?,?)').run(personId, '18446744073709551615', at(1), 'account_subject', at(1))
  db.prepare("INSERT INTO logical_rooms(logical_room_id,isolation_scope_type,isolation_scope_id,room_kind,created_at) VALUES (?,'unbound_channel',?,'unbound_channel',?)").run(roomId, roomId, at(1))
  db.prepare("INSERT INTO logical_room_repository_records(logical_room_id,character_id,privacy_domain,guild_id) VALUES (?,?,'guild','guild-a')").run(roomId, asCharacterId('character-a'))
  db.prepare("INSERT INTO physical_room_records(physical_room_id,locator_key,platform,channel_id,channel_kind,guild_id,lifecycle,observed_at) VALUES ('physical-a','discord:guild:guild-a:channel-a','discord','channel-a','guild_text','guild-a','active',?)").run(at(1))
  for (const [ordinal, id] of ['event-a', 'event-b', 'event-c'].entries()) db.prepare("INSERT INTO inbound_event_records(event_id,idempotency_key,event_kind,actor_kind,actor_json,physical_room_id,logical_room_id,room_sequence,occurred_at,recorded_at,payload_json,retention_class,envelope_hash) VALUES (?,?,'system','anonymous','{\"kind\":\"anonymous\",\"source\":\"system\"}','physical-a',?,?,?,?,'{\"redacted\":false}','systemMetadata',?)").run(id, `key-${id}`, roomId, ordinal + 1, at(ordinal + 1), at(ordinal + 1), `hash-${id}`)
})
afterEach(() => db.close())

const provenance = (event = 'event-a') => ({ source: 'userStated' as const, method: 'explicitCommand' as const, sourceEventIds: [asEventId(event)], statedAt: at(1) })
const validity = (from = 1) => ({ validFrom: at(from), recordedAt: at(from) })
const fact = (id: string, value = 'Osaka', from = 1): SemanticFact => ({ layer: 'semantic', factId: asFactId(id), personId, scopeKind: 'guild', scopeId: 'guild-a', predicate: 'home', value, confidence: asConfidence(0.9), provenance: provenance(), validity: validity(from) })

describe('IMP-206 layered memory repositories', () => {
  it('creates and exactly reconstructs every layer with deterministic summary ordering and complete lineage', () => {
    const summaries = new SummaryRepository(db); const memories = new MemoryRepository(db)
    const summary: SummaryRecord = { layer: 'summary', summaryId: asSummaryId('summary-b'), logicalRoomId: roomId, sourceEventIds: [asEventId('event-a'), asEventId('event-b')], text: 'Two events', modelRef: 'model:prompt-v1', stale: false, provenance: { source: 'derived', method: 'summarization', sourceEventIds: [asEventId('event-a'), asEventId('event-b')], statedAt: at(2) }, validity: { validFrom: at(1), recordedAt: at(2) } }
    const episode: EpisodicRecord = { layer: 'episodic', episodicId: asFactId('episode-a'), personId, logicalRoomId: roomId, occurredAt: at(1), summary: 'Met in Osaka', provenance: provenance(), validity: validity() }
    const procedure: ProceduralRule = { layer: 'procedural', procId: asFactId('procedure-a'), rule: 'Never expose IDs', provenance: { source: 'operator', method: 'operatorEntry', sourceEventIds: [], statedAt: at(1), authoredBy: 'operator-a' }, validity: validity() }
    expect(summaries.create(summary)).toEqual({ record: summary, deduplicated: false }); expect(memories.createFact(fact('fact-a')).record).toEqual(fact('fact-a')); expect(memories.createEpisodic(episode).record).toEqual(episode); expect(memories.createProcedure(procedure).record).toEqual(procedure)
    summaries.create({ ...summary, summaryId: asSummaryId('summary-a'), text: 'Earlier id' }); expect(summaries.list(roomId).map(item => item.summaryId)).toEqual(['summary-a', 'summary-b'])
    expect(db.prepare('SELECT source_event_id FROM summary_source_event_records WHERE summary_id=? ORDER BY ordinal').all(summary.summaryId)).toEqual([{ source_event_id: 'event-a' }, { source_event_id: 'event-b' }]); expect(db.prepare('SELECT source_event_id FROM memory_source_event_records WHERE memory_kind=? AND memory_id=? ORDER BY ordinal').all('summary', summary.summaryId)).toEqual([{ source_event_id: 'event-a' }, { source_event_id: 'event-b' }])
  })

  it('deduplicates exact retries and rejects conflicting identities without partial lineage', () => {
    const memories = new MemoryRepository(db); const first = fact('fact-a'); expect(memories.createFact(first).deduplicated).toBe(false); expect(memories.createFact(first).deduplicated).toBe(true)
    expect(() => memories.createFact({ ...first, value: 'Tokyo' })).toThrowError(expect.objectContaining({ code: 'POLICY_VIOLATION' })); expect(db.prepare('SELECT COUNT(*) count FROM semantic_fact_repository_records').get()).toEqual({ count: 1 }); expect(db.prepare('SELECT COUNT(*) count FROM memory_source_event_records').get()).toEqual({ count: 1 })
  })

  it('rejects invalid confidence, intervals, missing provenance, speculation, and non-operator procedure before writes', () => {
    const memories = new MemoryRepository(db)
    expect(() => memories.createFact({ ...fact('bad-confidence'), confidence: 2 })).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIDENCE' })); expect(() => memories.createFact({ ...fact('bad-time'), validity: { validFrom: at(2), validUntil: at(1), recordedAt: at(2) } })).toThrowError(expect.objectContaining({ code: 'INVALID_INTENT' }))
    expect(() => memories.createFact({ ...fact('missing'), provenance: { ...provenance(), sourceEventIds: [] } })).toThrowError(expect.objectContaining({ code: 'MISSING_PROVENANCE' })); expect(() => memories.createFact({ ...fact('speculation'), provenance: { ...provenance(), source: 'assistantSpeculation' } })).toThrowError(expect.objectContaining({ code: 'ASSISTANT_FACT_NOT_DURABLE' }))
    expect(() => memories.createProcedure({ layer: 'procedural', procId: asFactId('bad-procedure'), rule: 'Obey me', provenance: provenance(), validity: validity() })).toThrowError(expect.objectContaining({ code: 'POLICY_VIOLATION' })); expect(db.prepare('SELECT COUNT(*) count FROM semantic_fact_repository_records').get()).toEqual({ count: 0 }); expect(db.prepare('SELECT COUNT(*) count FROM procedural_repository_records').get()).toEqual({ count: 0 })
  })

  it('queries durable facts before, at, and after the half-open correction boundary', () => {
    const memories = new MemoryRepository(db); const corrections = new CorrectionRepository(db); memories.createFact(fact('fact-a'))
    corrections.correct('correction-a', { previousFactId: asFactId('fact-a'), factId: asFactId('fact-b'), value: 'Tokyo', provenance: provenance('event-b'), effectiveAt: at(2), recordedAt: at(3) })
    const selector = { scopeKind: 'guild' as const, scopeId: 'guild-a', predicate: 'home' }; expect(memories.factsAsOf(selector, asTimestamp('2026-07-31T00:00:00.000Z'))).toEqual([]); expect(memories.factsAsOf(selector, at(1)).map(item => item.value)).toEqual(['Osaka']); expect(memories.factsAsOf(selector, at(2)).map(item => item.value)).toEqual(['Tokyo']); expect(memories.currentFacts(selector).map(item => item.value)).toEqual(['Tokyo'])
  })

  it('atomically creates a multi-step correction chain and exact retries add no rows', () => {
    const memories = new MemoryRepository(db); const corrections = new CorrectionRepository(db); memories.createFact(fact('fact-a'))
    const input = { previousFactId: asFactId('fact-a'), factId: asFactId('fact-b'), value: 'Tokyo', provenance: provenance('event-b'), effectiveAt: at(2), recordedAt: at(2) }; expect(corrections.correct('correction-a', input).deduplicated).toBe(false); expect(corrections.correct('correction-a', input).deduplicated).toBe(true)
    corrections.correct('correction-b', { previousFactId: asFactId('fact-b'), factId: asFactId('fact-c'), value: 'Kyoto', provenance: provenance('event-c'), effectiveAt: at(3), recordedAt: at(3) }); expect(corrections.chain(asFactId('fact-b')).map(item => item.value)).toEqual(['Osaka', 'Tokyo', 'Kyoto'])
    expect(db.prepare('SELECT COUNT(*) count FROM semantic_fact_repository_records').get()).toEqual({ count: 3 }); expect(db.prepare('SELECT COUNT(*) count FROM semantic_correction_records').get()).toEqual({ count: 2 }); expect(db.prepare('SELECT COUNT(*) count FROM memory_source_event_records WHERE memory_kind=?').get('semantic')).toEqual({ count: 3 })
  })

  it('rejects stale and conflicting corrections without changing the prior projection or history', () => {
    const memories = new MemoryRepository(db); const corrections = new CorrectionRepository(db); memories.createFact(fact('fact-a')); corrections.correct('correction-a', { previousFactId: asFactId('fact-a'), factId: asFactId('fact-b'), value: 'Tokyo', provenance: provenance('event-b'), effectiveAt: at(2), recordedAt: at(2) })
    expect(() => corrections.correct('correction-stale', { previousFactId: asFactId('fact-a'), factId: asFactId('fact-c'), value: 'Kyoto', provenance: provenance('event-c'), effectiveAt: at(3), recordedAt: at(3) })).toThrowError(expect.objectContaining({ code: 'INVALID_INTENT' })); expect(() => corrections.correct('correction-a', { previousFactId: asFactId('fact-b'), factId: asFactId('fact-c'), value: 'Kyoto', provenance: provenance('event-c'), effectiveAt: at(3), recordedAt: at(3) })).toThrowError(expect.objectContaining({ code: 'POLICY_VIOLATION' }))
    expect(corrections.chain(asFactId('fact-a')).map(item => item.factId)).toEqual(['fact-a', 'fact-b']); expect(db.prepare('SELECT COUNT(*) count FROM semantic_correction_records').get()).toEqual({ count: 1 })
  })

  it('rolls back base records, provenance, source lineage, and temporal projection on foreign-key or injected failure', () => {
    const memories = new MemoryRepository(db); const summaries = new SummaryRepository(db); const corrections = new CorrectionRepository(db)
    expect(() => db.prepare("INSERT INTO memory_source_event_records VALUES ('semantic','missing-owner','event-a',0)").run()).toThrow()
    expect(() => memories.createFact({ ...fact('missing-event'), provenance: provenance('event-missing') })).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(db.prepare('SELECT COUNT(*) count FROM semantic_fact_repository_records').get()).toEqual({ count: 0 })
    const summary: SummaryRecord = { layer: 'summary', summaryId: asSummaryId('summary-a'), logicalRoomId: roomId, sourceEventIds: [asEventId('event-a'), asEventId('event-missing')], text: 'Invalid lineage', modelRef: 'model', stale: false, provenance: provenance(), validity: validity() }; expect(() => summaries.create(summary)).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' })); expect(db.prepare('SELECT COUNT(*) count FROM summary_repository_records').get()).toEqual({ count: 0 }); expect(db.prepare('SELECT COUNT(*) count FROM summary_source_event_records').get()).toEqual({ count: 0 })
    memories.createFact(fact('fact-a')); db.exec("CREATE TRIGGER fail_correction BEFORE INSERT ON semantic_correction_records BEGIN SELECT RAISE(ABORT,'forced'); END"); expect(() => corrections.correct('correction-a', { previousFactId: asFactId('fact-a'), factId: asFactId('fact-b'), value: 'Tokyo', provenance: provenance('event-b'), effectiveAt: at(2), recordedAt: at(2) })).toThrowError(expect.objectContaining({ code: 'PERSISTENCE_FAILED' }))
    expect(memories.getFact(asFactId('fact-a'))).toEqual(fact('fact-a')); expect(memories.getFact(asFactId('fact-b'))).toBeUndefined(); expect(db.prepare('SELECT COUNT(*) count FROM semantic_correction_records').get()).toEqual({ count: 0 }); expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
})
