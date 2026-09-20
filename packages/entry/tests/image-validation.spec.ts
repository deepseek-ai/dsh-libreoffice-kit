import { expect, it } from 'vitest'
import { resolveImageRender, selectedPages, type RenderImagesRequest } from '../src/image-operations.ts'
import { rgbaPixels, splitRasterRectangle, tileDimensions, writerPages } from '../src/rendering.ts'
import { parseCellRange, sheetRangeRectangle, type SheetGeometry } from '../src/sheet-geometry.ts'

it('rejects malformed image paths, format selections, and unbounded batches before opening files', () => {
  const base = { inputPath: '/in.pdf', outputDir: '/out' }
  for (const request of [null, { ...base, inputPath: 'relative.pdf' }, { ...base, outputDir: 'relative' },
    { ...base, inputPath: '/bad\0.pdf' }, { ...base, outputDir: '/bad\0' }])
    expect(() => resolveImageRender(request as RenderImagesRequest)).toThrow(/absolute filesystem/)
  expect(() => resolveImageRender({ ...base, inputPath: '/in.txt' })).toThrow(/Unsupported image input/)
  for (const selector of [{ sheet: 'Sheet1' }, { range: 'A1' }])
    expect(() => resolveImageRender({ ...base, ...selector })).toThrow(/only to worksheets/)
  for (const sheet of ['', ' ', 'bad\0name', 2])
    expect(() => resolveImageRender({ ...base, inputPath: '/in.xlsx', sheet } as RenderImagesRequest)).toThrow(/nonempty exact/)
  for (const pages of [[], [0], [1.5], [1, 1], '1'])
    expect(() => resolveImageRender({ ...base, pages } as RenderImagesRequest)).toThrow(/distinct positive/)
  for (const dpi of [23, 601, NaN]) expect(() => resolveImageRender({ ...base, dpi })).toThrow(/dpi/)
  for (const maxPages of [0, 10001, 1.5]) expect(() => resolveImageRender({ ...base, maxPages })).toThrow(/maxPages/)
  for (const maxPixels of [0, 16777217, 1.5]) expect(() => resolveImageRender({ ...base, maxPixels })).toThrow(/maxPixels/)
  expect(() => resolveImageRender({ ...base, pages: [2, 1], maxPages: 1 })).toThrow(/maxPages/)
  for (const count of [0, NaN, 1.5]) expect(() => selectedPages('all', count, 100)).toThrow(/no renderable pages/)
})
it('bounds raster allocation and source coordinates before calling the engine', () => {
  const rectangle = { x: 0, y: 0, width: 10, height: 10 }
  const limits = { maxPixels: 100, maxDimension: 8192, maxTiles: 100 }
  expect(() => splitRasterRectangle(rectangle, 0, limits)).toThrow(/Invalid raster/)
  expect(() => splitRasterRectangle({ ...rectangle, width: 1e30 }, 1, limits)).toThrow(/coordinate range/)
  const thin = splitRasterRectangle({ ...rectangle, width: 2, height: 1000 }, 1, { ...limits, maxTiles: 20 })
  expect(thin).toHaveLength(20)
  expect(thin.every(tile => tile.width === 2 && tile.height === 50)).toBe(true)
  expect(() => writerPages('0,0,0,0')).toThrow(/no document pages/)
  const page = { x: 0, y: 0, width: 1e10, height: 1e10, part: 0 }
  expect(() => tileDimensions({ pageIndex: 0, ...rectangle, width: 5000, height: 5000, scale: 1 }, [page])).toThrow(/allocation limit/)
  expect(() => tileDimensions({ pageIndex: 0, ...rectangle, x: 1e9, scale: 1 }, [page])).toThrow(/wasm32 range/)
  expect(() => rgbaPixels(new Uint8Array(4), 2)).toThrow(/unsupported tile pixel format/)
})
it('rejects malformed Calc geometry and bounds full-sheet source coordinates', () => {
  const geometry: SheetGeometry = { columns: { sizes: '150:0 300:16383', hidden: '0:16383', filtered: '0:16383' },
    rows: { sizes: '150:1048575', hidden: '0:1048575', filtered: '0:1048575' } }
  expect(sheetRangeRectangle(geometry, parseCellRange('A1:C1'), 1)).toEqual({ x: 0, y: 0, width: 50, height: 10 })
  for (const fields of [{ sizes: undefined }, { sizes: '150' }, { hidden: '0:0 1:16383' }, { sizes: '-1:16383' }])
    expect(() => sheetRangeRectangle({ ...geometry, columns: { ...geometry.columns, ...fields } } as SheetGeometry, parseCellRange('A1'), 1)).toThrow(/Invalid worksheet/)
  expect(() => sheetRangeRectangle(geometry, parseCellRange('A1'), 0)).toThrow(/raster scale/)
  expect(() => sheetRangeRectangle({ ...geometry, rows: { ...geometry.rows, sizes: '65535:1048575' } }, parseCellRange('A1:A1048576'), 1)).toThrow(/coordinate range/)
})
