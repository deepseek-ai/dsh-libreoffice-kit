/** Inventory refresh keeps parser, ordering, matching, and source failure behavior across cache paths. */
import { create } from 'fontkit'
import { fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { scanFontSnapshot } from '../src/font-snapshot.ts'
import { validateFontSnapshot } from '../src/font-snapshot-validation.ts'
import { writeFontMetadataCache } from '../src/font-metadata-cache.ts'
import { indexSystemFonts, SystemFontCatalog } from '../src/fonts.ts'
import { officeFontFiles } from '../src/office-fonts.ts'
import { resolveOptions } from '../src/options.ts'

vi.mock('fontkit', () => ({ create: vi.fn() }))
vi.mock('../src/office-fonts.ts', async original => ({ ...await original<typeof import('../src/office-fonts.ts')>(), officeFontFiles: vi.fn(() => []) }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, openSync: vi.fn(fs.openSync), fstatSync: vi.fn(fs.fstatSync), readSync: vi.fn(fs.readSync) }
})
const roots: string[] = []
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const font = (family = 'Fixture', style = 'Regular') => ({ familyName: family, subfamilyName: style, fullName: family,
  postscriptName: `${family}-${style}`, italicAngle: 0, 'OS/2': undefined, post: undefined,
  characterSet: [65], hasGlyphForCodePoint: (point: number) => point === 65 })
async function fixture() {
  const root = realpathSync(await mkdtemp(join(tmpdir(), 'kit-snapshot-'))); roots.push(root)
  const directory = join(root, 'fonts'); await mkdir(directory)
  const path = join(directory, 'fixture.ttf'); await writeFile(path, 'original')
  vi.mocked(create).mockImplementation(() => font())
  const options = resolveOptions({ fontDirectories: [directory], fontMetadataCacheDirectory: join(root, 'cache') })
  return { root, directory, path, options }
}

it('keeps ordered faces, selected fonts, and missing diagnostics identical on disk and memory hits', async () => {
  const { root, options } = await fixture()
  const cold = scanFontSnapshot(options)
  writeFontMetadataCache(options, cold.records, join(options.fontMetadataCacheDirectory as string, '.write'))
  vi.mocked(create).mockClear()
  const disk = scanFontSnapshot(options), memory = scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false }, cold.records)
  expect(create).not.toHaveBeenCalled()
  expect(disk).toEqual(cold); expect(memory).toEqual(cold)
  const match = (faces: typeof cold.faces) => new SystemFontCatalog({ faces, fallbackFamilies: [] }).match({
    family: 'Unavailable', style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: [65, 0x10ffff],
  }, new AbortController().signal)
  expect(match(disk.faces)).toEqual(match(cold.faces)); expect(match(memory.faces)).toEqual(match(cold.faces))
  await validateFontSnapshot(cold)
  await rm(root, { recursive: true }); await expect(validateFontSnapshot(cold)).rejects.toThrow('changed during conversion')
})

it.each(['ttf', 'otf', 'ttc', 'otc', 'dfont'])('caches every face of a .%s container through the original parser', async extension => {
  const { path, directory, options } = await fixture()
  await rename(path, join(directory, `multi.${extension}`))
  vi.mocked(create).mockReturnValue({ fonts: [font(), font('Fixture', 'Bold')] })
  const cold = scanFontSnapshot(options)
  expect(cold.faces.map(face => [face.faceIndex, face.style])).toEqual([[0, 'Regular'], [1, 'Bold']])
  vi.mocked(create).mockClear()
  expect(scanFontSnapshot(options, cold.records)).toEqual(cold)
  expect(create).not.toHaveBeenCalled()
})

it('retains same-name files, canonical duplicates and the original primary/Office budget and filtering', async () => {
  const { directory, path, options } = await fixture()
  const other = join(directory, 'other.ttf'); await writeFile(other, 'another!')
  const supplement = join(directory, 'office.ttf'); await writeFile(supplement, 'office!!')
  const rejected = join(directory, 'rejected.ttf'); await writeFile(rejected, 'rejected')
  vi.mocked(officeFontFiles).mockReturnValue([path, supplement, rejected])
  vi.mocked(create).mockImplementation(bytes => font(bytes.toString() === 'office!!' ? 'Calibri' : 'Fixture'))
  const selected = { ...options, fontDirectories: [path, path, other], includeOfficeFonts: true, maxFontFiles: 5 }
  const cold = scanFontSnapshot(selected)
  expect(cold.faces.map(face => face.path)).toEqual([path, other, supplement])
  expect(create).toHaveBeenCalledTimes(4)
  expect(cold.records).toHaveLength(4)
  vi.mocked(create).mockClear()
  expect(scanFontSnapshot(selected, cold.records)).toEqual(cold)
  expect(create).not.toHaveBeenCalled()
  expect(scanFontSnapshot({ ...selected, maxFontFiles: 2 }, cold.records).faces.map(face => face.path)).toEqual([path, other])
})

it('records parser rejection and empty collections, but rechecks file limits on a hit', async () => {
  const { options, path } = await fixture()
  vi.mocked(create).mockImplementationOnce(() => { throw new Error('damaged') })
  const damaged = scanFontSnapshot(options)
  expect(damaged.records[0]?.faces).toEqual([])
  vi.mocked(create).mockClear()
  expect(scanFontSnapshot(options, damaged.records)).toEqual(damaged)
  expect(create).not.toHaveBeenCalled()
  expect(scanFontSnapshot({ ...options, maxFontFileBytes: 1 }, damaged.records).records).toEqual([])
  await writeFile(path, 'changed-font')
  vi.mocked(create).mockReturnValueOnce({ fonts: [] })
  expect(scanFontSnapshot(options, damaged.records).records[0]?.faces).toEqual([])
  expect(create).toHaveBeenCalledOnce()
})

