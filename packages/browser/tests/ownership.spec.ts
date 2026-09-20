import { afterEach, describe, expect, it, vi } from 'vitest'
import { openDocument } from '../src/index.ts'
import { openOfficeDocument } from '../src/office.ts'
import { prepareOfficeBrowser } from '../src/preparation.ts'
import type { OfficeDocumentState } from '../src/office-types.ts'
import type { BrowserDocumentOptions } from '../src/types.ts'
import { FONT_CHUNK_BYTES, FontState } from '../src/protocol.ts'
import { fontViews } from '../src/font-channel.ts'
import type { OwnerMessage, WorkerMessage } from '../src/protocol.ts'

class ControlledWorker {
  static instances: ControlledWorker[] = []
  static opening: ((worker: ControlledWorker, message: Extract<OwnerMessage, { type: 'open' }>) => void) | undefined
  static holdDispose = false
  static throwPost = false
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  readonly messages: OwnerMessage[] = []
  terminated = false
  constructor() { ControlledWorker.instances.push(this) }
  postMessage(message: OwnerMessage, transfer: Transferable[] = []): void {
    if (ControlledWorker.throwPost) throw new Error('transport unavailable')
    const copy = structuredClone(message, { transfer })
    this.messages.push(copy)
    if (copy.type === 'open') queueMicrotask(() => { if (ControlledWorker.opening) ControlledWorker.opening(this, copy); else this.receive({ type: 'opened', id: copy.id, pages: [{ width: 816, height: 1056 }] }) })
    if (copy.type === 'dispose' && !ControlledWorker.holdDispose) queueMicrotask(() => this.receive({ type: 'disposed', id: copy.id }))
  }
  receive(message: WorkerMessage): void { this.onmessage?.({ data: message } as MessageEvent<WorkerMessage>) }
  terminate(): void { this.terminated = true }
}
const options = (): BrowserDocumentOptions => ({ data: new Uint8Array([1, 2, 3]), extension: 'pdf', assets: { workerUrl: '/worker.js', loaderUrl: '/soffice.js', dataUrl: '/soffice.data', wasmUrl: '/dsh-office.wasm', metadataUrl: '/soffice.data.js.metadata', programDirectory: '/instdir/program' }, timeoutMs: 10_000, maxArchiveEntries: 10000, maxUncompressedBytes: 128 * 1024 * 1024, maxLoadedFontBytes: 1024, fontFallbacks: [], resolveFonts: async () => ({ fonts: [] }) })
function supported(): void { vi.stubGlobal('Worker', ControlledWorker); vi.stubGlobal('crossOriginIsolated', true) }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); ControlledWorker.instances = []; ControlledWorker.opening = undefined; ControlledWorker.holdDispose = false; ControlledWorker.throwPost = false })

