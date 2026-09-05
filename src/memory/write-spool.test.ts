import type { DeferredInboundEvent } from './write-spool'

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asTimestamp } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { inspectSpoolStorage, openDeferredWriteSpool } from './write-spool'

/**
 * The durable-spool file boundary of the degraded posture (G5 pass condition 4,
 * artifact 21 §11.2; artifact 09 §10.6; artifact 16 REQ-OPS-001/REQ-OPS-002).
 *
 * These cases pin the two properties the spool exists for and nothing else:
 * an acceptance is durable before it is reported, and unreadable or
 * unreplayable input is surfaced rather than skipped. Replay policy lives in
 * `spool-reconciliation.test.ts`; posture wiring lives in `degraded-mode.test.ts`.
 */

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

function tempSpool(): string {
  const directory = mkdtempSync(join(tmpdir(), 'airi-memory-spool-'))
  directories.push(directory)
  return directory
}

function intent(messageId: string, content: string): DeferredInboundEvent {
  return {
    idempotencyKey: `message:${messageId}`,
    observationKey: `message:${messageId}`,
    kind: 'user_text',
    actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000001', displayName: 'Alex', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
    location: { platform: 'discord', guildId: '10000000000000001', channelId: '30000000000000001', channelKind: 'guildText' },
    occurredAt: asTimestamp('2026-08-13T10:00:00.000Z'),
    content,
    retentionClass: 'transcript',
  }
}

