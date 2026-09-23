import { afterEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConverter } from '../src/index.ts'
import type { WorkerRequest } from '../src/worker.ts'
const state = vi.hoisted(() => ({ behavior: 'ok', terminated: false,
  started: undefined as (() => void) | undefined }))
vi.mock('../src/engine.ts', () => ({ ENGINE_VERSION: 'test', resolveEngine: async () => ({ backend: 'wasm' }) }))
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough()
  snapshot: boolean
  constructor(entry: URL, options: { workerData: WorkerRequest }) {
    super()
    this.snapshot = entry.pathname.endsWith('/font-snapshot-worker.js')
    if (this.snapshot) {
      queueMicrotask(() => this.emit('message', { ok: true, snapshot: { faces: [], records: [], generation: 'empty' } }))
      return
    }
    state.started?.()
    state.started = undefined
    const data = options.workerData
    if (!('kind' in data.operation)) throw new Error('Wrong worker operation')
    const operation = data.operation
    setTimeout(() => { void (async () => {
      await writeFile(join(operation.outputDir, 'page-0001.png'), 'partially written image')
      if (state.behavior === 'hang') return
      if (state.behavior === 'fail') this.emit('message', { ok: false, code: 'failed', error: 'render failed' })
      else this.emit('message', { ok: true, images: { schemaVersion: 1, backend: 'wasm', rasterEngine: 'pdfium', source: 'saved', images: [], inputPath: operation.inputPath } })
    })() }, 5)
  }
  async terminate() { await new Promise(resolve => setTimeout(resolve, 5)); if (!this.snapshot) state.terminated = true; return 0 }
} }))
const roots: string[] = []
afterEach(async () => { state.behavior = 'ok'; state.terminated = false; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'kit-render-owned-')); roots.push(root)
  const inputPath = join(root, 'in.pdf'); await writeFile(inputPath, '%PDF-1.7 fixture')
  return { inputPath, outputDir: join(root, 'images') }
}
it('returns and persists one manifest after worker exit', async () => {
  const request = await fixture(), converter = await createConverter({ fontDirectories: [] })
  try {
    const result = await converter.renderImages(request)
    expect(state.terminated).toBe(true)
    expect(JSON.parse(await readFile(join(request.outputDir, 'manifest.json'), 'utf8'))).toEqual(result)
  } finally { await converter.dispose() }
})
it.each(['fail', 'hang'])('removes the complete owned partial directory after %s and worker termination', async (behavior) => {
  const request = await fixture(), converter = await createConverter({ timeoutMs: 40, fontDirectories: [] })
  state.behavior = behavior
  try {
    await expect(converter.renderImages(request)).rejects.toThrow(behavior === 'hang' ? /timed out/ : /render failed/)
    expect(state.terminated).toBe(true)
    await expect(stat(request.outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await converter.dispose() }
})
it('never removes a pre-existing directory or admits a cancelled request', async () => {
  const request = await fixture(), converter = await createConverter()
  await mkdir(request.outputDir); await writeFile(join(request.outputDir, 'keep'), 'owned by caller')
  try {
    await expect(converter.renderImages(request)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readdir(request.outputDir)).toEqual(['keep'])
    await expect(converter.renderImages({ ...request, outputDir: `${request.outputDir}-cancel` }, AbortSignal.abort(new Error('cancelled')))).rejects.toThrow(/cancelled/)
    expect(state.terminated).toBe(false)
  } finally { await converter.dispose() }
})
it('disposal aborts an in-flight batch and waits until its worker exits', async () => {
  const request = await fixture(), converter = await createConverter()
  state.behavior = 'hang'
  const converting = new Promise<void>(resolve => { state.started = resolve })
  const pending = converter.renderImages(request)
  await converting
  const rejected = expect(pending).rejects.toThrow(/disposed/)
  await converter.dispose(); await rejected
  expect(state.terminated).toBe(true)
  await expect(stat(request.outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
})
