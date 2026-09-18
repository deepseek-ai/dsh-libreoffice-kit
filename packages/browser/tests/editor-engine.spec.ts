/** Engine callback ordering, snapshot revisions and geometry without changing active sheets. */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { EditorEngine } from '../src/editor-engine.ts'
import type { EmscriptenModule } from '../src/engine-types.ts'
import type { BrowserEditorEvent, BrowserEditorFormat, BrowserEditorInput } from '../src/editor-types.ts'
import type { EditorOperation } from '../src/protocol.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function fixture(format: BrowserEditorFormat = 'xlsx', maxBytes = 1024) {
  const memory = new Uint32Array(8)
  const measured: number[] = []
  const events: BrowserEditorEvent[] = []
  const overrides = new Map<string, number | ((args: unknown[]) => number)>()
  let hold = false
  let editor: EditorEngine
  const module: EmscriptenModule = {
    ENV: {}, HEAPU32: memory, PThread: { terminateAllThreads() {} },
    FS: { mkdirTree() {}, writeFile() {}, readFile: () => new Uint8Array([42]), unlink: vi.fn() },
    UTF8ToString: pointer => pointer === 20 ? 'First' : pointer === 28 ? '0, 0, 12000, 16000' : 'Second',
    ccall: vi.fn((name, _returnType, _types, args) => {
      const override = overrides.get(name)
      if (override !== undefined) return typeof override === 'number' ? override : override(args)
      switch (name) {
        case 'malloc': return 4
        case 'free': return 0
        case 'dsh_lok_document_parts': return 2
        case 'dsh_lok_document_part_name': return args[1] === 0 ? 20 : 24
        case 'dsh_lok_document_page_rectangles': return 28
        case 'dsh_lok_document_selection': return 20
        case 'dsh_lok_document_size':
          measured.push(Number(args[1]))
          memory[1] = 12000; memory[2] = args[1] === 0 ? 16000 : 20000
          return 1
        case 'dsh_lok_document_command':
          if (!hold) editor.callback(16, JSON.stringify({ commandName: args[1], success: true }))
          return 1
        case 'dsh_lok_pump': return 0
        case 'dsh_lok_document_save': editor.callback(8, '.uno:ModifiedStatus=false'); return 1
        default: return 1
      }
    }),
  }
  const failed = vi.fn()
  editor = new EditorEngine(module, 1, format, maxBytes, event => { events.push(event) }, failed)
  onTestFinished(() => { editor.stop() })
  return { editor, module, overrides, memory, events, measured, failed, hold: () => { hold = true } }
}

it('acknowledges a UNO command only after completion, with its state and invalidations already published', async () => {
  const f = fixture()
  await f.editor.start()
  f.hold()
  let completed = false
  const pending = f.editor.operation({ type: 'command', command: '.uno:Bold' }).then(() => { completed = true })
  await Promise.resolve()
  expect(completed).toBe(false)
  f.editor.callback(8, '.uno:ModifiedStatus=true')
  f.editor.callback(0, '0, 0, 150, 300, 0')
  f.editor.callback(16, JSON.stringify({ commandName: '.uno:Bold', success: true }))
  await vi.advanceTimersByTimeAsync(16)
  await pending
  expect(f.editor.state.revision).toBe(1)
  expect(f.events.at(-1)).toEqual({ type: 'invalidate', part: 0, rectangle: { x: 0, y: 0, width: 10, height: 20 }, revision: 1 })
  expect(f.failed).not.toHaveBeenCalled()
})

it('accepts completion without a return value and joins pending command cancellation when the editor closes', async () => {
  const f = fixture()
  await f.editor.start()
  f.hold()
  const completed = f.editor.operation({ type: 'command', command: '.uno:Undo' })
  f.editor.callback(8, '.uno:ModifiedStatus=true')
  f.editor.callback(0, '0, 0, 150, 150, 0')
  f.editor.callback(16, JSON.stringify({ commandName: '.uno:Undo', success: false }))
  await vi.advanceTimersByTimeAsync(16)
  await completed
  expect(f.editor.state.revision).toBe(1)
  expect(f.failed).not.toHaveBeenCalled()
  const cancelled = expect(f.editor.operation({ type: 'command', command: '.uno:Bold' })).rejects.toMatchObject({ code: 'disposed' })
  f.editor.stop()
  await cancelled
  expect(vi.getTimerCount()).toBe(0)
})

