/** Font reads reject interrupted files and release every acquired descriptor. */
import { closeSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { create } from 'fontkit'
import { indexSystemFonts, readFont, type FontFace } from '../src/fonts.ts'

vi.mock('fontkit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fontkit')>()
  return { ...actual, create: vi.fn(actual.create) }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync: vi.fn(actual.closeSync),
    fstatSync: vi.fn(actual.fstatSync),
    openSync: vi.fn(actual.openSync),
    readdirSync: vi.fn(actual.readdirSync),
    readSync: vi.fn(actual.readSync),
    statSync: vi.fn(actual.statSync),
  }
})

const directories: string[] = []

afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fontFile(): Promise<FontFace> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-font-io-'))
  directories.push(directory)
  const path = join(directory, 'font.ttf')
  await writeFile(path, 'font bytes')
  const { dev, ino, size, mtimeMs, ctimeMs } = statSync(path)
  return {
    path, dev, ino, size, mtimeMs, ctimeMs,
    faceIndex: 0, family: 'Fixture', style: 'Regular', aliases: ['fixture'],
    weight: 400, width: 5, italic: false, fixed: false, postscriptName: 'Fixture-Regular',
  }
}

function index(path: string): FontFace[] {
  return indexSystemFonts({ directories: [path], maxFiles: 10, maxFileBytes: 1024 })
}

it('indexes each canonical font path once even when roots overlap', async () => {
  const face = await fontFile()
  expect(indexSystemFonts({ directories: [face.path, face.path], maxFiles: 1, maxFileBytes: 1024 })).toEqual([])
  expect(create).toHaveBeenCalledOnce()
})

it('skips nonregular sources and regular files without a font extension', async () => {
  const face = await fontFile()
  const status = statSync(face.path)
  status.isFile = () => false
  vi.mocked(statSync).mockReturnValueOnce(status)
  expect(index(face.path)).toEqual([])
  const text = join(face.path, '..', 'notes.txt')
  await writeFile(text, 'not a font')
  expect(index(text)).toEqual([])
  expect(openSync).not.toHaveBeenCalled()
})

it('retains physical face indices when decoding a font collection', async () => {
  const face = await fontFile()
  const font = (family: string) => ({
    familyName: family, fullName: family, postscriptName: `${family}-Regular`, subfamilyName: 'Regular',
    italicAngle: 0, 'OS/2': undefined, post: undefined, characterSet: [65], hasGlyphForCodePoint: () => true,
  })
  vi.mocked(create).mockReturnValueOnce({ fonts: [font('First'), font('Second')] })
  const canonical = realpathSync(face.path)
  expect(index(face.path)).toMatchObject([
    { family: 'First', faceIndex: 0, path: canonical },
    { family: 'Second', faceIndex: 1, path: canonical },
  ])
})

it.each(['ENOENT', 'EACCES'])('skips a directory that becomes unavailable with %s after stat', async (code) => {
  const face = await fontFile()
  const directory = join(face.path, '..', 'nested')
  await mkdir(directory)
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error('directory unavailable'), { code }) })
  expect(index(directory)).toEqual([])
  expect(openSync).not.toHaveBeenCalled()
})

it.each(['ENOENT', 'EACCES'])('skips a font that becomes unavailable with %s before opening', async (code) => {
  const face = await fontFile()
  vi.mocked(openSync).mockImplementationOnce(() => { throw Object.assign(new Error('font unavailable'), { code }) })
  expect(index(face.path)).toEqual([])
  expect(closeSync).not.toHaveBeenCalled()
})

it.each([undefined, { records: { fontFamily: { en: 'Fixture', undecoded: new Uint8Array([0xff]) }, fullName: { en: '' } } }])(
  'keeps usable font aliases when optional names are absent or undecoded', async (name) => {
    const face = await fontFile()
    vi.mocked(create).mockReturnValueOnce({
      ...(name === undefined ? {} : { name }), familyName: 'Fixture', fullName: null, postscriptName: null, subfamilyName: 'Regular',
      italicAngle: 0, 'OS/2': undefined, post: undefined, characterSet: [], hasGlyphForCodePoint: () => false,
    })
    expect(index(face.path)).toMatchObject([{ family: 'Fixture', aliases: ['fixture'], postscriptName: null }])
  },
)

it('propagates directory IO faults after enumeration has found the directory', async () => {
  const face = await fontFile()
  const directory = join(face.path, '..', 'nested')
  await mkdir(directory)
  const failure = Object.assign(new Error('directory IO failed'), { code: 'EIO' })
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw failure })
  expect(() => index(directory)).toThrow(failure)
  expect(openSync).not.toHaveBeenCalled()
})

it('rejects truncated files while indexing and closes their descriptors', async () => {
  const face = await fontFile()
  vi.mocked(readSync).mockReturnValueOnce(0)
  expect(() => index(face.path)).toThrow('truncated while indexing')
  expect(closeSync).toHaveBeenCalledOnce()
})

it.each(['size', 'mtimeMs', 'ctimeMs'] as const)('rejects an indexed file whose %s changes during reading', async (key) => {
  const face = await fontFile()
  const before = statSync(face.path)
  const after = statSync(face.path)
  // NTFS inode numbers can exceed Number.MAX_SAFE_INTEGER, where adding one is unchanged.
  after[key] = before[key] === 0 ? 1 : 0
  vi.mocked(fstatSync).mockReturnValueOnce(before).mockReturnValueOnce(after)
  expect(() => index(face.path)).toThrow('changed while indexing')
  expect(closeSync).toHaveBeenCalledOnce()
})

it('propagates file IO errors instead of treating them as absent fonts', async () => {
  const face = await fontFile()
  const failure = Object.assign(new Error('file IO failed'), { code: 'EIO' })
  vi.mocked(openSync).mockImplementationOnce(() => { throw failure })
  expect(() => index(face.path)).toThrow(failure)
  expect(closeSync).not.toHaveBeenCalled()
})

it('rejects truncation after matching an indexed font identity and closes the descriptor', async () => {
  const face = await fontFile()
  vi.mocked(readSync).mockReturnValueOnce(0)
  expect(() => readFont(face)).toThrow('An indexed font was truncated.')
  expect(closeSync).toHaveBeenCalledOnce()
})

it.each(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const)('rejects font %s mutation after reading', async (key) => {
  const face = await fontFile()
  const before = statSync(face.path)
  const after = statSync(face.path)
  // NTFS inode numbers can exceed Number.MAX_SAFE_INTEGER, where adding one is unchanged.
  after[key] = before[key] === 0 ? 1 : 0
  vi.mocked(fstatSync).mockReturnValueOnce(before).mockReturnValueOnce(after)
  expect(() => readFont(face)).toThrow('An indexed font changed while reading.')
  expect(closeSync).toHaveBeenCalledOnce()
})
