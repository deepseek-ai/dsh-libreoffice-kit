/** Node-only LibreOffice module execution; the owner terminates this worker on cancellation. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { createFontLoader, memoryFontConfig, preloadFonts } from './font-loader.ts'
import { preloadPdfFonts } from './font-full.ts'
import { profileXml } from './profile.ts'
import { ConversionError } from './errors.ts'
import type { FontFace, FontMatchRequest } from './fonts.ts'
import type { FontLoader } from './font-loader.ts'
import type { FontResolutionCacheEntry } from './font-loader.ts'
import type { DocumentFontMetadata } from './ooxml.ts'
import type { ResolvedOptions } from './options.ts'
import { validateOutput } from './operations.ts'
import type { ConversionSpec } from './operations.ts'
import type { WasmEngine } from './engine.ts'

const require = createRequire(import.meta.url)

/** MEMFS operations the conversion uses inside the Emscripten module. */
interface EmscriptenFileSystem {
  /**
   * @param path - Absolute MEMFS path.
   */
  mkdirTree(path: string): void
  /**
   * @param path - Absolute MEMFS path.
   * @param data - Complete file contents.
   */
  writeFile(path: string, data: Uint8Array): void
  /**
   * @param path - Absolute MEMFS path.
   * @returns whether the path exists.
   */
  analyzePath(path: string): { exists: boolean }
  /**
   * @param path - Absolute MEMFS path.
   * @returns the stat record the conversion inspects.
   */
  stat(path: string): { mode: number; size: number }
  /**
   * @param mode - Stat mode flags.
   * @returns whether the mode flags describe a regular file.
   */
  isFile(mode: number): boolean
  /**
   * @param path - Absolute MEMFS path.
   * @returns the complete file contents.
   */
  readFile(path: string): Uint8Array
}

/** The Emscripten module surface the conversion drives. */
export interface EmscriptenModule {
  readonly HEAPU32: Uint32Array
  readonly FS: EmscriptenFileSystem
  readonly ENV: Record<string, string>
  /**
   * @param name - Exported C function name.
   * @param returnType - Emscripten return type, or null for void.
   * @param argTypes - Emscripten argument types.
   * @param args - Call arguments.
   * @returns the exported function's numeric result.
   */
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): number
  /**
   * @param pointer - Pointer returned by the module.
   * @returns the NUL-terminated UTF-8 string at the pointer.
   */
  UTF8ToString(pointer: number): string
  readonly PThread: {
    /** Stop every pthread the module started. */
    terminateAllThreads(): void
  }
}

/** Module overrides the conversion supplies; Emscripten extends the module's own surface. */
interface EmscriptenModuleOverrides {
  dshOnCallback(type: number, payload: string): void
  readonly noInitialRun: boolean
  readonly mainScriptUrlOrBlob: string
  /**
   * @param name - Asset name the module requested.
   * @returns the absolute path of the declared asset.
   */
  locateFile(name: string): string
  /** @returns the preloaded data package for this engine. */
  getPreloadedPackage(): ArrayBuffer
  /**
   * @param request - VCL font attributes the engine is resolving.
   * @returns installed file paths for the selected faces.
   */
  dshResolveSystemFonts(request: FontMatchRequest): string[]
  readonly preRun: readonly ((module: EmscriptenModule) => void)[]
  /** Marks the module unusable after an Emscripten abort. */
  onAbort(): void
  /** Discards module stdout; the owner owns the response protocol. */
  print(): void
  /** Discards module stderr; the owner owns the response protocol. */
  printErr(): void
}

/** One conversion request executed inside the Node worker. */
export interface WasmConversionRequest {
  readonly engine: WasmEngine
  readonly bytes: Uint8Array
  readonly extension: string
  readonly operation: Pick<ConversionSpec, 'format' | 'recalculate' | 'sheet'>
  readonly options: ResolvedOptions
  readonly document: DocumentFontMetadata
  readonly faces: readonly FontFace[]
  readonly fontCache?: readonly FontResolutionCacheEntry[]
  readonly onFontCache?: (entries: FontResolutionCacheEntry[]) => void
}

/** Owned PDF bytes and declared families the installed catalog could not provide. */
export interface WasmConversionResult {
  readonly output: Uint8Array
  readonly missingFonts: string[]
}

type EmscriptenFactory = (overrides: EmscriptenModuleOverrides) => Promise<EmscriptenModule>

