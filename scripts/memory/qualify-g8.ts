import type { G8EvaluationRunFiles, G8PerformanceRunFiles } from '../../evals/memory/g8/qualification'

import process from 'node:process'

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { qualifyG8 } from '../../evals/memory/g8/qualification'

/**
 * CLI entry point for aggregate G8 release qualification (artifact 21 §11.2).
 *
 * Deliberately a reader, never a runner: it consumes artifacts the existing
 * evaluators and qualifiers already produced and reports whether the evidence
 * around them is sufficient for G8 at one exact candidate commit. It starts no
 * evaluator, no benchmark, no soak, and writes nothing — a qualifier that could
 * produce evidence could also produce it until it passed.
 *
 * There is no flag that asserts a pass. Approvals, signoffs, and the
 * gate-readiness assertion are external inputs; with any of them missing the
 * aggregate answers `blocked`, which is the repository's real G8 state until
 * that external evidence exists. A `pass` authorizes nothing and never starts
 * IMP-807 staged rollout.
 *
 * Exit codes:
 *   0 — every G8 condition has qualifying evidence
 *   2 — CLI, path, or input-file invalid (including files that are not JSON)
 *   3 — valid invocation, G8 blocked (blockers enumerated on stdout)
 *   5 — unexpected exception
 *
 * Call stack:
 *
 * main
 *   -> {@link run}
 *     -> readEvaluationRun / readPerformanceRun
 *     -> readJsonFile
 *     -> qualifyG8 (../../evals/memory/g8/qualification)
 *       -> parseEvaluationSummaryArtifact / qualifyRetrieval (../../evals/memory/retrieval/qualification)
 *       -> loadRun / deriveRunState (../../evals/memory/performance)
 *       -> verifySoakReport (../../src/memory/active-soak)
 */

const HELP = `Usage: pnpm memory:qualify-g8 -- [options]

Aggregates previously generated evidence into one G8 qualification decision for
an exact candidate commit. Runs no evaluators, opens no memory runtime, and
modifies no input.

Options:
  --candidate <sha>                  Exact 40-character candidate commit (required)
  --functional-run-a <directory>     First active-v1 evaluation run (required pair)
  --functional-run-b <directory>     Second active-v1 evaluation run (required pair)
  [--functional-thresholds <file>]   Eval threshold document the functional runs applied
  --multilingual-run-a <directory>   First multilingual-v1 evaluation run (required pair)
  --multilingual-run-b <directory>   Second multilingual-v1 evaluation run (required pair)
  [--multilingual-thresholds <file>] Eval threshold document the multilingual runs applied
  [--retrieval-policy <file>]        Approved retrieval policy document
  [--retrieval-decision <file>]      Independent evaluator decision document
  --performance-run-a <directory>    First performance-v2 run (required pair)
  --performance-run-b <directory>    Second performance-v2 run (required pair)
  [--performance-thresholds <file>]  Performance threshold document the runs applied
  [--price-document <file>]          Approved price document the runs bound;
                                     published cost evidence is recomputed against it
  [--soak-report <file>]             Active-soak report JSON (operations and rollback drills)
  --signoff <file>                   G8 signoff record (repeatable)
  --help                             Show this help

Every run directory must be an absolute path outside the repository checkout.
An evaluation run must contain summary.json, scenario-results.jsonl, and
report.md; a performance run must contain the five artifacts loadRun
reconciles: run-manifest.json, attempts.jsonl, run-findings.jsonl,
measurements.jsonl, and summary.json. The performance benchmark also publishes
report.md and voice-sample-diagnostics.jsonl; neither is read here, so a
baseline predating the diagnostics file is still usable.

--candidate is required; without it the invocation is invalid and exits 2. Each
run pair, the soak report, and the signoff records are independently optional;
anything absent is reported as a blocker rather than ignored, so omitting
evidence can never produce a pass.
`

const EVALUATION_ARTIFACTS = ['summary.json', 'scenario-results.jsonl', 'report.md'] as const
const PERFORMANCE_ARTIFACTS = ['run-manifest.json', 'attempts.jsonl', 'run-findings.jsonl', 'measurements.jsonl', 'summary.json'] as const

interface ParsedArgs {
  candidate?: string
  functionalRunA?: string
  functionalRunB?: string
  functionalThresholds?: string
  multilingualRunA?: string
  multilingualRunB?: string
  multilingualThresholds?: string
  retrievalPolicy?: string
  retrievalDecision?: string
  performanceRunA?: string
  performanceRunB?: string
  performanceThresholds?: string
  priceDocument?: string
  soakReport?: string
  signoffs: string[]
  help: boolean
}

