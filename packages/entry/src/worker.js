/** Cancellable CPU work and WASM conversion run outside the Node event loop. */
import { parentPort, workerData } from 'node:worker_threads';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectDocument } from './ooxml.js';
import { createFontLoader, preloadFonts } from './font-loader.js';
import { indexSystemFonts } from './fonts.js';
import { convertWithWasm } from './wasm.js';

try {
  const { inputPath, extension, options, engine, scratch } = workerData;
  const bytes = readFileSync(inputPath);
  const document = inspectDocument(bytes, extension, options);
  const faces = workerData.fontFaces ?? indexSystemFonts({ directories: options.fontDirectories, maxFiles: options.maxFontFiles, maxFileBytes: options.maxFontFileBytes });
  if (!workerData.fontFaces) parentPort.postMessage({ kind: 'fonts', faces });
  if (engine.backend === 'wasm') {
    const result = await convertWithWasm({ engine, bytes, extension, options, document, faces });
    parentPort.postMessage({ ok: true, ...result }, [result.pdf.buffer]);
  } else {
    const directory = join(scratch, 'fonts');
    mkdirSync(directory, { mode: 0o700 });
    const fonts = createFontLoader(options, document, (name, data) => {
      const path = join(directory, name);
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
      return path;
    }, faces);
    preloadFonts(fonts, options, document, true);
    parentPort.postMessage({ ok: true, fonts: fonts.files, missingFonts: fonts.missingFonts });
  }
} catch (error) {
  parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error), stack: error?.stack });
}
