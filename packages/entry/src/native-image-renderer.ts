/** Direct native LibreOfficeKit/PDFium rasterization through one operation-owned helper. */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { prepareNativeFontProfile, nativeEnvironment } from './native.ts'
import { ConversionError, failureCode } from './errors.ts'
import { selectedPages, type ImageRenderSpec, type RenderedImage, type RenderImagesResult } from './image-operations.ts'
import { dataArea, parseCellRange, rangeName, sheetPartInfo, sheetRangeRectangle, type Rectangle, type SheetGeometry } from './sheet-geometry.ts'
import { encodePng } from './png.ts'
import { rgbaPixels, splitRasterRectangle, tileDimensions, writerPages, type EnginePage } from './rendering.ts'
import type { FontSubstitution } from './font-loader.ts'
import type { NativeEngine } from './engine.ts'
import type { ResolvedOptions } from './options.ts'

interface NativeSheet { readonly part: number; readonly info: string; readonly geometry: string }
interface NativeReady {
  readonly ok: true
  readonly kind: 'ready'
  readonly documentType: 'pdf' | 'text' | 'spreadsheet' | 'presentation'
  readonly tileMode: 0 | 1
  readonly writerRectangles?: string
  readonly pages?: { readonly width: number; readonly height: number }[]
  readonly sheets?: NativeSheet[]
}
interface NativePaint {
  readonly ok: true
  readonly kind: 'paint'
  readonly index: number
  readonly path: string
  readonly width: number
  readonly height: number
}
interface ImageRegion { page: EnginePage; rectangle: Rectangle; number?: number; sheet?: string; range?: string; rtl?: boolean }

function failure(value: unknown, stderr: string): Error {
  const result = value as { code?: string; error?: string }
  return new ConversionError(failureCode(result), `LibreOffice native rendering failed: ${result.error ?? stderr}`)
}

function plan(ready: NativeReady, request: ImageRenderSpec): { count: number; regions: ImageRegion[] } {
  const select = (pages: EnginePage[]) => ({ count: pages.length, regions: selectedPages(request.pages, pages.length, request.maxPages).map(number => {
    const page = pages[number - 1]!
    return { page, number, rectangle: { x: 0, y: 0, width: page.width, height: page.height } }
  }) })
  if (ready.documentType === 'pdf' || ready.documentType === 'presentation') {
    const pages = ready.pages
    if (!Array.isArray(pages)) throw new ConversionError('invalid-document', 'LibreOffice returned no page dimensions.')
    return select(pages.map(({ width, height }, part) => {
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
        throw new ConversionError('invalid-document', 'LibreOffice returned invalid page dimensions.')
      return { part, x: 0, y: 0, width: width / 15, height: height / 15 }
    }))
  }
  if (ready.documentType === 'text') {
    if (typeof ready.writerRectangles !== 'string') throw new ConversionError('invalid-document', 'LibreOffice returned no Writer page rectangles.')
    return select(writerPages(ready.writerRectangles))
  }
  const sheets = (ready.sheets ?? []).map(({ part, info, geometry }) => ({
    part, info: sheetPartInfo(info), geometry: JSON.parse(geometry) as SheetGeometry,
  }))
  const count = sheets.filter(sheet => sheet.info.visible).length
  const chosen = request.sheet === undefined ? sheets.filter(sheet => sheet.info.visible)
    : sheets.filter(sheet => sheet.info.name === request.sheet)
  if (chosen.length === 0) throw new ConversionError('invalid-document', 'The exact worksheet name does not exist or the workbook has no visible sheets.')
  if (chosen.length > request.maxPages) throw new ConversionError('output-too-large', 'Selected worksheet count exceeds maxPages; select a sheet or raise the limit.')
  const scale = request.dpi / 96
  return { count, regions: chosen.map(({ part, info, geometry }) => {
    const range = request.range === undefined ? dataArea(info) : parseCellRange(request.range)
    const rectangle = sheetRangeRectangle(geometry, range, scale)
    return { page: { x: 0, y: 0, width: rectangle.x + rectangle.width, height: rectangle.y + rectangle.height, part },
      rectangle, sheet: info.name, range: rangeName(range), rtl: Boolean(info.rtllayout) }
  }) }
}

