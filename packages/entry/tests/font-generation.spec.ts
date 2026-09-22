/** Late conversion results cannot repopulate a newer catalog's matching cache. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConverterFactory } from '../src/index.ts'
import type { ConverterFactory } from '../src/index.ts'
import type { WorkerRequest } from '../src/worker.ts'

const control = vi.hoisted(() => ({ queue: [] as FakeWorker[], waiting: [] as ((worker: FakeWorker) => void)[] }))
class FakeWorker extends EventEmitter {
  stdout = { resume() {} }; stderr = { resume() {} }
  terminate = vi.fn(async () => 0)
  constructor(readonly url: URL, readonly options: { workerData: WorkerRequest }) {
    super()
    const waiting = control.waiting.shift()
    if (waiting) waiting(this); else control.queue.push(this)
  }
  snapshot(generation: string): void { this.emit('message', { ok: true, snapshot: { generation, records: [], faces: [] } }) }
  finish(key: string): void {
    this.emit('message', { kind: 'font-cache', entries: [{ key, faces: [], codePoints: [65], emptyRequest: false }] })
    this.emit('message', { ok: true, output: Buffer.from('%PDF-1.7 fixture'), missingFonts: [] })
  }
}
vi.mock('node:worker_threads', () => ({ Worker: class { constructor(...args: ConstructorParameters<typeof FakeWorker>) { return new FakeWorker(...args) } } }))
vi.mock('../src/engine.ts', async original => ({ ...await original<typeof import('../src/engine.ts')>(), resolveEngine: async () => ({ backend: 'wasm' }) }))
const roots: string[] = [], factories: ConverterFactory[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(factories.splice(0).map(factory => factory.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  control.queue.length = 0; control.waiting.length = 0
})
async function next(): Promise<FakeWorker> {
  const worker = control.queue.shift()
  return worker ?? new Promise(resolve => control.waiting.push(resolve))
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'kit-generation-')); roots.push(root)
  const inputPath = join(root, 'input.docx'); await writeFile(inputPath, 'fixture')
  const factory = await createConverterFactory({ fontDirectories: [], fontMetadataCacheDirectory: false, timeoutMs: 1000 }); factories.push(factory)
  return { root, inputPath, factory }
}

it('drops late match results from an old generation and retains the new generation entries', async () => {
  const { root, inputPath, factory } = await setup()
  const first = await factory.create(), second = await factory.create()
  const a = first.render({ inputPath, outputPath: join(root, 'a.pdf') })
  ;(await next()).snapshot('A'); const conversionA = await next()
  const b = second.render({ inputPath, outputPath: join(root, 'b.pdf') })
  ;(await next()).snapshot('B'); const conversionB = await next()
  expect(conversionB.options.workerData.fontCache).toEqual([])
  conversionB.finish('new'); await b
  conversionA.finish('old'); await a
  const c = second.render({ inputPath, outputPath: join(root, 'c.pdf') })
  ;(await next()).snapshot('B'); const conversionC = await next()
  expect(conversionC.options.workerData.fontCache?.map(entry => entry.key)).toEqual(['new'])
  conversionC.finish('new'); await c
})

it('times out metadata work, joins its Worker, removes output, and permits retry', async () => {
  const { root, inputPath, factory } = await setup(), converter = await factory.create()
  vi.useFakeTimers()
  const outputPath = join(root, 'timeout.pdf')
  const pending = converter.render({ inputPath, outputPath }), rejected = expect(pending).rejects.toMatchObject({ code: 'timeout' })
  const worker = await next()
  await vi.advanceTimersByTimeAsync(1000); await rejected
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  vi.useRealTimers()
  const retry = converter.render({ inputPath, outputPath })
  ;(await next()).snapshot('retry'); (await next()).finish('retry'); await retry
})

it('factory disposal cancels metadata work and waits for owned output cleanup', async () => {
  const { root, inputPath, factory } = await setup(), converter = await factory.create()
  const outputPath = join(root, 'disposed.pdf')
  const pending = converter.render({ inputPath, outputPath }), rejected = expect(pending).rejects.toThrow('disposed')
  const worker = await next()
  await factory.dispose(); await rejected
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes conversion output when a snapshot source changes during engine work', async () => {
  const { root, inputPath, factory } = await setup(), converter = await factory.create()
  const path = join(root, 'font.ttf'); await writeFile(path, 'font')
  const { dev, ino, size, mtimeMs, ctimeMs } = await stat(path)
  const outputPath = join(root, 'changed.pdf')
  const pending = converter.render({ inputPath, outputPath }), rejected = expect(pending).rejects.toThrow('changed during conversion')
  ;(await next()).emit('message', { ok: true, snapshot: { generation: 'one', faces: [], records: [{ path, dev, ino, size, mtimeMs, ctimeMs, faces: [] }] } })
  const conversion = await next(); await writeFile(path, 'replaced-font'); conversion.finish('old'); await rejected
  await expect(stat(outputPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('removes a direct-image batch when its snapshot source changes', async () => {
  const { root, inputPath, factory } = await setup(), converter = await factory.create()
  const path = join(root, 'font.ttf'); await writeFile(path, 'font')
  const { dev, ino, size, mtimeMs, ctimeMs } = await stat(path)
  const outputDir = join(root, 'changed-images')
  const pending = converter.renderImages({ inputPath, outputDir }), rejected = expect(pending).rejects.toThrow('changed during conversion')
  ;(await next()).emit('message', { ok: true, snapshot: { generation: 'one', faces: [], records: [{ path, dev, ino, size, mtimeMs, ctimeMs, faces: [] }] } })
  const conversion = await next(); await writeFile(path, 'replaced-font')
  conversion.emit('message', { ok: true, images: { schemaVersion: 1, backend: 'wasm', rasterEngine: 'libreoffice',
    source: 'saved', inputPath, sourceSha256: '0'.repeat(64), dpi: 144, pageCount: 1, images: [], missingFonts: [] } })
  await rejected
  await expect(stat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
})
