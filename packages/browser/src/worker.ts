/** Classic Worker entry: serializes one LibreOffice instance and owns its pthreads. */
import { inspectDocument } from '@deepseek-ai/libreoffice-kit/document-inspection'
import { memoryFontConfig } from '@deepseek-ai/libreoffice-kit/font-config'
import { createFontReader } from './font-channel.ts'
import { BrowserRenderError } from './types.ts'
import type { BrowserRenderErrorCode, BrowserTileRequest } from './types.ts'
import type { OwnerMessage, WorkerMessage, WorkerOptions } from './protocol.ts'
import type { EnginePage } from './rendering.ts'

import type { EmscriptenModule } from './engine-types.ts'
import type { OfficeDocumentFormat } from './office-types.ts'
import { OfficeEngine } from './office-engine.ts'
import { pdfPages, renderRegion } from './engine-rendering.ts'

interface EngineGlobal extends DedicatedWorkerGlobalScope {
  createLibreOfficeModule(overrides: Record<string, unknown>): Promise<EmscriptenModule>
}
const scope = globalThis as unknown as EngineGlobal
let module: EmscriptenModule | undefined
let office = 0
let document = 0
let pdf = 0
let pages: EnginePage[] = []
let reader: OfficeEngine | undefined
let fatal = false
let fontFailure: unknown
let serial = Promise.resolve()
const lifetime = new AbortController()

function send(message: WorkerMessage, transfer: Transferable[] = []): void { scope.postMessage(message, transfer) }
function call(name: string, args: number[]): number { return module!.ccall(name, 'number', args.map(() => 'number'), args) }
function error(code: BrowserRenderErrorCode): BrowserRenderError {
  if (fontFailure instanceof BrowserRenderError) return fontFailure
  if (!module) return new BrowserRenderError(code, 'LibreOffice could not initialize.')
  const pointer = call('dsh_lok_error', [office])
  if (!pointer) return new BrowserRenderError(code, 'LibreOffice could not render the document.')
  try { return new BrowserRenderError(code, module.UTF8ToString(pointer)) } finally { call('free', [pointer]) }
}

async function open(options: WorkerOptions, channel: SharedArrayBuffer, reading = false): Promise<void> {
  const { assets } = options
  let metadata: ReturnType<typeof inspectDocument>
  try { metadata = options.extension === 'pdf' ? { families: new Map(), codePoints: [] } : inspectDocument(options.data, options.extension, options) } catch (failure) { throw new BrowserRenderError('invalid-document', failure instanceof Error ? failure.message : String(failure)) }
  const initialFont = { family: 'sans-serif', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] }
  let initialFontPending = options.extension !== 'pdf'
  // Host font discovery runs while the engine downloads and compiles. The first
  // synchronous font read consumes this response through the same bounded channel.
  if (initialFontPending) send({ type: 'font', request: initialFont, known: [] })
  const response = await fetch(assets.dataUrl, { credentials: 'same-origin', signal: lifetime.signal })
  if (!response.ok) throw new BrowserRenderError('unavailable', `LibreOffice data request failed: ${response.status}`)
  const data = await response.arrayBuffer()
  scope.importScripts(assets.loaderUrl)
  let resolveFonts: ReturnType<typeof createFontReader> | undefined
  module = await scope.createLibreOfficeModule({
    noInitialRun: true,
    dshOnCallback(type: number, payload: string) { reader?.callback(type, payload) },
    mainScriptUrlOrBlob: assets.loaderUrl,
    locateFile(name: string) {
      const basename = name.slice(name.lastIndexOf('/') + 1)
      switch (basename) {
        case 'soffice.js': case 'soffice.cjs': return assets.loaderUrl
        case 'soffice.wasm': return assets.wasmUrl
        case 'soffice.data': return assets.dataUrl
        case 'soffice.data.js.metadata': return assets.metadataUrl
        default: throw new BrowserRenderError('unavailable', `LibreOffice requested an undeclared resource: ${basename}`)
      }
    },
    getPreloadedPackage: () => data,
    dshResolveSystemFontFaces(request: Parameters<NonNullable<typeof resolveFonts>>[0]) {
      if (!resolveFonts) throw new BrowserRenderError('font-unavailable', 'LibreOffice requested fonts before MEMFS initialization.')
      try { return resolveFonts(request) } catch (failure) { fontFailure = failure; throw failure }
    },
    preRun: [(loaded: EmscriptenModule) => {
      for (const path of ['/dsh/profile', '/dsh/font-cache', '/dsh-fonts', '/usr/share/fonts/dsh-pdfium']) loaded.FS.mkdirTree(path)
      loaded.FS.writeFile('/dsh/fonts.conf', new TextEncoder().encode(memoryFontConfig(options.fontFallbacks, metadata.families.values())))
      Object.assign(loaded.ENV, { HOME: '/dsh/profile', TMPDIR: '/tmp', FONTCONFIG_FILE: '/dsh/fonts.conf', LOK_HOST_ALLOWLIST: '^$' })
      resolveFonts = createFontReader(channel, options.timeoutMs, options.maxLoadedFontBytes, metadata.families,
        (request, known) => {
          if (initialFontPending) initialFontPending = false
          else send({ type: 'font', request, known })
        }, () => send({ type: 'font-next' }),
        (path, bytes) => loaded.FS.writeFile(path, bytes), families => send({ type: 'missing-fonts', families }))
      if (options.extension === 'pdf') {
        for (const family of new Set(options.fontFallbacks.flat())) resolveFonts({ ...initialFont, family, mode: 'full' })
      } else resolveFonts(initialFont)
    }],
    onAbort() { fatal = true },
    print() {}, printErr() {},
  })
  if (options.extension === 'pdf') {
    const pointer = call('malloc', [options.data.byteLength])
    if (!pointer) throw error('invalid-document')
    try {
      new Uint8Array(module.HEAPU32.buffer, pointer, options.data.byteLength).set(options.data)
      pdf = module.ccall('dsh_pdf_open', 'number', ['number', 'number', 'string'], [pointer, options.data.byteLength, ''])
    } finally { call('free', [pointer]) }
    if (!pdf) throw error('invalid-document')
    pages = pdfPages(module, pdf, () => error('invalid-document'))
    return
  }
  const input = `/dsh/document.${options.extension}`
  module.FS.writeFile(input, options.data)
  office = module.ccall('dsh_lok_initialize', 'number', ['string', 'string'], [assets.programDirectory, 'file:///dsh/profile'])
  if (!office) throw error('invalid-document')
  document = module.ccall('dsh_lok_document_load', 'number', ['number', 'string', 'string'], [office, `file://${input}`, 'ReadOnly=true,EnableMacrosExecution=false'])
  if (!document || !call('dsh_lok_document_initialize_rendering', [document])) throw error('invalid-document')
  const type = call('dsh_lok_document_type', [document])
  if (type !== (options.extension === 'docx' || options.extension === 'doc' ? 0 : options.extension === 'xlsx' || options.extension === 'xls' ? 1 : 2)) throw new BrowserRenderError('invalid-document', 'The document type does not match its extension.')
  if (reading) {
    reader = new OfficeEngine(module, document, options.extension as OfficeDocumentFormat,
      event => send({ type: 'office-event', event }), failure => {
        fatal ||= failure instanceof WebAssembly.RuntimeError
        send({ type: 'office-event', event: { type: 'error', code: 'render-failed', message: failure instanceof Error ? failure.message : String(failure) } })
      })
    await reader.start()
    pages = reader.state.parts.map((part, index) => ({ ...part, x: 0, y: 0, part: type === 0 ? -1 : index }))
    return
  }
  throw new BrowserRenderError('invalid-document', 'Office documents require a retained session.')
}

