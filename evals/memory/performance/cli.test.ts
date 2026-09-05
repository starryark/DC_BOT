import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadRun } from './baseline'
import { WORKLOAD_CATALOG_DIGEST } from './workloads'

/**
 * CLI invalid-input and credential-free smoke tests for the IMP-803 benchmark.
 *
 * These exercise the argv and output-safety guards without running a full
 * suite: invalid suite/seed, full suite without output, output inside the
 * checkout, nonempty output, and a credential-free smoke success that writes
 * the complete artifact set.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..')
const BENCH_ENTRY = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'memory', 'benchmark.ts')
const CAPTURE_ENTRY = resolve(import.meta.dirname, '..', '..', '..', 'scripts', 'memory', 'capture-brain-usage.ts')

/**
 * Every test in this file spawns the benchmark CLI through `npx tsx` at least
 * once, which costs seconds, not milliseconds. Vitest's 5 s default budget sits
 * below that cost once the full suite runs in parallel, so these tests expired
 * on host load rather than on CLI behaviour. The budgets below are declared on
 * the describes and stay above the spawn bound, so a genuine hang still surfaces
 * as the CLI's own timeout rather than as an ambiguous test timeout.
 */
const CLI_SPAWN_TIMEOUT_MS = 120_000
const CLI_TEST_TIMEOUT_MS = CLI_SPAWN_TIMEOUT_MS + 30_000
/** Budget for the tests that spawn the CLI twice in sequence. */
const CLI_PAIR_TEST_TIMEOUT_MS = CLI_SPAWN_TIMEOUT_MS * 2 + 30_000

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

