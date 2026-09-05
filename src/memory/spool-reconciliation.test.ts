import type { DeferredInboundEvent } from './write-spool'

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { asTimestamp, MemoryError } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it } from 'vitest'

import { buildDiscordActorEvidence } from './discord-actor-snapshot'
import { replayDeferredWrites } from './spool-reconciliation'
import { openDeferredWriteSpool } from './write-spool'

/**
 * Replay policy for the deferred-write spool (G5 pass condition 4;
 * artifact 09 §10.6; artifact 16 REQ-OPS-001, REQ-OPS-005, TEST-OPS-006).
 *
 * The spool file mechanics are proven in `write-spool.test.ts` and the wiring
 * into the production startup path in `degraded-mode.test.ts`. What is decided
 * here, and only here, is what the coordinator does with each outcome the
 * authority can return: applied, already-present, permanently refused, or
 * temporarily unavailable. Those four are the whole policy, and confusing any
 * two of them either duplicates durable state or loses a write silently.
 */

const directories: string[] = []
afterEach(() => directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true })))

function tempSpool(): string {
  const directory = mkdtempSync(join(tmpdir(), 'airi-memory-replay-'))
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

function spoolWith(contents: readonly string[]): string {
  const directory = tempSpool()
  const spool = openDeferredWriteSpool(directory)
  contents.forEach((content, index) => spool.accept(intent(`4000000000000000${index + 1}`, content)))
  spool.close()
  return directory
}

describe('replayDeferredWrites', () => {
  it('applies every pending write in acceptance order and consumes it', () => {
    const directory = spoolWith(['first', 'second', 'third'])
    const spool = openDeferredWriteSpool(directory)
    const applied: string[] = []

    const summary = replayDeferredWrites({
      spool,
      apply: (deferred) => {
        applied.push(deferred.content)
        return { deduplicated: false }
      },
    })

    expect(applied).toEqual(['first', 'second', 'third'])
    expect(summary.applied).toBe(3)
    expect(summary.deduplicated).toBe(0)
    expect(summary.quarantined).toBe(0)
    expect(summary.pending).toBe(0)
    expect(spool.pendingDepth()).toBe(0)
    spool.close()
  })

  it('counts an already-present write as deduplicated rather than as a new durable append', () => {
    // ROOT CAUSE:
    //
    // Recovery re-offers any record whose authority commit landed but whose
    // spool checkpoint did not, because that is precisely the state a crash in
    // that window leaves behind. If replay treated the authority's idempotent
    // "already have this" answer as a fresh append it would still be correct
    // durably, but the operator-facing count would claim durable growth that
    // did not happen, which is the false-success signal G5 condition 4 forbids.
    const directory = spoolWith(['first', 'second'])
    const spool = openDeferredWriteSpool(directory)

    const summary = replayDeferredWrites({ spool, apply: () => ({ deduplicated: true }) })

    expect(summary.applied).toBe(0)
    expect(summary.deduplicated).toBe(2)
    expect(summary.pending).toBe(0)
    spool.close()
  })

  it('quarantines a permanently refused write with its cause instead of dropping it', () => {
    const directory = spoolWith(['first', 'second'])
    const spool = openDeferredWriteSpool(directory)

    const summary = replayDeferredWrites({
      spool,
      apply: (deferred) => {
        if (deferred.content === 'first')
          throw new MemoryError('POLICY_VIOLATION', 'event idempotency key was reused with conflicting input')
        return { deduplicated: false }
      },
    })

    expect(summary.quarantined).toBe(1)
    expect(summary.applied).toBe(1)
    expect(summary.pending).toBe(0)
    const quarantined = readFileSync(join(directory, 'quarantine.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(quarantined).toHaveLength(1)
    expect(quarantined[0].reason).toBe('unreplayable')
    expect(quarantined[0].detail).toContain('POLICY_VIOLATION')
    spool.close()
  })

  it('halts on a retryable failure and leaves the write pending for the next pass', () => {
    // A retryable failure is the authority being unavailable, not the record
    // being bad. Quarantining it would discard a good write; continuing past it
    // would replay later records out of order against a store that is still
    // failing. The pass stops and the record stays pending.
    const directory = spoolWith(['first', 'second'])
    const spool = openDeferredWriteSpool(directory)

    const summary = replayDeferredWrites({
      spool,
      apply: () => {
        throw new MemoryError('PERSISTENCE_FAILED', 'database is locked', { retryable: true })
      },
    })

    expect(summary.applied).toBe(0)
    expect(summary.quarantined).toBe(0)
    expect(summary.pending).toBe(2)
    expect(summary.halted).toContain('PERSISTENCE_FAILED')
    expect(spool.pendingDepth()).toBe(2)
    spool.close()
  })

  it('resumes from the durable checkpoint after a halted pass', () => {
    const directory = spoolWith(['first', 'second'])
    const first = openDeferredWriteSpool(directory)
    let attempt = 0
    const replayed: string[] = []
    replayDeferredWrites({
      spool: first,
      apply: (deferred) => {
        attempt += 1
        if (attempt === 2)
          throw new MemoryError('UNAVAILABLE', 'authority went away', { retryable: true })
        replayed.push(deferred.content)
        return { deduplicated: false }
      },
    })
    first.close()

    const second = openDeferredWriteSpool(directory)
    const summary = replayDeferredWrites({
      spool: second,
      apply: (deferred) => {
        replayed.push(deferred.content)
        return { deduplicated: false }
      },
    })

    expect(replayed).toEqual(['first', 'second'])
    expect(summary.applied).toBe(1)
    expect(summary.pending).toBe(0)
    second.close()
  })

  it('quarantines an unreadable line without offering it to the authority', () => {
    const directory = spoolWith(['first'])
    const spoolFile = join(directory, 'pending.ndjson')
    const complete = readFileSync(spoolFile, 'utf8')
    writeFileSync(spoolFile, `${complete}${complete.slice(0, 40)}\n`, 'utf8')
    const spool = openDeferredWriteSpool(directory)
    const offered: string[] = []

    const summary = replayDeferredWrites({
      spool,
      apply: (deferred) => {
        offered.push(deferred.content)
        return { deduplicated: false }
      },
    })

    expect(offered).toEqual(['first'])
    expect(summary.applied).toBe(1)
    expect(summary.quarantined).toBe(1)
    expect(summary.pending).toBe(0)
    const quarantined = JSON.parse(readFileSync(join(directory, 'quarantine.ndjson'), 'utf8').trim())
    expect(quarantined.reason).toBe('unreadable')
    spool.close()
  })

  it('propagates a spool failure instead of reporting it as the authority being busy', () => {
    // ROOT CAUSE:
    //
    // The first implementation wrapped the authority call and the checkpoint
    // write in one try block, so an unwritable checkpoint was classified by
    // `isTransient` like any store failure — an unrecognized error, therefore
    // "retry later" — and the pass returned a clean halted summary:
    //
    //   try { apply(intent); spool.consume(entry.line) }
    //   catch (error) { if (isTransient(error)) return { ...halted } }
    //
    // That is the one classification that is never safe. The commit the
    // checkpoint was meant to record had already happened, so startup would
    // report an orderly incomplete recovery while durable state and spool state
    // had silently diverged.
    //
    // We fixed this by classifying only the authority call. A spool failure now
    // escapes the pass, and the composition module fails startup on it.
    const directory = spoolWith(['first'])
    const spool = openDeferredWriteSpool(directory)
    const committed: string[] = []

    expect(() => replayDeferredWrites({
      spool: {
        pending: () => spool.pending(),
        quarantine: (entry, reason, detail) => spool.quarantine(entry, reason, detail),
        consume: () => {
          throw new Error('EISDIR: illegal operation on a directory')
        },
      },
      apply: (deferred) => {
        committed.push(deferred.content)
        return { deduplicated: false }
      },
    })).toThrow('EISDIR')

    expect(committed).toEqual(['first'])
    spool.close()
  })

  it('reports an empty spool as an empty pass rather than as work done', () => {
    const spool = openDeferredWriteSpool(tempSpool())

    const summary = replayDeferredWrites({ spool, apply: () => ({ deduplicated: false }) })

    expect(summary).toEqual({ applied: 0, deduplicated: 0, quarantined: 0, pending: 0 })
    spool.close()
  })
})
