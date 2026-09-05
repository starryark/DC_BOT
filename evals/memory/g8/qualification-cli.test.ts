import type { G8EvaluationRunFiles, G8PerformanceRunFiles } from './qualification'

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { G8_CANDIDATE_COMMIT, greenBundle, OTHER_COMMIT } from './qualification-fixtures'

/**
 * `memory:qualify-g8` end-to-end matrix.
 *
 * The unit tests prove the aggregate's logic; these prove the process contract
 * around it — that a bare invocation fails closed with every family reported
 * missing, that exit 0 is reachable only through the complete arrangement, and
 * that the CLI offers no flag that could assert a pass.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const QUALIFY_ENTRY = resolve(import.meta.dirname, '../../../scripts/memory/qualify-g8.ts')

const CLI_TIMEOUT = 60000

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

/** Publish one evaluation run's three artifacts as the evaluator writes them. */
function writeEvaluationRun(files: G8EvaluationRunFiles): string {
  const dir = scratchDir('g8-qualify-eval-')
  writeFileSync(join(dir, 'summary.json'), files.summaryJson)
  writeFileSync(join(dir, 'scenario-results.jsonl'), files.scenarioResultsJsonl)
  writeFileSync(join(dir, 'report.md'), files.reportText)
  return dir
}

/** Publish one performance run's five loadable artifacts. */
function writePerformanceRun(files: G8PerformanceRunFiles): string {
  const dir = scratchDir('g8-qualify-perf-')
  writeFileSync(join(dir, 'run-manifest.json'), files.runManifestJson)
  writeFileSync(join(dir, 'attempts.jsonl'), files.attemptsJsonl)
  writeFileSync(join(dir, 'run-findings.jsonl'), files.runFindingsJsonl)
  writeFileSync(join(dir, 'measurements.jsonl'), files.measurementsJsonl)
  writeFileSync(join(dir, 'summary.json'), files.summaryJson)
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

const bundle = greenBundle().input

/** The full flag set for the green bundle, so single-flag mutations stay readable. */
function greenArgs(): string[] {
  return [
    '--candidate',
    G8_CANDIDATE_COMMIT,
    '--functional-run-a',
    writeEvaluationRun(bundle.functional!.runA!),
    '--functional-run-b',
    writeEvaluationRun(bundle.functional!.runB!),
    '--functional-thresholds',
    writeJson('functional-thresholds.json', bundle.functional!.thresholds),
    '--multilingual-run-a',
    writeEvaluationRun(bundle.multilingual!.runA!),
    '--multilingual-run-b',
    writeEvaluationRun(bundle.multilingual!.runB!),
    '--multilingual-thresholds',
    writeJson('multilingual-thresholds.json', bundle.multilingual!.thresholds),
    '--retrieval-policy',
    writeJson('retrieval-policy.json', bundle.multilingual!.policy),
    '--retrieval-decision',
    writeJson('retrieval-decision.json', bundle.multilingual!.decision),
    '--performance-run-a',
    writePerformanceRun(bundle.performance!.runA!),
    '--performance-run-b',
    writePerformanceRun(bundle.performance!.runB!),
    '--performance-thresholds',
    writeJson('performance-thresholds.json', bundle.performance!.thresholds),
    '--price-document',
    writeJson('price-document.json', bundle.priceDocument),
    '--soak-report',
    writeJson('soak-report.json', bundle.soakReport),
    ...bundle.signoffs!.map((signoff, index) => ['--signoff', writeJson(`signoff-${index}.json`, signoff)] as const).flat(),
  ]
}

describe('qualify-g8 cli arguments', () => {
  it('rejects a missing candidate with exit 2', () => {
    const result = runCli([])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('"reasons":["cli_arguments_invalid"]')
  }, CLI_TIMEOUT)

  it('rejects a candidate that is not a full commit SHA with exit 2', () => {
    expect(runCli(['--candidate', 'deadbeef']).code).toBe(2)
  }, CLI_TIMEOUT)

  it('rejects an unknown argument with exit 2', () => {
    expect(runCli(['--candidate', G8_CANDIDATE_COMMIT, '--pass']).code).toBe(2)
  }, CLI_TIMEOUT)

  it('refuses a run directory inside the repository with exit 2', () => {
    const result = runCli([
      '--candidate',
      G8_CANDIDATE_COMMIT,
      '--functional-run-a',
      join(REPO_ROOT, '.local', 'memory'),
      '--functional-run-b',
      writeEvaluationRun(bundle.functional!.runB!),
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('run_directory_unusable')
  }, CLI_TIMEOUT)

  it('refuses a run directory missing an artifact with exit 2', () => {
    const incomplete = scratchDir('g8-qualify-partial-')
    writeFileSync(join(incomplete, 'summary.json'), bundle.functional!.runA!.summaryJson)
    const result = runCli([
      '--candidate',
      G8_CANDIDATE_COMMIT,
      '--functional-run-a',
      incomplete,
      '--functional-run-b',
      writeEvaluationRun(bundle.functional!.runB!),
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('scenario-results.jsonl')
  }, CLI_TIMEOUT)

  it('refuses a document file that is not JSON with exit 2', () => {
    const notJson = join(scratchDir('g8-qualify-doc-'), 'soak.json')
    writeFileSync(notJson, '{ not json')
    const result = runCli(['--candidate', G8_CANDIDATE_COMMIT, '--soak-report', notJson])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('input_file_invalid')
  }, CLI_TIMEOUT)

  it('has no flag that asserts a pass', () => {
    for (const flag of ['--accepted', '--force', '--approve', '--pass']) {
      expect(runCli(['--candidate', G8_CANDIDATE_COMMIT, flag]).code, `${flag} must not be accepted as an argument`).toBe(2)
    }
  }, CLI_TIMEOUT)
})

// A complete evidence set and a decision nobody has recorded are different
// facts. Exit 3 says "blocked"; the payload says which families are missing.
describe('qualify-g8 fails closed', () => {
  it('reports every family missing when only the candidate is supplied', () => {
    const result = runCli(['--candidate', G8_CANDIDATE_COMMIT])
    expect(result.code, result.stderr).toBe(3)
    const payload = JSON.parse(result.stdout)
    expect(payload).toMatchObject({ format: 1, gate: 'g8', status: 'blocked', candidateCommit: G8_CANDIDATE_COMMIT })
    expect(payload.blockers).toContain('functional_missing')
    expect(payload.blockers).toContain('multilingual_missing')
    expect(payload.blockers).toContain('performance_missing')
    expect(payload.blockers).toContain('cost_document_missing')
    expect(payload.blockers).toContain('drill_evidence_missing')
    expect(payload.blockers).toContain('signoff_missing:privacy-lead')
    expect(payload.blockers).toContain('gate_readiness_unasserted')
  }, CLI_TIMEOUT)

  it('stays blocked when every signoff is withheld from an otherwise green bundle', () => {
    const args = greenArgs().filter((value, index, all) => value !== '--signoff' && all[index - 1] !== '--signoff')
    const result = runCli(args)
    expect(result.code, result.stderr).toBe(3)
    expect(JSON.parse(result.stdout).blockers).toContain('signoff_missing:privacy-lead')
  }, CLI_TIMEOUT)
})

describe('qualify-g8 verdicts', () => {
  it('passes the complete, fully matching arrangement with exit 0', () => {
    const result = runCli(greenArgs())
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: 1,
      gate: 'g8',
      status: 'pass',
      candidateCommit: G8_CANDIDATE_COMMIT,
      blockers: [],
    })
  }, CLI_TIMEOUT)

  it('blocks otherwise green evidence when a different candidate is requested', () => {
    const args = greenArgs().map((value, index, all) => (index > 0 && all[index - 1] === '--candidate' ? OTHER_COMMIT : value))
    const result = runCli(args)
    expect(result.code, result.stderr).toBe(3)
    const payload = JSON.parse(result.stdout)
    expect(payload.blockers).toContain('functional_run_a_stale_candidate')
    expect(payload.blockers).toContain('performance_run_a_stale_candidate')
    expect(payload.blockers).toContain('drill_stale_candidate')
    expect(payload.blockers).toContain('signoff_wrong_scope:privacy-lead')
  }, CLI_TIMEOUT)

  it('leaves every input directory byte-identical after qualifying', () => {
    const args = greenArgs()
    const directories = args.filter((_, index, all) => all[index - 1]?.endsWith('-run-a') || all[index - 1]?.endsWith('-run-b'))
    const before = directories.map(directoryDigest)
    runCli(args)
    expect(directories.map(directoryDigest)).toEqual(before)
  }, CLI_TIMEOUT)
})

/** The published artifacts of a run directory, listed and read back verbatim. */
function directoryDigest(directory: string): string {
  return readdirSync(directory).sort().map(name => `${name}:${readFileSync(join(directory, name), 'utf8')}`).join('|')
}
