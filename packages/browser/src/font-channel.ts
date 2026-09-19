/** Bounded frames bridge asynchronous Host font reads and synchronous VCL callbacks. */
import { normalize } from '@deepseek-ai/libreoffice-kit/font-config'
import { FONT_CHUNK_BYTES, FONT_HEADER_BYTES, FontState } from './protocol.ts'
import type { FontHeader, FontIdentity } from './protocol.ts'
import { BrowserRenderError } from './types.ts'
import type { BrowserFontRequest, BrowserFontResult } from './types.ts'

/** Views shared by the owner and engine; only the engine uses Atomics.wait. */
export function fontViews(channel: SharedArrayBuffer): { control: Int32Array; bytes: Uint8Array } {
  return { control: new Int32Array(channel, 0, 2), bytes: new Uint8Array(channel, FONT_HEADER_BYTES) }
}

/** Only uninstalled content crosses the channel; each family retains its own alias. */
export function* fontFrames(result: BrowserFontResult, known: readonly FontIdentity[] = []): Generator<{ state: FontState; bytes: Uint8Array }> {
  const identities = new Map(known.map(font => [font.id, font]))
  const header: FontHeader = { fonts: result.fonts.map(font => {
    const size = font.data === undefined ? font.bytes : font.data.byteLength
    const identity: FontIdentity = { id: font.id, bytes: size, ...(font.format ? { format: font.format } : {}) }
    const prior = identities.get(font.id)
    if (prior && (prior.bytes !== identity.bytes || prior.format !== identity.format)) throw new BrowserRenderError('font-unavailable', 'Font identity has conflicting bytes or formats.')
    if (!prior && font.data === undefined) throw new BrowserRenderError('font-unavailable', 'Font reference has not been installed.')
    identities.set(font.id, identity)
    return { ...identity, family: font.family, alias: font.alias, ...(prior ? { reference: true as const } : {}) }
  }), ...(result.missingFamily === undefined ? {} : { missingFamily: result.missingFamily }) }
  const encoded = new TextEncoder().encode(JSON.stringify(header))
  if (encoded.length > FONT_CHUNK_BYTES) throw new BrowserRenderError('font-limit', 'Font response metadata exceeds the transfer limit.')
  yield { state: FontState.Header, bytes: encoded }
  for (const [index, font] of result.fonts.entries()) {
    if (header.fonts[index]!.reference) continue
    if (font.data === undefined) throw new BrowserRenderError('font-unavailable', 'Font reference has not been installed.')
    for (let offset = 0; offset < font.data.byteLength; offset += FONT_CHUNK_BYTES) {
      yield { state: FontState.Bytes, bytes: font.data.subarray(offset, offset + FONT_CHUNK_BYTES) }
    }
  }
  yield { state: FontState.Done, bytes: new Uint8Array() }
}

/** One MEMFS font face registered under a document-local family alias. */
export interface EngineFontFace { readonly path: string; readonly family: string }