describe('openDeferredWriteSpool', () => {
  it('accepts a write as spooled, never as durable, and numbers records monotonically', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)

    const first = spool.accept(intent('40000000000000001', 'first'))
    const second = spool.accept(intent('40000000000000002', 'second'))

    expect(first.durability).toBe('spooled')
    expect(second.durability).toBe('spooled')
    expect(first.sequence).toBe(1)
    expect(second.sequence).toBe(2)
    expect(first.recordId).not.toBe(second.recordId)
    expect(spool.pendingDepth()).toBe(2)
    spool.close()
  })

  it('creates nothing on disk until a write is actually accepted', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)

    expect(spool.pending()).toEqual([])
    expect(spool.pendingDepth()).toBe(0)
    expect(() => readFileSync(join(directory, 'pending.ndjson'), 'utf8')).toThrow('ENOENT')
    spool.close()
  })

  it('carries accepted writes across a reopen and replays them in acceptance order', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.accept(intent('40000000000000002', 'second'))
    writer.close()

    const reader = openDeferredWriteSpool(directory)
    const pending = reader.pending()

    expect(pending).toHaveLength(2)
    expect(pending[0]!.status).toBe('readable')
    expect(pending[0]!.status === 'readable' && pending[0]!.record.intent.content).toBe('first')
    expect(pending[1]!.status === 'readable' && pending[1]!.record.intent.content).toBe('second')
    expect(pending[1]!.status === 'readable' && pending[1]!.record.sequence).toBe(2)
    reader.close()
  })

  it('numbers a record accepted after a reopen from the durable sequence, not from one', () => {
    const directory = tempSpool()
    const first = openDeferredWriteSpool(directory)
    first.accept(intent('40000000000000001', 'first'))
    first.close()

    const second = openDeferredWriteSpool(directory)
    expect(second.accept(intent('40000000000000002', 'second')).sequence).toBe(2)
    second.close()
  })

  it('durably remembers which lines were consumed so a restart does not re-offer them', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.accept(intent('40000000000000002', 'second'))
    const consumed = writer.pending()[0]!
    writer.consume(consumed.line)
    writer.close()

    const reader = openDeferredWriteSpool(directory)
    const pending = reader.pending()

    expect(pending).toHaveLength(1)
    expect(pending[0]!.status === 'readable' && pending[0]!.record.intent.content).toBe('second')
    expect(reader.pendingDepth()).toBe(1)
    reader.close()
  })

  it('reports a tampered record as unreadable instead of replaying or skipping it', () => {
    // ROOT CAUSE:
    //
    // An append-only NDJSON spool cannot tell a truncated tail or an edited line
    // from a good one by parsing alone: `JSON.parse` succeeds on a line whose
    // content was changed, and a half-written line simply throws and would be
    // easy to `continue` past. Either way the deferred write disappears with no
    // operator-visible trace, which is exactly the silent write loss ADR-016 and
    // artifact 09 F-1 forbid.
    //
    // Each record therefore carries a checksum over its own serialized body, and
    // a line that fails to parse or fails its checksum is surfaced as an
    // `unreadable` entry that the caller must dispose of explicitly.
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.accept(intent('40000000000000002', 'second'))
    writer.close()

    const spoolFile = join(directory, 'pending.ndjson')
    const lines = readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean)
    writeFileSync(spoolFile, `${[lines[0]!.replace('"first"', '"tampered"'), lines[1]!].join('\n')}\n`, 'utf8')

    const reader = openDeferredWriteSpool(directory)
    const pending = reader.pending()

    expect(pending).toHaveLength(2)
    expect(pending[0]!.status).toBe('unreadable')
    expect(pending[0]!.status === 'unreadable' && pending[0]!.detail).toContain('checksum')
    expect(pending[1]!.status).toBe('readable')
    reader.close()
  })

  it('reports a truncated tail as unreadable rather than losing it silently', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.close()

    const spoolFile = join(directory, 'pending.ndjson')
    const complete = readFileSync(spoolFile, 'utf8')
    writeFileSync(spoolFile, `${complete}${complete.slice(0, 40)}\n`, 'utf8')

    const reader = openDeferredWriteSpool(directory)
    const pending = reader.pending()

    expect(pending).toHaveLength(2)
    expect(pending[0]!.status).toBe('readable')
    expect(pending[1]!.status).toBe('unreadable')
    reader.close()
  })

  it('rejects an intent it cannot persist rather than accepting it', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)

    // An intent the durable authority could never accept is not a deferred
    // write, it is a defect. Spooling it would convert an immediate, diagnosable
    // rejection into one that surfaces at recovery time with no caller left to
    // report it to.
    expect(() => spool.accept({ ...intent('40000000000000001', 'first'), content: '' })).toThrow('content')
    expect(() => spool.accept({ ...intent('40000000000000002', 'second'), location: { platform: 'discord', channelId: '30000000000000001', channelKind: 'guildText' } })).toThrow('guildId')
    expect(spool.pendingDepth()).toBe(0)
    spool.close()
  })

  it('records a quarantined entry with its reason and advances past it', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.accept(intent('40000000000000002', 'second'))
    const doomed = writer.pending()[0]!

    writer.quarantine(doomed, 'unreplayable', 'authority refused the replay')

    const quarantined = readFileSync(join(directory, 'quarantine.ndjson'), 'utf8').trim().split('\n')
    expect(quarantined).toHaveLength(1)
    expect(JSON.parse(quarantined[0]!).reason).toBe('unreplayable')
    expect(JSON.parse(quarantined[0]!).detail).toBe('authority refused the replay')
    const remaining = writer.pending()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.status === 'readable' && remaining[0]!.record.intent.content).toBe('second')
    writer.close()
  })

  it('fails to open rather than silently restarting from zero when the checkpoint is corrupt', () => {
    // A checkpoint that cannot be read is not the same fact as "nothing was
    // consumed". Treating it as zero would replay records the authority already
    // holds; treating it as the end would drop them. Neither is decidable here,
    // so opening fails and an operator sees it.
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.consume(writer.pending()[0]!.line)
    writer.close()

    writeFileSync(join(directory, 'applied.json'), '{"consumedLines":', 'utf8')

    expect(() => openDeferredWriteSpool(directory)).toThrow('checkpoint')
  })

  it('fails to open when the spool directory is not usable', () => {
    const directory = tempSpool()
    mkdirSync(join(directory, 'pending.ndjson'))

    expect(() => openDeferredWriteSpool(directory)).toThrow()
  })
})

/**
 * The spool's privacy lifecycle (G7 pass condition 4; artifact 21 §11.2).
 *
 * A spooled record is raw user content on the filesystem, outside the
 * authority's deletion, retention, and backup machinery. These cases pin the
 * two halves of the closure that makes that acceptable: bytes leave once the
 * authority owns the write and the checkpoint proving it is durable, and they
 * never leave before that — for anyone.
 */
