import { fontFileIdentity } from '../src/font-file-identity.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fontFileFormat, fullFontFile, preloadPdfFonts } from '../src/font-full.ts'
import { SystemFontCatalog, normalize, type FontFace } from '../src/fonts.ts'
import { resolveOptions } from '../src/options.ts'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function face(bytes: Buffer): FontFace {
  const root = mkdtempSync(join(tmpdir(), 'kit-full-font-')); roots.push(root)
  const path = join(root, 'Face.otf'); writeFileSync(path, bytes)
  const status = statSync(path, { bigint: true })
  return { path, ...fontFileIdentity(status),
    faceIndex: 0, family: 'Face', style: 'Regular', aliases: [normalize('Face')], weight: 400, width: 5,
    italic: false, fixed: false, postscriptName: 'Face', coverage: [] }
}

it('classifies every supported sfnt signature and rejects other containers', () => {
  expect(fontFileFormat(Buffer.from('ttcf'))).toBe('ttc')
  expect(fontFileFormat(Buffer.from('OTTO'))).toBe('otf')
  expect(fontFileFormat(Buffer.from('true'))).toBe('ttf')
  expect(fontFileFormat(Buffer.from([0, 1, 0, 0]))).toBe('ttf')
  expect(() => fontFileFormat(Buffer.from('wOFF'))).toThrow(/not an sfnt/)
})

it('retains complete original font bytes and deduplicates PDF preload assets', () => {
  const bytes = Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(32)])
  const selected = face(bytes)
  expect(fullFontFile(selected)).toMatchObject({ bytes, format: 'otf' })
  vi.spyOn(SystemFontCatalog.prototype, 'match').mockReturnValue({ fonts: [selected] })
  const install = vi.fn()
  preloadPdfFonts(resolveOptions({ initialFontFamilies: ['Face', 'Face'], fontFallbacks: [], maxLoadedFontBytes: bytes.length }),
    [selected], install)
  expect(install).toHaveBeenCalledOnce()
  expect(install.mock.calls[0]![0]).toMatch(/\.otf$/)
  expect(() => preloadPdfFonts(resolveOptions({ initialFontFamilies: ['Face'], fontFallbacks: [], maxLoadedFontBytes: 1 }),
    [selected], vi.fn())).toThrow(/maxLoadedFontBytes/)
})

it('counts identical bytes from separate font paths only once', () => {
  const bytes = Buffer.concat([Buffer.from('OTTO'), Buffer.alloc(32)])
  const first = face(bytes), second = face(bytes)
  vi.spyOn(SystemFontCatalog.prototype, 'match')
    .mockReturnValueOnce({ fonts: [first] })
    .mockReturnValueOnce({ fonts: [second] })
    .mockReturnValue({ fonts: [] })
  const install = vi.fn()
  preloadPdfFonts(resolveOptions({ initialFontFamilies: ['First', 'Second'], fontFallbacks: [], maxLoadedFontBytes: bytes.length }),
    [first, second], install)
  expect(install).toHaveBeenCalledOnce()
})
