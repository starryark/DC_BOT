#!/usr/env tsx
import process from 'node:process'

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { compareAgainstBaseline, loadRun } from '../../evals/memory/performance/baseline'

const EXIT = { COMPLETE: 0, INVALID: 2, INCOMPATIBLE: 3, UNEXPECTED: 5 } as const

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`Usage: memory:baseline <baseline-dir> <candidate-dir>\n`)
    return
  }

  let baselineDir: string | undefined
  let candidateDir: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--baseline') {
      baselineDir = args[++i]
    }
    else if (args[i] === '--candidate') {
      candidateDir = args[++i]
    }
    else if (!args[i].startsWith('--')) {
      if (!baselineDir)
        baselineDir = args[i]
      else if (!candidateDir)
        candidateDir = args[i]
    }
  }

  if (!baselineDir || !candidateDir) {
    process.stderr.write(`Error: Expected --baseline <dir> and --candidate <dir>\n`)
    process.exitCode = EXIT.INVALID
    return
  }

  try {
    const baseline = loadRun(baselineDir, readFileSync, existsSync, join)
    const candidate = loadRun(candidateDir, readFileSync, existsSync, join)

    const result = compareAgainstBaseline(
      baseline.manifest,
      baseline.measurements,
      candidate.manifest,
      candidate.measurements,
    )

    if (result.status !== 'compatible') {
      process.stderr.write(`${JSON.stringify({ status: result.status, message: result.message })}\n`)
      process.exitCode = EXIT.INCOMPATIBLE
      return
    }

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
  catch (error: any) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: error.message || String(error) })}\n`)
    process.exitCode = EXIT.INVALID
  }
}

main().catch(() => {
  process.exitCode = EXIT.UNEXPECTED
})
