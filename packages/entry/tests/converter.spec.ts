import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { documentFixture } from './document-fixture.ts'
import { resolveEngine } from '../src/engine.ts'
import { ConversionError, createConverter } from '../src/index.ts'
import type { Converter, ConverterOptions } from '../src/index.ts'
import type { Engine, NativeEngine, WasmEngine } from '../src/engine.ts'
import type { WorkerOptions } from 'node:worker_threads'
import type { WorkerRequest } from '../src/worker.ts'
import type { SpawnOptions } from 'node:child_process'

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>()
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(entry: URL, options: WorkerOptions) {
        expect(entry.pathname).toMatch(/\/worker\.js$/)
        expect(options.execArgv).toEqual([])
        const data = options.workerData as WorkerRequest
        const fontDirectory = data.options.fontDirectories[0]
        if (data.engine.backend === 'wasm' && fontDirectory !== undefined) {
          const path = join(fontDirectory, 'fixture.ttf')
          const { size, mtimeMs, ctimeMs, dev, ino } = statSync(path)
          options = { ...options, workerData: { ...data, fontFaces: [{
            path, size, mtimeMs, ctimeMs, dev, ino, faceIndex: 0,
            family: 'Fixture Face', aliases: ['fixtureface'], style: 'Regular',
            weight: 400, width: 5, italic: false, fixed: false, decorative: false, postscriptName: 'FixtureFace',
            coverage: [[0, 0x10ffff]],
          }] } }
        }
        super(new URL('./worker-bootstrap.mjs', import.meta.url), options)
      }
    },
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (file: string, args: readonly string[], options: SpawnOptions) =>
      actual.spawn(process.execPath, [file, ...args], options),
  }
})

vi.mock('../src/engine.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/engine.ts')>(),
  resolveEngine: vi.fn(),
}))

const temporaryDirectories: string[] = []
afterEach(async () => {
  vi.mocked(resolveEngine).mockReset()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true, maxRetries: 3 })))
})

// Each real conversion boots a TypeScript worker and converts; the default 5s
// per-test budget only covers the mocked engine-selection paths.
vi.setConfig({ testTimeout: 60_000 })

/** One private conversion root with an input document ready to render. */
async function conversionFixture(): Promise<{ root: string; inputPath: string; outputPath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-kit-converter-'))
  temporaryDirectories.push(root)
  const inputPath = join(root, 'document.docx')
  await writeFile(inputPath, documentFixture('Converter fixture 中文', 'Unavailable Fixture Face'))
  return { root, inputPath, outputPath: join(root, 'document.pdf') }
}

/** Installation-independent font root shared by the WASM conversions in this file. */
let sharedFontDirectory: string | undefined

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-kit-fonts-'))
  sharedFontDirectory = join(root, 'fonts')
  await mkdir(sharedFontDirectory, { recursive: true })
  await writeFile(join(sharedFontDirectory, 'fixture.ttf'), 'original bytes accepted by the fake WASM engine')
})

afterAll(async () => {
  if (sharedFontDirectory === undefined) return
  await rm(dirname(sharedFontDirectory), { recursive: true, force: true, maxRetries: 3 })
})

/** The private font bytes used with the fake WASM engine. */
function fontDirectory(): string {
  if (sharedFontDirectory === undefined) throw new Error('Font fixture has not been initialized.')
  return sharedFontDirectory
}

/** A native engine whose helper answers one scripted conversion. */
async function nativeEngine(root: string, body: string): Promise<NativeEngine> {
  const directory = join(root, 'native')
  await mkdir(join(directory, 'program'), { recursive: true })
  const executable = join(directory, 'helper.cjs')
  await writeFile(executable, `
const argv = process.argv.slice(2)
const value = flag => argv[argv.indexOf(flag) + 1]
${body}
`, { mode: 0o700 })
  return { backend: 'native', root: directory, programDirectory: join(directory, 'program'), executable }
}

