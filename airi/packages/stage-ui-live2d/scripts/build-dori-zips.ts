import type { Cubism2Motions } from '../src/utils/dori-model-json'

import path from 'node:path'

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { argv, exit } from 'node:process'

import JSZip from 'jszip'

import { buildDoriModelJson } from '../src/utils/dori-model-json'
import { validateLive2DZip } from '../src/utils/live2d-validator'

/**
 * Packages a Bestdori Live2D download tree into one AIRI-importable ZIP per model.
 *
 * Usage:
 *   tsx packages/stage-ui-live2d/scripts/build-dori-zips.ts \
 *     --src C:/Users/lyang/DORI_models --out apps/stage-web/public/dori
 *
 * Bestdori models are Cubism 2.1, so the resulting archives only render in a
 * build that supplies the Cubism 2 core (see this package's README). The one
 * validation warning about that is expected here and treated as a pass; anything
 * in `errors` fails the run.
 */

const cubism2RuntimeWarning = 'Cubism 2 runtime is not configured in this build. Set AIRI_CUBISM2_CORE_PATH and AIRI_CUBISM2_CORE_SHA256 when building AIRI.'

/** Bestdori falls back to `chara_<id>` whenever its character API lookup fails. */
const characterDisplayNames: Record<string, string> = {
  anon: 'Anon Chihaya',
  chara_337: 'Uika Misumi',
  chara_338: 'Mutsumi Wakaba',
  chara_339: 'Umiri Yahata',
  chara_340: 'Nyamu Yutenji',
  chara_341: 'Sakiko Togawa',
  rana: 'Rana Kaname',
  soyo: 'Soyo Nagasaki',
  taki: 'Taki Shiina',
  tomori: 'Tomori Takamatsu',
}

const emotionGroupNames = ['Idle', 'Happy', 'Sad', 'Angry', 'Think', 'Surprise', 'Awkward', 'Question', 'Curious']

interface SourceModel {
  /** Directory holding `model.json`, i.e. the base for every relative reference. */
  directory: string
  /** `<character>/<model>` relative to the source root. */
  relativePath: string
  /** ASCII, collision-free archive folder and file stem, e.g. `tomori_live_default`. */
  slug: string
  displayName: string
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    if (!flag.startsWith('--') || args[index + 1] === undefined)
      continue
    parsed[flag.slice(2)] = args[index + 1]
  }
  return parsed
}

async function findModelDirectories(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true })
  if (entries.some(entry => entry.isFile() && entry.name === 'model.json'))
    return [relative]

  const nested = await Promise.all(entries
    .filter(entry => entry.isDirectory())
    .map(entry => findModelDirectories(root, path.join(relative, entry.name))))

  return nested.flat()
}

function describeModel(root: string, relativePath: string): SourceModel {
  const segments = relativePath.split(path.sep)
  const characterDirectory = segments[0]
  const modelDirectory = segments[segments.length - 1]

  return {
    directory: path.join(root, relativePath),
    relativePath: segments.join('/'),
    slug: segments.join('_'),
    displayName: `${characterDisplayNames[characterDirectory] ?? characterDirectory} — ${modelDirectory}`,
  }
}

/** Every path the Cubism 2 manifest points at, deduplicated and in stable order. */
function referencedFiles(modelJson: Record<string, unknown>): string[] {
  const references = new Set<string>()
  for (const key of ['model', 'physics', 'pose']) {
    if (typeof modelJson[key] === 'string')
      references.add(modelJson[key] as string)
  }
  if (Array.isArray(modelJson.textures)) {
    for (const texture of modelJson.textures) {
      if (typeof texture === 'string')
        references.add(texture)
    }
  }
  for (const definitions of Object.values((modelJson.motions ?? {}) as Cubism2Motions)) {
    for (const definition of definitions ?? []) {
      if (typeof definition?.file === 'string')
        references.add(definition.file)
    }
  }
  if (Array.isArray(modelJson.expressions)) {
    for (const expression of modelJson.expressions) {
      if (typeof expression?.file === 'string')
        references.add(expression.file)
    }
  }
  return [...references].sort()
}

