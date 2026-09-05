#!/usr/bin/env tsx
/**
 * `memory:capture-brain-usage` CLI for the IMP-803 cost-evidence path.
 *
 * Captures exactly one numeric Gemini usage sample and writes it to a private
 * external directory as an importable `brain-usage-sample` live artifact. It is
 * deliberately a separate command from `memory:benchmark`: the deterministic
 * benchmark stays provider-offline, and this is the only memory CLI that makes
 * a paid provider call — only when an operator runs it with credentials.
 *
 * Nothing about the request or the response is retained. The probe prompt is
 * fixed and synthetic, the streamed text is discarded chunk by chunk, and the
 * two published files carry numeric token counts plus operator-supplied
 * content-free provenance. Import `live-artifact.json` into the benchmark with
 * `--import-live`; `usage-record.json` is the raw numeric record the artifact's
 * `fileDigest`/`fileSizeBytes` describe and stays in private storage.
 *
 * Exit codes:
 *
 *   0 — one complete usage sample captured and published
 *   2 — invalid CLI argument, missing credentials, or unpublishable artifact fields
 *   3 — no trustworthy completed usage observation
 *   4 — unsafe output directory or artifact-write failure
 *   5 — unexpected runtime exception
 *
 * Call stack:
 *
 * main (scripts/memory/capture-brain-usage)
 *   -> {@link captureBrainUsageRecord}
 *     -> GeminiBrainProvider.generate (usage sink installed)
 *   -> {@link summarizeLiveArtifactFile}
 */

import process from 'node:process'

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { BrainUsageCaptureError, captureBrainUsageRecord } from '../../evals/memory/performance/brain-usage-capture'
import { liveArtifactDigest, summarizeLiveArtifactFile } from '../../evals/memory/performance/live-artifact'
import { config } from '../../src/config'
import { GeminiBrainProvider } from '../../src/providers/brain/gemini'
import { assertSafeOutputDirectory, gitTopLevel } from './output-safety'

const EXIT = { COMPLETE: 0, INVALID: 2, NO_EVIDENCE: 3, UNSAFE: 4, UNEXPECTED: 5 } as const

/** The importable summary; also the marker that makes a rerun's directory safe to reuse. */
const ARTIFACT_FILE = 'live-artifact.json'
/** The raw numeric record the artifact's file digest and size describe. */
const RAW_RECORD_FILE = 'usage-record.json'

interface ParsedArgs {
  help: boolean
  output?: string
  sampleId: string
  hostProvenance?: string
  configProvenance?: string
}

const HELP_TEXT = `Usage: memory:capture-brain-usage [options]

Captures one numeric Gemini usage sample and writes an importable
brain-usage-sample live artifact. This command makes a real, billable provider
call; the deterministic memory:benchmark never does.

Options:
  --output <directory>           Absolute private directory outside the checkout (required)
  --sample-id <id>               Content-free sample id (default: brain-usage-001)
  --host-provenance <text>       Content-free host provenance (required)
  --config-provenance <text>     Content-free config provenance (required)
  --help                         Show this help

Writes ${RAW_RECORD_FILE} (raw numeric record) and ${ARTIFACT_FILE} (importable
summary). Import the summary with:

  memory:benchmark --price-document <approved.json> --import-live <${ARTIFACT_FILE}>

Calculated cost is an estimate from observed usage and an approved price
document; it is not verified billing truth, and a locally mocked capture is not
G8 release evidence.

Exit codes:
  0  one complete usage sample captured and published
  2  invalid CLI argument, missing credentials, or unpublishable artifact fields
  3  no trustworthy completed usage observation
  4  unsafe output directory or artifact-write failure
  5  unexpected runtime exception
`