it('measures only the current sheet, and updates dimensions when selecting another sheet', async () => {
  const f = fixture()
  await f.editor.start()
  expect(f.measured).toEqual([0])
  await f.editor.operation({ type: 'part', part: 1 })
  expect(f.measured).toEqual([0, 1])
  expect(f.editor.state.part).toBe(1)
  expect(f.editor.state.parts[1]!.height).toBeCloseTo(20000 / 15)
  f.editor.callback(13, '12000, 20000')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.measured).toEqual([0, 1, 1])
})

it('preserves part-scoped and all-part invalidations and leaves viewport changes outside saved revisions', async () => {
  const f = fixture()
  await f.editor.start()
  f.editor.callback(8, '.uno:ModifiedStatus=true')
  f.editor.callback(0, 'EMPTY, 1')
  f.editor.callback(0, '0, 0, 150, 150, -1')
  await vi.advanceTimersByTimeAsync(16)
  const snapshot = (await f.editor.operation({ type: 'save' })).snapshot!
  expect(snapshot).toEqual({ data: new Uint8Array([42]), revision: 1, extension: 'xlsx' })
  expect(f.events.filter(event => event.type === 'invalidate').map(event => event.part)).toEqual([1, -1])
  await f.editor.operation({ type: 'viewport', rectangle: { x: 0, y: 0, width: 500, height: 400 }, scale: 1.5 })
  expect(f.editor.state.revision).toBe(snapshot.revision)
  f.editor.callback(8, '.uno:ModifiedStatus=true')
  f.editor.callback(0, '0, 0, 150, 150, 0')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.editor.state.revision).toBeGreaterThan(snapshot.revision)
  expect(snapshot.revision).toBe(1)
})

it.each(['docx', 'pptx'] as const)('exposes %s geometry and renders its active part without creating a revision', async format => {
  const f = fixture(format)
  await f.editor.start()
  expect(f.editor.state.documentType).toBe(format === 'docx' ? 'text' : 'presentation')
  expect(f.editor.state.pages).toHaveLength(format === 'docx' ? 1 : 0)
  f.editor.callback(8, '.uno:ModifiedStatus=true')
  await vi.advanceTimersByTimeAsync(16)
  const revision = f.editor.state.revision
  f.overrides.set('dsh_lok_document_paint', () => {
    f.editor.callback(0, '0, 0, 15, 15')
    return 1
  })
  const tile = f.editor.render({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 })
  expect(tile).toEqual({ width: 1, height: 1, rgba: new Uint8ClampedArray(4) })
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_paint', 'number', expect.any(Array),
    [1, 4, format === 'docx' ? -1 : 0, 1, 1, 0, 0, 15, 15])
  await vi.advanceTimersByTimeAsync(16)
  expect(f.editor.state.revision).toBe(revision)
})