describe('deferred write spool privacy lifecycle', () => {
  it('erases the raw bytes of consumed records and leaves nothing of them on disk', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)
    spool.accept(intent('40000000000000001', 'replayed private message'))
    spool.accept(intent('40000000000000002', 'still waiting'))
    spool.consume(spool.pending()[0]!.line)

    expect(spool.compact()).toBe(1)

    const remaining = readFileSync(join(directory, 'pending.ndjson'), 'utf8')
    expect(remaining).not.toContain('replayed private message')
    expect(remaining).toContain('still waiting')
    expect(spool.pendingDepth()).toBe(1)
    spool.close()
  })

  it('survives a reopen with the surviving record still readable and replayable', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.accept(intent('40000000000000002', 'second'))
    writer.consume(writer.pending()[0]!.line)
    writer.compact()
    writer.close()

    const reader = openDeferredWriteSpool(directory)
    const pending = reader.pending()

    // The rewritten line must still verify its own checksum, or recovery would
    // classify a survivor of a privacy cleanup as tampered and quarantine it.
    expect(pending).toHaveLength(1)
    expect(pending[0]!.status).toBe('readable')
    expect(pending[0]!.status === 'readable' && pending[0]!.record.intent.content).toBe('second')
    reader.close()
  })

  it('never erases an unreplayed record, including one belonging to another user', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)
    const mine = { ...intent('40000000000000001', 'mine, replayed'), idempotencyKey: 'message:mine', observationKey: 'message:mine' }
    const theirs: DeferredInboundEvent = {
      ...intent('40000000000000002', 'theirs, never replayed'),
      idempotencyKey: 'message:theirs',
      observationKey: 'message:theirs',
      actorEvidence: buildDiscordActorEvidence({ userId: '20000000000000002', displayName: 'Blake', guildId: '10000000000000001', observedAtEpochMs: 1_785_600_000_000, source: 'gateway' }),
    }
    spool.accept(mine)
    spool.accept(theirs)
    // Only the first was disposed of; the second is still the only durable copy
    // of an accepted write, and it belongs to someone else entirely.
    spool.consume(1)

    spool.compact()

    const remaining = readFileSync(join(directory, 'pending.ndjson'), 'utf8')
    expect(remaining).not.toContain('mine, replayed')
    expect(remaining).toContain('theirs, never replayed')
    spool.close()
  })

  it('erases nothing when no record has been consumed', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)
    spool.accept(intent('40000000000000001', 'unreplayed'))

    expect(spool.compact()).toBe(0)
    expect(readFileSync(join(directory, 'pending.ndjson'), 'utf8')).toContain('unreplayed')
    spool.close()
  })

  it('carries an undisposed unreadable line across compaction rather than dropping it', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.accept(intent('40000000000000002', 'second'))
    writer.close()

    const spoolFile = join(directory, 'pending.ndjson')
    const lines = readFileSync(spoolFile, 'utf8').split('\n').filter(Boolean)
    writeFileSync(spoolFile, `${[lines[0]!, lines[1]!.replace('"second"', '"tampered"')].join('\n')}\n`, 'utf8')

    const reader = openDeferredWriteSpool(directory)
    reader.consume(1)
    reader.compact()
    reader.close()

    // Compaction is a privacy cleanup, not a repair: an entry nobody has
    // dispositioned still needs an operator, so it survives.
    const after = openDeferredWriteSpool(directory)
    expect(after.pending()).toHaveLength(1)
    expect(after.pending()[0]!.status).toBe('unreadable')
    after.close()
  })

  it('keeps stamping sequences forward after compaction erased the earlier records', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.accept(intent('40000000000000002', 'second'))
    writer.consume(2)
    writer.compact()
    writer.close()

    // The records that carried sequences 1 and 2 are gone, so the durable
    // high-water mark in the checkpoint is the only thing left that stops a
    // reused sequence from making two records indistinguishable in the audit
    // trail.
    const reopened = openDeferredWriteSpool(directory)
    expect(reopened.accept(intent('40000000000000003', 'third')).sequence).toBe(3)
    reopened.close()
  })

  it('recovers idempotently from a crash between the checkpoint reset and the file swap', () => {
    // ROOT CAUSE:
    //
    // Compaction replaces two files that must agree: the pending records and the
    // checkpoint counting how many of them were disposed of. Writing the
    // compacted file first and the checkpoint second leaves, on a crash between
    // them, a checkpoint claiming N consumed lines over a file that no longer
    // starts with those N — every surviving record would be skipped and lost.
    //
    // The checkpoint is therefore reset to zero while the full file is still in
    // place. A crash there re-offers records the authority already committed,
    // and the spooled idempotency key collapses them. This case reproduces
    // exactly that on-disk state.
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'already applied'))
    writer.accept(intent('40000000000000002', 'not yet applied'))
    writer.consume(1)
    writer.close()

    writeFileSync(join(directory, 'applied.json'), JSON.stringify({ consumedLines: 0, highestSequence: 2 }), 'utf8')

    const recovered = openDeferredWriteSpool(directory)
    const offered = recovered.pending()

    expect(offered).toHaveLength(2)
    expect(offered.map(entry => entry.status === 'readable' ? entry.record.intent.content : 'unreadable')).toEqual(['already applied', 'not yet applied'])
    recovered.close()
  })

  it('quarantines a readable record as content-free audit evidence, never as its body', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)
    spool.accept(intent('40000000000000001', 'private quarantined content'))
    const doomed = spool.pending()[0]!

    spool.quarantine(doomed, 'unreplayable', 'authority refused the replay')

    const raw = readFileSync(join(directory, 'quarantine.ndjson'), 'utf8').trim()
    expect(raw).not.toContain('private quarantined content')
    const entry = JSON.parse(raw) as Record<string, unknown>
    expect(entry.reason).toBe('unreplayable')
    expect(entry.detail).toBe('authority refused the replay')
    expect(entry.line).toBe(1)
    expect(entry.sequence).toBe(1)
    expect(entry.kind).toBe('user_text')
    expect(entry.retentionClass).toBe('transcript')
    expect(entry.recordId).toBe(doomed.status === 'readable' ? doomed.record.recordId : undefined)
    expect(entry.recordChecksum).toMatch(/^[0-9a-f]{64}$/)
    expect(entry).not.toHaveProperty('record')
    expect(entry).not.toHaveProperty('intent')
    spool.close()
  })

  it('quarantines an unreadable line without echoing the bytes that could not be parsed', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'first'))
    writer.close()

    // A corrupt line whose bytes are themselves private content. The parser's
    // own message quotes a prefix of its input, so echoing it would leak the
    // very content quarantine must stop accumulating.
    writeFileSync(join(directory, 'pending.ndjson'), 'leaked secret fragment not json\n', 'utf8')

    const reader = openDeferredWriteSpool(directory)
    const broken = reader.pending()[0]!
    reader.quarantine(broken, 'unreadable', broken.status === 'unreadable' ? broken.detail : '')

    const entry = JSON.parse(readFileSync(join(directory, 'quarantine.ndjson'), 'utf8').trim()) as Record<string, unknown>
    expect(JSON.stringify(entry)).not.toContain('leaked secret fragment')
    expect(entry.reason).toBe('unreadable')
    expect(entry.detail).toBe('line is not JSON')
    expect(entry.rawBytes).toBe(31)
    expect(entry.rawChecksum).toMatch(/^[0-9a-f]{64}$/)
    reader.close()
  })
})

