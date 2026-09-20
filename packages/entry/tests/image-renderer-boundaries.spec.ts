import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderImagesWithWasm } from '../src/image-renderer.ts'
import { resolveImageRender, type RenderImagesRequest } from '../src/image-operations.ts'
import { resolveOptions } from '../src/options.ts'
import type { EmscriptenModule, WasmSession } from '../src/wasm.ts'

const wasm = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('../src/wasm.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/wasm.ts')>(), withWasmSession: wasm.run,
}))
beforeEach(() => { wasm.run.mockReset() })

interface EngineReply {
  type?: number
  parts?: number
  sizes?: unknown
  hidden?: boolean
  zeroCall?: { name: string; occurrence?: number }
  zeroCommand?: string
}

function fixture(extension: string, reply: EngineReply = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kit-raster-boundary-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const outputDir = join(root, 'images'); mkdirSync(outputDir)
  const memory = new Uint32Array(100000)
  const strings = new Map<number, string>()
  const counts = new Map<string, number>()
  const text = (value: string) => { const pointer = strings.size + 1; strings.set(pointer, value); return pointer }
  const call = vi.fn<EmscriptenModule['ccall']>((name, _returns, _types, args) => {
    const count = (counts.get(name) ?? 0) + 1; counts.set(name, count)
    if (reply.zeroCall?.name === name && count === (reply.zeroCall.occurrence ?? 1)) return 0
    switch (name) {
      case 'malloc': return 1024
      case 'free': return 0
      case 'dsh_lok_error': return text('engine ABI failed')
      case 'dsh_lok_document_type': return reply.type ?? (extension === 'xlsx' ? 1 : extension === 'pptx' ? 2 : 0)
      case 'dsh_lok_document_parts': return reply.parts ?? 2
      case 'dsh_lok_document_page_rectangles': return text('0,0,30,30;0,60,30,30')
      case 'dsh_lok_document_part_info': return text(JSON.stringify({ name: Number(args[1]) === 0 ? 'Data' : 'Other',
        visible: reply.hidden ? 0 : 1, rtllayout: 0, lastcolumn: 1, lastrow: 1 }))
      case 'dsh_lok_document_command_values': {
        const command = String(args[1])
        if (reply.zeroCommand !== undefined && command.startsWith(reply.zeroCommand)) return 0
        if (command === '.uno:AllPageSize') return text(JSON.stringify(reply.sizes ?? { parts: [{ width: 30, height: 30 }, { width: 30, height: 30 }] }))
        if (command === '.uno:SheetGeometryData') return text(JSON.stringify({
          columns: { sizes: '150:16383', hidden: '0:16383', filtered: '0:16383' },
          rows: { sizes: '150:1048575', hidden: '0:1048575', filtered: '0:1048575' },
        }))
        return text('{}')
      }
      case 'dsh_lok_document_tile_mode': return 0
      default: return 1
    }
  })
  const module: EmscriptenModule = { HEAPU32: memory, ccall: call, UTF8ToString: pointer => strings.get(pointer)!, ENV: {},
    PThread: { terminateAllThreads: vi.fn() }, FS: { mkdirTree() {}, writeFile() {}, analyzePath: () => ({ exists: true }),
      stat: () => ({ mode: 0, size: 0 }), isFile: () => true, readFile: () => new Uint8Array() } }
  const session: WasmSession = { module, office: 1, document: 2, pdf: false, missingFonts: [], idle: async () => {} }
  wasm.run.mockImplementation(async (_request: unknown, use: (session: WasmSession) => unknown) => use(session))
  const render = (selection: Partial<RenderImagesRequest> = {}, maxOutputBytes?: number) => renderImagesWithWasm({
    engine: { backend: 'wasm', root: outputDir, loader: '', data: '', wasm: '', metadata: '', programDirectory: '/program' },
    bytes: new TextEncoder().encode('saved document'), extension,
    options: resolveOptions({ fontDirectories: [], fontFallbacks: [], ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }) }),
    document: { families: new Map(), codePoints: [] }, faces: [],
    operation: resolveImageRender({ inputPath: join(root, `input.${extension}`), outputDir, dpi: 96, ...selection }),
  })
  return { render, call, outputDir }
}

it.each(['dsh_lok_document_initialize_rendering', 'dsh_lok_document_listen'])('does not inspect or paint a document after %s fails', async name => {
  const h = fixture('docx', { zeroCall: { name } })
  await expect(h.render()).rejects.toThrow('engine ABI failed')
  expect(h.call.mock.calls.some(call => call[0] === 'dsh_lok_document_type')).toBe(false)
  expect(readdirSync(h.outputDir)).toEqual([])
})