function render(request: BrowserTileRequest): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (fatal) throw new BrowserRenderError('render-failed', 'LibreOffice Worker has aborted.')
  if (!pdf || !module) throw new BrowserRenderError('disposed', 'The document is closed.')
  return renderRegion(module, pdf, request, pages, () => error('render-failed'), true)
}

function dispose(): void {
  reader?.stop()
  reader = undefined
  try {
    if (module && !fatal) {
      if (pdf) { const value = pdf; pdf = 0; if (!call('dsh_pdf_destroy', [value])) throw error('render-failed') }
      if (document) { const value = document; document = 0; if (!call('dsh_lok_document_destroy', [value])) throw error('render-failed') }
      if (office) { const value = office; office = 0; if (!call('dsh_lok_destroy', [value])) throw error('render-failed') }
    }
  } finally {
    module?.PThread.terminateAllThreads()
    module = undefined
    document = 0
    pdf = 0
    office = 0
    pages = []
  }
}

scope.onmessage = (event: MessageEvent<OwnerMessage>) => {
  const message = event.data
  if (message.type === 'dispose') { lifetime.abort(); reader?.stop() }
  serial = serial.then(async () => {
    try {
      switch (message.type) {
        case 'open': await open(message.options, message.channel, message.office); send({ type: 'opened', id: message.id, pages: pages.map(({ width, height }) => ({ width, height })), ...(reader ? { office: reader.state } : {}) }); break
        case 'tile': { const tile = render(message.request); send({ type: 'tile', id: message.id, tile }, [tile.rgba.buffer]); break }
        case 'office-tile': {
          if (!reader) throw new BrowserRenderError('disposed', 'Office reader is closed.')
          const tile = reader.render(message.request)
          send({ type: 'tile', id: message.id, tile }, [tile.rgba.buffer])
          break
        }
        case 'office-operation': {
          if (!reader) throw new BrowserRenderError('disposed', 'Office reader is closed.')
          const result = await reader.operation(message.operation)
          send({ type: 'office-result', id: message.id, ...result })
          break
        }
        case 'dispose': dispose(); send({ type: 'disposed', id: message.id }); scope.close(); break
        default: throw new BrowserRenderError('render-failed', 'Unsupported Office Worker request.')
      }
    } catch (failure) {
      fatal ||= failure instanceof WebAssembly.RuntimeError
      send({ type: 'error', id: message.id, code: failure instanceof BrowserRenderError ? failure.code : 'render-failed', message: failure instanceof Error ? failure.message : String(failure), fatal })
    }
  })
}
