import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'src/**/*.test.ts',
      'evals/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.test.ts',
    ],
    maxWorkers: 4,
  },
})