/** Run one native image batch and write final PNGs only after each bounded paint succeeds. */
export async function renderImagesWithNative(request: {
  readonly engine: NativeEngine
  readonly options: ResolvedOptions
  readonly inputPath: string
  readonly source: Uint8Array
  readonly scratch: string
  readonly profile: string
  readonly fonts: readonly string[]
  readonly substitutions: readonly FontSubstitution[]
  readonly missingFonts: string[]
  readonly operation: ImageRenderSpec
  readonly signal: AbortSignal
}): Promise<RenderImagesResult> {
  const { engine, options, inputPath, source, scratch, profile, fonts, substitutions, missingFonts, operation, signal } = request
  signal.throwIfAborted()
  await mkdir(profile, { mode: 0o700 })
  await prepareNativeFontProfile(profile, substitutions)
  const child = spawn(engine.executable, ['--operation', 'render-images', '--program-directory', engine.programDirectory,
    '--input-path', inputPath, '--scratch-directory', scratch, '--profile-directory', profile,
    '--max-output-bytes', String(options.maxOutputBytes), '--max-image-resolution', String(options.maxImageResolution),
    ...fonts.flatMap(path => ['--font-file', path])],
  { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: nativeEnvironment(profile, engine.programDirectory) })
  const lines: string[] = []
  const waiters: ((line: string) => void)[] = []
  const output = createInterface({ input: child.stdout })
  output.on('line', line => { const waiter = waiters.shift(); if (waiter) waiter(line); else lines.push(line) })
  let stderr = ''
  let stopped: unknown
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-65_536) })
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  const abort = (): void => { stopped ??= signal.reason; child.kill('SIGKILL') }
  signal.addEventListener('abort', abort, { once: true })
  const next = async (): Promise<string> => {
    signal.throwIfAborted()
    if (lines.length > 0) return lines.shift()!
    return new Promise<string>((resolve, reject) => {
      const done = (line: string) => { signal.removeEventListener('abort', cancel); resolve(line) }
      const cancel = () => { const index = waiters.indexOf(done); if (index >= 0) waiters.splice(index, 1); reject(signal.reason) }
      signal.addEventListener('abort', cancel, { once: true })
      waiters.push(done)
    })
  }
  const response = async <T>(): Promise<T> => {
    const line = await next()
    let value: unknown
    try { value = JSON.parse(line) } catch (cause) { throw new Error(`LibreOffice native renderer returned invalid JSON. ${stderr}`, { cause }) }
    if (!(value as { ok?: boolean }).ok) throw failure(value, stderr)
    return value as T
  }
  try {
    const ready = await response<NativeReady>()
    if (ready.kind !== 'ready') throw new Error('LibreOffice native renderer did not initialize.')
    const planned = plan(ready, operation)
    const scale = operation.dpi / 96
    const selected: ImageRegion[] = []
    for (const region of planned.regions) {
      if (region.sheet === undefined) selected.push(region)
      else {
        let rectangles: Rectangle[]
        try {
          rectangles = splitRasterRectangle(region.rectangle, scale, { maxPixels: operation.maxPixels,
            maxDimension: operation.maxDimension, maxTiles: operation.maxPages - selected.length })
        } catch (cause) { throw new ConversionError('output-too-large', String(cause), { cause }) }
        selected.push(...rectangles.map(rectangle => ({ ...region, rectangle })))
      }
    }
    for (const { page, rectangle } of selected) {
      const { width, height } = tileDimensions({ pageIndex: 0, ...rectangle, scale }, [page])
      if (width > operation.maxDimension || height > operation.maxDimension || width * height > operation.maxPixels)
        throw new ConversionError('output-too-large', 'Selected page exceeds maxPixels or maxDimension; reduce DPI or raise the image limits.')
    }
    const images: RenderedImage[] = []
    let total = 0
    for (const region of selected) {
      signal.throwIfAborted()
      const { width, height } = tileDimensions({ pageIndex: 0, ...region.rectangle, scale }, [region.page])
      const x = region.page.x + Math.round(region.rectangle.x * 15)
      const y = region.page.y + Math.round(region.rectangle.y * 15)
      const twipsWidth = Math.max(1, Math.round(region.rectangle.width * 15))
      const twipsHeight = Math.max(1, Math.round(region.rectangle.height * 15))
      const index = images.length + 1
      child.stdin.write(`P ${index} ${region.page.part} ${width} ${height} ${x} ${y} ${twipsWidth} ${twipsHeight}\n`)
      const painted = await response<NativePaint>()
      if (painted.kind !== 'paint' || painted.index !== index || painted.width !== width || painted.height !== height)
        throw new Error('LibreOffice native renderer returned inconsistent tile metadata.')
      if (resolve(painted.path) !== resolve(scratch, `tile-${index}.rgba`))
        throw new Error('LibreOffice native renderer returned a tile outside its scratch directory.')
      const raw = await readFile(painted.path)
      if (raw.byteLength !== width * height * 4) throw new Error('LibreOffice native renderer returned incomplete pixels.')
      const rgba = ready.documentType === 'pdf' ? new Uint8ClampedArray(raw) : rgbaPixels(raw, ready.tileMode)
      const png = encodePng(width, height, rgba)
      total += png.byteLength
      if (total > options.maxOutputBytes) throw new ConversionError('output-too-large', 'PNG batch exceeds maxOutputBytes.')
      const path = join(operation.outputDir, `page-${String(index).padStart(4, '0')}.png`)
      await writeFile(path, png, { flag: 'wx', mode: 0o600 })
      images.push({ index, ...(region.number === undefined ? {} : { page: region.number }),
        ...(region.sheet === undefined ? {} : { sheet: region.sheet, range: region.range!, rtl: region.rtl! }),
        path, width, height, rectangle: region.rectangle, byteLength: png.byteLength })
    }
    child.stdin.end('DONE\n')
    const done = await response<{ ok: true; kind: 'done' }>()
    if (done.kind !== 'done') throw new Error('LibreOffice native renderer did not finish.')
    const code = await closed
    if (code !== 0) throw new Error(`LibreOffice native renderer exited ${code}. ${stderr}`)
    return { schemaVersion: 1, backend: 'native', rasterEngine: ready.documentType === 'pdf' ? 'pdfium' : 'libreoffice',
      source: 'saved', inputPath: operation.inputPath, sourceSha256: createHash('sha256').update(source).digest('hex'),
      dpi: operation.dpi, pageCount: planned.count, images, missingFonts: [...missingFonts] }
  } finally {
    signal.removeEventListener('abort', abort)
    output.close()
    if (child.exitCode === null) child.kill('SIGKILL')
    await closed.catch(() => {})
    if (stopped !== undefined) throw stopped
  }
}
