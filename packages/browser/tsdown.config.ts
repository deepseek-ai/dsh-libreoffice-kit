import { defineConfig } from 'tsdown'

/** The classic worker bundles its protocol and renderer before loading Emscripten. */
export default defineConfig([
  { entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'browser', target: 'es2024', fixedExtension: false, dts: false, clean: false },
  { entry: ['lib/types/worker.js'], outDir: 'lib', format: ['iife'], noExternal: ['@deepseek-ai/libreoffice-kit/font-config', '@deepseek-ai/libreoffice-kit/internal/rendering', '@deepseek-ai/libreoffice-kit/internal/engine-rendering', '@deepseek-ai/libreoffice-kit/internal/sheet-geometry', '@deepseek-ai/libreoffice-kit/document-inspection', 'fflate', 'saxes', 'xmlchars'], outputOptions: { entryFileNames: '[name].js' }, platform: 'browser', target: 'es2024', fixedExtension: false, dts: false, clean: false },
])
