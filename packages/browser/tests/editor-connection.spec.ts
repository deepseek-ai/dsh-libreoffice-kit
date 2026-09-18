import { afterEach, expect, it, vi } from 'vitest'
import { openEditor } from '../src/editor.ts'
import type { BrowserEditorCapture, BrowserEditorOptions, BrowserEditorState } from '../src/editor-types.ts'
import type { OwnerMessage, WorkerMessage } from '../src/protocol.ts'

const state: BrowserEditorState = { documentType: 'text', revision: 0, renderGeneration: 0, part: 0,
  parts: [{ name: '', width: 816, height: 1056 }], pages: [], cursor: null, cursorVisible: false,
  selection: [], graphicSelection: null, cellAddress: '', cellFormula: '', commands: {} }
const request = { generation: 0, maxPixels: 1, tiles: [{ request: { part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 } }] }
const capture: BrowserEditorCapture = { state, tiles: [{ width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) }],
  regions: [{ part: 0, rectangle: { x: 0, y: 0, width: 1, height: 1 } }] }

class EditorWorker {
  static instances: EditorWorker[] = []
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly messages: OwnerMessage[] = []
  terminated = false
  constructor() { EditorWorker.instances.push(this) }
  postMessage(message: OwnerMessage, transfer: Transferable[] = []): void {
    const copy = structuredClone(message, { transfer })
    this.messages.push(copy)
    if (copy.type === 'open') queueMicrotask(() => this.receive({ type: 'opened', id: copy.id, pages: state.parts, editor: state }))
    if (copy.type === 'dispose') queueMicrotask(() => this.receive({ type: 'disposed', id: copy.id }))
  }
  receive(message: WorkerMessage): void { this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>) }
  terminate(): void { this.terminated = true }
}

function options(): BrowserEditorOptions {
  vi.stubGlobal('Worker', EditorWorker)
  vi.stubGlobal('crossOriginIsolated', true)
  return { data: new Uint8Array([1]), extension: 'docx', timeoutMs: 1000, maxArchiveEntries: 100,
    maxUncompressedBytes: 1024, maxLoadedFontBytes: 1024, fontFallbacks: [], resolveFonts: async () => ({ fonts: [] }),
    assets: { workerUrl: '/worker.js', loaderUrl: '/soffice.js', dataUrl: '/soffice.data', wasmUrl: '/soffice.wasm',
      metadataUrl: '/soffice.data.js.metadata', programDirectory: '/instdir/program' } }
}
afterEach(() => { vi.unstubAllGlobals(); EditorWorker.instances = [] })

it.each(['doc', 'xls', 'ppt'] as const)('requires explicit readOnly for legacy %s before creating a Worker', async extension => {
  const input = { ...options(), extension }
  for (const mode of [{}, { readOnly: false }, { readOnly: undefined }]) {
    await expect(openEditor({ ...input, ...mode } as BrowserEditorOptions)).rejects.toMatchObject({ code: 'invalid-document', message: 'Legacy Office documents require readOnly mode.' })
  }
  expect(EditorWorker.instances).toHaveLength(0)
  const editor = await openEditor({ ...input, readOnly: true })
  const worker = EditorWorker.instances[0]!
  try {
    expect(worker.messages[0]).toMatchObject({ type: 'open', editing: true, options: { extension, readOnly: true } })
  } finally { await editor.dispose() }
  expect(worker.terminated).toBe(true)
})

it('preserves an explicit writable mode and omits an unspecified mode at the Worker boundary', async () => {
  for (const mode of [{ readOnly: false }, { readOnly: undefined }]) {
    const editor = await openEditor({ ...options(), ...mode } as BrowserEditorOptions)
    const worker = EditorWorker.instances.at(-1)!
    try {
      const open = worker.messages[0]!
      if (open.type !== 'open') throw new Error('Expected open request.')
      if (mode.readOnly === false) expect(open.options.readOnly).toBe(false)
      else expect(open.options).not.toHaveProperty('readOnly')
    } finally { await editor.dispose() }
  }
})

it('returns an immutable capture response and rejects an unexpected response without closing the editor', async () => {
  const editor = await openEditor(options())
  const worker = EditorWorker.instances[0]!
  try {
    const first = editor.capture(request)
    expect(worker.messages.at(-1)).toMatchObject({ type: 'capture', request })
    worker.receive({ type: 'captured', id: worker.messages.at(-1)!.id, capture })
    expect(await first).toBe(capture)
    const invalid = expect(editor.capture(request)).rejects.toMatchObject({ code: 'render-failed', message: 'LibreOffice returned an unexpected capture response.' })
    worker.receive({ type: 'edited', id: worker.messages.at(-1)!.id })
    await invalid
    const next = editor.capture(request)
    worker.receive({ type: 'captured', id: worker.messages.at(-1)!.id, capture })
    expect(await next).toBe(capture)
  } finally { await editor.dispose() }
})

it('discards a cancelled capture result while preserving the document and later requests', async () => {
  const editor = await openEditor(options())
  const worker = EditorWorker.instances[0]!
  try {
    const cancelled = new AbortController()
    const failure = expect(editor.capture(request, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const first = worker.messages.at(-1)!
    cancelled.abort()
    await failure
    worker.receive({ type: 'captured', id: first.id, capture })
    const next = editor.capture(request)
    worker.receive({ type: 'captured', id: worker.messages.at(-1)!.id, capture })
    expect(await next).toBe(capture)
    expect(worker.terminated).toBe(false)
  } finally { await editor.dispose() }
})
