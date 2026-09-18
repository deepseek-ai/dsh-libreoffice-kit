import { afterEach, expect, it, vi } from 'vitest'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { create } from 'fontkit'
import * as hb from 'harfbuzzjs'
import { FontSubsetSource } from '../src/font-subsets.ts'
import { indexSystemFonts } from '../src/fonts.ts'
import { requestedFontScripts, fontScriptCodePoints } from '../src/unicode-scripts.ts'
import * as harfbuzz from '../src/harfbuzz-subset.ts'
import type { FontMatchRequest } from '../src/fonts.ts'
import type { FontAssetId } from '../src/font-source-types.ts'

const fixtures = fileURLToPath(new URL('./fixtures/fonts', import.meta.url))
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function scratch(...names: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-font-subsets-')); roots.push(root)
  for (const name of names) copyFileSync(join(fixtures, name), join(root, name))
  return root
}
function request(family: string, text = ''): FontMatchRequest {
  return { family, style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [...text].map(c => c.codePointAt(0)!) }
}
function source(root: string, maxCachedSubsetBytes = 128 * 1024 * 1024): FontSubsetSource {
  return new FontSubsetSource({ directories: [root], fallbackFamilies: [], maxFiles: 20, maxFileBytes: 256 * 1024 * 1024, maxCachedSubsetBytes })
}
interface ShapeFont {
  familyName: string
  subfamilyName: string
  characterSet: number[]
  variationAxes?: Record<string, unknown>
}
const sourceBytes = new WeakMap<ShapeFont, Uint8Array>()
function font(bytes: Uint8Array): ShapeFont {
  const parsed = create(bytes) as unknown as ShapeFont
  sourceBytes.set(parsed, bytes)
  return parsed
}
function shape(value: ShapeFont, text: string) {
  const face = new hb.Face(new hb.Blob(sourceBytes.get(value)!))
  const shaped = new hb.Font(face)
  const buffer = new hb.Buffer()
  buffer.addText(text)
  buffer.guessSegmentProperties()
  hb.shape(shaped, buffer)
  const glyphs = buffer.getGlyphInfos()
  expect(glyphs.every(glyph => glyph.codepoint !== 0)).toBe(true)
  return { outlines: glyphs.map(glyph => shaped.glyphToPath(glyph.codepoint)), positions: buffer.getGlyphPositions() }
}

it('Unicode data includes all scripts, private-use scalars, Script_Extensions and variation selectors', async () => {
  expect(await requestedFontScripts([0x41, 0x627, 0x915, 0x11400, 0xe000, 0x10ffff, 0x301, 0x20]))
    .toEqual(['Arabic', 'Devanagari', 'Latin', 'Newa', 'Unknown'])
  expect(await requestedFontScripts([])).toEqual(['Common'])
  expect(await requestedFontScripts([0x301, 0x20])).toEqual(['Common'])
  const repertoire = [0x41, 0x20, 0x301, 0x640, 0x627, 0x915, 0x11400, 0xe000]
  const arabic = await fontScriptCodePoints(repertoire, 'Arabic')
  expect(arabic).toEqual(expect.arrayContaining([0x20, 0x301, 0x640, 0x627, 0xfe0f, 0xe0100]))
  expect(arabic).not.toContain(0x41)
  expect(arabic).not.toContain(0x915)
  expect(await fontScriptCodePoints(repertoire, 'Unknown')).toContain(0xe000)
  // U+0964 has Indic Script_Extensions even though its primary Script is Common.
  expect(await fontScriptCodePoints([0x964], 'Devanagari')).toContain(0x964)
})

it('whole-script partitions reuse content across documents while different scripts have distinct aliases', async () => {
  const service = source(scratch('LatinGreek.ttf'))
  const latin = (await service.resolve(request('Roboto', 'A'))).fonts[0]!
  const repeated = (await service.resolve(request('Roboto', 'B'))).fonts[0]!
  const greek = (await service.resolve(request('Roboto', 'Ω'))).fonts[0]!
  expect(repeated).toEqual(latin)
  expect(greek.alias).not.toBe(latin.alias)
  expect(latin.alias).toBe(`DSH_${latin.id}`)
  const bytes = await service.read(latin.id)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(latin.id)
  expect(bytes.byteLength).toBe(latin.bytes)
  expect(font(bytes).familyName).toBe('Roboto')
  expect(font(bytes).characterSet).toEqual(expect.arrayContaining([65, 66]))
  expect(font(bytes).characterSet).not.toContain(0x3a9)
})

