/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DISCORD_CLIENT_ID?: string
  readonly VITE_LIVE2D_MODEL_ID?: string
  readonly VITE_LIVE2D_MODEL_URL?: string
  readonly VITE_AVATAR_RELAY_HTTP_URL?: string
  readonly VITE_AVATAR_RELAY_WS_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// TypeScript's DOM library currently exposes OPFS handles without their
// async-iterator alias, which AIRI's cache implementation uses.
type FileSystemDirectoryHandleAsyncIterator<T> = AsyncIterableIterator<T>
