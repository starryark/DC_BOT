import type { Plugin } from 'vite'

import process from 'node:process'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Cubism2CoreOptions {
  /** Filesystem path to a maintainer-approved Cubism 2.1 Web core. */
  sourcePath?: string
  /** Lowercase or uppercase hexadecimal SHA-256 of `sourcePath`. */
  sha256?: string
}

/**
 * Serves and emits a verified maintainer-supplied Cubism 2 Web core.
 *
 * The proprietary core is never downloaded or written into tracked source.
 * Omitting both options leaves legacy model support disabled.
 */
export function Cubism2Core(options: Cubism2CoreOptions = {}): Plugin {
  const sourcePath = options.sourcePath ?? process.env.AIRI_CUBISM2_CORE_PATH
  const expectedSha256 = options.sha256 ?? process.env.AIRI_CUBISM2_CORE_SHA256
  const publicPath = '/assets/js/live2d.min.js'
  let source: ReturnType<typeof readFileSync> | undefined

  return {
    name: 'proj-airi:cubism2-core',
    enforce: 'pre',
    config() {
      if (!sourcePath && !expectedSha256) {
        return {
          define: {
            __AIRI_CUBISM2_CORE_URL__: 'null',
          },
        }
      }
      if (!sourcePath || !expectedSha256)
        throw new Error('AIRI_CUBISM2_CORE_PATH and AIRI_CUBISM2_CORE_SHA256 must be configured together.')

      const resolvedPath = resolve(sourcePath)
      source = readFileSync(resolvedPath)
      const actualSha256 = createHash('sha256').update(source).digest('hex')
      if (actualSha256 !== expectedSha256.toLowerCase()) {
        throw new Error(`Cubism 2 core checksum mismatch for "${resolvedPath}". Expected ${expectedSha256}, received ${actualSha256}.`)
      }

      return {
        define: {
          __AIRI_CUBISM2_CORE_URL__: JSON.stringify(publicPath),
        },
      }
    },
    configureServer(server) {
      if (!source)
        return
      server.middlewares.use(publicPath, (_request, response) => {
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        response.end(source)
      })
    },
    buildStart() {
      if (source) {
        this.emitFile({
          type: 'asset',
          fileName: 'assets/js/live2d.min.js',
          source,
        })
      }
    },
  }
}
