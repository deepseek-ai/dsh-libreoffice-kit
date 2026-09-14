import { expect, it } from 'vitest'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname } from 'node:path'
import {
  absent, faceCoverage, faceMetrics, fontFamilyPriority, indexSystemFonts, indexedFace, normalize, readFont,
  mobileAssetFontDirectories, systemFontDirectories, SystemFontCatalog,
} from '../src/fonts.ts'
import type { FontFace, FontMatchRequest } from '../src/fonts.ts'
import type { Font } from 'fontkit'
import { createFontLoader, memoryFontConfig, preloadFonts } from '../src/font-loader.ts'
import { resolveOptions } from '../src/options.ts'

function fontFace(family: string, characters: string, overrides: Partial<FontFace> = {}): FontFace {
  const coverage = Array.from(characters, character => [character.codePointAt(0) ?? 0, character.codePointAt(0) ?? 0] as [number, number])
  return { family, aliases: [normalize(family)], path: `${family}.ttf`, faceIndex: 0,
    postscriptName: family, style: 'Regular', weight: 400, width: 5, italic: false, fixed: false,
    size: 0, mtimeMs: 0, ctimeMs: 0, dev: 0, ino: 0, coverage, ...overrides }
}

function matchFonts(faces: FontFace[], family: string, options: Parameters<typeof resolveOptions>[0] = {},
  attributes: Partial<FontMatchRequest> = {}) {
  return new SystemFontCatalog({ faces, fallbackFamilies: resolveOptions(options).fontFallbacks })
    .match({ family, style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: 'zh-CN',
      codePoints: Array.from('A汉', character => character.codePointAt(0) ?? 0), ...attributes }, new AbortController().signal)
}

function fontMatchRequest(overrides: Partial<FontMatchRequest> = {}): FontMatchRequest {
  return { family: 'Face', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [], ...overrides }
}

/** Run `body` against a private directory removed afterwards. */
function withTemporaryDirectory(body: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'libreoffice-kit-fonts-'))
  try { body(root) } finally { rmSync(root, { recursive: true, force: true }) }
}

it('common text families choose matching CJK text faces before handwriting', () => {
  const faces = [fontFace('Hannotate SC', '汉', { path: '0-handwriting.ttc' }),
    fontFace('Arial', 'A'), fontFace('Carlito', 'A'), fontFace('Caladea', 'A'),
    fontFace('Times New Roman', 'A'), fontFace('Courier New', 'A', { fixed: true }),
    fontFace('PingFang SC', '汉'), fontFace('Songti SC', '汉'), fontFace('Noto Sans Mono CJK SC', '汉', { fixed: true })]
  for (const [family, expected] of [
    ['Calibri', ['Carlito', 'PingFang SC']], ['Calibri Light', ['Carlito', 'PingFang SC']],
    ['sans-serif', ['Arial', 'PingFang SC']], ['Cambria', ['Caladea', 'Songti SC']],
    ['serif', ['Times New Roman', 'Songti SC']], ['monospace', ['Courier New', 'Noto Sans Mono CJK SC']],
  ] as const) expect(matchFonts(faces, family).fonts.map(face => face.family), family).toEqual(expected)
})

it('explicit installed families precede substitutions, including handwriting', () => {
  const faces = [fontFace('Arial', 'A汉'), fontFace('Carlito', 'A汉'), fontFace('Calibri', 'A汉'), fontFace('Hannotate SC', 'A汉')]
  for (const family of ['Calibri', 'Hannotate SC']) {
    const result = matchFonts(faces, family)
    expect(result.fonts.map(face => face.family)).toEqual([family])
    expect(result.missingFamily).toBeUndefined()
  }
})

it('monospaced Latin uses common full-width CJK text before handwriting when CJK monospace is absent', () => {
  const faces = [fontFace('Courier New', 'A', { fixed: true }), fontFace('PingFang SC', '汉'),
    fontFace('Hannotate SC', '汉', { path: '0-handwriting.ttc' })]
  expect(matchFonts(faces, 'monospace').fonts.map(face => face.family)).toEqual(['Courier New', 'PingFang SC'])
})

