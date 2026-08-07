import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * CLI invalid-input and credential-free smoke tests for the IMP-803 benchmark.
 *
 * These exercise the argv and output-safety guards without running a full
 * suite: invalid suite/seed, full suite without output, output inside the
 * checkout, nonempty output, and a credential-free smoke success that writes
 * the complete artifact set.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..', '..', '..')
const BENCH_ENTRY = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'memory', 'benchmark.ts')

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
  const dir = mkdtempSync(join(tmpdir(), 'imp803-cli-test-'))
  scratchDirs.push(dir)
  return dir
}

async function runCli(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const { execFileSync } = await import('node:child_process')
  try {
    const stdout = execFileSync('npx', ['tsx', BENCH_ENTRY, '--', ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120000, shell: true })
    return { code: 0, stdout, stderr: '' }
  }
  catch (error) {
    const e = error as { status?: number, stdout?: string, stderr?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

describe('benchmark CLI invalid input', () => {
  it('rejects an unknown suite with exit 2', async () => {
    const result = await runCli(['--suite', 'bogus', '--seed', '1'])
    expect(result.code).toBe(2)
  })

  it('rejects a negative seed with exit 2', async () => {
    const result = await runCli(['--suite', 'smoke', '--seed', '-5'])
    expect(result.code).toBe(2)
  })

  it('rejects performance-v1 without an explicit --output with exit 2', async () => {
    const result = await runCli(['--suite', 'performance-v1', '--seed', '1'])
    expect(result.code).toBe(2)
  })

  it('rejects an unknown argument with exit 2', async () => {
    const result = await runCli(['--nonsense'])
    expect(result.code).toBe(2)
  })
})

describe('benchmark CLI unsafe paths', () => {
  it('refuses an output directory inside the repository with exit 4', async () => {
    const inside = join(REPO_ROOT, 'airi', '.local', 'memory')
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

describe('benchmark CLI help', () => {
  it('prints help text and exits 0', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--suite')
    expect(result.stdout).toContain('Exit codes')
  })
})

describe('benchmark CLI credential-free smoke success', () => {
  it('runs the smoke suite to completion and writes artifacts with exit 0', async () => {
    const out = mkdtempSync(join(tmpdir(), 'imp803-cli-smoke-'))
    scratchDirs.push(out)
    const result = await runCli(['--suite', 'smoke', '--seed', '20260802', '--output', out, '--samples', '1', '--warmup', '1'])
    expect(result.code, result.stderr || result.stdout).toBe(0)
    expect(existsSync(join(out, 'summary.json'))).toBe(true)
    expect(existsSync(join(out, 'measurements.jsonl'))).toBe(true)
    expect(existsSync(join(out, 'report.md'))).toBe(true)
    expect(existsSync(join(out, 'run-manifest.json'))).toBe(true)
  }, 120000)
})
