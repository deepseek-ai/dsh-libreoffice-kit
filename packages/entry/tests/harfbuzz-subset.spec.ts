import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'

const read = fs.readFile
const wasm = await read(new URL('../assets/font-subset.wasm', import.meta.url))
const receipt = await read(new URL('../assets/font-subset.json', import.meta.url), 'utf8')
afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); vi.doUnmock('node:fs/promises') })

function engine(fault?: string) {
  const memory = new WebAssembly.Memory({ initial: 1 })
  new Uint8Array(memory.buffer).set([1, 2, 3], 100)
  return {
    memory, _initialize: vi.fn(), malloc: vi.fn(() => fault === 'allocation' ? 0 : 8), free: vi.fn(),
    hb_blob_create: vi.fn(() => 1), hb_blob_destroy: vi.fn(), hb_face_create: vi.fn(() => 2), hb_face_destroy: vi.fn(),
    hb_subset_input_create_or_fail: vi.fn(() => fault === 'input' ? 0 : 3), hb_subset_input_destroy: vi.fn(),
    hb_subset_input_set: vi.fn(() => 4), hb_set_clear: vi.fn(), hb_set_invert: vi.fn(), hb_subset_input_set_flags: vi.fn(),
    hb_subset_input_unicode_set: vi.fn(() => 5), hb_set_add: vi.fn(), hb_subset_or_fail: vi.fn(() => fault === 'subset' ? 0 : 6),
    hb_face_reference_blob: vi.fn(() => 7), hb_blob_get_data: vi.fn(() => 100), hb_blob_get_length: vi.fn(() => fault === 'empty' ? 0 : 3),
  }
}

it.each(['allocation', 'input', 'subset', 'empty'])('allocation failures and empty output reject and release acquired objects: %s', async fault => {
  const hb = engine(fault)
  vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({ instance: { exports: hb } } as unknown as WebAssembly.WebAssemblyInstantiatedSource)
  const { subsetFont } = await import('../src/harfbuzz-subset.ts')
  await expect(subsetFont(Uint8Array.of(9), 0, [65])).rejects.toThrow(/subsetter/)
  if (fault === 'allocation') expect(hb.free).not.toHaveBeenCalled()
  else expect(hb.free).toHaveBeenCalledWith(8)
  if (fault === 'empty') expect(hb.hb_blob_destroy).toHaveBeenCalledWith(7)
})

it.each([{}, { schemaVersion: 1 }, { schemaVersion: 1, source: {} }, { schemaVersion: 1, source: { algorithm: 'other' } },
  { ...JSON.parse(receipt), files: {} }, { ...JSON.parse(receipt), files: { 'assets/font-subset.wasm': { bytes: wasm.byteLength, sha256: 'wrong' } } },
])('mismatched packaged module receipts reject before instantiation: %j', async invalid => {
  vi.doMock('node:fs/promises', () => ({ readFile: async (url: URL) => url.pathname.endsWith('.json') ? JSON.stringify(invalid) : wasm }))
  const instantiate = vi.spyOn(WebAssembly, 'instantiate')
  const { subsetFont } = await import('../src/harfbuzz-subset.ts')
  await expect(subsetFont(Uint8Array.of(1), 0, [65])).rejects.toThrow(/receipt/)
  expect(instantiate).not.toHaveBeenCalled()
})

it('copies result bytes from current Wasm memory after heap growth', async () => {
  const hb = engine()
  hb.hb_subset_or_fail.mockImplementation(() => { hb.memory.grow(1); new Uint8Array(hb.memory.buffer).set([4, 5, 6], 100); return 6 })
  vi.spyOn(WebAssembly, 'instantiate').mockResolvedValue({ instance: { exports: hb } } as unknown as WebAssembly.WebAssemblyInstantiatedSource)
  const { subsetFont } = await import('../src/harfbuzz-subset.ts')
  expect(await subsetFont(Uint8Array.of(1), 0, [65])).toEqual(Uint8Array.of(4, 5, 6))
  expect(hb._initialize).toHaveBeenCalledOnce()
})
