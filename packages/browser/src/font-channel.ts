/** Bounded frames bridge asynchronous Host font reads and synchronous VCL callbacks. */
import { normalize } from '@deepseek-ai/libreoffice-kit/font-config'
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES, FontState } from './protocol.ts'
import type { FontHeader } from './protocol.ts'
import { BrowserRenderError } from './types.ts'
import type { BrowserFontRequest, BrowserFontResult } from './types.ts'

/** Views shared by the owner and engine; only the engine uses Atomics.wait. */
export function fontViews(channel: SharedArrayBuffer): { control: Int32Array; bytes: Uint8Array } {
  return { control: new Int32Array(channel, 0, 2), bytes: new Uint8Array(channel, FONT_HEADER_BYTES) }
}

/** Frames are produced lazily so the transfer channel never duplicates a whole font set. */
export function* fontFrames(result: BrowserFontResult): Generator<{ state: FontState; bytes: Uint8Array }> {
  const header: FontHeader = { fonts: result.fonts.map(font => ({ id: font.id, bytes: font.data.byteLength, family: font.family, alias: font.alias })), ...(result.missingFamily === undefined ? {} : { missingFamily: result.missingFamily }) }
  const encoded = new TextEncoder().encode(JSON.stringify(header))
  if (encoded.length > FONT_CHUNK_BYTES) throw new BrowserRenderError('font-limit', 'Font response metadata exceeds the transfer limit.')
  yield { state: FontState.Header, bytes: encoded }
  for (const font of result.fonts) {
    for (let offset = 0; offset < font.data.byteLength; offset += FONT_CHUNK_BYTES) {
      yield { state: FontState.Bytes, bytes: font.data.subarray(offset, offset + FONT_CHUNK_BYTES) }
    }
  }
  yield { state: FontState.Done, bytes: new Uint8Array() }
}

/** One MEMFS font face registered under a document-local family alias. */
export interface EngineFontFace { readonly path: string; readonly family: string }

/** The synchronous reader installs immutable subsets before returning their MEMFS paths and aliases. */
export function createFontReader(channel: SharedArrayBuffer, timeoutMs: number, maxLoadedFontBytes: number,
  declaredFamilies: ReadonlyMap<string, string>, request: (request: BrowserFontRequest) => void, next: () => void,
  install: (path: string, bytes: Uint8Array) => void, missing: (families: readonly string[]) => void): (request: BrowserFontRequest) => EngineFontFace[] {
  const { control, bytes } = fontViews(channel)
  const installed = new Map<string, EngineFontFace>()
  const aliases = new Map<string, { id: string; family: string }>()
  const requests = new Map<string, EngineFontFace[]>()
  const families = new Set<string>()
  let loadedBytes = 0
  function read(): { state: FontState; data: Uint8Array } {
    const started = performance.now()
    while (Atomics.load(control, 0) === FontState.Waiting) {
      const remaining = timeoutMs - (performance.now() - started)
      if (remaining <= 0 || Atomics.wait(control, 0, FontState.Waiting, remaining) === 'timed-out') throw new BrowserRenderError('timeout', 'Font loading timed out.')
    }
    const state = Atomics.load(control, 0) as FontState
    if (state === FontState.Cancelled) throw new DOMException('Document closed.', 'AbortError')
    const length = Atomics.load(control, 1)
    if (length < 0 || length > bytes.length) throw new BrowserRenderError('font-unavailable', 'Invalid font transfer length.')
    const data = bytes.slice(0, length)
    if (Atomics.compareExchange(control, 0, state, FontState.Waiting) === FontState.Cancelled) throw new DOMException('Document closed.', 'AbortError')
    next()
    if (state === FontState.Error) throw new BrowserRenderError('font-unavailable', new TextDecoder().decode(data))
    return { state, data }
  }
  return (attributes) => {
    const canonical = aliases.get(normalize(attributes.family))?.family
    const original = canonical === undefined ? attributes : { ...attributes, family: canonical }
    const key = JSON.stringify(original)
    const cached = requests.get(key)
    if (cached) return cached
    request(original)
    const first = read()
    if (first.state !== FontState.Header) throw new BrowserRenderError('font-unavailable', 'Expected font transfer metadata.')
    let header: FontHeader
    try { header = JSON.parse(new TextDecoder().decode(first.data)) as FontHeader } catch (cause) { throw new BrowserRenderError('font-unavailable', 'Invalid font transfer metadata.') }
    if (header === null || typeof header !== 'object' || !Array.isArray(header.fonts) || header.fonts.length === 0) throw new BrowserRenderError('font-unavailable', 'Host has no usable fonts.')
    const faces: EngineFontFace[] = []
    for (const font of header.fonts) {
      if (typeof font.id !== 'string' || typeof font.family !== 'string' || font.family.length === 0 || typeof font.alias !== 'string' || font.alias.length === 0 || /[\x00\t\r\n]/.test(font.alias) || !Number.isSafeInteger(font.bytes) || font.bytes <= 0) throw new BrowserRenderError('font-unavailable', 'Invalid font file descriptor.')
      const prior = installed.get(font.id)
      if (prior && prior.family !== font.alias) throw new BrowserRenderError('font-unavailable', 'Font identity has conflicting aliases.')
      const alias = normalize(font.alias)
      const previousAlias = aliases.get(alias)
      if (previousAlias && (previousAlias.id !== font.id || previousAlias.family !== font.family)) throw new BrowserRenderError('font-unavailable', 'Font alias identifies conflicting subsets.')
      if (!prior && loadedBytes + font.bytes > maxLoadedFontBytes) throw new BrowserRenderError('font-limit', 'Imported fonts exceed maxLoadedFontBytes.')
      const buffer = prior ? undefined : new Uint8Array(font.bytes)
      let received = 0
      while (received < font.bytes) {
        const frame = read()
        if (frame.state !== FontState.Bytes || frame.data.length === 0 || received + frame.data.length > font.bytes) throw new BrowserRenderError('font-unavailable', 'Incomplete font file transfer.')
        buffer?.set(frame.data, received)
        received += frame.data.length
      }
      const face = prior ?? { path: `/dsh-fonts/${installed.size}.font`, family: font.alias }
      if (buffer) { install(face.path, buffer); installed.set(font.id, face); loadedBytes += buffer.length }
      aliases.set(alias, { id: font.id, family: font.family })
      faces.push(face)
    }
    if (read().state !== FontState.Done) throw new BrowserRenderError('font-unavailable', 'Unexpected font transfer trailer.')
    const absentFamily = header.missingFamily === undefined ? undefined : declaredFamilies.get(normalize(header.missingFamily))
    if (absentFamily !== undefined && !families.has(absentFamily)) { families.add(absentFamily); missing([...families]) }
    requests.set(key, faces)
    return faces
  }
}