it('Calibri Light and bold substitutions retain the requested weight', () => {
  const faces = [fontFace('Arial', 'A汉'), fontFace('Carlito', 'A汉', { path: 'carlito-regular.ttf' }),
    fontFace('Carlito', 'A汉', { path: 'carlito-light.ttf', weight: 300, style: 'Light' }),
    fontFace('Carlito', 'A汉', { path: 'carlito-bold.ttf', weight: 700, style: 'Bold' })]
  expect(matchFonts(faces, 'Calibri Light', {}, { weight: 3 }).fonts[0]?.weight).toBe(300)
  expect(matchFonts(faces, 'Calibri', {}, { weight: 8 }).fonts[0]?.weight).toBe(700)
})

it('configured groups replace defaults while unlisted glyph coverage remains available', () => {
  const faces = [fontFace('Arial', 'A'), fontFace('PingFang SC', '汉'), fontFace('Custom Text', 'A汉'), fontFace('Rare Script', '𐐀')]
  expect(matchFonts(faces, 'sans-serif', { fontFallbacks: [['sans-serif', 'Custom Text']] }).fonts.map(face => face.family)).toEqual(['Custom Text'])
  expect(matchFonts(faces, 'sans-serif', {}, { codePoints: [0x10400] }).fonts.map(face => face.family)).toEqual(['Rare Script'])
  expect(matchFonts(faces, 'Custom Text', { fontFallbacks: [] }).fonts.map(face => face.family)).toEqual(['Custom Text'])
  expect(matchFonts([fontFace('Songti SC', 'A汉'), fontFace('PingFang SC', 'A汉')], 'Missing Serif', {
    fontFallbacks: [['Missing Serif', 'serif'], ['serif', 'Songti SC'], ['sans-serif', 'PingFang SC']],
  }).fonts.map(face => face.family)).toEqual(['Songti SC'])
})

it('font priority matches symbol, pitch, generic and deduplicated requests', () => {
  const groups = [['sans-serif', 'Arial'], ['serif', 'Serif Face'], ['monospace', 'Mono Face'], ['symbol', 'Symbol Face']]
  expect(fontFamilyPriority(['sans-serif'], groups, 1)).toEqual(['sans-serif', 'Arial', 'monospace', 'Mono Face'])
  expect(fontFamilyPriority(['Missing'], groups, 0, true)).toEqual(['Missing', 'symbol', 'Symbol Face', 'sans-serif', 'Arial'])
  expect(fontFamilyPriority(['Serif Face'], groups)).toEqual(['Serif Face', 'serif'])
  expect(fontFamilyPriority(['Arial', 'arial'], groups)).toEqual(['Arial', 'sans-serif'])
})

it('WASM aliases include the same metric and CJK alternatives as matching', () => {
  const xml = memoryFontConfig(resolveOptions().fontFallbacks)
  for (const [family, expected] of [
    ['Calibri', ['Carlito', 'PingFang SC']], ['Calibri Light', ['Carlito', 'PingFang SC']],
    ['Cambria', ['Caladea', 'Songti SC']], ['monospace', ['Courier New', 'Noto Sans Mono CJK SC']],
  ] as const) {
    const alias = xml.match(new RegExp(`<alias><family>${family}</family><accept>(.*?)</accept></alias>`))?.[1]
    expect(alias, family).toBeTruthy()
    const positions = expected.map(name => (alias ?? '').indexOf(`<family>${name}</family>`))
    expect(positions.every(index => index >= 0), `${family}: ${String(alias)}`).toBe(true)
    expect(positions[0] ?? 0, family).toBeLessThan(positions[1] ?? 0)
  }
  expect(xml).not.toContain('<prefer>')
  const requested = memoryFontConfig(resolveOptions().fontFallbacks, ['Microsoft YaHei'])
  expect(requested).toMatch(/<alias><family>Microsoft YaHei<\/family><accept>.*?<family>PingFang SC<\/family>/)
  expect(xml).not.toContain('<alias><family>Arial</family>')
  expect(memoryFontConfig([['A&B', 'Text <Regular>']])).toMatch(/<family>A&amp;B<\/family><accept><family>Text &lt;Regular&gt;<\/family>/)
})