it('normalizes cursor, selection, object, command and formula notifications together', async () => {
  const f = fixture()
  await f.editor.start()
  f.editor.callback(1, '{"rectangle":"15, 30, 45, 60"}')
  f.editor.callback(2, '15, 30, 45, 60;EMPTY;0, 0, 15, 15')
  f.editor.callback(5, 'true')
  f.editor.callback(6, '30, 45, 150, 300')
  f.editor.callback(8, '.uno:Bold=true')
  f.editor.callback(19, '=A1*3')
  f.editor.callback(34, 'B1')
  f.editor.callback(14, '1')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.editor.state).toMatchObject({
    part: 1, cursor: { x: 1, y: 2, width: 3, height: 4 }, cursorVisible: true,
    selection: [{ x: 1, y: 2, width: 3, height: 4 }, { x: 0, y: 0, width: 1, height: 1 }],
    graphicSelection: { x: 2, y: 3, width: 10, height: 20 },
    commands: { '.uno:Bold': 'true' }, cellFormula: '=A1*3', cellAddress: 'B1', revision: 0,
  })
  f.editor.callback(5, 'false')
  f.editor.callback(6, 'INPLACE')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.editor.state.cursorVisible).toBe(false)
  expect(f.editor.state.graphicSelection).toBeNull()
  f.editor.callback(17, '0, 0, 150, 300')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.editor.state).toMatchObject({ cursorVisible: true, cursor: { x: 0, y: 0, width: 10, height: 20 } })
})

it.each(['', 'EMPTY', 'INPLACE', '{}', '{"rectangle":1}', '0, 0, 15', 'NaN, 0, 15, 15', '0, 0, -1, 15', '0, 0, 15, -1'])(
  'clears a cursor for an unavailable or invalid rectangle %j', async payload => {
    const f = fixture()
    await f.editor.start()
    f.editor.callback(1, '0, 0, 15, 15')
    await vi.advanceTimersByTimeAsync(16)
    expect(f.editor.state.cursor).not.toBeNull()
    f.editor.callback(1, payload)
    await vi.advanceTimersByTimeAsync(16)
    expect(f.editor.state.cursor).toBeNull()
  })

it('ignores invalid part and unrelated command notifications, without acknowledging another command', async () => {
  const f = fixture()
  await f.editor.start()
  f.hold()
  let completed = false
  const pending = f.editor.operation({ type: 'command', command: '.uno:Bold', arguments: { State: { type: 'boolean', value: true } } })
    .then(() => { completed = true })
  for (const payload of ['null', '7', '{}', '{"commandName":".uno:Italic"}']) f.editor.callback(16, payload)
  for (const part of ['-1', '2', '1.5', 'invalid']) f.editor.callback(14, part)
  f.editor.callback(8, 'no-equals-sign')
  f.editor.callback(9999, 'future-notification')
  await vi.advanceTimersByTimeAsync(16)
  expect(completed).toBe(false)
  expect(f.editor.state.part).toBe(0)
  f.editor.callback(16, '{"commandName":".uno:Bold"}')
  await vi.advanceTimersByTimeAsync(16)
  await pending
  expect(completed).toBe(true)
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_command', 'number', ['number', 'string', 'string'],
    [1, '.uno:Bold', '{"State":{"type":"boolean","value":true}}'])
})

it('translates keyboard, pointer, composition and UTF-8 clipboard operations', async () => {
  const f = fixture()
  await f.editor.start()
  for (const action of ['down', 'up'] as const) await f.editor.operation({ type: 'input', event: { type: 'key', action, character: 0x4e2d, key: 512 } })
  for (const action of ['down', 'up', 'move'] as const) await f.editor.operation({ type: 'input', event: { type: 'pointer', action, x: -1, y: 2,
    clicks: 2, buttons: 1, modifiers: 4096 } })
  for (const action of ['update', 'end'] as const) await f.editor.operation({ type: 'input', event: { type: 'composition', action, text: '中文' } })
  await f.editor.operation({ type: 'paste', text: '中文' })
  expect(await f.editor.operation({ type: 'copy' })).toEqual({ text: 'First' })
  for (const action of [0, 1]) expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_key', 'number', expect.any(Array), [1, action, 0x4e2d, 512])
  for (const action of [0, 1, 2]) expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_mouse', 'number', expect.any(Array), [1, action, -15, 30, 2, 1, 4096])
  for (const action of [0, 2]) expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_composition', 'number', expect.any(Array), [1, action, '中文'])
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_paste', 'number', expect.any(Array), [1, 'text/plain;charset=utf-8', '中文', 6])
  f.overrides.set('dsh_lok_document_selection', 0)
  expect(await f.editor.operation({ type: 'copy' })).toEqual({ text: '' })
})

