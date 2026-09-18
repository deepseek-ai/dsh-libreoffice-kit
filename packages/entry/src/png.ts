/** Portable PNG encoding over straight RGBA; browser and Node need no native image dependency. */
import { zlibSync } from 'fflate'
import { MAX_TILE_PIXELS } from './rendering.ts'
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function chunk(type: string, bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(bytes.length + 12)
  const view = new DataView(output.buffer)
  view.setUint32(0, bytes.length)
  output.set(new TextEncoder().encode(type), 4)
  output.set(bytes, 8)
  let crc = 0xffffffff
  for (let i = 4; i < output.length - 4; i++) crc = crcTable[(crc ^ output[i]!) & 255]! ^ (crc >>> 8)
  view.setUint32(output.length - 4, (crc ^ 0xffffffff) >>> 0)
  return output
}
export function encodePng(width: number, height: number, rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || width * height > MAX_TILE_PIXELS || rgba.byteLength !== width * height * 4) throw new TypeError('Invalid PNG raster dimensions.')
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width); view.setUint32(4, height); header[8] = 8; header[9] = 6
  // A Sub filter compresses tiled document backgrounds and text well without unbounded search.
  const scanlines = new Uint8Array(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const source = y * width * 4
    const target = y * (width * 4 + 1)
    scanlines[target] = 1
    for (let x = 0; x < width * 4; x++) scanlines[target + 1 + x] = rgba[source + x]! - (x < 4 ? 0 : rgba[source + x - 4]!)
  }
  const chunks = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlibSync(scanlines, { level: 6 })), chunk('IEND', new Uint8Array())]
  const result = new Uint8Array(chunks.reduce((sum, value) => sum + value.length, 0))
  let offset = 0
  for (const value of chunks) { result.set(value, offset); offset += value.length }
  return result
}
