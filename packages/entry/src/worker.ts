/** Cancellable CPU work and WASM conversion run outside the Node event loop. */
import { parentPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspectDocument } from './document.ts'
import { createFontLoader, preloadFonts } from './font-loader.ts'
import type { FontResolutionCacheEntry } from './font-loader.ts'
import { indexSystemFonts } from './fonts.ts'
import { officeFontFace, officeFontFiles } from './office-fonts.ts'
import { renderImagesWithWasm } from './image-renderer.ts'
import type { ImageRenderSpec } from './image-operations.ts'
import { convertWithWasm } from './wasm.ts'
import { ConversionError, failureCode } from './errors.ts'
import type { ConversionSpec } from './operations.ts'
import type { Engine } from './engine.ts'
import type { FontFace } from './fonts.ts'
import type { ResolvedOptions } from './options.ts'

/** Worker input: inspected paths, validated limits, the resolved engine, and cached faces. */
export interface WorkerRequest {
  readonly inputPath: string
  readonly extension: string
  readonly operation: ConversionSpec | ImageRenderSpec
  readonly options: ResolvedOptions
  readonly engine: Engine
  readonly scratch: string
  /** Faces the previous conversion indexed; absent until the worker reports them. */
  readonly fontFaces?: FontFace[] | undefined
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

function indexFonts(options: ResolvedOptions): FontFace[] {
  const primary = indexSystemFonts({ directories: options.fontDirectories, maxFiles: options.maxFontFiles,
    maxFileBytes: options.maxFontFileBytes })
  if (!options.includeOfficeFonts) return primary
  const primaryFiles = new Set(primary.map(face => face.path))
  const remaining = Math.max(0, options.maxFontFiles - primaryFiles.size)
  if (remaining === 0) return primary
  const supplemental = indexSystemFonts({ directories: officeFontFiles().slice(0, remaining), maxFiles: remaining,
    maxFileBytes: options.maxFontFileBytes })
  const aliases = new Set(primary.flatMap(face => face.aliases))
  return [...primary, ...supplemental.filter(face => officeFontFace(face)
    && !face.aliases.some(alias => aliases.has(alias)))]
}

try {
  const { inputPath, extension, operation, options, engine, scratch, fontFaces, fontCache } = workerData as WorkerRequest
  const bytes = readFileSync(inputPath)
  const images = 'kind' in operation && operation.kind === 'images'
  if (images && extension === 'pdf' && new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-')
    throw new ConversionError('invalid-document', 'Input does not contain a PDF header.')
  const document = images && extension === 'pdf' ? { families: new Map<string, string>(), codePoints: [] } : inspectDocument(bytes, extension, options)
  const faces = fontFaces ?? indexFonts(options)
  if (!fontFaces) port.postMessage({ kind: 'fonts', faces })
  if (engine.backend === 'wasm') {
    if (faces.length === 0 && extension !== 'pdf') throw new ConversionError('unavailable', 'No usable fonts were found. Install fonts or configure fontDirectories before converting documents.')
    if (images) {
      let cacheEntries: FontResolutionCacheEntry[] = []
      const result = await renderImagesWithWasm({ engine, bytes, extension, operation: operation as ImageRenderSpec,
        options, document, faces, ...(fontCache === undefined ? {} : { fontCache }),
        onFontCache: entries => { cacheEntries = entries } })
      port.postMessage({ kind: 'font-cache', entries: cacheEntries })
      port.postMessage({ ok: true, images: result })
    } else {
      const result = await convertWithWasm({ engine, bytes, extension, operation: operation as ConversionSpec,
        options, document, faces, ...(fontCache === undefined ? {} : { fontCache }),
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
    }, faces, fontCache)
    preloadFonts(fonts, options, document, true)
    port.postMessage({ kind: 'font-cache', entries: fonts.cacheEntries })
    port.postMessage({ ok: true, fonts: fonts.files, substitutions: fonts.substitutions, missingFonts: fonts.missingFonts })
  }
} catch (error) {
  port.postMessage({ ok: false, code: failureCode(error), error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined })
}
