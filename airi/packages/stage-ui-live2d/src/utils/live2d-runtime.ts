import type * as Live2DDisplay from 'pixi-live2d-display'

declare const __AIRI_CUBISM2_CORE_URL__: string | null

declare global {
  interface Window {
    Live2D?: unknown
  }
}

export type Live2DRuntime = typeof Live2DDisplay

let runtimePromise: Promise<Live2DRuntime> | undefined
let coreScriptPromise: Promise<void> | undefined

function loadCubism2Core(url: string): Promise<void> {
  if (window.Live2D)
    return Promise.resolve()

  coreScriptPromise ??= new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.addEventListener('load', () => {
      if (!window.Live2D) {
        reject(new Error('The configured Cubism 2 core loaded without exposing window.Live2D.'))
        return
      }

      resolve()
    }, { once: true })
    script.addEventListener('error', () => reject(new Error(`Failed to load the configured Cubism 2 core from "${url}".`)), { once: true })
    document.head.appendChild(script)
  })

  return coreScriptPromise
}

/**
 * Loads the one pixi-live2d-display bundle used for the application lifetime.
 *
 * The combined bundle must only be evaluated after the proprietary Cubism 2
 * core has created `window.Live2D`. Builds without that core retain the
 * existing Cubism 3+ bundle and reject Cubism 2 models during validation.
 */
export function loadLive2DRuntime(): Promise<Live2DRuntime> {
  runtimePromise ??= (async () => {
    const cubism2CoreUrl = typeof __AIRI_CUBISM2_CORE_URL__ === 'string'
      ? __AIRI_CUBISM2_CORE_URL__
      : null

    const runtime = cubism2CoreUrl
      ? await loadCubism2Core(cubism2CoreUrl).then(() => import('pixi-live2d-display'))
      : await import('pixi-live2d-display/cubism4')

    const { configureLive2DLoaders } = await import('./live2d-zip-loader')
    configureLive2DLoaders(runtime)

    const { registerLive2DOpfs } = await import('./live2d-opfs-registration')
    registerLive2DOpfs(runtime)

    return runtime
  })()

  return runtimePromise
}

export function isCubism2RuntimeConfigured(): boolean {
  return typeof __AIRI_CUBISM2_CORE_URL__ === 'string'
    && __AIRI_CUBISM2_CORE_URL__.length > 0
}
