import type { InboundEventKind, PhysicalLocation, RetentionClass, Timestamp } from '@proj-airi/memory-domain'

import type { IngressActorEvidence } from './discord-actor-snapshot'

import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { asTimestamp, identityKeyFor, isValidId, MAX_EVENT_CONTENT_LENGTH, MemoryError, physicalRoomIdOf } from '@proj-airi/memory-domain'

/**
 * The approved durable write spool of the degraded stateless posture
 * (`FF-DURABLE-WRITE-SPOOL`; artifact 09 §10.6; artifact 16 REQ-OPS-001).
 *
 * When the authoritative store is unusable, this is the only place a write may
 * go, and accepting one here is the *only* thing that makes "we took your
 * message" true. That is why {@link DeferredWriteSpool.accept} is synchronous
 * and fsyncs before it returns: the acknowledgement the caller passes on must
 * already be backed by bytes on disk, because the next thing that happens may
 * be the process dying.
 *
 * What a record deliberately does *not* contain is any durable identifier. A
 * degraded process has no authority to allocate a person, room, or event id,
 * and inventing one so execution can continue is how a spool ends up
 * back-filling durable state that never existed. A record therefore carries the
 * raw ingress evidence plus the two correlation keys the live path would have
 * used — `idempotencyKey` for the event append, `observationKey` for the
 * identity observation — and recovery resolves canonical identity through the
 * authority it replays into.
 *
 * Layout under the runtime's reserved `spool/` directory:
 *
 * - `pending.ndjson` — append-only between compactions, one checksummed record
 *   per line.
 * - `applied.json` — how many lines of `pending.ndjson` recovery has disposed
 *   of, and the highest sequence ever stamped. Written atomically through
 *   `applied.json.tmp`.
 * - `quarantine.ndjson` — content-free evidence for records that left the spool
 *   without reaching the authority. Nothing is ever removed silently.
 *
 * A spooled record is raw user content on the filesystem, outside the
 * authoritative database and outside its backup and deletion machinery. That is
 * acceptable only while the content is still the *only* durable copy of an
 * accepted write. Once recovery has committed a record into the authority and
 * the checkpoint recording that is durable, the spool copy is an unmanaged
 * duplicate that no forget or retention pass can reach, so {@link
 * DeferredWriteSpool.compact} removes it. Compaction never touches an
 * unreplayed record, whoever wrote it.
 */

/**
 * One inbound turn, captured as replayable intent rather than as durable state.
 *
 * Every field is either raw platform evidence or a correlation key the live
 * write path already uses, so replaying this record produces exactly the append
 * the healthy path would have produced.
 */
export interface DeferredInboundEvent {
  /** The event append's dedupe key, identical to the one the live path uses. */
  readonly idempotencyKey: string
  /** The identity observation's dedupe key, identical to the one the live path uses. */
  readonly observationKey: string
  readonly kind: Extract<InboundEventKind, 'user_text' | 'user_voice'>
  /** Ingress evidence frozen at the boundary; never a resolved person. */
  readonly actorEvidence: IngressActorEvidence
  /** Where it happened, as platform coordinates; never a resolved room id. */
  readonly location: PhysicalLocation
  readonly occurredAt: Timestamp
  readonly content: string
  readonly retentionClass: RetentionClass
}

/**
 * Proof that a deferred write is on disk.
 *
 * `durability` is fixed at `spooled` because that is the only thing this module
 * can ever report. A caller holding one of these must not tell a user anything
 * was remembered (ADR-016, artifact 09 F-1).
 */
export interface SpoolAcceptance {
  readonly recordId: string
  readonly sequence: number
  readonly durability: 'spooled'
}

/** A spooled write as it was durably stored. */
export interface SpooledRecord {
  /**
   * Durable position stamped into the record when it was accepted. Distinct
   * from {@link SpoolEntry}'s `line`, which is the record's *current* physical
   * position and is what the checkpoint counts — an unreadable line has no
   * sequence to count by.
   */
  readonly sequence: number
  readonly recordId: string
  readonly spooledAt: string
  readonly intent: DeferredInboundEvent
}

/**
 * One line of the pending spool, readable or not.
 *
 * An `unreadable` line is surfaced rather than skipped: a truncated tail and a
 * tampered record look identical to a parser, and quietly continuing past
 * either is the silent write loss the spool exists to prevent.
 */
export type SpoolEntry
  = | { readonly status: 'readable', readonly line: number, readonly record: SpooledRecord }
    | { readonly status: 'unreadable', readonly line: number, readonly raw: string, readonly detail: string }

