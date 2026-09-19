import { afterEach, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from 'fontkit'
import { FontSubsetSource } from '../src/font-subsets.ts'
import { fontFileFormat, fullFontFile, preloadPdfFonts } from '../src/font-full.ts'
import * as fullFonts from '../src/font-full.ts'
import { indexSystemFonts, SystemFontCatalog } from '../src/fonts.ts'
import { resolveOptions } from '../src/options.ts'
import type { FontAssetId } from '../src/font-source-types.ts'
const fixtures = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url))
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(name: string, maxCachedSubsetBytes = 1) {
  const root = mkdtempSync(join(tmpdir(), 'kit-full-font-')); roots.push(root)
  const path = join(root, name); copyFileSync(join(fixtures, name), path)
  const source = new FontSubsetSource({ directories: [root], fallbackFamilies: [], maxFiles: 20, maxFileBytes: 256 * 1024 * 1024, maxCachedSubsetBytes })
  return { root, path, source }
}
const attributes = { family: 'Roboto', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [] }
it('full mode preserves original names and all glyphs, regenerates after eviction, and rejects changed/unknown files', async () => {
  const { source, path } = fixture('LatinGreek.ttf')
  const resolved = await source.resolve({ ...attributes, mode: 'full' })
  const asset = resolved.fonts[0]!
  expect(asset).toMatchObject({ mode: 'full', format: 'ttf', family: 'Roboto', alias: 'Roboto' })
  expect(asset.id).toMatch(/^full_[a-f0-9]{64}$/)
  const bytes = await source.read(asset.id)
  expect(Buffer.from(bytes)).toEqual(readFileSync(path))
  const parsed = create(bytes)
  expect('characterSet' in parsed && parsed.characterSet.includes(0x3a9)).toBe(true)
  await expect(source.read('other' as FontAssetId)).rejects.toThrow(/not selected/)
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.of(0)]))
  await expect(source.read(asset.id)).rejects.toThrow(/changed/)
})
it.each([['Faces.ttc', 'ttc'], ['Face.dfont', 'ttf']])('full %s remains a PDFium-scannable original font resource', (name, format) => {
  const { root, path } = fixture(name)
  const faces = indexSystemFonts({ directories: [root], maxFiles: 10, maxFileBytes: 10000000 })
  const full = fullFontFile(faces[0]!)
  expect(full.format).toBe(format)
  if (format === 'ttc') expect(Buffer.from(full.bytes)).toEqual(readFileSync(path))
  else expect('familyName' in create(full.bytes)).toBe(true)
})
it('shares one full TTC across its physical faces without replacing the requested family or alias', async () => {
  const original = readFileSync(join(fixtures, 'Faces.ttc'))
  const { source } = fixture('Faces.ttc', original.length)
  const generate = vi.spyOn(fullFonts, 'fullFontFile')
  const result = await source.resolve({ ...attributes, mode: 'full', codePoints: [0x41, 0x928] })
  expect(result.fonts).toHaveLength(2)
  expect(result.fonts.map(asset => ({ family: asset.family, alias: asset.alias, format: asset.format }))).toEqual([
    { family: 'Roboto', alias: 'Roboto', format: 'ttc' },
    { family: 'Noto Sans Devanagari', alias: 'Noto Sans Devanagari', format: 'ttc' },
  ])
  expect(result.fonts[1]!.id).toBe(result.fonts[0]!.id)
  for (const asset of result.fonts) expect(Buffer.from(await source.read(asset.id))).toEqual(original)
  const devanagari = await source.resolve({ ...attributes, mode: 'full', family: 'Noto Sans Devanagari', codePoints: [0x928] })
  expect(devanagari.fonts).toEqual([result.fonts[1]])
  expect((await source.resolve({ ...attributes, mode: 'full', codePoints: [0x41] })).fonts).toEqual([result.fonts[0]])
  expect(generate).toHaveBeenCalledOnce()
})
it('accounts for identical full TTC bytes once when distinct indexed paths and faces share an asset', async () => {
  const collectionBytes = readFileSync(join(fixtures, 'Faces.ttc'))
  const otherBytes = readFileSync(join(fixtures, 'Arabic.ttf'))
  const { source, root, path } = fixture('Faces.ttc', collectionBytes.length + otherBytes.length)
  const copy = join(root, 'Copy.ttc')
  copyFileSync(path, copy)
  copyFileSync(join(fixtures, 'Arabic.ttf'), join(root, 'Arabic.ttf'))
  const faces = indexSystemFonts({ directories: [root], maxFiles: 20, maxFileBytes: 10000000 })
  const otherFace = faces.find(face => basename(face.path) === 'Arabic.ttf')!
  const firstFace = faces.find(face => basename(face.path) === 'Faces.ttc' && face.faceIndex === 0)!
  const secondFace = faces.find(face => basename(face.path) === 'Copy.ttc' && face.faceIndex === 1)!
  expect([otherFace, firstFace, secondFace].every(Boolean)).toBe(true)
  vi.spyOn(SystemFontCatalog.prototype, 'match').mockReturnValueOnce({ fonts: [otherFace] })
    .mockReturnValueOnce({ fonts: [firstFace] }).mockReturnValueOnce({ fonts: [secondFace] })
  const generate = vi.spyOn(fullFonts, 'fullFontFile')
  const other = (await source.resolve({ ...attributes, mode: 'full', family: otherFace.family })).fonts[0]!
  const first = (await source.resolve({ ...attributes, mode: 'full', family: firstFace.family })).fonts[0]!
  const second = (await source.resolve({ ...attributes, mode: 'full', family: secondFace.family })).fonts[0]!
  expect(second.id).toBe(first.id)
  expect(second).toMatchObject({ family: 'Noto Sans Devanagari', alias: 'Noto Sans Devanagari' })
  expect(Buffer.from(await source.read(other.id))).toEqual(otherBytes)
  expect(Buffer.from(await source.read(second.id))).toEqual(collectionBytes)
  // The first font still fits beside one physical TTC, even after two face/path selections.
  expect(generate).toHaveBeenCalledTimes(3)
})
it.each(['full', 'subset'] as const)('retains separate %s assets for two resources in one Apple dfont', async mode => {
  const { source, root, path } = fixture('Face.dfont', 256 * 1024 * 1024)
  const resources = ['LatinGreek.ttf', 'Devanagari.ttf'].map(name => readFileSync(join(fixtures, name)))
  const chunks = resources.map(bytes => { const size = Buffer.alloc(4); size.writeUInt32BE(bytes.length); return Buffer.concat([size, bytes]) })
  const data = Buffer.concat(chunks)
  const map = Buffer.alloc(38 + 12 * resources.length)
  const header = Buffer.alloc(16)
  header.writeUInt32BE(256, 0); header.writeUInt32BE(256 + data.length, 4)
  header.writeUInt32BE(data.length, 8); header.writeUInt32BE(map.length, 12)
  header.copy(map)
  map.writeUInt16BE(28, 24); map.writeUInt16BE(map.length, 26)
  map.writeUInt16BE(0, 28); map.write('sfnt', 30, 'ascii')
  map.writeUInt16BE(resources.length - 1, 34); map.writeUInt16BE(10, 36)
  let offset = 0
  for (const [index, chunk] of chunks.entries()) {
    const entry = 38 + index * 12
    map.writeUInt16BE(128 + index, entry); map.writeUInt16BE(0xffff, entry + 2)
    map.writeUInt32BE(offset, entry + 4); offset += chunk.length
  }
  writeFileSync(path, Buffer.concat([header, Buffer.alloc(240), data, map]))
  const faces = indexSystemFonts({ directories: [root], maxFiles: 10, maxFileBytes: 10000000 })
  expect(faces.map(face => [face.faceIndex, face.family])).toEqual([[0, 'Roboto'], [1, 'Noto Sans Devanagari']])
  const generate = vi.spyOn(fullFonts, 'fullFontFile')
  const assets = []
  for (const face of faces) {
    const asset = (await source.resolve({ ...attributes, family: face.family, codePoints: [0x20], mode })).fonts[0]!
    assets.push(asset)
    expect(asset.family).toBe(face.family)
    expect(asset.alias).toBe(mode === 'full' ? face.family : `DSH_${asset.id}`)
    const parsed = create(await source.read(asset.id))
    expect('familyName' in parsed && parsed.familyName).toBe(face.family)
  }
  expect(assets[0]!.id).not.toBe(assets[1]!.id)
  expect(generate).toHaveBeenCalledTimes(mode === 'full' ? 2 : 0)
})
it('rejects replaced TTC selections until a new source captures the replacement', async () => {
  const { source, path } = fixture('Faces.ttc', 256 * 1024 * 1024)
  const previous = (await source.resolve({ ...attributes, mode: 'full', codePoints: [0x41, 0x928] })).fonts
  expect(previous).toHaveLength(2)
  expect(previous[0]!.id).toBe(previous[1]!.id)
  copyFileSync(join(fixtures, 'LatinGreek.ttf'), path)
  for (const asset of previous) await expect(source.read(asset.id)).rejects.toThrow(/changed/)
  await expect(source.resolve({ ...attributes, mode: 'full', codePoints: [0x41] })).rejects.toThrow(/changed/)
  const refreshed = new FontSubsetSource({ directories: [join(path, '..')], fallbackFamilies: [], maxFiles: 20,
    maxFileBytes: 256 * 1024 * 1024, maxCachedSubsetBytes: 256 * 1024 * 1024 })
  const current = (await refreshed.resolve({ ...attributes, mode: 'full', codePoints: [0x41] })).fonts[0]!
  expect(current).toMatchObject({ family: 'Roboto', alias: 'Roboto', format: 'ttf' })
  expect(current.id).not.toBe(previous[0]!.id)
  expect(Buffer.from(await refreshed.read(current.id))).toEqual(readFileSync(path))
  await expect(refreshed.read(previous[0]!.id)).rejects.toThrow(/not selected/)
})
it('preload deduplicates full assets and enforces the byte budget before installation', () => {
  const { root } = fixture('LatinGreek.ttf')
  const faces = indexSystemFonts({ directories: [root], maxFiles: 10, maxFileBytes: 10000000 })
  const install = vi.fn()
  preloadPdfFonts(resolveOptions({ fontDirectories: [root], initialFontFamilies: ['Roboto', 'Roboto'], fontFallbacks: [['sans-serif', 'Roboto']] }), faces, install)
  expect(install).toHaveBeenCalledOnce()
  expect(install.mock.calls[0]![0]).toMatch(/\.ttf$/)
  expect(() => preloadPdfFonts(resolveOptions({ fontDirectories: [root], maxLoadedFontBytes: 1 }), faces, vi.fn())).toThrow(/maxLoadedFontBytes/)
})
it('classifies sfnt signatures and rejects containers PDFium cannot mount as full fonts', () => {
  expect(fontFileFormat(Buffer.from('OTTO'))).toBe('otf')
  expect(fontFileFormat(Buffer.from('true'))).toBe('ttf')
  expect(() => fontFileFormat(Buffer.from('wOFF'))).toThrow(/not an sfnt font/)
})
it('preloads an Apple dfont as its complete sfnt resource', () => {
  const { root } = fixture('Face.dfont')
  const faces = indexSystemFonts({ directories: [root], maxFiles: 10, maxFileBytes: 10000000 })
  const installed: { name: string; bytes: Uint8Array }[] = []
  preloadPdfFonts(resolveOptions({ initialFontFamilies: ['Roboto'], fontFallbacks: [] }), faces,
    (name, bytes) => { installed.push({ name, bytes }) })
  expect(installed).toHaveLength(1)
  expect(installed[0]!.name).toMatch(/\.ttf$/)
  const original = readFileSync(join(fixtures, 'LatinGreek.ttf'))
  // The extracted stream can retain the dfont resource-map suffix after the complete sfnt tables.
  expect(Buffer.from(installed[0]!.bytes.subarray(0, original.length))).toEqual(original)
  const parsed = create(installed[0]!.bytes)
  if (!('characterSet' in parsed)) throw new Error('Expected an extracted sfnt face.')
  expect(parsed.familyName).toBe('Roboto')
  expect(parsed.characterSet).toContain(0x3a9)
})
it('identical font content selected from two paths consumes the preload budget once', () => {
  const { root, path } = fixture('LatinGreek.ttf')
  copyFileSync(path, join(root, 'Alias.ttf'))
  const faces = indexSystemFonts({ directories: [root], maxFiles: 10, maxFileBytes: 10000000 })
  expect(faces).toHaveLength(2)
  // The catalog can return physical copies through different family/fallback selections.
  vi.spyOn(SystemFontCatalog.prototype, 'match').mockReturnValueOnce({ fonts: [faces[0]!] })
    .mockReturnValueOnce({ fonts: [faces[1]!] }).mockReturnValue({ fonts: [] })
  const install = vi.fn()
  const bytes = readFileSync(path)
  preloadPdfFonts(resolveOptions({ initialFontFamilies: ['Roboto', 'Alias'], fontFallbacks: [], maxLoadedFontBytes: bytes.length }), faces, install)
  expect(install).toHaveBeenCalledOnce()
  expect(Buffer.from(install.mock.calls[0]![1] as Uint8Array)).toEqual(bytes)
})
it('evicted full-font assets reject a changed content hash even when the indexed stat is unchanged', async () => {
  const { source, path } = fixture('LatinGreek.ttf')
  const asset = (await source.resolve({ ...attributes, mode: 'full' })).fonts[0]!
  const fonts = await import('../src/fonts.ts')
  vi.spyOn(fonts, 'readFont').mockReturnValueOnce(readFileSync(join(fixtures, 'Devanagari.ttf')))
  await expect(source.read(asset.id)).rejects.toThrow('The selected font content changed.')
  expect(Buffer.from(await source.read(asset.id))).toEqual(readFileSync(path))
})
