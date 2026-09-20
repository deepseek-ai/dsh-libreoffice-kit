/** The initial Office font request overlaps engine loading and shares its cancellation. */
import { afterEach, expect, it, vi } from 'vitest'
import type { OwnerMessage, WorkerMessage, WorkerOptions } from '../src/protocol.ts'

vi.mock('@deepseek-ai/libreoffice-kit/document-inspection', () => ({
  inspectDocument: () => ({ families: new Map(), codePoints: [] }),
}))
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it.each(['docx', 'xlsx', 'pptx', 'pdf'] as const)('starts %s fonts at the appropriate phase and aborts a pending engine download', async extension => {
  const fetching = Promise.withResolvers<void>()
  const disposed = Promise.withResolvers<void>()
  const messages: WorkerMessage[] = []
  const fetchAsset = vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
    fetching.resolve()
  }))
  const close = vi.fn()
  vi.stubGlobal('onmessage', undefined)
  vi.stubGlobal('fetch', fetchAsset)
  vi.stubGlobal('close', close)
  vi.stubGlobal('postMessage', (message: WorkerMessage) => {
    messages.push(message)
    if (message.type === 'disposed') disposed.resolve()
  })
  await import('../src/worker.ts')
  const receive = (message: OwnerMessage) => globalThis.onmessage!(new MessageEvent('message', { data: message }))
  const options: WorkerOptions = { extension, data: new Uint8Array([1]), timeoutMs: 1000,
    maxArchiveEntries: 10, maxUncompressedBytes: 1000, maxLoadedFontBytes: 1000,
    fontFallbacks: [['Test Font']], assets: { workerUrl: '/worker', loaderUrl: '/loader',
      wasmUrl: '/wasm', dataUrl: '/data', metadataUrl: '/metadata', programDirectory: '/program' } }
  receive({ type: 'open', id: 1, options, channel: new SharedArrayBuffer(16), ...(extension === 'pdf' ? {} : { office: true }) })
  await fetching.promise
  const beforeDownload = [...messages]
  receive({ type: 'dispose', id: 2 })
  await disposed.promise
  expect(close).toHaveBeenCalledOnce()
  expect(fetchAsset).toHaveBeenCalledOnce()
  if (extension === 'pdf') expect(beforeDownload).toEqual([])
  else expect(beforeDownload).toEqual([{ type: 'font', known: [], request: {
    family: 'sans-serif', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [],
  } }])
  expect(messages.map(message => message.type)).toEqual([...(extension === 'pdf' ? [] : ['font']), 'error', 'disposed'])
})
