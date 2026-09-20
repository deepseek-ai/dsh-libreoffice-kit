/** Read-only ABI boundaries, layout generations and selection-preserving geometry. */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { OfficeEngine } from '../src/office-engine.ts'
import type { EmscriptenModule } from '../src/engine-types.ts'
import type { OfficeDocumentEvent, OfficeDocumentFormat } from '../src/office-types.ts'
import type { OfficeOperation } from '../src/protocol.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
function fixture(format: OfficeDocumentFormat = 'xlsx') {
  const memory = new Uint32Array(8), measured: number[] = [], events: OfficeDocumentEvent[] = []
  const overrides = new Map<string, number | ((args: unknown[]) => number)>()
  let hold = false, reader: OfficeEngine
  let pageRectangles = '0, 0, 12000, 16000'
  let layout = { changed: true, width: 12000, height: 16000 } as { changed: boolean; width: number; height: number; anchor?: { x: number; y: number; width: number; height: number } }
  const module: EmscriptenModule = {
    ENV: {}, HEAPU32: memory, PThread: { terminateAllThreads() {} },
    FS: { mkdirTree() {}, writeFile: vi.fn(), readFile: vi.fn(), unlink: vi.fn() },
    UTF8ToString: pointer => pointer === 20 ? 'First' : pointer === 28 ? pageRectangles : pointer === 32 ? JSON.stringify(layout) : 'Second',
    ccall: vi.fn((name, _returnType, _types, args) => {
      const override = overrides.get(name)
      if (override !== undefined) return typeof override === 'number' ? override : override(args)
      switch (name) {
        case 'malloc': return 4
        case 'free': return 0
        case 'dsh_lok_document_configure_view': return 32
        case 'dsh_lok_document_parts': return 2
        case 'dsh_lok_document_part_name': return args[1] === 0 ? 20 : 24
        case 'dsh_lok_document_page_rectangles': return 28
        case 'dsh_lok_document_selection': return 20
        case 'dsh_lok_document_size':
          measured.push(Number(args[1])); memory[1] = layout.width; memory[2] = args[1] === 0 ? layout.height : 20000; return 1
        case 'dsh_lok_document_command':
          if (!hold) reader.callback(16, JSON.stringify({ commandName: args[1], success: true }))
          return 1
        case 'dsh_lok_pump': return 0
        default: return 1
      }
    }),
  }
  const failed = vi.fn()
  reader = new OfficeEngine(module, 1, format, event => { events.push(event) }, failed)
  onTestFinished(() => { reader.stop() })
  return { reader, module, overrides, memory, events, measured, failed, hold: () => { hold = true },
    setPageRectangles: (value: string) => { pageRectangles = value }, setLayout: (value: typeof layout) => { layout = value } }
}
it.each(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'] as const)('enforces the read-only paginated view before accepting %s input', async format => {
  const f = fixture(format); await f.reader.start()
  const calls = vi.mocked(f.module.ccall).mock.calls.map(([name]) => name)
  expect(calls.indexOf('dsh_lok_document_configure_view')).toBeLessThan(calls.indexOf('dsh_lok_document_listen'))
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_configure_view', 'number', expect.any(Array), [1, 1, 0, 0, -1, -1])
  expect(f.reader.state.layout).toBe('paginated')
  expect(f.reader.state).not.toHaveProperty('revision'); expect(f.reader.state).not.toHaveProperty('commands')
})
it('rejects a presentation whose capture view cannot be created', async () => {
  const f = fixture('pptx')
  f.overrides.set('dsh_lok_document_create_view', -1)
  await expect(f.reader.start()).rejects.toMatchObject({ code: 'render-failed' })
})
it.each(['input', 'command', 'paste', 'save', 'capture', 'composition', 'key'])('rejects legacy mutation operation %s before entering LibreOffice', async type => {
  const f = fixture(); await f.reader.start(); vi.mocked(f.module.ccall).mockClear()
  await expect(f.reader.operation({ type, event: { type: 'composition', text: '中文' }, command: '.uno:Bold' } as unknown as OfficeOperation)).rejects.toMatchObject({ code: 'render-failed' })
  expect(f.module.ccall).not.toHaveBeenCalled(); expect(f.module.FS.writeFile).not.toHaveBeenCalled(); expect(f.module.FS.readFile).not.toHaveBeenCalled()
})
it('allows selection, navigation and copy without exposing raw key or UNO commands', async () => {
  const f = fixture(); await f.reader.start()
  for (const action of ['down', 'up', 'move'] as const) await f.reader.operation({ type: 'pointer', event: { action, x: -1, y: 2, buttons: 1, clicks: 2, modifiers: 0x1000 } })
  await f.reader.operation({ type: 'navigate', event: { key: 'right', extend: true, word: true } })
  await f.reader.operation({ type: 'select-all' }); await f.reader.operation({ type: 'cell', address: '$A$1:C5' })
  expect(await f.reader.operation({ type: 'copy' })).toEqual({ text: 'First' })
  for (const action of [0, 1, 2]) expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_mouse', 'number', expect.any(Array), [1, action, -15, 30, 2, 1, 0x1000])
  for (const action of [0, 1]) expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_key', 'number', expect.any(Array), [1, action, 0, 0x3403])
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_command', 'number', expect.any(Array), [1, '.uno:GoToCell', '{"ToPoint":{"type":"string","value":"$A$1:C5"}}'])
  const commands = vi.mocked(f.module.ccall).mock.calls.filter(([name]) => name === 'dsh_lok_document_command').map(([, , , args]) => args[1])
  expect(commands).toEqual(['.uno:ReportWhenIdle', '.uno:SelectAll', '.uno:GoToCell'])
  f.overrides.set('dsh_lok_document_selection', 0); expect(await f.reader.operation({ type: 'copy' })).toEqual({ text: '' })
})
it.each([
  { type: 'navigate', event: { key: 'Delete' } }, { type: 'navigate', event: { key: 'constructor' } },
  { type: 'navigate', event: { key: 'right', extend: 'yes' } }, { type: 'navigate', event: { key: 'right', word: 1 } },
  { type: 'pointer', event: { action: 'paste', x: 0, y: 0, buttons: 1, modifiers: 0, clicks: 1 } },
  { type: 'pointer', event: { action: 'down', x: Infinity, y: 0, buttons: 1, modifiers: 0, clicks: 1 } },
  { type: 'pointer', event: { action: 'down', x: 0, y: 1e10, buttons: 1, modifiers: 0, clicks: 1 } },
  { type: 'pointer', event: { action: 'down', x: 0, y: 0, buttons: 2, modifiers: 0, clicks: 1 } },
  { type: 'pointer', event: { action: 'down', x: 0, y: 0, buttons: 1, modifiers: 0x4000, clicks: 1 } },
  { type: 'pointer', event: { action: 'down', x: 0, y: 0, buttons: 1, modifiers: 0, clicks: 4 } },
  { type: 'cell', address: 'file:///tmp/doc' }, { type: 'cell', address: 'XFE1' }, { type: 'cell', address: 'A1048577' },
  { type: 'part', part: 2 }, { type: 'part', part: -1 }, { type: 'part', part: 1.5 },
  { type: 'layout', request: { mode: 'continuous', width: 500 } },
])('rejects malformed reading operations at the Worker boundary: %j', async operation => {
  const f = fixture(); await f.reader.start(); vi.mocked(f.module.ccall).mockClear()
  await expect(f.reader.operation(operation as OfficeOperation)).rejects.toMatchObject({ code: 'render-failed' })
  expect(f.module.ccall).not.toHaveBeenCalled()
})
it('measures only the active sheet and updates it when navigating parts', async () => {
  const f = fixture(); await f.reader.start(); expect(f.measured).toEqual([0])
  await f.reader.operation({ type: 'part', part: 1 })
  expect(f.measured).toEqual([0, 1]); expect(f.reader.state.parts[1]!.height).toBeCloseTo(20000 / 15)
  await f.reader.operation({ type: 'part', part: 1 }); expect(f.measured).toEqual([0, 1])
  f.reader.callback(13, '12000, 20000'); await vi.advanceTimersByTimeAsync(16)
  expect(f.measured).toEqual([0, 1, 1])
  expect(vi.mocked(f.module.ccall).mock.calls.filter(([name]) => name.includes('_view'))).toHaveLength(1)
})
it('invalidates old Writer pixels on a geometry-only callback without disturbing selection or repainting unchanged size', async () => {
  const f = fixture('docx'); await f.reader.start()
  f.reader.callback(1, '15, 30, 45, 60'); f.reader.callback(2, '15, 30, 45, 60')
  await vi.advanceTimersByTimeAsync(16)
  const { cursor, selection } = f.reader.state
  f.events.length = 0; vi.mocked(f.module.ccall).mockClear()
  f.setLayout({ changed: true, width: 12000, height: 18000 })
  f.reader.callback(13, '12000, 18000'); await vi.advanceTimersByTimeAsync(16)
  expect(f.reader.state).toMatchObject({ layoutGeneration: 1, renderGeneration: 1,
    parts: [{ width: 800, height: 1200 }] })
  expect(f.events).toEqual([{ type: 'state', state: f.reader.state }, { type: 'invalidate', part: 0, rectangle: null, generation: 1 }])
  expect(f.reader.state.cursor).toBe(cursor); expect(f.reader.state.selection).toBe(selection)
  const count = f.events.length
  f.reader.callback(13, '12000, 18000'); await vi.advanceTimersByTimeAsync(16)
  expect(f.events).toHaveLength(count)
  expect(f.reader.state).toMatchObject({ layoutGeneration: 1, renderGeneration: 1 })
  expect(vi.mocked(f.module.ccall).mock.calls.some(([name]) => /_part$|_mouse$|_key$|_paint$/.test(name))).toBe(false)
})
it('invalidates changed Writer page rectangles even when total document dimensions remain equal', async () => {
  const f = fixture('docx'); await f.reader.start()
  f.setPageRectangles('0, 0, 12000, 8000;0, 9000, 12000, 7000')
  f.reader.callback(13, '12000, 16000'); await vi.advanceTimersByTimeAsync(16)
  expect(f.reader.state.pages).toHaveLength(2)
  expect(f.events.at(-1)).toEqual({ type: 'invalidate', part: 0, rectangle: null, generation: 1 })
})
it('preserves measured worksheet caches on part changes and invalidates only the sheet whose geometry changes', async () => {
  const f = fixture(); await f.reader.start()
  await f.reader.operation({ type: 'part', part: 1 })
  expect(f.events.at(-1)).toEqual({ type: 'invalidate', part: 1, rectangle: null, generation: 1 })
  f.events.length = 0
  await f.reader.operation({ type: 'part', part: 0 })
  f.reader.callback(14, '1'); await vi.advanceTimersByTimeAsync(16)
  f.reader.callback(13, '12000, 20000'); await vi.advanceTimersByTimeAsync(16)
  expect(f.events.every(event => event.type === 'state')).toBe(true)
  expect(f.reader.state).toMatchObject({ part: 1, layoutGeneration: 1, renderGeneration: 1 })
  f.setLayout({ changed: true, width: 15000, height: 16000 })
  f.reader.callback(13, '15000, 20000')
  f.reader.callback(0, '0, 0, 15, 15, 1'); f.reader.callback(0, '0, 0, 15, 15, 0')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.events.filter(event => event.type === 'invalidate')).toEqual([
    { type: 'invalidate', part: 0, rectangle: { x: 0, y: 0, width: 1, height: 1 }, generation: 2 },
    { type: 'invalidate', part: 1, rectangle: null, generation: 2 },
  ])
  expect(f.reader.state.layoutGeneration).toBe(2)
})
it.each([-1, 0])('invalidates part identities together and does not duplicate a covering part %s invalidation', async part => {
  const f = fixture(); await f.reader.start()
  f.overrides.set('dsh_lok_document_parts', 1)
  f.reader.callback(13, '12000, 16000'); f.reader.callback(0, '0, 0, 15, 15, 0')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.events.at(-1)).toEqual({ type: 'invalidate', part: -1, rectangle: null, generation: 1 })
  f.events.length = 0
  f.setLayout({ changed: true, width: 15000, height: 16000 })
  f.reader.callback(13, '15000, 16000'); f.reader.callback(0, `EMPTY, ${part}`)
  await vi.advanceTimersByTimeAsync(16)
  expect(f.events.filter(event => event.type === 'invalidate')).toEqual([{ type: 'invalidate', part, rectangle: null, generation: 2 }])
})
it('discards coordinate caches when native part identities change without changing the part count', async () => {
  const f = fixture(); await f.reader.start()
  f.overrides.set('dsh_lok_document_part_name', args => args[1] === 0 ? 24 : 20)
  f.reader.callback(13, '12000, 16000'); await vi.advanceTimersByTimeAsync(16)
  expect(f.reader.state.parts.map(part => part.name)).toEqual(['Second', 'First'])
  expect(f.events.at(-1)).toEqual({ type: 'invalidate', part: -1, rectangle: null, generation: 1 })
})
it('publishes selection, cell contents and invalidations without editor formatting state', async () => {
  const f = fixture(); await f.reader.start()
  f.reader.callback(1, '{"rectangle":"15, 30, 45, 60"}'); f.reader.callback(2, '15, 30, 45, 60;EMPTY;0, 0, 15, 15')
  f.reader.callback(6, '30, 45, 150, 300'); f.reader.callback(8, '.uno:Bold=true'); f.reader.callback(19, '=A1*3'); f.reader.callback(34, 'B1')
  f.reader.callback(0, 'EMPTY, 1'); f.reader.callback(0, '0, 0, 150, 150, -1')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.reader.state).toMatchObject({ cursor: { x: 1, y: 2, width: 3, height: 4 },
    selection: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 0, y: 0, width: 1, height: 1 }],
    graphicSelection: { x: 2, y: 3, width: 10, height: 20 }, cellAddress: 'B1', cellFormula: '=A1*3', renderGeneration: 1 })
  expect(f.events.at(-1)).toEqual({ type: 'invalidate', part: -1, rectangle: { x: 0, y: 0, width: 10, height: 10 }, generation: 1 })
  expect(f.reader.state).not.toHaveProperty('commands')
})
it.each(['', 'EMPTY', 'INPLACE', '{}', '{"rectangle":1}', '0, 0, 15', 'NaN, 0, 15, 15', '0, 0, -1, 15'])('clears an invalid selection rectangle %j', async payload => {
  const f = fixture(); await f.reader.start(); f.reader.callback(17, payload); await vi.advanceTimersByTimeAsync(16); expect(f.reader.state.cursor).toBeNull()
})
it('waits for an allowed command acknowledgement and rejects pending work on close', async () => {
  const f = fixture(); await f.reader.start(); f.hold()
  let completed = false
  const pending = f.reader.operation({ type: 'select-all' }).then(() => { completed = true })
  for (const payload of ['null', '7', '{}', '{"commandName":".uno:Bold"}']) f.reader.callback(16, payload)
  await vi.advanceTimersByTimeAsync(16); expect(completed).toBe(false)
  f.reader.callback(2, '0, 0, 150, 300'); f.reader.callback(16, '{"commandName":".uno:SelectAll","success":false}')
  await vi.advanceTimersByTimeAsync(16); await pending
  expect(f.reader.state.selection).toEqual([{ x: 0, y: 0, width: 10, height: 20 }])
  const cancelled = expect(f.reader.operation({ type: 'select-all' })).rejects.toMatchObject({ code: 'disposed' })
  f.reader.stop(); await cancelled; expect(vi.getTimerCount()).toBe(0)
})
it('deduplicates equivalent viewports, with raster scale separate from reading width', async () => {
  const f = fixture('docx'); await f.reader.start()
  const rectangle = { x: 0, y: 0, width: 500, height: 400 }
  await f.reader.operation({ type: 'viewport', rectangle, scale: 1 })
  await f.reader.operation({ type: 'viewport', rectangle: { ...rectangle }, scale: 1 })
  await f.reader.operation({ type: 'viewport', rectangle, scale: 2 })
  expect(vi.mocked(f.module.ccall).mock.calls.filter(([name]) => name === 'dsh_lok_document_viewport')).toHaveLength(2)
  expect(vi.mocked(f.module.ccall).mock.calls.filter(([name]) => name === 'dsh_lok_document_configure_view')).toHaveLength(1)
  expect(f.reader.state.layoutGeneration).toBe(0)
})
it('changes layout once per width, restores a body anchor and drops paginated geometry', async () => {
  const f = fixture('docx'); await f.reader.start()
  f.setLayout({ changed: true, width: 7500, height: 30000, anchor: { x: 150, y: 3000, width: 30, height: 300 } })
  const result = await f.reader.operation({ type: 'layout', request: { mode: 'continuous', width: 500, anchor: { x: 10, y: 100 } } })
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_configure_view', 'number', expect.any(Array), [1, 1, 1, 7500, 150, 1500])
  expect(result).toEqual({ layout: { changed: true, anchor: { x: 10, y: 200, width: 2, height: 20 } } })
  expect(f.reader.state).toMatchObject({ layout: 'continuous', layoutGeneration: 1, renderGeneration: 1,
    pages: [{ x: 0, y: 0, width: 500, height: 2000 }] })
  expect(f.events.at(-1)).toEqual({ type: 'invalidate', part: -1, rectangle: null, generation: 1 })
  vi.mocked(f.module.ccall).mockClear()
  expect(await f.reader.operation({ type: 'layout', request: { mode: 'continuous', width: 500 } })).toEqual({ layout: { changed: false } })
  expect(f.module.ccall).not.toHaveBeenCalled()
  await f.reader.operation({ type: 'layout', request: { mode: 'paginated' } })
  expect(f.reader.state.layoutGeneration).toBe(2); expect(f.reader.state.pages[0]?.width).toBe(800)
})
it.each([0, -1, NaN, Infinity, 1e10])('rejects invalid continuous width %s', async width => {
  const f = fixture('docx'); await f.reader.start(); vi.mocked(f.module.ccall).mockClear()
  await expect(f.reader.operation({ type: 'layout', request: { mode: 'continuous', width } })).rejects.toMatchObject({ code: 'render-failed' })
  expect(f.module.ccall).not.toHaveBeenCalled()
})
it.each(['docx', 'pptx'] as const)('renders %s directly without creating another view or touching file output', async format => {
  const f = fixture(format); await f.reader.start(); vi.mocked(f.module.ccall).mockClear()
  const tile = f.reader.render({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 })
  expect(tile).toEqual({ width: 1, height: 1, rgba: new Uint8ClampedArray(4) })
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_paint', 'number', expect.any(Array), [1, 4, format === 'docx' ? -1 : 0, 1, 1, 0, 0, 15, 15])
  expect(vi.mocked(f.module.ccall).mock.calls.some(([name]) => /create_view|save|paste|composition/.test(name))).toBe(false)
  expect(f.module.FS.readFile).not.toHaveBeenCalled(); expect(f.module.FS.writeFile).not.toHaveBeenCalled()
})
it.each(['xlsx'] as const)('rejects queued old-part %s tiles before native painting and retains the new selection', async format => {
  const f = fixture(format); await f.reader.start()
  const previousRequest = { part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 }
  const completed = f.reader.render(previousRequest)
  await f.reader.operation({ type: 'part', part: 1 })
  f.reader.callback(2, '15, 30, 45, 60'); f.reader.callback(34, 'A1:B1'); f.reader.callback(19, '7')
  await vi.advanceTimersByTimeAsync(16)
  const selected = f.reader.state
  vi.mocked(f.module.ccall).mockClear(); f.events.length = 0
  expect(() => f.reader.render(previousRequest)).toThrow(expect.objectContaining({ code: 'stale-part' }))
  expect(f.module.ccall).not.toHaveBeenCalled(); expect(f.events).toEqual([])
  expect(f.reader.state).toBe(selected)
  expect(await f.reader.operation({ type: 'copy' })).toEqual({ text: 'First' })
  expect(f.reader.render({ ...previousRequest, part: 1 })).toEqual(completed)
  expect(f.reader.state.selection).toBe(selected.selection)
})
it('observes queued native part changes before deciding whether a tile can paint', async () => {
  const f = fixture(); await f.reader.start()
  f.reader.callback(14, '1'); f.reader.callback(2, '15, 30, 45, 60')
  expect(() => f.reader.render({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 }))
    .toThrow(expect.objectContaining({ code: 'stale-part' }))
  expect(f.reader.state).toMatchObject({ part: 1, selection: [{ x: 1, y: 2, width: 3, height: 4 }] })
  expect(vi.mocked(f.module.ccall).mock.calls.some(([name]) => name === 'dsh_lok_document_paint')).toBe(false)
})
it('stops after an event-loop failure and ignores subsequent callbacks', async () => {
  const f = fixture(); await f.reader.start(); f.overrides.set('dsh_lok_pump', -1)
  await vi.advanceTimersByTimeAsync(16); expect(f.failed).toHaveBeenCalledOnce()
  f.reader.callback(0, 'EMPTY'); await vi.advanceTimersByTimeAsync(32)
  await expect(f.reader.operation({ type: 'copy' })).rejects.toMatchObject({ code: 'disposed' })
  expect(() => f.reader.render({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 })).toThrow('closed')
  expect(vi.getTimerCount()).toBe(0)
})
it('handles native part notifications and defaults invalidation rectangles to the active part', async () => {
  const f = fixture(); await f.reader.start()
  for (const payload of ['-1', '2', '1.5', 'invalid']) f.reader.callback(14, payload)
  await vi.advanceTimersByTimeAsync(16); expect(f.reader.state.part).toBe(0)
  f.reader.callback(14, '1'); f.reader.callback(0, '0, 0, 15, 15'); f.reader.callback(9999, 'unknown')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.reader.state.part).toBe(1); expect(f.measured.at(-1)).toBe(1)
  expect(f.events.at(-1)).toMatchObject({ type: 'invalidate', part: 1 })
})
it('rejects absent operations, invalid viewports and non-spreadsheet cell navigation', async () => {
  const f = fixture('docx'); await f.reader.start()
  for (const operation of [null, 42, { type: 'cell', address: 'A1' },
    { type: 'viewport', rectangle: { x: 0, y: 0, width: 1, height: 1 }, scale: 0 },
    { type: 'viewport', rectangle: { x: 0, y: 0, width: 1, height: 1 }, scale: 17 },
    { type: 'viewport', rectangle: { x: 0, y: 0, width: 0, height: 1 }, scale: 1 },
    { type: 'viewport', rectangle: { x: 0, y: 0, width: 1, height: 0 }, scale: 1 },
    { type: 'layout', request: { mode: 'continuous', width: 500, anchor: { x: -1, y: 0 } } },
    { type: 'layout', request: { mode: 'continuous', width: 500, anchor: { x: 0, y: -1 } } },
  ]) await expect(f.reader.operation(operation as OfficeOperation)).rejects.toMatchObject({ code: 'render-failed' })
  await f.reader.operation({ type: 'navigate', event: { key: 'down' } })
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_key', 'number', expect.any(Array), [1, 0, 0, 0x400])
})
it.each(['unconfigured', 'invalid-layout', 'empty-parts', 'out-of-memory', 'empty-size', 'listen-failed'] as const)('fails closed when native initialization returns %s', async mode => {
  const f = fixture()
  if (mode === 'unconfigured') f.overrides.set('dsh_lok_document_configure_view', 0)
  if (mode === 'invalid-layout') f.setLayout({ changed: true, width: 0, height: 16000 })
  if (mode === 'empty-parts') f.overrides.set('dsh_lok_document_parts', 0)
  if (mode === 'out-of-memory') f.overrides.set('malloc', 0)
  if (mode === 'empty-size') f.overrides.set('dsh_lok_document_size', () => 1)
  if (mode === 'listen-failed') f.overrides.set('dsh_lok_document_listen', 0)
  await expect(f.reader.start()).rejects.toMatchObject({ code: mode === 'empty-parts' || mode === 'empty-size' ? 'invalid-document' : 'render-failed' })
})
it('rejects invalid native body anchors and failed tile painting', async () => {
  const f = fixture('docx'); await f.reader.start()
  f.setLayout({ changed: true, width: 7500, height: 30000, anchor: { x: -1, y: 2, width: 2, height: 20 } })
  await expect(f.reader.operation({ type: 'layout', request: { mode: 'continuous', width: 500 } })).rejects.toMatchObject({ code: 'render-failed' })
  expect(f.reader.state.layout).toBe('paginated')
  f.overrides.set('dsh_lok_document_paint', 0)
  expect(() => f.reader.render({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 })).toThrow('tile rendering failed')
})
it('bounds a busy event loop by both pass count and elapsed time', async () => {
  const f = fixture(); await f.reader.start()
  f.overrides.set('dsh_lok_pump', 1); vi.mocked(f.module.ccall).mockClear()
  await f.reader.operation({ type: 'copy' })
  expect(vi.mocked(f.module.ccall).mock.calls.filter(([name]) => name === 'dsh_lok_pump')).toHaveLength(8)
  vi.mocked(f.module.ccall).mockClear()
  const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(9)
  await f.reader.operation({ type: 'copy' })
  expect(vi.mocked(f.module.ccall).mock.calls.filter(([name]) => name === 'dsh_lok_pump')).toHaveLength(1)
  now.mockRestore()
})
it('does not revive a stopped session when a previously scheduled callback arrives late', async () => {
  const timer = vi.spyOn(globalThis, 'setTimeout'), f = fixture(); await f.reader.start()
  const callback = timer.mock.calls.at(-1)![0] as () => void
  f.reader.stop(); vi.mocked(f.module.ccall).mockClear(); callback()
  expect(f.module.ccall).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
})

