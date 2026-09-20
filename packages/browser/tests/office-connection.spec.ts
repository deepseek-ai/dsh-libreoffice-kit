import { afterEach, expect, it, vi } from 'vitest'
import { openOfficeDocument } from '../src/office.ts'
import type { OfficeDocumentOptions, OfficeDocumentState } from '../src/office-types.ts'
import type { OwnerMessage, WorkerMessage } from '../src/protocol.ts'

const state: OfficeDocumentState = { documentType: 'text', renderGeneration: 0, layoutGeneration: 0, layout: 'paginated', part: 0,
  parts: [{ name: '', width: 816, height: 1056 }], pages: [], cursor: null,
  selection: [], graphicSelection: null, cellAddress: '', cellFormula: '' }
class ReadingWorker {
  static instances: ReadingWorker[] = []
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly messages: OwnerMessage[] = []
  terminated = false
  constructor() { ReadingWorker.instances.push(this) }
  postMessage(message: OwnerMessage, transfer: Transferable[] = []): void {
    const copy = structuredClone(message, { transfer }); this.messages.push(copy)
    if (copy.type === 'open') queueMicrotask(() => this.receive({ type: 'opened', id: copy.id, pages: state.parts, office: state }))
    if (copy.type === 'dispose') queueMicrotask(() => this.receive({ type: 'disposed', id: copy.id }))
  }
  receive(message: WorkerMessage): void { this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>) }
  terminate(): void { this.terminated = true }
}
function options(): OfficeDocumentOptions {
  vi.stubGlobal('Worker', ReadingWorker); vi.stubGlobal('crossOriginIsolated', true)
  return { data: new Uint8Array([1]), extension: 'docx', timeoutMs: 1000, maxArchiveEntries: 100,
    maxUncompressedBytes: 1024, maxLoadedFontBytes: 1024, fontFallbacks: [], resolveFonts: async () => ({ fonts: [] }),
    assets: { workerUrl: '/worker.js', loaderUrl: '/soffice.js', dataUrl: '/soffice.data', wasmUrl: '/dsh-office.wasm',
      metadataUrl: '/soffice.data.js.metadata', programDirectory: '/instdir/program' } }
}
afterEach(() => { vi.unstubAllGlobals(); ReadingWorker.instances = [] })
it('propagates a stale-part tile rejection without closing the reading session', async () => {
  const document = await openOfficeDocument(options()), worker = ReadingWorker.instances[0]!
  try {
    const request = { part: 1, x: 0, y: 0, width: 1, height: 1, scale: 1 }
    const stale = expect(document.renderTile(request)).rejects.toMatchObject({ code: 'stale-part' })
    worker.receive({ type: 'error', id: worker.messages.at(-1)!.id, code: 'stale-part', message: 'Inactive part', fatal: false })
    await stale
    expect(worker.terminated).toBe(false)
    const current = document.renderTile({ ...request, part: 0 })
    const tile = { width: 1, height: 1, rgba: new Uint8ClampedArray(4) }
    worker.receive({ type: 'tile', id: worker.messages.at(-1)!.id, tile })
    expect(await current).toEqual(tile)
  } finally { await document.dispose() }
})
it.each(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] as const)('opens %s without an editable mode or legacy opt-in', async extension => {
  const document = await openOfficeDocument({ ...options(), extension, readOnly: false } as OfficeDocumentOptions)
  const worker = ReadingWorker.instances[0]!
  try {
    expect(worker.messages[0]).toMatchObject({ type: 'open', office: true, options: { extension } })
    expect(worker.messages[0]).not.toHaveProperty('options.readOnly')
  } finally { await document.dispose() }
  expect(worker.terminated).toBe(true)
})
it('coalesces pending layouts to the newest width and resolves every caller with the actual result', async () => {
  const document = await openOfficeDocument(options()), worker = ReadingWorker.instances[0]!
  try {
    const first = document.setLayout({ mode: 'continuous', width: 700 })
    const second = document.setLayout({ mode: 'continuous', width: 600 })
    const third = document.setLayout({ mode: 'continuous', width: 500, anchor: { x: 3, y: 300 } })
    expect(worker.messages.filter(message => message.type === 'office-operation')).toHaveLength(1)
    worker.receive({ type: 'office-result', id: worker.messages.at(-1)!.id, layout: { changed: true } })
    await first
    expect(worker.messages.filter(message => message.type === 'office-operation')).toHaveLength(2)
    expect(worker.messages.at(-1)).toMatchObject({ operation: { type: 'layout', request: { mode: 'continuous', width: 500 } } })
    const result = { changed: true, anchor: { x: 3, y: 450, width: 2, height: 20 } }
    worker.receive({ type: 'office-result', id: worker.messages.at(-1)!.id, layout: result })
    expect(await second).toEqual(result); expect(await third).toEqual(result)
  } finally { await document.dispose() }
})
it('rejects missing layout receipts and permits a later layout request', async () => {
  const document = await openOfficeDocument(options()), worker = ReadingWorker.instances[0]!
  try {
    const invalid = expect(document.setLayout({ mode: 'continuous', width: 500 })).rejects.toMatchObject({ code: 'render-failed' })
    worker.receive({ type: 'office-result', id: worker.messages.at(-1)!.id }); await invalid
    const next = document.setLayout({ mode: 'paginated' })
    worker.receive({ type: 'office-result', id: worker.messages.at(-1)!.id, layout: { changed: false } })
    expect(await next).toEqual({ changed: false })
  } finally { await document.dispose() }
})
it('settles all pending layout requests on disposal', async () => {
  const document = await openOfficeDocument(options())
  const pending = [500, 600, 700].map(width => expect(document.setLayout({ mode: 'continuous', width })).rejects.toMatchObject({ code: 'disposed' }))
  await document.dispose(); await Promise.all(pending)
})