it('font fallback options reject blank names and retain independent per-converter arrays', () => {
  for (const name of ['', ' ', '\t\n']) expect(() => resolveOptions({ fontFallbacks: [['sans-serif', name]] })).toThrow(/fontFallbacks/)
  const first = resolveOptions()
  first.fontFallbacks[0]?.push('Changed')
  expect(resolveOptions().fontFallbacks.every(group => !group.includes('Changed'))).toBe(true)
})

it('font directory defaults honor host platform paths', () => {
  expect(systemFontDirectories('win32', 'C:\\Users\\example', { SystemRoot: 'D:\\Windows', LOCALAPPDATA: 'D:\\Local' }))
    .toEqual(['D:\\Windows\\Fonts', 'D:\\Local\\Microsoft\\Windows\\Fonts'])
  expect(systemFontDirectories('linux', '/home/example', { XDG_DATA_DIRS: '/usr/share:/opt/share', XDG_DATA_HOME: '/data' }))
    .toEqual(['/usr/share/fonts', '/opt/share/fonts', '/home/example/.fonts', '/data/fonts'])
  expect(systemFontDirectories('linux', '/home/example', {})).toEqual(['/usr/local/share/fonts', '/usr/share/fonts', '/home/example/.fonts', '/home/example/.local/share/fonts'])
  expect(systemFontDirectories('win32', 'C:\\Users\\example', {})).toEqual(['C:\\Windows\\Fonts', 'C:\\Users\\example\\AppData\\Local\\Microsoft\\Windows\\Fonts'])
  // macOS font assets live only on macOS; a host without them still returns the fixed roots.
  expect(systemFontDirectories('darwin', '/Users/example').slice(0, 3))
    .toEqual(['/System/Library/Fonts', '/Library/Fonts', '/Users/example/Library/Fonts'])
})

it('macOS mobile font assets are discovered and sorted by name', () => {
  withTemporaryDirectory((root) => {
    const assets = join(root, 'AssetsV2')
    mkdirSync(assets)
    mkdirSync(join(assets, 'com_apple_MobileAsset_Font5'))
    mkdirSync(join(assets, 'com_apple_MobileAsset_Font2'))
    mkdirSync(join(assets, 'unrelated'))
    writeFileSync(join(assets, 'com_apple_MobileAsset_Font7'), 'not a directory')
    expect(mobileAssetFontDirectories(assets).map(path => path.slice(assets.length + 1)))
      .toEqual(['com_apple_MobileAsset_Font2', 'com_apple_MobileAsset_Font5', 'com_apple_MobileAsset_Font7'])
    expect(mobileAssetFontDirectories(join(root, 'absent'))).toEqual([])
    const loop = join(root, 'loop')
    symlinkSync(loop, loop)
    expect(() => mobileAssetFontDirectories(loop)).toThrow(/ELOOP/)
    rmSync(loop)
  })
})

it('known-absent filesystem failures are the only ones a font source tolerates', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code })
  expect(absent(errno('ENOENT'))).toBe(true)
  expect(absent(errno('ENOTDIR'))).toBe(true)
  expect(absent(errno('ELOOP'))).toBe(false)
  expect(absent(new Error('no code'))).toBe(false)
  expect(absent(null)).toBe(false)
  expect(absent('ENOENT')).toBe(false)
})

