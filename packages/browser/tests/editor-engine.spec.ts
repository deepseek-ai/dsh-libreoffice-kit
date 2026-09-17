/** Engine callback ordering, snapshot revisions and geometry without changing active sheets. */
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { EditorEngine } from '../src/editor-engine.ts'
import type { EmscriptenModule } from '../src/engine-types.ts'
import type { BrowserEditorEvent } from '../src/editor-types.ts'

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function fixture() {
  const memory = new Uint32Array(8)
  const measured: number[] = []
  const events: BrowserEditorEvent[] = []
  let hold = false
  let editor: EditorEngine
  const module: EmscriptenModule = {
    ENV: {}, HEAPU32: memory, PThread: { terminateAllThreads() {} },
    FS: { mkdirTree() {}, writeFile() {}, readFile: () => new Uint8Array([42]), unlink: vi.fn() },
    UTF8ToString: pointer => pointer === 20 ? 'First' : 'Second',
    ccall: (name, _returnType, _types, args) => {
      switch (name) {
        case 'malloc': return 4
        case 'free': return 0
        case 'dsh_lok_document_parts': return 2
        case 'dsh_lok_document_part_name': return args[1] === 0 ? 20 : 24
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
    },
  }
  const failed = vi.fn()
  editor = new EditorEngine(module, 1, 'xlsx', 1024, event => { events.push(event) }, failed)
  onTestFinished(() => { editor.stop() })
  return { editor, events, measured, failed, hold: () => { hold = true } }
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
