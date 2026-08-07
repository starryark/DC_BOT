import { cpus, totalmem } from 'node:os'
import process from 'node:process'

import type { EnvironmentFingerprint } from './contracts'

/**
 * Collect truthful environment metadata for the run manifest.
 */
export function collectEnvironmentFingerprint(executingPnpmVersion: string | null = null): EnvironmentFingerprint {
  const cpuList = cpus()
  const cpuModel = cpuList.length > 0 && cpuList[0] ? cpuList[0].model : 'unknown'
  const cpuCount = cpuList.length > 0 ? cpuList.length : 1
  const memoryBytes = totalmem()
  
  // Try to determine SQLite version from the node:sqlite module.
  let sqliteVersion = 'unknown'
  try {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(':memory:')
    const row = db.prepare('select sqlite_version() as version').get() as { version: string }
    if (row && typeof row.version === 'string') {
      sqliteVersion = row.version
    }
    db.close()
  } catch (e) {
    // fallback
  }

  return {
    nodeVersion: process.version,
    pnpmVersion: executingPnpmVersion || 'unavailable (execution limitation)',
    platform: process.platform,
    architecture: process.arch,
    cpuModel,
    cpuCount,
    totalMemoryBytes: memoryBytes,
    sqliteVersion,
  }
}