it.each([['Arabic.ttf', 'Arabic', 'سلام'], ['Devanagari.ttf', 'Devanagari', 'नमस्तेक्षि'], ['Newa.ttf', 'Newa', '𑐀𑐁']])(
  '%s retains glyph outlines, shaping and positions after Unicode-script subsetting', async (name, script, text) => {
    const original = readFileSync(join(fixtures, name))
    const before = font(original)
    const subset = font(await harfbuzz.subsetFont(original, 0, await fontScriptCodePoints(before.characterSet, script)))
    expect(subset.familyName).toBe(before.familyName)
    expect(subset.subfamilyName).toBe(before.subfamilyName)
    expect(shape(subset, text)).toEqual(shape(before, text))
    expect(shape(subset, text).outlines.some(commands => commands.length > 0)).toBe(true)
  },
)

it('baseline subsets can carry only metadata and .notdef before any script is requested', async () => {
  const service = source(scratch('Variable.ttf'))
  const baseline = (await service.resolve(request('Noto Sans'))).fonts[0]!
  const bytes = await service.read(baseline.id)
  expect(font(bytes).familyName).toBe('Noto Sans')
  expect([...new hb.Face(new hb.Blob(bytes)).collectUnicodes()]).not.toContain(97)
  const latin = (await service.resolve(request('Noto Sans', 'a'))).fonts[0]!
  const subset = font(await service.read(latin.id))
  expect(subset.variationAxes).toEqual(font(readFileSync(join(fixtures, 'Variable.ttf'))).variationAxes)
  expect(shape(subset, 'abc')).toEqual(shape(font(readFileSync(join(fixtures, 'Variable.ttf'))), 'abc'))
})

it('TTC matching retains each physical face and emits independent sfnt files', async () => {
  const service = source(scratch('Faces.ttc'))
  const result = await service.resolve(request('Roboto', 'Aन'))
  expect(result.fonts).toHaveLength(2)
  expect(await service.resolve(request('Roboto', 'Aन'))).toEqual(result)
  expect(result.fonts.map(asset => asset.family)).toEqual(['Roboto', 'Noto Sans Devanagari'])
  for (const asset of result.fonts) {
    const bytes = await service.read(asset.id)
    expect(Buffer.from(bytes.subarray(0, 4)).toString()).not.toBe('ttcf')
    expect(font(bytes).familyName).toBe(asset.family)
  }
})

it('keeps identical script partitions separate for different faces of one TTC', async () => {
  const service = source(scratch('Faces.ttc'))
  const generate = vi.spyOn(harfbuzz, 'subsetFont')
  const assets = []
  for (const family of ['Roboto', 'Noto Sans Devanagari']) {
    const asset = (await service.resolve(request(family, ' '))).fonts[0]!
    assets.push(asset)
    expect(asset.family).toBe(family)
    expect(font(await service.read(asset.id)).familyName).toBe(family)
    expect((await service.resolve(request(family, ' '))).fonts).toEqual([asset])
  }
  expect(assets[0]!.id).not.toBe(assets[1]!.id)
  expect(generate.mock.calls.map(([, faceIndex]) => faceIndex)).toEqual([0, 1])
})

it('Apple dfont resources are extracted before HarfBuzz subsetting', async () => {
  const service = source(scratch('Face.dfont'))
  const result = await service.resolve(request('Roboto', 'A'))
  expect(result.fonts).toHaveLength(1)
  expect(shape(font(await service.read(result.fonts[0]!.id)), 'AB')).toEqual(shape(font(readFileSync(join(fixtures, 'LatinGreek.ttf'))), 'AB'))
})

it('bounded cache eviction regenerates the same content and transfers cannot detach retained bytes', async () => {
  const generate = vi.spyOn(harfbuzz, 'subsetFont')
  const service = source(scratch('LatinGreek.ttf'), 1)
  const asset = (await service.resolve(request('Roboto', 'A'))).fonts[0]!
  const first = await service.read(asset.id)
  expect(await service.read(asset.id)).toEqual(first)
  expect(generate).toHaveBeenCalledTimes(3)
  generate.mockClear()
  const retained = source(scratch('LatinGreek.ttf'))
  const cached = (await retained.resolve(request('Roboto', 'A'))).fonts[0]!
  const transferred = await retained.read(cached.id)
  structuredClone(transferred, { transfer: [transferred.buffer] })
  expect(transferred.byteLength).toBe(0)
  expect(await retained.read(cached.id)).toEqual(first)
  expect(generate).toHaveBeenCalledTimes(1)
})

