import { expect, it, vi } from 'vitest'
import { createFontReader, fontFrames, fontViews } from '../src/font-channel.ts'
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES } from '../src/protocol.ts'
import type { BrowserFontRequest, BrowserFontResult } from '../src/types.ts'

const attributes: BrowserFontRequest = { family: 'Test Sans', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [], mode: 'full' }
const data = new Uint8Array([1, 2, 3])

function channel(response: (input: BrowserFontRequest) => BrowserFontResult) {
  const shared = new SharedArrayBuffer(FONT_HEADER_BYTES + FONT_CHUNK_BYTES)
  const { control, bytes } = fontViews(shared)
  let frames: ReturnType<typeof fontFrames>
  const install = vi.fn()
  const pump = (): void => {
    const next = frames.next()
    if (next.done) return
    bytes.set(next.value.bytes)
    Atomics.store(control, 1, next.value.bytes.length)
    Atomics.store(control, 0, next.value.state)
  }
  const request = vi.fn((input: BrowserFontRequest) => { frames = fontFrames(response(input)); pump() })
  const read = createFontReader(shared, 10, data.length, new Map(), request, pump, install, vi.fn())
  return { read, install, request }
}

it('mounts a shared full TTC once while retaining each requested face family', () => {
  const exchange = channel(input => ({ fonts: [{ id: 'shared-collection', data, family: input.family, alias: input.family, format: 'ttc' }] }))
  const sans = exchange.read(attributes)
  const serif = exchange.read({ ...attributes, family: 'Test Serif' })
  expect(sans).toEqual([{ path: '/usr/share/fonts/dsh-pdfium/0.ttc', family: 'Test Sans' }])
  expect(serif).toEqual([{ path: '/usr/share/fonts/dsh-pdfium/0.ttc', family: 'Test Serif' }])
  expect(exchange.read({ ...attributes, codePoints: [0x4e2d] })).toEqual(sans)
  expect(exchange.read({ ...attributes, family: 'Test Serif' })).toBe(serif)
  expect(exchange.install.mock.calls).toEqual([['/usr/share/fonts/dsh-pdfium/0.ttc', data]])
  expect(exchange.request).toHaveBeenCalledTimes(3)
})

it.each([{ id: 'same', alias: 'Other' }, { id: 'other', alias: 'Subset' }])(
  'retains immutable subset identity and alias checks for %j', change => {
    const exchange = channel(input => ({ fonts: [{ id: 'same', alias: 'Subset', family: 'Test Sans', data,
      ...(input.codePoints.length ? change : {}) }] }))
    const first = exchange.read({ ...attributes, mode: 'subset' })
    expect(() => exchange.read({ ...attributes, mode: 'subset', codePoints: [0x4e2d] })).toThrow(/conflicting/)
    expect(first).toEqual([{ path: '/dsh-fonts/0.font', family: 'Subset' }])
    expect(exchange.install).toHaveBeenCalledExactlyOnceWith('/dsh-fonts/0.font', data)
  })

it.each([[undefined, 'ttc'], ['ttc', undefined], ['ttc', 'ttf']] as const)(
  'rejects the same asset identity switching from %s to %s', (initial, changed) => {
    const exchange = channel(input => {
      const format = input.codePoints.length ? changed : initial
      return { fonts: [{ id: 'same', alias: 'Test Sans', family: 'Test Sans', data, ...(format ? { format } : {}) }] }
    })
    exchange.read({ ...attributes, mode: initial ? 'full' : 'subset' })
    expect(() => exchange.read({ ...attributes, mode: changed ? 'full' : 'subset', codePoints: [0x4e2d] })).toThrow(/conflicting/)
    expect(exchange.install).toHaveBeenCalledTimes(1)
  })

it('rejects an unsupported full-font format before mounting its bytes', () => {
  const exchange = channel(() => ({ fonts: [{ id: 'bad', data, family: 'Test Sans', alias: 'Test Sans', format: 'woff' as never }] }))
  expect(() => exchange.read(attributes)).toThrow('Invalid full font format.')
  expect(exchange.install).not.toHaveBeenCalled()
})
