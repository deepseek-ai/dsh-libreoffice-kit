/** Platform-independent document geometry and raster pixel conversion. */
import type { Rectangle } from './sheet-geometry.ts'
export const TWIPS_PER_CSS_PIXEL = 15
export const MAX_TILE_PIXELS = 16 * 1024 * 1024
export interface EnginePage { readonly width: number; readonly height: number; readonly x: number; readonly y: number; readonly part: number }
export interface TileRequest { readonly pageIndex: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly scale: number }
export interface RasterTile { readonly width: number; readonly height: number; readonly rgba: Uint8ClampedArray }

/** Split a region on its output-pixel grid, bounding the plan before allocating it. */
export function splitRasterRectangle(rectangle: Rectangle, scale: number,
  limits: { readonly maxPixels: number; readonly maxDimension: number; readonly maxTiles: number }): Rectangle[] {
  const { x, y, width, height } = rectangle
  const { maxPixels, maxDimension, maxTiles } = limits
  if (![x, y, width, height, scale].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || scale <= 0
    || !Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > MAX_TILE_PIXELS
    || !Number.isSafeInteger(maxDimension) || maxDimension < 1 || maxDimension > MAX_TILE_PIXELS
    || !Number.isSafeInteger(maxTiles) || maxTiles < 0) throw new TypeError('Invalid raster splitting limits or rectangle.')
  const pixelWidth = Math.ceil(width * scale - 1e-9), pixelHeight = Math.ceil(height * scale - 1e-9)
  if (![pixelWidth, pixelHeight].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Raster dimensions exceed the coordinate range.')
  let tileWidth = Math.min(pixelWidth, maxDimension), tileHeight = Math.min(pixelHeight, maxDimension)
  if (tileWidth * tileHeight > maxPixels) {
    const side = Math.floor(Math.sqrt(maxPixels))
    if (tileWidth <= side) tileHeight = Math.floor(maxPixels / tileWidth)
    else if (tileHeight <= side) tileWidth = Math.floor(maxPixels / tileHeight)
    else { tileWidth = side; tileHeight = Math.min(tileHeight, Math.floor(maxPixels / tileWidth)) }
  }
  const columns = Math.ceil(pixelWidth / tileWidth), rows = Math.ceil(pixelHeight / tileHeight)
  if (columns * rows > maxTiles) throw new RangeError('Raster batch exceeds maxPages after worksheet splitting.')
  const result: Rectangle[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const left = column * tileWidth / scale, top = row * tileHeight / scale
      result.push({ x: x + left, y: y + top, width: Math.min(tileWidth / scale, width - left), height: Math.min(tileHeight / scale, height - top) })
    }
  }
  return result
}

/** Writer's zero-area parity placeholders have no visible page. Offsets stay in twips. */
export function writerPages(rectangles: string): EnginePage[] {
  const pages = rectangles.split(';').filter(value => value.trim()).flatMap<EnginePage>((rectangle) => {
    const fields = rectangle.split(',').map(value => Number(value.trim()))
    const [x, y, width, height] = fields
    if (fields.length !== 4 || x === undefined || y === undefined || width === undefined || height === undefined
      || fields.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
      || (width === 0) !== (height === 0) || x + width > 0x7fffffff || y + height > 0x7fffffff)
      throw new Error('LibreOffice returned invalid page rectangles.')
    return width === 0 ? [] : [{ x, y, width: width / TWIPS_PER_CSS_PIXEL, height: height / TWIPS_PER_CSS_PIXEL, part: -1 }]
  })
  if (pages.length === 0) throw new Error('LibreOffice returned no document pages.')
  return pages
}

/** Validate coordinates before allocation or wasm32 integer conversion. */
export function tileDimensions(request: TileRequest, pages: readonly EnginePage[]): { page: EnginePage; width: number; height: number } {
  const page = pages[request.pageIndex]
  if (!Number.isSafeInteger(request.pageIndex) || !page || ![request.x, request.y, request.width, request.height, request.scale].every(Number.isFinite)
    || request.x < 0 || request.y < 0 || request.width <= 0 || request.height <= 0 || request.scale <= 0
    || request.x + request.width > page.width + 0.001 || request.y + request.height > page.height + 0.001)
    throw new Error('Tile rectangle lies outside its page.')
  const width = Math.ceil(request.width * request.scale - 1e-9)
  const height = Math.ceil(request.height * request.scale - 1e-9)
  if (width <= 0 || height <= 0 || !Number.isSafeInteger(width * height) || width * height > MAX_TILE_PIXELS)
    throw new Error('Tile exceeds the 16 megapixel allocation limit.')
  const twips = [page.x + Math.round(request.x * 15), page.y + Math.round(request.y * 15), Math.round(request.width * 15), Math.round(request.height * 15)]
  if (twips.some(value => !Number.isSafeInteger(value) || value < 0 || value > 0x7fffffff)
    || twips[0]! + twips[2]! > 0x7fffffff || twips[1]! + twips[3]! > 0x7fffffff)
    throw new Error('Tile coordinates exceed the wasm32 range.')
  return { page, width, height }
}

/** Cairo/LO channels are premultiplied; PNG and ImageData require straight RGBA. */
export function rgbaPixels(source: Uint8Array, tileMode: number): Uint8ClampedArray {
  if ((tileMode !== 0 && tileMode !== 1) || source.length % 4 !== 0) throw new Error('LibreOffice returned an unsupported tile pixel format.')
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
