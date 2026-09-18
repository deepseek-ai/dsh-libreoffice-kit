import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { strToU8, unzipSync, zipSync } from 'fflate'
import { documentFixture } from './document-fixture.ts'
import { ENGINE_VERSION, installedPackageExists, platformTarget, resolveEngine } from '../src/engine.ts'
import { resolveOptions } from '../src/options.ts'
import { inspectDocument } from '../src/ooxml.ts'

const metadataProbe = vi.hoisted(() => ({ unbuiltPath: undefined as string | undefined }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: vi.fn(actual.stat),
    readFile: (...args: Parameters<typeof actual.readFile>) => args[0] === metadataProbe.unbuiltPath
      ? Promise.resolve('{"status":"unbuilt"}') : actual.readFile(...args),
  }
})

const familyVersion = (JSON.parse(readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8')) as { version: string }).version

/** One staged engine directory inside a private temporary root. */
interface EngineFixture {
  directory: string
  native: string
  wasm: string
  writeNative: (manifest?: Record<string, unknown>) => Promise<void>
}

async function engineFixture(): Promise<EngineFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'libreoffice-kit-engine-'))
  const native = join(directory, 'native')
  const wasm = join(directory, 'wasm')
  await mkdir(join(native, 'program'), { recursive: true })
  await mkdir(wasm)
  await writeFile(join(native, 'helper'), 'fixture', { mode: 0o755 })
  const manifest = () => ({ schemaVersion: 1, version: familyVersion, platform: 'linux-arm64-glibc', status: 'built',
    engine: { kind: 'native', executable: 'helper', programDirectory: 'program', glibcMinimum: '2.38' } })
  const writeNative = async (values: Record<string, unknown> = manifest()) => { await writeFile(join(native, 'prebuilds.json'), JSON.stringify(values)) }
  await writeNative()
  await writeFile(join(native, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-linux-arm64-glibc', version: familyVersion }))
  await writeFile(join(wasm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: familyVersion }))
  for (const file of ['loader', 'wasm', 'data', 'metadata']) await writeFile(join(wasm, file), 'fixture')
  await writeFile(join(wasm, 'prebuilds.json'), JSON.stringify({ schemaVersion: 1, version: familyVersion, platform: 'wasm', status: 'built', engine: {
    kind: 'wasm', loader: 'loader', wasm: 'wasm', data: 'data', metadata: 'metadata', programDirectory: '/instdir/program',
  } }))
  return { directory, native, wasm, writeNative }
}