/** The synchronous reader installs immutable font assets before returning their MEMFS paths and aliases. */
export function createFontReader(channel: SharedArrayBuffer, timeoutMs: number, maxLoadedFontBytes: number,
  declaredFamilies: ReadonlyMap<string, string>, request: (request: BrowserFontRequest, known: readonly FontIdentity[]) => void, next: () => void,
  install: (path: string, bytes: Uint8Array) => void, missing: (families: readonly string[]) => void): (request: BrowserFontRequest) => EngineFontFace[] {
  const { control, bytes } = fontViews(channel)
  const installed = new Map<string, { face: EngineFontFace; bytes: number; format: FontIdentity['format'] }>()
  const aliases = new Map<string, { id: string; family: string }>()
  const requests = new Map<string, EngineFontFace[]>()
  const coverage = new Map<string, { readonly points: Set<number>; readonly faces: EngineFontFace[]; complete: boolean }>()
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
    const codePoints = [...new Set(attributes.codePoints)].sort((left, right) => left - right)
    const original = { ...attributes, codePoints, ...(canonical === undefined ? {} : { family: canonical }) }
    const key = JSON.stringify(original)
    const cached = requests.get(key)
    if (cached) return cached
    const { codePoints: _points, ...base } = original
    const coverageKey = JSON.stringify(base)
    const covered = coverage.get(coverageKey)
    if (codePoints.length > 0 && covered && (covered.complete || codePoints.every(point => covered.points.has(point)))) {
      requests.set(key, covered.faces)
      return covered.faces
    }
    request(original, [...installed].map(([id, font]) => ({ id, bytes: font.bytes, ...(font.format ? { format: font.format } : {}) })))
    const first = read()
    if (first.state !== FontState.Header) throw new BrowserRenderError('font-unavailable', 'Expected font transfer metadata.')
    let header: FontHeader
    try { header = JSON.parse(new TextDecoder().decode(first.data)) as FontHeader } catch (cause) { throw new BrowserRenderError('font-unavailable', 'Invalid font transfer metadata.') }
    if (header === null || typeof header !== 'object' || !Array.isArray(header.fonts) || header.fonts.length === 0) throw new BrowserRenderError('font-unavailable', 'Host has no usable fonts.')
    const faces: EngineFontFace[] = []
    for (const font of header.fonts) {
      if (typeof font.id !== 'string' || typeof font.family !== 'string' || font.family.length === 0 || typeof font.alias !== 'string' || font.alias.length === 0 || /[\x00\t\r\n]/.test(font.alias) || !Number.isSafeInteger(font.bytes) || font.bytes <= 0) throw new BrowserRenderError('font-unavailable', 'Invalid font file descriptor.')
      if (font.format !== undefined && !['ttf', 'otf', 'ttc'].includes(font.format)) throw new BrowserRenderError('font-unavailable', 'Invalid full font format.')
      if (font.reference !== undefined && font.reference !== true) throw new BrowserRenderError('font-unavailable', 'Invalid font reference descriptor.')
      const prior = installed.get(font.id)
      if (font.reference && !prior) throw new BrowserRenderError('font-unavailable', 'Font reference has not been installed.')
      if (prior && (prior.bytes !== font.bytes || prior.format !== font.format || (font.format === undefined && prior.face.family !== font.alias))) throw new BrowserRenderError('font-unavailable', 'Font identity has conflicting bytes, aliases or formats.')
      const alias = normalize(font.alias)
      const previousAlias = aliases.get(alias)
      if (previousAlias && (previousAlias.family !== font.family || (font.format === undefined && previousAlias.id !== font.id))) throw new BrowserRenderError('font-unavailable', 'Font alias identifies conflicting subsets.')
      if (!prior && loadedBytes + font.bytes > maxLoadedFontBytes) throw new BrowserRenderError('font-limit', 'Imported fonts exceed maxLoadedFontBytes.')
      const buffer = prior ? undefined : new Uint8Array(font.bytes)
      let received = 0
      while (!font.reference && received < font.bytes) {
        const frame = read()
        if (frame.state !== FontState.Bytes || frame.data.length === 0 || received + frame.data.length > font.bytes) throw new BrowserRenderError('font-unavailable', 'Incomplete font file transfer.')
        buffer?.set(frame.data, received)
        received += frame.data.length
      }
      // A full TTC asset can expose multiple families from the same installed bytes.
      // Its requested family must not inherit the first family's alias.
      const face = { path: prior?.face.path ?? (font.format === undefined ? `/dsh-fonts/${installed.size}.font` : `/usr/share/fonts/dsh-pdfium/${installed.size}.${font.format}`), family: font.alias }
      if (buffer) { install(face.path, buffer); installed.set(font.id, { face, bytes: buffer.length, format: font.format }); loadedBytes += buffer.length }
      aliases.set(alias, { id: font.id, family: font.family })
      faces.push(face)
    }
    if (read().state !== FontState.Done) throw new BrowserRenderError('font-unavailable', 'Unexpected font transfer trailer.')
    const absentFamily = header.missingFamily === undefined ? undefined : declaredFamilies.get(normalize(header.missingFamily))
    if (absentFamily !== undefined && !families.has(absentFamily)) { families.add(absentFamily); missing([...families]) }
    requests.set(key, faces)
    if (codePoints.length > 0) {
      const group = { points: new Set(covered?.points), faces: [...(covered?.faces ?? [])], complete: covered?.complete ?? false }
      for (const point of codePoints) group.points.add(point)
      for (const face of faces) {
        if (!group.faces.some(existing => existing.path === face.path && existing.family === face.family)) group.faces.push(face)
      }
      group.complete ||= header.fonts.every(font => font.format !== undefined)
      coverage.set(coverageKey, group)
    }
    return faces
  }
}
