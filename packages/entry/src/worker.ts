/** Cancellable CPU work and WASM conversion run outside the Node event loop. */
import { parentPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspectDocument } from './document.ts'
import { createFontLoader, preloadFonts } from './font-loader.ts'
import type { FontResolutionCacheEntry } from './font-loader.ts'
import { renderImagesWithWasm } from './image-renderer.ts'
import type { ImageRenderSpec } from './image-operations.ts'
import { convertWithWasm } from './wasm.ts'
import { ConversionError, failureCode } from './errors.ts'
import type { ConversionSpec } from './operations.ts'
import type { Engine } from './engine.ts'
import type { FontFace } from './fonts.ts'
import type { ResolvedOptions } from './options.ts'

/** Worker input: inspected paths, validated limits, the resolved engine, and the current font snapshot. */
export interface WorkerRequest {
  readonly inputPath: string
  readonly extension: string
  readonly operation: ConversionSpec | ImageRenderSpec
  readonly options: ResolvedOptions
  readonly engine: Engine
  readonly scratch: string
  /** Faces the caller's font snapshot revalidated for this conversion. */
  readonly fontFaces: FontFace[]
  readonly fontCache?: FontResolutionCacheEntry[] | undefined
}

/**
 * @param port - The parent port, present inside a Worker thread.
 * @returns the connected parent port.
 * @throws when this entry is loaded outside a Worker.
 */
function requireParentPort(port: MessagePort | null): MessagePort {
  if (port === null) throw new Error('The LibreOffice conversion worker requires a parent port.')
  return port
}

// workerData is `any` at the node:worker_threads boundary; the converter is the
// only spawner and always provides a WorkerRequest.
const port = requireParentPort(parentPort)

try {
  const { inputPath, extension, operation, options, engine, scratch, fontFaces, fontCache } = workerData as WorkerRequest
  const bytes = readFileSync(inputPath)
  const images = 'kind' in operation && operation.kind === 'images'
  if (images && extension === 'pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new ConversionError('invalid-document', 'Input does not contain a PDF header.')
  const document = images && extension === 'pdf' ? { families: new Map<string, string>(), codePoints: [] } : inspectDocument(bytes, extension, options)
  if (engine.backend === 'wasm') {
    if (fontFaces.length === 0 && extension !== 'pdf') throw new ConversionError('unavailable', 'No usable fonts were found. Install fonts or configure fontDirectories before converting documents.')
    if (images) {
      let cacheEntries: FontResolutionCacheEntry[] = []
      const result = await renderImagesWithWasm({ engine, bytes, extension, operation: operation as ImageRenderSpec,
        options, document, faces: fontFaces, ...(fontCache === undefined ? {} : { fontCache }),
        onFontCache: entries => { cacheEntries = entries } })
      port.postMessage({ kind: 'font-cache', entries: cacheEntries })
      port.postMessage({ ok: true, images: result })
    } else {
      const result = await convertWithWasm({ engine, bytes, extension, operation: operation as ConversionSpec,
        options, document, faces: fontFaces, ...(fontCache === undefined ? {} : { fontCache }),
        onFontCache: entries => port.postMessage({ kind: 'font-cache', entries }) })
      port.postMessage({ ok: true, ...result }, [result.output.buffer as ArrayBuffer])
    }
  } else {
    const directory = join(scratch, 'fonts')
    mkdirSync(directory, { mode: 0o700 })
    const fonts = createFontLoader(options, document, (name, data) => {
      const path = join(directory, name)
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
      return path
    }, fontFaces, fontCache)
    preloadFonts(fonts, options, document, true)
    port.postMessage({ kind: 'font-cache', entries: fonts.cacheEntries })
    port.postMessage({ ok: true, fonts: fonts.files, substitutions: fonts.substitutions, missingFonts: fonts.missingFonts })
  }
} catch (error) {
  port.postMessage({ ok: false, code: failureCode(error), error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined })
}
