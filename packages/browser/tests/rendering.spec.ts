import { describe, expect, it } from 'vitest'
import { rgbaPixels, tileDimensions, writerPages } from '../src/rendering.ts'

describe('LibreOffice page geometry', () => {
  it('preserves Writer page offsets and converts twips to CSS pixels', () => {
    expect(writerPages('284, 284, 12240, 15840; 284, 16408, 15840, 12240')).toEqual([
      { x: 284, y: 284, width: 816, height: 1056, part: -1 },
      { x: 284, y: 16408, width: 1056, height: 816, part: -1 },
    ])
    expect(() => writerPages('')).toThrow('no document pages')
    expect(() => writerPages('1,2,0,4')).toThrow('invalid page rectangles')
    expect(() => writerPages('1,2,NaN,4')).toThrow('invalid page rectangles')
    expect(() => writerPages('2147483647,2,10,4')).toThrow('invalid page rectangles')
    expect(() => writerPages('1,2147483647,10,4')).toThrow('invalid page rectangles')
  })
  it('omits zero-area section parity frames while retaining content offsets and ordinary blank pages', () => {
    const pages = writerPages('284,284,12240,15840; 12524,284,0,0; 284,16408,12240,15840')
    expect(pages).toEqual([
      { x: 284, y: 284, width: 816, height: 1056, part: -1 },
      { x: 284, y: 16408, width: 816, height: 1056, part: -1 },
    ])
    expect(tileDimensions({ pageIndex: 1, x: 0, y: 0, width: 100, height: 100, scale: 1 }, pages).page.y).toBe(16408)
    expect(writerPages('284,284,12240,15840;284,16408,12240,15840;284,32532,12240,15840')).toHaveLength(3)
  })
  it('rejects malformed zero-area frames and documents without a visible page', () => {
    expect(() => writerPages('284,284,0,0')).toThrow('no document pages')
    for (const rectangle of ['1,2,0,4', '1,2,4,0', '-1,2,0,0', '1,NaN,0,0', '2147483648,2,0,0']) {
      expect(() => writerPages(`284,284,12240,15840;${rectangle}`)).toThrow('invalid page rectangles')
    }
  })
  it('bounds page coordinates and allocation before calling wasm32', () => {
    const pages = writerPages('0,0,12240,15840')
    const request = { pageIndex: 0, x: 32, y: 64, width: 100.2, height: 90.1, scale: 2 }
    expect(tileDimensions(request, pages)).toMatchObject({ width: 201, height: 181 })
    for (const change of [{ pageIndex: -1 }, { x: -1 }, { x: 810 }, { scale: Infinity }, { scale: 1000 }, { width: Number.MIN_VALUE, scale: Number.MIN_VALUE }]) expect(() => tileDimensions({ ...request, ...change }, pages)).toThrow()
  })
})

describe('browser pixels', () => {
  it('converts BGRA to unassociated RGBA, including transparent pixels', () => {
    expect([...rgbaPixels(new Uint8Array([16, 32, 64, 128, 0, 0, 0, 0, 50, 100, 150, 255]), 1)])
      .toEqual([128, 64, 32, 128, 0, 0, 0, 0, 150, 100, 50, 255])
    expect([...rgbaPixels(new Uint8Array([1, 2, 3, 255]), 0)]).toEqual([1, 2, 3, 255])
    expect(() => rgbaPixels(new Uint8Array(4), 2)).toThrow('unsupported tile pixel format')
  })
})
