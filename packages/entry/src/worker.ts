/** Cancellable CPU work and WASM conversion run outside the Node event loop. */
import { parentPort, workerData } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspectDocument } from './document.ts'
import { createFontLoader, preloadFonts } from './font-loader.ts'
import { indexSystemFonts } from './fonts.ts'
import { convertWithWasm } from './wasm.ts'
import { ConversionError, failureCode } from './errors.ts'
import type { Engine } from './engine.ts'
import type { FontFace } from './fonts.ts'
import type { ResolvedOptions } from './options.ts'

/** Worker input: inspected paths, validated limits, the resolved engine, and cached faces. */
export interface WorkerRequest {
  readonly inputPath: string
  readonly extension: string
  readonly options: ResolvedOptions
  readonly engine: Engine
  readonly scratch: string
  /** Faces the previous conversion indexed; absent until the worker reports them. */
  readonly fontFaces?: FontFace[] | undefined
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
  const { inputPath, extension, options, engine, scratch, fontFaces } = workerData as WorkerRequest
  const bytes = readFileSync(inputPath)
  const document = inspectDocument(bytes, extension, options)
  const faces = fontFaces ?? indexSystemFonts({ directories: options.fontDirectories, maxFiles: options.maxFontFiles,
    maxFileBytes: options.maxFontFileBytes })
  if (!fontFaces) port.postMessage({ kind: 'fonts', faces })
  if (engine.backend === 'wasm') {
    if (faces.length === 0) throw new ConversionError('unavailable', 'No usable fonts were found. Install fonts or configure fontDirectories before converting documents.')
    const result = await convertWithWasm({ engine, bytes, extension, options, document, faces })
    port.postMessage({ ok: true, ...result }, [result.pdf.buffer as ArrayBuffer])
  } else {
    const directory = join(scratch, 'fonts')
    mkdirSync(directory, { mode: 0o700 })
    const fonts = createFontLoader(options, document, (name, data) => {
      const path = join(directory, name)
      writeFileSync(path, data, { flag: 'wx', mode: 0o600 })
      return path
    }, faces)
    preloadFonts(fonts, options, document, true)
    port.postMessage({ ok: true, fonts: fonts.files, substitutions: fonts.substitutions, missingFonts: fonts.missingFonts })
  }
} catch (error) {
  port.postMessage({ ok: false, code: failureCode(error), error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined })
}
