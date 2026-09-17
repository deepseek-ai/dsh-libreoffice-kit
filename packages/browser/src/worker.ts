/** Classic Worker entry: serializes one LibreOffice instance and owns its pthreads. */
import { inspectDocument } from '@deepseek-ai/libreoffice-kit/document-inspection'
import { memoryFontConfig } from '@deepseek-ai/libreoffice-kit/font-config'
import { createFontReader } from './font-channel.ts'
import { BrowserRenderError } from './types.ts'
import type { BrowserRenderErrorCode, BrowserTileRequest } from './types.ts'
import type { OwnerMessage, WorkerMessage, WorkerOptions } from './protocol.ts'
import { rgbaPixels, tileDimensions, TWIPS_PER_CSS_PIXEL, writerPages } from './rendering.ts'
import type { EnginePage } from './rendering.ts'

interface EmscriptenModule {
  readonly FS: { mkdirTree(path: string): void; writeFile(path: string, data: Uint8Array): void }
  readonly ENV: Record<string, string>
  readonly HEAPU32: Uint32Array
  readonly PThread: { terminateAllThreads(): void }
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): number
  UTF8ToString(pointer: number): string
}
interface EngineGlobal extends DedicatedWorkerGlobalScope {
  createLibreOfficeModule(overrides: Record<string, unknown>): Promise<EmscriptenModule>
}
const scope = globalThis as unknown as EngineGlobal
let module: EmscriptenModule | undefined
let office = 0
let document = 0
let pages: EnginePage[] = []
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

async function open(options: WorkerOptions, channel: SharedArrayBuffer): Promise<void> {
  const { assets } = options
  let metadata: ReturnType<typeof inspectDocument>
  try { metadata = inspectDocument(options.data, options.extension, options) } catch (failure) { throw new BrowserRenderError('invalid-document', failure instanceof Error ? failure.message : String(failure)) }
  const response = await fetch(assets.dataUrl, { credentials: 'same-origin', signal: lifetime.signal })
  if (!response.ok) throw new BrowserRenderError('unavailable', `LibreOffice data request failed: ${response.status}`)
  const data = await response.arrayBuffer()
  scope.importScripts(assets.loaderUrl)
  let resolveFonts: ReturnType<typeof createFontReader> | undefined
  module = await scope.createLibreOfficeModule({
    noInitialRun: true,
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
      for (const path of ['/dsh/profile', '/dsh/font-cache', '/dsh-fonts']) loaded.FS.mkdirTree(path)
      loaded.FS.writeFile('/dsh/fonts.conf', new TextEncoder().encode(memoryFontConfig(options.fontFallbacks, metadata.families.values())))
      Object.assign(loaded.ENV, { HOME: '/dsh/profile', TMPDIR: '/tmp', FONTCONFIG_FILE: '/dsh/fonts.conf', LOK_HOST_ALLOWLIST: '^$' })
      resolveFonts = createFontReader(channel, options.timeoutMs, options.maxLoadedFontBytes, metadata.families,
        request => send({ type: 'font', request }), () => send({ type: 'font-next' }),
        (path, bytes) => loaded.FS.writeFile(path, bytes), families => send({ type: 'missing-fonts', families }))
      resolveFonts({ family: 'sans-serif', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] })
    }],
    onAbort() { fatal = true },
    print() {}, printErr() {},
  })
  const input = `/dsh/document.${options.extension}`
  module.FS.writeFile(input, options.data)
  office = module.ccall('dsh_lok_initialize', 'number', ['string', 'string'], [assets.programDirectory, 'file:///dsh/profile'])
  if (!office) throw error('invalid-document')
  document = module.ccall('dsh_lok_document_load', 'number', ['number', 'string', 'string'], [office, `file://${input}`, 'Batch=true,EnableMacrosExecution=false'])
  if (!document || !call('dsh_lok_document_initialize_rendering', [document])) throw error('invalid-document')
  const type = call('dsh_lok_document_type', [document])
  if (type !== (options.extension === 'doc' || options.extension === 'docx' ? 0 : 2)) throw new BrowserRenderError('invalid-document', 'The document type does not match its extension.')
  if (type === 0) {
    const pointer = call('dsh_lok_document_page_rectangles', [document])
    if (!pointer) throw error('invalid-document')
    try { pages = writerPages(module.UTF8ToString(pointer)) } finally { call('free', [pointer]) }
  } else if (type === 2) {
    const count = call('dsh_lok_document_parts', [document])
    if (count <= 0) throw error('invalid-document')
    const pointer = call('malloc', [8])
    if (!pointer) throw error('invalid-document')
    try {
      for (let part = 0; part < count; part++) {
        if (!call('dsh_lok_document_size', [document, part, pointer, pointer + 4])) throw error('invalid-document')
        const width = module.HEAPU32[pointer / 4]!
        const height = module.HEAPU32[pointer / 4 + 1]!
        if (width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) throw error('invalid-document')
        pages.push({ x: 0, y: 0, width: width / TWIPS_PER_CSS_PIXEL, height: height / TWIPS_PER_CSS_PIXEL, part })
      }
    } finally { call('free', [pointer]) }
  } else throw new BrowserRenderError('invalid-document', 'The file is not a Writer or Impress document.')
}

