import type { BenchmarkRunArtifacts } from './qualification-fixtures'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { verifyRetrievalBenchmarkPacket } from './qualification'
import {
  approvedPolicyObject,
  artifactHashes,
  benchmarkPacket,
  benchmarkRunArtifacts,
  independentDecisionObject,
  passingRetrievalResults,
} from './qualification-fixtures'

/**
 * `memory:qualify-retrieval` end-to-end matrix (IMP-607 governance, T003/T004).
 *
 * The unit tests prove the verifier's logic; these prove the process contract
 * around it — that a missing approval exits nonzero while still reporting
 * `measured_not_evaluated` rather than a benchmark failure, that tampering and
 * mismatched pairs never reach a verdict at all, and that exit code 0 is
 * reachable only through the one fully matching arrangement.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const QUALIFY_ENTRY = resolve(import.meta.dirname, '../../../scripts/memory/qualify-retrieval.ts')

const CLI_TIMEOUT = 60000

const runAArtifacts = benchmarkRunArtifacts({ generatedAt: '2026-08-08T01:00:00Z' })
const runBArtifacts = benchmarkRunArtifacts({ generatedAt: '2026-08-08T03:00:00Z' })

const verifiedRunA = verifyRetrievalBenchmarkPacket(benchmarkPacket(runAArtifacts))
const NORMALIZED_DIGEST = verifiedRunA.identity.normalizedResultDigest
const measured = verifiedRunA.aggregate

const scratchDirs: string[] = []

afterAll(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    }
    catch {
      // Windows transient file-handle locks
    }
  }
})

function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** Publish a run's artifacts as the evaluator would, byte for byte. */
function writeRun(artifacts: BenchmarkRunArtifacts): string {
  const dir = scratchDir('g8-qualify-run-')
  writeFileSync(join(dir, 'summary.json'), artifacts.summaryText)
  writeFileSync(join(dir, 'scenario-results.jsonl'), artifacts.scenarioResultsText)
  writeFileSync(join(dir, 'report.md'), artifacts.reportText)
  return dir
}

function writeJson(name: string, value: unknown): string {
  const path = join(scratchDir('g8-qualify-doc-'), name)
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  return path
}

function runCli(args: string[]): { code: number, stdout: string, stderr: string } {
  try {
    const stdout = execFileSync('npx', ['tsx', QUALIFY_ENTRY, '--', ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: CLI_TIMEOUT, shell: true })
    return { code: 0, stdout, stderr: '' }
  }
  catch (error) {
    const failure = error as { status?: number, stdout?: string, stderr?: string }
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const passingPolicyObject = approvedPolicyObject()
const failingPolicyObject = approvedPolicyObject({
  limits: [{ name: 'mean-precision-floor', metric: 'meanPrecisionAtCutoff', operation: '>=', value: measured.meanPrecisionAtCutoff + 0.01 }],
})

function decisionObject(policyDigest: unknown, overrides: Record<string, unknown> = {}, runs: { a?: BenchmarkRunArtifacts, b?: BenchmarkRunArtifacts } = {}) {
  return independentDecisionObject({
    policyDigest: policyDigest as string,
    normalizedResultDigest: NORMALIZED_DIGEST,
    runA: artifactHashes(runs.a ?? runAArtifacts),
    runB: artifactHashes(runs.b ?? runBArtifacts),
    overrides,
  })
}

describe('qualify-retrieval cli arguments', () => {
  it('rejects a missing run pair with exit 2', () => {
    const result = runCli([])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('"reasons":["cli_arguments_invalid"]')
  }, CLI_TIMEOUT)

  it('rejects an unknown argument with exit 2', () => {
    expect(runCli(['--accepted']).code).toBe(2)
  }, CLI_TIMEOUT)

  it('refuses the same directory for both runs with exit 2', () => {
    const dir = writeRun(runAArtifacts)
    const result = runCli(['--run-a', dir, '--run-b', dir])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('run_directories_identical')
  }, CLI_TIMEOUT)

  it('refuses a run directory inside the repository with exit 2', () => {
    const result = runCli(['--run-a', join(REPO_ROOT, '.local', 'memory'), '--run-b', writeRun(runBArtifacts)])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('run_directory_unusable')
  }, CLI_TIMEOUT)

  it('refuses a run directory missing an artifact with exit 2', () => {
    const incomplete = scratchDir('g8-qualify-partial-')
    writeFileSync(join(incomplete, 'summary.json'), runAArtifacts.summaryText)
    const result = runCli(['--run-a', incomplete, '--run-b', writeRun(runBArtifacts)])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('scenario-results.jsonl')
  }, CLI_TIMEOUT)
})

// A benchmark that ran cleanly and an approval nobody has given are different
// facts. Exit 3 says "not accepted"; the payload says which of the two it is.
describe('qualify-retrieval governance absence', () => {
  it('reports measured_not_evaluated with no policy and no decision', () => {
    const result = runCli(['--run-a', writeRun(runAArtifacts), '--run-b', writeRun(runBArtifacts)])
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({
      status: 'measured_not_evaluated',
      reasons: ['approved_policy_missing', 'independent_decision_missing'],
    })
  }, CLI_TIMEOUT)

  it('reports measured_not_evaluated with a policy but no decision', () => {
    const result = runCli([
      '--run-a',
      writeRun(runAArtifacts),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
    ])
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'measured_not_evaluated', reasons: ['independent_decision_missing'] })
  }, CLI_TIMEOUT)

  it('reports measured_not_evaluated with a decision but no policy', () => {
    const result = runCli([
      '--run-a',
      writeRun(runAArtifacts),
      '--run-b',
      writeRun(runBArtifacts),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest)),
    ])
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'measured_not_evaluated', reasons: ['approved_policy_missing'] })
  }, CLI_TIMEOUT)
})

