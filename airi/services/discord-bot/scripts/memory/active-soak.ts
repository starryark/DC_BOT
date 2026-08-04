import type { SoakStageOptions } from './active-soak-stages'

import process from 'node:process'

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { prepareSoakRun, reportSoakRun, verifySoakRun } from './active-soak-stages'

type Command = 'prepare' | 'report' | 'verify'

const HELP = `Usage: pnpm memory:active-soak -- <prepare|report|verify> [options]

Qualifies one exact commit and configuration for deliberate active opt-in.
It never changes the default rollout state.

Commands:
  prepare   Guard the checkout, runtime, and output location, take a verified
            pre-soak backup, and write private run state (contains the report
            redaction key).
  report    Correlate durable records with operator attestations and emit a
            redacted JSON report. Run only after the bot is stopped. Reads only
            the authority bound during preparation.
  verify    Apply the acceptance rules to a report. Exits nonzero on failure.

Options:
  --run-id <slug>            Run identity (prepare)
  --commit <full-sha>        Exact 40-character candidate commit (prepare, verify)
  --root <absolute-dir>      Isolated memory runtime root (prepare; on report it
                             may only restate the bound root)
  --binding-file <path>      Private guild-only binding specification (prepare)
  --out <absolute-dir>       Private run output directory outside the checkout
                             (prepare, report)
  --state <path>             Private run state file (report)
  --attestation <path>       Operator attestation file (report)
  --report <path>            Redacted report file (verify)
  --help                     Show this help
`

/**
 * Runs one stage of the private active-memory soak against this checkout.
 *
 * This entrypoint owns only argv, stdout, and the exit code. Every guard lives
 * in the stage module, which takes the repository root as a parameter so it can
 * be exercised against a fixture checkout.
 *
 * Call stack:
 *
 * main
 *   -> {@link prepareSoakRun} | {@link reportSoakRun} | {@link verifySoakRun} (./active-soak-stages)
 *     -> buildSoakReport | verifySoakReport (../../src/memory/active-soak)
 *       -> memory-sqlite backup / read-only inspection facilities
 */
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  if (!args.command)
    throw new Error('An active-soak command is required. Use --help for usage.')

  // scripts/memory -> scripts -> discord-bot -> services -> airi -> repository root
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
  if (args.command === 'prepare') {
    print({
      status: 'ok',
      ...await prepareSoakRun(args, repoRoot),
      reminder: 'Run state holds the report redaction key. Keep it, the backup, and the binding file out of version control.',
    })
  }
  else if (args.command === 'report') {
    print({ status: 'ok', ...reportSoakRun(args, repoRoot) })
  }
  else {
    const verdict = verifySoakRun(args)
    print({ status: verdict.ok ? 'ok' : 'failed', failures: verdict.failures })
    if (!verdict.ok)
      process.exitCode = 1
  }
}

interface ParsedArgs extends SoakStageOptions { command?: Command, help: boolean }

function parseArgs(values: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { help: false }
  const commands = new Set<Command>(['prepare', 'report', 'verify'])
  const options: Record<string, keyof SoakStageOptions> = { '--run-id': 'runId', '--commit': 'commit', '--root': 'root', '--binding-file': 'bindingFile', '--out': 'out', '--state': 'state', '--attestation': 'attestation', '--report': 'report' }
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    // `pnpm memory:active-soak -- prepare` forwards the separator verbatim.
    if (value === '--')
      continue
    else if (commands.has(value as Command) && !result.command)
      result.command = value as Command
    else if (value === '--help' || value === '-h')
      result.help = true
    else if (options[value])
      Object.assign(result, { [options[value]!]: values[++index] })
    else throw new Error(`Unknown or incomplete argument: ${value}`)
  }
  return result
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
