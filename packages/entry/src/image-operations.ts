/** Public direct-raster request and immutable saved-file manifest. */
import { extname, isAbsolute, resolve, relative } from 'node:path'
import { ConversionError } from './errors.ts'
import { parseCellRange, rangeName, type Rectangle } from './sheet-geometry.ts'
import { MAX_TILE_PIXELS } from './rendering.ts'
export const IMAGE_FORMATS = ['doc', 'docx', 'odt', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'pdf'] as const
export interface RenderImagesRequest {
  readonly inputPath: string
  /** Must not exist. A failed or cancelled batch removes this entire new directory. */
  readonly outputDir: string
  /** One-based physical pages/slides; forbidden for worksheets. Default: all. */
  readonly pages?: 'all' | readonly number[]
  /** Calc only. Exact worksheet name. Without it, render each visible worksheet's data area. */
  readonly sheet?: string
  /** Calc only. A1 rectangle, requiring an exact sheet. Default: A1 through the last data cell. */
  readonly range?: string
  /** Raster DPI. Default 144, range 24–600. */
  readonly dpi?: number
  /** Total output image limit, including worksheet fragments. Never truncates. Default: 100. */
  readonly maxPages?: number
  /** Per-image pixel limit. Default and maximum: 16777216. */
  readonly maxPixels?: number
  /** Per-image width/height limit in output pixels. Default: 8192. */
  readonly maxDimension?: number
}
export interface RenderedImage {
  readonly index: number
  readonly page?: number
  readonly sheet?: string
  readonly range?: string
  readonly rtl?: boolean
  readonly path: string
  readonly width: number
  readonly height: number
  /** Source rectangle in CSS pixels at 96 DPI, before raster scale. */
  readonly rectangle: Rectangle
  readonly byteLength: number
}
export interface RenderImagesResult {
  readonly schemaVersion: 1
  readonly backend: 'wasm'
  readonly rasterEngine: 'libreoffice' | 'pdfium'
  readonly source: 'saved'
  readonly inputPath: string
  readonly sourceSha256: string
  readonly dpi: number
  /** Total physical pages/slides, or visible worksheets; images contains the selected subset. */
  readonly pageCount: number
  readonly images: readonly RenderedImage[]
  readonly missingFonts: string[]
}
export interface ImageRenderSpec extends RenderImagesRequest {
  readonly kind: 'images'
  readonly extension: string
  readonly dpi: number
  readonly maxPages: number
  readonly maxPixels: number
  readonly maxDimension: number
}
export function resolveImageRender(request: RenderImagesRequest): ImageRenderSpec {
  if (!request || typeof request.inputPath !== 'string' || typeof request.outputDir !== 'string'
    || !isAbsolute(request.inputPath) || !isAbsolute(request.outputDir) || request.inputPath.includes('\0') || request.outputDir.includes('\0'))
    throw new TypeError('inputPath and outputDir must be absolute filesystem paths.')
  const inputPath = resolve(request.inputPath), outputDir = resolve(request.outputDir)
  const within = relative(outputDir, inputPath)
  if (!within || (!within.startsWith('..') && !isAbsolute(within))) throw new TypeError('Input cannot be inside the newly owned output directory.')
  const extension = extname(inputPath).slice(1).toLowerCase()
  if (!(IMAGE_FORMATS as readonly string[]).includes(extension)) throw new ConversionError('unsupported-format', `Unsupported image input: ${extension}.`)
  const calc = ['xls', 'xlsx', 'ods'].includes(extension)
  if (calc && request.pages !== undefined) throw new TypeError('Worksheets use sheet and A1 range, not printed page numbers.')
  if (!calc && (request.sheet !== undefined || request.range !== undefined)) throw new TypeError('sheet and range apply only to worksheets.')
  if (request.sheet !== undefined && (typeof request.sheet !== 'string' || !request.sheet.trim() || request.sheet.includes('\0')))
    throw new TypeError('sheet must be a nonempty exact worksheet name.')
  if (request.range !== undefined && request.sheet === undefined) throw new TypeError('range requires an exact sheet name.')
  const range = request.range === undefined ? undefined : rangeName(parseCellRange(request.range))
  const pages = request.pages ?? 'all'
  if (pages !== 'all' && (!Array.isArray(pages) || pages.length === 0 || pages.some(page => !Number.isSafeInteger(page) || page < 1)
    || new Set(pages).size !== pages.length)) throw new TypeError('pages must be all or distinct positive one-based page numbers.')
  const dpi = request.dpi ?? 144
  const maxPages = request.maxPages ?? 100
  const maxPixels = request.maxPixels ?? MAX_TILE_PIXELS
  const maxDimension = request.maxDimension ?? 8192
  if (!Number.isFinite(dpi) || dpi < 24 || dpi > 600) throw new TypeError('dpi must be between 24 and 600.')
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10000) throw new TypeError('maxPages must be an integer between 1 and 10000.')
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > MAX_TILE_PIXELS) throw new TypeError('maxPixels must be between 1 and 16777216.')
  if (!Number.isSafeInteger(maxDimension) || maxDimension < 1 || maxDimension > MAX_TILE_PIXELS) throw new TypeError('maxDimension must be between 1 and 16777216.')
  if (pages !== 'all' && pages.length > maxPages) throw new ConversionError('output-too-large', 'Selected page count exceeds maxPages.')
  return { kind: 'images', inputPath, outputDir, extension, dpi, maxPages, maxPixels, maxDimension,
    ...(calc ? {} : { pages: pages === 'all' ? 'all' : [...pages] }), ...(request.sheet === undefined ? {} : { sheet: request.sheet }), ...(range === undefined ? {} : { range }) }
}
export function selectedPages(pages: 'all' | readonly number[] | undefined, count: number, limit: number): number[] {
  if (!Number.isSafeInteger(count) || count < 1) throw new ConversionError('invalid-document', 'The document contains no renderable pages.')
  const result = pages === undefined || pages === 'all' ? Array.from({ length: Math.min(count, limit + 1) }, (_, i) => i + 1) : [...pages]
  if (result.length > limit) throw new ConversionError('output-too-large', 'Selected page count exceeds maxPages; select pages or raise the limit.')
  if (result.some(page => page > count)) throw new TypeError(`Selected page lies outside the ${count}-page document.`)
  return result
}
