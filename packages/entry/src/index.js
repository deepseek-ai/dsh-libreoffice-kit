/** Convert caller-authorized disk documents with installed native or Node WASM engines. */
import { constants } from 'node:fs';
import { open, mkdtemp, mkdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { runNative } from './native.js';
import { resolveOptions } from './options.js';
import { resolveEngine } from './engine.js';
import { ConversionError, failureCode } from './errors.js';
export { ConversionError } from './errors.js';

async function readBounded(path, limit, signal, role) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    const invalid = role === 'input' ? 'invalid-document' : 'invalid-output';
    if (!before.isFile() || before.size < 1) throw new ConversionError(invalid, 'Document must be a nonempty regular file.');
    if (before.size > limit) throw new ConversionError(`${role}-too-large`, `Document exceeds its ${role} byte limit.`);
    const bytes = Buffer.alloc(before.size);
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new ConversionError(invalid, 'Document was truncated while reading.');
      offset += bytesRead;
    }
    const after = await file.stat();
    if (['size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw new ConversionError(invalid, 'Document changed while reading.');
    signal.throwIfAborted();
    return bytes;
  } finally { await file.close(); }
}

async function runWorker(data, signal, onFonts) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: data, name: 'libreoffice-conversion', execArgv: [], stdout: true, stderr: true });
  // Emscripten pthread diagnostics must not enter the embedding application's stdout protocol.
  worker.stdout.resume();
  worker.stderr.resume();
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.once('error', reject);
      worker.once('exit', code => reject(new ConversionError('failed', `LibreOffice worker exited before returning a result (${code}).`)));
      worker.on('message', message => {
        if (message.kind === 'fonts') onFonts(message.faces);
        else if (message.ok) resolve(message);
        else reject(new ConversionError(failureCode(message), message.error));
      });
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

/**
 * Resolve the installed engine and deployment limits without starting LibreOffice.
 * @param {import('./index.js').ConverterOptions} [options] Conversion, font, and optional GPU limits.
 * @returns {Promise<import('./index.js').Converter>} A serial converter; dispose it after use.
 * @throws If configuration or an installed engine package is invalid. Only absent platform packages select WASM.
 */
export async function createConverter(options) {
  const resolvedOptions = resolveOptions(options);
  let engine;
  try { engine = await resolveEngine(); } catch (cause) { throw new ConversionError('unavailable', cause.message, { cause }); }
  const lifetime = new AbortController();
  const active = new Set();
  const waiting = new Set();
  let running = false;
  let disposal;
  let fontFaces;
  async function acquire(signal) {
    while (running) {
      signal.throwIfAborted();
      await new Promise((resolve, reject) => {
        const cleanup = () => { waiting.delete(wake); signal.removeEventListener('abort', abort); };
        const wake = () => { cleanup(); resolve(); };
        const abort = () => { cleanup(); reject(signal.reason); };
        waiting.add(wake);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    signal.throwIfAborted();
    running = true;
  }
  async function render(request, signal) {
    if (!request || typeof request.inputPath !== 'string' || typeof request.outputPath !== 'string'
      || !isAbsolute(request.inputPath) || !isAbsolute(request.outputPath) || request.inputPath.includes('\0') || request.outputPath.includes('\0')) throw new TypeError('inputPath and outputPath must be absolute filesystem paths.');
    if (resolve(request.inputPath) === resolve(request.outputPath)) throw new Error('Input and output paths must differ.');
    const extension = extname(request.inputPath).slice(1).toLowerCase();
    if (!['docx', 'xlsx', 'pptx'].includes(extension)) throw new ConversionError('unsupported-format', 'Input extension must be docx, xlsx, or pptx.');
    await acquire(signal);
    const deadline = new AbortController();
    const stopped = AbortSignal.any([signal, deadline.signal]);
    const timer = setTimeout(() => deadline.abort(new ConversionError('timeout', 'LibreOffice conversion timed out.')), resolvedOptions.timeoutMs);
    let scratch;
    let output;
    let succeeded = false;
    let failure;
    try {
      stopped.throwIfAborted();
      output = await open(request.outputPath, 'wx', 0o600);
      const bytes = await readBounded(request.inputPath, resolvedOptions.maxInputBytes, stopped, 'input');
      scratch = await mkdtemp(join(tmpdir(), 'libreoffice-kit-'));
      const inputPath = join(scratch, `document.${extension}`);
      const input = await open(inputPath, 'wx', 0o600);
      try { await input.writeFile(bytes); } finally { await input.close(); }
      const result = await runWorker({ inputPath, extension, options: resolvedOptions, engine, scratch, fontFaces }, stopped, faces => { fontFaces = faces; });
      let pdf;
      if (engine.backend === 'native') {
        const profile = join(scratch, 'profile');
        await mkdir(profile, { mode: 0o700 });
        const path = join(scratch, 'document.pdf');
        await runNative(engine, resolvedOptions, inputPath, path, profile, result.fonts, stopped);
        pdf = await readBounded(path, resolvedOptions.maxOutputBytes, stopped, 'output');
      } else pdf = result.pdf;
      if (pdf?.length > resolvedOptions.maxOutputBytes) throw new ConversionError('output-too-large', 'LibreOffice PDF exceeds its output byte limit.');
      if (!pdf || Buffer.from(pdf.subarray(0, 5)).toString() !== '%PDF-') throw new ConversionError('invalid-output', 'LibreOffice did not produce a PDF.');
      stopped.throwIfAborted();
      await output.writeFile(pdf);
      stopped.throwIfAborted();
      succeeded = true;
      return { backend: engine.backend, missingFonts: result.missingFonts,
        imageScaling: result.imageScaling ?? { backend: 'native', attempted: 0, accelerated: 0, declined: 0, failed: 0 } };
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      clearTimeout(timer);
      try {
        const errors = [];
        try { await output?.close(); } catch (error) { errors.push(error); }
        const cleanup = await Promise.allSettled([
          ...(output && !succeeded ? [unlink(request.outputPath)] : []),
          ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
        ]);
        for (const result of cleanup) if (result.status === 'rejected') errors.push(result.reason);
        if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'LibreOffice conversion cleanup failed.');
      } finally {
        running = false;
        for (const wake of [...waiting]) wake();
      }
    }
  }
  return {
    backend: engine.backend,
    render(request, signal) {
      const task = render(request, signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal);
      active.add(task);
      void task.finally(() => active.delete(task)).catch(() => {});
      return task;
    },
    dispose() {
      disposal ??= (async () => { lifetime.abort(new Error('LibreOffice converter is disposed.')); await Promise.allSettled(active); })();
      return disposal;
    },
  };
}
