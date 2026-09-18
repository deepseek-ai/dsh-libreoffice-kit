/** One saved-file model and one bounded direct PNG batch; no Office-to-PDF intermediate. */
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { withWasmSession, engineError, type WasmConversionRequest, type WasmSession } from './wasm.ts'
import { numericCall, engineString, pdfPages, renderRegion } from './engine-rendering.ts'
import { tileDimensions, writerPages, type EnginePage } from './rendering.ts'
import { dataArea, parseCellRange, rangeName, sheetPartInfo, sheetRangeRectangle, type Rectangle, type SheetGeometry } from './sheet-geometry.ts'
import { selectedPages, type ImageRenderSpec, type RenderedImage, type RenderImagesResult } from './image-operations.ts'
import { ConversionError } from './errors.ts'
import { encodePng } from './png.ts'
interface ImageRegion { page: EnginePage; rectangle: Rectangle; number?: number; sheet?: string; range?: string; rtl?: boolean }
async function regions(session: WasmSession, request: ImageRenderSpec): Promise<{ count: number; regions: ImageRegion[] }> {
  const { module, document, office, pdf } = session
  const call = (name: string, args: number[]) => numericCall(module, name, args)
  const failure = () => engineError(module, office)
  const text = (name: string, args: number[]) => engineString(module, name, args.map(() => 'number'), args, failure)
  const values = (command: string) => engineString(module, 'dsh_lok_document_command_values', ['number', 'string'], [document, command], failure)
  const select = (pages: EnginePage[]) => ({ count: pages.length, regions: selectedPages(request.pages, pages.length, request.maxPages).map(number => {
    const page = pages[number - 1]!
    return { page, number, rectangle: { x: 0, y: 0, width: page.width, height: page.height } }
  }) })
  if (pdf) return select(pdfPages(module, document, failure))
  if (!call('dsh_lok_document_initialize_rendering', [document]) || !call('dsh_lok_document_listen', [document])) throw failure()
  await session.idle()
  const type = call('dsh_lok_document_type', [document])
  const expected = ['xls', 'xlsx', 'ods'].includes(request.extension) ? 1 : ['ppt', 'pptx', 'odp'].includes(request.extension) ? 2 : 0
  if (type !== expected) throw new ConversionError('invalid-document', 'LibreOffice imported the input as an unexpected document type.')
  if (type === 0) return select(writerPages(text('dsh_lok_document_page_rectangles', [document])))
  const parts = call('dsh_lok_document_parts', [document])
  if (!Number.isSafeInteger(parts) || parts < 1 || parts > 100000) throw new ConversionError('invalid-document', 'Invalid document part count.')
  if (type === 2) {
    const sizes = JSON.parse(values('.uno:AllPageSize')) as { parts?: { width: number; height: number }[] }
    if (!Array.isArray(sizes.parts) || sizes.parts.length !== parts) throw new ConversionError('invalid-document', 'Impress returned inconsistent slide dimensions.')
    return select(sizes.parts.map(({ width, height }, part) => {
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff)
        throw new ConversionError('invalid-document', 'Impress returned invalid slide dimensions.')
      return { part, x: 0, y: 0, width: width / 15, height: height / 15 }
    }))
  }
  const sheets = Array.from({ length: parts }, (_, part) => ({ part, info: sheetPartInfo(text('dsh_lok_document_part_info', [document, part])) }))
  const count = sheets.filter(({ info }) => info.visible).length
  const selected = request.sheet === undefined ? sheets.filter(({ info }) => info.visible) : sheets.filter(({ info }) => info.name === request.sheet)
  if (!selected.length) throw new ConversionError('invalid-document', 'The exact worksheet name does not exist or the workbook has no visible sheets.')
  if (selected.length > request.maxPages) throw new ConversionError('output-too-large', 'Selected worksheet count exceeds maxPages; select a sheet or raise the limit.')
  const result: ImageRegion[] = []
  const scale = request.dpi / 96
  for (const { part, info } of selected) {
    if (!call('dsh_lok_document_part', [document, part])) throw failure()
    await session.idle()
    const range = request.range === undefined ? dataArea(info) : parseCellRange(request.range)
    const rectangle = sheetRangeRectangle(JSON.parse(values('.uno:SheetGeometryData')) as SheetGeometry, range, scale)
    const page = { x: 0, y: 0, width: rectangle.x + rectangle.width, height: rectangle.y + rectangle.height, part }
    result.push({ page, rectangle, sheet: info.name, range: rangeName(range), rtl: Boolean(info.rtllayout) })
  }
  return { count, regions: result }
}
export async function renderImagesWithWasm(request: Omit<WasmConversionRequest, 'operation'> & { operation: ImageRenderSpec }): Promise<RenderImagesResult> {
  return withWasmSession(request, async (session) => {
    const { operation, options } = request
    const { count, regions: selected } = await regions(session, operation)
    const scale = operation.dpi / 96
    // Validate the complete batch before painting the first image; never truncate a selection.
    for (const { page, rectangle } of selected) {
      const { width, height } = tileDimensions({ pageIndex: 0, ...rectangle, scale }, [page])
      if (width * height > operation.maxPixels) throw new ConversionError('output-too-large', 'Selected image exceeds maxPixels; choose a smaller A1 range or DPI.')
    }
    const images: RenderedImage[] = []
    let total = 0
    for (const region of selected) {
      if (region.sheet !== undefined) {
        const call = (name: string, args: number[]) => numericCall(session.module, name, args)
        if (!call('dsh_lok_document_part', [session.document, region.page.part])) throw engineError(session.module, session.office)
        // Header geometry expands Calc's tiled area for explicit ranges beyond its initial viewport.
        const { x, y, width, height } = region.rectangle
        const command = `.uno:ViewRowColumnHeaders?x=${Math.round(x * 15)}&y=${Math.round(y * 15)}&width=${Math.round(width * 15)}&height=${Math.round(height * 15)}`
        if (!call('dsh_lok_document_viewport', [session.document, Math.round(scale * 1440), 21600,
          Math.round(x * 15), Math.round(y * 15), Math.round(width * 15), Math.round(height * 15)])) throw engineError(session.module, session.office)
        engineString(session.module, 'dsh_lok_document_command_values', ['number', 'string'], [session.document, command], () => engineError(session.module, session.office))
        await session.idle()
      }
      const tile = renderRegion(session.module, session.document, { pageIndex: 0, ...region.rectangle, scale }, [region.page], () => engineError(session.module, session.office), session.pdf)
      const png = encodePng(tile.width, tile.height, tile.rgba)
      total += png.length
      if (total > options.maxOutputBytes) throw new ConversionError('output-too-large', 'PNG batch exceeds maxOutputBytes.')
      const index = images.length + 1
      const path = join(operation.outputDir, `page-${String(index).padStart(4, '0')}.png`)
      writeFileSync(path, png, { flag: 'wx', mode: 0o600 })
      images.push({ index, ...(region.number === undefined ? {} : { page: region.number }),
        ...(region.sheet === undefined ? {} : { sheet: region.sheet, range: region.range!, rtl: region.rtl! }), path,
        width: tile.width, height: tile.height, rectangle: region.rectangle, byteLength: png.length })
    }
    return { schemaVersion: 1, backend: 'wasm', rasterEngine: session.pdf ? 'pdfium' : 'libreoffice', source: 'saved',
      inputPath: operation.inputPath, sourceSha256: createHash('sha256').update(request.bytes).digest('hex'),
      dpi: operation.dpi, pageCount: count, images, missingFonts: session.missingFonts }
  })
}