it('surfaces the engine error when Writer geometry is unavailable', async () => {
  const h = fixture('docx', { zeroCall: { name: 'dsh_lok_document_page_rectangles' } })
  await expect(h.render()).rejects.toThrow('engine ABI failed')
  expect(readdirSync(h.outputDir)).toEqual([])
})

it('rejects a mismatched imported document type before querying its geometry', async () => {
  const h = fixture('docx', { type: 1 })
  await expect(h.render()).rejects.toMatchObject({ code: 'invalid-document', message: expect.stringMatching(/unexpected document type/) })
  expect(h.call.mock.calls.some(call => call[0] === 'dsh_lok_document_parts')).toBe(false)
})

it.each([0, -1, 1.5, 100001])('rejects invalid part count %s before reading parts', async parts => {
  const h = fixture('pptx', { parts })
  await expect(h.render()).rejects.toMatchObject({ code: 'invalid-document', message: 'Invalid document part count.' })
  expect(h.call.mock.calls.some(call => call[0] === 'dsh_lok_document_command_values')).toBe(false)
})

it.each([{}, { parts: [] }, { parts: [{ width: 30, height: 30 }] }])('rejects an incomplete slide size response %j', async sizes => {
  const h = fixture('pptx', { sizes })
  await expect(h.render()).rejects.toMatchObject({ code: 'invalid-document', message: expect.stringMatching(/inconsistent slide dimensions/) })
  expect(readdirSync(h.outputDir)).toEqual([])
})

it.each([[1.5, 30], [30, 1.5], [0, 30], [30, 0], [0x80000000, 30], [30, 0x80000000]])('rejects invalid slide dimensions %s × %s', async (width, height) => {
  const h = fixture('pptx', { sizes: { parts: [{ width, height }, { width: 30, height: 30 }] } })
  await expect(h.render()).rejects.toMatchObject({ code: 'invalid-document', message: expect.stringMatching(/invalid slide dimensions/) })
  expect(readdirSync(h.outputDir)).toEqual([])
})

it.each([false, true])('rejects %s hidden-sheet selection without creating output', async hidden => {
  const h = fixture('xlsx', { hidden })
  await expect(h.render(hidden ? {} : { sheet: 'Absent' })).rejects.toMatchObject({ code: 'invalid-document', message: expect.stringMatching(/worksheet name/) })
  expect(readdirSync(h.outputDir)).toEqual([])
})

it('counts selected worksheets before attempting geometry or raster work', async () => {
  const h = fixture('xlsx')
  await expect(h.render({ maxPages: 1 })).rejects.toMatchObject({ code: 'output-too-large', message: expect.stringMatching(/worksheet count exceeds maxPages/) })
  expect(h.call.mock.calls.some(call => call[0] === 'dsh_lok_document_part')).toBe(false)
})

it.each([
  { zeroCall: { name: 'dsh_lok_document_part', occurrence: 1 } },
  { zeroCall: { name: 'dsh_lok_document_part', occurrence: 2 } },
  { zeroCall: { name: 'dsh_lok_document_viewport' } },
  { zeroCommand: '.uno:SheetGeometryData' },
  { zeroCommand: '.uno:ViewRowColumnHeaders?' },
] satisfies EngineReply[])('does not publish a spreadsheet image after setup failure %j', async reply => {
  const h = fixture('xlsx', reply)
  await expect(h.render({ sheet: 'Data' })).rejects.toThrow('engine ABI failed')
  expect(h.call.mock.calls.some(call => call[0] === 'dsh_lok_document_paint')).toBe(false)
  expect(readdirSync(h.outputDir)).toEqual([])
})

it('releases raster memory and retains the engine failure when painting fails', async () => {
  const h = fixture('docx', { zeroCall: { name: 'dsh_lok_document_paint' } })
  await expect(h.render()).rejects.toThrow('engine ABI failed')
  expect(h.call.mock.calls.filter(call => call[0] === 'free').map(call => call[3])).toContainEqual([1024])
  expect(readdirSync(h.outputDir)).toEqual([])
})

it('stops before writing a PNG that would overflow the complete batch byte limit', async () => {
  const h = fixture('docx')
  await expect(h.render({}, 100)).rejects.toMatchObject({ code: 'output-too-large', message: 'PNG batch exceeds maxOutputBytes.' })
  expect(h.call.mock.calls.filter(call => call[0] === 'dsh_lok_document_paint')).toHaveLength(2)
  expect(readdirSync(h.outputDir)).toEqual(['page-0001.png'])
  expect(statSync(join(h.outputDir, 'page-0001.png')).size).toBeLessThanOrEqual(100)
})