const EXIT = {
  PASS: 0,
  INVALID_CONFIG: 2,
  BLOCKED: 3,
  UNEXPECTED: 5,
} as const

function main(): void {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv.slice(2))
  }
  catch (error) {
    reportInvalid('cli_arguments_invalid', messageOf(error))
    process.exitCode = EXIT.INVALID_CONFIG
    return
  }
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  // scripts/memory -> scripts -> discord-bot -> services -> airi -> repository root
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

  try {
    process.exitCode = run(args, repoRoot)
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ format: 1, status: 'error', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.UNEXPECTED
  }
}

function run(args: ParsedArgs, repoRoot: string): number {
  if (!args.candidate || !/^[0-9a-f]{40}$/.test(args.candidate)) {
    reportInvalid('cli_arguments_invalid', '--candidate must be the exact full 40-character candidate commit SHA')
    return EXIT.INVALID_CONFIG
  }

  let functionalRuns: { runA?: G8EvaluationRunFiles, runB?: G8EvaluationRunFiles } | undefined
  let multilingualRuns: { runA?: G8EvaluationRunFiles, runB?: G8EvaluationRunFiles } | undefined
  let performanceRuns: { runA?: G8PerformanceRunFiles, runB?: G8PerformanceRunFiles } | undefined

  try {
    if (args.functionalRunA || args.functionalRunB) {
      functionalRuns = {
        runA: args.functionalRunA ? readEvaluationRun('--functional-run-a', args.functionalRunA, repoRoot) : undefined,
        runB: args.functionalRunB ? readEvaluationRun('--functional-run-b', args.functionalRunB, repoRoot) : undefined,
      }
    }
    if (args.multilingualRunA || args.multilingualRunB) {
      multilingualRuns = {
        runA: args.multilingualRunA ? readEvaluationRun('--multilingual-run-a', args.multilingualRunA, repoRoot) : undefined,
        runB: args.multilingualRunB ? readEvaluationRun('--multilingual-run-b', args.multilingualRunB, repoRoot) : undefined,
      }
    }
    if (args.performanceRunA || args.performanceRunB) {
      performanceRuns = {
        runA: args.performanceRunA ? readPerformanceRun('--performance-run-a', args.performanceRunA, repoRoot) : undefined,
        runB: args.performanceRunB ? readPerformanceRun('--performance-run-b', args.performanceRunB, repoRoot) : undefined,
      }
    }
  }
  catch (error) {
    reportInvalid('run_directory_unusable', messageOf(error))
    return EXIT.INVALID_CONFIG
  }

  const readJson = (flag: string, path: string | undefined): unknown => {
    if (path === undefined)
      return undefined
    const resolved = resolve(path)
    if (!existsSync(resolved)) {
      throw new InvalidInput(`${flag} file not found: ${resolved}`)
    }
    try {
      return JSON.parse(readFileSync(resolved, 'utf8'))
    }
    catch (cause) {
      throw new InvalidInput(`${flag} is not valid JSON (${messageOf(cause)})`)
    }
  }

  try {
    const result = qualifyG8({
      candidateCommit: args.candidate,
      ...(functionalRuns
        ? {
            functional: {
              ...functionalRuns,
              thresholds: readJson('--functional-thresholds', args.functionalThresholds),
            },
          }
        : {}),
      ...(multilingualRuns
        ? {
            multilingual: {
              ...multilingualRuns,
              thresholds: readJson('--multilingual-thresholds', args.multilingualThresholds),
              policy: readJson('--retrieval-policy', args.retrievalPolicy),
              decision: readJson('--retrieval-decision', args.retrievalDecision),
            },
          }
        : {}),
      ...(performanceRuns
        ? {
            performance: {
              ...performanceRuns,
              thresholds: readJson('--performance-thresholds', args.performanceThresholds),
            },
          }
        : {}),
      priceDocument: readJson('--price-document', args.priceDocument),
      soakReport: readJson('--soak-report', args.soakReport),
      signoffs: args.signoffs.map(path => readJson('--signoff', path)),
    })

    process.stdout.write(`${JSON.stringify({ format: 1, ...result }, null, 2)}\n`)
    return result.status === 'pass' ? EXIT.PASS : EXIT.BLOCKED
  }
  catch (error) {
    if (error instanceof InvalidInput) {
      reportInvalid('input_file_invalid', error.message)
      return EXIT.INVALID_CONFIG
    }
    throw error
  }
}

/** Distinguishes operator-input failures (exit 2) from unexpected faults (exit 5). */
class InvalidInput extends Error {}