it('restores the reading view after capture paints and deferred native focus changes', async () => {
  const f = fixture('pptx')
  let current = 0, focusCapture = false
  f.overrides.set('dsh_lok_document_get_view', () => current)
  f.overrides.set('dsh_lok_document_create_view', () => { current = 1; return current })
  f.overrides.set('dsh_lok_document_set_view', args => { current = Number(args[1]); return 1 })
  f.overrides.set('dsh_lok_pump', () => { if (focusCapture) { current = 1; focusCapture = false }; return 0 })
  await f.reader.start()
  const selection = f.reader.state.selection
  f.overrides.set('dsh_lok_document_paint', () => { expect(current).toBe(1); return 1 })
  f.reader.render({ part: 1, x: 0, y: 0, width: 1, height: 1, scale: 1 })
  expect(current).toBe(0)
  expect(f.reader.state.part).toBe(0)
  expect(f.reader.state.selection).toBe(selection)
  focusCapture = true
  await vi.advanceTimersByTimeAsync(16)
  expect(current).toBe(0)
  f.overrides.set('dsh_lok_document_command', args => {
    expect(current).toBe(0)
    f.reader.callback(16, JSON.stringify({ commandName: args[1], success: true }))
    return 1
  })
  current = 1
  await f.reader.operation({ type: 'select-all' })
  expect(current).toBe(0)
  f.overrides.set('dsh_lok_document_paint', 0)
  expect(() => f.reader.render({ part: 1, x: 0, y: 0, width: 1, height: 1, scale: 1 })).toThrow()
  expect(current).toBe(0)
})