describe('qualify-retrieval verdicts', () => {
  it('accepts the complete, fully matching arrangement with exit 0', () => {
    const result = runCli([
      '--run-a',
      writeRun(runAArtifacts),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest)),
    ])
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: 1,
      status: 'accepted',
      requestedModes: ['lexical'],
      normalizedResultDigest: NORMALIZED_DIGEST,
      policyDigest: passingPolicyObject.policyDigest,
      decision: 'accepted',
      reasons: [],
    })
  }, CLI_TIMEOUT)

  it('rejects with exit 3 when an approved quality limit is missed', () => {
    const result = runCli([
      '--run-a',
      writeRun(runAArtifacts),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', failingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(failingPolicyObject.policyDigest)),
    ])
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'rejected', reasons: ['policy_limit_failed'] })
  }, CLI_TIMEOUT)

  it('rejects with exit 3 when the independent evaluator rejected', () => {
    const result = runCli([
      '--run-a',
      writeRun(runAArtifacts),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest, { decision: 'rejected' })),
    ])
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'rejected', reasons: ['independent_decision_rejected'], decision: 'rejected' })
  }, CLI_TIMEOUT)

  it('does not accept a dirty candidate even with a passing policy and an accepting decision', () => {
    const dirtyA = benchmarkRunArtifacts({ generatedAt: '2026-08-08T01:00:00Z', dirtyWorktree: true })
    const result = runCli([
      '--run-a',
      writeRun(dirtyA),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest, {}, { a: dirtyA })),
    ])
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout)).toMatchObject({ status: 'rejected', reasons: ['run_a_dirty_worktree'] })
  }, CLI_TIMEOUT)
})

