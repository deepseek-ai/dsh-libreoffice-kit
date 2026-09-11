/** Node-only LibreOffice module execution; the owner terminates this worker on cancellation. */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createImageScaler } from './gpu/index.mjs';
import { createFontLoader, memoryFontConfig, preloadFonts } from './font-loader.js';
import { ConversionError } from './errors.js';

const require = createRequire(import.meta.url);
function engineError(module, office) {
  const pointer = module.ccall('dsh_lok_error', 'number', ['number'], [office]);
  if (!pointer) return new Error('LibreOffice WASM could not convert the document.');
  try { return new Error(module.UTF8ToString(pointer)); } finally { module.ccall('free', null, ['number'], [pointer]); }
}

/** Convert bounded source bytes; return owned PDF bytes only after engine teardown. */
export async function convertWithWasm({ engine, bytes, extension, options, document: metadata, faces }) {
  const factory = require(engine.loader);
  const raw = readFileSync(engine.data);
  const data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const scaler = await createImageScaler({ maxGpuBytes: options.maxGpuBytes, timeoutMs: options.gpuTimeoutMs,
    initializationTimeoutMs: options.gpuInitializationTimeoutMs, mode: options.gpu });
  let module;
  let office = 0;
  let document = 0;
  let fontLoader;
  let fatal = false;
  let failure;
  try {
    module = await factory({
      noInitialRun: true,
      mainScriptUrlOrBlob: engine.loader,
      locateFile(name) {
        const file = basename(name);
        if (![engine.loader, engine.data, engine.wasm, engine.metadata].some(path => basename(path) === file)) throw new Error(`LibreOffice requested an unlisted asset: ${file}`);
        return join(dirname(engine.loader), file);
      },
      getPreloadedPackage: () => data,
      dshMaxGpuBytes: options.maxGpuBytes,
      dshScaleImage: scaler.scaleImage,
      dshResolveSystemFonts(request) {
        if (!fontLoader) throw new Error('LibreOffice requested fonts before initializing MEMFS.');
        return fontLoader.resolve(request);
      },
      preRun: [module => {
        for (const path of ['/dsh/profile', '/dsh/font-cache', '/dsh-fonts']) module.FS.mkdirTree(path);
        module.FS.writeFile('/dsh/fonts.conf', new TextEncoder().encode(memoryFontConfig(options.fontFallbacks)));
        Object.assign(module.ENV, { HOME: '/dsh/profile', TMPDIR: '/tmp', FONTCONFIG_FILE: '/dsh/fonts.conf', LOK_HOST_ALLOWLIST: '^$' });
        fontLoader = createFontLoader(options, metadata, (name, bytes) => {
          const path = `/dsh-fonts/${name}`;
          module.FS.writeFile(path, bytes);
          return path;
        }, faces);
        preloadFonts(fontLoader, options, metadata);
      }],
      onAbort() { fatal = true; },
      print() {}, printErr() {},
    });
    const input = `/dsh/document.${extension}`;
    const output = '/dsh/document.pdf';
    module.FS.writeFile(input, bytes);
    office = module.ccall('dsh_lok_initialize', 'number', ['string', 'string'], [engine.programDirectory, 'file:///dsh/profile']);
    if (!office) throw engineError(module, 0);
    document = module.ccall('dsh_lok_document_load', 'number', ['number', 'string', 'string'], [office, `file://${input}`, 'Batch=true,EnableMacrosExecution=false']);
    if (!document) throw engineError(module, office);
    const succeeded = module.ccall('dsh_lok_document_save_pdf', 'number', ['number', 'string', 'string'], [document, `file://${output}`, JSON.stringify({
      ExportBookmarks: { type: 'boolean', value: 'true' }, ReduceImageResolution: { type: 'boolean', value: 'true' },
      MaxImageResolution: { type: 'long', value: String(options.maxImageResolution) },
    })]);
    if (!succeeded) throw engineError(module, office);
    if (!module.FS.analyzePath(output).exists) throw new ConversionError('invalid-output', 'LibreOffice did not create its PDF output.');
    const status = module.FS.stat(output);
    if (!module.FS.isFile(status.mode)) throw new ConversionError('invalid-output', 'Generated PDF is not a regular file.');
    if (status.size > options.maxOutputBytes) throw new ConversionError('output-too-large', 'Generated PDF exceeds its output byte limit.');
    const pdf = module.FS.readFile(output);
    if (new TextDecoder().decode(pdf.subarray(0, 5)) !== '%PDF-') throw new ConversionError('invalid-output', 'LibreOffice did not produce a PDF.');
    return { pdf, missingFonts: fontLoader.missingFonts,
      imageScaling: { backend: scaler.backend, reason: scaler.reason, adapter: scaler.adapter, ...scaler.stats } };
  } catch (error) {
    fatal ||= error instanceof WebAssembly.RuntimeError;
    failure = error;
    throw error;
  } finally {
    const errors = [];
    if (module && !fatal) {
      if (document) try { if (!module.ccall('dsh_lok_document_destroy', 'number', ['number'], [document])) throw engineError(module, office); } catch (error) { errors.push(error); fatal ||= error instanceof WebAssembly.RuntimeError; }
      if (office && !fatal) try { if (!module.ccall('dsh_lok_destroy', 'number', ['number'], [office])) throw engineError(module, 0); } catch (error) { errors.push(error); }
    }
    if (module) try { module.PThread.terminateAllThreads(); } catch (error) { errors.push(error); }
    try { await scaler.dispose(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'LibreOffice WASM cleanup failed.');
  }
}