it('unreadable, missing, and non-font sources are skipped while real failures propagate', () => {
  withTemporaryDirectory((root) => {
    const loop = join(root, 'loop')
    symlinkSync(loop, loop)
    expect(() => indexSystemFonts({ directories: [loop], maxFiles: 1, maxFileBytes: 1 })).toThrow(/ELOOP/)
    // The self-referencing link survives only until this assertion; it cannot be removed recursively.
    rmSync(loop)
    expect(indexSystemFonts({ directories: [join(root, 'missing')], maxFiles: 1, maxFileBytes: 1 })).toEqual([])
    const parsed = join(root, 'not-a-font.ttf')
    writeFileSync(parsed, 'this is not a font')
    expect(indexSystemFonts({ directories: [root], maxFiles: 4, maxFileBytes: 1024 })).toEqual([])
    expect(indexSystemFonts({ directories: [parsed], maxFiles: 4, maxFileBytes: 1024 })).toEqual([])
    expect(indexSystemFonts({ directories: [root], maxFiles: 4, maxFileBytes: 4 })).toEqual([])
    const nested = join(root, 'nested')
    mkdirSync(nested)
    symlinkSync(parsed, join(nested, 'link.ttf'))
    expect(indexSystemFonts({ directories: [nested], maxFiles: 4, maxFileBytes: 1024 })).toEqual([])
  })
})

it('VCL metrics default for faces without OS/2 or post tables and glyph decoding can reject', () => {
  expect(faceMetrics({ 'OS/2': undefined, post: undefined })).toEqual({ weight: 400, width: 5, fixed: false })
  expect(faceMetrics({ 'OS/2': { usWeightClass: 700, usWidthClass: 3 }, post: { isFixedPitch: 1 } }))
    .toEqual({ weight: 700, width: 3, fixed: true })
  const damaged = { characterSet: [65], hasGlyphForCodePoint: () => { throw new Error('damaged cmap') } } as unknown as Font
  expect(faceCoverage(damaged)).toEqual([])
})

it('regional priority prefers the requested writing system and stays neutral otherwise', () => {
  const faces = [fontFace('Source Han Sans SC', 'A汉', { path: 'SourceHanSansSC-Regular.otf' }),
    fontFace('Source Han Sans TC', 'A汉', { path: 'SourceHanSansTC-Regular.otf' }),
    fontFace('Noto Sans JP', 'A汉', { path: 'NotoSansJP-Regular.otf' }),
    fontFace('Noto Sans KR', 'A汉', { path: 'NotoSansKR-Regular.otf' }),
    fontFace('Plain Face', 'A汉', { path: 'plain.ttf' })]
  const select = (language: string) => matchFonts(faces, 'Missing Family', { fontFallbacks: [] }, { language, codePoints: [65] }).fonts[0]?.family
  expect(select('ja-JP')).toBe('Noto Sans JP')
  expect(select('ko-KR')).toBe('Noto Sans KR')
  expect(select('zh-TW')).toBe('Source Han Sans TC')
  expect(select('zh-CN')).toBe('Source Han Sans SC')
  expect(select('en-US')).toBe('Noto Sans JP')
})

it('an indexed face is located inside its file or reported as replaced', () => {
  const parsed = { postscriptName: 'Kept Face' }
  expect(indexedFace(parsed as unknown as Parameters<typeof indexedFace>[0], { faceIndex: 0, postscriptName: 'Kept Face' }).postscriptName).toBe('Kept Face')
  expect(() => indexedFace(parsed as unknown as Parameters<typeof indexedFace>[0], { faceIndex: 0, postscriptName: 'Other Face' }))
    .toThrow(/no longer available/)
  expect(() => indexedFace({ fonts: [] }, { faceIndex: 3, postscriptName: 'Missing Face' })).toThrow(/no longer available/)
})

it('the directory component of an unreadable path is not a font source', () => {
  withTemporaryDirectory((root) => {
    const file = join(root, 'file')
    writeFileSync(file, 'text')
    expect(indexSystemFonts({ directories: [join(file, 'child')], maxFiles: 4, maxFileBytes: 1024 })).toEqual([])
  })
})

it('an unreadable directory is skipped instead of failing the catalog', () => {
  if (process.getuid?.() === 0) return
  withTemporaryDirectory((root) => {
    const blocked = join(root, 'blocked')
    mkdirSync(blocked)
    const unreadable = join(root, 'unreadable.ttf')
    writeFileSync(unreadable, 'not a font')
    // Restore the modes before cleanup: an unreadable directory cannot be removed recursively.
    try {
      chmodSync(blocked, 0o111)
      expect(indexSystemFonts({ directories: [root], maxFiles: 4, maxFileBytes: 1024 })).toEqual([])
      chmodSync(unreadable, 0o000)
      expect(indexSystemFonts({ directories: [root], maxFiles: 4, maxFileBytes: 1024 })).toEqual([])
    } finally {
      chmodSync(blocked, 0o700)
      chmodSync(unreadable, 0o600)
    }
  })
})

