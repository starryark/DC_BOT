import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { WORKLOAD_CATALOG_DIGEST } from './workloads'

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

  it('rejects performance-v2 without an explicit --output with exit 2', async () => {
    const result = await runCli(['--suite', 'performance-v2', '--seed', '1'])
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

describe('benchmark CLI integration and evidence loading', () => {
  const writeJson = (name: string, data: any) => {
    const dir = tempDir()
    const path = join(dir, name)
    writeFileSync(path, JSON.stringify(data))
    return path
  }

  const validThreshold = {
    format: 'performance-thresholds',
    schemaVersion: 2,
    contractId: 'performance-v2',
    contractDigest: WORKLOAD_CATALOG_DIGEST,
    source: 'test',
    approver: 'test-approver',
    approvedAt: '2026-08-01T00:00:00Z',
    provenance: 'test-provenance',
    thresholds: [
      {
        workloadId: 'smoke-runtime-open-close',
        metricId: 'smoke-runtime-open-close.p95',
        statistic: 'p95',
        unit: 'milliseconds',
        comparator: 'lte',
        bound: 100000,
      },
    ],
  }

  const validPrice = {
    format: 1,
    provider: 'openai',
    model: 'bench/text-v1',
    billingUnit: 'token',
    currency: 'USD',
    dimensions: [
      { dimension: 'input', unit: 'token', pricePerUnit: 0.001 },
      { dimension: 'output', unit: 'token', pricePerUnit: 0.002 },
      { dimension: 'thinking', unit: 'token', pricePerUnit: 0.002 },
    ],
    effectiveStart: '2026-08-01T00:00:00Z',
    source: 'test',
    approver: 'test',
    approvedAt: '2026-08-01T00:00:00Z',
    provenance: 'test',
  }

  const validLive = {
    format: 1,
    kind: 'tts-sample',
    sampleId: 'test-sample',
    fileDigest: '0000000000000000000000000000000000000000000000000000000000000000',
    fileSizeBytes: 100,
    hostProvenance: 'test',
    configProvenance: 'test',
    observedAt: '2026-08-01T00:00:00Z',
  }

  it('no threshold -> measured-not-evaluated', async () => {
    const out = tempDir()
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1'])
    expect(result.code).toBe(0)
    const measurements = readFileSync(join(out, 'measurements.jsonl'), 'utf8')
    expect(measurements).toContain('"thresholdEvaluation":"not_evaluated"')
    expect(measurements).not.toContain('"thresholdEvaluation":"passed"')
    expect(measurements).not.toContain('"thresholdEvaluation":"failed"')
  })

  it('threshold pass -> passed', async () => {
    const out = tempDir()
    const tPath = writeJson('t.json', validThreshold)
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--thresholds', tPath])
    expect(result.code).toBe(0)
    const measurements = readFileSync(join(out, 'measurements.jsonl'), 'utf8')
    expect(measurements).toContain('"thresholdEvaluation":"passed"')
  })

  it('threshold fail -> exit 3', async () => {
    const out = tempDir()
    const failingThreshold = { ...validThreshold, thresholds: [{ ...validThreshold.thresholds[0], bound: 0 }] }
    const tPath = writeJson('t.json', failingThreshold)
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--thresholds', tPath])
    expect(result.code).toBe(3)
    const measurements = readFileSync(join(out, 'measurements.jsonl'), 'utf8')
    expect(measurements).toContain('"thresholdEvaluation":"failed"')
  })

  it('malformed threshold -> exit 2 before runtime', async () => {
    const out = tempDir()
    const tPath = writeJson('t.json', { ...validThreshold, format: 'wrong' })
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--thresholds', tPath])
    expect(result.code).toBe(2)
  })

  it('valid price + no usage -> digest present, cost unavailable', async () => {
    const out = tempDir()
    const pPath = writeJson('p.json', validPrice)
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--price-document', pPath])
    expect(result.code).toBe(0)
    const manifest = JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8'))
    expect(manifest.priceDocumentDigest).toMatch(/^[0-9a-f]{64}$/)
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    expect(summary.costAvailability).toBe('unavailable')
  })

  it('malformed price -> exit 2', async () => {
    const out = tempDir()
    const pPath = writeJson('p.json', { ...validPrice, format: 'wrong' })
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--price-document', pPath])
    expect(result.code).toBe(2)
  })

  it('valid live summary -> digest present', async () => {
    const out = tempDir()
    const lPath = writeJson('l.json', validLive)
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--import-live', lPath])
    expect(result.code).toBe(0)
    const manifest = JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8'))
    expect(manifest.importedLiveArtifactDigests.length).toBe(1)
  })

  it('duplicate live summary -> exit 2', async () => {
    const out = tempDir()
    const lPath = writeJson('l.json', validLive)
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--import-live', lPath, '--import-live', lPath])
    expect(result.code).toBe(2)
  })

  it('malformed live summary -> exit 2', async () => {
    const out = tempDir()
    const lPath = writeJson('l.json', { ...validLive, format: 'wrong' })
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--import-live', lPath])
    expect(result.code).toBe(2)
  })

  it('--sample-capacity 2 -> emitted measurements show capacity 2', async () => {
    const out = tempDir()
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '3', '--warmup', '1', '--sample-capacity', '2'])
    expect(result.code).toBe(0)
    const measurements = readFileSync(join(out, 'measurements.jsonl'), 'utf8')
    expect(measurements).toContain('"sampleCapacity":2')
  })

  it('manifest CPU/memory values are no longer synthetic placeholders', async () => {
    const out = tempDir()
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1'])
    expect(result.code).toBe(0)
    const manifest = JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8'))
    expect(manifest.environment.cpuModel).not.toBe('synthetic')
    expect(manifest.environment.totalMemoryBytes).toBeGreaterThan(0)
  })

  it('starting/ending timestamps are ordered', async () => {
    const out = tempDir()
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1'])
    expect(result.code).toBe(0)
    const manifest = JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8'))
    const start = new Date(manifest.startedAt).getTime()
    const end = new Date(manifest.completedAt).getTime()
    expect(start).toBeLessThanOrEqual(end)
  })

  it('no input changes the deterministic contract digest', async () => {
    const out1 = tempDir()
    const result1 = await runCli(['--suite', 'smoke', '--output', out1, '--samples', '1', '--warmup', '1'])
    expect(result1.code).toBe(0)
    const manifest1 = JSON.parse(readFileSync(join(out1, 'run-manifest.json'), 'utf8'))

    const out2 = tempDir()
    const tPath = writeJson('t.json', validThreshold)
    const pPath = writeJson('p.json', validPrice)
    const lPath = writeJson('l.json', validLive)
    const result2 = await runCli(['--suite', 'smoke', '--output', out2, '--samples', '3', '--warmup', '2', '--sample-capacity', '2', '--thresholds', tPath, '--price-document', pPath, '--import-live', lPath])
    expect(result2.code).toBe(0)
    const manifest2 = JSON.parse(readFileSync(join(out2, 'run-manifest.json'), 'utf8'))

    expect(manifest1.contractDigest).toBe(manifest2.contractDigest)
    expect(manifest1.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
  }, 120000)

  it('--baseline successfully compares to a compatible directory', async () => {
    const baseDir = tempDir()
    const r1 = await runCli(['--suite', 'smoke', '--output', baseDir, '--samples', '1', '--warmup', '1'])
    expect(r1.code).toBe(0)

    const candDir = tempDir()
    const r2 = await runCli(['--suite', 'smoke', '--output', candDir, '--samples', '1', '--warmup', '1', '--baseline', baseDir])
    expect(r2.code).toBe(0)

    const summary = JSON.parse(readFileSync(join(candDir, 'summary.json'), 'utf8'))
    expect(summary.baselineComparison).toBeDefined()
    expect(summary.baselineComparison.status).toBe('compatible')
    expect(summary.baselineComparison.deltas.length).toBeGreaterThan(0)
  })

  it('--baseline fails with exit 2 if digest is incompatible', async () => {
    const baseDir = tempDir()
    const r1 = await runCli(['--suite', 'smoke', '--output', baseDir, '--samples', '1', '--warmup', '1'])
    expect(r1.code).toBe(0)

    const manifestPath = join(baseDir, 'run-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.contractDigest = '0'.repeat(64)
    writeFileSync(manifestPath, JSON.stringify(manifest))

    const candDir = tempDir()
    const r2 = await runCli(['--suite', 'smoke', '--output', candDir, '--samples', '1', '--warmup', '1', '--baseline', baseDir])
    expect(r2.code).toBe(2)
  })
})
