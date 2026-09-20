/** Worker-owned reading, bounded VCL event slices and immutable notifications. */
import { BrowserRenderError } from './types.ts'
import type { BrowserTile } from './types.ts'
import type { EmscriptenModule } from './engine-types.ts'
import type { OfficeOperation } from './protocol.ts'
import type { OfficeDocumentEvent, OfficeDocumentFormat, OfficeDocumentState, OfficeDocumentTileRequest, OfficeDocumentRectangle, OfficeDocumentLayoutRequest, OfficeDocumentLayoutResult } from './office-types.ts'
import { parseCellRange } from '@deepseek-ai/libreoffice-kit/internal/sheet-geometry'
import { renderRegion } from './engine-rendering.ts'
import { TWIPS_PER_CSS_PIXEL, writerPages } from './rendering.ts'

function rectangle(payload: string): OfficeDocumentRectangle | null {
  if (payload.startsWith('{')) {
    const value: unknown = JSON.parse(payload)
    if (typeof value !== 'object' || value === null || !('rectangle' in value) || typeof value.rectangle !== 'string') return null
    payload = value.rectangle
  }
  if (!payload || payload.startsWith('EMPTY') || payload === 'INPLACE') return null
  const values = payload.split(',').slice(0, 4).map(Number)
  if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return null
  const [x, y, width, height] = values.map(value => value / TWIPS_PER_CSS_PIXEL) as [number, number, number, number]
  return width >= 0 && height >= 0 ? { x, y, width, height } : null
}

function integer(value: number, max = 0x7fffffff): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new BrowserRenderError('render-failed', 'Office input contains an invalid integer.')
  return value
}

function twips(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value * TWIPS_PER_CSS_PIXEL) > 0x7fffffff) throw new BrowserRenderError('render-failed', 'Office input lies outside document coordinates.')
  return Math.round(value * TWIPS_PER_CSS_PIXEL)
}

const navigationKeys = { down: 0x400, up: 0x401, left: 0x402, right: 0x403, home: 0x404, end: 0x405, pageUp: 0x406, pageDown: 0x407 } as const

/** One read-only document, driven exclusively by its Worker's messages and timer. */
export class OfficeEngine {
  state: OfficeDocumentState
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly callbacks: { type: number; payload: string }[] = []
  private geometryDirty = false
  private stopped = false
  private layoutWidth = 0
  private viewport = ''
  private captureView: number | undefined
  private readingView: number | undefined
  private commandResult: { name: string; resolve: () => void; reject: (error: unknown) => void } | undefined

  constructor(private readonly module: EmscriptenModule, private readonly document: number,
    format: OfficeDocumentFormat, private readonly emit: (event: OfficeDocumentEvent) => void,
    private readonly failure: (error: unknown) => void) {
    this.state = { documentType: format === 'docx' || format === 'doc' ? 'text' : format === 'xlsx' || format === 'xls' ? 'spreadsheet' : 'presentation',
      renderGeneration: 0, layoutGeneration: 0, layout: 'paginated', part: 0, parts: [], pages: [], cursor: null,
      selection: [], graphicSelection: null, cellAddress: '', cellFormula: '' }
  }

