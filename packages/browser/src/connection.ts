/** Browser document ownership, cancellation and asynchronous Host font delivery. */
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES, FontState } from './protocol.ts'
import type { OwnerMessage, OwnerRequest, WorkerMessage, WorkerOptions } from './protocol.ts'
import { fontFrames, fontViews } from './font-channel.ts'
import { BrowserRenderError } from './types.ts'
import { preparedBrowserModule } from './preparation.ts'
import type { BrowserDocumentOptions } from './types.ts'
import type { OfficeDocumentEvent, OfficeDocumentOptions } from './office-types.ts'

interface Pending {
  resolve(message: WorkerMessage): void
  reject(error: unknown): void
}

/**
 * Load original Office bytes in a dedicated Worker with no intermediate PDF.
 * @param options - Resources, limits, source bytes and asynchronous Host font provider.
 * @param signal - Document lifetime; abort closes its Worker and all pending work.
 * @returns Initial geometry, ordered Worker requests and joined disposal.
 */
export async function openBrowserConnection(options: BrowserDocumentOptions | OfficeDocumentOptions, signal?: AbortSignal,
  office = false, onEvent?: (event: OfficeDocumentEvent) => void) {
  signal?.throwIfAborted()
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined' || typeof Worker === 'undefined') throw new BrowserRenderError('unavailable', 'LibreOffice requires an isolated secure browser context with Worker and SharedArrayBuffer support.')
  if (![options.timeoutMs, options.maxLoadedFontBytes, options.maxArchiveEntries, options.maxUncompressedBytes].every(value => Number.isSafeInteger(value) && value > 0) || options.timeoutMs > 0x7fffffff) throw new TypeError('Document limits must be positive integers and timeoutMs must fit a browser timer.')
  if (!(office ? ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] : ['pdf']).includes(options.extension) || options.data.byteLength === 0) throw new BrowserRenderError('invalid-document', 'The document is empty or has an unsupported extension.')
  if (options.preparedEngine !== undefined) preparedBrowserModule(options.preparedEngine, options.assets)
  const worker = new Worker(options.assets.workerUrl, { name: 'libreoffice-document' })
  const channel = new SharedArrayBuffer(FONT_HEADER_BYTES + FONT_CHUNK_BYTES)
  const { control, bytes } = fontViews(channel)
  const lifetime = new AbortController()
  const pending = new Map<number, Pending>()
  let sequence = 0
  let closed = false
  let disposal: Promise<void> | undefined
  let frames: ReturnType<typeof fontFrames> | undefined
  let opened: Extract<WorkerMessage, { type: 'opened' }> | undefined

  function failPending(error: unknown): void {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  function sendFontError(error: unknown): void {
    if (closed) return
    frames = undefined
    const encoded = new TextEncoder().encode(error instanceof Error ? error.message : String(error)).subarray(0, FONT_CHUNK_BYTES)
    bytes.set(encoded)
    Atomics.store(control, 1, encoded.length)
    Atomics.store(control, 0, FontState.Error)
    Atomics.notify(control, 0)
  }
  function pumpFonts(): void {
    if (closed || !frames) return
    try {
      const frame = frames.next()
      if (frame.done) { frames = undefined; return }
      bytes.set(frame.value.bytes)
      Atomics.store(control, 1, frame.value.bytes.length)
      Atomics.store(control, 0, frame.value.state)
      Atomics.notify(control, 0)
    } catch (error) { sendFontError(error) }
  }
  worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
    const message = event.data
    switch (message.type) {
      case 'office-event': if (!closed) { onEvent?.(message.event); if (message.event.type === 'error') void dispose() }; return
      case 'font':
        if (closed) return
        void Promise.resolve().then(() => options.resolveFonts(message.request, message.known, lifetime.signal)).then(result => {
          if (closed) return
          frames = fontFrames(result, message.known)
          pumpFonts()
        }, sendFontError)
        return
      case 'font-next': pumpFonts(); return
      case 'missing-fonts': if (!closed) options.onMissingFonts?.(message.families); return
      default: {
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
        if (message.type === 'error') {
          entry.reject(new BrowserRenderError(message.code, message.message))
          if (message.fatal || message.code === 'font-limit' || message.code === 'font-unavailable' || message.code === 'timeout') {
            onEvent?.({ type: 'error', code: message.code, message: message.message })
            void dispose()
          }
        } else entry.resolve(message)
      }
    }
  }
  worker.onerror = (event) => {
    const error = new BrowserRenderError('render-failed', event.message || 'LibreOffice Worker failed.')
    onEvent?.({ type: 'error', code: error.code, message: error.message })
    failPending(error)
    void dispose()
  }
  worker.onmessageerror = () => {
    const error = new BrowserRenderError('render-failed', 'LibreOffice Worker returned an unreadable response.')
    onEvent?.({ type: 'error', code: error.code, message: error.message })
    failPending(error)
    void dispose()
  }

  function post(message: OwnerMessage, transfer: Transferable[] = []): Promise<WorkerMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id)
        const error = new BrowserRenderError('timeout', 'LibreOffice operation timed out.')
        reject(error)
        if (!closed) onEvent?.({ type: 'error', code: error.code, message: error.message })
        void dispose()
      }, options.timeoutMs)
      pending.set(message.id, {
        resolve(value) { clearTimeout(timer); resolve(value) },
        reject(error) { clearTimeout(timer); reject(error) },
      })
      try { worker.postMessage(message, transfer) } catch (error) { pending.get(message.id)?.reject(error); pending.delete(message.id) }
    })
  }
  function dispose(): Promise<void> {
    if (disposal) return disposal
    closed = true
    signal?.removeEventListener('abort', aborted)
    lifetime.abort()
    frames = undefined
    Atomics.store(control, 0, FontState.Cancelled)
    Atomics.notify(control, 0)
    failPending(new BrowserRenderError('disposed', 'The document is closed.'))
    disposal = new Promise<void>((resolve) => {
      // This handshake only releases owned workers; document processing has its own caller deadline.
      const deadline = setTimeout(resolve, 1_000)
      void post({ type: 'dispose', id: ++sequence }).then(() => resolve(), () => resolve()).finally(() => clearTimeout(deadline))
    }).finally(() => { worker.terminate(); failPending(new BrowserRenderError('disposed', 'The document is closed.')); worker.onmessage = null; worker.onerror = null; worker.onmessageerror = null })
    return disposal
  }
  function aborted(): void { void dispose() }
  signal?.addEventListener('abort', aborted, { once: true })

  try {
    const data = new Uint8Array(options.data)
    const engineOptions: WorkerOptions = { data, extension: options.extension, assets: options.assets,
      ...(options.preparedEngine === undefined ? {} : { preparedEngine: options.preparedEngine }),
      timeoutMs: options.timeoutMs, maxLoadedFontBytes: options.maxLoadedFontBytes, fontFallbacks: options.fontFallbacks,
      maxArchiveEntries: options.maxArchiveEntries, maxUncompressedBytes: options.maxUncompressedBytes }
    const result = await post({ type: 'open', id: ++sequence, options: engineOptions, channel, ...(office ? { office: true } : {}) }, [data.buffer])
    if (result.type !== 'opened') throw new BrowserRenderError('invalid-document', 'LibreOffice returned an unexpected load response.')
    opened = result
    if (opened.type !== 'opened' || opened.pages.length === 0) throw new BrowserRenderError('invalid-document', 'LibreOffice returned no document pages.')
    signal?.throwIfAborted()
  } catch (error) {
    await dispose()
    signal?.throwIfAborted()
    throw error
  }

  return {
    opened,
    request(message: OwnerRequest, operation?: AbortSignal): Promise<WorkerMessage> {
      if (closed) return Promise.reject(new BrowserRenderError('disposed', 'The document is closed.'))
      if (operation?.aborted) return Promise.reject(operation.reason)
      const task = post({ ...message, id: ++sequence })
      if (!operation) return task
      return new Promise((resolve, reject) => {
        const abort = (): void => { reject(operation.reason) }
        operation.addEventListener('abort', abort, { once: true })
        void task.then(resolve, reject).finally(() => operation.removeEventListener('abort', abort))
      })
    },
    dispose,
  }
}
