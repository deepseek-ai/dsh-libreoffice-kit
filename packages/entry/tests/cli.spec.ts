/** The command entry uses public API validation, cancellation, and disposal. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

const api = vi.hoisted(() => ({
  renderImages: vi.fn(), convert: vi.fn(), recalculate: vi.fn(), dispose: vi.fn(), create: vi.fn(), discover: vi.fn(),
}))
vi.mock('../src/index.ts', () => ({
  IMAGE_FORMATS: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'],
  CONVERSION_FORMATS: [{ inputs: ['docx'], outputs: ['pdf'] }],
  createConverter: api.create, discoverRuntime: api.discover,
}))
const originalArgv = process.argv
const originalCode = process.exitCode
let out: string[]
let err: string[]
let cancel: (() => void) | undefined

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  out = []; err = []; cancel = undefined
  process.exitCode = undefined
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { out.push(String(chunk)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { err.push(String(chunk)); return true })
  vi.spyOn(process, 'once').mockImplementation((event, listener) => {
    if (event === 'SIGINT') cancel = listener as () => void
    return process
  })
  api.create.mockResolvedValue({ renderImages: api.renderImages, convert: api.convert, recalculate: api.recalculate, dispose: api.dispose })
  api.convert.mockResolvedValue({ backend: 'native', missingFonts: [] })
  api.recalculate.mockResolvedValue({ backend: 'native', missingFonts: [] })
  api.discover.mockResolvedValue({ version: 'test', backend: 'wasm', cliPath: '/cli.js', nodeApiPath: '/index.js' })
})
afterEach(() => { process.argv = originalArgv; process.exitCode = originalCode; vi.restoreAllMocks() })

async function run(args: string[]) {
  process.argv = ['node', '/cli.js', ...args]
  await import('../src/cli.ts')
  return { stdout: out.join(''), stderr: err.join(''), exitCode: process.exitCode }
}

it('discovers capabilities without creating a converter', async () => {
  const result = await run(['capabilities', '--json'])
  expect(JSON.parse(result.stdout).runtime.backend).toBe('wasm')
  expect(api.create).not.toHaveBeenCalled()
})
it('passes conversion, limits, font configuration, and exact sheet names through the public API', async () => {
  const result = await run(['convert', '--input', 'book.xlsx', '--output', 'book.csv', '--sheet', 'Summary 中文',
    '--max-output-bytes', '12345', '--font-directory', './fonts', '--initial-font-family', 'Fixture', '--font-fallbacks', '[["One","Two"]]'])
  expect(api.create).toHaveBeenCalledWith({ maxOutputBytes: 12345, fontDirectories: [resolve('fonts')], initialFontFamilies: ['Fixture'], fontFallbacks: [['One', 'Two']] })
  expect(api.convert).toHaveBeenCalledWith({ inputPath: resolve('book.xlsx'), outputPath: resolve('book.csv'), sheet: 'Summary 中文' }, expect.any(AbortSignal))
  expect(JSON.parse(result.stdout).outputPath).toBe(resolve('book.csv'))
  expect(api.dispose).toHaveBeenCalledOnce()
})
it('recalculates through the same converter and disposes after success', async () => {
  expect((await run(['recalculate', '--input', 'book.xls', '--output', 'checked.xlsx'])).stderr).toBe('')
  expect(api.recalculate).toHaveBeenCalledWith({ inputPath: resolve('book.xls'), outputPath: resolve('checked.xlsx') }, expect.any(AbortSignal))
  expect(api.dispose).toHaveBeenCalledOnce()
})
it.each([
  [[], /Usage/], [['unknown'], /Usage/], [['convert', 'extra'], /Usage/],
  [['capabilities', '--input', 'file'], /only --json/], [['convert'], /required/],
  [['convert', '--input', 'a.docx', '--output', 'b.pdf', '--timeout-ms', 'abc'], /positive integer/],
  [['recalculate', '--input', 'a.xls', '--output', 'b.xlsx', '--sheet', 'Sheet1'], /only for CSV/],
  [['convert', '--unknown'], /Unknown option/],
] as const)('rejects invalid CLI arguments %j', async (args, message) => {
  const result = await run([...args])
  expect(JSON.parse(result.stderr).error).toMatch(message)
  expect(result.exitCode).toBe(1)
  expect(api.create).not.toHaveBeenCalled()
})
it('cancels active conversion and awaits disposal before reporting failure', async () => {
  api.convert.mockImplementation(async (_request, signal: AbortSignal) => {
    cancel!()
    signal.throwIfAborted()
  })
  const result = await run(['convert', '--input', 'a.docx', '--output', 'b.pdf'])
  expect(JSON.parse(result.stderr).error).toMatch(/cancelled/)
  expect(api.dispose).toHaveBeenCalledOnce()
})
it('reports converter failures including non-Error rejections', async () => {
  api.create.mockRejectedValue('unavailable engine')
  const result = await run(['convert', '--input', 'a.docx', '--output', 'b.pdf'])
  expect(JSON.parse(result.stderr)).toEqual({ code: 'failed', error: 'unavailable engine' })
})
it('renders a complete selected PNG batch through the existing converter with its limits', async () => {
  api.renderImages.mockResolvedValue({ backend: 'wasm', rasterEngine: 'pdfium', source: 'saved', images: [] })
  const result = await run(['render', '--input', 'a.pdf', '--output-dir', './images', '--pages', '3,1', '--dpi', '144',
    '--max-pages', '4', '--max-pixels', '12345', '--max-output-bytes', '67890', '--timeout-ms', '700'])
  expect(api.create).toHaveBeenCalledWith({ maxOutputBytes: 67890, timeoutMs: 700 })
  expect(api.renderImages).toHaveBeenCalledWith({ inputPath: resolve('a.pdf'), outputDir: resolve('images'), pages: [3, 1], dpi: 144, maxPages: 4, maxPixels: 12345 }, expect.any(AbortSignal))
  expect(JSON.parse(result.stdout).rasterEngine).toBe('pdfium')
  expect(api.dispose).toHaveBeenCalledOnce()
})