describe('browser document ownership', () => {
  it('rejects unsupported isolation before creating an engine', async () => {
    supported()
    vi.stubGlobal('crossOriginIsolated', false)
    await expect(openDocument(options())).rejects.toMatchObject({ code: 'unavailable' })
    expect(ControlledWorker.instances).toHaveLength(0)
  })
  it('copies borrowed document bytes and awaits idempotent Worker disposal', async () => {
    supported()
    const input = options()
    const document = await openDocument(input)
    expect([...input.data]).toEqual([1, 2, 3])
    const worker = ControlledWorker.instances[0]!
    const opened = worker.messages[0]!
    expect(opened.type).toBe('open')
    if (opened.type === 'open') expect([...opened.options.data]).toEqual([1, 2, 3])
    const first = document.dispose()
    expect(document.dispose()).toBe(first)
    await first
    expect(worker.terminated).toBe(true)
    await expect(document.renderTile({ pageIndex: 0, x: 0, y: 0, width: 10, height: 10, scale: 1 })).rejects.toMatchObject({ code: 'disposed' })
  })
  it('clones a matching precompiled module into the document Worker', async () => {
    supported()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0),
      { headers: { 'content-type': 'application/wasm' } })))
    const input = options()
    const preparedEngine = await prepareOfficeBrowser(input.assets)
    const document = await openDocument({ ...input, preparedEngine })
    const opened = ControlledWorker.instances[0]!.messages[0]!
    expect(opened.type).toBe('open')
    if (opened.type === 'open') expect((opened.options.preparedEngine as unknown as { module: unknown }).module)
      .toBeInstanceOf(WebAssembly.Module)
    await document.dispose()
    await expect(openDocument({ ...input, preparedEngine, assets: { ...input.assets, wasmUrl: '/other.wasm' } }))
      .rejects.toThrow(/does not match/)
  })
  it('serializes tiles while cancellation discards only the obsolete result', async () => {
    supported()
    const document = await openDocument(options())
    const worker = ControlledWorker.instances[0]!
    const cancelled = new AbortController()
    const request = { pageIndex: 0, x: 0, y: 0, width: 10, height: 10, scale: 1 }
    const first = document.renderTile(request, cancelled.signal)
    const firstRejected = expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const second = document.renderTile(request)
    await vi.waitFor(() => expect(worker.messages.filter(message => message.type === 'tile')).toHaveLength(1))
    cancelled.abort()
    await firstRejected
    const firstMessage = worker.messages.find(message => message.type === 'tile')!
    worker.receive({ type: 'tile', id: firstMessage.id, tile: { width: 10, height: 10, rgba: new Uint8ClampedArray(400) } })
    await vi.waitFor(() => expect(worker.messages.filter(message => message.type === 'tile')).toHaveLength(2))
    const secondMessage = worker.messages.at(-1)!
    worker.receive({ type: 'tile', id: secondMessage.id, tile: { width: 10, height: 10, rgba: new Uint8ClampedArray(400) } })
    await expect(second).resolves.toMatchObject({ width: 10, height: 10 })
    await document.dispose()
  })
  it('returns a synchronous font-provider failure through the shared channel immediately', async () => {
    supported()
    const document = await openDocument({ ...options(), resolveFonts: () => { throw new Error('Host unavailable') } })
    const worker = ControlledWorker.instances[0]!
    const opened = worker.messages[0]!
    if (opened.type !== 'open') throw new Error('Expected open')
    worker.receive({ type: 'font', known: [], request: { family: 'Arial', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] } })
    await vi.waitFor(() => expect(Atomics.load(new Int32Array(opened.channel, 0, 2), 0)).toBe(FontState.Error))
    await document.dispose()
  })
  it('propagates document cancellation to an asynchronous Host font request', async () => {
    supported()
    const input = options()
    let fontSignal: AbortSignal | undefined
    const document = await openDocument({ ...input, resolveFonts: (_request, _known, signal) => { fontSignal = signal; return new Promise(() => {}) } })
    const worker = ControlledWorker.instances[0]!
    worker.receive({ type: 'font', known: [], request: { family: 'Arial', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] } })
    await Promise.resolve()
    await document.dispose()
    expect(fontSignal?.aborted).toBe(true)
  })
})

const tileRequest = { pageIndex: 0, x: 0, y: 0, width: 10, height: 10, scale: 1 }
const fontRequest = { family: 'Arial', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] }

const readingState: OfficeDocumentState = { documentType: 'text', renderGeneration: 0, layoutGeneration: 0, layout: 'paginated', part: 0,
  parts: [{ name: '', width: 816, height: 1056 }], pages: [], cursor: null, selection: [], graphicSelection: null, cellAddress: '', cellFormula: '' }

function supportedOffice(): void {
  supported()
  ControlledWorker.opening = (worker, message) => worker.receive({ type: 'opened', id: message.id,
    pages: [{ width: 816, height: 1056 }], office: readingState })
}

