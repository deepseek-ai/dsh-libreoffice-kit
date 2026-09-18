import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFontReader, fontFrames, fontViews } from '../src/font-channel.ts'
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES, FontState } from '../src/protocol.ts'
import type { BrowserFontRequest, BrowserFontResult } from '../src/types.ts'

const attributes: BrowserFontRequest = { family: 'Test', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] }
const face = { id: 'latin', data: new Uint8Array([1, 2, 3]), family: 'Test', alias: 'DSH_latin' }
type Frame = { state: FontState; bytes: Uint8Array; length?: number }
const frame = (state: FontState, value: unknown): Frame => ({ state, bytes: new TextEncoder().encode(JSON.stringify(value)) })

function connection(response: (request: BrowserFontRequest) => Iterable<Frame>, limit = 64, declared = new Map([['test', 'Source Test']])) {
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
  const request = vi.fn((input: BrowserFontRequest) => { frames = response(input)[Symbol.iterator](); pump() })
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