function render(request: BrowserTileRequest): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (fatal) throw new BrowserRenderError('render-failed', 'LibreOffice Worker has aborted.')
  if (!document || !module) throw new BrowserRenderError('disposed', 'The document is closed.')
  const { page, width, height } = tileDimensions(request, pages)
  const size = width * height * 4
  const pointer = call('malloc', [size])
  if (!pointer) throw error('render-failed')
  try {
    new Uint8Array(module.HEAPU32.buffer, pointer, size).fill(0)
    const position = [page.x + Math.round(request.x * TWIPS_PER_CSS_PIXEL), page.y + Math.round(request.y * TWIPS_PER_CSS_PIXEL), Math.max(1, Math.round(request.width * TWIPS_PER_CSS_PIXEL)), Math.max(1, Math.round(request.height * TWIPS_PER_CSS_PIXEL))]
    if (!call('dsh_lok_document_paint', [document, pointer, page.part, width, height, ...position])) throw error('render-failed')
    return { width, height, rgba: rgbaPixels(new Uint8Array(module.HEAPU32.buffer, pointer, size), call('dsh_lok_document_tile_mode', [document])) }
  } finally { call('free', [pointer]) }
}

function dispose(): void {
  try {
    if (module && !fatal) {
      if (document) { const value = document; document = 0; if (!call('dsh_lok_document_destroy', [value])) throw error('render-failed') }
      if (office) { const value = office; office = 0; if (!call('dsh_lok_destroy', [value])) throw error('render-failed') }
    }
  } finally {
    module?.PThread.terminateAllThreads()
    module = undefined
    document = 0
    office = 0
    pages = []
  }
}

scope.onmessage = (event: MessageEvent<OwnerMessage>) => {
  const message = event.data
  if (message.type === 'dispose') lifetime.abort()
  serial = serial.then(async () => {
    try {
      switch (message.type) {
        case 'open': await open(message.options, message.channel); send({ type: 'opened', id: message.id, pages: pages.map(({ width, height }) => ({ width, height })) }); break
        case 'tile': { const tile = render(message.request); send({ type: 'tile', id: message.id, tile }, [tile.rgba.buffer]); break }
        case 'dispose': dispose(); send({ type: 'disposed', id: message.id }); scope.close(); break
      }
    } catch (failure) {
      fatal ||= failure instanceof WebAssembly.RuntimeError
      send({ type: 'error', id: message.id, code: failure instanceof BrowserRenderError ? failure.code : 'render-failed', message: failure instanceof Error ? failure.message : String(failure), fatal })
    }
  })
}