describe('browser Office ownership', () => {
  it('acknowledges only typed navigation and selection operations through the retained Worker', async () => {
    supportedOffice()
    const document = await openOfficeDocument({ ...options(), extension: 'docx' })
    const worker = ControlledWorker.instances[0]!
    const acknowledge = (): void => { worker.receive({ type: 'office-result', id: worker.messages.at(-1)!.id }) }
    try {
      for (const work of [() => document.pointer({ action: 'down', x: 1, y: 2, buttons: 1, modifiers: 0, clicks: 1 }),
        () => document.navigate({ key: 'right', extend: true }), () => document.selectAll(), () => document.goToCell('B2'),
        () => document.setPart(0), () => document.setViewport({ x: 0, y: 0, width: 100, height: 100 }, 2)]) {
        const promise = work(); acknowledge(); await promise
      }
      const empty = document.copy(); acknowledge(); expect(await empty).toBe('')
      const copied = document.copy()
      worker.receive({ type: 'office-result', id: worker.messages.at(-1)!.id, text: '中文' })
      expect(await copied).toBe('中文')
      const tile = { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) }
      const rendering = document.renderTile({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 })
      worker.receive({ type: 'tile', id: worker.messages.at(-1)!.id, tile })
      expect(await rendering).toBe(tile)
      for (const removed of ['input', 'dispatch', 'paste', 'save', 'capture']) expect(document).not.toHaveProperty(removed)
    } finally { await document.dispose() }
  })
  it('rejects invalid responses and already canceled tiles without closing the model', async () => {
    supportedOffice()
    const document = await openOfficeDocument({ ...options(), extension: 'docx' })
    const worker = ControlledWorker.instances[0]!
    try {
      const failedOperation = expect(document.copy()).rejects.toMatchObject({ code: 'render-failed' })
      worker.receive({ type: 'disposed', id: worker.messages.at(-1)!.id }); await failedOperation
      const failedTile = expect(document.renderTile({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 })).rejects.toMatchObject({ code: 'render-failed' })
      worker.receive({ type: 'office-result', id: worker.messages.at(-1)!.id }); await failedTile
      const cancelled = new AbortController(); cancelled.abort(); const count = worker.messages.length
      await expect(document.renderTile({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 }, cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(worker.messages).toHaveLength(count)
    } finally { await document.dispose() }
  })
  it('closes on a terminal reading event and ignores late notifications', async () => {
    supportedOffice()
    const document = await openOfficeDocument({ ...options(), extension: 'docx' })
    const worker = ControlledWorker.instances[0]!, events = vi.fn()
    document.subscribe(events)
    const pending = expect(document.copy()).rejects.toMatchObject({ code: 'disposed' })
    const error = { type: 'error' as const, code: 'render-failed' as const, message: 'Document engine stopped' }
    worker.receive({ type: 'office-event', event: error })
    worker.receive({ type: 'office-event', event: { type: 'state', state: { ...readingState, renderGeneration: 10 } } })
    await pending; await document.dispose()
    expect(events).toHaveBeenCalledExactlyOnceWith(error)
    expect(document.state.renderGeneration).toBe(0)
    expect(worker.terminated).toBe(true)
  })
  it.each(['error', 'messageerror', 'timeout'] as const)('notifies reading observers of a Worker %s failure', async kind => {
    supportedOffice(); vi.useFakeTimers()
    const document = await openOfficeDocument({ ...options(), extension: 'docx', timeoutMs: 10 })
    const worker = ControlledWorker.instances[0]!, events = vi.fn()
    document.subscribe(events)
    const failure = expect(document.copy()).rejects.toMatchObject({ code: kind === 'timeout' ? 'timeout' : 'render-failed' })
    if (kind === 'error') worker.onerror?.({ message: 'Worker crashed' } as ErrorEvent)
    else if (kind === 'messageerror') worker.onmessageerror?.()
    else await vi.advanceTimersByTimeAsync(10)
    await failure; await document.dispose()
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', code: kind === 'timeout' ? 'timeout' : 'render-failed' }))
    expect(worker.terminated).toBe(true); expect(vi.getTimerCount()).toBe(0)
  })
  it('preserves event order, input byte ownership and idempotent joined disposal', async () => {
    supportedOffice()
    const source = { ...options(), extension: 'docx' as const }, document = await openOfficeDocument(source)
    const worker = ControlledWorker.instances[0]!, events = vi.fn()
    expect(worker.messages[0]).toMatchObject({ type: 'open', office: true })
    expect([...source.data]).toEqual([1, 2, 3])
    const unsubscribe = document.subscribe(events)
    worker.receive({ type: 'office-event', event: { type: 'state', state: { ...readingState, renderGeneration: 1 } } })
    worker.receive({ type: 'office-event', event: { type: 'invalidate', part: 0, rectangle: null, generation: 1 } })
    expect(document.state.renderGeneration).toBe(1); expect(events).toHaveBeenCalledTimes(2)
    unsubscribe()
    worker.receive({ type: 'office-event', event: { type: 'invalidate', part: 0, rectangle: null, generation: 2 } })
    expect(events).toHaveBeenCalledTimes(2)
    const disposal = document.dispose(); expect(document.dispose()).toBe(disposal); await disposal
    expect(worker.terminated).toBe(true)
    await expect(document.copy()).rejects.toMatchObject({ code: 'disposed' })
  })
  it('contains observer exceptions and reports terminal engine errors to every subscriber', async () => {
    supportedOffice()
    const document = await openOfficeDocument({ ...options(), extension: 'docx' }), worker = ControlledWorker.instances[0]!
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      document.subscribe(() => { throw new Error('observer failed') })
      const events = vi.fn(); document.subscribe(events)
      worker.receive({ type: 'office-event', event: { type: 'invalidate', part: 0, rectangle: null, generation: 1 } })
      expect(events).toHaveBeenCalledOnce(); expect(log).toHaveBeenCalledOnce()
      const failure = expect(document.copy()).rejects.toMatchObject({ code: 'render-failed' })
      worker.receive({ type: 'error', id: worker.messages.at(-1)!.id, fatal: true, code: 'render-failed', message: 'WASM trapped' })
      await failure
      expect(events).toHaveBeenLastCalledWith({ type: 'error', code: 'render-failed', message: 'WASM trapped' })
      await document.dispose(); expect(worker.terminated).toBe(true)
    } finally { log.mockRestore(); await document.dispose() }
  })
  it('rejects an opening response missing retained reading state', async () => {
    supported()
    await expect(openOfficeDocument({ ...options(), extension: 'docx' })).rejects.toMatchObject({ code: 'invalid-document' })
    expect(ControlledWorker.instances[0]!.terminated).toBe(true)
  })
})

