import { expect, it } from 'vitest'
import { inflateSync } from 'node:zlib'
import { encodePng } from '../src/png.ts'
import { rgbaPixels, tileDimensions, writerPages } from '../src/rendering.ts'
import { parseCellRange, rangeName, sheetPartInfo, dataArea, sheetRangeRectangle } from '../src/sheet-geometry.ts'
import { resolveImageRender, selectedPages } from '../src/image-operations.ts'

it('encodes decodable PNG dimensions, RGBA rows and the standard IEND checksum', () => {
  const rgba = Uint8Array.from([255, 1, 2, 255, 44, 55, 66, 128, 0, 0, 0, 0, 23, 45, 67, 255])
  const png = encodePng(2, 2, rgba)
  const buffer = Buffer.from(png)
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  expect([buffer.readUInt32BE(16), buffer.readUInt32BE(20)]).toEqual([2, 2])
  const idat: Uint8Array[] = []
  for (let offset = 8; offset < png.length;) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') expect(buffer.readUInt32BE(offset + 8)).toBe(0xae426082)
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(idat))
  const decoded: number[] = []
  for (let row = 0; row < 2; row++) {
    const start = row * 9
    expect(raw[start]).toBe(1)
    for (let x = 0; x < 8; x++) decoded.push((raw[start + 1 + x]! + (x >= 4 ? decoded[row * 8 + x - 4]! : 0)) & 255)
  }
  expect(decoded).toEqual([...rgba])
  expect(() => encodePng(0, 1, rgba)).toThrow(/dimensions/)
  expect(() => encodePng(2, 3, rgba)).toThrow(/dimensions/)
})
it('normalizes premultiplied channels and ignores empty Writer parity pages', () => {
  expect([...rgbaPixels(Uint8Array.of(32, 64, 96, 128), 1)]).toEqual([191, 128, 64, 128])
  expect([...rgbaPixels(Uint8Array.of(80, 80, 80, 0), 0)]).toEqual([0, 0, 0, 0])
  expect(writerPages('0,0,150,300; 0,301,0,0; 0,302,150,300')).toHaveLength(2)
  expect(() => writerPages('0,0,10,0')).toThrow(/rectangles/)
  expect(() => tileDimensions({ pageIndex: 0, x: 9, y: 0, width: 2, height: 1, scale: 1 }, writerPages('0,0,150,150'))).toThrow(/outside/)
})
it('validates complete A1 rectangles and data-area metadata', () => {
  expect(rangeName(parseCellRange('$aa$2:$BC$30'))).toBe('AA2:BC30')
  expect(rangeName(parseCellRange('XFD1048576'))).toBe('XFD1048576:XFD1048576')
  for (const input of ['A0', 'A1:B0', 'B2:A1', 'XFE1', 'A1048577', 'Sheet1!A1', 'A:A']) expect(() => parseCellRange(input)).toThrow()
  const info = sheetPartInfo('{"name":"数据","visible":1,"rtllayout":1,"lastcolumn":3,"lastrow":5}')
  expect(rangeName(dataArea(info))).toBe('A1:D6')
  expect(() => sheetPartInfo('{"name":"a","visible":1,"rtllayout":0,"lastcolumn":99999,"lastrow":0}')).toThrow(/metadata/)
})
it('combines hidden/filtered spans and per-cell raster rounding without allocating whole worksheets', () => {
  const geometry = { columns: { sizes: '151:16383', hidden: '0:0 1 16383', filtered: '0:16383' },
    rows: { sizes: '31:1048575', hidden: '0:1048575', filtered: '0:0 1 1048575' } }
  expect(sheetRangeRectangle(geometry, parseCellRange('C3:D4'), 1.5)).toEqual({ x: 10, y: 2, width: 20, height: 4 })
  expect(() => sheetRangeRectangle(geometry, parseCellRange('B2'), 1.5)).toThrow(/hidden/)
  const invalid = { ...geometry, columns: { ...geometry.columns, sizes: '10:0' } }
  expect(() => sheetRangeRectangle(invalid, parseCellRange('A1'), 1)).toThrow(/complete/)
})
it('never conflates sheets with printed pages or truncates an all-pages request', () => {
  expect(resolveImageRender({ inputPath: '/in.pdf', outputDir: '/out', pages: [3, 1] }).pages).toEqual([3, 1])
  expect(() => resolveImageRender({ inputPath: '/in.xlsx', outputDir: '/out', pages: 'all' })).toThrow(/Worksheets/)
  expect(() => resolveImageRender({ inputPath: '/in.xlsx', outputDir: '/out', range: 'A1:B2' })).toThrow(/sheet/)
  expect(() => resolveImageRender({ inputPath: '/out/in.docx', outputDir: '/out' })).toThrow(/inside/)
  expect(() => selectedPages('all', 101, 100)).toThrow(/maxPages/)
  expect(() => selectedPages([4], 3, 100)).toThrow(/outside/)
  expect(selectedPages([3, 1], 4, 100)).toEqual([3, 1])
})
