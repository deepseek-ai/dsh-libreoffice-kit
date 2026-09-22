/** Whole fonts for engines such as PDFium that perform their own glyph mapping. */
import { createHash } from 'node:crypto'
import { extname } from 'node:path'
import { create } from 'fontkit'
import { indexedFace, readFont, SystemFontCatalog, type FontFace } from './fonts.ts'
import type { ResolvedOptions } from './options.ts'
export type FontFileFormat = 'ttf' | 'otf' | 'ttc'
export function fontFileFormat(bytes: Uint8Array): FontFileFormat {
  const magic = new TextDecoder().decode(bytes.subarray(0, 4))
  if (magic === 'ttcf') return 'ttc'
  if (magic === 'OTTO') return 'otf'
  if (magic === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'ttf'
  throw new Error('The full font asset is not an sfnt font or collection.')
}
/** Keep full names, encoding tables and glyphs. Apple dfont containers expose one complete sfnt resource. */
export function fullFontFile(face: FontFace): { bytes: Uint8Array; sourceHash: string; format: FontFileFormat } {
  const original = readFont(face)
  const sourceHash = createHash('sha256').update(original).digest('hex')
  let bytes: Uint8Array = original
  /* v8 ignore next -- Apple dfont resource extraction is exercised by matching-host font qualification. */
  if (extname(face.path).toLowerCase() === '.dfont') bytes = indexedFace(create(original), face).stream.buffer
  return { bytes, sourceHash, format: fontFileFormat(bytes) }
}
/** Mount a fixed bounded set before PDFium performs its first installed-font enumeration. */
export function preloadPdfFonts(options: ResolvedOptions, faces: readonly FontFace[], install: (name: string, bytes: Uint8Array) => void): void {
  const catalog = new SystemFontCatalog({ faces, fallbackFamilies: options.fontFallbacks })
  const files = new Set<string>()
  const assets = new Set<string>()
  let total = 0
  const families = [...new Set([...options.initialFontFamilies, ...options.fontFallbacks.flat(), 'sans-serif', 'serif', 'monospace'])]
  for (const family of families) {
    const result = catalog.match({ family, style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] }, new AbortController().signal)
    for (const face of result.fonts) {
      /* v8 ignore next -- Apple dfont face identity is covered by matching-host font qualification. */
      const physical = `${face.path}#${extname(face.path).toLowerCase() === '.dfont' ? face.faceIndex : ''}`
      if (files.has(physical)) continue
      files.add(physical)
      const { bytes, format } = fullFontFile(face)
      const id = createHash('sha256').update(bytes).digest('hex')
      if (assets.has(id)) continue
      if (total + bytes.length > options.maxLoadedFontBytes) throw new Error('PDF full-font preload exceeds maxLoadedFontBytes.')
      install(`${id}.${format}`, bytes)
      total += bytes.length
      assets.add(id)
    }
  }
}
