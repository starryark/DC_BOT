import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Output-path safety shared by the memory evidence CLIs.
 *
 * Every command that writes raw or provider-derived material writes it outside
 * the checkout: an absolute directory that is neither the repository nor a
 * symlink back into it, and that is either empty or a directory this same
 * command already initialized. The checks live here rather than in one CLI
 * because `memory:benchmark` and `memory:capture-brain-usage` must not be able
 * to drift into two different definitions of "safe".
 */

/** Whether `target` is the repository root or a path inside it. */
export function insideRepository(gitRoot: string, target: string): boolean {
  const step = relative(resolve(gitRoot), resolve(target))
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

/** The Git top-level directory containing `directory`, or `undefined` when it is not a checkout. */
export function gitTopLevel(directory: string): string | undefined {
  try {
    return execFileSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  }
  catch {
    return undefined
  }
}

/**
 * Refuse an output directory inside the repository or one with unexpected contents.
 *
 * `initializedMarker` is the filename this command writes on a successful run;
 * a nonempty directory is accepted only when it contains that marker, so a
 * rerun overwrites its own previous output and nothing else.
 *
 * A non-absolute or in-checkout path is `unsafe`; a nonempty foreign directory
 * is `unsafe` too, because writing into it would mix evidence sets.
 */
export function assertSafeOutputDirectory(directory: string, gitRoot: string, initializedMarker: string): { error?: string, kind?: 'unsafe' | 'invalid' } {
  if (!isAbsolute(directory))
    return { error: `--output must be an absolute path, got ${directory}`, kind: 'unsafe' }
  if (insideRepository(gitRoot, directory))
    return { error: `--output ${directory} is inside the repository checkout; use a private directory outside it`, kind: 'unsafe' }
  let real
  try {
    real = realpath(directory)
  }
  catch {
    return {}
  }
  if (real !== directory && insideRepository(gitRoot, real))
    return { error: `--output ${directory} resolves inside the repository checkout via symlink`, kind: 'unsafe' }
  if (existsSync(directory) && statSync(directory).isDirectory()) {
    const entries = readdirSync(directory)
    if (entries.length > 0 && !entries.includes(initializedMarker))
      return { error: `--output ${directory} is nonempty and not a previously initialized run directory`, kind: 'unsafe' }
  }
  return {}
}

/**
 * Resolve symlinks in a child process.
 *
 * NOTICE:
 * `fs.realpathSync` would be the direct call, but resolving out-of-process
 * keeps this helper usable from CLIs that must not fail on a host where the
 * path does not exist yet: the spawn throws and the caller treats an
 * unresolvable path as "nothing to check".
 * Removal condition: when every caller creates the directory before checking.
 */
function realpath(path: string): string {
  return execFileSync('node', ['-e', `process.stdout.write(require('fs').realpathSync(${JSON.stringify(path)}))`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}