async function runEntry(entry: string, args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  const { execFileSync } = await import('node:child_process')
  try {
    const stdout = execFileSync('npx', ['tsx', entry, '--', ...args], { encoding: 'utf8', cwd: REPO_ROOT, timeout: CLI_SPAWN_TIMEOUT_MS, shell: true })
    return { code: 0, stdout, stderr: '' }
  }
  catch (error) {
    const e = error as { status?: number, stdout?: string, stderr?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

async function runCli(args: string[]): Promise<{ code: number, stdout: string, stderr: string }> {
  return runEntry(BENCH_ENTRY, args)
}

describe('benchmark CLI invalid input', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
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

describe('benchmark CLI unsafe paths', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
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

describe('benchmark CLI help', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('prints help text and exits 0', async () => {
    const result = await runCli(['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('--suite')
    expect(result.stdout).toContain('Exit codes')
  })
})

describe('benchmark CLI credential-free smoke success', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('runs the smoke suite to completion and writes artifacts with exit 0', async () => {
    const out = mkdtempSync(join(tmpdir(), 'imp803-cli-smoke-'))
    scratchDirs.push(out)
    const result = await runCli(['--suite', 'smoke', '--seed', '20260802', '--output', out, '--samples', '1', '--warmup', '1'])
    expect(result.code, result.stderr || result.stdout).toBe(0)
    expect(existsSync(join(out, 'summary.json'))).toBe(true)
    expect(existsSync(join(out, 'measurements.jsonl'))).toBe(true)
    expect(existsSync(join(out, 'report.md'))).toBe(true)
    expect(existsSync(join(out, 'run-manifest.json'))).toBe(true)
    expect(existsSync(join(out, 'attempts.jsonl'))).toBe(true)
    expect(existsSync(join(out, 'run-findings.jsonl'))).toBe(true)
    // Written on every run so the artifact set has a fixed shape. Smoke runs
    // neither condition-5 voice workload, so the body is legitimately empty.
    expect(existsSync(join(out, 'voice-sample-diagnostics.jsonl'))).toBe(true)
    expect(readFileSync(join(out, 'voice-sample-diagnostics.jsonl'), 'utf8')).toBe('')

    // The directory must reconcile against its own rows through the same loader
    // a baseline comparison uses, so the warmup-failure count the summary now
    // carries is verified on the real CLI path rather than only in unit tests.
    const loaded = loadRun(out, (path, enc) => readFileSync(path, enc), existsSync, join)
    expect(loaded.runFindings).toEqual([])
    expect(JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')).warmupFailures).toBe(0)
  })
})

describe('benchmark CLI integration and evidence loading', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
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

  const brainUsage = (sampleId: string, overrides: Record<string, unknown> = {}) => ({
    format: 1,
    kind: 'brain-usage-sample',
    sampleId,
    fileDigest: '1'.repeat(64),
    fileSizeBytes: 256,
    hostProvenance: 'test-host',
    configProvenance: 'test-brain-capture',
    observedAt: '2026-08-02T00:00:00Z',
    usage: {
      schemaVersion: 1,
      provider: validPrice.provider,
      model: validPrice.model,
      correlationId: `usage-probe-${sampleId}`,
      inputTokens: 1000,
      outputTokens: 200,
      thinkingTokens: null,
      totalTokens: 1200,
      disposition: 'complete',
      retryCount: 0,
      observedAt: '2026-08-02T00:00:00Z',
      ...overrides,
    },
  })

  it('price + brain usage sample -> cost available with recomputable evidence', async () => {
    const out = tempDir()
    const pPath = writeJson('p.json', validPrice)
    const lPath = writeJson('l.json', brainUsage('brain-usage-001'))
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--price-document', pPath, '--import-live', lPath])
    expect(result.code).toBe(0)
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    expect(summary.costAvailability).toBe('available')
    expect(summary.costUnavailableReason).toBeUndefined()
    // The published evidence names the imported sample and reproduces the sum.
    const manifest = JSON.parse(readFileSync(join(out, 'run-manifest.json'), 'utf8'))
    expect(manifest.importedLiveArtifactDigests).toContain(summary.costEvidence.liveArtifactDigest)
    expect(manifest.priceDocumentDigest).toBe(summary.costEvidence.priceDocumentDigest)
    expect(summary.costEvidence.amount).toBeCloseTo(1000 * 0.001 + 200 * 0.002, 9)
    // A live sample never reaches the deterministic contract identity.
    expect(summary.contractDigest).toBe(WORKLOAD_CATALOG_DIGEST)
    expect(loadRun(out, (path, enc) => readFileSync(path, enc), existsSync, join).manifest.suite).toBe('smoke')
  })

  it('brain usage sample without a price document -> cost unavailable', async () => {
    const out = tempDir()
    const lPath = writeJson('l.json', brainUsage('brain-usage-001'))
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--import-live', lPath])
    expect(result.code).toBe(0)
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    expect(summary.costAvailability).toBe('unavailable')
    expect(summary.costUnavailableReason).toBe('no-price-document-supplied')
    expect(summary.costEvidence).toBeUndefined()
  })

  it('two cost-eligible brain usage samples -> exit 2 before the runtime starts', async () => {
    const out = tempDir()
    const pPath = writeJson('p.json', validPrice)
    const firstPath = writeJson('l1.json', brainUsage('brain-usage-001'))
    const secondPath = writeJson('l2.json', brainUsage('brain-usage-002'))
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--price-document', pPath, '--import-live', firstPath, '--import-live', secondPath])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('cost-eligible brain usage samples')
  })

  it('a non-complete brain usage sample stays cost-unavailable', async () => {
    const out = tempDir()
    const pPath = writeJson('p.json', validPrice)
    const lPath = writeJson('l.json', brainUsage('brain-usage-001', { disposition: 'failed' }))
    const result = await runCli(['--suite', 'smoke', '--output', out, '--samples', '1', '--warmup', '1', '--price-document', pPath, '--import-live', lPath])
    expect(result.code).toBe(0)
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'))
    expect(summary.costAvailability).toBe('unavailable')
    expect(summary.costUnavailableReason).toBe('brain-usage-not-complete')
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
  })

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
  }, CLI_PAIR_TEST_TIMEOUT_MS)

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
  }, CLI_PAIR_TEST_TIMEOUT_MS)
})

/**
 * The controlled capture command is registered and refuses to start without
 * the operator inputs a real capture needs. It makes a paid provider call, so
 * nothing here runs one: only argv handling is exercised.
 */
describe('capture-brain-usage CLI argument handling', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('documents the two-stage workflow in its help', async () => {
    const result = await runEntry(CAPTURE_ENTRY, ['--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('memory:benchmark --price-document')
    expect(result.stdout).toContain('billable provider')
  })

  it('rejects a run with no output or provenance', async () => {
    const result = await runEntry(CAPTURE_ENTRY, [])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('--host-provenance')
  })

  it('rejects an unknown argument', async () => {
    const result = await runEntry(CAPTURE_ENTRY, ['--prompt', 'say something'])
    expect(result.code).toBe(2)
  })

  it('refuses an output directory inside the checkout', async () => {
    const result = await runEntry(CAPTURE_ENTRY, ['--output', REPO_ROOT, '--host-provenance', 'h', '--config-provenance', 'c'])
    expect(result.code).toBe(4)
    expect(result.stderr).toContain('inside the repository checkout')
  })
})