  private call(name: string, args: (number | string)[] = []): number {
    return this.module.ccall(name, 'number', args.map(value => typeof value), args)
  }
  private text(name: string, args: (number | string)[]): string {
    const pointer = this.call(name, args)
    if (!pointer) return ''
    try { return this.module.UTF8ToString(pointer) } finally { this.call('free', [pointer]) }
  }
  private invoke(name: string, args: (number | string)[] = []): void {
    if (!this.call(`dsh_lok_document_${name}`, [this.document, ...args])) throw new BrowserRenderError('render-failed', `LibreOffice could not complete ${name}.`)
  }
  private requireOpen(): void {
    if (this.stopped) throw new BrowserRenderError('disposed', 'Office document is closed.')
  }
  /** Collect callbacks without reentering LibreOffice inside its callback. */
  callback(type: number, payload: string): void { if (!this.stopped) this.callbacks.push({ type, payload }) }
  /** Enforce the native read-only view before accepting any input. */
  async start(): Promise<void> {
    this.requireOpen()
    if (this.state.documentType === 'presentation') {
      const view = this.call('dsh_lok_document_get_view', [this.document])
      try {
        const created = this.call('dsh_lok_document_create_view', [this.document])
        if (created < 0) throw new BrowserRenderError('render-failed', 'LibreOffice could not create a slide capture view.')
        this.captureView = created
        this.invoke('initialize_rendering')
        this.configure({ mode: 'paginated' })
        this.pump()
      } finally { this.invoke('set_view', [view]) }
      this.readingView = view
    }
    this.configure({ mode: 'paginated' })
    this.invoke('listen')
    this.refreshGeometry()
    this.pump()
    this.schedule()
    await this.command('.uno:ReportWhenIdle', { idleID: { type: 'string', value: 'office-open' } })
  }
  private schedule(): void {
    this.timer = setTimeout(() => {
      if (this.stopped) return
      try { this.pump(); this.schedule() } catch (error) { this.stop(); this.failure(error) }
    }, 16)
  }
  /** Stop event processing before destroying the document. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.callbacks.length = 0
    this.commandResult?.reject(new BrowserRenderError('disposed', 'Office document is closed.'))
    this.commandResult = undefined
  }
  /** Return the part whose cached coordinates changed, or -1 when part identities changed. */
  private refreshGeometry(): number | undefined {
    const count = this.state.documentType === 'text' ? 1 : this.call('dsh_lok_document_parts', [this.document])
    if (!Number.isSafeInteger(count) || count <= 0) throw new BrowserRenderError('invalid-document', 'Office document has no parts.')
    const pointer = this.call('malloc', [8])
    if (!pointer) throw new BrowserRenderError('render-failed', 'Office geometry allocation failed.')
    try {
      const part = Math.min(this.state.part, count - 1)
      this.invoke('size', [part, pointer, pointer + 4])
      const width = this.module.HEAPU32[pointer / 4]! / TWIPS_PER_CSS_PIXEL
      const height = this.module.HEAPU32[pointer / 4 + 1]! / TWIPS_PER_CSS_PIXEL
      if (!(width > 0 && height > 0)) throw new BrowserRenderError('invalid-document', 'Office returned empty document dimensions.')
      // Measure the selected part only, preserving navigation and selection.
      const parts = Array.from({ length: count }, (_, index) => ({
        name: this.state.documentType === 'text' ? '' : this.text('dsh_lok_document_part_name', [this.document, index]),
        width: index === part ? width : this.state.parts[index]?.width ?? width,
        height: index === part ? height : this.state.parts[index]?.height ?? height,
      }))
      const pages = this.state.documentType !== 'text' ? [] : this.state.layout === 'continuous'
        ? [{ x: 0, y: 0, width, height }]
        : writerPages(this.text('dsh_lok_document_page_rectangles', [this.document])).map(page => ({ x: page.x / TWIPS_PER_CSS_PIXEL,
          y: page.y / TWIPS_PER_CSS_PIXEL, width: page.width, height: page.height }))
      const previous = this.state
      const identitiesChanged = previous.parts.length > 0 && (previous.parts.length !== parts.length
        || parts.some((value, index) => value.name !== previous.parts[index]!.name))
      const measured = previous.parts[part]
      const geometryChanged = measured !== undefined && (measured.width !== width || measured.height !== height
        || JSON.stringify(previous.pages) !== JSON.stringify(pages))
      this.state = { ...previous, part, parts, pages }
      this.geometryDirty = false
      return identitiesChanged ? -1 : geometryChanged ? part : undefined
    } finally { this.call('free', [pointer]) }
  }
  private pump(): void {
    if (this.readingView !== undefined) this.invoke('set_view', [this.readingView])
    const deadline = performance.now() + 8
    for (let pass = 0; pass < 8; pass++) {
      const result = this.call('dsh_lok_pump')
      if (result < 0) throw new BrowserRenderError('render-failed', 'LibreOffice event processing failed.')
      if (!result || performance.now() >= deadline) break
    }
    // Deferred native focus events can activate the capture view while pumping.
    if (this.readingView !== undefined) this.invoke('set_view', [this.readingView])
    this.flush()
  }
  private flush(): void {
    if (this.callbacks.length === 0) return
    let changed = false
    const invalidations: { part: number; rectangle: OfficeDocumentRectangle | null }[] = []
    for (const { type, payload } of this.callbacks.splice(0)) {
      switch (type) {
        case 0: {
          const fields = payload.split(',')
          const index = fields[0]?.trim() === 'EMPTY' ? fields[1] : fields[4]
          const part = index !== undefined && /^\s*-?\d+\s*$/.test(index) ? Number(index) : this.state.part
          invalidations.push({ part, rectangle: rectangle(payload) })
          break
        }
        case 1: case 17: this.state = { ...this.state, cursor: rectangle(payload) }; changed = true; break
        case 2: this.state = { ...this.state, selection: payload.split(';').map(rectangle).filter((value): value is OfficeDocumentRectangle => value !== null) }; changed = true; break
        case 6: this.state = { ...this.state, graphicSelection: rectangle(payload) }; changed = true; break
        case 13: this.geometryDirty = true; break
        case 14: {
          const part = Number(payload)
          if (Number.isSafeInteger(part) && part >= 0 && part < this.state.parts.length) {
            this.state = { ...this.state, part }; this.viewport = ''; this.geometryDirty = true; changed = true
          }
          break
        }
        case 16: {
          const result: unknown = JSON.parse(payload)
          if (typeof result === 'object' && result !== null && 'commandName' in result && result.commandName === this.commandResult?.name) this.commandResult?.resolve()
          break
        }
        case 19: this.state = { ...this.state, cellFormula: payload }; changed = true; break
        case 34: this.state = { ...this.state, cellAddress: payload }; changed = true; break
      }
    }
    const geometry = this.geometryDirty ? this.refreshGeometry() : undefined
    if (geometry !== undefined) {
      this.state = { ...this.state, layoutGeneration: this.state.layoutGeneration + 1 }
      // A size notification need not be accompanied by LOK tile invalidation.
      // Keep other sheets' pixels, but never reuse coordinates from an old layout.
      if (!invalidations.some(value => value.rectangle === null && (value.part === -1 || value.part === geometry))) {
        for (let index = invalidations.length - 1; index >= 0; index--) {
          if (geometry === -1 || invalidations[index]!.part === geometry) invalidations.splice(index, 1)
        }
        invalidations.push({ part: geometry, rectangle: null })
      }
    }
    if (invalidations.length > 0) {
      this.state = { ...this.state, renderGeneration: this.state.renderGeneration + 1 }
      changed = true
    }
    if (changed) this.emit({ type: 'state', state: this.state })
    for (const invalidation of invalidations) this.emit({ type: 'invalidate', ...invalidation, generation: this.state.renderGeneration })
  }
  /** The Worker permits only these typed reading operations, including at runtime. */
  async operation(operation: OfficeOperation): Promise<{ text?: string; layout?: OfficeDocumentLayoutResult }> {
    this.requireOpen()
    if (this.readingView !== undefined) this.invoke('set_view', [this.readingView])
    if (!operation || typeof operation !== 'object') throw new BrowserRenderError('render-failed', 'Invalid Office reading operation.')
    switch (operation.type) {
      case 'pointer': {
        const event = operation.event
        if (!event || !['down', 'up', 'move'].includes(event.action) || ![0, 1].includes(event.buttons)
          || ![0, 0x1000, 0x2000, 0x3000].includes(event.modifiers)) throw new BrowserRenderError('render-failed', 'Invalid Office selection pointer.')
        this.invoke('mouse', [event.action === 'down' ? 0 : event.action === 'up' ? 1 : 2,
          twips(event.x), twips(event.y), integer(event.clicks, 3), event.buttons, event.modifiers])
        break
      }
      case 'navigate': {
        const event = operation.event
        if (!event || !Object.hasOwn(navigationKeys, event.key)
          || (event.extend !== undefined && typeof event.extend !== 'boolean') || (event.word !== undefined && typeof event.word !== 'boolean')) {
          throw new BrowserRenderError('render-failed', 'Invalid Office navigation key.')
        }
        const key = navigationKeys[event.key] | (event.extend ? 0x1000 : 0) | (event.word ? 0x2000 : 0)
        this.invoke('key', [0, 0, key]); this.invoke('key', [1, 0, key])
        break
      }
      case 'select-all': await this.command('.uno:SelectAll', {}); break
      case 'cell': {
        if (this.state.documentType !== 'spreadsheet' || typeof operation.address !== 'string') throw new BrowserRenderError('render-failed', 'Cell navigation requires a spreadsheet address.')
        try { parseCellRange(operation.address) } catch { throw new BrowserRenderError('render-failed', 'Cell navigation requires a bounded A1 cell or range.') }
        await this.command('.uno:GoToCell', { ToPoint: { type: 'string', value: operation.address } })
        break
      }
      case 'copy': this.pump(); return { text: this.text('dsh_lok_document_selection', [this.document]) }
      case 'part': {
        const part = integer(operation.part, this.state.parts.length - 1)
        if (part === this.state.part) break
        this.invoke('part', [part])
        this.viewport = ''
        this.state = { ...this.state, part, cursor: null, selection: [], graphicSelection: null, cellAddress: '', cellFormula: '' }
        const geometry = this.refreshGeometry()
        if (geometry !== undefined) this.state = { ...this.state, layoutGeneration: this.state.layoutGeneration + 1,
          renderGeneration: this.state.renderGeneration + 1 }
        this.emit({ type: 'state', state: this.state })
        if (geometry !== undefined) this.emit({ type: 'invalidate', part: geometry, rectangle: null, generation: this.state.renderGeneration })
        break
      }
      case 'viewport': {
        const { x, y, width, height } = operation.rectangle
        if (!(operation.scale > 0 && operation.scale <= 16 && width > 0 && height > 0)) throw new BrowserRenderError('render-failed', 'Office viewport is invalid.')
        const args = [Math.max(1, Math.round(256 * operation.scale)), 256 * TWIPS_PER_CSS_PIXEL, twips(x), twips(y), twips(width), twips(height)]
        const key = args.join(',')
        if (key !== this.viewport) { this.invoke('viewport', args); this.viewport = key }
        break
      }
      case 'layout': {
        const request = operation.request
        if (!request || !['paginated', 'continuous'].includes(request.mode) || (request.mode === 'continuous' && this.state.documentType !== 'text')) {
          throw new BrowserRenderError('render-failed', 'Continuous layout is only available for Writer documents.')
        }
        const width = request.mode === 'continuous' ? twips(request.width) : 0
        if (request.mode === 'continuous' && width <= 0) throw new BrowserRenderError('render-failed', 'Continuous layout requires a positive width.')
        if (request.anchor && (twips(request.anchor.x) < 0 || twips(request.anchor.y) < 0)) throw new BrowserRenderError('render-failed', 'Reading anchors must lie within positive document coordinates.')
        if (request.mode === this.state.layout && width === this.layoutWidth) return { layout: { changed: false } }
        const result = this.configure(request)
        this.layoutWidth = width
        this.viewport = ''
        this.state = { ...this.state, layout: request.mode, layoutGeneration: this.state.layoutGeneration + 1,
          renderGeneration: this.state.renderGeneration + 1 }
        // Establish the requested layout before its acknowledgement pumps any
        // matching size callback; that callback must not invalidate it twice.
        this.refreshGeometry()
        await this.command('.uno:ReportWhenIdle', { idleID: { type: 'string', value: 'office-layout' } })
        this.refreshGeometry()
        this.emit({ type: 'state', state: this.state })
        this.emit({ type: 'invalidate', part: -1, rectangle: null, generation: this.state.renderGeneration })
        return { layout: result }
      }
      default: throw new BrowserRenderError('render-failed', 'Unsupported Office reading operation.')
    }
    this.pump()
    return {}
  }
  private configure(request: OfficeDocumentLayoutRequest): OfficeDocumentLayoutResult {
    const raw = this.text('dsh_lok_document_configure_view', [this.document, 1, request.mode === 'continuous' ? 1 : 0,
      request.mode === 'continuous' ? twips(request.width) : 0, request.anchor ? twips(request.anchor.x) : -1, request.anchor ? twips(request.anchor.y) : -1])
    if (!raw) throw new BrowserRenderError('render-failed', 'LibreOffice could not configure its read-only view.')
    const result = JSON.parse(raw) as { changed: boolean; width: number; height: number; anchor?: OfficeDocumentRectangle }
    if (typeof result.changed !== 'boolean' || !(result.width > 0 && result.height > 0)) throw new BrowserRenderError('render-failed', 'LibreOffice returned an invalid reading layout.')
    if (result.anchor === undefined) return { changed: result.changed }
    const { x, y, width, height } = result.anchor
    if (![x, y, width, height].every(value => Number.isFinite(value) && value >= 0)) throw new BrowserRenderError('render-failed', 'LibreOffice returned an invalid reading anchor.')
    return { changed: result.changed, anchor: { x: x / TWIPS_PER_CSS_PIXEL, y: y / TWIPS_PER_CSS_PIXEL,
      width: width / TWIPS_PER_CSS_PIXEL, height: height / TWIPS_PER_CSS_PIXEL } }
  }
  /** Internal whitelist commands only; no arbitrary command crosses the public API. */
  private async command(name: '.uno:ReportWhenIdle' | '.uno:SelectAll' | '.uno:GoToCell', args: unknown): Promise<void> {
    const result = Promise.withResolvers<void>()
    this.commandResult = { name, resolve: () => result.resolve(), reject: result.reject }
    try { this.invoke('command', [name, JSON.stringify(args)]); this.pump(); await result.promise }
    finally { this.commandResult = undefined }
  }
  /** Direct tiles preserve the active view, navigation state and selection. */
  render(request: OfficeDocumentTileRequest): BrowserTile {
    this.requireOpen()
    if (this.readingView !== undefined) this.invoke('set_view', [this.readingView])
    this.flush()
    const part = this.state.parts[integer(request.part, this.state.parts.length - 1)]!
    const capture = request.part !== this.state.part
    if (capture && this.state.documentType !== 'presentation') throw new BrowserRenderError('stale-part', 'The Office tile belongs to an inactive worksheet.')
    try {
      if (capture) this.invoke('set_view', [this.captureView!])
      return renderRegion(this.module, this.document, { ...request, pageIndex: 0 }, [{ ...part, x: 0, y: 0,
        part: this.state.documentType === 'text' ? -1 : request.part }], () => new BrowserRenderError('render-failed', 'Office tile rendering failed.'))
    } finally {
      if (this.readingView !== undefined) this.invoke('set_view', [this.readingView])
      this.flush()
    }
  }
}
