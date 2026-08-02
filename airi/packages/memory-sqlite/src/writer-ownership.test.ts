import type { ChildProcess } from 'node:child_process'

import { fork } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { MemoryError } from '@proj-airi/memory-domain'
import { afterEach, describe, expect, it } from 'vitest'

import { openSqliteDatabase } from './connection-profile.js'
import { acquireSqliteWriterOwnership, canonicalSqliteAuthorityIdentity, openAuthoritativeSqliteDatabase, sqliteWriterLeasePath, SqliteWriterOwnershipError } from './writer-ownership.js'

const roots: string[] = []
const children: ChildProcess[] = []
const childFixture = new URL('./fixtures/writer-ownership-child.ts', import.meta.url)

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'dc-bot-writer-ownership-'))
  roots.push(value)
  return value
}

function startChild(mode: 'hold' | 'crash-after-ready' | 'try-acquire', path: string, timeoutMs = 250): ChildProcess {
  const child = fork(childFixture, [mode, path, String(timeoutMs)], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  children.push(child)
  return child
}

function nextMessage<T extends { type: string }>(child: ChildProcess, expected: T['type'], timeoutMs = 5_000): Promise<T> {
  return new Promise((resolveMessage, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not report ${expected} within ${timeoutMs} ms`)), timeoutMs)
    function onError(error: Error) {
      clearTimeout(timer)
      child.off('message', onMessage)
      reject(error)
    }
    function onMessage(message: unknown) {
      const payload = message as T
      if (payload.type !== expected)
        return
      clearTimeout(timer)
      child.off('error', onError)
      child.off('message', onMessage)
      resolveMessage(payload)
    }
    child.on('message', onMessage)
    child.once('error', onError)
  })
}

function exited(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode != null || child.signalCode != null)
    return Promise.resolve()
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs} ms`)), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
  })
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode == null && child.signalCode == null)
      child.kill('SIGKILL')
  }
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('authoritative SQLite writer ownership', () => {
  it('acquires, closes idempotently, and reacquires after clean release', async () => {
    const path = join(await root(), 'authority.db')
    const first = openAuthoritativeSqliteDatabase(path)
    expect(first.closed).toBe(false)
    expect(first.ownership.held).toBe(true)
    first.close()
    first.close()
    expect(first.closed).toBe(true)
    expect(first.ownership.held).toBe(false)

    const second = openAuthoritativeSqliteDatabase(path)
    second.close()
  })

  it('refuses a live competing process within the configured bound and keeps the owner healthy', async () => {
    const path = join(await root(), 'authority.db')
    const owner = startChild('hold', path)
    await nextMessage(owner, 'acquired')

    const started = performance.now()
    const competitor = startChild('try-acquire', path, 200)
    const refused = await nextMessage<{ type: 'refused', errorName: string, code: string, message: string, retryable: boolean, classification: string, acquisitionTimeoutMs: number, refusalLatencyMs: number }>(competitor, 'refused')
    const elapsedMs = performance.now() - started
    expect(refused).toMatchObject({
      errorName: 'SqliteWriterOwnershipError',
      code: 'UNAVAILABLE',
      retryable: true,
      classification: 'SQLITE_WRITER_OWNERSHIP_UNAVAILABLE',
      acquisitionTimeoutMs: 200,
    })
    expect(refused.message).not.toContain(path)
    expect(refused.refusalLatencyMs).toBeLessThan(1_500)
    expect(elapsedMs).toBeLessThan(3_000)

    owner.send({ type: 'ping' })
    await nextMessage(owner, 'healthy')
    owner.send({ type: 'release' })
    await nextMessage(owner, 'released')
    await exited(owner)
  })

  it('reacquires after abrupt owner termination without deleting the lease database', async () => {
    const path = join(await root(), 'authority.db')
    const owner = startChild('crash-after-ready', path)
    await nextMessage(owner, 'acquired')
    const leasePath = sqliteWriterLeasePath(path)

    owner.kill('SIGKILL')
    await exited(owner)

    const replacement = acquireSqliteWriterOwnership(path)
    expect(replacement.leasePath).toBe(leasePath)
    replacement.close()
  })

  it('allows read-only access during live ownership without claiming or upgrading ownership', async () => {
    const path = join(await root(), 'authority.db')
    const setup = openSqliteDatabase(path)
    setup.exec('CREATE TABLE ownership_canary(value TEXT NOT NULL); INSERT INTO ownership_canary VALUES (\'unchanged\')')
    setup.close()

    const owner = openAuthoritativeSqliteDatabase(path)
    const reader = openSqliteDatabase(path, { readOnly: true })
    expect(reader.prepare('SELECT value FROM ownership_canary').get()).toEqual({ value: 'unchanged' })
    expect(() => reader.exec('INSERT INTO ownership_canary VALUES (\'forbidden\')')).toThrow()
    reader.close()
    owner.close()
  })

  it('does not mutate application tables and isolates different authority and artifact paths', async () => {
    const directory = await root()
    const firstPath = join(directory, 'first.db')
    const secondPath = join(directory, 'second.db')
    const backupPath = join(directory, 'first-backup.db')
    const setup = openSqliteDatabase(firstPath)
    setup.exec('CREATE TABLE ownership_canary(value TEXT NOT NULL); INSERT INTO ownership_canary VALUES (\'unchanged\')')
    setup.close()

    const first = acquireSqliteWriterOwnership(firstPath)
    const second = acquireSqliteWriterOwnership(secondPath)
    const backup = acquireSqliteWriterOwnership(backupPath)
    first.close()
    second.close()
    backup.close()

    const verify = openSqliteDatabase(firstPath, { readOnly: true })
    expect(verify.prepare('SELECT value FROM ownership_canary').all()).toEqual([{ value: 'unchanged' }])
    verify.close()
  })

  it('canonicalizes relative segments and Windows path casing to one ownership identity', async () => {
    const directory = await root()
    await mkdir(join(directory, 'nested'))
    const path = join(directory, 'authority.db')
    const alias = resolve(join(directory, 'nested', '..', 'authority.db'))
    expect(canonicalSqliteAuthorityIdentity(alias)).toBe(canonicalSqliteAuthorityIdentity(path))
    expect(sqliteWriterLeasePath(alias)).toBe(sqliteWriterLeasePath(path))

    if (process.platform === 'win32') {
      expect(canonicalSqliteAuthorityIdentity(path.toUpperCase())).toBe(canonicalSqliteAuthorityIdentity(path))
      expect(sqliteWriterLeasePath(path.toUpperCase())).toBe(sqliteWriterLeasePath(path))
    }
    expect(relative(dirname(path), sqliteWriterLeasePath(path))).not.toContain('..')
  })

  it('returns typed errors and rejects invalid timeout values', async () => {
    const path = join(await root(), 'authority.db')
    expect(() => acquireSqliteWriterOwnership(path, { acquisitionTimeoutMs: 0 })).toThrow(MemoryError)
    const owner = acquireSqliteWriterOwnership(path)
    try {
      expect(() => acquireSqliteWriterOwnership(path, { acquisitionTimeoutMs: 25 })).toThrow(SqliteWriterOwnershipError)
    }
    finally {
      owner.close()
    }
  })
})