const invalidInputs: BrowserEditorInput[] = [
  { type: 'key', action: 'down', character: -1, key: 0 },
  { type: 'key', action: 'down', character: 1.5, key: 0 },
  { type: 'key', action: 'down', character: 0x110000, key: 0 },
  { type: 'key', action: 'down', character: 0, key: 0x10000 },
  { type: 'pointer', action: 'down', x: Infinity, y: 0, clicks: 1, buttons: 1, modifiers: 0 },
  { type: 'pointer', action: 'down', x: 0, y: 1e10, clicks: 1, buttons: 1, modifiers: 0 },
  { type: 'pointer', action: 'down', x: 0, y: 0, clicks: 4, buttons: 1, modifiers: 0 },
  { type: 'pointer', action: 'down', x: 0, y: 0, clicks: 1, buttons: 8, modifiers: 0 },
  { type: 'composition', action: 'update', text: '\0' },
]
it.each(invalidInputs)('rejects invalid input before passing it to LibreOffice: %j', async event => {
  const f = fixture()
  await f.editor.start()
  vi.mocked(f.module.ccall).mockClear()
  await expect(f.editor.operation({ type: 'input', event })).rejects.toMatchObject({ code: 'render-failed' })
  expect(f.module.ccall).not.toHaveBeenCalled()
})

it('enforces UTF-8 byte limits and command syntax at the Worker boundary', async () => {
  const f = fixture('xlsx', 4)
  await f.editor.start()
  for (const text of ['中文', '\0', 42 as unknown as string]) await expect(f.editor.operation({ type: 'paste', text })).rejects.toMatchObject({ code: 'render-failed' })
  await expect(f.editor.operation({ type: 'command', command: 'file:///bad' })).rejects.toMatchObject({ code: 'render-failed' })
  await expect(f.editor.operation({ type: 'paste', text: 'four' })).resolves.toEqual({})
})

it.each([
  { type: 'part', part: 2 },
  { type: 'viewport', rectangle: { x: 0, y: 0, width: 0, height: 1 }, scale: 1 },
  { type: 'viewport', rectangle: { x: 0, y: 0, width: 1, height: 0 }, scale: 1 },
  { type: 'viewport', rectangle: { x: 0, y: 0, width: 1, height: 1 }, scale: 0 },
  { type: 'viewport', rectangle: { x: 0, y: 0, width: 1, height: 1 }, scale: 17 },
] satisfies EditorOperation[])('rejects an invalid part or viewport %j', async operation => {
  const f = fixture()
  await f.editor.start()
  await expect(f.editor.operation(operation)).rejects.toMatchObject({ code: 'render-failed' })
})

it('keeps a positive device scale for a subpixel viewport', async () => {
  const f = fixture()
  await f.editor.start()
  await f.editor.operation({ type: 'viewport', rectangle: { x: 0, y: 0, width: 1, height: 1 }, scale: 0.001 })
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_viewport', 'number', expect.any(Array), [1, 1, 3840, 0, 0, 15, 15])
})

it.each([
  ['dsh_lok_document_parts', 0, 'invalid-document'],
  ['dsh_lok_document_parts', 0.5, 'invalid-document'],
  ['malloc', 0, 'render-failed'],
  ['dsh_lok_document_size', 0, 'render-failed'],
] as const)('rejects failed geometry from %s without leaving an event timer', async (name, value, code) => {
  const f = fixture()
  f.overrides.set(name, value)
  await expect(f.editor.start()).rejects.toMatchObject({ code })
  expect(vi.getTimerCount()).toBe(0)
  if (name === 'dsh_lok_document_size') expect(f.module.ccall).toHaveBeenCalledWith('free', 'number', ['number'], [4])
})

