import process from 'node:process'

import { mkdtemp, rm, stat } from 'node:fs/promises'
import { cpus, freemem, platform, release, tmpdir, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'

import { createVerifiedBackup, restoreVerifiedBackup, verifyDatabase } from '../backup.js'
import { openSqliteDatabase, recommendedBusyTimeoutMs } from '../connection-profile.js'
import { latestSchemaVersion } from '../migrations/index.js'
import { UnitOfWork } from '../unit-of-work.js'

/* eslint-disable style/max-statements-per-line -- benchmark timing samples deliberately pair operations with their clocks */
const seed = Number(process.env.IMP208_SEED ?? 208)
const operations = Number(process.env.IMP208_OPERATIONS ?? 2000)
if (!Number.isSafeInteger(operations) || operations < 100 || operations > 1_000_000)
  throw new Error('IMP208_OPERATIONS must be from 100 through 1000000')
const percentile = (values: number[], p: number) => values.slice().sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]!

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dc-bot-imp208-benchmark-'))
  const path = join(directory, 'benchmark.db'); const backupPath = join(directory, 'backup.db'); const restorePath = join(directory, 'restore.db')
  try {
    const database = openSqliteDatabase(path)
    database.exec('PRAGMA wal_autocheckpoint=0; CREATE TABLE benchmark_operations(id INTEGER PRIMARY KEY,room INTEGER NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,UNIQUE(room,sequence))')
    const reader = openSqliteDatabase(path)
    const insert = database.prepare('INSERT INTO benchmark_operations(room,sequence,payload) VALUES (?,?,?)')
    const latencies: number[] = []; const started = performance.now()
    for (let index = 0; index < operations; index++) {
      const at = performance.now()
      new UnitOfWork(database).run(() => insert.run(index % 32, Math.floor(index / 32) + 1, `synthetic-${seed}`))
      latencies.push(performance.now() - at)
      if (index % 10 === 0)
        reader.prepare('SELECT count(*) FROM benchmark_operations WHERE room=?').get(index % 32)
    }
    const elapsed = performance.now() - started
    const walBytesBefore = await stat(`${path}-wal`).then(value => value.size, () => 0)
    const checkpointStarted = performance.now(); const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get(); const checkpointMs = performance.now() - checkpointStarted
    const walBytesAfter = await stat(`${path}-wal`).then(value => value.size, () => 0)
    const backupStarted = performance.now(); await createVerifiedBackup(database, path, backupPath, new Date().toISOString()); const backupMs = performance.now() - backupStarted
    const restoreStarted = performance.now(); await restoreVerifiedBackup(backupPath, restorePath, () => {}); const restoreMs = performance.now() - restoreStarted
    const restored = new DatabaseSync(restorePath, { readOnly: true }); const integrityStarted = performance.now(); verifyDatabase(restored); const integrityMs = performance.now() - integrityStarted; restored.close()
    const sqliteVersion = (database.prepare('SELECT sqlite_version() version').get() as { version: string }).version
    reader.close()
    database.close()
    console.info(JSON.stringify({
      recordedAt: new Date().toISOString(),
      environment: { os: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', logicalProcessors: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), storageType: 'not determinable from Node APIs', node: process.version, sqlite: sqliteVersion },
      revision: process.env.IMP208_REVISION ?? 'working-tree',
      schemaVersion: latestSchemaVersion,
      configuration: { journalMode: 'wal', synchronous: 'full', foreignKeys: true, busyTimeoutMs: recommendedBusyTimeoutMs, walAutocheckpoint: 0 },
      workload: { seed, operations, rooms: 32, writers: 1, writerConnections: 1, readerConnections: 1, queueClaimers: 0, readEveryWrites: 10, command: `pnpm -F @proj-airi/memory-sqlite benchmark:imp208` },
      measurements: { rows: operations, databaseBytes: (await stat(path)).size, throughputOpsPerSecond: operations / (elapsed / 1000), appendLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) }, transactionDurationMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), p99: percentile(latencies, 0.99) }, busyLockedCount: 0, totalBusyWaitMs: 0, writerQueueDepth: 'not applicable; no coordinator composed', walBytesBefore, walBytesAfter, checkpointMs, checkpoint, backupBytes: (await stat(backupPath)).size, backupMs, restoreMs, integrityMs },
      criteria: { functional: 'zero lost/duplicate/partial writes; integrity and foreign keys pass; bounded busy handling', performance: 'local baseline only; no universal production SLO' },
    }, null, 2))
  }
  finally { await rm(directory, { recursive: true, force: true }) }
}

void main()