/** Why a record left the spool without reaching the authority. */
export type SpoolQuarantineReason = 'unreadable' | 'unreplayable'

/**
 * The degraded posture's write path, exposed on the runtime beside the
 * authority surfaces the healthy postures expose.
 *
 * It is deliberately not a `TraceMemoryAuthority`: that contract speaks in
 * resolved person, room, and event ids, and in this posture none of them exist.
 */
export interface DeferredMemoryAuthority {
  /** Durably accepts one inbound turn for later replay. Never a durable success. */
  spoolInboundEvent: (intent: DeferredInboundEvent) => Promise<SpoolAcceptance>
}

/**
 * A durable spool bound to one directory.
 *
 * `accept` is the degraded write path; `pending`/`consume`/`quarantine` are the
 * recovery path and are driven by `replayDeferredWrites`. One process owns the
 * spool at a time, the same sole-writer assumption the authority is opened
 * under.
 */
export interface DeferredWriteSpool {
  readonly directory: string
  accept: (intent: DeferredInboundEvent) => SpoolAcceptance
  /** Entries after the durable checkpoint, in acceptance order. */
  pending: () => readonly SpoolEntry[]
  pendingDepth: () => number
  /** Durably records that `line` was applied. Must advance, never rewind. */
  consume: (line: number) => void
  /** Durably records why an entry was abandoned, then consumes it. */
  quarantine: (entry: SpoolEntry, reason: SpoolQuarantineReason, detail: string) => void
  /**
   * Erases the raw bytes of every record already disposed of, keeping every
   * record that is not. Returns how many were erased.
   *
   * Renumbers the lines of everything that survives, so it must not run while a
   * replay pass is in flight: that pass holds `line` values from before the
   * move and would consume the wrong records with them. Call it after a pass
   * completes, which is where recovery calls it.
   */
  compact: () => number
  close: () => void
}

/**
 * What a spool directory holds, read without taking ownership of it.
 *
 * The runtime's privacy-completeness surface needs to know whether unmanaged
 * content is sitting outside the database, and it must be able to ask without
 * creating the directory or competing with the process that owns the spool —
 * so this reads the same files {@link openDeferredWriteSpool} writes and
 * reports counts only, never content.
 */
export interface SpoolStorageCensus {
  readonly directory: string
  readonly present: boolean
  /** Records not yet disposed of. Each is the only durable copy of an accepted write. */
  readonly pendingRecords: number
  /** Lines that parse as records but are unreadable; also undisposed. */
  readonly unreadableRecords: number
  /** Disposed-of records whose raw bytes are still on disk. Compaction clears these. */
  readonly retainedConsumedRecords: number
  readonly quarantineEntries: number
  /** True when any quarantine entry still carries a raw record body. */
  readonly quarantineCarriesContent: boolean
}

const PENDING_FILE = 'pending.ndjson'
const CHECKPOINT_FILE = 'applied.json'
const CHECKPOINT_TEMPORARY_FILE = 'applied.json.tmp'
const QUARANTINE_FILE = 'quarantine.ndjson'
/** Kept distinct from the checkpoint's temporary file so one cannot block the other. */
const COMPACTION_TEMPORARY_FILE = 'pending.ndjson.compacting'

/**
 * Validates that an intent is one the authority could actually accept later.
 *
 * Deferring a write that can never replay is worse than refusing it: the
 * caller that could still have reported the problem is long gone by the time
 * recovery discovers it. The checks mirror the durable append's own
 * preconditions and reuse the domain's validators wherever they exist.
 */
function assertReplayableIntent(intent: DeferredInboundEvent): void {
  if (!intent.idempotencyKey || !isValidId(intent.idempotencyKey))
    throw new MemoryError('INVALID_ID', 'a deferred write requires an idempotency key the durable append would accept')
  if (!intent.observationKey)
    throw new MemoryError('INVALID_ID', 'a deferred write requires an identity observation key')
  if (intent.kind !== 'user_text' && intent.kind !== 'user_voice')
    throw new MemoryError('UNKNOWN_EVENT_KIND', `a deferred write cannot carry event kind ${JSON.stringify(intent.kind)}`)
  if (intent.retentionClass !== 'transcript' && intent.retentionClass !== 'command' && intent.retentionClass !== 'systemMetadata')
    throw new MemoryError('INVALID_PAYLOAD', `a deferred write cannot carry retention class ${JSON.stringify(intent.retentionClass)}`)
  if (typeof intent.content !== 'string' || intent.content.length === 0)
    throw new MemoryError('EMPTY_CONTENT', 'a deferred write requires event content')
  if (intent.content.length > MAX_EVENT_CONTENT_LENGTH)
    throw new MemoryError('PAYLOAD_TOO_LARGE', `a deferred write may not exceed ${MAX_EVENT_CONTENT_LENGTH} characters`)
  asTimestamp(intent.occurredAt)
  // Throws for a DM carrying a guild id, or a guild channel missing one, which
  // are exactly the shapes the room repository would refuse at replay time.
  physicalRoomIdOf(intent.location)
  assertReplayableEvidence(intent.actorEvidence)
}