/** Read one `memory:evaluate` run directory's three published artifacts. */
function readEvaluationRun(flag: string, directory: string, repoRoot: string): G8EvaluationRunFiles {
  assertReadableRunDirectory(flag, directory, repoRoot, EVALUATION_ARTIFACTS)
  return {
    summaryJson: readFileSync(join(directory, 'summary.json'), 'utf8'),
    scenarioResultsJsonl: readFileSync(join(directory, 'scenario-results.jsonl'), 'utf8'),
    reportText: readFileSync(join(directory, 'report.md'), 'utf8'),
  }
}

/** Read one performance-v2 run directory's five loadable artifacts. */
function readPerformanceRun(flag: string, directory: string, repoRoot: string): G8PerformanceRunFiles {
  assertReadableRunDirectory(flag, directory, repoRoot, PERFORMANCE_ARTIFACTS)
  return {
    runManifestJson: readFileSync(join(directory, 'run-manifest.json'), 'utf8'),
    attemptsJsonl: readFileSync(join(directory, 'attempts.jsonl'), 'utf8'),
    runFindingsJsonl: readFileSync(join(directory, 'run-findings.jsonl'), 'utf8'),
    measurementsJsonl: readFileSync(join(directory, 'measurements.jsonl'), 'utf8'),
    summaryJson: readFileSync(join(directory, 'summary.json'), 'utf8'),
  }
}

/** Refuse a run directory that is missing, inside the repository, or incomplete. */
function assertReadableRunDirectory(flag: string, directory: string, repoRoot: string, artifacts: readonly string[]): void {
  const resolved = resolve(directory)
  if (!isAbsolute(directory))
    throw new InvalidInput(`${flag} must be an absolute path, got ${directory}`)
  if (!existsSync(resolved) || !statSync(resolved).isDirectory())
    throw new InvalidInput(`${flag} ${resolved} is not an existing directory`)

  // Qualification evidence lives outside the checkout so it cannot be edited by
  // the same change under review, and so a symlink cannot smuggle it back in.
  if (insideRepository(repoRoot, resolved))
    throw new InvalidInput(`${flag} ${resolved} is inside the repository checkout; qualification reads evidence from outside it`)
  const real = realpathSync(resolved)
  if (real !== resolved && insideRepository(repoRoot, real))
    throw new InvalidInput(`${flag} ${resolved} resolves inside the repository checkout via symlink`)

  for (const artifact of artifacts) {
    if (!existsSync(join(resolved, artifact)))
      throw new InvalidInput(`${flag} ${resolved} is missing ${artifact}`)
  }
}

function insideRepository(repoRoot: string, target: string): boolean {
  const step = relative(resolve(repoRoot), resolve(target))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

function reportInvalid(reason: string, message: string): void {
  process.stderr.write(`${JSON.stringify({ format: 1, status: 'invalid', reasons: [reason], message })}\n`)
}

/** Parse argv into validated arguments or throw on invalid input. */
function parseArgs(values: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { signoffs: [], help: false }
  const flags: ReadonlyArray<[string, keyof ParsedArgs]> = [
    ['--candidate', 'candidate'],
    ['--functional-run-a', 'functionalRunA'],
    ['--functional-run-b', 'functionalRunB'],
    ['--functional-thresholds', 'functionalThresholds'],
    ['--multilingual-run-a', 'multilingualRunA'],
    ['--multilingual-run-b', 'multilingualRunB'],
    ['--multilingual-thresholds', 'multilingualThresholds'],
    ['--retrieval-policy', 'retrievalPolicy'],
    ['--retrieval-decision', 'retrievalDecision'],
    ['--performance-run-a', 'performanceRunA'],
    ['--performance-run-b', 'performanceRunB'],
    ['--performance-thresholds', 'performanceThresholds'],
    ['--price-document', 'priceDocument'],
    ['--soak-report', 'soakReport'],
  ]
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (value === '--') {
      continue
    }
    else if (value === '--help' || value === '-h') {
      result.help = true
    }
    else if (value === '--signoff') {
      const path = values[++index]
      if (!path)
        throw new Error('--signoff requires a file argument')
      result.signoffs.push(path)
    }
    else {
      const match = flags.find(([flag]) => flag === value)
      if (!match) {
        throw new Error(`Unknown or incomplete argument: ${value}`)
      }
      const path = values[++index]
      if (!path) {
        throw new Error(`${value} requires a file or directory argument`)
      }
      // Braces above are load-bearing: without them the parenthesized cast on
      // the next line is parsed as a call on the thrown Error, and the
      // assignment is silently swallowed into the if body.
      (result as Record<string, string | undefined>)[match[1] as string] = path
    }
  }
  return result
}

function messageOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string')
    return (error as { message: string }).message
  return String(error)
}

main()