describe('qualify-retrieval evidence faults', () => {
  it('refuses a mismatched run pair with exit 4', () => {
    const otherCommit = benchmarkRunArtifacts({ commitSha: 'b'.repeat(40) })
    const result = runCli([
      '--run-a',
      writeRun(runAArtifacts),
      '--run-b',
      writeRun(otherCommit),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest, {}, { b: otherCommit })),
    ])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('run_identity_mismatch:candidateCommit')
    expect(result.stdout).not.toContain('accepted')
  }, CLI_TIMEOUT)

  it('refuses an artifact tampered after publication with exit 4', () => {
    const summary = JSON.parse(runAArtifacts.summaryText) as Record<string, unknown>
    summary.normalizedResultDigest = 'f'.repeat(64)
    const tampered = { ...runAArtifacts, summaryText: `${JSON.stringify(summary, null, 2)}\n` }
    const result = runCli([
      '--run-a',
      writeRun(tampered),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest)),
    ])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('normalized_result_digest_mismatch')
  }, CLI_TIMEOUT)

  it('refuses an incomplete benchmark whose rows were removed with exit 4', () => {
    const rows = runAArtifacts.scenarioResultsText.split('\n').filter(line => line.trim().length > 0)
    const truncated = { ...runAArtifacts, scenarioResultsText: `${rows.slice(1).join('\n')}\n` }
    const result = runCli(['--run-a', writeRun(truncated), '--run-b', writeRun(runBArtifacts)])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('scenario_result_count_mismatch')
  }, CLI_TIMEOUT)

  it('refuses a run whose scenario rows are not valid JSON with exit 2', () => {
    const broken = { ...runAArtifacts, scenarioResultsText: `${runAArtifacts.scenarioResultsText}{ not json\n` }
    const result = runCli(['--run-a', writeRun(broken), '--run-b', writeRun(runBArtifacts)])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('scenario_results_malformed_json')
  }, CLI_TIMEOUT)

  // ADR-011: a vector policy describes evidence the evaluator refuses to
  // produce, so it can never be reconciled with a lexical benchmark.
  it('refuses a vector policy against lexical evidence with exit 2', () => {
    const vectorPolicy = approvedPolicyObject({ requestedModes: ['vector'] })
    const result = runCli([
      '--run-a',
      writeRun(runAArtifacts),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', vectorPolicy),
      '--decision',
      writeJson('decision.json', decisionObject(vectorPolicy.policyDigest)),
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('approved_policy_invalid')
    expect(result.stdout).not.toContain('accepted')
  }, CLI_TIMEOUT)

  it('refuses a decision bound to different artifact bytes with exit 4', () => {
    const republished = benchmarkRunArtifacts({ generatedAt: '2026-08-09T12:00:00Z' })
    const result = runCli([
      '--run-a',
      writeRun(republished),
      '--run-b',
      writeRun(runBArtifacts),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest)),
    ])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('decision_run_a_artifact_hash_mismatch')
  }, CLI_TIMEOUT)

  it('refuses a benchmark whose assertions failed without ever consulting governance', () => {
    const results = passingRetrievalResults()
    results[0] = { ...results[0]!, outcome: 'failed', assertions: results[0]!.assertions.map(assertion => ({ ...assertion, passed: false })) }
    const failed = benchmarkRunArtifacts({ results, generatedAt: '2026-08-08T01:00:00Z' })
    const failedB = benchmarkRunArtifacts({ results, generatedAt: '2026-08-08T03:00:00Z' })
    const result = runCli([
      '--run-a',
      writeRun(failed),
      '--run-b',
      writeRun(failedB),
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest, {}, { a: failed, b: failedB })),
    ])
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout).reasons).toContain('run_a_not_valid_for_gate')
  }, CLI_TIMEOUT)
})

describe('qualify-retrieval does not manufacture evidence', () => {
  it('has no flag that asserts acceptance', () => {
    const runADirectory = writeRun(runAArtifacts)
    const runBDirectory = writeRun(runBArtifacts)
    for (const flag of ['--accepted', '--force', '--approve']) {
      const result = runCli(['--run-a', runADirectory, '--run-b', runBDirectory, flag])
      expect(result.code, `${flag} must not be accepted as an argument`).toBe(2)
    }
  }, CLI_TIMEOUT)

  it('leaves both run directories byte-identical after qualifying', () => {
    const runADirectory = writeRun(runAArtifacts)
    const runBDirectory = writeRun(runBArtifacts)
    const before = [runADirectory, runBDirectory].map(directoryDigest)
    runCli([
      '--run-a',
      runADirectory,
      '--run-b',
      runBDirectory,
      '--policy',
      writeJson('policy.json', passingPolicyObject),
      '--decision',
      writeJson('decision.json', decisionObject(passingPolicyObject.policyDigest)),
    ])
    expect([runADirectory, runBDirectory].map(directoryDigest)).toEqual(before)
  }, CLI_TIMEOUT)
})

/** The published artifacts of a run directory, listed and read back verbatim. */
function directoryDigest(directory: string): string {
  return readdirSync(directory).sort().map(name => `${name}:${readFileSync(join(directory, name), 'utf8')}`).join('|')
}