function assertReplayableEvidence(evidence: IngressActorEvidence): void {
  if (evidence?.kind === 'attributed') {
    identityKeyFor(evidence.snapshot.platformUserId)
    if (!evidence.snapshot.displayNameAtEvent)
      throw new MemoryError('INVALID_ACTOR', 'attributed ingress evidence requires the name that was actually displayed')
    asTimestamp(evidence.snapshot.observedAt)
    return
  }
  if (evidence?.kind === 'anonymous') {
    if (!evidence.actor.displayNameAtEvent)
      throw new MemoryError('INVALID_ACTOR', 'anonymous ingress evidence requires the name that was actually displayed')
    asTimestamp(evidence.actor.observedAt)
    return
  }
  throw new MemoryError('INVALID_ACTOR', 'a deferred write requires attributed or anonymous ingress evidence')
}

/**
 * Renders a failure into the text that is stored as a spool `detail`.
 *
 * Bounded and single-line on purpose: the value is written into an operator-read
 * NDJSON field, where an unbounded stack trace would bury the reason it exists
 * to carry.
 */
function failureText(error: unknown): string {
  const message = error instanceof MemoryError ? `${error.code}: ${error.message}` : String(error)
  return message.replace(/\s+/g, ' ').slice(0, 300)
}

/** Digest of the serialized record body, so a rewritten line cannot pass as original. */
function checksumOf(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

/** Parses one spool line, proving it is byte-for-byte the record that was accepted. */
function readEntry(line: number, raw: string): SpoolEntry {
  let parsed: { checksum?: unknown, record?: unknown }
  try {
    parsed = JSON.parse(raw) as { checksum?: unknown, record?: unknown }
  }
  catch {
    // Deliberately not the parser's own message: V8 quotes a prefix of the
    // offending input, and this detail is written into `quarantine.ndjson`,
    // which must not accumulate fragments of user content. "It did not parse"
    // is the whole diagnosis a corrupt line supports anyway.
    return { status: 'unreadable', line, raw, detail: 'line is not JSON' }
  }
  if (typeof parsed?.checksum !== 'string' || typeof parsed?.record !== 'object' || parsed.record === null)
    return { status: 'unreadable', line, raw, detail: 'line is not a checksummed spool record' }
  // `JSON.parse` preserves key order, so re-serializing the parsed record
  // reproduces the exact bytes that were digested when it was accepted.
  if (checksumOf(JSON.stringify(parsed.record)) !== parsed.checksum)
    return { status: 'unreadable', line, raw, detail: 'record checksum does not match its content' }

  const record = parsed.record as Partial<SpooledRecord>
  if (!Number.isSafeInteger(record.sequence) || typeof record.recordId !== 'string' || typeof record.spooledAt !== 'string' || typeof record.intent !== 'object' || record.intent === null)
    return { status: 'unreadable', line, raw, detail: 'record is missing its durable position or its intent' }
  try {
    assertReplayableIntent(record.intent as DeferredInboundEvent)
  }
  catch (error) {
    return { status: 'unreadable', line, raw, detail: `intent is not replayable: ${failureText(error)}` }
  }
  return { status: 'readable', line, record: record as SpooledRecord }
}

interface SpoolCheckpoint {
  readonly consumedLines: number
  /**
   * The highest sequence ever stamped by {@link DeferredWriteSpool.accept}.
   *
   * Carried in the checkpoint because compaction removes the records that would
   * otherwise be the only evidence of it, and a sequence reused after
   * compaction would make two different records indistinguishable in the
   * quarantine audit trail. Compaction persists it before those records go
   * away, so the value survives the one operation that could lose it.
   */
  readonly highestSequence: number
}

function readCheckpoint(path: string): SpoolCheckpoint {
  if (!existsSync(path))
    return { consumedLines: 0, highestSequence: 0 }
  const raw = readFileSync(path, 'utf8')
  let parsed: { consumedLines?: unknown, highestSequence?: unknown }
  try {
    parsed = JSON.parse(raw) as { consumedLines?: unknown, highestSequence?: unknown }
  }
  catch (error) {
    throw new Error(`memory spool checkpoint at ${path} is unreadable and recovery cannot tell which writes were applied: ${failureText(error)}`)
  }
  const consumed = parsed?.consumedLines
  if (!Number.isSafeInteger(consumed) || (consumed as number) < 0)
    throw new Error(`memory spool checkpoint at ${path} is unreadable and recovery cannot tell which writes were applied`)
  const highest = parsed?.highestSequence
  return { consumedLines: consumed as number, highestSequence: Number.isSafeInteger(highest) && (highest as number) >= 0 ? highest as number : 0 }
}

/** Writes `data` and returns only once the bytes are on the device. */
function writeDurably(path: string, data: string, flags: 'a' | 'w'): void {
  const handle = openSync(path, flags)
  try {
    writeSync(handle, data)
    fsyncSync(handle)
  }
  finally {
    closeSync(handle)
  }
}

/**
 * Opens the spool in `directory`, reading whatever a previous process left.
 *
 * Creates no files until something is actually accepted or consumed, so a
 * healthy startup that finds no deferred writes leaves no trace of a spool it
 * never needed.
 */
export function openDeferredWriteSpool(directory: string): DeferredWriteSpool {
  mkdirSync(directory, { recursive: true })
  const pendingPath = join(directory, PENDING_FILE)
  const checkpointPath = join(directory, CHECKPOINT_FILE)
  const temporaryCheckpointPath = join(directory, CHECKPOINT_TEMPORARY_FILE)
  const quarantinePath = join(directory, QUARANTINE_FILE)
  const compactionPath = join(directory, COMPACTION_TEMPORARY_FILE)

  const readLines = (): string[] => existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8').split('\n').filter(line => line.length > 0) : []
  const checkpoint = readCheckpoint(checkpointPath)
  let consumedLines = checkpoint.consumedLines
  let entries = readLines().map((raw, index) => readEntry(index + 1, raw))
  // A record on disk outranks the checkpoint here: `accept` stamps a sequence
  // and fsyncs the record without touching the checkpoint, so after a crash the
  // records are the fresher evidence of how far numbering got.
  let highestSequence = entries.reduce((highest, entry) => entry.status === 'readable' ? Math.max(highest, entry.record.sequence) : highest, checkpoint.highestSequence)
  let appendHandle: number | undefined

  const writeCheckpoint = (consumed: number): void => {
    // Temporary file plus rename, so a torn write can never leave a checkpoint
    // that claims more or less than one of the two real values.
    writeDurably(temporaryCheckpointPath, JSON.stringify({ consumedLines: consumed, highestSequence }), 'w')
    renameSync(temporaryCheckpointPath, checkpointPath)
    consumedLines = consumed
  }
  const closeAppendHandle = (): void => {
    if (appendHandle === undefined)
      return
    const handle = appendHandle
    appendHandle = undefined
    closeSync(handle)
  }

  return {
    directory,
    accept: (intent) => {
      assertReplayableIntent(intent)
      const sequence = ++highestSequence
      const record: SpooledRecord = { sequence, recordId: randomUUID(), spooledAt: new Date().toISOString(), intent }
      const body = JSON.stringify(record)
      const serialized = `${JSON.stringify({ checksum: checksumOf(body), record })}\n`
      if (appendHandle === undefined)
        appendHandle = openSync(pendingPath, 'a')
      writeSync(appendHandle, serialized)
      fsyncSync(appendHandle)
      entries = [...entries, { status: 'readable', line: entries.length + 1, record }]
      return { recordId: record.recordId, sequence, durability: 'spooled' }
    },
    pending: () => entries.slice(consumedLines),
    pendingDepth: () => entries.length - consumedLines,
    consume: (line) => {
      // Re-consuming an already-consumed line is a no-op rather than an error:
      // recovery retries a record whose checkpoint write was lost, and that
      // retry must not look like a fault.
      if (line <= consumedLines)
        return
      if (line > entries.length)
        throw new Error(`memory spool cannot consume line ${line}; only ${entries.length} are spooled`)
      writeCheckpoint(line)
    },
    quarantine: (entry, reason, detail) => {
      // Content-free by construction. The old format stored the record body,
      // which turned quarantine into an indefinite archive of raw private
      // content that no forget or retention pass could reach. What an operator
      // needs to investigate is which record failed and why, so identity,
      // position, timing, classification and a bounded diagnostic stay, and a
      // digest stands in for the body it replaces.
      const evidence = entry.status === 'readable'
        ? { recordId: entry.record.recordId, sequence: entry.record.sequence, spooledAt: entry.record.spooledAt, kind: entry.record.intent.kind, retentionClass: entry.record.intent.retentionClass, recordChecksum: checksumOf(JSON.stringify(entry.record)) }
        : { rawBytes: Buffer.byteLength(entry.raw, 'utf8'), rawChecksum: checksumOf(entry.raw) }
      writeDurably(quarantinePath, `${JSON.stringify({ quarantinedAt: new Date().toISOString(), reason, detail, line: entry.line, ...evidence })}\n`, 'a')
      // Only after the reason is durable: a crash between the two leaves the
      // entry pending and it is offered again, which is recoverable. The
      // reverse order would lose it with no record of why.
      if (entry.line > consumedLines)
        writeCheckpoint(entry.line)
    },
    compact: () => {
      const erased = Math.min(consumedLines, entries.length)
      if (erased === 0)
        return 0
      const survivors = entries.slice(consumedLines)
      // Rewriting the file means reproducing the bytes that were digested when
      // each record was accepted, so a survivor still verifies its own checksum
      // after the move. An unreadable line is carried across verbatim: it is
      // undisposed of, and this is a privacy cleanup, not a repair.
      const kept = survivors.map(entry => entry.status === 'readable'
        ? `${JSON.stringify({ checksum: checksumOf(JSON.stringify(entry.record)), record: entry.record })}\n`
        : `${entry.raw}\n`).join('')
      // The append handle points at the file about to be replaced, and on
      // Windows an open handle also blocks the rename outright.
      closeAppendHandle()
      writeDurably(compactionPath, kept, 'w')
      // Order is the whole crash-safety argument. The checkpoint drops to zero
      // while the full file is still in place, so a crash here re-offers records
      // the authority already holds and its idempotency key collapses them —
      // redundant, never lossy. The reverse order would leave a checkpoint
      // claiming records the compacted file no longer starts with, which would
      // skip past surviving writes and lose them silently.
      writeCheckpoint(0)
      renameSync(compactionPath, pendingPath)
      entries = readLines().map((raw, index) => readEntry(index + 1, raw))
      return erased
    },
    close: closeAppendHandle,
  }
}

/**
 * Reports what a spool directory holds without opening or creating it.
 *
 * Read-only and allocation-free of any durable state, so a privacy or operator
 * surface can ask about external content while another process owns the spool.
 * A directory that has never been used reports `present: false` rather than
 * failing, because a runtime that never degraded has no spool to account for.
 *
 * Throws, rather than reporting zero, when the checkpoint is unreadable: how
 * many records were disposed of is then unknown, and every count derived from
 * it would be a guess presented as a census.
 */
export function inspectSpoolStorage(directory: string): SpoolStorageCensus {
  const pendingPath = join(directory, PENDING_FILE)
  const quarantinePath = join(directory, QUARANTINE_FILE)
  const lines = existsSync(pendingPath) ? readFileSync(pendingPath, 'utf8').split('\n').filter(line => line.length > 0) : []
  const consumedLines = Math.min(readCheckpoint(join(directory, CHECKPOINT_FILE)).consumedLines, lines.length)
  const undisposed = lines.slice(consumedLines).map((raw, index) => readEntry(consumedLines + index + 1, raw))
  const quarantineLines = existsSync(quarantinePath) ? readFileSync(quarantinePath, 'utf8').split('\n').filter(line => line.length > 0) : []
  // A legacy quarantine file — or one an operator hand-edited — can still carry
  // a record body, and reporting completeness over it would be false.
  const carriesContent = quarantineLines.some((line) => {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>
      return 'record' in parsed || 'intent' in parsed || 'content' in parsed
    }
    catch {
      return true
    }
  })
  return {
    directory,
    present: existsSync(directory),
    pendingRecords: undisposed.filter(entry => entry.status === 'readable').length,
    unreadableRecords: undisposed.filter(entry => entry.status === 'unreadable').length,
    retainedConsumedRecords: consumedLines,
    quarantineEntries: quarantineLines.length,
    quarantineCarriesContent: carriesContent,
  }
}
