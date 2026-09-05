import type { RetrievalBenchmarkPacket, RetrievalQualificationResult } from '../../evals/memory/retrieval/qualification'

import process from 'node:process'

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseRetrievalPolicy } from '../../evals/memory/retrieval/policy'
import {
  parseEvaluationSummaryArtifact,
  parseIndependentRetrievalDecision,
  parseScenarioResultsJsonl,
  QualificationEvidenceError,
  qualifyRetrieval,
  sha256Bytes,
  verifyRetrievalBenchmarkPacket,
} from '../../evals/memory/retrieval/qualification'

/**
 * CLI entry point for retrieval qualification (IMP-607 governance, T003).
 *
 * Deliberately separate from `memory:evaluate`. That command *produces* a
 * benchmark; this one only *reads* previously produced artifacts and reports
 * whether the governance evidence around them is sufficient. It opens no memory
 * runtime, issues no search, and writes nothing into either run directory — a
 * verifier that could re-run the benchmark could also re-run it until it
 * passed.
 *
 * There is no flag that asserts acceptance. An approved policy and an
 * independent evaluator decision are inputs supplied from outside; with either
 * missing the answer is `measured_not_evaluated`, which is the project's real
 * state for lexical retrieval until that external evidence exists.
 *
 * Exit codes:
 *   0 — formally accepted
 *   2 — CLI, path, or evidence schema invalid
 *   3 — valid evidence, not formally accepted (rejected or measured_not_evaluated)
 *   4 — artifact integrity failure: recomputation, digest, or hash mismatch
 *   5 — unexpected exception
 *
 * Call stack:
 *
 * main
 *   -> {@link run}
 *     -> {@link readBenchmarkPacket}
 *       -> parseEvaluationSummaryArtifact (../../evals/memory/retrieval/qualification)
 *       -> parseScenarioResultsJsonl (../../evals/memory/retrieval/qualification)
 *     -> verifyRetrievalBenchmarkPacket (../../evals/memory/retrieval/qualification)
 *     -> parseRetrievalPolicy (../../evals/memory/retrieval/policy)
 *     -> parseIndependentRetrievalDecision (../../evals/memory/retrieval/qualification)
 *     -> qualifyRetrieval (../../evals/memory/retrieval/qualification)
 *       -> {@link RetrievalQualificationResult}
 */

const HELP = `Usage: pnpm memory:qualify-retrieval -- [options]

Verifies previously generated retrieval benchmark artifacts against an
externally approved policy and an independently supplied evaluator decision.
Runs no scenarios, opens no memory runtime, and modifies no input.

Options:
  --run-a <directory>       First benchmark output directory (required)
  --run-b <directory>       Second benchmark output directory (required)
  [--policy <file>]         Externally approved retrieval policy document
  [--decision <file>]       Independent evaluator decision document
  --help                    Show this help

Both run directories must be absolute paths outside the repository checkout and
must each contain summary.json, scenario-results.jsonl, and report.md.
`

/** The artifacts `memory:evaluate` publishes; all three are required, all are hashed. */
const REQUIRED_ARTIFACTS = ['summary.json', 'scenario-results.jsonl', 'report.md'] as const

interface ParsedArgs {
  runA?: string
  runB?: string
  policy?: string
  decision?: string
  help: boolean
}

const EXIT = {
  ACCEPTED: 0,
  INVALID_CONFIG: 2,
  NOT_ACCEPTED: 3,
  INTEGRITY: 4,
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
  if (!args.runA || !args.runB) {
    reportInvalid('cli_arguments_invalid', 'both --run-a and --run-b are required')
    return EXIT.INVALID_CONFIG
  }

  const runADirectory = resolve(args.runA)
  const runBDirectory = resolve(args.runB)
  // The same directory twice is not a reproducibility pair. Caught here rather
  // than by the artifact hashes so the message names the actual mistake.
  if (runADirectory === runBDirectory) {
    reportInvalid('run_directories_identical', '--run-a and --run-b must name two different run directories')
    return EXIT.INVALID_CONFIG
  }

  for (const [flag, directory] of [['--run-a', runADirectory], ['--run-b', runBDirectory]] as const) {
    const pathError = assertReadableRunDirectory(flag, directory, repoRoot)
    if (pathError) {
      reportInvalid('run_directory_unusable', pathError)
      return EXIT.INVALID_CONFIG
    }
  }

  let packetA: RetrievalBenchmarkPacket
  let packetB: RetrievalBenchmarkPacket
  try {
    packetA = readBenchmarkPacket(runADirectory)
    packetB = readBenchmarkPacket(runBDirectory)
  }
  catch (error) {
    return reportEvidenceFault(error)
  }

  // Run A's verified identity is what an approved policy must have been
  // approved against, so it has to be derived before the policy is parsed.
  let expectedIdentity
  try {
    const verified = verifyRetrievalBenchmarkPacket(packetA)
    expectedIdentity = {
      repositoryCommit: verified.identity.candidateCommit,
      datasetVersion: verified.identity.datasetVersion,
      datasetDigest: verified.identity.datasetDigest,
      evaluatorSchemaVersion: verified.identity.evaluatorSchemaVersion,
      analyzerConfigIdentity: verified.identity.analyzerConfigIdentity,
      requestedModes: verified.identity.requestedModes,
    }
  }
  catch (error) {
    return reportEvidenceFault(error)
  }

  let policy
  if (args.policy) {
    const policyPath = resolve(args.policy)
    if (!existsSync(policyPath)) {
      reportInvalid('approved_policy_not_found', `policy file not found: ${policyPath}`)
      return EXIT.INVALID_CONFIG
    }
    try {
      policy = parseRetrievalPolicy(JSON.parse(readFileSync(policyPath, 'utf8')), expectedIdentity)
    }
    catch (error) {
      reportInvalid('approved_policy_invalid', messageOf(error))
      return EXIT.INVALID_CONFIG
    }
  }

  let decision
  if (args.decision) {
    const decisionPath = resolve(args.decision)
    if (!existsSync(decisionPath)) {
      reportInvalid('independent_decision_not_found', `decision file not found: ${decisionPath}`)
      return EXIT.INVALID_CONFIG
    }
    try {
      decision = parseIndependentRetrievalDecision(JSON.parse(readFileSync(decisionPath, 'utf8')))
    }
    catch (error) {
      return reportEvidenceFault(error)
    }
  }

  let result: RetrievalQualificationResult
  try {
    result = qualifyRetrieval({ runA: packetA, runB: packetB, policy, decision })
  }
  catch (error) {
    return reportEvidenceFault(error)
  }

  process.stdout.write(`${JSON.stringify({ format: 1, ...result }, null, 2)}\n`)
  return result.status === 'accepted' ? EXIT.ACCEPTED : EXIT.NOT_ACCEPTED
}

