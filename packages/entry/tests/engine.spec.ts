import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { chmodSync, readFileSync } from 'node:fs'
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
    const engine = process.platform === 'linux' ? 'wasm' : platformTarget()
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
      const engine = process.platform === 'linux' ? 'wasm' : platformTarget()
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

describe('engine resolution', () => {
  it.each(['darwin', 'win32'])('%s never resolves WASM when its native package is missing', async platform => {
    const resolve = vi.fn((name: string): never => {
      throw Object.assign(new Error(`Cannot find module '${name}/package.json'`), { code: 'MODULE_NOT_FOUND' })
    })
    await expect(resolveEngine(resolve, () => false, { platform, arch: 'arm64' }))
      .rejects.toThrow(`Required LibreOfficeKit native package is missing: @deepseek-ai/libreoffice-kit-${platform}-arm64`)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(`@deepseek-ai/libreoffice-kit-${platform}-arm64`)
  })

  it.each([['darwin', 'riscv64'], ['win32', 'ia32'], ['freebsd', 'x64']])('rejects unsupported %s/%s without resolving an engine', async (platform, arch) => {
    const resolve = vi.fn()
    await expect(resolveEngine(resolve, () => false, { platform, arch })).rejects.toThrow('Unsupported LibreOfficeKit host')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('selects a resolved native engine and its recorded glibc floor', async () => {
    const fixture = await engineFixture()
    try {
      const report = vi.fn(() => ({ header: { glibcVersionRuntime: '2.39' } }))
      const engine = await resolveEngine(() => join(fixture.native, 'package.json'), () => true,
        { platform: 'linux', arch: 'arm64', report })
      expect(engine).toMatchObject({ backend: 'native', glibcMinimum: '2.38', executable: join(fixture.native, 'helper') })
      expect(report).toHaveBeenCalledOnce()
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('uses native without resolving WASM and rejects when no engine is installed', async () => {
    const fixture = await engineFixture()
    try {
      const nativeOnly = (name: string): string => {
        if (name.endsWith('-wasm')) throw new Error('WASM must not be resolved for a usable native engine')
        return join(fixture.native, 'package.json')
      }
      await expect(resolveEngine(nativeOnly, () => true,
        { platform: 'linux', arch: 'arm64', report: () => ({ header: { glibcVersionRuntime: '2.39' } }) }))
        .resolves.toMatchObject({ backend: 'native' })
      const missing = (name: string): never => {
        throw Object.assign(new Error(`Cannot find module '${name}/package.json'`), { code: 'MODULE_NOT_FOUND' })
      }
      await expect(resolveEngine(missing, () => false, { platform: 'linux', arch: 'riscv64' })).rejects.toThrow(/libreoffice-kit-wasm/)
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('Linux without a native development package uses WASM; corrupt native packages reject', async () => {
    const fixture = await engineFixture()
    try {
      let wasmResolutions = 0
      const absent = (name: string): string => {
        if (name.endsWith('-wasm')) { wasmResolutions++; return join(fixture.wasm, 'package.json') }
        throw Object.assign(new Error(`Cannot find module '${name}/package.json'`), { code: 'MODULE_NOT_FOUND' })
      }
      expect((await resolveEngine(absent, () => false, { platform: 'linux', arch: 'x64', report: () => ({ header: { glibcVersionRuntime: '2.39' } }) })).backend).toBe('wasm')
      expect(wasmResolutions).toBe(1)
      await expect(resolveEngine(() => join(fixture.wasm, 'package.json'), () => true,
        { platform: 'linux', arch: 'arm64', report: () => ({ header: { glibcVersionRuntime: '2.39' } }) }))
        .rejects.toThrow(/incompatible or incomplete/)
      await expect(resolveEngine(absent, () => true, { platform: 'linux', arch: 'x64', report: () => ({ header: { glibcVersionRuntime: '2.39' } }) })).rejects.toThrow(/package is incomplete/)
      await expect(resolveEngine(() => { throw Object.assign(new Error('Package exports is malformed'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' }) }))
        .rejects.toThrow(/malformed/)
      await expect(resolveEngine(() => { throw Object.assign(new Error('Cannot find module elsewhere'), { code: 'MODULE_NOT_FOUND' }) }))
        .rejects.toThrow(/elsewhere/)
      await expect(resolveEngine(() => { throw Object.assign(new Error('no message'), { code: 'MODULE_NOT_FOUND', message: undefined }) }))
        .rejects.toBeInstanceOf(Error)
      await writeFile(join(fixture.wasm, 'prebuilds.json'), JSON.stringify({ schemaVersion: 1, version: familyVersion, platform: 'wasm', status: 'unbuilt', engine: { kind: 'wasm' } }))
      await expect(resolveEngine(absent, () => false, { platform: 'linux', arch: 'x64' })).rejects.toThrow(/incompatible or incomplete/)
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('rejects every incomplete native manifest field in turn', async () => {
    const fixture = await engineFixture()
    const base = { schemaVersion: 1, version: familyVersion, platform: 'linux-arm64-glibc', status: 'built',
      engine: { kind: 'native', executable: 'helper', programDirectory: 'program', glibcMinimum: '2.38' } }
    const resolve = () => resolveEngine(() => join(fixture.native, 'package.json'), () => true,
      { platform: 'linux', arch: 'arm64', report: () => ({ header: { glibcVersionRuntime: '2.39' } }) })
    try {
      const invalid: Record<string, unknown>[] = [
        { ...base, engine: { ...base.engine, kind: 'wasm' } },
        { ...base, version: '0.0.0' },
        { ...base, schemaVersion: 2 },
        { ...base, status: 'unbuilt' },
        { ...base, platform: 'linux-x64-glibc' },
        { ...base, engine: undefined },
        { ...base, engine: { ...base.engine, executable: '/absolute/helper' } },
        { ...base, engine: { ...base.engine, executable: '../escape' } },
        { ...base, engine: { ...base.engine, executable: 'absent' } },
        { ...base, engine: { ...base.engine, programDirectory: 'absent' } },
        { ...base, engine: { ...base.engine, executable: 'program' } },
        { ...base, engine: { ...base.engine, programDirectory: 'helper' } },
        { ...base, engine: { ...base.engine, glibcMinimum: '2' } },
        { ...base, engine: { ...base.engine, glibcMinimum: '2.38', kind: 'wasm' } },
      ]
      for (const manifest of invalid) {
        await fixture.writeNative(manifest)
        await expect(resolve()).rejects.toThrow(/invalid|incomplete|no such file|escapes|is not a/)
      }
      await fixture.writeNative({ ...base, platform: 'linux-arm64-glibc', engine: { ...base.engine, glibcMinimum: undefined } })
      await expect(resolve()).resolves.toMatchObject({ backend: 'native' })
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('the WASM engine requires a complete asset set and a virtual program path', async () => {
    const fixture = await engineFixture()
    const resolve = () => resolveEngine(name => join(name.endsWith('-wasm') ? fixture.wasm : fixture.native, 'package.json'), () => true,
      { platform: 'linux', arch: 'riscv64', report: () => ({}) })
    try {
      await expect(resolve()).resolves.toMatchObject({ backend: 'wasm', programDirectory: '/instdir/program' })
      await rm(join(fixture.wasm, 'data'))
      await expect(resolve()).rejects.toThrow(/no such file/)
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })
})

describe('glibc floors', () => {
  const resolveWith = async (fixture: Awaited<ReturnType<typeof engineFixture>>, report: () => Record<string, unknown>) =>
    resolveEngine(name => join(name.endsWith('-wasm') ? fixture.wasm : fixture.native, 'package.json'), () => true,
      { platform: 'linux', arch: 'arm64', report })

  it('a known older glibc selects the installed WASM while equal and newer hosts use native', async () => {
    const fixture = await engineFixture()
    try {
      for (const version of ['2.17', '2.9', '2.37.9', '2.38', '2.39', '3.0']) {
        const expected = ['2.17', '2.9', '2.37.9'].includes(version) ? 'wasm' : 'native'
        expect((await resolveWith(fixture, () => ({ header: { glibcVersionRuntime: version } }))).backend, version).toBe(expected)
      }
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('older manifests remain readable and an unknown libc never selects a native ABI', async () => {
    const fixture = await engineFixture()
    try {
      await fixture.writeNative({ schemaVersion: 1, version: familyVersion, platform: 'linux-arm64-glibc', status: 'built',
        engine: { kind: 'native', executable: 'helper', programDirectory: 'program' } })
      expect((await resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.17' } }))).backend).toBe('native')
      expect((await resolveWith(fixture, () => ({ header: {}, sharedObjects: ['/lib/libc.so.6'] }))).backend).toBe('wasm')
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('patch components compare numerically with an omitted patch equal to zero', async () => {
    const fixture = await engineFixture()
    try {
      await fixture.writeNative({ schemaVersion: 1, version: familyVersion, platform: 'linux-arm64-glibc', status: 'built',
        engine: { kind: 'native', executable: 'helper', programDirectory: 'program', glibcMinimum: '2.2.5' } })
      expect((await resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.2' } }))).backend).toBe('wasm')
      expect((await resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.2.5' } }))).backend).toBe('native')
      expect((await resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.10' } }))).backend).toBe('native')
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('invalid glibc metadata and a mismatched package identity reject before fallback', async () => {
    const fixture = await engineFixture()
    try {
      for (const value of [null, 2.38, '', '2', '2.38.0.1', '02.38', '2.38 ', 'GLIBC_2.38', '9007199254740992.1']) {
        await fixture.writeNative({ schemaVersion: 1, version: familyVersion, platform: 'linux-arm64-glibc', status: 'built',
          engine: { kind: 'native', executable: 'helper', programDirectory: 'program', glibcMinimum: value } })
        await expect(resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.17' } }))).rejects.toThrow(/invalid glibcMinimum/)
      }
      await fixture.writeNative()
      await writeFile(join(fixture.native, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-linux-x64-glibc', version: familyVersion }))
      await expect(resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.17' } }))).rejects.toThrow(/incompatible or incomplete/)
      await writeFile(join(fixture.native, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-linux-arm64-glibc', version: familyVersion }))
      await rm(join(fixture.native, 'helper'))
      await expect(resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.17' } }))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('an older engine package rejects even when its manifest agrees with that version', async () => {
    const fixture = await engineFixture()
    try {
      await fixture.writeNative({ schemaVersion: 1, version: '0.1.0', platform: 'linux-arm64-glibc', status: 'built',
        engine: { kind: 'native', executable: 'helper', programDirectory: 'program', glibcMinimum: '2.38' } })
      await writeFile(join(fixture.native, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-linux-arm64-glibc', version: '0.1.0' }))
      await expect(resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.17' } }))).rejects.toThrow(/incompatible or incomplete/)
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('a non-executable helper and an unreadable engine manifest reject', async () => {
    const fixture = await engineFixture()
    try {
      if (process.platform !== 'win32') {
        chmodSync(join(fixture.native, 'helper'), 0o644)
        await expect(resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.39' } }))).rejects.toThrow(/not executable/)
      }
      chmodSync(join(fixture.native, 'helper'), 0o755)
      await writeFile(join(fixture.native, 'prebuilds.json'), 'not json')
      await expect(resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.39' } }))).rejects.toThrow(SyntaxError)
    } finally { await rm(fixture.directory, { recursive: true, force: true }) }
  })

  it('checks POSIX executable modes while Windows accepts its native file permissions', async () => {
    const fixture = await engineFixture()
    const host = process
    try {
      const status = await stat(join(fixture.native, 'helper'))
      status.mode = (status.mode & ~0o777) | 0o644
      for (const platform of ['linux', 'win32']) {
        vi.stubGlobal('process', { ...host, platform })
        vi.mocked(stat).mockResolvedValueOnce(status)
        const result = resolveWith(fixture, () => ({ header: { glibcVersionRuntime: '2.39' } }))
        if (platform === 'linux') await expect(result).rejects.toThrow(/not executable/)
        else await expect(result).resolves.toMatchObject({ backend: 'native' })
      }
    } finally {
      vi.unstubAllGlobals()
      vi.mocked(stat).mockReset()
      await rm(fixture.directory, { recursive: true, force: true })
    }
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