it('preloading resolves configured, declared, and default families for both engines', () => {
  withTemporaryDirectory((root) => {
    const path = join(root, 'fixture.ttf')
    writeFileSync(path, 'font bytes')
    const status = statSync(path)
    const faces = [fontFace('Fixture Face', 'A汉', { path, size: status.size, mtimeMs: status.mtimeMs,
      ctimeMs: status.ctimeMs, dev: status.dev, ino: status.ino })]
    const options = resolveOptions({ fontFallbacks: [], initialFontFamilies: ['Fixture Face'] })
    const document = { families: new Map([['declaredface', 'Declared Face']]), codePoints: [65] }
    const native = createFontLoader(options, document, name => name, faces)
    preloadFonts(native, options, document, true)
    expect(native.files).toEqual(['0.ttf'])
    preloadFonts(native, options, document)
    const wasm = createFontLoader(options, document, name => name, faces)
    preloadFonts(wasm, options, document)
    expect(wasm.files).toEqual(['0.ttf'])
  })
})

// Indexing every installed font is the slowest setup in this suite; shared runners need headroom.
it('glyph coverage decodes from a parsed face and deduplicates shared files', { timeout: 60_000 }, () => {
  const available = indexSystemFonts({ directories: systemFontDirectories(), maxFiles: 20_000, maxFileBytes: 256 * 1024 * 1024 })[0]
  if (available === undefined) return
  const decoded = { ...available }
  delete decoded.coverage
  const catalog = new SystemFontCatalog({ faces: [decoded], fallbackFamilies: [] })
  const matched = catalog.match(fontMatchRequest({ family: available.family, codePoints: [65] }), new AbortController().signal)
  expect(matched.fonts).toHaveLength(1)
  expect(matched.fonts[0]?.coverage?.length).toBeGreaterThan(0)
  const shared = { ...decoded, coverage: [[65, 65]] as [number, number][] }
  const second = { ...shared, coverage: [[66, 66]] as [number, number][], faceIndex: 1 }
  const deduplicated = new SystemFontCatalog({ faces: [shared, second], fallbackFamilies: [] })
  const deduplicatedMatch = deduplicated.match(fontMatchRequest({ family: available.family, codePoints: [65, 66] }),
    new AbortController().signal)
  expect(deduplicatedMatch.fonts).toHaveLength(1)
})

it('a ranked face that covers no requested glyph is skipped', () => {
  const faces = [fontFace('Requested Face', 'B')]
  const matched = new SystemFontCatalog({ faces, fallbackFamilies: [] })
    .match(fontMatchRequest({ family: 'Requested Face', codePoints: [65] }), new AbortController().signal)
  expect(matched.fonts).toEqual([])
  expect(matched.missingFamily).toBeUndefined()
})

it('style, weight, width, and pitch differences order the selected faces', () => {
  const faces = [fontFace('Style Face', 'A', { path: 'style-plain.ttf' }),
    fontFace('Style Face', 'A', { path: 'style-bold.ttf', style: 'Bold', weight: 700, width: 7, fixed: true })]
  const exact = matchFonts(faces, 'Style Face', { fontFallbacks: [] },
    { style: 'Regular', italic: 0, pitch: 0, weight: 5, width: 0 }).fonts[0]
  expect(exact?.path).toBe('style-plain.ttf')
  const symbol = matchFonts(faces, 'Style Face', { fontFallbacks: [] },
    { style: '', italic: 3, pitch: 1, weight: 11, width: 2 }).fonts[0]
  expect(symbol?.path).toBe('style-bold.ttf')
  const upright = matchFonts(faces, 'Style Face', { fontFallbacks: [] },
    { style: '', italic: 2, pitch: 0, weight: 5, width: 0 }).fonts[0]
  expect(upright?.path).toBe('style-plain.ttf')
})

