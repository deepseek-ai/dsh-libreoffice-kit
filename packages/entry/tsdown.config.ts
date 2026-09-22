import { defineConfig } from 'tsdown'

/** Independent ESM bundles keep every published entry and Worker free of shared chunks. */
export default defineConfig(['index', 'cli', 'worker'].map(name => ({
    entry: [`lib/types/${name}.js`],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  })))
