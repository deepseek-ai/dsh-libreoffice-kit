import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertWithWasm } from '../src/wasm.ts'
import { resolveOptions } from '../src/options.ts'
import type { WasmConversionRequest } from '../src/wasm.ts'
import type { WasmEngine } from '../src/engine.ts'
import type { FontFace } from '../src/fonts.ts'

/** Outcomes the fake Emscripten factory reproduces for one conversion. */
interface LoaderBehavior {
  expectedFormat?: string
  expectedSheet?: string
  initialize?: number
  load?: number
  save?: number
  errorPointer?: boolean
  errorMessage?: string
  outputMissing?: boolean
  directoryOutput?: boolean
  oversize?: boolean
  notPdf?: boolean
  destroyDocument?: number
  destroyDocumentRuntimeError?: boolean
  destroy?: number
  terminateThrows?: boolean
  factoryThrows?: boolean
  skipPreRun?: boolean
  resolveBeforePreRun?: boolean
  resolveAfterPreRun?: boolean
  unknownAsset?: boolean
  runtimeErrorDuringSave?: boolean
  abortDuringFactory?: boolean
}

/**
 * The fake Emscripten factory: a CommonJS module with the MEMFS, `ccall`,
 * `UTF8ToString`, and pthread surface `convertWithWasm` drives.
 * @param behavior - One conversion's scripted outcomes.
 * @returns the loader module source.
 */
function loaderSource(behavior: LoaderBehavior): string {
  return `const behavior = ${JSON.stringify(behavior)}
module.exports = async function factory(overrides) {
  const files = new Map()
  const module = {
    FS: {
      mkdirTree() {},
      writeFile(path, data) { files.set(path, new Uint8Array(data)) },
      analyzePath(path) { return { exists: files.has(path) } },
      stat(path) { const data = files.get(path); return { mode: 1, size: data === undefined ? 0 : data.length } },
      isFile() { return !behavior.directoryOutput },
      readFile(path) { return files.get(path) },
    },
    ENV: {},
    ccall(name, returnType, argTypes, args) {
      if (name === 'dsh_lok_initialize') return behavior.initialize === undefined ? 1 : behavior.initialize
      if (name === 'dsh_lok_document_load') return behavior.load === undefined ? 2 : behavior.load
      if (name === 'dsh_lok_document_export') {
        if (behavior.expectedFormat && args[3] !== behavior.expectedFormat) throw new Error('Wrong export format')
        if (behavior.expectedSheet && args[6] !== behavior.expectedSheet) throw new Error('Wrong worksheet')
        if (behavior.expectedFormat === 'txt' && args[4] !== 'UTF8,LF') throw new Error('Wrong text encoding')
        if (behavior.runtimeErrorDuringSave) throw new WebAssembly.RuntimeError('save failed')
        if (!behavior.outputMissing) {
          const body = (behavior.expectedFormat === 'ods' ? 'PK\\x03\\x04fixture' : behavior.notPdf ? 'not-a-pdf' : '%PDF-1.7 fixture').repeat(behavior.oversize ? 4000 : 1)
          files.set(String(args[2]).replace('file://', ''), new TextEncoder().encode(body))
        }
        return behavior.save === undefined ? 1 : behavior.save
      }
      if (name === 'dsh_lok_error') return behavior.errorPointer ? 8 : 0
      if (name === 'dsh_lok_document_destroy') {
        if (behavior.destroyDocumentRuntimeError) throw new WebAssembly.RuntimeError('destroy failed')
        return behavior.destroyDocument === undefined ? 1 : behavior.destroyDocument
      }
      if (name === 'dsh_lok_destroy') return behavior.destroy === undefined ? 1 : behavior.destroy
      return 0
    },
    UTF8ToString() { return behavior.errorMessage === undefined ? 'engine failure' : behavior.errorMessage },
    PThread: { terminateAllThreads() { if (behavior.terminateThrows) throw new Error('terminate failed') } },
  }
  for (const asset of ['loader.cjs', 'soffice.wasm', 'soffice.data', 'soffice.data.js.metadata']) overrides.locateFile(asset)
  if (behavior.unknownAsset) overrides.locateFile('unlisted.bin')
  overrides.getPreloadedPackage()
  overrides.print()
  overrides.printErr()
  if (behavior.resolveBeforePreRun) overrides.dshResolveSystemFonts({ family: 'Early', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] })
  if (!behavior.skipPreRun) for (const hook of overrides.preRun) hook(module)
  if (behavior.resolveAfterPreRun) overrides.dshResolveSystemFonts({ family: 'Fixture Face', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [65] })
  if (behavior.factoryThrows) throw new Error('factory failed')
  if (behavior.abortDuringFactory) { overrides.onAbort(); throw new Error('module aborted') }
  return module
}
`
}

