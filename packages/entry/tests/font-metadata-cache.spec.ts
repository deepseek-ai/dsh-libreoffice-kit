/** Derived metadata storage serves only records the current source files still validate. */
import { fstatSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultFontMetadataCacheDirectory, readFontMetadataCache, writeFontMetadataCache } from '../src/font-metadata-cache.ts'
import type { FontFace, FontFileMetadata } from '../src/fonts.ts'
import type { ResolvedOptions } from '../src/options.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fstatSync: vi.fn(actual.fstatSync),
    readSync: vi.fn(actual.readSync),
    renameSync: vi.fn(actual.renameSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})

/** Persisted format fields this package writes; changing either side of the contract updates this fixture. */
const VERSION = { format: 1, extractor: 1, fontkit: '2.0.4' }
const digestOf = (records: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(records)).digest('hex')

const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-font-cache-'))
  roots.push(directory)
  return directory
}

function cacheOptions(directory: string | false, maxFontMetadataCacheBytes = 4096):
Pick<ResolvedOptions, 'fontMetadataCacheDirectory' | 'maxFontMetadataCacheBytes'> {
  return { fontMetadataCacheDirectory: directory, maxFontMetadataCacheBytes }
}

/** One record whose identity matches the file at `path`. */
function recordFor(path: string): FontFileMetadata {
  const { dev, ino, size, mtimeMs, ctimeMs } = statSync(path)
  const face: FontFace = { path, dev, ino, size, mtimeMs, ctimeMs, faceIndex: 0, family: 'Fixture',
    style: 'Regular', aliases: ['fixture'], weight: 400, width: 5, italic: false, fixed: false,
    postscriptName: 'Fixture' }
  return { path, dev, ino, size, mtimeMs, ctimeMs, faces: [face] }
}

async function sourceFile(directory: string): Promise<FontFileMetadata> {
  const path = join(directory, 'face.ttf')
  await writeFile(path, 'font bytes')
  return recordFor(path)
}

/** Publish a cache whose digest matches its records, so rejections come from record validation alone. */
async function published(directory: string, records: readonly unknown[], version = VERSION): Promise<void> {
  await writeFile(join(directory, 'font-metadata.json'), JSON.stringify({ ...version, digest: digestOf(records), records }))
}

it('resolves the user cache directory for every supported platform', () => {
  expect(defaultFontMetadataCacheDirectory('darwin', '/home/user', {})).toBe('/home/user/Library/Caches/libreoffice-kit')
  expect(defaultFontMetadataCacheDirectory('win32', 'C:\\Users\\user', { LOCALAPPDATA: 'D:\\Local' }))
    .toBe(win32.join('D:\\Local', 'libreoffice-kit/Cache'))
  expect(defaultFontMetadataCacheDirectory('win32', 'C:\\Users\\user', {}))
    .toBe(win32.join('C:\\Users\\user', 'AppData/Local', 'libreoffice-kit/Cache'))
  expect(defaultFontMetadataCacheDirectory('linux', '/home/user', { XDG_CACHE_HOME: '/cache' })).toBe('/cache/libreoffice-kit')
  expect(defaultFontMetadataCacheDirectory('linux', '/home/user', { XDG_CACHE_HOME: 'relative' })).toBe('/home/user/.cache/libreoffice-kit')
  expect(defaultFontMetadataCacheDirectory('linux', '/home/user', {})).toBe('/home/user/.cache/libreoffice-kit')
})