it('rejects a physical font changed between primary and supplemental discovery', async () => {
  const { options, path } = await fixture()
  vi.mocked(officeFontFiles).mockImplementation(() => {
    const status = statSync(path, { bigint: true }); status.size++
    vi.mocked(fstatSync).mockReturnValueOnce(status)
    return [path]
  })
  expect(() => scanFontSnapshot({ ...options, includeOfficeFonts: true })).toThrow('changed while indexing')
})

it('finds additions, deletions, same-size replacements, and renames without a TTL', async () => {
  const { options, directory, path } = await fixture()
  const initial = scanFontSnapshot(options)
  const added = join(directory, 'added.otf'); await writeFile(added, 'added')
  const addition = scanFontSnapshot(options, initial.records)
  expect(addition.records).toHaveLength(2); expect(addition.generation).not.toBe(initial.generation)
  await unlink(added)
  expect(scanFontSnapshot(options, addition.records)).toEqual(initial)
  const replacement = join(directory, 'replacement'); await writeFile(replacement, 'replaced'); await rename(replacement, path)
  const replaced = scanFontSnapshot(options, initial.records)
  expect(replaced.generation).not.toBe(initial.generation)
  expect(replaced.records[0]?.size).toBe(initial.records[0]?.size)
  await expect(validateFontSnapshot(initial)).rejects.toThrow('changed during conversion')
  await rename(path, added)
  expect(scanFontSnapshot(options, replaced.records).faces[0]?.path).toBe(added)
})

it('distinguishes file identifiers that collide as JavaScript numbers', async () => {
  const { options, path } = await fixture()
  const original = statSync(path, { bigint: true }), replacement = statSync(path, { bigint: true })
  original.ino = 2n ** 60n
  replacement.ino = original.ino + 1n
  expect(Number(original.ino)).toBe(Number(replacement.ino))
  vi.mocked(fstatSync).mockReturnValueOnce(original).mockReturnValueOnce(original)
  const initial = scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false })
  vi.mocked(create).mockClear()
  vi.mocked(fstatSync).mockReturnValueOnce(replacement).mockReturnValueOnce(replacement).mockReturnValueOnce(replacement)
  const replaced = scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false }, initial.records)
  expect(replaced.generation).not.toBe(initial.generation)
  expect(replaced.records[0]?.ino).toBe(replacement.ino.toString())
  expect(create).toHaveBeenCalledOnce()
})

it.skipIf(process.platform === 'win32')('rediscovers link targets and permission changes', async () => {
  const { options, path, root } = await fixture()
  const alias = join(root, 'linked.ttf'); await symlink(path, alias)
  const selected = { ...options, fontDirectories: [alias] }
  const before = scanFontSnapshot(selected)
  const next = join(root, 'next.ttf'); await writeFile(next, 'next font')
  await unlink(alias); await symlink(next, alias)
  expect(scanFontSnapshot(selected, before.records).faces[0]?.path).toBe(next)
  await chmod(path, 0o000)
  try {
    await expect(validateFontSnapshot(before)).rejects.toThrow('changed during conversion')
    if (process.getuid?.() !== 0) expect(scanFontSnapshot(options, before.records).records).toEqual([])
  } finally { await chmod(path, 0o600) }
  expect(scanFontSnapshot(options, before.records).faces).toHaveLength(1)
})

it('does not admit a cached file outside the newly configured inventory', async () => {
  const { options } = await fixture()
  const before = scanFontSnapshot(options)
  expect(scanFontSnapshot({ ...options, fontDirectories: [] }, before.records).records).toEqual([])
})

it.each(['ENOENT', 'EACCES', 'EIO'])('preserves %s source errors while revalidating cached metadata', async code => {
  const { options } = await fixture()
  const before = scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false })
  const failure = Object.assign(new Error('source failed'), { code })
  vi.mocked(openSync).mockImplementationOnce(() => { throw failure })
  const run = () => scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false }, before.records)
  if (code === 'EIO') expect(run).toThrow(failure)
  else expect(run().records).toEqual([])
  expect(scanFontSnapshot(options, before.records)).toEqual(before)
})

it('skips cached sources that stop being regular and rejects mutation during an uncached read', async () => {
  const { options, path } = await fixture()
  const before = scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false })
  const status = statSync(path, { bigint: true }); status.isFile = () => false
  vi.mocked(fstatSync).mockReturnValueOnce(status).mockReturnValueOnce(status)
  expect(indexSystemFonts({ directories: [path], maxFiles: 1, maxFileBytes: 1024 }, new Map(before.records.map(record => [record.path, record])))).toEqual([])
  vi.mocked(readSync).mockReturnValueOnce(0)
  expect(() => scanFontSnapshot({ ...options, fontMetadataCacheDirectory: false })).toThrow('truncated while indexing')
})

it('validates both disk options before an engine is created', () => {
  expect(resolveOptions({ fontMetadataCacheDirectory: false }).fontMetadataCacheDirectory).toBe(false)
  expect(resolveOptions().maxFontMetadataCacheBytes).toBe(32 * 1024 * 1024)
  for (const value of ['', 'relative', '/nul\0']) expect(() => resolveOptions({ fontMetadataCacheDirectory: value })).toThrow('absolute path or false')
  for (const value of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) expect(() => resolveOptions({ maxFontMetadataCacheBytes: value })).toThrow('positive safe integer')
})
