/** Shared bounded raster allocations for browser and Node engine owners. */
import { rgbaPixels, tileDimensions, TWIPS_PER_CSS_PIXEL, type EnginePage, type RasterTile, type TileRequest } from './rendering.ts'
export interface RasterModule {
  readonly HEAPU32: Uint32Array
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): number
  UTF8ToString(pointer: number): string
}
export function numericCall(module: RasterModule, name: string, args: number[]): number {
  return module.ccall(name, 'number', args.map(() => 'number'), args)
}
/** Copy/free one engine-owned UTF-8 return value. */
export function engineString(module: RasterModule, name: string, types: string[], args: unknown[], failure: () => Error): string {
  const pointer = module.ccall(name, 'number', types, args)
  if (!pointer) throw failure()
  try { return module.UTF8ToString(pointer) } finally { numericCall(module, 'free', [pointer]) }
}
/** Paint into a temporary allocation; copy pixels before free or another engine call. */
export function renderRegion(module: RasterModule, document: number, request: TileRequest,
  pages: readonly EnginePage[], failure: () => Error, pdf = false): RasterTile {
  const call = (name: string, args: number[]): number => numericCall(module, name, args)
  const { page, width, height } = tileDimensions(request, pages)
  const size = width * height * 4
  const pointer = call('malloc', [size])
  if (!pointer) throw failure()
  try {
    new Uint8Array(module.HEAPU32.buffer, pointer, size).fill(0)
    const position = [page.x + Math.round(request.x * TWIPS_PER_CSS_PIXEL), page.y + Math.round(request.y * TWIPS_PER_CSS_PIXEL),
      Math.max(1, Math.round(request.width * TWIPS_PER_CSS_PIXEL)), Math.max(1, Math.round(request.height * TWIPS_PER_CSS_PIXEL))]
    if (!call(pdf ? 'dsh_pdf_paint' : 'dsh_lok_document_paint', [document, pointer, page.part, width, height, ...position])) throw failure()
    const source = new Uint8Array(module.HEAPU32.buffer, pointer, size)
    const rgba = pdf ? new Uint8ClampedArray(source) : rgbaPixels(source, call('dsh_lok_document_tile_mode', [document]))
    return { width, height, rgba }
  } finally { call('free', [pointer]) }
}
/** PDF page dimensions use the same twips ABI, with an immutable PDF page index as part. */
export function pdfPages(module: RasterModule, pdf: number, failure: () => Error): EnginePage[] {
  const count = numericCall(module, 'dsh_pdf_page_count', [pdf])
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000) throw failure()
  const pointer = numericCall(module, 'malloc', [8])
  if (!pointer) throw failure()
  try {
    return Array.from({ length: count }, (_, part) => {
      if (!numericCall(module, 'dsh_pdf_page_size', [pdf, part, pointer, pointer + 4])) throw failure()
      const width = module.HEAPU32[pointer / 4]!
      const height = module.HEAPU32[pointer / 4 + 1]!
      if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) throw failure()
      return { part, x: 0, y: 0, width: width / 15, height: height / 15 }
    })
  } finally { numericCall(module, 'free', [pointer]) }
}