it('round-trips per-file records and leaves the published file in place', async () => {
  const directory = await root()
  const temporaryPath = join(directory, '.pending')
  const record = await sourceFile(directory)
  writeFontMetadataCache(cacheOptions(directory), [record], temporaryPath)
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([record])
  await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('ignores its cache when the caller disables persistence', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  await published(directory, [record])
  expect(readFontMetadataCache(cacheOptions(false))).toEqual([])
  writeFontMetadataCache(cacheOptions(false), [record], join(directory, '.pending'))
  await expect(stat(join(directory, '.pending'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('treats an absent, unreadable, or non-file cache as a miss', async () => {
  const directory = await root()
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
  await mkdir(join(directory, 'font-metadata.json'))
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
  vi.mocked(fstatSync).mockImplementationOnce(() => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) })
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
})

it('rejects a cache larger than the configured byte limit', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  await published(directory, [record])
  expect(readFontMetadataCache(cacheOptions(directory, 8))).toEqual([])
})

it('rejects a cache that truncates or changes while it is read', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  await published(directory, [record])
  vi.mocked(readSync).mockReturnValueOnce(0)
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
  vi.resetAllMocks()
  const before = statSync(join(directory, 'font-metadata.json'))
  const after = statSync(join(directory, 'font-metadata.json'))
  after.mtimeMs = before.mtimeMs + 1
  vi.mocked(fstatSync).mockImplementationOnce(() => before).mockImplementationOnce(() => after)
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
})

it.each([
  ['invalid JSON', '{not json'],
  ['a non-object payload', 'null'],
  ['an array payload', '[]'],
  ['a missing record list', JSON.stringify(VERSION)],
  ['a newer format', JSON.stringify({ ...VERSION, format: 2, records: [] })],
  ['another extractor', JSON.stringify({ ...VERSION, extractor: 2, records: [] })],
  ['another parser', JSON.stringify({ ...VERSION, fontkit: '2.0.5', records: [] })],
])('treats %s as a miss', async (_label, contents) => {
  const directory = await root()
  await writeFile(join(directory, 'font-metadata.json'), contents)
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
})

it('accepts a record without faces and rejects a duplicated physical path', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  await published(directory, [{ ...record, faces: [] }])
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([{ ...record, faces: [] }])
  await published(directory, [record, record])
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
})

it('accepts a face whose postscript name is absent', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  const faces = [{ ...record.faces[0]!, postscriptName: null }]
  await published(directory, [{ ...record, faces }])
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([{ ...record, faces }])
})

/** One cached record the reader must reject, derived from a valid record by `mutate`. */
type Mutation = (record: FontFileMetadata) => unknown

it.each<[string, Mutation]>([
  ['a non-object record', () => 7],
  ['unrecorded fields', record => ({ ...record, document: 'not metadata' })],
  ['a non-string path', record => ({ ...record, path: 7 })],
  ['a path holding a NUL', record => ({ ...record, path: `${record.path}\0.ttf` })],
  ['a relative path', record => ({ ...record, path: 'face.ttf' })],
  ['a non-numeric identity field', record => ({ ...record, size: '4' })],
  ['a non-finite identity field', record => ({ ...record, dev: Number.NaN })],
  ['a fractional size', record => ({ ...record, size: 1.5 })],
  ['a negative size', record => ({ ...record, size: -1 })],
  ['a non-array face list', record => ({ ...record, faces: 'none' })],
  ['a non-object face', () => ({ faces: [7] })],
  ['a face naming another file', record => ({ ...record, faces: [{ ...record.faces[0]!, path: '/other.ttf' }] })],
  ['a face with another identity', record => ({ ...record, faces: [{ ...record.faces[0]!, size: -1 }] })],
  ['a face at another index', record => ({ ...record, faces: [{ ...record.faces[0]!, faceIndex: 1 }] })],
  ['a face without a family', record => ({ ...record, faces: [{ ...record.faces[0]!, family: null }] })],
  ['a family holding a NUL', record => ({ ...record, faces: [{ ...record.faces[0]!, family: 'Fi\0xture' }] })],
  ['a face without a style', record => ({ ...record, faces: [{ ...record.faces[0]!, style: 7 }] })],
  ['a non-array alias list', record => ({ ...record, faces: [{ ...record.faces[0]!, aliases: 'fixture' }] })],
  ['a non-string alias', record => ({ ...record, faces: [{ ...record.faces[0]!, aliases: [7] }] })],
  ['an alias holding a NUL', record => ({ ...record, faces: [{ ...record.faces[0]!, aliases: ['fi\0xture'] }] })],
  ['a non-numeric weight', record => ({ ...record, faces: [{ ...record.faces[0]!, weight: '400' }] })],
  ['a non-finite width', record => ({ ...record, faces: [{ ...record.faces[0]!, width: Number.POSITIVE_INFINITY }] })],
  ['a non-boolean italic flag', record => ({ ...record, faces: [{ ...record.faces[0]!, italic: 0 }] })],
  ['a non-boolean fixed flag', record => ({ ...record, faces: [{ ...record.faces[0]!, fixed: 0 }] })],
  ['a non-string postscript name', record => ({ ...record, faces: [{ ...record.faces[0]!, postscriptName: 7 }] })],
  ['an unrecorded face field', record => ({ ...record, faces: [{ ...record.faces[0]!, extra: true }] })],
])('rejects a record with %s', async (_label, mutate) => {
  const directory = await root()
  const record = await sourceFile(directory)
  await published(directory, [mutate(record)])
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([])
})

