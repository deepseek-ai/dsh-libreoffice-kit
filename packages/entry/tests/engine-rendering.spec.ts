import { expect, it, vi } from 'vitest'
import { engineString, pdfPages, renderRegion, type RasterModule } from '../src/engine-rendering.ts'

const page = { part: 4, x: 30, y: 60, width: 10, height: 10 }
const request = { pageIndex: 0, x: 1, y: 2, width: 2, height: 2, scale: 1 }
const failure = new Error('Engine rejected the operation')

function moduleWith(call: RasterModule['ccall']) {
  return { HEAPU32: new Uint32Array(1024), ccall: vi.fn(call), UTF8ToString: vi.fn(() => '中文 document') }
}

it('copies engine-owned UTF-8 and releases the pointer even when decoding fails', () => {
  const module = moduleWith(name => name === 'free' ? 0 : 64)
  expect(engineString(module, 'read_metadata', ['number', 'string'], [7, 'page'], () => failure)).toBe('中文 document')
  expect(module.ccall).toHaveBeenNthCalledWith(1, 'read_metadata', 'number', ['number', 'string'], [7, 'page'])
  expect(module.ccall).toHaveBeenLastCalledWith('free', 'number', ['number'], [64])
  module.UTF8ToString.mockImplementationOnce(() => { throw new Error('Invalid UTF-8') })
  expect(() => engineString(module, 'read_metadata', [], [], () => failure)).toThrow('Invalid UTF-8')
  expect(module.ccall.mock.calls.filter(call => call[0] === 'free')).toHaveLength(2)
})

it('does not decode or release a null engine string pointer', () => {
  const module = moduleWith(() => 0)
  expect(() => engineString(module, 'read_metadata', [], [], () => failure)).toThrow(failure)
  expect(module.UTF8ToString).not.toHaveBeenCalled()
  expect(module.ccall).toHaveBeenCalledOnce()
})

it.each([false, true])('copies %s PDF-mode pixels before releasing their temporary engine allocation', (pdf) => {
  const module = moduleWith((name, _return, _types, args) => {
    if (name === 'malloc') return 64
    if (name === 'free') { module.HEAPU32.fill(0); return 0 }
    if (name === 'dsh_lok_document_tile_mode') return 1
    const buffer = new Uint8Array(module.HEAPU32.buffer, Number(args[1]), 16)
    for (let index = 0; index < buffer.length; index += 4) buffer.set([32, 64, 96, 128], index)
    return 1
  })
  const result = renderRegion(module, 7, request, [page], () => failure, pdf)
  expect(result).toMatchObject({ width: 2, height: 2 })
  expect([...result.rgba.slice(0, 4)]).toEqual(pdf ? [32, 64, 96, 128] : [191, 128, 64, 128])
  expect(module.HEAPU32.every(value => value === 0)).toBe(true)
  expect(module.ccall).toHaveBeenCalledWith(pdf ? 'dsh_pdf_paint' : 'dsh_lok_document_paint', 'number',
    Array(9).fill('number'), [7, 64, 4, 2, 2, 45, 90, 30, 30])
  expect(module.ccall).toHaveBeenLastCalledWith('free', 'number', ['number'], [64])
})

it('refuses a failed raster allocation without painting or freeing a null pointer', () => {
  const module = moduleWith(() => 0)
  expect(() => renderRegion(module, 7, request, [page], () => failure)).toThrow(failure)
  expect(module.ccall).toHaveBeenCalledExactlyOnceWith('malloc', 'number', ['number'], [16])
})

it.each([false, true])('releases an allocated raster after the %s PDF-mode paint fails', (pdf) => {
  const module = moduleWith(name => name === 'malloc' ? 64 : 0)
  expect(() => renderRegion(module, 7, request, [page], () => failure, pdf)).toThrow(failure)
  expect(module.ccall.mock.calls.map(call => call[0])).toEqual(['malloc', pdf ? 'dsh_pdf_paint' : 'dsh_lok_document_paint', 'free'])
})

it.each([0, -1, 1.5, 100001])('rejects PDF page count %s before allocating geometry storage', count => {
  const module = moduleWith(() => count)
  expect(() => pdfPages(module, 7, () => failure)).toThrow(failure)
  expect(module.ccall).toHaveBeenCalledExactlyOnceWith('dsh_pdf_page_count', 'number', ['number'], [7])
})

it('reports a failed PDF geometry allocation without querying page sizes', () => {
  const module = moduleWith(name => name === 'dsh_pdf_page_count' ? 2 : 0)
  expect(() => pdfPages(module, 7, () => failure)).toThrow(failure)
  expect(module.ccall.mock.calls.map(call => call[0])).toEqual(['dsh_pdf_page_count', 'malloc'])
})

it('releases PDF geometry storage when a later page size query fails', () => {
  const module = moduleWith((name, _return, _types, args) => {
    if (name === 'dsh_pdf_page_count') return 2
    if (name === 'malloc') return 64
    module.HEAPU32[16] = 150; module.HEAPU32[17] = 300
    return name === 'dsh_pdf_page_size' && args[1] === 0 ? 1 : 0
  })
  expect(() => pdfPages(module, 7, () => failure)).toThrow(failure)
  expect(module.ccall).toHaveBeenLastCalledWith('free', 'number', ['number'], [64])
})

it.each([[0, 150], [150, 0], [0x80000000, 150], [150, 0x80000000]])('rejects PDF twips dimensions %s × %s', (width, height) => {
  const module = moduleWith(name => {
    if (name === 'malloc') return 64
    module.HEAPU32[16] = width; module.HEAPU32[17] = height
    return 1
  })
  expect(() => pdfPages(module, 7, () => failure)).toThrow(failure)
  expect(module.ccall).toHaveBeenLastCalledWith('free', 'number', ['number'], [64])
})

it('converts PDF page sizes to CSS pixels while retaining each immutable page index', () => {
  const module = moduleWith((name, _return, _types, args) => {
    if (name === 'malloc') return 64
    if (name === 'dsh_pdf_page_count') return 2
    if (name === 'dsh_pdf_page_size') {
      module.HEAPU32[16] = 150 * (Number(args[1]) + 1); module.HEAPU32[17] = 300
    }
    return 1
  })
  expect(pdfPages(module, 7, () => failure)).toEqual([
    { part: 0, x: 0, y: 0, width: 10, height: 20 }, { part: 1, x: 0, y: 0, width: 20, height: 20 },
  ])
  expect(module.ccall).toHaveBeenLastCalledWith('free', 'number', ['number'], [64])
})
