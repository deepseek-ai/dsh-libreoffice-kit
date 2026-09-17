/** Geometry and pixel conversions between LibreOffice twips and browser ImageData. */
import { BrowserRenderError } from './types.ts'
import type { BrowserPage, BrowserTileRequest } from './types.ts'

export const TWIPS_PER_CSS_PIXEL = 15
export interface EnginePage extends BrowserPage { readonly x: number; readonly y: number; readonly part: number }

/** Parse Writer's semicolon-separated x,y,width,height rectangles in twips. */
export function writerPages(rectangles: string): EnginePage[] {
  const pages = rectangles.split(';').filter(value => value.trim()).map((rectangle) => {
    const fields = rectangle.split(',').map(value => Number(value.trim()))
    const [x, y, width, height] = fields
    if (fields.length !== 4 || x === undefined || y === undefined || width === undefined || height === undefined || fields.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff) || width <= 0 || height <= 0 || x + width > 0x7fffffff || y + height > 0x7fffffff) throw new BrowserRenderError('invalid-document', 'LibreOffice returned invalid page rectangles.')
    return { x, y, width: width / TWIPS_PER_CSS_PIXEL, height: height / TWIPS_PER_CSS_PIXEL, part: -1 }
  })
  if (pages.length === 0) throw new BrowserRenderError('invalid-document', 'LibreOffice returned no document pages.')
  return pages
}

/** Validate wire-supplied coordinates before allocation or wasm32 integer conversion. */
export function tileDimensions(request: BrowserTileRequest, pages: readonly EnginePage[]): { page: EnginePage; width: number; height: number } {
  const page = pages[request.pageIndex]
  if (!Number.isSafeInteger(request.pageIndex) || !page || ![request.x, request.y, request.width, request.height, request.scale].every(Number.isFinite)
    || request.x < 0 || request.y < 0 || request.width <= 0 || request.height <= 0 || request.scale <= 0
    || request.x + request.width > page.width + 0.001 || request.y + request.height > page.height + 0.001) throw new BrowserRenderError('render-failed', 'Tile rectangle lies outside its page.')
  const width = Math.ceil(request.width * request.scale)
  const height = Math.ceil(request.height * request.scale)
  // A tile is an allocation unit, not a full high-resolution page. This also bounds wasm32 arithmetic.
  if (width <= 0 || height <= 0 || !Number.isSafeInteger(width * height) || width * height > 16 * 1024 * 1024) throw new BrowserRenderError('render-failed', 'Tile exceeds the 16 megapixel allocation limit.')
  return { page, width, height }
}

/** Cairo/LO produces premultiplied channels; ImageData expects unassociated RGBA. */
export function rgbaPixels(source: Uint8Array, tileMode: number): Uint8ClampedArray {
  if (tileMode !== 0 && tileMode !== 1) throw new BrowserRenderError('render-failed', 'LibreOffice returned an unsupported tile pixel format.')
  const result = new Uint8ClampedArray(source.length)
  for (let index = 0; index < source.length; index += 4) {
    const alpha = source[index + 3]!
    const multiplier = alpha === 0 ? 0 : 255 / alpha
    result[index] = source[index + (tileMode === 1 ? 2 : 0)]! * multiplier
    result[index + 1] = source[index + 1]! * multiplier
    result[index + 2] = source[index + (tileMode === 1 ? 0 : 2)]! * multiplier
    result[index + 3] = alpha
  }
  return result
}