describe('inspectSpoolStorage', () => {
  it('reports an unused directory as holding nothing', () => {
    const census = inspectSpoolStorage(join(tempSpool(), 'never-created'))

    expect(census.present).toBe(false)
    expect(census.pendingRecords).toBe(0)
    expect(census.retainedConsumedRecords).toBe(0)
    expect(census.quarantineEntries).toBe(0)
    expect(census.quarantineCarriesContent).toBe(false)
  })

  it('counts unreplayed, replayed-but-retained, and quarantined records separately', () => {
    const directory = tempSpool()
    const spool = openDeferredWriteSpool(directory)
    spool.accept(intent('40000000000000001', 'replayed'))
    spool.accept(intent('40000000000000002', 'unreplayed'))
    spool.accept(intent('40000000000000003', 'doomed'))
    spool.consume(1)
    // Quarantining line 3 also advances the checkpoint past line 2, which is the
    // documented cost of leaving an entry through quarantine.
    spool.quarantine(spool.pending()[1]!, 'unreplayable', 'refused')
    spool.close()

    const census = inspectSpoolStorage(directory)

    expect(census.present).toBe(true)
    expect(census.retainedConsumedRecords).toBe(3)
    expect(census.pendingRecords).toBe(0)
    expect(census.unreadableRecords).toBe(0)
    expect(census.quarantineEntries).toBe(1)
    expect(census.quarantineCarriesContent).toBe(false)
  })

  it('counts an undisposed record as pending and an undisposed corrupt line as unreadable', () => {
    const directory = tempSpool()
    const writer = openDeferredWriteSpool(directory)
    writer.accept(intent('40000000000000001', 'unreplayed'))
    writer.close()
    writeFileSync(join(directory, 'pending.ndjson'), `${readFileSync(join(directory, 'pending.ndjson'), 'utf8')}not a record\n`, 'utf8')

    const census = inspectSpoolStorage(directory)

    expect(census.pendingRecords).toBe(1)
    expect(census.unreadableRecords).toBe(1)
    expect(census.retainedConsumedRecords).toBe(0)
  })

  it('reports a legacy quarantine file that still carries record bodies', () => {
    const directory = tempSpool()
    openDeferredWriteSpool(directory).close()
    writeFileSync(join(directory, 'quarantine.ndjson'), `${JSON.stringify({ quarantinedAt: '2026-08-16T00:00:00.000Z', reason: 'unreplayable', detail: 'refused', line: 1, record: '{"intent":{"content":"legacy private content"}}' })}\n`, 'utf8')

    expect(inspectSpoolStorage(directory).quarantineCarriesContent).toBe(true)
  })
})
