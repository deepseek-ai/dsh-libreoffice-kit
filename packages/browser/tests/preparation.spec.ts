import { afterEach, expect, it, vi } from 'vitest'
import { instantiatePreparedModule, preparedBrowserModule, prepareOfficeBrowser } from '../src/preparation.ts'

const assets = { workerUrl: '/worker.js', loaderUrl: '/soffice.js', dataUrl: '/soffice.data', wasmUrl: '/dsh-office.wasm',
  metadataUrl: '/soffice.data.js.metadata', programDirectory: '/instdir/program' }
const emptyModule = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0)

afterEach(() => { vi.unstubAllGlobals() })

it('compiles one successful WASM response into a cloneable asset-bound handle', async () => {
  const fetch = vi.fn(async () => new Response(emptyModule, { headers: { 'content-type': 'application/wasm' } }))
  vi.stubGlobal('fetch', fetch)
  const prepared = await prepareOfficeBrowser(assets)
  const module = preparedBrowserModule(prepared, assets)
  expect(structuredClone(module)).toBeInstanceOf(WebAssembly.Module)
  expect(fetch).toHaveBeenCalledExactlyOnceWith('/dsh-office.wasm', { credentials: 'same-origin' })
  expect(() => preparedBrowserModule(prepared, { ...assets, wasmUrl: '/other.wasm' })).toThrow(/does not match/)
})

it('reports request failures and observes cancellation after compilation', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
  await expect(prepareOfficeBrowser(assets)).rejects.toMatchObject({ code: 'unavailable' })
  const abort = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => {
    abort.abort(new Error('stopped'))
    return new Response(emptyModule, { headers: { 'content-type': 'application/wasm' } })
  }))
  await expect(prepareOfficeBrowser(assets, abort.signal)).rejects.toThrow('stopped')
})

it('rejects browsers without streaming WebAssembly compilation before fetching', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('WebAssembly', { compileStreaming: undefined })
  await expect(prepareOfficeBrowser(assets)).rejects.toMatchObject({ code: 'unavailable' })
  expect(fetch).not.toHaveBeenCalled()
})

it('instantiates compiled code and publishes the exact module and instance', async () => {
  const module = await WebAssembly.compile(emptyModule)
  const receive = vi.fn()
  const exports = instantiatePreparedModule(module, {}, receive)
  expect(exports).toEqual({})
  expect(receive).toHaveBeenCalledWith(expect.any(WebAssembly.Instance), module)
})
