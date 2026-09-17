/** Raster ownership and cleanup at the WASM allocation and paint boundary. */
import { expect, it, vi } from 'vitest'
import { renderRegion } from '../src/engine-rendering.ts'
import type { EmscriptenModule } from '../src/engine-types.ts'

function fixture(mode = 0, failureAt?: 'allocate' | 'paint' | 'throw') {
  const memory = new Uint32Array(32)
  new Uint8Array(memory.buffer).fill(255)
  const call = vi.fn<EmscriptenModule['ccall']>((name, _result, _types, args) => {
    if (name === 'malloc') return failureAt === 'allocate' ? 0 : 8
    if (name === 'dsh_lok_document_paint') {
      expect([...new Uint8Array(memory.buffer, 8, 4)]).toEqual([0, 0, 0, 0])
      if (failureAt === 'throw') throw new Error('WASM trap')
      if (failureAt === 'paint') return 0
      new Uint8Array(memory.buffer, Number(args[1]), 4).set([10, 20, 30, 128])
      return 1
    }
    return name === 'dsh_lok_document_tile_mode' ? mode : 0
  })
  const module: EmscriptenModule = { ENV: {}, HEAPU32: memory, ccall: call, UTF8ToString: () => '',
    PThread: { terminateAllThreads() {} },
    FS: { mkdirTree() {}, writeFile() {}, readFile: () => new Uint8Array(), unlink() {} } }
  return { module, call, memory }
}

const pages = [{ x: 30, y: 60, width: 10, height: 10, part: -1 }]
const request = { pageIndex: 0, x: 0.5, y: 0.25, width: 0.1, height: 0.2, scale: 2 }

it.each([0, 1])('copies %s-mode pixels before freeing the allocation and applies page offsets', mode => {
  const f = fixture(mode)
  const tile = renderRegion(f.module, 7, request, pages, () => new Error('paint failed'))
  expect(f.call).toHaveBeenCalledWith('dsh_lok_document_paint', 'number', expect.any(Array), [7, 8, -1, 1, 1, 38, 64, 2, 3])
  expect(f.call).toHaveBeenLastCalledWith('free', 'number', ['number'], [8])
  new Uint8Array(f.memory.buffer).fill(0)
  expect(tile).toEqual({ width: 1, height: 1, rgba: new Uint8ClampedArray(mode === 0 ? [20, 40, 60, 128] : [60, 40, 20, 128]) })
})

it.each(['allocate', 'paint', 'throw', 'format'] as const)('releases every acquired allocation after %s failure', fault => {
  const f = fixture(fault === 'format' ? 2 : 0, fault === 'format' ? undefined : fault)
  expect(() => renderRegion(f.module, 7, request, pages, () => new Error('paint failed'))).toThrow()
  const frees = f.call.mock.calls.filter(call => call[0] === 'free')
  expect(frees).toHaveLength(fault === 'allocate' ? 0 : 1)
  if (fault === 'allocate') expect(f.call).toHaveBeenCalledTimes(1)
})

it('rejects out-of-page input before allocating WASM memory', () => {
  const f = fixture()
  expect(() => renderRegion(f.module, 7, { ...request, width: 20 }, pages, () => new Error('paint failed'))).toThrow()
  expect(f.call).not.toHaveBeenCalled()
})
