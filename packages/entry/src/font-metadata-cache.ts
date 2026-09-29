/** Optional, bounded disk storage for derived font metadata; source reads remain authoritative. */
import { constants, openSync, fstatSync, readSync, closeSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { isAbsolute, join, posix, win32 } from 'node:path'
import type { FontFace, FontFileMetadata } from './fonts.ts'
import type { ResolvedOptions } from './options.ts'

type CacheOptions = Pick<ResolvedOptions, 'fontMetadataCacheDirectory' | 'maxFontMetadataCacheBytes'>
// Increment extractor when indexed fields or their derivation changes; parser stays pinned in package.json.
const VERSION = { format: 1, extractor: 2, fontkit: '2.0.4' }
const digest = (records: readonly FontFileMetadata[]): string => createHash('sha256').update(JSON.stringify(records)).digest('hex')

/** Resolve the platform's user-local cache, independently of font discovery. */
export function defaultFontMetadataCacheDirectory(platform = process.platform, home = homedir(), env = process.env): string {
  if (platform === 'darwin') return posix.join(home, 'Library/Caches/libreoffice-kit')
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData/Local'), 'libreoffice-kit/Cache')
  return posix.join(env.XDG_CACHE_HOME && posix.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : posix.join(home, '.cache'), 'libreoffice-kit')
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const text = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0')
const IDENTITY = ['size', 'mtimeMs', 'ctimeMs', 'dev', 'ino'] as const

function record(value: unknown): value is FontFileMetadata {
  if (!object(value) || !text(value.path) || !isAbsolute(value.path)
    || !['size', 'mtimeMs', 'ctimeMs'].every(key => finite(value[key]))
    || !['dev', 'ino'].every(key => typeof value[key] === 'string' && /^\d+$/.test(value[key])) || !Number.isSafeInteger(value.size) || Number(value.size) < 0
    || !Object.keys(value).every(key => ['path', ...IDENTITY, 'faces'].includes(key))
    || !Array.isArray(value.faces)) return false
  return value.faces.every((face: unknown, index: number): face is FontFace => object(face)
    && face.path === value.path && IDENTITY.every(key => face[key] === value[key])
    && face.faceIndex === index && text(face.family) && text(face.style)
    && Array.isArray(face.aliases) && face.aliases.every(text)
    && finite(face.weight) && finite(face.width) && typeof face.italic === 'boolean' && typeof face.fixed === 'boolean'
    && (face.postscriptName === null || text(face.postscriptName))
    && Object.keys(face).every(key => ['path', ...IDENTITY, 'faceIndex', 'family', 'style', 'aliases', 'weight', 'width', 'italic', 'fixed', 'postscriptName'].includes(key)))
}

/** Read validated records within the configured byte limit; unusable derived data is a cache miss. */
export function readFontMetadataCache(options: CacheOptions): FontFileMetadata[] {
  return readCache(options) ?? []
}

function readCache(options: CacheOptions): FontFileMetadata[] | undefined {
  if (options.fontMetadataCacheDirectory === false) return undefined
  try {
    const fd = openSync(join(options.fontMetadataCacheDirectory, 'font-metadata.json'), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    let bytes: Buffer
    try {
      const before = fstatSync(fd)
      if (!before.isFile() || before.size > options.maxFontMetadataCacheBytes) return undefined
      bytes = Buffer.alloc(before.size)
      for (let offset = 0; offset < bytes.length;) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (count === 0) return undefined
        offset += count
      }
      const after = fstatSync(fd)
      if (IDENTITY.some(key => before[key] !== after[key])) return undefined
    } finally { closeSync(fd) }
    const data: unknown = JSON.parse(bytes.toString('utf8'))
    if (!object(data) || data.format !== VERSION.format || data.extractor !== VERSION.extractor || data.fontkit !== VERSION.fontkit
      || !Object.keys(data).every(key => ['format', 'extractor', 'fontkit', 'digest', 'records'].includes(key))
      || !Array.isArray(data.records) || !data.records.every(record)) return undefined
    const records: FontFileMetadata[] = data.records
    return data.digest === digest(records) && new Set(records.map(file => file.path)).size === records.length ? records : undefined
  } catch {
    // Cache corruption, permissions, and IO errors never substitute stale metadata for source inspection.
    return undefined
  }
}

/** Atomically publish a bounded snapshot through a caller-owned unique temporary path. */
export function writeFontMetadataCache(options: CacheOptions, records: readonly FontFileMetadata[], temporaryPath: string): void {
  if (options.fontMetadataCacheDirectory === false) return
  let owned = false
  try {
    const bytes = JSON.stringify({ ...VERSION, digest: digest(records), records })
    if (Buffer.byteLength(bytes) > options.maxFontMetadataCacheBytes) return
    const existing = readCache(options)
    if (JSON.stringify(existing) === JSON.stringify(records)) return
    mkdirSync(options.fontMetadataCacheDirectory, { recursive: true, mode: 0o700 })
    const fd = openSync(temporaryPath, 'wx', 0o600)
    owned = true
    try { writeFileSync(fd, bytes) } finally { closeSync(fd) }
    renameSync(temporaryPath, join(options.fontMetadataCacheDirectory, 'font-metadata.json'))
    owned = false
  } catch {
    // Persistence is optional; the freshly inspected in-memory snapshot remains usable.
  } finally {
    if (owned) {
      try { unlinkSync(temporaryPath) } catch { /* The parent also removes this path after joining the Worker. */ }
    }
  }
}
