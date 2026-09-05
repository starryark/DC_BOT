import type { DatabaseSync } from 'node:sqlite'

import process from 'node:process'

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { asCharacterId, asTimestamp } from '@proj-airi/memory-domain'
import { BindingRepository, captureDeletionObligations, createVerifiedBackup, deletionCompletenessReport, deletionTarget, DeliveryRepository, openAuthoritativeSqliteDatabase, openReadOnlySqliteDatabase, ReconciliationQueue, replayDeletionObligations, restoreVerifiedBackup, verifyDatabase, verifyDeletionTarget } from '@proj-airi/memory-sqlite'

import { DELIVERY_RECONCILIATION_POLICY, reconcileDeliveries } from '../../src/memory/delivery-reconciliation'
import { privacyCompletenessReport } from '../../src/memory/privacy-completeness'
import { loadRoomBindingFile, persistedConfiguredBindingMembers } from '../../src/memory/room-bindings'
import { resolveMemoryRuntimePaths } from '../../src/memory/runtime-paths'

type Command = 'status' | 'inspect' | 'integrity' | 'backup' | 'restore' | 'reconcile-bindings' | 'reconcile-deliveries' | 'verify-deletion' | 'smoke'

const HELP = `Usage: pnpm memory:<command> [options]

Commands: status, inspect, integrity, backup, restore, reconcile-bindings,
          reconcile-deliveries, verify-deletion, smoke

Options:
  --root <absolute-directory>  Memory runtime root
  --binding-file <path>       Binding manifest for reconcile-bindings
  --character <id>            Character scope for reconcile-bindings
  --destination <path>        New backup/restore candidate path
  --backup <path>             Verified backup path for restore
  --show-content              Permit inspect to display stored content
  --help                      Show this help
`

