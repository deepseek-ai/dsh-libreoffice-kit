import { defineConfig } from 'tsdown'

/** Independent ESM bundles keep the public CLI and private Worker beside the adapter. */
export default defineConfig(['index', 'cli', 'worker', 'font-source', 'font-worker', 'font-config', 'document', 'rendering', 'engine-rendering', 'sheet-geometry'].map(entry => ({
  entry: [`lib/types/${entry}.js`],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})))