async function main(): Promise<void> {
  let parsed: ParsedArgs
  try {
    parsed = parseArgs(process.argv.slice(2))
  }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }
  if (parsed.help) {
    process.stdout.write(HELP_TEXT)
    return
  }

  if (!parsed.output || !parsed.hostProvenance || !parsed.configProvenance) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: '--output, --host-provenance, and --config-provenance are required' })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }

  const workspaceRoot = resolve(import.meta.dirname, '../..')
  const gitRoot = gitTopLevel(workspaceRoot)
  if (!gitRoot) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'failed to resolve Git top-level directory' })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }

  const outputDirectory = resolve(parsed.output)
  const pathCheck = assertSafeOutputDirectory(outputDirectory, gitRoot, ARTIFACT_FILE)
  if (pathCheck.error) {
    const isUnsafe = pathCheck.kind === 'unsafe'
    process.stderr.write(`${JSON.stringify({ status: isUnsafe ? 'unsafe' : 'invalid', message: pathCheck.error })}\n`)
    process.exitCode = isUnsafe ? EXIT.UNSAFE : EXIT.INVALID
    return
  }

  // Fail before the paid call rather than after it: a capture with no key would
  // otherwise spend the operator's setup on a request that cannot start.
  if (!config().brain.apiKey) {
    process.stderr.write(`${JSON.stringify({ status: 'invalid', message: 'GEMINI_API_KEY is not set; a real capture requires operator credentials' })}\n`)
    process.exitCode = EXIT.INVALID
    return
  }

  const correlationId = `usage-probe-${parsed.sampleId}`
  const controller = new AbortController()

  try {
    const usage = await captureBrainUsageRecord({
      createProvider: usageSink => new GeminiBrainProvider({ usageSink }),
      correlationId,
      signal: controller.signal,
    })

    mkdirSync(outputDirectory, { recursive: true })
    const rawTempPath = join(outputDirectory, `.${RAW_RECORD_FILE}.tmp`)
    writeFileSync(rawTempPath, `${JSON.stringify(usage, null, 2)}\n`)

    let artifact
    try {
      // Summarized from the bytes about to be published, so the digest and size
      // describe exactly the file the operator keeps.
      artifact = await summarizeLiveArtifactFile({
        path: rawTempPath,
        kind: 'brain-usage-sample',
        sampleId: parsed.sampleId,
        hostProvenance: parsed.hostProvenance,
        configProvenance: parsed.configProvenance,
        observedAt: usage.observedAt,
        usage,
      })
    }
    catch (error) {
      // Nothing is left behind when the operator's provenance strings would
      // make the artifact unpublishable.
      rmSync(rawTempPath, { force: true })
      process.stderr.write(`${JSON.stringify({ status: 'invalid', message: messageOf(error) })}\n`)
      process.exitCode = EXIT.INVALID
      return
    }

    const artifactTempPath = join(outputDirectory, `.${ARTIFACT_FILE}.tmp`)
    writeFileSync(artifactTempPath, `${JSON.stringify(artifact, null, 2)}\n`)
    renameSync(rawTempPath, join(outputDirectory, RAW_RECORD_FILE))
    renameSync(artifactTempPath, join(outputDirectory, ARTIFACT_FILE))

    process.stdout.write(`${JSON.stringify({
      status: 'complete',
      output: outputDirectory,
      sampleId: artifact.sampleId,
      correlationId,
      provider: usage.provider,
      model: usage.model,
      disposition: usage.disposition,
      liveArtifactDigest: liveArtifactDigest(artifact),
      importedAs: ARTIFACT_FILE,
    }, null, 2)}\n`)
  }
  catch (error) {
    if (error instanceof BrainUsageCaptureError) {
      process.stderr.write(`${JSON.stringify({ status: 'no-evidence', reason: error.reason, generationFailed: error.generationFailed })}\n`)
      process.exitCode = EXIT.NO_EVIDENCE
      return
    }
    process.stderr.write(`${JSON.stringify({ status: 'error', message: messageOf(error) })}\n`)
    process.exitCode = EXIT.UNEXPECTED
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, sampleId: 'brain-usage-001' }
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index]!
    if (value === '--') {
      continue
    }
    else if (value === '--help' || value === '-h') {
      result.help = true
    }
    else if (value === '--output') {
      result.output = argv[++index]
      if (!result.output)
        throw new Error('--output requires a directory argument')
    }
    else if (value === '--sample-id') {
      const next = argv[++index]
      if (!next)
        throw new Error('--sample-id requires an argument')
      result.sampleId = next
    }
    else if (value === '--host-provenance') {
      result.hostProvenance = argv[++index]
      if (!result.hostProvenance)
        throw new Error('--host-provenance requires an argument')
    }
    else if (value === '--config-provenance') {
      result.configProvenance = argv[++index]
      if (!result.configProvenance)
        throw new Error('--config-provenance requires an argument')
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

await main()
