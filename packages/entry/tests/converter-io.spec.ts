/** Conversion IO faults preserve their cause and settle ownership of files and workers. */
import { EventEmitter } from 'node:events'
import { mkdtemp, open, readFile, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConverter, type Converter } from '../src/index.ts'

vi.mock('../src/engine.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/engine.ts')>(),
  resolveEngine: async () => ({ backend: 'wasm' }),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open), rm: vi.fn(actual.rm), unlink: vi.fn(actual.unlink) }
})

const worker = vi.hoisted(() => ({ terminations: 0 }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    stdout = { resume() {} }
    stderr = { resume() {} }
    snapshot: boolean
    constructor(entry: URL) {
      super()
      this.snapshot = entry.pathname.endsWith('/font-snapshot-worker.js')
      queueMicrotask(() => this.emit('message', this.snapshot
        ? { ok: true, snapshot: { faces: [], records: [], generation: 'empty' } }
        : { ok: true, output: Buffer.from('%PDF-1.7 fixture'), missingFonts: [] }))
    }
    async terminate(): Promise<number> { if (!this.snapshot) worker.terminations++; return 0 }
  },
}))

const roots: string[] = []
const converters: Converter[] = []

afterEach(async () => {
  await Promise.all(converters.splice(0).map(converter => converter.dispose()))
  vi.restoreAllMocks()
  vi.resetAllMocks()
  worker.terminations = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-converter-io-'))
  roots.push(root)
  const inputPath = join(root, 'input.docx')
  const outputPath = join(root, 'output.pdf')
  await writeFile(inputPath, 'source bytes inspected by the worker')
  const converter = await createConverter({ fontDirectories: [], fontMetadataCacheDirectory: false })
  converters.push(converter)
  return { converter, inputPath, outputPath }
}

async function interceptFile(path: string, inspect: (file: FileHandle) => void): Promise<void> {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  vi.mocked(open).mockImplementation(async (filePath, flags, mode) => {
    const file = await actual.open(filePath, flags, mode)
    if (filePath === path) inspect(file)
    return file
  })
}

it('rejects an input truncated between stat and read, then closes and removes owned files', async () => {
  const { converter, inputPath, outputPath } = await fixture()
  let closed = false
  await interceptFile(inputPath, (file) => {
    vi.spyOn(file, 'read').mockResolvedValueOnce({ bytesRead: 0, buffer: Buffer.alloc(0) })
    const close = file.close.bind(file)
    vi.spyOn(file, 'close').mockImplementation(async () => { await close(); closed = true })
  })
  await expect(converter.render({ inputPath, outputPath })).rejects.toMatchObject({
    code: 'invalid-document', message: 'Document was truncated while reading.',
  })
  expect(closed).toBe(true)
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['size', 'mtimeMs', 'ctimeMs'] as const)('rejects input %s changes during reading', async (key) => {
  const { converter, inputPath, outputPath } = await fixture()
  await interceptFile(inputPath, (file) => {
    const stat = file.stat.bind(file)
    let reads = 0
    vi.spyOn(file, 'stat').mockImplementation(async () => {
      const status = await stat()
      if (++reads === 2) status[key] += 1
      return status
    })
  })
  await expect(converter.render({ inputPath, outputPath })).rejects.toMatchObject({
    code: 'invalid-document', message: 'Document changed while reading.',
  })
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('reports a close failure after conversion and releases the slot for later work', async () => {
  const { converter, inputPath, outputPath } = await fixture()
  const failure = new Error('output close failed')
  await interceptFile(outputPath, (file) => {
    const close = file.close.bind(file)
    vi.spyOn(file, 'close').mockImplementation(async () => { await close(); throw failure })
  })
  await expect(converter.render({ inputPath, outputPath })).rejects.toMatchObject({ errors: [failure] })
  expect(worker.terminations).toBe(1)
  const next = `${outputPath}.next`
  await expect(converter.render({ inputPath, outputPath: next })).resolves.toMatchObject({ backend: 'wasm' })
  expect(worker.terminations).toBe(2)
})

it('preserves the conversion failure together with output deletion and scratch cleanup faults', async () => {
  const { converter, inputPath, outputPath } = await fixture()
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const conversion = new Error('output write failed')
  const deletion = new Error('output deletion failed')
  const cleanup = new Error('scratch removal failed')
  await interceptFile(outputPath, (file) => {
    vi.spyOn(file, 'writeFile').mockRejectedValueOnce(conversion)
  })
  vi.mocked(unlink).mockImplementationOnce(async (path) => { await actual.unlink(path); throw deletion })
  vi.mocked(rm).mockImplementationOnce(async (path, options) => { await actual.rm(path, options); throw cleanup })
  await expect(converter.render({ inputPath, outputPath })).rejects.toMatchObject({
    message: 'LibreOffice conversion cleanup failed.', errors: [conversion, deletion, cleanup],
  })
  expect(worker.terminations).toBe(1)
  await expect(readFile(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
})