it.each([1, 2])('rejects an empty dimension at %s and releases the geometry allocation', async offset => {
  const f = fixture()
  f.overrides.set('dsh_lok_document_size', () => { f.memory[1] = 12000; f.memory[2] = 16000; f.memory[offset] = 0; return 1 })
  await expect(f.editor.start()).rejects.toMatchObject({ code: 'invalid-document' })
  expect(f.module.ccall).toHaveBeenCalledWith('free', 'number', ['number'], [4])
})

it('accepts unnamed sheets and clamps the current sheet after the engine removes a part', async () => {
  const f = fixture()
  f.overrides.set('dsh_lok_document_part_name', 0)
  await f.editor.start()
  expect(f.editor.state.parts.map(part => part.name)).toEqual(['', ''])
  await f.editor.operation({ type: 'part', part: 1 })
  f.overrides.set('dsh_lok_document_parts', 1)
  f.editor.callback(13, '')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.editor.state.part).toBe(0)
  expect(f.editor.state.parts).toHaveLength(1)
})

it('yields a busy LibreOffice loop after a slice count or elapsed-time limit', async () => {
  const f = fixture()
  f.overrides.set('dsh_lok_pump', 1)
  const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
  await f.editor.start()
  vi.mocked(f.module.ccall).mockClear()
  await f.editor.operation({ type: 'paste', text: 'x' })
  expect(vi.mocked(f.module.ccall).mock.calls.filter(call => call[0] === 'dsh_lok_pump')).toHaveLength(8)
  clock.mockReturnValueOnce(0).mockReturnValue(9)
  vi.mocked(f.module.ccall).mockClear()
  await f.editor.operation({ type: 'paste', text: 'y' })
  expect(vi.mocked(f.module.ccall).mock.calls.filter(call => call[0] === 'dsh_lok_pump')).toHaveLength(1)
})

it.each(['pump', 'json'] as const)('stops event processing after a %s failure and ignores late callbacks', async mode => {
  const f = fixture()
  await f.editor.start()
  if (mode === 'pump') f.overrides.set('dsh_lok_pump', -1)
  else f.editor.callback(1, '{')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.failed).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  const state = f.editor.state
  f.editor.callback(8, '.uno:ModifiedStatus=true')
  await vi.advanceTimersByTimeAsync(32)
  expect(f.editor.state).toBe(state)
})

it('does not reschedule a timer callback delivered after stop', async () => {
  const schedule = vi.spyOn(globalThis, 'setTimeout')
  const f = fixture()
  await f.editor.start()
  const callback = schedule.mock.calls.find(([, delay]) => delay === 16)![0] as () => void
  f.editor.stop()
  callback()
  expect(vi.getTimerCount()).toBe(0)
  expect(f.failed).not.toHaveBeenCalled()
})

it.each([0, 1025])('removes an invalid %s-byte export before reporting failure', async size => {
  const f = fixture()
  await f.editor.start()
  vi.spyOn(f.module.FS, 'readFile').mockReturnValue(new Uint8Array(size))
  await expect(f.editor.operation({ type: 'save' })).rejects.toMatchObject({ code: 'render-failed' })
  expect(f.module.FS.unlink).toHaveBeenCalledWith('/dsh/export.xlsx')
})

it('reports a failed tile while retaining the editable document', async () => {
  const f = fixture()
  await f.editor.start()
  f.overrides.set('dsh_lok_document_paint', 0)
  expect(() => f.editor.render({ part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 })).toThrow('Office tile rendering failed.')
  expect(await f.editor.operation({ type: 'copy' })).toEqual({ text: 'First' })
})

it('tracks visual generations without inventing saved edits and rejects a stale capture', async () => {
  const f = fixture('docx')
  await f.editor.start()
  f.editor.callback(0, '0, 0, 150, 150, 0')
  await vi.advanceTimersByTimeAsync(16)
  expect(f.editor.state.revision).toBe(0)
  expect(f.editor.state.renderGeneration).toBe(1)
  await expect(f.editor.capture({ generation: 0, maxPixels: 1, tiles: [] })).rejects.toMatchObject({ code: 'snapshot-changed' })
})

