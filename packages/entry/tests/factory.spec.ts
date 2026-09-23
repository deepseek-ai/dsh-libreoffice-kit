/** Converter factories share bounded font state across independent serial converters. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConverter, createConverterFactory } from '../src/index.ts'
import type { WorkerRequest } from '../src/worker.ts'

vi.mock('../src/engine.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/engine.ts')>(),
  resolveEngine: async () => ({ backend: 'wasm' }),
}))

const observations = vi.hoisted(() => [] as WorkerRequest[])
const scans = vi.hoisted(() => ({ count: 0 }))
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    stdout = { resume() {} }
    stderr = { resume() {} }
    constructor(entry: URL, options: { workerData: WorkerRequest }) {
      super()
      if (entry.pathname.endsWith('/font-snapshot-worker.js')) {
        scans.count++
        queueMicrotask(() => this.emit('message', { ok: true, snapshot: { generation: 'fixture', records: [], faces: [{
          path: '/font.ttf', size: 4, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1, faceIndex: 0,
          family: 'Fixture', style: 'Regular', aliases: ['fixture'], weight: 400, width: 5,
          italic: false, fixed: false, postscriptName: 'Fixture',
        }] } }))
        return
      }
      const turn = observations.length
      observations.push(options.workerData)
      queueMicrotask(() => {
        this.emit('message', { kind: 'font-cache', entries: [{
          key: turn < 2 ? '{"family":"Fixture"}' : '{"family":"Other"}',
          codePoints: [65 + turn], emptyRequest: false,
          faces: [{ path: '/font.ttf', faceIndex: 0 }],
        }] })
        this.emit('message', { ok: true, output: Buffer.from('%PDF-1.7 fixture'), missingFonts: [] })
      })
    }
    async terminate(): Promise<number> { return 0 }
  },
}))

const roots: string[] = []
afterEach(async () => {
  observations.length = 0
  scans.count = 0
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('shares font faces and match entries across converters and rejects creation after disposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-kit-factory-'))
  roots.push(root)
  const inputPath = join(root, 'input.docx')
  await writeFile(inputPath, 'fixture')
  const factory = await createConverterFactory({ fontDirectories: [], maxFontResolutionEntries: 1 })
  const first = await factory.create()
  const second = await factory.create()
  const third = await factory.create()
  const fourth = await factory.create()
  await first.render({ inputPath, outputPath: join(root, 'first.pdf') })
  await second.render({ inputPath, outputPath: join(root, 'second.pdf') })
  await third.render({ inputPath, outputPath: join(root, 'third.pdf') })
  await fourth.render({ inputPath, outputPath: join(root, 'fourth.pdf') })
  expect(observations[0]!.fontFaces).toHaveLength(1)
  expect(observations[0]!.fontCache).toEqual([])
  expect(observations[1]!.fontFaces).toHaveLength(1)
  expect(observations[1]!.fontCache).toEqual([expect.objectContaining({ codePoints: [65] })])
  expect(observations[2]!.fontCache).toEqual([expect.objectContaining({ codePoints: [65, 66] })])
  expect(observations[3]!.fontCache).toEqual([expect.objectContaining({ key: '{"family":"Other"}', codePoints: [67] })])
  expect(scans.count).toBe(4)
  await factory.dispose()
  await expect(factory.create()).rejects.toMatchObject({ code: 'unavailable' })
})

it('joins every converter and aggregates factory disposal failures', async () => {
  const factory = await createConverterFactory({ fontDirectories: [] })
  const first = await factory.create(), second = await factory.create()
  const firstFailure = new Error('first disposal failed'), secondFailure = new Error('second disposal failed')
  Object.defineProperty(first, 'dispose', { value: vi.fn().mockRejectedValue(firstFailure) })
  Object.defineProperty(second, 'dispose', { value: vi.fn().mockRejectedValue(secondFailure) })
  await expect(factory.dispose()).rejects.toMatchObject({ errors: [firstFailure, secondFailure] })
})

it('shares bounded font state across compatibility converters without a caller-owned factory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-kit-compatible-factory-'))
  roots.push(root)
  const inputPath = join(root, 'input.docx')
  await writeFile(inputPath, 'fixture')
  const options = { fontDirectories: [], initialFontFamilies: ['standalone-shared-state'], maxFontResolutionEntries: 2 }
  const first = await createConverter(options)
  await first.render({ inputPath, outputPath: join(root, 'first.pdf') })
  await first.dispose()
  const second = await createConverter(options)
  await second.render({ inputPath, outputPath: join(root, 'second.pdf') })
  await second.dispose()
  expect(observations[0]!.fontFaces).toHaveLength(1)
  expect(observations[0]!.fontCache).toEqual([])
  expect(observations[1]!.fontFaces).toHaveLength(1)
  expect(observations[1]!.fontCache).toEqual([expect.objectContaining({ codePoints: [65] })])

  const isolated = await createConverter({ ...options, initialFontFamilies: ['standalone-isolated-state'] })
  await isolated.render({ inputPath, outputPath: join(root, 'isolated.pdf') })
  await isolated.dispose()
  expect(observations[2]!.fontFaces).toHaveLength(1)
  expect(observations[2]!.fontCache).toEqual([])
})

it('bounds the number of compatibility configurations retained by the process', async () => {
  const converters = await Promise.all(Array.from({ length: 17 }, async (_, index) =>
    createConverter({ fontDirectories: [], initialFontFamilies: [`bounded-compatible-state-${index}`] })))
  await Promise.all(converters.map(converter => converter.dispose()))
})
