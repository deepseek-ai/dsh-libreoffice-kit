/** Offline discovery of the installed engine and public entry points. */
import { fileURLToPath } from 'node:url'
import { ENGINE_VERSION, resolveEngine } from './engine.ts'
import { ConversionError } from './errors.ts'

/** Paths use the same installed Node API and precompiled engine as createConverter. */
export interface RuntimeInfo {
  readonly version: string
  readonly backend: 'native' | 'wasm'
  readonly cliPath: string
  readonly nodeApiPath: string
}

/**
 * Inspect installed engine metadata without starting, downloading, or building an engine.
 * @returns Public entry paths, engine version, and selected backend.
 * @throws ConversionError when the installed engine is unavailable or invalid.
 */
export async function discoverRuntime(): Promise<RuntimeInfo> {
  try {
    const engine = await resolveEngine()
    return { version: ENGINE_VERSION, backend: engine.backend,
      cliPath: fileURLToPath(new URL('./cli.js', import.meta.url)),
      nodeApiPath: fileURLToPath(new URL('./index.js', import.meta.url)) }
  } catch (cause) {
    throw new ConversionError('unavailable', (cause as Error).message, { cause })
  }
}