it('captures cached pixels in a separate view and restores the editable view', async () => {
  const f = fixture('docx')
  await f.editor.start()
  f.overrides.set('dsh_lok_document_get_view', 3)
  f.overrides.set('dsh_lok_document_create_view', 4)
  const cached = { width: 1, height: 1, rgba: new Uint8ClampedArray([1, 2, 3, 255]) }
  const result = await f.editor.capture({ generation: 0, maxPixels: 1, tiles: [
    { request: { part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 }, cached },
  ] })
  expect(result.tiles).toEqual([cached])
  expect(result.state.renderGeneration).toBe(0)
  const calls = vi.mocked(f.module.ccall).mock.calls
  const views = calls.filter(([name]) => name === 'dsh_lok_document_set_view').map(([, , , args]) => args[1])
  expect(views[0]).toBe(4)
  expect(views.slice(1).every(view => view === 3)).toBe(true)
  expect(calls.some(([name]) => name === 'dsh_lok_document_paint')).toBe(false)
  f.editor.stop()
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_destroy_view', 'number', ['number', 'number'], [1, 4])
})

it('restores the editing view after deferred capture-window activation before awaiting command callbacks', async () => {
  const f = fixture('docx')
  await f.editor.start()
  let currentView = 3
  let activateCaptureWindow = false
  f.overrides.set('dsh_lok_document_get_view', () => currentView)
  f.overrides.set('dsh_lok_document_set_view', args => { currentView = Number(args[1]); return 1 })
  f.overrides.set('dsh_lok_document_create_view', () => { activateCaptureWindow = true; currentView = 4; return 4 })
  f.overrides.set('dsh_lok_pump', () => {
    if (activateCaptureWindow) { currentView = 4; activateCaptureWindow = false }
    return 0
  })
  f.overrides.set('dsh_lok_document_command', args => {
    // Only the editing view has a command-result callback registered.
    if (currentView === 3) f.editor.callback(16, JSON.stringify({ commandName: args[1] }))
    return 1
  })
  let completed = false
  const task = f.editor.capture({ generation: 0, maxPixels: 1, tiles: [] }).then(() => { completed = true })
  await vi.advanceTimersByTimeAsync(32)
  expect(completed).toBe(true)
  await task
  expect(currentView).toBe(3)
  await expect(f.editor.operation({ type: 'command', command: '.uno:Bold' })).resolves.toEqual({})
})

it('rejects pixels invalidated during capture and restores its view before failing', async () => {
  const f = fixture('docx')
  await f.editor.start()
  f.overrides.set('dsh_lok_document_get_view', 3)
  f.overrides.set('dsh_lok_document_create_view', 4)
  f.overrides.set('dsh_lok_document_paint', () => { f.editor.callback(0, 'EMPTY, 0'); return 1 })
  f.overrides.set('dsh_lok_document_tile_mode', 0)
  await expect(f.editor.capture({ generation: 0, maxPixels: 1, tiles: [
    { request: { part: 0, x: 0, y: 0, width: 1, height: 1, scale: 1 } },
  ] })).rejects.toMatchObject({ code: 'snapshot-changed' })
  expect(f.module.ccall).toHaveBeenCalledWith('dsh_lok_document_set_view', 'number', ['number', 'number'], [1, 3])
  expect(f.editor.state.revision).toBe(0)
})

it.each(['doc', 'xls', 'ppt'] as const)('keeps legacy %s read-only while retaining its render model', async format => {
  const f = fixture(format)
  const editor = new EditorEngine(f.module, 1, format, 1024, () => {}, () => {}, true)
  await expect(editor.operation({ type: 'paste', text: 'change' })).rejects.toThrow('read-only')
  await expect(editor.operation({ type: 'save' })).rejects.toThrow('read-only')
  expect(editor.state.documentType).toBe(format === 'doc' ? 'text' : format === 'xls' ? 'spreadsheet' : 'presentation')
  editor.stop()
})
