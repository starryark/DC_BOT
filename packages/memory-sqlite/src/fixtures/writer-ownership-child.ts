import process from 'node:process'

import { performance } from 'node:perf_hooks'

import { acquireSqliteWriterOwnership } from '../writer-ownership.js'

const [mode, authorityPath, timeoutText] = process.argv.slice(2)
const acquisitionTimeoutMs = Number(timeoutText)

function report(message: Record<string, unknown>): void {
  process.send?.(message)
}

const acquisitionStarted = performance.now()
try {
  const ownership = acquireSqliteWriterOwnership(authorityPath!, { acquisitionTimeoutMs })
  report({ type: 'acquired', acquisitionTimeoutMs })

  if (mode === 'try-acquire') {
    ownership.close()
    process.exit(0)
  }

  process.on('message', (message) => {
    const command = message as { type?: string }
    if (command.type === 'ping')
      report({ type: 'healthy' })
    if (command.type === 'release') {
      ownership.close()
      report({ type: 'released' })
      process.exit(0)
    }
  })
}
catch (error) {
  const failure = error as { name?: string, code?: string, message?: string, retryable?: boolean, details?: Record<string, unknown> }
  report({
    type: 'refused',
    errorName: failure.name,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
    classification: failure.details?.classification,
    acquisitionTimeoutMs: failure.details?.acquisitionTimeoutMs,
    refusalLatencyMs: performance.now() - acquisitionStarted,
  })
  process.exit(2)
}
