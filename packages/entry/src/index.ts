/** Convert caller-authorized disk documents with installed native or Node WASM engines. */
import { constants } from 'node:fs'
import { open, mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { resolveImageRender } from './image-operations.ts'
import type { ImageRenderSpec, RenderImagesRequest, RenderImagesResult } from './image-operations.ts'
export { IMAGE_FORMATS } from './image-operations.ts'
export type { RenderImagesRequest, RenderImagesResult, RenderedImage } from './image-operations.ts'
import { runNative } from './native.ts'
import { resolveOptions } from './options.ts'
import { resolveEngine } from './engine.ts'
import { ConversionError, failureCode } from './errors.ts'
import { resolveConversion, validateOutput } from './operations.ts'
import type { ConversionRequest, ConversionSpec } from './operations.ts'
export { CONVERSION_FORMATS } from './operations.ts'
export type { ConversionRequest } from './operations.ts'
export { discoverRuntime } from './runtime.ts'
export type { RuntimeInfo } from './runtime.ts'
import type { Engine, NativeEngine } from './engine.ts'
import type { FontFace } from './fonts.ts'
import type { FontSubstitution } from './font-loader.ts'
import type { WorkerRequest } from './worker.ts'
export { ConversionError } from './errors.ts'
export type { ConversionErrorCode } from './errors.ts'
export { ENGINE_VERSION } from './engine.ts'

/** Host limits used by both native and Node WASM conversions. All byte limits are positive safe integers. */
export interface ConverterOptions {
  /** Deadline after a queued conversion starts, including font work and output. Default: 120000 ms. */
  timeoutMs?: number
  /** Maximum source bytes. Default: 64 MiB. */
  maxInputBytes?: number
  /** Maximum generated output bytes. Default: 128 MiB. */
  maxOutputBytes?: number
  /** PDF export image resolution in DPI. Default: 144. */
  maxImageResolution?: number
  /** Maximum ZIP entries. Default: 20000. */
  maxArchiveEntries?: number
  /** Maximum declared uncompressed archive bytes. Default: 512 MiB. */
  maxUncompressedBytes?: number
  /** Font roots; defaults to conventional platform and user directories. */
  fontDirectories?: string[]
  /** Ordered family groups replace the defaults. Exact installed families precede alternatives; the full indexed
   * catalog remains available for missing glyphs. Native LibreOffice also resolves installed metric-compatible
   * fonts before configured choices. */
  fontFallbacks?: string[][]
  /** Families imported before loading a document. Defaults to none. */
  initialFontFamilies?: string[]
  /** Maximum visited physical font files. Default: 20000. */
  maxFontFiles?: number
  /** Files exceeding this limit are omitted. Default: 256 MiB. */
  maxFontFileBytes?: number
  /** Complete original font bytes imported per conversion. Default: 512 MiB. Native platform fonts remain OS-managed. */
  maxLoadedFontBytes?: number
}

/** Result of one conversion. */
export interface RenderResult {
  readonly backend: 'native' | 'wasm'
  /** Declared OOXML families no installed font provides; binary formats return an empty list. */
  readonly missingFonts: string[]
}

/** A converter serializes document operations; cancellation and disposal await process/worker exit. */
export interface Converter {
  readonly backend: 'native' | 'wasm'
  /**
   * Convert a private, caller-authorized regular Office file to a fresh exclusive PDF path.
   * The caller owns both directories and must prevent concurrent path changes.
   * Rejects existing output paths; removes a newly created output on failure or cancellation.
   * @param request - Absolute paths. Input suffixes are listed in CONVERSION_FORMATS.
   * @param signal - Optional cancellation, including while queued.
   * @returns Engine choice and missing declared font families.
   */
  render(request: { inputPath: string; outputPath: string }, signal?: AbortSignal): Promise<RenderResult>
  /** Render Office directly to PNG, or PDF through PDFium, in one fresh output directory.
   * Worksheets use sheet/A1 coordinates; page selections are one-based for documents and slides.
   * Failure/cancellation removes the complete batch. The manifest describes one saved input snapshot.
   */
  renderImages(request: RenderImagesRequest, signal?: AbortSignal): Promise<RenderImagesResult>
  /** Convert to the output extension; CSV requires a sheet for multi-sheet inputs. */
  convert(request: ConversionRequest, signal?: AbortSignal): Promise<RenderResult>
  /**
   * Recalculate the entire workbook synchronously and save formulas with refreshed cached results.
   * This does not validate formulas or business data.
   * @param request - XLS, XLSX, or ODS input and a distinct fresh XLSX or ODS output.
   * @param signal - Cancellation, including while queued.
   * @returns Engine choice and missing declared font families.
   */
  recalculate(request: Omit<ConversionRequest, 'sheet'>, signal?: AbortSignal): Promise<RenderResult>
  /** Abort queued and active work, await exit and cleanup, and permanently reject further renders. */
  dispose(): Promise<void>
}

/** Worker result for a WASM conversion, which returns owned output bytes. */
interface WasmWorkerResult {
  readonly kind?: undefined
  readonly ok: true
  readonly output: Uint8Array
  readonly missingFonts: string[]
}

interface ImagesWorkerResult { readonly kind?: undefined; readonly ok: true; readonly images: RenderImagesResult }

/** Worker result for a native conversion, which returns the font imports the helper loads. */
interface NativeWorkerResult {
  readonly kind?: undefined
  readonly ok: true
  readonly fonts: string[]
  readonly substitutions: FontSubstitution[]
  readonly missingFonts: string[]
}

/** One message the conversion worker sends before it settles. */
type WorkerMessage =
  | { readonly kind: 'fonts'; readonly faces: FontFace[] }
  | WasmWorkerResult
  | ImagesWorkerResult
  | NativeWorkerResult
  | { readonly kind?: undefined; readonly ok: false; readonly code?: string; readonly error: string }

/** File identity that must match across a bounded read. */
const CHANGED_KEYS = ['size', 'mtimeMs', 'ctimeMs'] as const

async function readBounded(path: string, limit: number, signal: AbortSignal, role: 'input' | 'output'): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    const invalid = role === 'input' ? 'invalid-document' : 'invalid-output'
    if (!before.isFile() || (role === 'input' && before.size < 1)) throw new ConversionError(invalid, 'Document must be a nonempty regular file.')
    if (before.size > limit) throw new ConversionError(`${role}-too-large`, `Document exceeds its ${role} byte limit.`)
    const bytes = Buffer.alloc(before.size)
    for (let offset = 0; offset < bytes.length;) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) throw new ConversionError(invalid, 'Document was truncated while reading.')
      offset += bytesRead
    }
    const after = await file.stat()
    if (CHANGED_KEYS.some(key => before[key] !== after[key])) throw new ConversionError(invalid, 'Document changed while reading.')
    signal.throwIfAborted()
    return bytes
  } finally { await file.close() }
}

