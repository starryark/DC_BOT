import process from 'node:process'

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { latestSchemaVersion, openAuthoritativeSqliteDatabase } from '@proj-airi/memory-sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { prepareSoakRun, reportSoakRun, verifySoakRun } from '../../scripts/memory/active-soak-stages'
import { SOAK_SCENARIOS } from './active-soak'

/**
 * Operator-level tests for the active-soak stages.
 *
 * These exercise the filesystem, git, output-location, and authority guards
 * against a throwaway checkout rather than this repository, because the guards
 * exist precisely to reject states a running repository is not in. The CLI
 * entrypoint keeps the real repository root as a process fact; the stages take
 * it as a parameter, which is what makes a fixture checkout possible.
 */

const RUN_ID = 'soak-cli-001'
const CLI = fileURLToPath(new URL('../../scripts/memory/active-soak.ts', import.meta.url))
const SERVICE_ROOT = fileURLToPath(new URL('../..', import.meta.url))
/**
 * The one case below spawns the CLI in a child Node process with the tsx
 * loader, which costs seconds under parallel suite load; Vitest's 5 s default
 * would expire on that cost rather than on CLI behaviour.
 */
const CLI_TEST_TIMEOUT_MS = 120_000

let workspace: string
let repoRoot: string
let runtimeRoot: string
let outputDirectory: string
let bindingFile: string
let headSha: string

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function guildBinding(id: string, guildId: string, channelSuffix: string) {
  return {
    id,
    characterId: 'character-a',
    locations: [
      { kind: 'guildText', guildId, channelId: `1844674407370955161${channelSuffix}` },
      { kind: 'guildVoice', guildId, channelId: `1844674407370955162${channelSuffix}` },
    ],
  }
}

function writeBindingFile(path: string, bindings: unknown[]): string {
  writeFileSync(path, JSON.stringify({ version: 1, bindings }))
  return path
}

/** Thirteen distinct, non-overlapping windows, which is the minimum a report can be built from. */
function attestationDocument(commitSha: string) {
  return {
    format: 1,
    runId: RUN_ID,
    commitSha,
    scenarios: SOAK_SCENARIOS.map((scenario, index) => ({
      id: scenario.id,
      from: `2026-08-02T10:00:${String(index * 4).padStart(2, '0')}.000Z`,
      to: `2026-08-02T10:00:${String(index * 4 + 2).padStart(2, '0')}.000Z`,
      observed: 'pass',
    })),
    rollbackDrillPassed: true,
    deletionVerified: true,
    oldBackupRestoreVerified: true,
  }
}

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'active-soak-')))
  repoRoot = join(workspace, 'checkout')
  runtimeRoot = join(workspace, 'runtime')
  outputDirectory = join(workspace, 'evidence')

  mkdirSync(repoRoot, { recursive: true })
  git(repoRoot, ['init', '-q', '-b', 'main'])
  git(repoRoot, ['config', 'user.email', 'soak@example.invalid'])
  git(repoRoot, ['config', 'user.name', 'Soak Fixture'])
  // Without this the fixture commit emits a CRLF conversion warning on Windows,
  // which is noise the dirty-worktree assertion must not be confused with.
  git(repoRoot, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(repoRoot, 'candidate.txt'), 'candidate\n')
  git(repoRoot, ['add', '-A'])
  git(repoRoot, ['commit', '-q', '-m', 'candidate'])
  headSha = git(repoRoot, ['rev-parse', 'HEAD']).trim()

  mkdirSync(join(runtimeRoot, 'authority'), { recursive: true })
  openAuthoritativeSqliteDatabase(join(runtimeRoot, 'authority', 'memory.sqlite')).close()

  bindingFile = writeBindingFile(join(workspace, 'bindings.json'), [guildBinding('private', '99999999999999999', '5')])
})

afterEach(() => rmSync(workspace, { recursive: true, force: true }))

function prepareOptions(overrides: Record<string, string> = {}) {
  return { runId: RUN_ID, commit: headSha, root: runtimeRoot, bindingFile, out: outputDirectory, ...overrides }
}

describe('active soak prepare guards', () => {
  it('refuses to arm a run from a dirty worktree', async () => {
    writeFileSync(join(repoRoot, 'uncommitted.txt'), 'scratch\n')

    await expect(prepareSoakRun(prepareOptions(), repoRoot)).rejects.toThrow(/worktree is dirty/)
  })

  it('refuses a commit that is not the checked-out HEAD', async () => {
    await expect(prepareSoakRun(prepareOptions({ commit: 'f'.repeat(40) }), repoRoot)).rejects.toThrow(/HEAD is .* but --commit is/)
    await expect(prepareSoakRun(prepareOptions({ commit: headSha.slice(0, 12) }), repoRoot)).rejects.toThrow(/exact full 40-character/)
  })

  it('refuses an output directory inside the repository checkout', async () => {
    await expect(prepareSoakRun(prepareOptions({ out: join(repoRoot, 'evidence') }), repoRoot)).rejects.toThrow(/inside the repository checkout/)
    await expect(prepareSoakRun(prepareOptions({ out: repoRoot }), repoRoot)).rejects.toThrow(/inside the repository checkout/)
  })

  it('refuses a runtime root inside the repository checkout', async () => {
    mkdirSync(join(repoRoot, '.local', 'memory', 'authority'), { recursive: true })

    await expect(prepareSoakRun(prepareOptions({ root: join(repoRoot, '.local', 'memory') }), repoRoot)).rejects.toThrow(/isolated from the repository checkout/)
  })

  it('refuses a runtime root with no authority database', async () => {
    await expect(prepareSoakRun(prepareOptions({ root: join(workspace, 'empty-runtime') }), repoRoot)).rejects.toThrow(/Memory authority does not exist/)
  })

  it('refuses a binding specification that is unparsable or spans more than one guild', async () => {
    const multiGuild = writeBindingFile(join(workspace, 'multi-guild.json'), [guildBinding('a', '99999999999999999', '5'), guildBinding('b', '88888888888888888', '6')])
    const malformed = join(workspace, 'malformed.json')
    writeFileSync(malformed, '{"version": 1')

    await expect(prepareSoakRun(prepareOptions({ bindingFile: multiGuild }), repoRoot)).rejects.toThrow(/exactly one private guild/)
    await expect(prepareSoakRun(prepareOptions({ bindingFile: malformed }), repoRoot)).rejects.toThrow(/could not be read as JSON/)
  })

  it('refuses a run identity that already has state', async () => {
    await prepareSoakRun(prepareOptions(), repoRoot)

    await expect(prepareSoakRun(prepareOptions(), repoRoot)).rejects.toThrow(/already has state/)
  })
})

