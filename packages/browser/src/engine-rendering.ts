/** Bounded raster allocation shared by preview and editor Workers. */
import type { EmscriptenModule } from './engine-types.ts'
import type { BrowserTile, BrowserTileRequest } from './types.ts'
import { rgbaPixels, tileDimensions, TWIPS_PER_CSS_PIXEL, type EnginePage } from './rendering.ts'

/** Paint one document rectangle and release WASM memory before returning owned pixels. */
export function renderRegion(module: EmscriptenModule, document: number, request: BrowserTileRequest,
  pages: readonly EnginePage[], failure: () => Error): BrowserTile {
  const call = (name: string, args: number[]): number => module.ccall(name, 'number', args.map(() => 'number'), args)
  const { page, width, height } = tileDimensions(request, [...pages])
  const size = width * height * 4
  const pointer = call('malloc', [size])
  if (!pointer) throw failure()
  try {
    new Uint8Array(module.HEAPU32.buffer, pointer, size).fill(0)
    const position = [page.x + Math.round(request.x * TWIPS_PER_CSS_PIXEL), page.y + Math.round(request.y * TWIPS_PER_CSS_PIXEL),
      Math.max(1, Math.round(request.width * TWIPS_PER_CSS_PIXEL)), Math.max(1, Math.round(request.height * TWIPS_PER_CSS_PIXEL))]
    if (!call('dsh_lok_document_paint', [document, pointer, page.part, width, height, ...position])) throw failure()
    return { width, height, rgba: rgbaPixels(new Uint8Array(module.HEAPU32.buffer, pointer, size), call('dsh_lok_document_tile_mode', [document])) }
  } finally { call('free', [pointer]) }
}
