/** Browser-side WASM compilation without creating an Office Worker or memory. */
import { BrowserRenderError } from './types.ts'
import type { BrowserEngineAssets, PreparedBrowserEngine } from './types.ts'

interface PreparedBrowserEngineRecord {
  readonly wasmUrl: string
  readonly module: WebAssembly.Module
}

/**
 * Compile the version-matched LibreOffice WASM module for later document Workers.
 * @param assets - Browser resources whose WASM URL identifies the compiled module.
 * @param signal - Cancels the resource request; compilation may finish before cancellation is observed.
 * @returns an opaque, structured-cloneable engine handle that allocates no WASM memory.
 */
export async function prepareOfficeBrowser(assets: BrowserEngineAssets, signal?: AbortSignal): Promise<PreparedBrowserEngine> {
  signal?.throwIfAborted()
  if (typeof WebAssembly.compileStreaming !== 'function') throw new BrowserRenderError('unavailable', 'Streaming WebAssembly compilation is unavailable.')
  const response = await fetch(assets.wasmUrl, { credentials: 'same-origin', ...(signal === undefined ? {} : { signal }) })
  if (!response.ok) throw new BrowserRenderError('unavailable', `LibreOffice WASM request failed: ${response.status}`)
  const module = await WebAssembly.compileStreaming(Promise.resolve(response))
  signal?.throwIfAborted()
  return Object.freeze({ wasmUrl: assets.wasmUrl, module }) as unknown as PreparedBrowserEngine
}

/** Return the compiled module after validating the Worker-bound asset identity. */
export function preparedBrowserModule(prepared: PreparedBrowserEngine, assets: BrowserEngineAssets): WebAssembly.Module {
  const record = prepared as unknown as PreparedBrowserEngineRecord
  if (record.wasmUrl !== assets.wasmUrl || !(record.module instanceof WebAssembly.Module)) {
    throw new TypeError('The prepared browser engine does not match the requested WASM asset.')
  }
  return record.module
}

/** Instantiate precompiled code through Emscripten's synchronous override. */
export function instantiatePreparedModule(module: WebAssembly.Module, imports: WebAssembly.Imports,
  receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void): WebAssembly.Exports {
  const instance = new WebAssembly.Instance(module, imports)
  receive(instance, module)
  return instance.exports
}