describe('engine discovery', () => {
  it('the adapter pins the engine family version its manifests record', () => {
    expect(ENGINE_VERSION).toBe(familyVersion)
  })

  it('selects glibc and rejects unsupported libc or host architectures', () => {
    expect(platformTarget('linux', 'arm64', () => ({ header: { glibcVersionRuntime: '2.36' } }))).toBe('linux-arm64-glibc')
    expect(platformTarget('linux', 'x64', () => ({ header: {}, sharedObjects: ['/lib/ld-musl-x86_64.so.1'] }))).toBeUndefined()
    expect(platformTarget('linux', 'x64', () => ({ header: {}, sharedObjects: ['/lib/libc.so.6'] }))).toBeUndefined()
    expect(platformTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(platformTarget('freebsd', 'x64')).toBeUndefined()
    expect(platformTarget('linux', 'riscv64')).toBeUndefined()
  })

  it('finds an installed engine package on the real resolution path', () => {
    const engine = 'wasm'
    expect(installedPackageExists(`@deepseek-ai/libreoffice-kit-${engine}`)).toBe(true)
    expect(installedPackageExists('@deepseek-ai/libreoffice-kit-absent')).toBe(false)
    // A builtin name has no resolution paths, which never selects a native installation.
    expect(installedPackageExists('node:fs')).toBe(false)
  })

  it('reads the host diagnostic report with the default platform probe', async () => {
    const fixture = await engineFixture()
    try {
      const absent = (name: string): string => {
        if (name.endsWith('-wasm')) return join(fixture.wasm, 'package.json')
        throw Object.assign(new Error(`Cannot find module '${name}/package.json'`), { code: 'MODULE_NOT_FOUND' })
      }
      await expect(resolveEngine(absent, () => false, { platform: 'linux', arch: 'x64' })).resolves.toMatchObject({ backend: 'wasm' })
      // Keep the default package resolver test independent of locally staged payloads.
      const engine = 'wasm'
      const manifest = createRequire(import.meta.url).resolve(`@deepseek-ai/libreoffice-kit-${engine}/package.json`)
      metadataProbe.unbuiltPath = join(dirname(manifest), 'prebuilds.json')
      await expect(resolveEngine()).rejects.toThrow(/incompatible or incomplete/)
    } finally {
      metadataProbe.unbuiltPath = undefined
      await rm(fixture.directory, { recursive: true, force: true })
    }
  })
})

describe('document inspection', () => {
  it('rejects wrong membership and ZIP budgets, and reads declared fonts', () => {
    const bytes = documentFixture('汉字 Hello', 'Absent Family')
    const defaults = resolveOptions()
    const result = inspectDocument(bytes, 'docx', defaults)
    expect([...result.families.values()]).toEqual(['Absent Family'])
    expect(result.codePoints).toContain('汉'.codePointAt(0))
    expect(() => inspectDocument(bytes, 'xlsx', defaults)).toThrow(/xlsx/)
    expect(() => inspectDocument(bytes, 'docx', { ...defaults, maxArchiveEntries: 2 })).toThrow(/bounded OOXML/)
    expect(() => inspectDocument(bytes, 'docx', { ...defaults, maxUncompressedBytes: 10 })).toThrow(/bounded OOXML/)
    expect(() => inspectDocument(new Uint8Array([0, 1, 2]), 'docx', defaults)).toThrow(/bounded OOXML/)
  })

  it('excludes theme inventories and unresolved theme aliases from font notices', () => {
    const files = unzipSync(documentFixture('Visible content', 'Missing Content Face'))
    files['word/theme/theme1.xml'] = strToU8('<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:font typeface="Unused Theme Face"/></a:theme>')
    files['word/fontTable.xml'] = strToU8('<a:font xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="Font Inventory Only"/>')
    files['word/drawing.xml'] = strToU8('<a:rPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:latin typeface="+mn-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="Missing Drawing Face"/></a:rPr>')
    expect([...inspectDocument(zipSync(files), 'docx', resolveOptions()).families.values()])
      .toEqual(['Missing Content Face', 'Missing Drawing Face'])
  })

  it('ignores a damaged part and reads declared font names from an unparenthesized namespace', () => {
    const files = unzipSync(documentFixture('Damaged part', 'Kept Face'))
    files['word/broken.xml'] = strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:rFonts w:ascii=')
    expect([...inspectDocument(zipSync(files), 'docx', resolveOptions()).families.values()]).toEqual(['Kept Face'])
  })

  it('rejects an unsupported extension and reads spreadsheet family names', () => {
    const bytes = documentFixture('Sheet text', 'Word Face')
    expect(() => inspectDocument(bytes, 'txt', resolveOptions())).toThrow(/must be docx/)
    const files = unzipSync(bytes)
    files['xl/worksheets/sheet1.xml'] = strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><name val="Sheet Face"/></worksheet>')
    expect([...inspectDocument(zipSync(files), 'docx', resolveOptions()).families.values()]).toEqual(['Word Face', 'Sheet Face'])
  })

  it('decodes UTF-16 parts with a byte-order mark', () => {
    const files = unzipSync(documentFixture('Encoded parts', 'Base Face'))
    const encode = (text: string, bigEndian: boolean): Uint8Array => {
      const bytes = new Uint8Array(text.length * 2 + 2)
      bytes[0] = bigEndian ? 0xfe : 0xff
      bytes[1] = bigEndian ? 0xff : 0xfe
      for (let index = 0; index < text.length; index++) {
        const code = text.charCodeAt(index)
        bytes[2 + index * 2] = bigEndian ? code >> 8 : code & 0xff
        bytes[3 + index * 2] = bigEndian ? code & 0xff : code >> 8
      }
      return bytes
    }
    const part = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:rFonts w:ascii="LE Face"/></w:document>'
    const other = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:rFonts w:ascii="BE Face"/></w:document>'
    files['word/le.xml'] = encode(part, false)
    files['word/be.xml'] = encode(other, true)
    expect([...inspectDocument(zipSync(files), 'docx', resolveOptions()).families.values()])
      .toEqual(['Base Face', 'LE Face', 'BE Face'])
  })
})

describe('portable engine resolution', () => {
  it.each(['darwin', 'win32', 'linux'])('%s resolves only the required WASM package', async platform => {
    const fixture = await engineFixture()
    try {
      const resolver = vi.fn(() => join(fixture.wasm, 'package.json'))
      const report = vi.fn(() => ({ header: { glibcVersionRuntime: '2.17' } }))
      await expect(resolveEngine(resolver, () => true, { platform, arch: 'arm64', report }))
        .resolves.toMatchObject({ backend: 'wasm', programDirectory: '/instdir/program' })
      expect(resolver).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/libreoffice-kit-wasm')
      expect(report).not.toHaveBeenCalled()
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects unsupported OS without probing any engine', async () => {
    const resolver = vi.fn()
    await expect(resolveEngine(resolver, () => true, { platform: 'freebsd', arch: 'x64' })).rejects.toThrow('Unsupported LibreOfficeKit host')
    expect(resolver).not.toHaveBeenCalled()
  })

  it('missing or malformed WASM never tries a native engine', async () => {
    for (const error of [new Error('Missing WASM'), new SyntaxError('Malformed manifest')]) {
      const resolver = vi.fn((): never => { throw error })
      await expect(resolveEngine(resolver)).rejects.toBe(error)
      expect(resolver).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/libreoffice-kit-wasm')
    }
  })

  it('rejects incompatible manifests, escaped assets, and missing files', async () => {
    const fixture = await engineFixture()
    const file = join(fixture.wasm, 'prebuilds.json')
    const base = JSON.parse(readFileSync(file, 'utf8'))
    const resolve = () => resolveEngine(() => join(fixture.wasm, 'package.json'))
    try {
      for (const change of [{ version: '0.0.0' }, { schemaVersion: 2 }, { status: 'unbuilt' }, { platform: 'darwin-arm64' }, { engine: undefined }]) {
        await writeFile(file, JSON.stringify({ ...base, ...change }))
        await expect(resolve()).rejects.toThrow(/incompatible or incomplete/)
      }
      for (const loader of ['/tmp/loader', '../loader']) {
        await writeFile(file, JSON.stringify({ ...base, engine: { ...base.engine, loader } }))
        await expect(resolve()).rejects.toThrow(/invalid asset path|escapes/)
      }
      await writeFile(file, JSON.stringify(base))
      await rm(join(fixture.wasm, 'data'))
      await expect(resolve()).rejects.toThrow(/no such file/)
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })
})

describe('option validation', () => {
  it('rejects missing limits, timer overflow, unknown switches, and malformed lists', () => {
    expect(resolveOptions({ fontDirectories: [] }).maxImageResolution).toBe(144)
    for (const options of [{ maxInputBytes: 0 }, { timeoutMs: 2 ** 31 }, { maxOutputBytes: NaN }, { gpu: 'webgpu' }, { backend: 'wasm' }, { fontFallbacks: [[]] }]) {
      expect(() => resolveOptions(options)).toThrow()
    }
    expect(() => resolveOptions(null as unknown as Parameters<typeof resolveOptions>[0])).toThrow(/must be an object/)
    expect(() => resolveOptions('options' as unknown as Parameters<typeof resolveOptions>[0])).toThrow(/must be an object/)
    expect(() => resolveOptions([] as unknown as Parameters<typeof resolveOptions>[0])).toThrow(/must be an object/)
    expect(() => resolveOptions({ timeoutMs: 'fast' } as unknown as Parameters<typeof resolveOptions>[0])).toThrow(/positive safe integer/)
    expect(() => resolveOptions({ fontDirectories: ['ok', ''] })).toThrow(/nonempty strings/)
    expect(() => resolveOptions({ fontDirectories: 'root' } as unknown as Parameters<typeof resolveOptions>[0])).toThrow(/nonempty strings/)
    expect(() => resolveOptions({ fontDirectories: ['bad\0name'] })).toThrow(/nonempty strings/)
    expect(() => resolveOptions({ initialFontFamilies: [null] } as unknown as Parameters<typeof resolveOptions>[0]))
      .toThrow(/nonempty strings/)
    expect(resolveOptions({ initialFontFamilies: ['Face'] }).initialFontFamilies).toEqual(['Face'])
    expect(resolveOptions({ fontFallbacks: [['sans-serif', 'Face']] }).fontFallbacks).toEqual([['sans-serif', 'Face']])
  })
})

describe('error categories', () => {
  it('publishes only known categories and preserves causes', async () => {
    const { ConversionError, failureCode } = await import('../src/errors.ts')
    expect(failureCode(new ConversionError('timeout', 'late'))).toBe('timeout')
    expect(failureCode(Object.assign(new Error('x'), { code: 'unpublished' }))).toBe('failed')
    expect(failureCode(Object.assign(new Error('x'), { code: 42 }))).toBe('failed')
    expect(failureCode('nope')).toBe('failed')
    const cause = new Error('cause')
    expect(new ConversionError('failed', 'outer', { cause }).cause).toBe(cause)
    expect(new ConversionError('failed', 'outer').name).toBe('ConversionError')
  })
})