export function engineError(module: EmscriptenModule, office: number): Error {
  const pointer = module.ccall('dsh_lok_error', 'number', ['number'], [office])
  if (!pointer) return new Error('LibreOffice WASM could not convert the document.')
  try { return new Error(module.UTF8ToString(pointer)) } finally { module.ccall('free', null, ['number'], [pointer]) }
}

/**
 * @param loader - Loader the module's pre-run hook installs.
 * @returns the initialized font loader.
 * @throws when the module resolved without running its pre-run hook.
 */
function requiredFontLoader(loader: FontLoader | undefined): FontLoader {
  if (loader === undefined) throw new Error('LibreOffice initialized without its font loader.')
  return loader
}

/**
 * Convert bounded source bytes; return owned PDF bytes only after engine teardown.
 * @param request - Engine installation, source bytes, limits, and font metadata.
 * @returns the generated PDF bytes and the declared families the catalog could not provide.
 */
export interface WasmSession {
  readonly module: EmscriptenModule
  readonly office: number
  readonly document: number
  readonly pdf: boolean
  readonly missingFonts: string[]
  idle(): Promise<void>
}

/** A single module loader and owned session lifecycle for export and direct raster operations. */
export async function withWasmSession<T>(request: Omit<WasmConversionRequest, 'operation'>,
  use: (session: WasmSession) => Promise<T> | T): Promise<T> {
  const { engine, bytes, extension, options, document: metadata, faces } = request
  const pdf = extension === 'pdf'
  let idleReady = false
  const factory = require(engine.loader) as EmscriptenFactory
  const raw = readFileSync(engine.data)
  const data = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)
  let module: EmscriptenModule | undefined
  let office = 0
  let document = 0
  let fontLoader: ReturnType<typeof createFontLoader> | undefined
  let fatal = false
  let failure: unknown
  try {
    module = await factory({
      dshOnCallback(type, payload) {
        if (type !== 16) return
        try {
          const result = JSON.parse(payload) as { commandName?: string; idleID?: string }
          if (result.commandName === '.uno:ReportWhenIdle' && result.idleID === 'node-raster') idleReady = true
        } catch { /* Non-JSON callbacks are irrelevant to the idle barrier. */ }
      },
      noInitialRun: true,
      mainScriptUrlOrBlob: engine.loader,
      locateFile(name) {
        const file = basename(name)
        if (file === 'soffice.wasm') return engine.wasm
        for (const asset of [engine.loader, engine.data, engine.wasm, engine.metadata]) {
          if (basename(asset) === file) return asset
        }
        throw new Error(`LibreOffice requested an unlisted asset: ${file}`)
      },
      getPreloadedPackage: () => data,
      dshResolveSystemFonts(request) {
        if (!fontLoader) throw new Error('LibreOffice requested fonts before initializing MEMFS.')
        return fontLoader.resolve(request)
      },
      preRun: [(loadedModule) => {
        for (const path of ['/dsh/profile/user', '/dsh/font-cache', '/dsh-fonts']) loadedModule.FS.mkdirTree(path)
        loadedModule.FS.writeFile('/dsh/profile/user/registrymodifications.xcu', new TextEncoder().encode(profileXml()))
        loadedModule.FS.writeFile('/dsh/fonts.conf', new TextEncoder().encode(memoryFontConfig(options.fontFallbacks, metadata.families.values())))
        Object.assign(loadedModule.ENV, { HOME: '/dsh/profile', TMPDIR: '/tmp', FONTCONFIG_FILE: '/dsh/fonts.conf', LOK_HOST_ALLOWLIST: '^$' })
        fontLoader = createFontLoader(options, metadata, (name, bytes) => {
          const path = `/dsh-fonts/${name}`
          loadedModule.FS.writeFile(path, bytes)
          return path
        }, faces, request.fontCache)
        if (pdf) {
          loadedModule.FS.mkdirTree('/usr/share/fonts/dsh-pdfium')
          preloadPdfFonts(options, faces, (name, bytes) => loadedModule.FS.writeFile(`/usr/share/fonts/dsh-pdfium/${name}`, bytes))
        } else preloadFonts(fontLoader, options, metadata)
      }],
      onAbort() { fatal = true },
      print() {}, printErr() {},
    })
    const instance = module
    const input = `/dsh/document.${extension}`
    if (!pdf) instance.FS.writeFile(input, bytes)
    if (pdf) {
      const pointer = instance.ccall('malloc', 'number', ['number'], [bytes.length])
      if (!pointer) throw engineError(instance, 0)
      try {
        new Uint8Array(instance.HEAPU32.buffer).set(bytes, pointer)
        document = instance.ccall('dsh_pdf_open', 'number', ['number', 'number', 'string'], [pointer, bytes.length, ''])
      } finally { instance.ccall('free', null, ['number'], [pointer]) }
      if (!document) throw engineError(instance, 0)
    } else {
      office = instance.ccall('dsh_lok_initialize', 'number', ['string', 'string'], [engine.programDirectory, 'file:///dsh/profile'])
      if (!office) throw engineError(instance, 0)
      document = instance.ccall('dsh_lok_document_load', 'number', ['number', 'string', 'string'], [office, `file://${input}`, 'Batch=true,EnableMacrosExecution=false'])
      if (!document) throw engineError(instance, office)
    }
    const result = await use({ module: instance, office, document, pdf,
      get missingFonts() { return requiredFontLoader(fontLoader).missingFonts },
      async idle() {
        if (pdf) return
        idleReady = false
        if (!instance.ccall('dsh_lok_document_command', 'number', ['number', 'string', 'string'],
          [document, '.uno:ReportWhenIdle', '{"idleID":{"type":"string","value":"node-raster"}}'])) throw engineError(instance, office)
        const deadline = performance.now() + options.timeoutMs
        while (!idleReady) {
          for (let i = 0; i < 8 && !idleReady; i++) {
            const pending = instance.ccall('dsh_lok_pump', 'number', [], [])
            if (pending < 0) throw engineError(instance, office)
            if (!pending) break
          }
          if (performance.now() > deadline) throw new ConversionError('timeout', 'LibreOffice did not reach its raster idle barrier.')
          if (!idleReady) await new Promise(resolve => setTimeout(resolve, 0))
        }
      },
    })
    request.onFontCache?.(requiredFontLoader(fontLoader).cacheEntries)
    return result
  } catch (error) {
    fatal ||= error instanceof WebAssembly.RuntimeError
    failure = error
    throw error
  } finally {
    const errors: unknown[] = []
    if (module && !fatal) {
      if (document) try { if (!module.ccall(pdf ? 'dsh_pdf_destroy' : 'dsh_lok_document_destroy', 'number', ['number'], [document])) throw engineError(module, office) } catch (error) { errors.push(error); fatal ||= error instanceof WebAssembly.RuntimeError }
      if (office && !fatal) try { if (!module.ccall('dsh_lok_destroy', 'number', ['number'], [office])) throw engineError(module, 0) } catch (error) { errors.push(error) }
    }
    if (module) try { module.PThread.terminateAllThreads() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(failure ? [failure, ...errors] : errors, 'LibreOffice WASM cleanup failed.')
  }
}