it('missing families without a selected substitute record no substitution', () => {
  const options = resolveOptions({ fontFallbacks: [] })
  const document = { families: new Map([['missingonly', 'Missing Only']]), codePoints: [] }
  const loader = createFontLoader(options, document, name => name, [])
  expect(loader.resolve(fontMatchRequest({ family: 'Missing Only' }))).toEqual([])
  expect(loader.missingFonts).toEqual(['Missing Only'])
  expect(loader.substitutions).toEqual([])
})

it('reading a replaced, irregular, or truncated indexed font rejects', () => {
  withTemporaryDirectory((root) => {
    const path = join(root, 'face.ttf')
    writeFileSync(path, 'four')
    const stat = statSync(path)
    const face: FontFace = { path, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino,
      faceIndex: 0, family: 'Face', style: 'Regular', aliases: ['face'], weight: 400, width: 5, italic: false, fixed: false,
      postscriptName: 'Face', coverage: [] }
    expect(readFont(face).toString()).toBe('four')
    expect(() => readFont({ ...face, path: root })).toThrow(/changed/)
  })
})

it('font imports retain original bytes, enforce budgets, and reject stale snapshots', { timeout: 60_000 }, () => {
  const available = indexSystemFonts({ directories: systemFontDirectories(), maxFiles: 20_000, maxFileBytes: 256 * 1024 * 1024 })
  const source = available.find(face => /Arial|Liberation Sans|DejaVu Sans/.test(face.family)) ?? available[0]
  if (source === undefined) return
  withTemporaryDirectory((root) => {
    const path = join(root, `original${extname(source.path)}`)
    copyFileSync(source.path, path)
    const faces = indexSystemFonts({ directories: [root], maxFiles: 1, maxFileBytes: source.size })
    const installed = faces[0]
    if (installed === undefined) throw new Error('The copied font was not indexed.')
    const options = resolveOptions({ fontDirectories: [root], maxLoadedFontBytes: source.size })
    const document = { families: new Map([['unavailabletestfont', 'Unavailable Test Font']]), codePoints: [] }
    let installs = 0
    const install = (name: string, bytes: Buffer): string => {
      installs++
      expect(bytes).toEqual(readFont(installed))
      return name
    }
    const loader = createFontLoader(options, document, install, faces)
    const request = fontMatchRequest({ family: installed.family })
    expect(loader.resolve(request)).toEqual(loader.resolve(request))
    expect(installs).toBe(1)
    expect(loader.substitutions).toEqual([])
    loader.resolve({ ...request, family: 'Unavailable Test Font' })
    expect(loader.missingFonts).toEqual(['Unavailable Test Font'])
    expect(loader.substitutions).toEqual([{ family: 'Unavailable Test Font', substitute: installed.family }])
    loader.resolve({ ...request, family: 'Unrelated Engine Default' })
    loader.resolve({ ...request, family: 'sans-serif' })
    expect(loader.substitutions).toHaveLength(1)
    const bounded = createFontLoader({ ...options, maxLoadedFontBytes: source.size - 1 }, document, () => { throw new Error('Import must not start') }, faces)
    expect(() => bounded.resolve(request)).toThrow(/maxLoadedFontBytes/)
    expect(indexSystemFonts({ directories: [root], maxFiles: 1, maxFileBytes: source.size - 1 })).toEqual([])
    copyFileSync(source.path, join(root, `second${extname(source.path)}`))
    expect(() => indexSystemFonts({ directories: [root], maxFiles: 1, maxFileBytes: source.size })).toThrow(/maxFontFiles/)
    const catalog = new SystemFontCatalog({ faces, fallbackFamilies: [] })
    writeFileSync(path, 'changed')
    expect(() => readFont(installed)).toThrow(/changed/)
    expect(() => catalog.match({ ...request, codePoints: [65] }, new AbortController().signal)).toThrow(/changed/)
  })
})
