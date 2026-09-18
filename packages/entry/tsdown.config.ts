import { defineConfig } from 'tsdown'

/** Independent bundles keep every published entry and worker free of unlisted shared chunks. */
export default defineConfig(['index', 'cli', 'font-source', 'font-config', 'document', 'worker', 'font-worker'].map(name => ({
  entry: [`lib/types/${name}.js`],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})))