it('keeps the inspected snapshot when persistence is unavailable', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  const blocked = join(directory, 'blocked')
  await writeFile(blocked, 'not a directory')
  writeFontMetadataCache(cacheOptions(blocked), [record], join(directory, '.pending'))
  await expect(stat(join(directory, '.pending'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('skips records that exceed the byte limit and records already published unchanged', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  writeFontMetadataCache(cacheOptions(directory, 8), [record], join(directory, '.pending'))
  await expect(stat(join(directory, 'font-metadata.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  writeFontMetadataCache(cacheOptions(directory), [record], join(directory, '.pending'))
  vi.mocked(renameSync).mockClear()
  writeFontMetadataCache(cacheOptions(directory), [record], join(directory, '.repeat'))
  expect(renameSync).not.toHaveBeenCalled()
  await expect(stat(join(directory, '.repeat'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(readFontMetadataCache(cacheOptions(directory))).toEqual([record])
})

it('removes its temporary file after a failed write or publish', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  const temporaryPath = join(directory, '.pending')
  vi.mocked(writeFileSync).mockImplementationOnce(() => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }) })
  writeFontMetadataCache(cacheOptions(directory), [record], temporaryPath)
  await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  vi.mocked(renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('publish failed'), { code: 'EACCES' }) })
  writeFontMetadataCache(cacheOptions(directory), [record], temporaryPath)
  await expect(stat(temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(join(directory, 'font-metadata.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves an unremovable temporary file to its owner', async () => {
  const directory = await root()
  const record = await sourceFile(directory)
  const temporaryPath = join(directory, '.pending')
  vi.mocked(writeFileSync).mockImplementationOnce(() => { throw new Error('disk full') })
  vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error('unlink denied') })
  writeFontMetadataCache(cacheOptions(directory), [record], temporaryPath)
  expect((await stat(temporaryPath)).isFile()).toBe(true)
})

it.skipIf(process.platform === 'win32')('creates the cache directory and file with private POSIX permissions', async () => {
  const parent = await root()
  const directory = join(parent, 'nested', 'kit')
  const record = await sourceFile(parent)
  writeFontMetadataCache(cacheOptions(directory), [record], join(parent, '.pending'))
  expect((await stat(directory)).mode & 0o777).toBe(0o700)
  expect((await stat(join(directory, 'font-metadata.json'))).mode & 0o777).toBe(0o600)
})

it('publishes a valid empty snapshot instead of preserving a missing or corrupt cache', async () => {
  const directory = await root()
  writeFontMetadataCache(cacheOptions(directory), [], join(directory, '.pending'))
  expect(JSON.parse(await readFile(join(directory, 'font-metadata.json'), 'utf8')).records).toEqual([])
  await writeFile(join(directory, 'font-metadata.json'), 'broken')
  writeFontMetadataCache(cacheOptions(directory), [], join(directory, '.pending'))
  expect(JSON.parse(await readFile(join(directory, 'font-metadata.json'), 'utf8')).records).toEqual([])
})
