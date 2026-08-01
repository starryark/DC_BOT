import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { arch, argv, env, platform, stdout } from 'node:process'

interface Measurement {
  kind: 'tts' | 'asr'
  label: string
  firstByteMs: number
  totalMs: number
  bytes: number
  streamingMode?: number
  targetChars?: number
  prefetch?: number
  cache?: 'cold' | 'warm'
  language?: string
}

/**
 * Runs the reproducible network portion of the Wave 4 voice benchmark and
 * writes machine-readable results. Audio quality remains an operator score in
 * the adjacent runbook because it cannot be inferred from latency.
 *
 * Call stack:
 *
 * main
 *   -> runTtsMatrix / runAsrSamples
 *     -> measureResponse
 *       -> writeFile
 */
async function main(): Promise<void> {
  const args = parseArgs(argv.slice(2))
  const output = resolve(args.output ?? 'benchmarks/voice/latest.json')
  const results: Measurement[] = []

  if (args.tts !== 'false')
    results.push(...await runTtsMatrix(args))
  if (args.asr)
    results.push(...await runAsrSamples(args.asr, args))

  const report = {
    capturedAt: new Date().toISOString(),
    hardware: hardwareSnapshot(),
    configuration: {
      asrUrl: args.asrUrl ?? env.ASR_BASE_URL ?? 'http://127.0.0.1:8765',
      ttsUrl: args.ttsUrl ?? env.GPT_SOVITS_URL ?? 'http://127.0.0.1:9880',
      asrModel: args.asrModel ?? 'operator-supplied',
      asrDtype: args.asrDtype ?? 'operator-supplied',
    },
    results,
    subjectiveAudioQuality: 'pending operator review',
  }
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  stdout.write(`Wrote ${results.length} measurements to ${output}\n`)
}

async function runTtsMatrix(args: Record<string, string>): Promise<Measurement[]> {
  const baseUrl = (args.ttsUrl ?? env.GPT_SOVITS_URL ?? 'http://127.0.0.1:9880').replace(/\/$/, '')
  const refAudioPath = env.GPT_SOVITS_REF_AUDIO
  if (!refAudioPath)
    throw new Error('GPT_SOVITS_REF_AUDIO is required for the TTS benchmark')
  const measurements: Measurement[] = []
  const targets = [{ language: 'en', sizes: [40, 75, 100] }, { language: 'ja', sizes: [14, 28, 45] }]
  for (const streamingMode of [0, 2, 3]) {
    for (const target of targets) {
      for (const targetChars of target.sizes) {
        for (const prefetch of [0, 1]) {
          for (const cache of ['cold', 'warm'] as const) {
            const text = sampleText(target.language, targetChars)
            const body = {
              text,
              text_lang: target.language,
              ref_audio_path: refAudioPath,
              prompt_text: env.GPT_SOVITS_PROMPT_TEXT ?? '',
              prompt_lang: env.GPT_SOVITS_PROMPT_LANG ?? 'ja',
              media_type: 'wav',
              streaming_mode: streamingMode,
              text_split_method: 'cut5',
            }
            // A repeated request is the warm-cache observation. Cache clearing
            // is intentionally operator-controlled to avoid destructive IO.
            if (cache === 'warm')
              await measureResponse(`${baseUrl}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            const measured = await measureResponse(`${baseUrl}/tts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            measurements.push({ kind: 'tts', label: `${target.language}-${targetChars}`, ...measured, streamingMode, targetChars, prefetch, cache, language: target.language })
          }
        }
      }
    }
  }
  return measurements
}

async function runAsrSamples(list: string, args: Record<string, string>): Promise<Measurement[]> {
  const baseUrl = (args.asrUrl ?? env.ASR_BASE_URL ?? 'http://127.0.0.1:8765').replace(/\/$/, '')
  const measurements: Measurement[] = []
  for (const file of list.split(',').map(v => v.trim()).filter(Boolean)) {
    const wav = await readFile(resolve(file))
    const measured = await measureResponse(`${baseUrl}/v1/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    })
    measurements.push({ kind: 'asr', label: file, ...measured })
  }
  return measurements
}

async function measureResponse(url: string, init: RequestInit): Promise<{ firstByteMs: number, totalMs: number, bytes: number }> {
  const started = performance.now()
  const response = await fetch(url, init)
  if (!response.ok || !response.body)
    throw new Error(`${url} returned HTTP ${response.status}: ${await response.text()}`)
  const reader = response.body.getReader()
  let firstByteMs = 0
  let bytes = 0
  while (true) {
    const chunk = await reader.read()
    if (chunk.done)
      break
    if (bytes === 0)
      firstByteMs = performance.now() - started
    bytes += chunk.value.byteLength
  }
  return { firstByteMs, totalMs: performance.now() - started, bytes }
}

function sampleText(language: string, targetChars: number): string {
  const seed = language === 'en' ? 'The experiment is proceeding normally. ' : '実験は順調に進んでいるわ。'
  return seed.repeat(Math.ceil(targetChars / seed.length)).slice(0, targetChars)
}

function hardwareSnapshot(): { platform: string, cpu: string, gpu: string } {
  let gpu = 'nvidia-smi unavailable'
  try {
    gpu = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.used', '--format=csv,noheader'], { encoding: 'utf8' }).trim()
  }
  catch { /* The report remains useful on CPU-only hosts. */ }
  return { platform: `${platform} ${arch}`, cpu: env.PROCESSOR_IDENTIFIER ?? 'unknown', gpu }
}

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < values.length; i++) {
    const key = values[i]
    if (!key.startsWith('--'))
      continue
    const next = values[i + 1]
    result[key.slice(2)] = next && !next.startsWith('--') ? values[++i] : 'true'
  }
  return result
}

await main()
