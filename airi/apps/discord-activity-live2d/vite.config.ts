import Vue from '@vitejs/plugin-vue'

import { DownloadLive2DSDK } from '@proj-airi/unplugin-live2d-sdk/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  // Discord serves Activities below an application-specific URL mapping.
  // Relative asset URLs keep production builds independent of that mapping.
  base: './',
  build: {
    sourcemap: true,
  },
  plugins: [
    Vue(),
    DownloadLive2DSDK(),
  ],
})
