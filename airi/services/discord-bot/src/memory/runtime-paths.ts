import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

export interface MemoryRuntimePaths {
  root: string
  authorityDirectory: string
  authority: string
  backups: string
  spool: string
  reports: string
  exports: string
  logs: string
  roomBindings: string
}

/** Resolves the complete local layout once and rejects ambiguous runtime roots. */
export function resolveMemoryRuntimePaths(repoRoot: string, configuredRoot: string | undefined): MemoryRuntimePaths {
  const resolvedRepo = resolve(repoRoot)
  const root = configuredRoot?.trim()
    ? resolveExplicitRoot(configuredRoot.trim())
    : join(resolvedRepo, '.local', 'memory')

  if (root === resolvedRepo || root === parse(root).root)
    throw new Error('Memory runtime root must be a dedicated directory, not a repository or filesystem root')
  if (existsSync(root) && !statSync(root).isDirectory())
    throw new Error('Memory runtime root exists but is not a directory')

  const authorityDirectory = join(root, 'authority')
  return {
    root,
    authorityDirectory,
    authority: join(authorityDirectory, 'memory.sqlite'),
    backups: join(root, 'backups'),
    spool: join(root, 'spool'),
    reports: join(root, 'reports'),
    exports: join(root, 'exports'),
    logs: join(root, 'logs'),
    roomBindings: join(root, 'room-bindings.json'),
  }
}

function resolveExplicitRoot(value: string): string {
  if (!isAbsolute(value))
    throw new Error('MEMORY_RUNTIME_ROOT must be an absolute path')
  return resolve(value)
}