describe('active soak prepare artifacts', () => {
  it('binds the candidate, takes a verified backup, and records its digest', async () => {
    const prepared = await prepareSoakRun(prepareOptions(), repoRoot)
    const state = JSON.parse(readFileSync(prepared.statePath, 'utf8')) as Record<string, string | number | string[]>

    expect(prepared.commitSha).toBe(headSha)
    expect(prepared.scenarios).toBe(SOAK_SCENARIOS.length)
    expect(existsSync(prepared.backupPath)).toBe(true)
    expect(existsSync(`${prepared.backupPath}.manifest.json`)).toBe(true)
    expect(state.commitSha).toBe(headSha)
    expect(state.schemaVersion).toBe(latestSchemaVersion)
    expect(state.authorityPath).toBe(join(runtimeRoot, 'authority', 'memory.sqlite'))
    expect(state.scenarios).toHaveLength(SOAK_SCENARIOS.length)
    expect(state.preSoakBackupDigest).toBe(createHash('sha256').update(readFileSync(prepared.backupPath)).digest('hex'))
    expect(state.redactionKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it.skipIf(process.platform === 'win32')('publishes the run state, backup, and manifest owner-only', async () => {
    const prepared = await prepareSoakRun(prepareOptions(), repoRoot)

    for (const path of [prepared.statePath, prepared.backupPath, `${prepared.backupPath}.manifest.json`])
      expect(statSync(path).mode & 0o077, path).toBe(0)
    expect(statSync(outputDirectory).mode & 0o077).toBe(0)
  })
})

describe('active soak report authority binding', () => {
  async function preparedRun() {
    const prepared = await prepareSoakRun(prepareOptions(), repoRoot)
    const attestationPath = join(workspace, 'attestation.json')
    writeFileSync(attestationPath, JSON.stringify(attestationDocument(headSha)))
    return { prepared, attestationPath }
  }

  it('refuses a runtime root other than the one bound during preparation', async () => {
    const { prepared, attestationPath } = await preparedRun()
    mkdirSync(join(workspace, 'other-runtime', 'authority'), { recursive: true })
    openAuthoritativeSqliteDatabase(join(workspace, 'other-runtime', 'authority', 'memory.sqlite')).close()

    expect(() => reportSoakRun({ state: prepared.statePath, attestation: attestationPath, root: join(workspace, 'other-runtime') }, repoRoot))
      .toThrow(/is not the runtime root bound during preparation/)
  })

  it('refuses to write the report inside the repository checkout', async () => {
    const { prepared, attestationPath } = await preparedRun()

    expect(() => reportSoakRun({ state: prepared.statePath, attestation: attestationPath, out: join(repoRoot, 'reports') }, repoRoot))
      .toThrow(/inside the repository checkout/)
  })

  it('reads the bound authority and writes a report tied to the candidate and backup', async () => {
    const { prepared, attestationPath } = await preparedRun()

    const result = reportSoakRun({ state: prepared.statePath, attestation: attestationPath }, repoRoot)
    const report = JSON.parse(readFileSync(result.reportPath, 'utf8')) as Record<string, unknown>

    expect(result.reportPath).toBe(join(outputDirectory, `${RUN_ID}.report.json`))
    expect(report.commitSha).toBe(headSha)
    expect(report.schemaVersion).toBe(latestSchemaVersion)
    expect(report.preSoakBackupDigest).toBe(createHash('sha256').update(readFileSync(prepared.backupPath)).digest('hex'))
    expect(JSON.stringify(report)).not.toContain(prepared.backupPath)
  })

  it('reports an empty authority as failing verification rather than passing it', async () => {
    const { prepared, attestationPath } = await preparedRun()

    const result = reportSoakRun({ state: prepared.statePath, attestation: attestationPath }, repoRoot)
    const verdict = verifySoakRun({ report: result.reportPath, commit: headSha })

    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toContainEqual('the deletion scenario window contains no durable forget request')
  })
})

describe('active soak command exit status', { timeout: CLI_TEST_TIMEOUT_MS }, () => {
  it('exits nonzero when verification fails', () => {
    const reportPath = join(workspace, 'unusable.report.json')
    writeFileSync(reportPath, JSON.stringify({ format: 1 }))

    const result = spawnSync(process.execPath, ['--import', 'tsx', CLI, 'verify', '--report', reportPath, '--commit', headSha], { cwd: SERVICE_ROOT, encoding: 'utf8' })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stdout) as { status: string, failures: string[] }).toEqual({ status: 'failed', failures: ['report does not match the expected schema'] })
  })
})
