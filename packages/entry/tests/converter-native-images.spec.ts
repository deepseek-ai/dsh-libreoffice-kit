/** Native image requests route worker-selected fonts into the operation-owned helper. */
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createConverter } from '../src/index.ts'
import type { WorkerRequest } from '../src/worker.ts'

const native = vi.hoisted(() => ({ render: vi.fn() }))
vi.mock('../src/engine.ts', () => ({
  ENGINE_VERSION: 'test',
  resolveEngine: async () => ({ backend: 'native', root: '/engine', executable: '/engine/helper', programDirectory: '/engine/program' }),
}))
vi.mock('../src/native-image-renderer.ts', () => ({ renderImagesWithNative: native.render }))
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  stdout = { resume() {} }; stderr = { resume() {} }
  constructor(entry: URL, options: { workerData: WorkerRequest }) {
    super()
    queueMicrotask(() => {
      if (entry.pathname.endsWith('/font-snapshot-worker.js')) {
        this.emit('message', { ok: true, snapshot: { faces: [], records: [], generation: 'empty' } })
        return
      }
      this.emit('message', { kind: 'font-cache', entries: [] })
      this.emit('message', { ok: true, fonts: ['/font.ttf'], substitutions: [], missingFonts: ['Missing'] })
    })
  }
  async terminate() { return 0 }
} }))

const roots: string[] = []
afterEach(async () => {
  native.render.mockReset()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

it('passes native font selection and source bytes to direct rendering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kit-native-image-route-')); roots.push(root)
  const inputPath = join(root, 'input.docx'), outputDir = join(root, 'images')
  await writeFile(inputPath, 'document')
  native.render.mockImplementation(async request => ({
    schemaVersion: 1, backend: 'native', rasterEngine: 'libreoffice', source: 'saved',
    inputPath: request.operation.inputPath, sourceSha256: '0'.repeat(64), dpi: request.operation.dpi,
    pageCount: 1, images: [], missingFonts: request.missingFonts,
  }))
  const converter = await createConverter({ fontDirectories: [] })
  try {
    await expect(converter.renderImages({ inputPath, outputDir })).resolves.toMatchObject({
      backend: 'native', missingFonts: ['Missing'],
    })
    expect(native.render).toHaveBeenCalledWith(expect.objectContaining({
      fonts: ['/font.ttf'], missingFonts: ['Missing'], source: Buffer.from('document'),
    }))
  } finally { await converter.dispose() }
})
