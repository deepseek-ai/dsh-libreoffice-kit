/** Compatibility converters transparently share bounded process-local font metadata. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConverter } from '../src/index.ts'
import type { WorkerRequest } from '../src/worker.ts'

vi.mock('../src/engine.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/engine.ts')>(),
  resolveEngine: async () => ({ backend: 'wasm' }),
}))

const observations = vi.hoisted(() => [] as WorkerRequest[])
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    stdout = { resume() {} }
    stderr = { resume() {} }
    constructor(_entry: URL, options: { workerData: WorkerRequest }) {
      super()
      const turn = observations.length
      observations.push(options.workerData)
      queueMicrotask(() => {
        if (options.workerData.fontFaces === undefined) this.emit('message', { kind: 'fonts', faces: [{
          path: '/font.ttf', size: 4, mtimeMs: 1, ctimeMs: 1, dev: 1, ino: 1, faceIndex: 0,
          family: 'Fixture', style: 'Regular', aliases: ['fixture'], weight: 400, width: 5,
          italic: false, fixed: false, decorative: false, postscriptName: 'Fixture', coverage: [[0, 0x10ffff]],
        }] })
        this.emit('message', { kind: 'font-cache', entries: [{
          key: '{"family":"Fixture"}', codePoints: [65 + turn], emptyRequest: false,
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
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('reuses font faces and covered matches across separately created converters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'libreoffice-kit-compatible-cache-'))
  roots.push(root)
  const inputPath = join(root, 'input.docx')
  await writeFile(inputPath, 'fixture')
  const options = { fontDirectories: [], initialFontFamilies: ['transparent-cache-test'], maxFontResolutionEntries: 2 }
  const first = await createConverter(options)
  await first.render({ inputPath, outputPath: join(root, 'first.pdf') })
  await first.dispose()
  const second = await createConverter(options)
  await second.render({ inputPath, outputPath: join(root, 'second.pdf') })
  await second.dispose()
  expect(observations[0]!.fontFaces).toBeUndefined()
  expect(observations[0]!.fontCache).toEqual([])
  expect(observations[1]!.fontFaces).toHaveLength(1)
  expect(observations[1]!.fontCache).toEqual([expect.objectContaining({ codePoints: [65] })])

  const isolated = await createConverter({ ...options, initialFontFamilies: ['isolated-cache-test'] })
  await isolated.render({ inputPath, outputPath: join(root, 'isolated.pdf') })
  await isolated.dispose()
  expect(observations[2]!.fontFaces).toBeUndefined()
  expect(observations[2]!.fontCache).toEqual([])
})

it('bounds the number of retained compatibility configurations', async () => {
  const converters = await Promise.all(Array.from({ length: 17 }, async (_, index) =>
    createConverter({ fontDirectories: [], initialFontFamilies: [`bounded-cache-${index}`] })))
  await Promise.all(converters.map(converter => converter.dispose()))
})
