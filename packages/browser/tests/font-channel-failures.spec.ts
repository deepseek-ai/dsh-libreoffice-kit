import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFontReader, fontFrames, fontViews } from '../src/font-channel.ts'
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES, FontState } from '../src/protocol.ts'
import type { FontIdentity } from '../src/protocol.ts'
import type { BrowserFontRequest, BrowserFontResult } from '../src/types.ts'

const attributes: BrowserFontRequest = { family: 'Test', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] }
const face = { id: 'latin', data: new Uint8Array([1, 2, 3]), family: 'Test', alias: 'DSH_latin' }
type Frame = { state: FontState; bytes: Uint8Array; length?: number }
const frame = (state: FontState, value: unknown): Frame => ({ state, bytes: new TextEncoder().encode(JSON.stringify(value)) })

function connection(response: (request: BrowserFontRequest, known: readonly FontIdentity[]) => Iterable<Frame>, limit = 64, declared = new Map([['test', 'Source Test']])) {
  const channel = new SharedArrayBuffer(FONT_HEADER_BYTES + FONT_CHUNK_BYTES)
  const { control, bytes } = fontViews(channel)
  let frames: Iterator<Frame>
  const installed = vi.fn()
  const missing = vi.fn()
  const pump = (): void => {
    const next = frames.next()
    if (next.done) return
    bytes.set(next.value.bytes)
    Atomics.store(control, 1, next.value.length ?? next.value.bytes.length)
    Atomics.store(control, 0, next.value.state)
  }
  const request = vi.fn((input: BrowserFontRequest, known: readonly FontIdentity[]) => { frames = response(input, known)[Symbol.iterator](); pump() })
  const read = createFontReader(channel, 1, limit, declared, request, pump, installed, missing)
  return { read, request, installed, missing, control }
}
afterEach(() => vi.restoreAllMocks())

