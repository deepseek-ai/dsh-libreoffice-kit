import { expect, it, vi } from 'vitest'
import { createFontReader, fontFrames, fontViews } from '../src/font-channel.ts'
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES, FontState } from '../src/protocol.ts'
import type { FontIdentity } from '../src/protocol.ts'
import type { BrowserFontRequest, BrowserFontResult } from '../src/types.ts'

const defaultAttributes: BrowserFontRequest = { family: 'Test Sans', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] }
const attributes: BrowserFontRequest = { ...defaultAttributes, mode: 'full' }
const data = new Uint8Array([1, 2, 3])

function channel(response: (input: BrowserFontRequest) => BrowserFontResult, limit = data.length) {
  const shared = new SharedArrayBuffer(FONT_HEADER_BYTES + FONT_CHUNK_BYTES)
  const { control, bytes } = fontViews(shared)
  let frames: ReturnType<typeof fontFrames>
  const transfers: { state: FontState; bytes: Uint8Array }[][] = []
  const install = vi.fn()
  const pump = (): void => {
    const next = frames.next()
    if (next.done) return
    transfers.at(-1)!.push(next.value)
    bytes.set(next.value.bytes)
    Atomics.store(control, 1, next.value.bytes.length)
    Atomics.store(control, 0, next.value.state)
  }
  const request = vi.fn((input: BrowserFontRequest, known: readonly FontIdentity[]) => {
    transfers.push([])
    frames = fontFrames(response(input), known)
    pump()
  })
  const read = createFontReader(shared, 10, limit, new Map(), request, pump, install, vi.fn())
  return { read, install, request, transfers }
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
  expect(exchange.request.mock.calls.map(([, known]) => known)).toEqual([[],
    [{ id: 'shared-collection', bytes: data.length, format: 'ttc' }],
    [{ id: 'shared-collection', bytes: data.length, format: 'ttc' }]])
  expect(exchange.transfers.map(frames => frames.map(frame => frame.state))).toEqual([
    [FontState.Header, FontState.Bytes, FontState.Done], [FontState.Header, FontState.Done], [FontState.Header, FontState.Done],
  ])
})

it('transfers one TTC body for several face aliases in the same response under one-file byte limits', () => {
  const exchange = channel(() => ({ fonts: ['Test Sans', 'Test Serif', 'Test Mono'].map(family => ({
    id: 'shared-collection', data, family, alias: family, format: 'ttc' as const,
  })) }))
  expect(exchange.read(attributes)).toEqual(['Test Sans', 'Test Serif', 'Test Mono'].map(family => ({
    path: '/usr/share/fonts/dsh-pdfium/0.ttc', family,
  })))
  expect(exchange.install).toHaveBeenCalledExactlyOnceWith('/usr/share/fonts/dsh-pdfium/0.ttc', data)
  const frames = exchange.transfers[0]!
  expect(frames.map(frame => frame.state)).toEqual([FontState.Header, FontState.Bytes, FontState.Done])
  expect(JSON.parse(new TextDecoder().decode(frames[0]!.bytes))).toEqual({ fonts: [
    { id: 'shared-collection', bytes: data.length, family: 'Test Sans', alias: 'Test Sans', format: 'ttc' },
    { id: 'shared-collection', bytes: data.length, family: 'Test Serif', alias: 'Test Serif', format: 'ttc', reference: true },
    { id: 'shared-collection', bytes: data.length, family: 'Test Mono', alias: 'Test Mono', format: 'ttc', reference: true },
  ] })
})

it('accepts matching metadata-only references and rejects unknown references', () => {
  const exchange = channel(input => input.codePoints.length === 0
    ? { fonts: [{ id: 'shared', data, family: input.family, alias: input.family, format: 'ttc' }] }
    : { fonts: [{ id: 'shared', bytes: data.length, family: input.family, alias: input.family, format: 'ttc' }] })
  exchange.read(attributes)
  expect(exchange.read({ ...attributes, family: 'Second', codePoints: [0x41] }))
    .toEqual([{ path: '/usr/share/fonts/dsh-pdfium/0.ttc', family: 'Second' }])
  expect(exchange.transfers.map(frames => frames.map(frame => frame.state))).toEqual([
    [FontState.Header, FontState.Bytes, FontState.Done], [FontState.Header, FontState.Done],
  ])
  expect(() => [...fontFrames({ fonts: [{ id: 'unknown', bytes: 4, family: 'Test', alias: 'Test' }] })])
    .toThrow('not been installed')
})

it('combines prior results when they cover a later request with the same attributes', () => {
  const latin = { id: 'latin', data, family: 'Test Sans', alias: 'Latin' }
  const greek = { id: 'greek', data: Uint8Array.of(4, 5), family: 'Test Sans', alias: 'Greek' }
  const exchange = channel(input => ({ fonts: input.codePoints.includes(0x3a9) ? [greek] : [latin] }), 5)
  exchange.read({ ...defaultAttributes, codePoints: [0x41] })
  exchange.read({ ...defaultAttributes, codePoints: [0x3a9] })
  expect(exchange.read({ ...defaultAttributes, codePoints: [0x3a9, 0x41, 0x41] })).toEqual([
    { path: '/dsh-fonts/0.font', family: 'Latin' }, { path: '/dsh-fonts/1.font', family: 'Greek' },
  ])
  expect(exchange.request).toHaveBeenCalledTimes(2)
})

it('reuses a complete-font fallback for later code points', () => {
  const exchange = channel(() => ({ fonts: [{ id: 'full', data, family: 'Test Sans', alias: 'Test Sans', format: 'ttf' }] }))
  const first = exchange.read({ ...defaultAttributes, codePoints: [0x41] })
  expect(exchange.read({ ...defaultAttributes, codePoints: [0x3a9] })).toEqual(first)
  expect(exchange.request).toHaveBeenCalledOnce()
})

it.each([{ id: 'same', alias: 'Other' }, { id: 'other', alias: 'Subset' }])(
  'retains immutable subset identity and alias checks for %j', change => {
    const exchange = channel(input => ({ fonts: [{ id: 'same', alias: 'Subset', family: 'Test Sans', data,
      ...(input.codePoints.length ? change : {}) }] }))
    const first = exchange.read(defaultAttributes)
    expect(() => exchange.read({ ...defaultAttributes, codePoints: [0x4e2d] })).toThrow(/conflicting/)
    expect(first).toEqual([{ path: '/dsh-fonts/0.font', family: 'Subset' }])
    expect(exchange.install).toHaveBeenCalledExactlyOnceWith('/dsh-fonts/0.font', data)
  })

it.each([[undefined, 'ttc'], ['ttc', undefined], ['ttc', 'ttf']] as const)(
  'rejects the same asset identity switching from %s to %s', (initial, changed) => {
    const exchange = channel(input => {
      const format = input.codePoints.length ? changed : initial
      return { fonts: [{ id: 'same', alias: 'Test Sans', family: 'Test Sans', data, ...(format ? { format } : {}) }] }
    })
    exchange.read(initial ? attributes : defaultAttributes)
    expect(() => exchange.read({ ...(changed ? attributes : defaultAttributes), codePoints: [0x4e2d] })).toThrow(/conflicting/)
    expect(exchange.install).toHaveBeenCalledTimes(1)
  })

it('rejects an unsupported full-font format before mounting its bytes', () => {
  const exchange = channel(() => ({ fonts: [{ id: 'bad', data, family: 'Test Sans', alias: 'Test Sans', format: 'woff' as never }] }))
  expect(() => exchange.read(attributes)).toThrow('Invalid full font format.')
  expect(exchange.install).not.toHaveBeenCalled()
})