async function dispatched(worker: ControlledWorker): Promise<Extract<OwnerMessage, { type: 'tile' }>> {
  await vi.waitFor(() => expect(worker.messages.at(-1)?.type).toBe('tile'))
  return worker.messages.at(-1) as Extract<OwnerMessage, { type: 'tile' }>
}

describe('browser transport failures and cancellation', () => {
  it('ignores Office notifications when a PDF has no reading observer', async () => {
    supported()
    const document = await openDocument(options())
    const worker = ControlledWorker.instances[0]!
    worker.receive({ type: 'office-event', event: { type: 'state', state: readingState } })
    await document.dispose()
    expect(worker.terminated).toBe(true)
  })
  it('rejects invalid limits, an empty source and already aborted loads before creating Workers', async () => {
    supported()
    for (const change of [{ timeoutMs: 0 }, { timeoutMs: 0x80000000 }, { maxLoadedFontBytes: -1 }]) await expect(openDocument({ ...options(), ...change })).rejects.toBeInstanceOf(TypeError)
    await expect(openDocument({ ...options(), data: new Uint8Array() })).rejects.toMatchObject({ code: 'invalid-document' })
    const cancelled = new AbortController(); cancelled.abort()
    await expect(openDocument(options(), cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(ControlledWorker.instances).toHaveLength(0)
  })
  it.each(['empty', 'mismatched', 'load-error'] as const)('disposes a Worker whose load response is %s', async mode => {
    supported()
    ControlledWorker.opening = (worker, message) => worker.receive(mode === 'empty' ? { type: 'opened', id: message.id, pages: [] }
      : mode === 'mismatched' ? { type: 'disposed', id: message.id }
        : { type: 'error', fatal: false, id: message.id, code: 'invalid-document', message: 'Broken source' })
    await expect(openDocument(options())).rejects.toMatchObject({ code: 'invalid-document' })
    expect(ControlledWorker.instances[0]!.terminated).toBe(true)
  })
  it('rejects an initial transport exception and still terminates the Worker', async () => {
    supported(); ControlledWorker.throwPost = true
    await expect(openDocument(options())).rejects.toThrow('transport unavailable')
    expect(ControlledWorker.instances[0]!.terminated).toBe(true)
  })
  it('times out a stuck engine and enforces its independent shutdown deadline', async () => {
    supported(); vi.useFakeTimers(); ControlledWorker.opening = () => {}; ControlledWorker.holdDispose = true
    const opening = openDocument({ ...options(), timeoutMs: 10 })
    const failure = expect(opening).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(1000); await failure
    expect(ControlledWorker.instances[0]!.terminated).toBe(true)
    const document = await (async () => { ControlledWorker.opening = undefined; return openDocument(options()) })()
    const disposal = document.dispose()
    await vi.advanceTimersByTimeAsync(1000); await disposal
    expect(ControlledWorker.instances[1]!.terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it.each(['error', 'empty-error', 'messageerror'] as const)('rejects pending tiles on a Worker %s event', async kind => {
    supported()
    const document = await openDocument(options()); const worker = ControlledWorker.instances[0]!
    const tile = document.renderTile(tileRequest); const failure = expect(tile).rejects.toMatchObject({ code: 'render-failed' })
    await dispatched(worker)
    if (kind === 'messageerror') worker.onmessageerror?.()
    else worker.onerror?.({ message: kind === 'error' ? 'Worker crashed' : '' } as ErrorEvent)
    await failure; await document.dispose(); expect(worker.terminated).toBe(true)
  })
  it.each(['font-limit', 'font-unavailable', 'timeout'] as const)('closes the document after an unrecoverable %s response', async code => {
    supported()
    const document = await openDocument(options()); const worker = ControlledWorker.instances[0]!
    const tile = document.renderTile(tileRequest); const failure = expect(tile).rejects.toMatchObject({ code })
    const sent = await dispatched(worker)
    worker.receive({ type: 'error', fatal: false, id: sent.id, code, message: code })
    await failure; await document.dispose(); expect(worker.terminated).toBe(true)
  })
  it('recovers the tile queue after a render failure and rejects an unrelated reply', async () => {
    supported()
    const document = await openDocument(options()); const worker = ControlledWorker.instances[0]!
    const tile = document.renderTile(tileRequest); const failure = expect(tile).rejects.toMatchObject({ code: 'render-failed' })
    const sent = await dispatched(worker)
    worker.receive({ type: 'error', fatal: false, id: sent.id, code: 'render-failed', message: 'Region could not render' }); await failure
    const second = document.renderTile(tileRequest); const secondFailure = expect(second).rejects.toMatchObject({ code: 'render-failed' })
    await vi.waitFor(() => expect(worker.messages.filter(message => message.type === 'tile')).toHaveLength(2))
    worker.receive({ type: 'disposed', id: worker.messages.at(-1)!.id }); await secondFailure
    await document.dispose()
  })
  it('skips a tile canceled while queued, rejects queued work on document abort, and ignores stale responses', async () => {
    supported()
    const lifetime = new AbortController()
    const document = await openDocument(options(), lifetime.signal); const worker = ControlledWorker.instances[0]!
    const already = new AbortController(); already.abort()
    await expect(document.renderTile(tileRequest, already.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const first = document.renderTile(tileRequest)
    const cancel = new AbortController(); const second = document.renderTile(tileRequest, cancel.signal)
    const cancelled = expect(second).rejects.toMatchObject({ name: 'AbortError' })
    const firstMessage = await dispatched(worker); cancel.abort(); await cancelled
    worker.receive({ type: 'tile', id: firstMessage.id, tile: { width: 10, height: 10, rgba: new Uint8ClampedArray(400) } }); await first
    await Promise.resolve(); await Promise.resolve()
    expect(worker.messages.filter(message => message.type === 'tile')).toHaveLength(1)
    worker.receive({ type: 'tile', id: firstMessage.id, tile: { width: 10, height: 10, rgba: new Uint8ClampedArray(400) } })
    const queued = document.renderTile(tileRequest); const disposed = expect(queued).rejects.toMatchObject({ code: 'disposed' })
    lifetime.abort(); await disposed; await document.dispose()
  })
  it('aborts an in-flight load and preserves the caller cancellation reason', async () => {
    supported(); ControlledWorker.opening = () => {}
    const lifetime = new AbortController()
    const opening = openDocument(options(), lifetime.signal); const failure = expect(opening).rejects.toMatchObject({ name: 'AbortError' })
    lifetime.abort(); await failure
    expect(ControlledWorker.instances[0]!.terminated).toBe(true)
  })
})

describe('owner-side asynchronous font delivery', () => {
  it('returns only a reference header and trailer when the Worker already installed the same font', async () => {
    supported()
    const data = new Uint8Array([1, 2, 3])
    const resolveFonts = vi.fn(async (_request, known) => ({ fonts: [{ id: 'shared-ttc', family: 'Arial', alias: 'Arial',
      ...(known.length === 0 ? { data } : { bytes: data.length }), format: 'ttc' as const }] }))
    const document = await openDocument({ ...options(), resolveFonts })
    const worker = ControlledWorker.instances[0]!
    const opened = worker.messages[0] as Extract<OwnerMessage, { type: 'open' }>
    const { control, bytes } = fontViews(opened.channel)
    try {
      worker.receive({ type: 'font', request: fontRequest, known: [{ id: 'shared-ttc', bytes: data.length, format: 'ttc' }] })
      await vi.waitFor(() => expect(Atomics.load(control, 0)).toBe(FontState.Header))
      expect(JSON.parse(new TextDecoder().decode(bytes.slice(0, Atomics.load(control, 1))))).toEqual({ fonts: [
        { id: 'shared-ttc', bytes: data.length, family: 'Arial', alias: 'Arial', format: 'ttc', reference: true },
      ] })
      expect(resolveFonts).toHaveBeenCalledExactlyOnceWith(fontRequest,
        [{ id: 'shared-ttc', bytes: data.length, format: 'ttc' }], expect.any(AbortSignal))
      worker.receive({ type: 'font-next' })
      expect(Atomics.load(control, 0)).toBe(FontState.Done)
      expect(Atomics.load(control, 1)).toBe(0)
      worker.receive({ type: 'font-next' })
      expect(Atomics.load(control, 0)).toBe(FontState.Done)
    } finally { await document.dispose() }
  })
  it('publishes one bounded frame per acknowledgement and forwards missing-source diagnostics', async () => {
    supported()
    const missing = vi.fn()
    const document = await openDocument({ ...options(), onMissingFonts: missing, resolveFonts: async () => ({ fonts: [{ id: 'font', family: 'Arial', alias: 'DSH_font', data: new Uint8Array([1, 2]) }] }) })
    const worker = ControlledWorker.instances[0]!
    const opened = worker.messages[0] as Extract<OwnerMessage, { type: 'open' }>
    const views = fontViews(opened.channel)
    worker.receive({ type: 'font-next' })
    worker.receive({ type: 'font', known: [], request: fontRequest })
    await vi.waitFor(() => expect(Atomics.load(views.control, 0)).toBe(FontState.Header))
    worker.receive({ type: 'font-next' }); expect(Atomics.load(views.control, 0)).toBe(FontState.Bytes)
    expect([...views.bytes.slice(0, 2)]).toEqual([1, 2])
    worker.receive({ type: 'font-next' }); expect(Atomics.load(views.control, 0)).toBe(FontState.Done)
    worker.receive({ type: 'font-next' })
    worker.receive({ type: 'missing-fonts', families: ['Absent'] }); expect(missing).toHaveBeenCalledWith(['Absent'])
    const disposal = document.dispose()
    worker.receive({ type: 'font', known: [], request: fontRequest }); worker.receive({ type: 'font-next' }); worker.receive({ type: 'missing-fonts', families: ['Late'] })
    await disposal; expect(missing).toHaveBeenCalledTimes(1)
  })
  it('reports metadata overflow and primitive provider failures through the shared channel', async () => {
    supported()
    for (const resolveFonts of [async () => ({ fonts: [{ id: 'font', family: 'x'.repeat(FONT_CHUNK_BYTES), alias: 'DSH_font', data: new Uint8Array([1]) }] }), async () => { throw 'Host offline' }]) {
      const document = await openDocument({ ...options(), resolveFonts })
      const worker = ControlledWorker.instances.at(-1)!
      const opened = worker.messages[0] as Extract<OwnerMessage, { type: 'open' }>
      worker.receive({ type: 'font', known: [], request: fontRequest })
      await vi.waitFor(() => expect(Atomics.load(fontViews(opened.channel).control, 0)).toBe(FontState.Error))
      await document.dispose()
    }
  })
  it.each([false, true])('does not revive a disposed document when a delayed provider %s', async reject => {
    supported()
    const response = Promise.withResolvers<{ fonts: [] }>()
    const document = await openDocument({ ...options(), resolveFonts: () => response.promise })
    const worker = ControlledWorker.instances[0]!
    const opened = worker.messages[0] as Extract<OwnerMessage, { type: 'open' }>
    worker.receive({ type: 'font', known: [], request: fontRequest }); await Promise.resolve()
    await document.dispose()
    if (reject) response.reject(new Error('late failure')); else response.resolve({ fonts: [] })
    await Promise.resolve(); await Promise.resolve()
    expect(Atomics.load(fontViews(opened.channel).control, 0)).toBe(FontState.Cancelled)
  })
})


it('closes a trapped engine instead of dispatching another tile into its aborted module', async () => {
  supported()
  const document = await openDocument(options()); const worker = ControlledWorker.instances[0]!
  const tile = document.renderTile(tileRequest); const failure = expect(tile).rejects.toMatchObject({ code: 'render-failed' })
  const sent = await dispatched(worker)
  worker.receive({ type: 'error', id: sent.id, code: 'render-failed', message: 'WASM trap', fatal: true })
  await failure
  await expect(document.renderTile(tileRequest)).rejects.toMatchObject({ code: 'disposed' })
  await document.dispose(); expect(worker.terminated).toBe(true)
})