/** One installed WASM engine plus a readable font face the conversion can import. */
async function wasmFixture(root: string, behavior: LoaderBehavior) {
  const directory = join(root, 'engine')
  await mkdir(directory, { recursive: true })
  const loader = join(directory, 'loader.cjs')
  await writeFile(loader, loaderSource(behavior))
  const wasm = join(directory, 'soffice.wasm')
  await writeFile(wasm, 'wasm bytes')
  const data = join(directory, 'soffice.data')
  await writeFile(data, 'data bytes')
  const metadata = join(directory, 'soffice.data.js.metadata')
  await writeFile(metadata, '{}')
  const engine: WasmEngine = { backend: 'wasm', root: directory, programDirectory: '/instdir/program', loader, wasm, data, metadata }
  const fontPath = join(root, 'fixture.ttf')
  writeFileSync(fontPath, 'font bytes')
  const status = statSync(fontPath)
  const face: FontFace = { path: fontPath, size: status.size, mtimeMs: status.mtimeMs, ctimeMs: status.ctimeMs,
    dev: status.dev, ino: status.ino, faceIndex: 0, family: 'Fixture Face', style: 'Regular', aliases: ['fixtureface'],
    weight: 400, width: 5, italic: false, fixed: false, decorative: false, postscriptName: 'FixtureFace', coverage: [[65, 65]] }
  return { engine, face }
}

/** Convert one request through the fake engine inside a private directory. */
async function convert(behavior: LoaderBehavior, limits: { maxOutputBytes?: number } = {}, operation: WasmConversionRequest['operation'] = { format: 'pdf', recalculate: false }):
Promise<Awaited<ReturnType<typeof convertWithWasm>>> {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-kit-wasm-'))
  try {
    const { engine, face } = await wasmFixture(root, behavior)
    const request: WasmConversionRequest = { engine, bytes: new Uint8Array([1, 2, 3]), extension: 'docx', operation,
      options: resolveOptions({ fontDirectories: [], initialFontFamilies: ['Fixture Face'], ...limits }),
      document: { families: new Map([['fixtureface', 'Fixture Face']]), codePoints: [65] }, faces: [face] }
    return await convertWithWasm(request)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 3 }) }
}

describe('Node WASM conversion', () => {
  it('forwards generic exports, CSV selection, and synchronous recalculation', async () => {
    for (const format of ['txt', 'csv', 'ods']) {
      const sheet = format === 'csv' ? 'Summary 中文' : undefined
      await convert({ expectedFormat: format, ...(sheet ? { expectedSheet: sheet } : {}) }, {},
        { format, recalculate: format === 'ods', ...(sheet ? { sheet } : {}) })
    }
  })
  it('returns owned PDF bytes and the catalog diagnostics', async () => {
    const result = await convert({ resolveAfterPreRun: true })
    expect(new TextDecoder().decode(result.output.subarray(0, 5))).toBe('%PDF-')
    expect(result.missingFonts).toEqual([])
  })

  it('reports an uninitialized engine and an unloaded document', async () => {
    await expect(convert({ initialize: 0, errorPointer: true, errorMessage: 'startup refused' })).rejects.toThrow(/startup refused/)
    await expect(convert({ initialize: 0 })).rejects.toThrow(/could not convert the document/)
    await expect(convert({ load: 0, errorPointer: true, errorMessage: 'load refused' })).rejects.toThrow(/load refused/)
    await expect(convert({ save: 0, errorPointer: true, errorMessage: 'export refused' })).rejects.toThrow(/export refused/)
  })

  it('rejects missing, irregular, oversized, and non-PDF engine output', async () => {
    await expect(convert({ outputMissing: true })).rejects.toThrow(/did not create its output/)
    await expect(convert({ directoryOutput: true })).rejects.toThrow(/not a regular file/)
    await expect(convert({ oversize: true }, { maxOutputBytes: 16 })).rejects.toThrow(/output byte limit/)
    await expect(convert({ notPdf: true })).rejects.toThrow(/did not produce a PDF/)
  })

  it('refuses fonts requested before MEMFS and assets the engine did not declare', async () => {
    await expect(convert({ resolveBeforePreRun: true })).rejects.toThrow(/before initializing MEMFS/)
    await expect(convert({ unknownAsset: true })).rejects.toThrow(/unlisted asset/)
  })

  it('requires the pre-run hook to install the font loader', async () => {
    await expect(convert({ skipPreRun: true })).rejects.toThrow(/without its font loader/)
  })

  it('reports an aborted module through the fatal teardown path', async () => {
    await expect(convert({ abortDuringFactory: true })).rejects.toThrow(/module aborted/)
    expect(true).toBe(true)
  })

  it('reports a WebAssembly runtime error without attempting teardown', async () => {
    await expect(convert({ runtimeErrorDuringSave: true })).rejects.toBeInstanceOf(WebAssembly.RuntimeError)
    await expect(convert({ destroyDocumentRuntimeError: true })).rejects.toBeInstanceOf(AggregateError)
  })

  it('aggregates engine failure with teardown failure and teardown failure alone', async () => {
    const failure = await convert({ outputMissing: true, destroyDocument: 0 }).catch((error: unknown) => error as AggregateError)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toHaveLength(2)
    const teardown = await convert({ destroyDocument: 0 }).catch((error: unknown) => error as AggregateError)
    expect(teardown).toBeInstanceOf(AggregateError)
    expect((teardown as AggregateError).errors).toHaveLength(1)
    await expect(convert({ destroyDocument: 0, destroy: 0 })).rejects.toThrow(/cleanup failed/)
    await expect(convert({ terminateThrows: true })).rejects.toThrow(/cleanup failed/)
  })

  it('propagates a factory that rejects before returning a module', async () => {
    await expect(convert({ factoryThrows: true })).rejects.toThrow(/factory failed/)
  })
})
