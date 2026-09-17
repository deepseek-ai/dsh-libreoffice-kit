import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/entry/tests/**/*.spec.ts', 'packages/browser/tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: { provider: 'v8', include: ['packages/entry/src/**/*.ts', 'packages/browser/src/**/*.ts'],
      // Worker entries run in real Node/Chromium threads; packed browser qualification covers the browser engine.
      exclude: ['packages/entry/src/worker.ts', 'packages/browser/src/worker.ts'], thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 } },
  },
})