const writesPdf = "require('node:fs').writeFileSync(value('--output-path'), '%PDF-1.7 native fixture'); console.log(JSON.stringify({ ok: true }));"

/** A WASM engine whose loader is a scripted CommonJS Emscripten factory. */
async function wasmEngine(root: string, loaderBody: string): Promise<WasmEngine> {
  const directory = join(root, 'wasm')
  await mkdir(directory, { recursive: true })
  const loader = join(directory, 'loader.cjs')
  await writeFile(loader, loaderBody)
  const wasm = join(directory, 'dsh-office.wasm')
  await writeFile(wasm, 'wasm bytes')
  const data = join(directory, 'soffice.data')
  await writeFile(data, 'data bytes')
  const metadata = join(directory, 'soffice.data.js.metadata')
  await writeFile(metadata, '{}')
  return { backend: 'wasm', root: directory, programDirectory: '/instdir/program', loader, wasm, data, metadata }
}

/** Loader source that writes a PDF into MEMFS and answers success. */
const wasmWritesPdf = `module.exports = async function factory(overrides) {
  const files = new Map()
  const module = {
    FS: { mkdirTree() {}, writeFile(path, data) { files.set(path, data) }, analyzePath(path) { return { exists: files.has(path) } },
      stat(path) { const data = files.get(path); return { mode: 1, size: data === undefined ? 0 : data.length } },
      isFile() { return true }, readFile(path) { return files.get(path) } },
    ENV: {},
    ccall(name, returnType, argTypes, args) {
      if (name === 'dsh_lok_initialize') return 1
      if (name === 'dsh_lok_document_load') return 2
      if (name === 'dsh_lok_document_export') { files.set(String(args[2]).replace('file://', ''), new TextEncoder().encode('%PDF-1.7 wasm fixture')); return 1 }
      if (name === 'dsh_lok_error') return 0
      return 1
    },
    UTF8ToString() { return 'engine failure' },
    PThread: { terminateAllThreads() {} },
  }
  for (const hook of overrides.preRun) hook(module)
  return module
}
`

/**
 * Resolve the mocked engine and create an isolated converter.
 * @param engine - Engine the resolver reports.
 * @param options - Converter options layered over empty font directories.
 * @returns the converter the caller must dispose.
 */
async function converterFor(engine: Engine, options: ConverterOptions = {}): Promise<Converter> {
  vi.mocked(resolveEngine).mockResolvedValue(engine)
  return await createConverter({ timeoutMs: 30_000, fontDirectories: [], ...options })
}

