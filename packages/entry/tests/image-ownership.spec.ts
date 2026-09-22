/** Image batch failures keep converter serialization, font caching, and owned cleanup intact. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConverter } from '../src/index.ts'
import type { WorkerRequest } from '../src/worker.ts'
const state = vi.hoisted(() => ({ wrongManifest: false, cleanupPath: '', cleanupError: new Error('image cleanup denied'),
  events: [] as string[], fonts: [] as unknown[] }))
vi.mock('../src/engine.ts', () => ({ ENGINE_VERSION: 'test', resolveEngine: async () => ({ backend: 'wasm' }) }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: (...args: Parameters<typeof actual.rm>) => args[0] === state.cleanupPath ? Promise.reject(state.cleanupError) : actual.rm(...args) }
})
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  stdout = { resume() {} }; stderr = { resume() {} }
  constructor(_url: URL, options: { workerData: WorkerRequest }) {
    super()
    const data = options.workerData
    state.events.push('start'); state.fonts.push(data.fontFaces)
    setTimeout(() => {
      this.emit('message', { kind: 'fonts', faces: [] })
      this.emit('message', state.wrongManifest ? { ok: true, output: new Uint8Array([1]), missingFonts: [] }
        : { ok: true, images: { schemaVersion: 1, backend: 'wasm', source: 'saved', rasterEngine: 'pdfium', images: [], inputPath: data.operation.inputPath } })
    }, 1)
  }
  async terminate() { state.events.push('terminate'); return 0 }
} }))
const roots: string[] = []
let testFontFamily = ''
let testIndex = 0
beforeEach(() => { testFontFamily = `image-ownership-${testIndex++}` })
afterEach(async () => {
  state.wrongManifest = false; state.cleanupPath = ''; state.events = []; state.fonts = []
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kit-image-ownership-')); roots.push(root)
  const inputPath = join(root, 'in.docx'); await writeFile(inputPath, 'fixture inspected by worker')
  return { inputPath, outputDir: join(root, 'images') }
}
const converterOptions = () => ({ fontDirectories: [], initialFontFamilies: [testFontFamily] })
it('rejects image results for export requests and removes the owned export file', async () => {
  const request = await fixture(), outputPath = `${request.inputPath}.pdf`, converter = await createConverter(converterOptions())
  try {
    await expect(converter.convert({ inputPath: request.inputPath, outputPath })).rejects.toThrow(/image batch for an export/)
    await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state.events).toEqual(['start', 'terminate'])
  } finally { await converter.dispose() }
})
it('rejects an image worker without its manifest and removes its owned directory', async () => {
  const request = await fixture(), converter = await createConverter(converterOptions())
  state.wrongManifest = true
  try {
    await expect(converter.renderImages(request)).rejects.toThrow(/did not return its manifest/)
    await expect(stat(request.outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(state.events).toEqual(['start', 'terminate'])
  } finally { await converter.dispose() }
})
it('starts queued batches only after prior worker cleanup and reuses the returned font snapshot', async () => {
  const first = await fixture(), second = { ...first, outputDir: `${first.outputDir}-second` }, converter = await createConverter(converterOptions())
  try {
    const result = await Promise.all([converter.renderImages(first), converter.renderImages(second)])
    expect(state.events).toEqual(['start', 'terminate', 'start', 'terminate'])
    expect(state.fonts).toEqual([undefined, []])
    for (let index = 0; index < 2; index++)
      expect(JSON.parse(await readFile(join([first, second][index]!.outputDir, 'manifest.json'), 'utf8'))).toEqual(result[index])
  } finally { await converter.dispose() }
})
it('reports cleanup failures with their exact cause and still releases the converter slot', async () => {
  const request = await fixture(), converter = await createConverter(converterOptions())
  state.wrongManifest = true; state.cleanupPath = request.outputDir
  try {
    await expect(converter.renderImages(request)).rejects.toMatchObject({ name: 'AggregateError', message: 'Image batch cleanup failed.', errors: [state.cleanupError] })
    state.wrongManifest = false; state.cleanupPath = ''
    await expect(converter.renderImages({ ...request, outputDir: `${request.outputDir}-next` })).resolves.toMatchObject({ source: 'saved' })
    expect(state.events).toEqual(['start', 'terminate', 'start', 'terminate'])
  } finally { await converter.dispose() }
})