async function runWorker(data: WorkerRequest, signal: AbortSignal, onFonts: (faces: FontFace[]) => void):
Promise<WasmWorkerResult | NativeWorkerResult | ImagesWorkerResult> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: data, name: 'libreoffice-conversion', execArgv: [], stdout: true, stderr: true,
  })
  // Emscripten pthread diagnostics must not enter the embedding application's stdout protocol.
  worker.stdout.resume()
  worker.stderr.resume()
  const settled = Promise.withResolvers<WasmWorkerResult | NativeWorkerResult | ImagesWorkerResult>()
  const abort = (): void => { settled.reject(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  worker.once('error', settled.reject)
  worker.once('exit', (code) => { settled.reject(new ConversionError('failed', `LibreOffice worker exited before returning a result (${code}).`)) })
  worker.on('message', (message: WorkerMessage) => {
    if (message.kind === 'fonts') onFonts(message.faces)
    else if (message.ok) settled.resolve(message)
    else settled.reject(new ConversionError(failureCode(message), message.error))
  })
  try {
    return await settled.promise
  } finally {
    signal.removeEventListener('abort', abort)
    await worker.terminate()
  }
}

/**
 * Resolve the installed engine and deployment limits without starting LibreOffice.
 * @param options - Conversion, font, and output limits.
 * @returns A serial converter; dispose it after use.
 * @throws TypeError for invalid options, or an unavailable ConversionError for invalid installed engines.
 * An absent native engine or a known unsupported glibc version selects WASM.
 */
export async function createConverter(options?: ConverterOptions): Promise<Converter> {
  const resolvedOptions = resolveOptions(options)
  let engine: Engine
  try { engine = await resolveEngine() } catch (cause) { throw new ConversionError('unavailable', (cause as Error).message, { cause }) }
  const lifetime = new AbortController()
  const active = new Set<Promise<RenderResult | RenderImagesResult>>()
  const waiting = new Set<() => void>()
  let running = false
  let disposal: Promise<void> | undefined
  let fontFaces: FontFace[] | undefined
  async function acquire(signal: AbortSignal): Promise<void> {
    while (running) {
      signal.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { waiting.delete(wake); signal.removeEventListener('abort', abort) }
        const wake = () => { cleanup(); resolve() }
        const abort = () => { cleanup(); reject(signal.reason as Error) }
        waiting.add(wake)
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    signal.throwIfAborted()
    running = true
  }
  async function execute(request: ConversionSpec, signal: AbortSignal): Promise<RenderResult> {
    const { extension, format } = request
    await acquire(signal)
    const deadline = new AbortController()
    const stopped = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => { deadline.abort(new ConversionError('timeout', 'LibreOffice conversion timed out.')) }, resolvedOptions.timeoutMs)
    let scratch: string | undefined
    let output: FileHandle | undefined
    let succeeded = false
    let failure: unknown
    try {
      stopped.throwIfAborted()
      output = await open(request.outputPath, 'wx', 0o600)
      const sourceBytes = await readBounded(request.inputPath, resolvedOptions.maxInputBytes, stopped, 'input')
      scratch = await mkdtemp(join(tmpdir(), 'libreoffice-kit-'))
      const inputPath = join(scratch, `document.${extension}`)
      const input = await open(inputPath, 'wx', 0o600)
      try { await input.writeFile(sourceBytes) } finally { await input.close() }
      const result = await runWorker({ inputPath, extension, operation: request, options: resolvedOptions, engine, scratch, fontFaces },
        stopped, (faces) => { fontFaces = faces })
      if ('images' in result) throw new ConversionError('failed', 'Conversion worker returned an image batch for an export request.')
      let bytes: Uint8Array
      if ('output' in result) bytes = result.output
      else {
        // The worker answers with font imports for the engine the converter resolved.
        const native = engine as NativeEngine
        const profile = join(scratch, 'profile')
        await mkdir(profile, { mode: 0o700 })
        const path = join(scratch, `output.${format}`)
        await runNative(native, resolvedOptions, inputPath, path, profile, result.fonts, result.substitutions, stopped, request)
        bytes = await readBounded(path, resolvedOptions.maxOutputBytes, stopped, 'output')
      }
      validateOutput(bytes, format)
      stopped.throwIfAborted()
      await output.writeFile(bytes)
      stopped.throwIfAborted()
      succeeded = true
      return { backend: engine.backend, missingFonts: result.missingFonts }
    } catch (error) {
      failure = error
      throw error
    } finally {
      clearTimeout(timer)
      try {
        const errors: unknown[] = []
        try { await output?.close() } catch (error) { errors.push(error) }
        const cleanup = await Promise.allSettled([
          ...(output && !succeeded ? [unlink(request.outputPath)] : []),
          ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
        ])
        for (const result of cleanup) {
          if (result.status === 'rejected') errors.push(result.reason)
        }
        if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'LibreOffice conversion cleanup failed.')
      } finally {
        running = false
        for (const wake of [...waiting]) wake()
      }
    }
  }
  async function executeImages(request: ImageRenderSpec, signal: AbortSignal): Promise<RenderImagesResult> {
    await acquire(signal)
    const deadline = new AbortController()
    const stopped = AbortSignal.any([signal, deadline.signal])
    const timer = setTimeout(() => deadline.abort(new ConversionError('timeout', 'LibreOffice image rendering timed out.')), resolvedOptions.timeoutMs)
    let scratch: string | undefined
    let owned = false
    let succeeded = false
    try {
      stopped.throwIfAborted()
      await mkdir(request.outputDir, { mode: 0o700 })
      owned = true
      const source = await readBounded(request.inputPath, resolvedOptions.maxInputBytes, stopped, 'input')
      scratch = await mkdtemp(join(tmpdir(), 'libreoffice-kit-images-'))
      const inputPath = join(scratch, `document.${request.extension}`)
      await writeFile(inputPath, source, { flag: 'wx', mode: 0o600 })
      const result = await runWorker({ inputPath, extension: request.extension, operation: request, options: resolvedOptions, engine, scratch, fontFaces },
        stopped, faces => { fontFaces = faces })
      if (!('images' in result)) throw new ConversionError('failed', 'Image worker did not return its manifest.')
      stopped.throwIfAborted()
      await writeFile(join(request.outputDir, 'manifest.json'), `${JSON.stringify(result.images, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      stopped.throwIfAborted()
      succeeded = true
      return result.images
    } finally {
      clearTimeout(timer)
      try {
        const cleanup = await Promise.allSettled([
          ...(scratch ? [rm(scratch, { recursive: true, force: true })] : []),
          ...(owned && !succeeded ? [rm(request.outputDir, { recursive: true, force: true })] : []),
        ])
        const failures = cleanup.filter(result => result.status === 'rejected')
        if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Image batch cleanup failed.')
      } finally { running = false; for (const wake of [...waiting]) wake() }
    }
  }
  async function submit(request: ConversionRequest, operation: 'render' | 'convert' | 'recalculate', signal?: AbortSignal): Promise<RenderResult> {
    const task = execute(resolveConversion(request, operation),
      signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal)
    active.add(task)
    void task.finally(() => { active.delete(task) }).catch((_error: unknown) => { /* The caller owns task rejection. */ })
    return task
  }
  return {
    backend: engine.backend,
    render: (request, signal) => submit(request, 'render', signal),
    async renderImages(request, signal) {
      const task = executeImages(resolveImageRender(request), signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal)
      active.add(task)
      void task.finally(() => active.delete(task)).catch(() => {})
      return task
    },
    convert: (request, signal) => submit(request, 'convert', signal),
    recalculate: (request, signal) => submit(request, 'recalculate', signal),
    dispose() {
      disposal ??= (async () => { lifetime.abort(new Error('LibreOffice converter is disposed.')); await Promise.allSettled(active) })()
      return disposal
    },
  }
}