/** Convert bounded source bytes; return owned bytes only after engine teardown. */
export async function convertWithWasm(request: WasmConversionRequest): Promise<WasmConversionResult> {
  return withWasmSession(request, (session) => {
    const { module, office, document } = session
    const { operation, options } = request
    const output = `/dsh/output.${operation.format}`
    const filterOptions = operation.format === 'pdf' ? JSON.stringify({
      ExportBookmarks: { type: 'boolean', value: 'true' }, ReduceImageResolution: { type: 'boolean', value: 'true' },
      MaxImageResolution: { type: 'long', value: String(options.maxImageResolution) },
    }) : operation.format === 'txt' ? 'UTF8,LF' : ''
    const succeeded = module.ccall('dsh_lok_document_export', 'number',
      ['number', 'number', 'string', 'string', 'string', 'number', 'string'],
      [office, document, `file://${output}`, operation.format, filterOptions, Number(operation.recalculate), operation.sheet ?? ''])
    if (!succeeded) throw engineError(module, office)
    if (!module.FS.analyzePath(output).exists) throw new ConversionError('invalid-output', 'LibreOffice did not create its output.')
    const status = module.FS.stat(output)
    if (!module.FS.isFile(status.mode)) throw new ConversionError('invalid-output', 'Generated output is not a regular file.')
    if (status.size > options.maxOutputBytes) throw new ConversionError('output-too-large', 'Generated output exceeds its output byte limit.')
    const result = module.FS.readFile(output)
    validateOutput(result, operation.format)
    return { output: result, missingFonts: session.missingFonts }
  })
}
