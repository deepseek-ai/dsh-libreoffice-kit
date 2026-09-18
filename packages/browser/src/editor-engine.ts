/** Worker-owned editing, VCL event slices and immutable editing notifications. */
import { BrowserRenderError } from './types.ts'
import type { BrowserTile } from './types.ts'
import type { EmscriptenModule } from './engine-types.ts'
import type { EditorOperation } from './protocol.ts'
import type { BrowserEditorCapture, BrowserEditorCaptureRegion, BrowserEditorCaptureRequest, BrowserEditorEvent, BrowserEditorFormat, BrowserEditorSnapshot, BrowserEditorState, BrowserEditorTileRequest, BrowserRectangle } from './editor-types.ts'
import { dataArea, parseCellRange, rangeName, sheetPartInfo, sheetRangeRectangle, type SheetGeometry } from '@deepseek-ai/libreoffice-kit/internal/sheet-geometry'
import { renderRegion } from './engine-rendering.ts'
import { tileDimensions, TWIPS_PER_CSS_PIXEL, writerPages } from './rendering.ts'

function rectangle(payload: string): BrowserRectangle | null {
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

/** One editor, driven exclusively by its owning Worker's messages and timer. */
export class EditorEngine {
  state: BrowserEditorState
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly callbacks: { type: number; payload: string; phase: string }[] = []
  private phase = 'view'
  private modified = false
  private geometryDirty = false
  private stopped = false
  private renderView = -1
  private commandResult: { name: string; resolve: () => void; reject: (error: unknown) => void } | undefined

  constructor(private readonly module: EmscriptenModule, private readonly document: number,
    private readonly format: BrowserEditorFormat, private readonly maxBytes: number,
    private readonly emit: (event: BrowserEditorEvent) => void, private readonly failure: (error: unknown) => void,
    private readonly readOnly = false) {
    this.state = { documentType: format === 'docx' || format === 'doc' ? 'text' : format === 'xlsx' || format === 'xls' ? 'spreadsheet' : 'presentation', revision: 0, renderGeneration: 0,
      part: 0, parts: [], pages: [], cursor: null, cursorVisible: false, selection: [], graphicSelection: null,
      cellAddress: '', cellFormula: '', commands: {} }
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

  /** Collect callbacks without reentering LibreOffice from inside its own callback. */
  callback(type: number, payload: string): void { if (!this.stopped) this.callbacks.push({ type, payload, phase: this.phase }) }

  /** Register callbacks after document initialization, then begin bounded event slices. */
  async start(): Promise<void> {
    this.invoke('listen')
    this.refreshGeometry()
    this.pump()
    this.schedule()
    await this.command('.uno:ReportWhenIdle', { idleID: { type: 'string', value: 'editor-open' } })
    this.state = { ...this.state, revision: 0 }
    this.phase = 'idle'
  }

  private schedule(): void {
    this.timer = setTimeout(() => {
      if (this.stopped) return
      try { this.pump(); this.schedule() } catch (error) { this.stop(); this.failure(error) }
    }, 16)
  }

  /** Cancel the owned timer before the document or office is destroyed. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.callbacks.length = 0
    this.commandResult?.reject(new BrowserRenderError('disposed', 'Office editor is closed.'))
    this.commandResult = undefined
    if (this.renderView >= 0) {
      this.call('dsh_lok_document_destroy_view', [this.document, this.renderView])
      this.renderView = -1
    }
  }

  private refreshGeometry(): void {
    const phase = this.phase
    this.phase = 'view'
    const count = this.state.documentType === 'text' ? 1 : this.call('dsh_lok_document_parts', [this.document])
    if (!Number.isSafeInteger(count) || count <= 0) throw new BrowserRenderError('invalid-document', 'Office document has no editable parts.')
    const pointer = this.call('malloc', [8])
    if (!pointer) throw new BrowserRenderError('render-failed', 'Office geometry allocation failed.')
    try {
      const part = Math.min(this.state.part, count - 1)
      this.invoke('size', [part, pointer, pointer + 4])
      const width = this.module.HEAPU32[pointer / 4]! / TWIPS_PER_CSS_PIXEL
      const height = this.module.HEAPU32[pointer / 4 + 1]! / TWIPS_PER_CSS_PIXEL
      if (!(width > 0 && height > 0)) throw new BrowserRenderError('invalid-document', 'Office returned empty document dimensions.')
      // Switching worksheets to measure them can commit an in-progress cell or IME edit.
      // Inactive parts retain their last observed dimensions until selected.
      const parts = Array.from({ length: count }, (_, index) => ({
        name: this.state.documentType === 'text' ? '' : this.text('dsh_lok_document_part_name', [this.document, index]),
        width: index === part ? width : this.state.parts[index]?.width ?? width,
        height: index === part ? height : this.state.parts[index]?.height ?? height,
      }))
      const pages = this.state.documentType === 'text'
        ? writerPages(this.text('dsh_lok_document_page_rectangles', [this.document])).map(page => ({ x: page.x / TWIPS_PER_CSS_PIXEL,
          y: page.y / TWIPS_PER_CSS_PIXEL, width: page.width, height: page.height })) : []
      this.state = { ...this.state, part, parts, pages }
    } finally { this.call('free', [pointer]); this.phase = phase }
    this.geometryDirty = false
  }

  private pump(): void {
    const deadline = performance.now() + 8
    // A newly created capture window can activate itself through deferred VCL
    // events. Preserve the caller's view so subsequent commands retain their
    // callback channel and never target the read-only capture window.
    const view = this.renderView >= 0 ? this.call('dsh_lok_document_get_view', [this.document]) : -1
    try {
      for (let pass = 0; pass < 8; pass++) {
        const result = this.call('dsh_lok_pump')
        if (result < 0) throw new BrowserRenderError('render-failed', 'LibreOffice event processing failed.')
        if (!result || performance.now() >= deadline) break
      }
    } finally {
      if (view >= 0 && !this.call('dsh_lok_document_set_view', [this.document, view])) {
        throw new BrowserRenderError('render-failed', 'The editor view could not be restored after event processing.')
      }
    }
    this.flush()
  }

  private flush(): void {
    if (this.callbacks.length === 0) return
    let changed = false
    let edited = false
    const invalidations: { part: number; rectangle: BrowserRectangle | null }[] = []
    for (const { type, payload, phase } of this.callbacks.splice(0)) {
      switch (type) {
        case 0: {
          const fields = payload.split(',')
          const index = fields[0]?.trim() === 'EMPTY' ? fields[1] : fields[4]
          const part = index !== undefined && /^\s*-?\d+\s*$/.test(index) ? Number(index) : this.state.part
          invalidations.push({ part, rectangle: rectangle(payload) })
          edited ||= !['paint', 'view', 'save', 'capture'].includes(phase)
          break
        }
        case 1: this.state = { ...this.state, cursor: rectangle(payload) }; changed = true; break
        case 2: this.state = { ...this.state, selection: payload.split(';').map(rectangle).filter((value): value is BrowserRectangle => value !== null) }; changed = true; break
        case 5: this.state = { ...this.state, cursorVisible: payload === 'true' }; changed = true; break
        case 6: this.state = { ...this.state, graphicSelection: rectangle(payload) }; changed = true; break
        case 8: {
          const separator = payload.indexOf('=')
          if (separator < 0) break
          const command = payload.slice(0, separator), value = payload.slice(separator + 1)
          if (command === '.uno:ModifiedStatus') { this.modified = value === 'true'; edited ||= this.modified }
          this.state = { ...this.state, commands: { ...this.state.commands, [command]: value } }
          changed = true
          break
        }
        case 13: this.geometryDirty = true; changed = true; break
        case 14: {
          const part = Number(payload)
          if (Number.isSafeInteger(part) && part >= 0 && part < this.state.parts.length) this.state = { ...this.state, part }
          changed = true
          break
        }
        case 16: {
          const result: unknown = JSON.parse(payload)
          if (typeof result !== 'object' || result === null || !('commandName' in result)
            || result.commandName !== this.commandResult?.name) break
          // Writer's Undo executes without setting SfxRequest::Done or a return value,
          // so its dispatch notification reports success=false even after the edit.
          // This notification acknowledges completion; state callbacks report effects.
          this.commandResult!.resolve()
          break
        }
        case 17: this.state = { ...this.state, cursor: rectangle(payload), cursorVisible: true }; changed = true; break
        case 19: this.state = { ...this.state, cellFormula: payload }; changed = true; break
        case 34: this.state = { ...this.state, cellAddress: payload }; changed = true; break
      }
    }
    if (edited && this.modified) { this.state = { ...this.state, revision: this.state.revision + 1 }; changed = true }
    if (invalidations.length > 0 || this.geometryDirty) {
      this.state = { ...this.state, renderGeneration: this.state.renderGeneration + 1 }
      changed = true
    }
    if (this.geometryDirty) this.refreshGeometry()
    if (changed) this.emit({ type: 'state', state: this.state })
    for (const invalidation of invalidations) this.emit({ type: 'invalidate', ...invalidation, revision: this.state.revision })
  }

  /** Apply one ordered command and collect the resulting notifications before acknowledgement. */
  async operation(operation: EditorOperation): Promise<{ text?: string; snapshot?: BrowserEditorSnapshot }> {
    if (this.readOnly && ['input', 'command', 'paste', 'save'].includes(operation.type)) throw new BrowserRenderError('render-failed', 'This Office document is read-only.')
    this.phase = operation.type === 'part' || operation.type === 'viewport' ? 'view' : operation.type === 'save' ? 'save' : 'edit'
    try {
      switch (operation.type) {
        case 'input': {
          const event = operation.event
          if (event.type === 'key') this.invoke('key', [event.action === 'down' ? 0 : 1, integer(event.character, 0x10ffff), integer(event.key, 0xffff)])
          else if (event.type === 'pointer') this.invoke('mouse', [event.action === 'down' ? 0 : event.action === 'up' ? 1 : 2,
            twips(event.x), twips(event.y), integer(event.clicks, 3), integer(event.buttons, 7), integer(event.modifiers, 0xffff)])
          else { this.checkText(event.text); this.invoke('composition', [event.action === 'update' ? 0 : 2, event.text]) }
          break
        }
        case 'command':
          if (!/^\.uno:[A-Za-z][A-Za-z0-9]*$/.test(operation.command)) throw new BrowserRenderError('render-failed', 'Office command must name a UNO command.')
          await this.command(operation.command, operation.arguments ?? {})
          break
        case 'paste': {
          this.checkText(operation.text)
          this.invoke('paste', ['text/plain;charset=utf-8', operation.text, new TextEncoder().encode(operation.text).byteLength])
          break
        }
        case 'copy': return { text: this.text('dsh_lok_document_selection', [this.document]) }
        case 'part': {
          const part = integer(operation.part, this.state.parts.length - 1)
          this.invoke('part', [part])
          this.state = { ...this.state, part, cursor: null, selection: [], graphicSelection: null }
          this.refreshGeometry()
          this.emit({ type: 'state', state: this.state })
          break
        }
        case 'viewport': {
          const { x, y, width, height } = operation.rectangle
          if (!(operation.scale > 0 && operation.scale <= 16 && width > 0 && height > 0)) throw new BrowserRenderError('render-failed', 'Office viewport is invalid.')
          this.invoke('viewport', [Math.max(1, Math.round(256 * operation.scale)), 256 * TWIPS_PER_CSS_PIXEL, twips(x), twips(y), twips(width), twips(height)])
          break
        }
        case 'save': {
          this.pump()
          const path = `/dsh/export.${this.format}`
          this.invoke('save', [`file://${path}`, this.format])
          const data = this.module.FS.readFile(path)
          this.module.FS.unlink(path)
          if (data.length === 0 || data.length > this.maxBytes) throw new BrowserRenderError('render-failed', 'Office export exceeds the configured byte limit.')
          this.pump()
          return { snapshot: { data, revision: this.state.revision, extension: this.format } }
        }
      }
      this.pump()
      return {}
    } finally { this.phase = 'idle' }
  }

  private checkText(text: string): void {
    if (typeof text !== 'string' || text.includes('\0') || new TextEncoder().encode(text).length > this.maxBytes) throw new BrowserRenderError('render-failed', 'Office input exceeds the text limit or contains NUL.')
  }

  private async command(name: string, args: unknown): Promise<void> {
    const result = Promise.withResolvers<void>()
    this.commandResult = { name, resolve: () => result.resolve(), reject: result.reject }
    try {
      this.invoke('command', [name, JSON.stringify(args)])
      this.pump()
      await result.promise
    } finally { this.commandResult = undefined }
  }

  /** Painting preserves the active selection and cannot itself mark the document edited. */
  render(request: BrowserEditorTileRequest): BrowserTile {
    const part = this.state.parts[integer(request.part, this.state.parts.length - 1)]!
    this.phase = 'paint'
    try {
      return renderRegion(this.module, this.document, { ...request, pageIndex: 0 }, [{ ...part, x: 0, y: 0,
        part: this.state.documentType === 'text' ? -1 : request.part }], () => new BrowserRenderError('render-failed', 'Office tile rendering failed.'))
    } finally { this.flush(); this.phase = 'idle' }
  }

  /** Capture one bounded batch with no input interleaving; cached tiles are checked at the same generation. */
  async capture(request: BrowserEditorCaptureRequest): Promise<BrowserEditorCapture> {
    integer(request.maxPixels)
    if (!request.maxPixels || request.maxPixels > 67_108_864 || request.tiles.length > 4096) {
      throw new BrowserRenderError('render-failed', 'Office capture exceeds its allocation limit.')
    }
    await this.command('.uno:ReportWhenIdle', { idleID: { type: 'string', value: 'capture' } })
    this.pump()
    const generation = this.state.renderGeneration
    if (request.generation !== undefined && request.generation !== generation) throw new BrowserRenderError('snapshot-changed', 'The document changed before capture.')
    const original = this.call('dsh_lok_document_get_view', [this.document])
    if (original < 0) throw new BrowserRenderError('render-failed', 'The editor view is unavailable.')
    this.phase = 'capture'
    let parts = this.state.parts
    const tiles: BrowserTile[] = []
    const regions: BrowserEditorCaptureRegion[] = []
    try {
      if (this.renderView < 0) this.renderView = this.call('dsh_lok_document_create_view', [this.document])
      if (this.renderView < 0 || !this.call('dsh_lok_document_set_view', [this.document, this.renderView])) throw new BrowserRenderError('render-failed', 'The capture view is unavailable.')
      const pointer = this.call('malloc', [8])
      if (!pointer) throw new BrowserRenderError('render-failed', 'Office capture geometry allocation failed.')
      try {
        parts = this.state.parts.map((part, index) => {
          this.invoke('size', [index, pointer, pointer + 4])
          const width = this.module.HEAPU32[pointer / 4]! / TWIPS_PER_CSS_PIXEL
          const height = this.module.HEAPU32[pointer / 4 + 1]! / TWIPS_PER_CSS_PIXEL
          if (!(width > 0 && height > 0)) throw new BrowserRenderError('invalid-document', 'Office returned empty capture dimensions.')
          return { ...part, width, height }
        })
      } finally { this.call('free', [pointer]) }
      if (request.selection !== undefined && this.state.documentType === 'spreadsheet') {
        const selection = request.selection
        for (let part = 0; part < parts.length; part++) {
          const info = sheetPartInfo(this.text('dsh_lok_document_part_info', [this.document, part]))
          if (selection.sheet !== undefined ? selection.sheet !== info.name : !info.visible) continue
          this.invoke('part', [part])
          this.invoke('viewport', [Math.max(1, Math.round(256 * selection.scale)), 256 * TWIPS_PER_CSS_PIXEL, 0, 0, 1, 1])
          const range = selection.range === undefined ? dataArea(info) : parseCellRange(selection.range)
          const geometry = JSON.parse(this.text('dsh_lok_document_command_values', [this.document, '.uno:SheetGeometryData'])) as SheetGeometry
          const rectangle = sheetRangeRectangle(geometry, range, selection.scale)
          this.text('dsh_lok_document_command_values', [this.document, `.uno:ViewRowColumnHeaders?x=${twips(rectangle.x)}&y=${twips(rectangle.y)}&width=${twips(rectangle.width)}&height=${twips(rectangle.height)}`])
          regions.push({ part, sheet: info.name, range: rangeName(range), rectangle })
          parts = parts.map((entry, index) => index === part ? { ...entry, width: Math.max(entry.width, rectangle.x + rectangle.width), height: Math.max(entry.height, rectangle.y + rectangle.height) } : entry)
        }
        if (regions.length === 0) throw new BrowserRenderError('invalid-document', 'No worksheet matches the export selection.')
      } else if (this.state.documentType === 'text') {
        regions.push(...this.state.pages.map(rectangle => ({ part: 0, rectangle })))
      } else if (this.state.documentType === 'presentation') {
        regions.push(...parts.map((part, index) => ({ part: index, rectangle: { x: 0, y: 0, width: part.width, height: part.height } })))
      }
      let pixels = 0
      for (const entry of request.tiles) {
        const part = parts[integer(entry.request.part, parts.length - 1)]!
        const page = { ...part, x: 0, y: 0, part: this.state.documentType === 'text' ? -1 : entry.request.part }
        const region = { ...entry.request, pageIndex: 0 }
        const size = tileDimensions(region, [page])
        pixels += size.width * size.height
        if (pixels > request.maxPixels) throw new BrowserRenderError('render-failed', 'Office capture exceeds its pixel budget.')
        if (entry.cached !== undefined) {
          if (request.generation === undefined || entry.cached.width !== size.width || entry.cached.height !== size.height
            || entry.cached.rgba.byteLength !== size.width * size.height * 4) throw new BrowserRenderError('render-failed', 'Cached Office pixels do not match the capture.')
          tiles.push(entry.cached)
        } else {
          this.invoke('part', [entry.request.part])
          tiles.push(renderRegion(this.module, this.document, region, [page], () => new BrowserRenderError('render-failed', 'Office capture failed.')))
        }
      }
    } finally {
      this.call('dsh_lok_document_set_view', [this.document, original])
      this.pump()
      this.phase = 'idle'
    }
    await this.command('.uno:ReportWhenIdle', { idleID: { type: 'string', value: 'capture-complete' } })
    this.pump()
    if (this.state.renderGeneration !== generation) throw new BrowserRenderError('snapshot-changed', 'The document changed during capture.')
    return { state: { ...this.state, parts }, tiles, regions }
  }
}