async function packageModel(model: SourceModel, outputDirectory: string) {
  const sourceModelJson = JSON.parse(await readFile(path.join(model.directory, 'model.json'), 'utf8')) as Record<string, unknown>
  const builtModelJson = buildDoriModelJson(sourceModelJson, model.displayName)

  const zip = new JSZip()
  zip.file(`${model.slug}/model.json`, JSON.stringify(builtModelJson, null, 2))
  for (const reference of referencedFiles(builtModelJson))
    zip.file(`${model.slug}/${reference}`, await readFile(path.join(model.directory, reference)))

  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const report = await validateLive2DZip(new Blob([new Uint8Array(archive)]))
  const unexpectedWarnings = report.warnings.filter(warning => warning !== cubism2RuntimeWarning)

  const zipFileName = `${model.slug}.zip`
  await writeFile(path.join(outputDirectory, zipFileName), archive)

  const groupNames = Object.keys(builtModelJson.motions as Cubism2Motions)
  return {
    model,
    zipFileName,
    bytes: archive.byteLength,
    entryPoint: report.entryPoint,
    errors: report.errors,
    unexpectedWarnings,
    missingEmotionGroups: emotionGroupNames.filter(group => !groupNames.includes(group)),
  }
}

async function main() {
  const args = parseArgs(argv.slice(2))
  if (!args.src) {
    console.error('Usage: tsx packages/stage-ui-live2d/scripts/build-dori-zips.ts --src <bestdori-tree> [--out apps/stage-web/public/dori]')
    exit(1)
  }

  const sourceRoot = path.resolve(args.src)
  const outputDirectory = path.resolve(args.out ?? 'apps/stage-web/public/dori')
  await mkdir(outputDirectory, { recursive: true })

  const models = (await findModelDirectories(sourceRoot))
    .filter(Boolean)
    .map(relativePath => describeModel(sourceRoot, relativePath))
    .sort((a, b) => a.slug.localeCompare(b.slug))

  console.info(`Found ${models.length} model(s) under ${sourceRoot}`)
  console.info(`Writing to ${outputDirectory}\n`)

  const results = []
  const failures = []
  for (const [index, model] of models.entries()) {
    const result = await packageModel(model, outputDirectory)
    if (result.errors.length > 0 || result.unexpectedWarnings.length > 0) {
      failures.push(result)
      console.error(`  [${index + 1}/${models.length}] FAILED ${model.slug}`)
      result.errors.forEach(error => console.error(`      error:   ${error}`))
      result.unexpectedWarnings.forEach(warning => console.error(`      warning: ${warning}`))
    }
    else {
      results.push(result)
      if ((index + 1) % 10 === 0 || index + 1 === models.length)
        console.info(`  [${index + 1}/${models.length}] ok`)
    }
  }

  const manifest = results.map(result => ({
    id: `dori-${result.model.slug}`,
    name: result.model.displayName,
    url: `/dori/${result.zipFileName}`,
  }))
  await writeFile(path.join(outputDirectory, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  const totalBytes = results.reduce((sum, result) => sum + result.bytes, 0)
  console.info(`\n${results.length}/${models.length} model(s) packaged, ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`)
  console.info(`Preset manifest: ${path.join(outputDirectory, 'index.json')} (${manifest.length} entries)`)

  // Coverage is uneven by design: not every costume has, say, a `mitore` motion,
  // and `mts_`/`maskon_` families are deliberately never aliased. Say so rather
  // than let a partial result read as full coverage.
  const partial = results.filter(result => result.missingEmotionGroups.length > 0)
  if (partial.length === 0) {
    console.info(`All ${results.length} model(s) expose all ${emotionGroupNames.length} emotion motion groups.`)
  }
  else {
    console.info(`\n${partial.length} model(s) expose fewer than ${emotionGroupNames.length} emotion motion groups:`)
    partial.forEach(result => console.info(`  ${result.model.slug} — missing ${result.missingEmotionGroups.join(', ')}`))
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} model(s) failed validation.`)
    exit(1)
  }
}

main().catch((error) => {
  console.error(error)
  exit(1)
})
