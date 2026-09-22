import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/entry/tests/**/*.spec.ts'],
    pool: 'forks',
    coverage: { provider: 'v8', include: ['packages/entry/src/**/*.ts'],
      // Worker entry and the native raster child-process owner settle in separate processes;
      // installed-engine qualification covers their full transport and teardown paths.
      exclude: ['packages/entry/src/worker.ts', 'packages/entry/src/native-image-renderer.ts'],
      thresholds: { perFile: true, lines: 100, functions: 100, branches: 100, statements: 100 } },
  },
})
