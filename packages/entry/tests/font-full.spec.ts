import { afterEach, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from 'fontkit'
import { FontSubsetSource } from '../src/font-subsets.ts'
import { fullFontFile, preloadPdfFonts } from '../src/font-full.ts'
import { indexSystemFonts } from '../src/fonts.ts'
import { resolveOptions } from '../src/options.ts'
import type { FontAssetId } from '../src/font-source-types.ts'
const fixtures = fileURLToPath(new URL('./fixtures/fonts/', import.meta.url))
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(name: string) {
  const root = mkdtempSync(join(tmpdir(), 'kit-full-font-')); roots.push(root)
  const path = join(root, name); copyFileSync(join(fixtures, name), path)
  const source = new FontSubsetSource({ directories: [root], fallbackFamilies: [], maxFiles: 20, maxFileBytes: 256 * 1024 * 1024, maxCachedSubsetBytes: 1 })
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
it('preload deduplicates full assets and enforces the byte budget before installation', () => {
  const { root } = fixture('LatinGreek.ttf')
  const faces = indexSystemFonts({ directories: [root], maxFiles: 10, maxFileBytes: 10000000 })
  const install = vi.fn()
  preloadPdfFonts(resolveOptions({ fontDirectories: [root], initialFontFamilies: ['Roboto', 'Roboto'], fontFallbacks: [['sans-serif', 'Roboto']] }), faces, install)
  expect(install).toHaveBeenCalledOnce()
  expect(install.mock.calls[0]![0]).toMatch(/\.ttf$/)
  expect(() => preloadPdfFonts(resolveOptions({ fontDirectories: [root], maxLoadedFontBytes: 1 }), faces, vi.fn())).toThrow(/maxLoadedFontBytes/)
})
