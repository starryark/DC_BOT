import type { JSONObject, ModelSettings } from 'pixi-live2d-display'

import type { Live2DRuntime } from './live2d-runtime'

import JSZip from 'jszip'

import { decodeZipFileName } from './decode-zip-filename'

let configuredRuntime: Live2DRuntime | undefined

function shouldIgnoreLive2DArchiveEntry(filePath: string): boolean {
  return filePath
    .split('/')
    .some(segment => segment === '__MACOSX' || segment.startsWith('._'))
}

export function isSettingsFile(file: string): boolean {
  return !shouldIgnoreLive2DArchiveEntry(file)
    && !file.endsWith('items_pinned_to_model.json')
    && (file.endsWith('.model3.json') || file.endsWith('model.json'))
}

export function isMocFile(file: string): boolean {
  return file.endsWith('.moc3') || file.endsWith('.moc')
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop()!
}

/**
 * Normalizes nullable Cubism 3+ references before upstream path resolution.
 *
 * Before:
 * - `{ "FileReferences": { "Physics": null } }`
 *
 * After:
 * - `{ "FileReferences": {} }`
 */
function sanitizeModelSettingsText(text: string): string {
  const json = JSON.parse(text) as Record<string, unknown>
  const refs = json.FileReferences

  if (refs && typeof refs === 'object') {
    const fileReferences = refs as Record<string, unknown>
    for (const key of ['Physics', 'Pose', 'DisplayInfo']) {
      if (fileReferences[key] === null)
        delete fileReferences[key]
    }
  }

  return JSON.stringify(json)
}

function createModelSettings(text: string, url: string): ModelSettings {
  if (!configuredRuntime)
    throw new Error('Live2D runtime has not been configured.')
  if (!text)
    throw new Error(`Empty settings file: ${url}`)

  const settingsJSON = JSON.parse(text) as JSONObject & { url?: string }
  settingsJSON.url = url
  const runtime = configuredRuntime.Live2DFactory.findRuntime(settingsJSON)
  if (!runtime)
    throw new Error('Unknown Live2D settings JSON.')

  return runtime.createModelSettings(settingsJSON)
}

async function collectMetadata(reader: JSZip, settings: ModelSettings, filePaths: string[]) {
  const metadataSettings = settings as ModelSettings & {
    _cdiData?: unknown
    _expFiles?: Array<{ name: string, fileName: string, data: unknown }>
  }
  const expressionPaths = filePaths.filter(file =>
    file.toLowerCase().endsWith('.exp3.json')
    || file.toLowerCase().endsWith('.exp.json'),
  )

  const cdiPath = filePaths.find(file => file.toLowerCase().endsWith('.cdi3.json'))
  if (cdiPath)
    metadataSettings._cdiData = JSON.parse(await reader.file(cdiPath)!.async('text'))

  metadataSettings._expFiles = await Promise.all(expressionPaths.map(async fileName => ({
    name: basename(fileName).replace(/\.exp3?\.json$/i, ''),
    fileName,
    data: JSON.parse(await reader.file(fileName)!.async('text')),
  })))
}

/**
 * Installs AIRI's ZIP and directory policies on the selected runtime exactly once.
 */
export function configureLive2DLoaders(runtime: Live2DRuntime): void {
  if (configuredRuntime === runtime)
    return
  configuredRuntime = runtime

  const { FileLoader, ZipLoader } = runtime
  ZipLoader.zipReader = (data: Blob) => JSZip.loadAsync(data, { decodeFileName: decodeZipFileName })

  ZipLoader.createSettings = async (reader: JSZip) => {
    const filePaths = Object.keys(reader.files)
    const settingsPath = filePaths.find(isSettingsFile)
    if (!settingsPath)
      throw new Error('A Live2D .model.json or .model3.json entry point is required.')

    const settings = createModelSettings(
      sanitizeModelSettingsText(await reader.file(settingsPath)!.async('text')),
      settingsPath,
    )
    await collectMetadata(reader, settings, filePaths)
    return settings
  }

  ZipLoader.readText = async (reader: JSZip, path: string) => {
    const file = reader.file(path)
    if (!file)
      throw new Error(`Cannot find file: ${path}`)
    const text = await file.async('text')
    return isSettingsFile(path) ? sanitizeModelSettingsText(text) : text
  }

  ZipLoader.getFilePaths = async (reader: JSZip) => {
    const paths: string[] = []
    reader.forEach((relativePath, file) => {
      if (!file.dir && !shouldIgnoreLive2DArchiveEntry(relativePath))
        paths.push(relativePath)
    })
    return paths
  }

  ZipLoader.getFiles = (reader: JSZip, paths: string[]) =>
    Promise.all(paths.map(async (path) => {
      const file = new File([await reader.file(path)!.async('blob')], basename(path))
      Object.defineProperty(file, 'webkitRelativePath', { value: path })
      return file
    }))

  const defaultReadText = FileLoader.readText
  FileLoader.createSettings = async (files: File[]) => {
    const settingsFile = files.find(file => isSettingsFile(file.webkitRelativePath || file.name))
    if (!settingsFile)
      throw new TypeError('A Live2D .model.json or .model3.json entry point is required.')
    const settingsUrl = settingsFile.webkitRelativePath || settingsFile.name
    const settings = createModelSettings(await FileLoader.readText(settingsFile), settingsUrl)
    Object.assign(settings, { _objectURL: URL.createObjectURL(settingsFile) })
    return settings
  }
  FileLoader.readText = async (file: File) => {
    const text = await defaultReadText(file)
    return isSettingsFile(file.webkitRelativePath || file.name)
      ? sanitizeModelSettingsText(text)
      : text
  }
}