it('refresh recognizes new and modified fonts and refuses previously selected stale originals', async () => {
  const root = scratch('LatinGreek.ttf')
  const service = source(root)
  const old = (await service.resolve(request('Roboto', 'A'))).fonts[0]!
  const options = { directories: [root], maxFiles: 20, maxFileBytes: 256 * 1024 * 1024 }
  const first = indexSystemFonts(options)
  expect(indexSystemFonts(options, first)[0]).toBe(first[0])
  copyFileSync(join(fixtures, 'Arabic.ttf'), join(root, 'Arabic.ttf'))
  expect((await service.resolve(request('Noto Nastaliq Urdu', 'س'))).fonts[0]?.family).toBe('Noto Nastaliq Urdu')
  copyFileSync(join(fixtures, 'Devanagari.ttf'), join(root, 'LatinGreek.ttf'))
  await expect(service.read(old.id)).rejects.toThrow(/changed/)
  expect((await service.resolve(request('Noto Sans Devanagari', 'न'))).fonts[0]?.family).toBe('Noto Sans Devanagari')
  await expect(service.read('unknown' as FontAssetId)).rejects.toThrow(/not selected/)
})

it('large font buffers grow the subset heap without losing glyph outlines', { timeout: 30_000 }, async () => {
  const original = readFileSync(join(fixtures, 'LatinGreek.ttf'))
  // Real collections can exceed the upstream module's fixed 65 MiB heap before glyph closure starts.
  const collectionSized = new Uint8Array(70 * 1024 * 1024)
  collectionSized.set(original)
  const subset = font(await harfbuzz.subsetFont(collectionSized, 0, [65, 66]))
  expect(shape(subset, 'AB')).toEqual(shape(font(original), 'AB'))
})

it('LRU eviction releases older subsets while keeping the current entry reusable', async () => {
  const root = scratch('LatinGreek.ttf')
  const measuring = source(root)
  const latinSize = (await measuring.resolve(request('Roboto', 'A'))).fonts[0]!.bytes
  const greekSize = (await measuring.resolve(request('Roboto', 'Ω'))).fonts[0]!.bytes
  const service = source(root, Math.max(latinSize, greekSize))
  const generate = vi.spyOn(harfbuzz, 'subsetFont')
  const latin = (await service.resolve(request('Roboto', 'A'))).fonts[0]!
  const greek = (await service.resolve(request('Roboto', 'Ω'))).fonts[0]!
  await service.read(greek.id)
  expect(generate).toHaveBeenCalledTimes(2)
  await service.read(latin.id)
  expect(generate).toHaveBeenCalledTimes(3)
  expect((await service.resolve(request('Missing Family', 'A'))).missingFamily).toBe('Missing Family')
})

it('regeneration rejects inconsistent original bytes and changed subset content', async () => {
  const fonts = await import('../src/fonts.ts')
  const service = source(scratch('LatinGreek.ttf'), 1)
  const asset = (await service.resolve(request('Roboto', 'A'))).fonts[0]!
  vi.spyOn(fonts, 'readFont').mockReturnValueOnce(Buffer.from('unexpected font replacement'))
  await expect(service.read(asset.id)).rejects.toThrow(/content changed/)
  vi.spyOn(harfbuzz, 'subsetFont').mockResolvedValueOnce(Uint8Array.of(1))
  await expect(service.read(asset.id)).rejects.toThrow(/identity changed/)
})

it.each([1, 128 * 1024 * 1024])('refresh retires obsolete selections with a %i-byte cache budget', async budget => {
  const root = scratch('LatinGreek.ttf')
  const service = source(root, budget)
  const old = (await service.resolve(request('Roboto', 'A'))).fonts[0]!
  rmSync(join(root, 'LatinGreek.ttf'))
  expect((await service.resolve(request('Roboto', 'A'))).fonts).toEqual([])
  await expect(service.read(old.id)).rejects.toThrow(/not selected/)
})

it('regional matches of identical installed files preserve the latest valid content selection', async () => {
  const root = scratch()
  copyFileSync(join(fixtures, 'LatinGreek.ttf'), join(root, 'copy_sc.ttf'))
  copyFileSync(join(fixtures, 'LatinGreek.ttf'), join(root, 'copy_jp.ttf'))
  const service = source(root)
  const chinese = (await service.resolve({ ...request('Roboto', 'A'), language: 'zh' })).fonts[0]!
  const japanese = (await service.resolve({ ...request('Roboto', 'A'), language: 'ja' })).fonts[0]!
  expect(japanese.id).toBe(chinese.id)
  rmSync(join(root, 'copy_sc.ttf'))
  await service.resolve({ ...request('Roboto', 'A'), language: 'ja' })
  expect((await service.read(japanese.id)).byteLength).toBe(japanese.bytes)
})

it('rejects an unknown asset mode before indexing any font files', async () => {
  const fonts = await import('../src/fonts.ts')
  const index = vi.spyOn(fonts, 'indexSystemFonts')
  const service = source(scratch('LatinGreek.ttf'))
  await expect(service.resolve({ ...request('Roboto', 'A'), mode: 'stream' as never })).rejects.toThrow('Unknown font asset mode.')
  expect(index).not.toHaveBeenCalled()
})