/**
 * Runs one local memory operation with read-only inspection and guarded mutation ownership.
 *
 * Call stack:
 *
 * main
 *   -> {@link runReadOnly} | {@link runMutation}
 *     -> memory-sqlite repositories / verified backup APIs
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (!args.command)
    throw new Error('A memory command is required. Use --help for usage.')

  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const configuredRoot = args.root ?? process.env.MEMORY_RUNTIME_ROOT
  const paths = resolveMemoryRuntimePaths(repoRoot, configuredRoot)
  if (!existsSync(paths.authority))
    throw new Error(`Memory authority does not exist: ${paths.authority}`)

  if (args.command === 'status' || args.command === 'inspect' || args.command === 'integrity' || args.command === 'verify-deletion' || args.command === 'smoke') {
    runReadOnly(args.command, paths, args.showContent)
    return
  }
  await runMutation(args.command, args, paths)
}

function runReadOnly(command: Command, paths: ReturnType<typeof resolveMemoryRuntimePaths>, showContent: boolean): void {
  const database = openReadOnlySqliteDatabase(paths.authority)
  try {
    if (command === 'integrity' || command === 'smoke')
      verifyDatabase(database)
    if (command === 'verify-deletion') {
      const obligations = captureDeletionObligations(database)
      for (const obligation of obligations)
        verifyDeletionTarget(database, deletionTarget(obligation.targetTable, obligation.targetId))
      // The database report is authoritative for every class it holds and
      // explicitly not for the external write spool, so the operator surface
      // reports the combination. Printing the SQLite half alone would answer
      // "is deletion complete" with a report that cannot see one of the classes
      // it enumerates.
      const completeness = privacyCompletenessReport({ sqlite: deletionCompletenessReport(database), spoolDirectory: paths.spool })
      print({
        status: completeness.complete ? 'ok' : 'incomplete',
        verifiedObligations: obligations.length,
        privacyCompleteness: {
          complete: completeness.complete,
          blockers: completeness.blockers,
          externallyOwnedClasses: completeness.sqlite.externallyOwnedClasses,
          external: completeness.external,
        },
        deletionCompleteness: {
          classes: completeness.sqlite.classes.map(item => ({ storageClass: item.storageClass, tables: item.tables, disposition: item.disposition, ...(item.check ? { check: item.check } : {}) })),
          verifiedObligations: completeness.sqlite.verifiedObligations,
          lexicalIndexConsistent: completeness.sqlite.lexicalIndexConsistent,
          optionalStoresAbsent: completeness.sqlite.optionalStoresAbsent,
        },
      })
      // Non-zero on an incomplete census, so an operator script cannot read a
      // successful exit as "deletion is complete" while content sits outside.
      if (!completeness.complete)
        process.exitCode = 3
      return
    }
    const metadata = counts(database)
    if (command === 'inspect' && showContent) {
      const content = database.prepare(`SELECT event_id,event_kind,payload_json FROM inbound_event_records ORDER BY occurred_at DESC,event_id DESC LIMIT 25`).all()
      print({ status: 'ok', redacted: false, metadata, content })
    }
    else {
      print({ status: 'ok', redacted: true, metadata })
    }
  }
  finally { database.close() }
}

async function runMutation(command: Command, args: ParsedArgs, paths: ReturnType<typeof resolveMemoryRuntimePaths>): Promise<void> {
  const handle = openAuthoritativeSqliteDatabase(paths.authority)
  try {
    if (command === 'backup') {
      const destination = requiredSafeDestination(args.destination, paths.authorityDirectory)
      mkdirSync(dirname(destination), { recursive: true })
      const manifest = await createVerifiedBackup(handle.database, paths.authority, destination, new Date().toISOString())
      print({ status: 'ok', destination, manifest })
      return
    }
    if (command === 'restore') {
      const backupPath = requiredAbsolute(args.backup, '--backup')
      const destination = requiredSafeDestination(args.destination, paths.authorityDirectory)
      mkdirSync(dirname(destination), { recursive: true })
      const obligations = captureDeletionObligations(handle.database)
      await restoreVerifiedBackup(backupPath, destination, database => replayDeletionObligations(database, obligations))
      print({ status: 'ok', destination, replayedObligations: obligations.length, promotionRequired: true })
      return
    }
    if (command === 'reconcile-bindings') {
      const bindingFile = requiredAbsolute(args.bindingFile ?? process.env.MEMORY_BINDING_FILE, '--binding-file')
      const characterId = asCharacterId(args.character ?? process.env.CHARACTER_ID ?? '')
      if (!characterId)
        throw new Error('--character is required')
      const members = persistedConfiguredBindingMembers(loadRoomBindingFile(bindingFile), characterId)
      const manifest = new BindingRepository(handle.database).reconcileConfigured({ owner: 'config:discord-bot', members, at: asTimestamp(new Date().toISOString()) })
      print({ status: 'ok', manifest })
      return
    }
    if (command === 'reconcile-deliveries') {
      // IMP-406: run the same bounded reconciliation pass the runtime runs at
      // startup, then surface content-free state plus any still-unresolved rows.
      const repository = new DeliveryRepository(handle.database)
      const queue = new ReconciliationQueue(handle.database)
      const summary = reconcileDeliveries(
        {
          deliveries: repository,
          queue,
          now: () => new Date().toISOString(),
          id: randomUUID,
          workerId: `discord-bot:operator:${process.pid}`,
          random: Math.random,
        },
        DELIVERY_RECONCILIATION_POLICY,
      )
      const unresolved = repository.unresolved()
      print({
        status: 'ok',
        summary: { ...summary, operatorReviewTotal: repository.countByState('abandoned') },
        unresolved: unresolved.map(item => ({ deliveryId: item.deliveryId, state: item.state, transport: item.transport, destinationId: item.destinationId })),
      })
      return
    }
    throw new Error(`Unsupported mutation command: ${command}`)
  }
  finally { handle.close() }
}

function counts(database: DatabaseSync): Record<string, number> {
  const tables = ['inbound_event_records', 'generation_attempt_records', 'output_segment_records', 'delivery_attempt_records', 'room_binding_records', 'forget_requests', 'deletion_tombstones']
  return Object.fromEntries(tables.map((table) => {
    const row = database.prepare(`SELECT count(*) count FROM ${table}`).get() as { count: number }
    return [table, row.count]
  }))
}

interface ParsedArgs { command?: Command, root?: string, bindingFile?: string, character?: string, destination?: string, backup?: string, showContent: boolean, help: boolean }

function parseArgs(values: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { showContent: false, help: false }
  const commands = new Set<Command>(['status', 'inspect', 'integrity', 'backup', 'restore', 'reconcile-bindings', 'reconcile-deliveries', 'verify-deletion', 'smoke'])
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (commands.has(value as Command) && !result.command)
      result.command = value as Command
    else if (value === '--show-content')
      result.showContent = true
    else if (value === '--help' || value === '-h')
      result.help = true
    else if (value === '--root')
      result.root = values[++index]
    else if (value === '--binding-file')
      result.bindingFile = values[++index]
    else if (value === '--character')
      result.character = values[++index]
    else if (value === '--destination')
      result.destination = values[++index]
    else if (value === '--backup')
      result.backup = values[++index]
    else throw new Error(`Unknown or incomplete argument: ${value}`)
  }
  return result
}

function requiredAbsolute(value: string | undefined, option: string): string {
  if (!value || !isAbsolute(value))
    throw new Error(`${option} must be an absolute path`)
  return resolve(value)
}

function requiredSafeDestination(value: string | undefined, authorityDirectory: string): string {
  const destination = requiredAbsolute(value, '--destination')
  const relationship = relative(authorityDirectory, destination)
  if (relationship === '' || (!relationship.startsWith('..') && !isAbsolute(relationship)))
    throw new Error('Destination must be outside the live authority directory')
  return destination
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

main().catch((error: unknown) => {
  let message = String(error)
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string')
    message = error.message
  process.stderr.write(`${JSON.stringify({ status: 'error', message })}\n`)
  process.exitCode = 1
})
