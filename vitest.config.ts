import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/entry/tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: { provider: 'v8', include: ['packages/entry/src/**/*.ts'],
      // Converter tests run worker.ts in a real child thread, outside this V8 coverage isolate.
      exclude: ['packages/entry/src/worker.ts'], thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 } },
  },
})
