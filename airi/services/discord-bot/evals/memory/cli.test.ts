import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * CLI invalid-input and unsafe-path tests for the G8-1 evaluator (IMP-802, T005).
 *
 * These exercise the argv guards without running a full suite: invalid suite
 * names, invalid seeds, an output directory inside the repository, a nonempty
 * output directory that is not a prior run, and a threshold file with mismatched
 * provenance. Each must produce the documented nonzero exit, not a run.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..')
const EVAL_ENTRY = resolve(import.meta.dirname, '../../scripts/memory/evaluate.ts')

const scratchDirs: string[] = []

beforeEach(() => {
  scratchDirs.length = 0
})
afterEach(() => {
  for (const dir of scratchDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    }
    catch {
      // Windows transient file-handle locks
    }
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'g8-cli-test-'))
  scratchDirs.push(dir)
  return dir
}

async function runCli(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const { execFileSync } = await import('node:child_process')
  try {
    const stdout = execFileSync('npx', ['tsx', EVAL_ENTRY, '--', ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120000, shell: true })
    return { code: 0, stdout, stderr: '' }
  }
  catch (error) {
    const e = error as { status?: number, stdout?: string, stderr?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

describe('cLI invalid input', () => {
  it('rejects an unknown suite with exit 2', async () => {
    const result = await runCli(['--suite', 'bogus', '--seed', '1'])
    expect(result.code).toBe(2)
  })

  it('rejects a negative seed with exit 2', async () => {
    const result = await runCli(['--suite', 'smoke', '--seed', '-5'])
    expect(result.code).toBe(2)
  })

  it('rejects active-v1 without an explicit --output with exit 2', async () => {
    const result = await runCli(['--suite', 'active-v1', '--seed', '1'])
    expect(result.code).toBe(2)
  })

  it('rejects an unknown argument with exit 2', async () => {
    const result = await runCli(['--nonsense'])
    expect(result.code).toBe(2)
  })
})

describe('cLI unsafe paths', () => {
  it('refuses an output directory inside the repository with exit 4', async () => {
    const inside = join(REPO_ROOT, '.local', 'memory')
    const result = await runCli(['--suite', 'smoke', '--seed', '1', '--output', inside])
    expect(result.code).toBe(4)
  })

  it('refuses a nonempty output directory that is not a prior run with exit 4', async () => {
    const out = tempDir()
    writeFileSync(join(out, 'unrelated.txt'), 'x')
    const result = await runCli(['--suite', 'smoke', '--seed', '1', '--output', out])
    expect(result.code).toBe(4)
  })
})

describe('cLI threshold provenance', () => {
  it('rejects a threshold file with mismatched provenance with exit 2', async () => {
    const out = tempDir()
    const thresholdFile = join(out, 'thresholds.json')
    writeFileSync(thresholdFile, JSON.stringify({
      format: 1,
      approver: 'owner',
      approvedAt: '2026-08-06T00:00:00Z',
      source: 'eval',
      repositoryCommit: 'a'.repeat(40),
      datasetVersion: '9.9.9',
      datasetDigest: '0'.repeat(64),
      evaluatorSchemaVersion: 1,
      limits: [{ name: 'x', metric: 'y', operation: '<=', value: 1 }],
    }))
    const result = await runCli(['--suite', 'smoke', '--seed', '1', '--output', mkdtempSync(join(out, 'run-')), '--thresholds', thresholdFile])
    expect(result.code).toBe(2)
  })
})

describe('cLI smoke success', () => {
  it('runs the smoke suite to completion and writes artifacts with exit 0', async () => {
    const out = mkdtempSync(join(tmpdir(), 'g8-cli-smoke-'))
    scratchDirs.push(out)
    const result = await runCli(['--suite', 'smoke', '--seed', '20260802', '--output', out])
    expect(result.code, result.stderr || result.stdout).toBe(0)
    expect(existsSync(join(out, 'summary.json'))).toBe(true)
    expect(existsSync(join(out, 'scenario-results.jsonl'))).toBe(true)
    expect(existsSync(join(out, 'report.md'))).toBe(true)
  }, 120000)
})