/**
 * Read one run's three artifacts and bind them to the bytes they came from.
 *
 * Hashing happens before parsing, over the raw file contents, so the hash an
 * independent decision commits to is the hash of what is on disk rather than of
 * a re-serialization of whatever parsed out of it.
 */
function readBenchmarkPacket(directory: string): RetrievalBenchmarkPacket {
  const [summaryBytes, scenarioBytes, reportBytes] = REQUIRED_ARTIFACTS.map(name => readFileSync(join(directory, name)))
  const decoder = new TextDecoder()

  return {
    summary: parseEvaluationSummaryArtifact(JSON.parse(decoder.decode(summaryBytes!))),
    scenarioResults: parseScenarioResultsJsonl(decoder.decode(scenarioBytes!)),
    rawArtifactHashes: {
      summarySha256: sha256Bytes(summaryBytes!),
      scenarioResultsSha256: sha256Bytes(scenarioBytes!),
      reportSha256: sha256Bytes(reportBytes!),
    },
  }
}

/** Refuse a run directory that is missing, inside the repository, or incomplete. */
function assertReadableRunDirectory(flag: string, directory: string, repoRoot: string): string | undefined {
  if (!isAbsolute(directory))
    return `${flag} must be an absolute path, got ${directory}`
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return `${flag} ${directory} is not an existing directory`

  // Qualification evidence lives outside the checkout so it cannot be edited by
  // the same change under review, and so a symlink cannot smuggle it back in.
  if (insideRepository(repoRoot, directory))
    return `${flag} ${directory} is inside the repository checkout; qualification reads evidence from outside it`
  const real = realpathSync(directory)
  if (real !== directory && insideRepository(repoRoot, real))
    return `${flag} ${directory} resolves inside the repository checkout via symlink`

  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(directory, artifact)))
      return `${flag} ${directory} is missing ${artifact}`
  }
  return undefined
}

function insideRepository(repoRoot: string, target: string): boolean {
  const step = relative(resolve(repoRoot), resolve(target))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

/**
 * Map an evidence fault onto its exit code.
 *
 * `schema` means the input was not a benchmark artifact at all (exit 2);
 * `integrity` means it looked like one but its own contents disagree (exit 4).
 * Only the stable reason code is printed — never a value from the artifact.
 */
function reportEvidenceFault(error: unknown): number {
  if (error instanceof QualificationEvidenceError) {
    process.stderr.write(`${JSON.stringify({ format: 1, status: 'invalid', reasons: [error.reason] })}\n`)
    return error.fault === 'schema' ? EXIT.INVALID_CONFIG : EXIT.INTEGRITY
  }
  if (isFileSystemError(error)) {
    reportInvalid('run_directory_unusable', messageOf(error))
    return EXIT.INVALID_CONFIG
  }
  if (error instanceof SyntaxError) {
    reportInvalid('benchmark_summary_invalid', 'an artifact is not valid JSON')
    return EXIT.INVALID_CONFIG
  }
  throw error
}

function reportInvalid(reason: string, message: string): void {
  process.stderr.write(`${JSON.stringify({ format: 1, status: 'invalid', reasons: [reason], message })}\n`)
}

function isFileSystemError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code: unknown }).code === 'string'
}

/** Parse argv into validated arguments or throw on invalid input. */
function parseArgs(values: readonly string[]): ParsedArgs {
  const result: ParsedArgs = { help: false }
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!
    if (value === '--') {
      continue
    }
    else if (value === '--help' || value === '-h') {
      result.help = true
    }
    else if (value === '--run-a') {
      result.runA = values[++index]
      if (!result.runA)
        throw new Error('--run-a requires a directory argument')
    }
    else if (value === '--run-b') {
      result.runB = values[++index]
      if (!result.runB)
        throw new Error('--run-b requires a directory argument')
    }
    else if (value === '--policy') {
      result.policy = values[++index]
      if (!result.policy)
        throw new Error('--policy requires a file argument')
    }
    else if (value === '--decision') {
      result.decision = values[++index]
      if (!result.decision)
        throw new Error('--decision requires a file argument')
    }
    else {
      throw new Error(`Unknown or incomplete argument: ${value}`)
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
