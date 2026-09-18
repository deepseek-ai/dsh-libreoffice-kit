/** Calc data-area and A1 coordinates shared by saved-file and retained-session capture. */
export interface CellRange { readonly firstColumn: number; readonly firstRow: number; readonly lastColumn: number; readonly lastRow: number }
export interface Rectangle { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export interface SheetPartInfo { readonly name: string; readonly visible: number; readonly rtllayout: number; readonly lastcolumn: number; readonly lastrow: number }
interface DimensionData { readonly sizes: string; readonly hidden: string; readonly filtered: string }
export interface SheetGeometry { readonly columns: DimensionData; readonly rows: DimensionData }
interface Span { end: number; value: number }
const MAX_COLUMN = 16383
const MAX_ROW = 1048575

function column(index: number): string {
  let name = ''
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) name = String.fromCharCode(65 + (value - 1) % 26) + name
  return name
}
export function rangeName(range: CellRange): string {
  return `${column(range.firstColumn)}${range.firstRow + 1}:${column(range.lastColumn)}${range.lastRow + 1}`
}
export function parseCellRange(value: string): CellRange {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/i.exec(value)
  if (!match) throw new TypeError('range must be an A1 cell or rectangle without a sheet prefix.')
  const col = (name: string): number => [...name.toUpperCase()].reduce((sum, c) => sum * 26 + c.charCodeAt(0) - 64, 0) - 1
  const firstColumn = col(match[1]!)
  const firstRow = Number(match[2]) - 1
  const lastColumn = col(match[3] ?? match[1]!)
  const lastRow = Number(match[4] ?? match[2]) - 1
  if (lastColumn < firstColumn || lastRow < firstRow || lastColumn > MAX_COLUMN || lastRow > MAX_ROW)
    throw new TypeError('range exceeds Calc worksheet bounds or has reversed endpoints.')
  return { firstColumn, firstRow, lastColumn, lastRow }
}
export function sheetPartInfo(value: string): SheetPartInfo {
  const info = JSON.parse(value) as SheetPartInfo
  if (!info || typeof info.name !== 'string' || ![0, 1].includes(info.visible) || ![0, 1].includes(info.rtllayout)
    || !Number.isInteger(info.lastcolumn) || !Number.isInteger(info.lastrow) || info.lastcolumn < 0 || info.lastrow < 0
    || info.lastcolumn > MAX_COLUMN || info.lastrow > MAX_ROW) throw new Error('LibreOffice returned invalid worksheet data-area metadata.')
  return info
}
/** Formatting-only cells and standalone drawings do not enlarge LibreOffice's data area. */
export function dataArea(info: SheetPartInfo): CellRange {
  return { firstColumn: 0, firstRow: 0, lastColumn: info.lastcolumn, lastRow: info.lastrow }
}
function spans(encoded: string, flags: boolean, maximum: number): Span[] {
  if (typeof encoded !== 'string' || encoded.length > 32 * 1024 * 1024) throw new Error('Invalid worksheet geometry span encoding.')
  const tokens = encoded.trim().split(/\s+/)
  let previous = -1
  let flag = 0
  const result = tokens.map((token, i) => {
    const fields = token.split(':')
    let value: number
    let end: number
    if (flags && i > 0) { value = flag = 1 - flag; end = Number(fields[0]); if (fields.length !== 1) throw new Error('Invalid worksheet flag span.') }
    else { value = Number(fields[0]); end = Number(fields[1]); flag = value; if (fields.length !== 2) throw new Error('Invalid worksheet size span.') }
    if (!Number.isSafeInteger(value) || value < 0 || (flags ? value > 1 : value > 65535)
      || !Number.isSafeInteger(end) || end <= previous || end > maximum) throw new Error('Invalid worksheet geometry span.')
    previous = end
    return { end, value }
  })
  if (previous !== maximum) throw new Error('Worksheet geometry does not cover the complete dimension.')
  return result
}
function dimension(data: DimensionData, first: number, last: number, maximum: number, scale: number): [number, number] {
  const sizes = spans(data?.sizes, false, maximum)
  const hidden = spans(data?.hidden, true, maximum)
  const filtered = spans(data?.filtered, true, maximum)
  let position = 0, start = 0, index = 0, si = 0, hi = 0, fi = 0
  while (index <= last) {
    const size = sizes[si]!, hide = hidden[hi]!, filter = filtered[fi]!
    const end = Math.min(size.end, hide.end, filter.end, last, index < first ? first - 1 : last)
    // ScViewData::ToPixel truncates each visible cell independently and keeps nonzero cells >=1px.
    const pixels = hide.value || filter.value || size.value === 0 ? 0 : Math.max(1, Math.floor(size.value * scale / 15))
    if (index === first) start = position
    position += (end - index + 1) * pixels
    index = end + 1
    if (index > size.end) si++
    if (index > hide.end) hi++
    if (index > filter.end) fi++
  }
  return [start / scale, (position - start) / scale]
}
/** Logical columns advance from A; LOK itself mirrors RTL sheet painting. No manual x inversion. */
export function sheetRangeRectangle(geometry: SheetGeometry, range: CellRange, scale: number): Rectangle {
  if (!Number.isFinite(scale) || scale <= 0 || scale > 16) throw new TypeError('Invalid worksheet raster scale.')
  const [x, width] = dimension(geometry.columns, range.firstColumn, range.lastColumn, MAX_COLUMN, scale)
  const [y, height] = dimension(geometry.rows, range.firstRow, range.lastRow, MAX_ROW, scale)
  if (width <= 0 || height <= 0) throw new Error('The selected worksheet range is entirely hidden or filtered.')
  if ([x, y, width, height, x + width, y + height].some(value => !Number.isFinite(value) || value * 15 > 0x7fffffff))
    throw new Error('The selected worksheet range exceeds the supported coordinate range.')
  return { x, y, width, height }
}