describe('createConverter', () => {
  it('reports an unavailable engine with its cause', async () => {
    vi.mocked(resolveEngine).mockRejectedValue(new Error('no engine installed'))
    await expect(createConverter({ fontDirectories: [] })).rejects.toMatchObject({ code: 'unavailable', message: 'no engine installed' })
  })

  it('converts through the native helper and reads back the PDF it wrote', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const converter = await converterFor(await nativeEngine(root, writesPdf))
    try {
      expect(converter.backend).toBe('native')
      const result = await converter.render({ inputPath, outputPath })
      expect(result).toEqual({ backend: 'native', missingFonts: ['Unavailable Fixture Face'] })
      expect((await readFile(outputPath)).subarray(0, 5).toString()).toBe('%PDF-')
      // Later renders reuse the worker's cached font faces, and each queued one waits for its slot.
      const queued = converter.render({ inputPath, outputPath: join(root, 'queued.pdf') })
      const third = converter.render({ inputPath, outputPath: join(root, 'third.pdf') })
      await expect(queued).resolves.toMatchObject({ backend: 'native' })
      await expect(third).resolves.toMatchObject({ backend: 'native' })
    } finally { await converter.dispose() }
  })

  it('converts through the WASM engine and returns its bytes', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const fonts = fontDirectory()
    const converter = await converterFor(await wasmEngine(root, wasmWritesPdf), { fontDirectories: [fonts] })
    try {
      expect(converter.backend).toBe('wasm')
      await expect(converter.render({ inputPath, outputPath })).resolves.toMatchObject({ backend: 'wasm' })
      expect((await readFile(outputPath)).subarray(0, 5).toString()).toBe('%PDF-')
    } finally { await converter.dispose() }
  })

  it('reports a WASM conversion refused for lack of fonts and a loader that fails', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const unavailable = await converterFor(await wasmEngine(root, wasmWritesPdf))
    try {
      await expect(unavailable.render({ inputPath, outputPath })).rejects.toMatchObject({ code: 'unavailable' })
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await unavailable.dispose() }
    const fonts = fontDirectory()
    const refused = await converterFor(await wasmEngine(join(root, 'refused'), 'module.exports = async function factory() { throw new Error("loader refused") }\n'),
      { fontDirectories: [fonts] })
    try {
      await expect(refused.render({ inputPath, outputPath: join(root, 'refused.pdf') })).rejects.toMatchObject({ code: 'failed' })
    } finally { await refused.dispose() }
  })

  it('reports a worker that exits before answering', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const fonts = fontDirectory()
    const converter = await converterFor(await wasmEngine(root, 'process.exit(7)\n'), { fontDirectories: [fonts] })
    try {
      await expect(converter.render({ inputPath, outputPath })).rejects.toThrow(/exited before returning a result \(7\)/)
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await converter.dispose() }
  })

  it('rejects invalid requests before reading any file', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const converter = await converterFor(await nativeEngine(root, writesPdf))
    try {
      const invalid = [
        undefined, {}, { inputPath: 'relative.docx', outputPath }, { inputPath, outputPath: 'relative.pdf' },
        { inputPath: `${inputPath}\0`, outputPath }, { inputPath, outputPath: `${outputPath}\0` },
      ]
      for (const request of invalid) {
        await expect(converter.render(request as { inputPath: string; outputPath: string })).rejects.toThrow(/absolute filesystem paths/)
      }
      await expect(converter.render({ inputPath, outputPath: inputPath })).rejects.toThrow(/must differ/)
      await writeFile(join(root, 'note.txt'), 'text')
      await expect(converter.render({ inputPath: join(root, 'note.txt'), outputPath })).rejects.toMatchObject({ code: 'unsupported-format' })
      await writeFile(outputPath, 'existing')
      await expect(converter.render({ inputPath, outputPath })).rejects.toMatchObject({ code: 'EEXIST' })
      await rm(outputPath)
      const directory = join(root, 'directory-input.docx')
      await mkdir(directory)
      await expect(converter.render({ inputPath: directory, outputPath })).rejects.toMatchObject({ code: 'invalid-document' })
      const empty = join(root, 'empty.docx')
      await writeFile(empty, '')
      await expect(converter.render({ inputPath: empty, outputPath })).rejects.toMatchObject({ code: 'invalid-document' })
    } finally { await converter.dispose() }
    const bounded = await converterFor(await nativeEngine(join(root, 'bounded'), writesPdf), { maxInputBytes: 16 })
    try {
      await expect(bounded.render({ inputPath, outputPath })).rejects.toMatchObject({ code: 'input-too-large' })
    } finally { await bounded.dispose() }
  })

  it('rejects non-document bytes and outputs the engine did not render', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const invalid = await converterFor(await nativeEngine(root, writesPdf))
    try {
      const notZip = join(root, 'not-zip.docx')
      await writeFile(notZip, 'not a zip archive')
      await expect(invalid.render({ inputPath: notZip, outputPath })).rejects.toMatchObject({ code: 'invalid-document' })
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await invalid.dispose() }
    const notPdf = await converterFor(await nativeEngine(join(root, 'not-pdf'), "require('node:fs').writeFileSync(value('--output-path'), 'not a pdf'); console.log(JSON.stringify({ ok: true }));"))
    try {
      await expect(notPdf.render({ inputPath, outputPath })).rejects.toMatchObject({ code: 'invalid-output' })
    } finally { await notPdf.dispose() }
  })

  it('enforces the output byte limit on the returned PDF', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const converter = await converterFor(await nativeEngine(root, writesPdf), { maxOutputBytes: 8 })
    try {
      await expect(converter.render({ inputPath, outputPath })).rejects.toMatchObject({ code: 'output-too-large' })
    } finally { await converter.dispose() }
  })

  it('times out a conversion and removes its partial output', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const converter = await converterFor(await nativeEngine(root, 'setInterval(() => {}, 1000);'), { timeoutMs: 50 })
    try {
      await expect(converter.render({ inputPath, outputPath })).rejects.toMatchObject({ code: 'timeout' })
      await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await converter.dispose() }
  })

  it('cancels an active and a queued render, then rejects later work after disposal', async () => {
    const { root, inputPath } = await conversionFixture()
    const converter = await converterFor(await nativeEngine(root, 'setInterval(() => {}, 1000);'))
    try {
      const activeController = new AbortController()
      const active = converter.render({ inputPath, outputPath: join(root, 'active.pdf') }, activeController.signal)
      const queuedController = new AbortController()
      const queued = converter.render({ inputPath, outputPath: join(root, 'queued.pdf') }, queuedController.signal)
      const queuedCheck = expect(queued).rejects.toThrow(/queued stop/)
      queuedController.abort(new Error('queued stop'))
      await queuedCheck
      activeController.abort(new Error('active stop'))
      await expect(active).rejects.toThrow(/active stop/)
      await expect(stat(join(root, 'active.pdf'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await converter.dispose() }
    await expect(converter.render({ inputPath, outputPath: join(root, 'disposed.pdf') })).rejects.toThrow(/disposed/)
    await expect(converter.dispose()).resolves.toBeUndefined()
  })

  it('fails a conversion with the category the helper reports', async () => {
    const { root, inputPath, outputPath } = await conversionFixture()
    const converter = await converterFor(await nativeEngine(root, "console.log(JSON.stringify({ ok: false, code: 'timeout', error: 'helper reported a timeout' })); process.exitCode = 2;"))
    try {
      const failure: unknown = await converter.render({ inputPath, outputPath }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ConversionError)
      const conversion = failure as ConversionError
      expect(conversion.code).toBe('timeout')
      expect(conversion.message).toContain('helper reported a timeout')
    } finally { await converter.dispose() }
  })

})


it('shares the converter queue and exclusive output handling with conversion and recalculation', async () => {
  const { root, inputPath } = await conversionFixture()
  vi.mocked(resolveEngine).mockResolvedValue(await nativeEngine(root, `const fs = require('node:fs'); fs.writeFileSync(value('--output-path'), value('--format') === 'txt' ? 'Exported text' : Buffer.from([0x50, 0x4b, 3, 4])); console.log(JSON.stringify({ok:true}));`))
  const converter = await createConverter({ fontDirectories: [] })
  try {
    const outputPath = join(root, 'converted.txt')
    await converter.convert({ inputPath, outputPath })
    expect(await readFile(outputPath, 'utf8')).toBe('Exported text')
    await expect(converter.convert({ inputPath, outputPath })).rejects.toMatchObject({ code: 'EEXIST' })
    const spreadsheet = join(root, 'input.xlsx')
    await writeFile(spreadsheet, await readFile(new URL('../../../test/fixtures/one-sheet.xlsx', import.meta.url)))
    await converter.recalculate({ inputPath: spreadsheet, outputPath: join(root, 'calculated.ods') })
    await expect(converter.recalculate({ inputPath, outputPath: join(root, 'invalid.docx') })).rejects.toMatchObject({ code: 'unsupported-format' })
  } finally { await converter.dispose() }
})