describe('font transfer validation and document diagnostics', () => {
  it('installs immutable bytes once, caches requests and resolves a later alias to its source family', () => {
    const exchange = connection(input => fontFrames({ fonts: [face, face], missingFamily: input.codePoints.length ? 'TEST' : 'test' }))
    const first = exchange.read(attributes)
    expect(exchange.read(attributes)).toBe(first)
    expect(exchange.read({ ...attributes, family: 'DSH_latin', codePoints: [0x62] })).toEqual(first)
    expect(exchange.request.mock.calls[1]![0].family).toBe('Test')
    expect(exchange.installed.mock.calls).toEqual([['/dsh-fonts/0.font', face.data]])
    expect(exchange.missing.mock.calls).toEqual([[['Source Test']]])
  })
  it('installs full regular and bold faces under their original shared family for PDFium', () => {
    const regular = { ...face, id: 'regular', alias: 'Test', format: 'ttf' as const }
    const bold = { ...regular, id: 'bold', data: new Uint8Array([4, 5, 6]) }
    const exchange = connection(input => fontFrames({ fonts: [input.weight > 5 ? bold : regular] }))
    expect(exchange.read({ ...attributes, mode: 'full' })).toEqual([{ path: '/usr/share/fonts/dsh-pdfium/0.ttf', family: 'Test' }])
    expect(exchange.read({ ...attributes, mode: 'full', weight: 8 })).toEqual([{ path: '/usr/share/fonts/dsh-pdfium/1.ttf', family: 'Test' }])
    expect(exchange.read({ ...attributes, mode: 'full', codePoints: [0x62] })).toEqual([{ path: '/usr/share/fonts/dsh-pdfium/0.ttf', family: 'Test' }])
    expect(exchange.installed).toHaveBeenCalledTimes(2)
    expect(exchange.request.mock.calls[0]?.[0]).toMatchObject({ mode: 'full' })
  })
  it('suppresses bootstrap families and binary-document diagnostics while retaining source-declared failures', () => {
    const response = (missingFamily: string): BrowserFontResult => ({ fonts: [face], missingFamily })
    const bootstrap = connection(() => fontFrames(response('Liberation Sans')))
    bootstrap.read(attributes)
    expect(bootstrap.missing).not.toHaveBeenCalled()
    const binary = connection(() => fontFrames(response('Test')), 64, new Map())
    binary.read(attributes)
    expect(binary.missing).not.toHaveBeenCalled()
    const declared = connection(() => fontFrames(response('Test')))
    declared.read(attributes)
    expect(declared.missing).toHaveBeenCalledWith(['Source Test'])
  })
  it('rejects oversized metadata before publishing it', () => {
    expect(() => [...fontFrames({ fonts: [{ ...face, family: 'x'.repeat(FONT_CHUNK_BYTES) }] })]).toThrow('metadata exceeds')
  })
  it.each([null, {}, { fonts: [] }, { fonts: 'wrong' }, 'wrong'])('rejects invalid transfer metadata %j', header => {
    const exchange = connection(() => [frame(FontState.Header, header)])
    expect(() => exchange.read(attributes)).toThrow('Host has no usable fonts')
  })
  it('categorizes invalid JSON, remote failures and an unexpected first frame as font failures', () => {
    for (const frames of [
      [{ state: FontState.Header, bytes: new TextEncoder().encode('{') }],
      [{ state: FontState.Error, bytes: new TextEncoder().encode('Host offline') }],
      [frame(FontState.Done, '')],
    ]) expect(() => connection(() => frames).read(attributes)).toThrow(expect.objectContaining({ code: 'font-unavailable' }))
  })
  it.each([-1, FONT_CHUNK_BYTES + 1])('rejects an out-of-range shared frame length %s', length => {
    expect(() => connection(() => [{ state: FontState.Header, bytes: new Uint8Array(), length }]).read(attributes)).toThrow('transfer length')
  })
  it.each([
    { id: 1 }, { family: 1 }, { family: '' }, { alias: 1 }, { alias: '' }, { alias: 'bad\tname' }, { bytes: 1.5 }, { bytes: 0 },
    { reference: false }, { reference: 0 }, { reference: 1 }, { reference: 'true' }, { reference: null }, { reference: {} },
  ])('rejects malformed font descriptors %j', change => {
    expect(() => connection(() => [frame(FontState.Header, { fonts: [{ id: face.id, family: face.family, alias: face.alias, bytes: 3, ...change }] })]).read(attributes)).toThrow('descriptor')
  })
  it('rejects inconsistent immutable identities and aliases without replacing an installed font', () => {
    for (const change of [{ alias: 'other' }, { id: 'other' }, { family: 'other' }]) {
      const exchange = connection(input => fontFrames({ fonts: [{ ...face, ...(input.codePoints.length ? change : {}) }] }))
      exchange.read(attributes)
      expect(() => exchange.read({ ...attributes, codePoints: [0x62] })).toThrow(/conflicting/)
      expect(exchange.installed).toHaveBeenCalledTimes(1)
    }
  })
  it('rejects references to a font that has never been installed', () => {
    const exchange = connection(() => [frame(FontState.Header, { fonts: [{ id: face.id, family: face.family,
      alias: face.alias, bytes: face.data.length, reference: true }] }), { state: FontState.Done, bytes: new Uint8Array() }])
    expect(() => exchange.read(attributes)).toThrow(expect.objectContaining({ code: 'font-unavailable' }))
    expect(exchange.request.mock.calls[0]?.[1]).toEqual([])
    expect(exchange.installed).not.toHaveBeenCalled()
  })
  it.each([{ bytes: 4 }, { format: 'ttf' }, { format: undefined }])(
    'rejects a known font reference with conflicting immutable metadata %j', change => {
      const full = { ...face, alias: 'Test', format: 'ttc' as const }
      const exchange = connection((input, known) => input.codePoints.length
        ? [frame(FontState.Header, { fonts: [{ id: full.id, family: full.family, alias: full.alias,
          bytes: full.data.length, format: full.format, reference: true, ...change }] }), { state: FontState.Done, bytes: new Uint8Array() }]
        : fontFrames({ fonts: [full] }, known))
      exchange.read({ ...attributes, mode: 'full' })
      expect(() => exchange.read({ ...attributes, mode: 'full', codePoints: [0x62] })).toThrow(/conflicting/)
      expect(exchange.request.mock.calls[1]?.[1]).toEqual([{ id: full.id, bytes: full.data.length, format: 'ttc' }])
      expect(exchange.installed).toHaveBeenCalledExactlyOnceWith('/usr/share/fonts/dsh-pdfium/0.ttc', full.data)
    })
  it('does not register or charge a font whose filesystem installation throws', () => {
    const exchange = connection((_input, known) => fontFrames({ fonts: [face] }, known), face.data.length)
    exchange.installed.mockImplementationOnce(() => { throw new Error('MEMFS write failed') })
    expect(() => exchange.read(attributes)).toThrow('MEMFS write failed')
    expect(exchange.read(attributes)).toEqual([{ path: '/dsh-fonts/0.font', family: face.alias }])
    expect(exchange.read({ ...attributes, codePoints: [0x62] })).toEqual([{ path: '/dsh-fonts/0.font', family: face.alias }])
    expect(exchange.request.mock.calls.map(([, known]) => known)).toEqual([[], [], [{ id: face.id, bytes: face.data.length }]])
    expect(exchange.installed.mock.calls).toEqual([['/dsh-fonts/0.font', face.data], ['/dsh-fonts/0.font', face.data]])
  })
  it.each([FontState.Error, FontState.Cancelled])('keeps only successfully installed fonts known after transfer failure %s', failure => {
    const other = { id: 'arabic', family: 'Other', alias: 'DSH_arabic', data: new Uint8Array([4, 5, 6]) }
    let failed = false
    const exchange = connection((_input, known) => {
      if (failed) return fontFrames({ fonts: [face, other] }, known)
      failed = true
      return [frame(FontState.Header, { fonts: [face, other].map(font => ({ id: font.id, family: font.family,
        alias: font.alias, bytes: font.data.length })) }), { state: FontState.Bytes, bytes: face.data },
      { state: FontState.Bytes, bytes: other.data.subarray(0, 1) }, { state: failure, bytes: new TextEncoder().encode('Host unavailable') }]
    }, face.data.length + other.data.length)
    expect(() => exchange.read(attributes)).toThrow(expect.objectContaining(failure === FontState.Cancelled
      ? { name: 'AbortError' } : { code: 'font-unavailable' }))
    expect(exchange.installed).toHaveBeenCalledExactlyOnceWith('/dsh-fonts/0.font', face.data)
    expect(exchange.read(attributes)).toEqual([{ path: '/dsh-fonts/0.font', family: face.alias }, { path: '/dsh-fonts/1.font', family: other.alias }])
    expect(exchange.request.mock.calls.map(([, known]) => known)).toEqual([[], [{ id: face.id, bytes: face.data.length }]])
    expect(exchange.installed.mock.calls).toEqual([['/dsh-fonts/0.font', face.data], ['/dsh-fonts/1.font', other.data]])
  })
  it('rejects the byte limit, truncated bodies, overlong bodies and a missing trailer', () => {
    expect(() => connection(() => fontFrames({ fonts: [face] }), 2).read(attributes)).toThrow('maxLoadedFontBytes')
    const header = frame(FontState.Header, { fonts: [{ id: face.id, family: face.family, alias: face.alias, bytes: 3 }] })
    for (const body of [frame(FontState.Done, ''), { state: FontState.Bytes, bytes: new Uint8Array() }, { state: FontState.Bytes, bytes: new Uint8Array(4) }]) {
      expect(() => connection(() => [header, body]).read(attributes)).toThrow('Incomplete')
    }
    expect(() => connection(() => [header, { state: FontState.Bytes, bytes: face.data }, frame(FontState.Header, {})]).read(attributes)).toThrow('trailer')
  })
  it('consumes a frame made available by a futex wakeup', () => {
    const metadata = frame(FontState.Waiting, { fonts: [{ id: face.id, family: face.family, alias: face.alias, bytes: 3 }] })
    const exchange = connection(() => [metadata, { state: FontState.Bytes, bytes: face.data }, { state: FontState.Done, bytes: new Uint8Array() }])
    vi.spyOn(Atomics, 'wait').mockImplementation(() => { Atomics.store(exchange.control, 0, FontState.Header); return 'ok' })
    expect(exchange.read(attributes)).toEqual([{ path: '/dsh-fonts/0.font', family: 'DSH_latin' }])
  })
  it('bounds a stalled producer and preserves cancellation both before and during consumption', () => {
    expect(() => connection(() => []).read(attributes)).toThrow(expect.objectContaining({ code: 'timeout' }))
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(5)
    expect(() => connection(() => []).read(attributes)).toThrow(expect.objectContaining({ code: 'timeout' }))
    expect(() => connection(() => [frame(FontState.Cancelled, '')]).read(attributes)).toThrow(expect.objectContaining({ name: 'AbortError' }))
    const original = Atomics.compareExchange
    vi.spyOn(Atomics, 'compareExchange').mockImplementation((array, index, expected, replacement) => {
      Atomics.store(array, index, FontState.Cancelled)
      return original(array, index, expected, replacement)
    })
    expect(() => connection(() => fontFrames({ fonts: [face] })).read(attributes)).toThrow(expect.objectContaining({ name: 'AbortError' }))
  })
})
