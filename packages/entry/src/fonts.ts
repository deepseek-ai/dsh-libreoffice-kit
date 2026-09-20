/** Host font metadata snapshots and conversion-local glyph matching over original files. */
import { normalize } from './font-config.ts'
import { fontPreferences, fontRegion, fontScriptGroups } from './font-preferences.ts'
import type { FontMatchRequest } from './font-request.ts'
export type { FontMatchRequest } from './font-request.ts'
export { fontFamilyPriority, normalize } from './font-config.ts'
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { extname, join, posix, win32 } from 'node:path'
import { create } from 'fontkit'
import type { Font, FontCollection } from 'fontkit'

const FONT_EXTENSIONS: ReadonlySet<string> = new Set(['.ttf', '.otf', '.ttc', '.otc', '.dfont'])
const VCL_WEIGHTS = [400, 100, 200, 300, 350, 400, 500, 600, 700, 800, 900]
const GENERIC_FAMILIES: ReadonlySet<string> = new Set(['serif', 'sansserif', 'monospace', 'cursive', 'fantasy', 'systemui', 'symbol'])
/** File identity read from the descriptor, before and after, to detect concurrent replacement. */
const STAT_KEYS = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const

/** One inclusive Unicode range a physical face renders. */
export type GlyphRange = [number, number]

/** Metadata for one physical face, captured without retaining its bytes or glyph coverage. */
export interface FontFace {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  readonly ctimeMs: number
  readonly dev: number
  readonly ino: number
  readonly faceIndex: number
  readonly family: string
  readonly style: string
  readonly aliases: string[]
  readonly weight: number
  readonly width: number
  readonly italic: boolean
  readonly fixed: boolean
  /** OS/2 identifies a script or ornamental face; deprioritized only after named preferences. */
  readonly decorative: boolean
  readonly postscriptName: string | null
  /** Decoded glyph ranges; absent until a match reads this face's coverage. */
  coverage?: GlyphRange[]
}

/** Selected physical files and the requested family the catalog could not find. */
export interface FontMatchResult {
  readonly fonts: FontFace[]
  readonly missingFamily?: string
  /** Requested scalars no installed face covers. */
  readonly unresolvedCodePoints?: readonly number[]
}

/** One host font snapshot and the ordered fallback groups a conversion supplies. */
export interface SystemFontCatalogOptions {
  readonly faces: readonly FontFace[]
  readonly fallbackFamilies: readonly (readonly string[])[]
  /** Whole-file consumers deduplicate collections; subset consumers retain each selected face. */
  readonly deduplicateBy?: 'file' | 'face'
  /** Platform owning the indexed font snapshot; defaults to the current Host. */
  readonly platform?: string
}

/** Host font roots and physical file limits. */
export interface FontIndexOptions {
  readonly directories: readonly string[]
  readonly files?: readonly string[]
  readonly maxFiles: number
  readonly maxFileBytes: number
}

/**
 * @param error - Thrown filesystem value.
 * @returns whether it means the path is not a usable font source.
 */
export function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(String(error.code))
}

/**
 * Discover system and per-user font roots using the selected platform's path separators.
 * @param platform - Host operating system.
 * @param home - Host user home used to locate per-user font directories.
 * @param env - Host environment containing Windows and XDG directory overrides.
 * @returns candidate directories; missing platform directories are ignored during indexing.
 */
export function systemFontDirectories(platform = process.platform, home = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  if (platform === 'win32') {
    return [win32.join(env.SystemRoot ?? 'C:\\Windows', 'Fonts'),
      win32.join(env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')]
  }
  if (platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', posix.join(home, 'Library/Fonts'),
      ...mobileAssetFontDirectories('/System/Library/AssetsV2')]
  }
  const shared = (env.XDG_DATA_DIRS ?? '/usr/local/share:/usr/share').split(':').filter(Boolean)
  return [...new Set([...shared.map(path => posix.join(path, 'fonts')), posix.join(home, '.fonts'),
    posix.join(env.XDG_DATA_HOME ?? posix.join(home, '.local/share'), 'fonts')])]
}

/**
 * Font asset directories macOS publishes under its MobileAsset root.
 * @param assets - Absolute MobileAsset font directory root.
 * @returns matching asset directories, sorted by name.
 * @throws when the root exists but cannot be read for a reason other than its absence or protection.
 */
export function mobileAssetFontDirectories(assets: string): string[] {
  let entries: string[] = []
  try {
    entries = readdirSync(assets)
  }
  catch (error) {
    // Font assets may be unavailable or protected on an otherwise supported macOS installation.
    if (!absent(error))
      throw error
  }
  return entries.filter(name => /^com_apple_MobileAsset_Font\d*$/.test(name)).sort().map(name => join(assets, name))
}

function fontPaths(directories: readonly string[], maxFiles: number): string[] {
  const pending = [...directories].reverse()
  const visited = new Set<string>()
  const paths: string[] = []
  for (let path = pending.pop(); path !== undefined; path = pending.pop()) {
    let canonical: string
    let status: Stats
    try {
      canonical = realpathSync(path)
      status = statSync(canonical)
    }
    catch (error) {
      // Optional font directories, dangling font links, and protected assets are not usable sources.
      if (absent(error))
        continue
      throw error
    }
    if (visited.has(canonical))
      continue
    visited.add(canonical)
    if (status.isDirectory()) {
      let names: string[]
      try {
        names = readdirSync(canonical)
      }
      catch (error) {
        // Directory access can change after the successful stat.
        if (absent(error))
          continue
        throw error
      }
      pending.push(...names.sort().reverse().map(name => join(canonical, name)))
    }
    else if (status.isFile() && FONT_EXTENSIONS.has(extname(canonical).toLowerCase())) {
      if (paths.length >= maxFiles)
        throw new Error('The system font catalog exceeds maxFontFiles.')
      paths.push(canonical)
    }
  }
  return paths
}

function ranges(font: Font): GlyphRange[] {
  const points = font.characterSet.filter(point => font.hasGlyphForCodePoint(point)).sort((left, right) => left - right)
  const result: GlyphRange[] = []
  for (const point of points) {
    const last = result.at(-1)
    if (last !== undefined && point <= last[1] + 1)
      last[1] = Math.max(last[1], point)
    else
      result.push([point, point])
  }
  return result
}

/**
 * Decode glyph coverage for one parsed face.
 * @param font - The parsed physical face.
 * @returns the inclusive ranges the face renders, or none when its glyph tables reject decoding.
 */
export function faceCoverage(font: Font): GlyphRange[] {
  try {
    return ranges(font)
  }
  catch {
    // Lazy glyph decoding can reject damaged tables after the same font's metadata was accepted.
    return []
  }
}

/**
 * @param parsed - Parsed font file: one face, or a collection of faces.
 * @param face - Indexed metadata naming the face inside that file.
 * @returns the physical face the index names.
 * @throws when the file no longer provides the indexed face.
 */
export function indexedFace(parsed: Font | FontCollection, face: Pick<FontFace, 'faceIndex' | 'postscriptName'>): Font {
  const font = 'fonts' in parsed ? parsed.fonts[face.faceIndex] : parsed
  if (font === undefined || font.postscriptName !== face.postscriptName)
    throw new Error('The indexed font face is no longer available; recreate the converter.')
  return font
}

function covers(face: FontFace, points: readonly number[]): number[] {
  if (points.length === 0)
    return []
  if (face.coverage === undefined) {
    const parsed = create(readFont(face))
    face.coverage = faceCoverage(indexedFace(parsed, face))
  }
  const coverage = face.coverage
  return points.filter(point => coverage.some(([first, last]) => point >= first && point <= last))
}

/**
 * VCL metrics and OS/2 design classification for one parsed face.
 * @param font - The parsed physical face, whose `OS/2` and `post` tables may be absent.
 * @returns the recorded classes, or the regular defaults for an absent table.
 */
export function faceMetrics(font: Pick<Font, 'OS/2' | 'post'>): Pick<FontFace, 'weight' | 'width' | 'fixed' | 'decorative'> {
  const os2 = font['OS/2']
  // PANOSE family kinds 3/4 are script/decorative; IBM classes 9/10 are ornamental/script.
  const familyClass = (os2?.sFamilyClass ?? 0) >>> 8
  return {
    weight: os2 === undefined ? 400 : os2.usWeightClass,
    width: os2 === undefined ? 5 : os2.usWidthClass,
    fixed: Boolean(font.post?.isFixedPitch),
    decorative: [3, 4].includes(os2?.panose[0] ?? 0) || [9, 10].includes(familyClass),
  }
}

function inspect(path: string, maxBytes: number): FontFace[] {
  let status: Stats
  let bytes: Buffer
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      status = fstatSync(fd)
      if (!status.isFile() || status.size > maxBytes)
        return []
      bytes = Buffer.alloc(status.size)
      let offset = 0
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
        if (count === 0)
          throw new Error('A system font was truncated while indexing; reload the font service.')
        offset += count
      }
      const after = fstatSync(fd)
      if (after.size !== status.size
                || after.mtimeMs !== status.mtimeMs || after.ctimeMs !== status.ctimeMs) {
        throw new Error('A system font changed while indexing; reload the font service.')
      }
    }
    finally {
      closeSync(fd)
    }
  }
  catch (error) {
    // Installed font files may disappear or become protected between directory enumeration and reading.
    if (absent(error))
      return []
    throw error
  }
  let faces: FontFace[]
  try {
    const parsed = create(bytes)
    const fonts = 'fonts' in parsed ? parsed.fonts : [parsed]
    faces = fonts.map((font, faceIndex) => {
      const names = ['fontFamily', 'preferredFamily', 'fullName', 'postscriptName']
        .flatMap(key => Object.values(font.name?.records[key] ?? {}))
        .filter((name): name is string => typeof name === 'string')
      const aliases = [...new Set([...names, font.familyName, font.fullName, font.postscriptName]
        .filter((name): name is string => Boolean(name)).map(normalize))]
      return {
        path, size: status.size, mtimeMs: status.mtimeMs, ctimeMs: status.ctimeMs,
        dev: status.dev, ino: status.ino, faceIndex,
        family: font.familyName, style: font.subfamilyName, aliases,
        ...faceMetrics(font),
        italic: font.italicAngle !== 0, postscriptName: font.postscriptName,
      }
    })
  }
  catch {
    // fontkit rejects unsupported or damaged font tables; other installed files can still satisfy the request.
    return []
  }
  return faces
}

/**
 * Snapshot eligible local font metadata without retaining font bytes or decoding glyph coverage.
 * @param options - Host font roots and physical file limits.
 * @param previous - Optional prior snapshot whose unchanged physical files can reuse parsed metadata.
 * @returns current metadata; changed and newly installed files are decoded again.
 */
export function indexSystemFonts(options: FontIndexOptions, previous: readonly FontFace[] = []): FontFace[] {
  const reusable = new Map<string, FontFace[]>()
  for (const face of previous) {
    const group = reusable.get(face.path)
    if (group) group.push(face)
    else reusable.set(face.path, [face])
  }
  return fontPaths([...options.directories, ...(options.files ?? [])], options.maxFiles).flatMap((path) => {
    const prior = reusable.get(path)
    if (prior !== undefined) {
      let current: Stats
      try { current = statSync(path) } catch (error) {
        // A file may disappear or become protected between enumeration and refresh.
        if (absent(error)) return []
        throw error
      }
      if (current.isFile() && current.size <= options.maxFileBytes && STAT_KEYS.every(key => current[key] === prior[0]![key])) return prior
    }
    return inspect(path, options.maxFileBytes)
  })
}
/** Conversion-local glyph coverage over the converter's first metadata snapshot. */
export class SystemFontCatalog {
  private readonly options: SystemFontCatalogOptions
  private readonly faces: FontFace[]

  /**
     * @param options - Host metadata snapshot and fallback families.
     */
  constructor(options: SystemFontCatalogOptions) {
    this.options = options
    this.faces = options.faces.map(face => ({ ...face }))
  }
  /**
     * Find installed faces covering the requested family or missing characters.
     * Exact families and configured aliases precede script/region body preferences,
     * then other glyph-covering faces. Unlisted decorative Latin/CJK faces follow
     * body faces; normal cursive writing systems retain their typographic traditions.
     * @param request - VCL family/style attributes and Unicode scalars missing from its current font.
     * @param signal - cancellation checked between synchronous font reads.
     * @returns selected files or physical faces according to deduplicateBy; absent glyphs remain unresolved.
     * @throws if an indexed font changes or cannot be read during glyph matching.
     */
  match(request: FontMatchRequest, signal: AbortSignal): FontMatchResult {
    signal.throwIfAborted()
    const requested = request.family.split(';').map(family => family.trim()).filter(Boolean)
    const primary = requested[0]
    let missingFamily: string | undefined
    if (primary !== undefined && !GENERIC_FAMILIES.has(normalize(primary))
            && !this.faces.some(face => face.aliases.includes(normalize(primary)))) {
      missingFamily = primary
    }
    const groups = fontScriptGroups(request.codePoints)
    if (groups.size === 0) groups.set('Common', [])
    const selected: FontFace[] = []
    const files = new Set<string>()
    const unresolved: number[] = []
    for (const [script, points] of groups) {
      const preference = fontPreferences(request, this.options.fallbackFamilies, script, groups.keys(), this.options.platform)
      const missing = new Set(points)
      const ranked = this.faces.map((face) => {
        const explicit = preference.explicit.findIndex(name => face.aliases.includes(name))
        const rank = preference.candidates.findIndex(name => face.aliases.includes(name))
        const region = fontRegion(face.family)
        const locale = preference.region === undefined ? 0 : region === preference.region
          || (preference.region === 'hk' && region === 'tc') ? 0 : region === undefined ? 1 : 2
        const style = (request.style && normalize(request.style) === normalize(face.style) ? -1 : 0)
          + (request.italic === 3 || (request.italic !== 0) === face.italic ? 0 : 100)
          + (request.pitch === 0 || (request.pitch === 1) === face.fixed ? 0 : 50)
          + Math.abs((VCL_WEIGHTS[request.weight] ?? 400) - face.weight) / 100
          + (request.width === 0 ? 0 : Math.abs(request.width - face.width))
        return { face, explicit: explicit < 0 ? preference.explicit.length : explicit,
          region: explicit < 0 ? locale : 0, rank: explicit < 0 ? rank < 0 ? preference.candidates.length : rank : 0,
          decorative: explicit < 0 && preference.penalizeDecorative && face.decorative ? 1 : 0, style }
      }).sort((a, b) => a.explicit - b.explicit || a.region - b.region || a.rank - b.rank
        || a.decorative - b.decorative || a.style - b.style
        || a.face.path.localeCompare(b.face.path, 'en') || a.face.faceIndex - b.face.faceIndex)
      for (const { face } of ranked) {
        signal.throwIfAborted()
        const covered = covers(face, [...missing])
        if (missing.size > 0 && covered.length === 0) continue
        const identity = this.options.deduplicateBy === 'face' ? `${face.path}#${face.faceIndex}` : face.path
        if (!files.has(identity)) { selected.push(face); files.add(identity) }
        for (const point of covered) missing.delete(point)
        if (missing.size === 0) break
      }
      unresolved.push(...missing)
    }
    return { fonts: selected, ...(missingFamily === undefined ? {} : { missingFamily }),
      ...(unresolved.length === 0 ? {} : { unresolvedCodePoints: unresolved }) }
  }
}

/**
 * Read the unchanged indexed regular file; reject concurrent replacement or truncation.
 * @param face - Indexed face metadata whose identity and timestamps must still match the file.
 * @returns the complete original font bytes.
 * @throws when the file changed, was replaced, or was truncated since indexing.
 */
export function readFont(face: FontFace): Buffer {
  const fd = openSync(face.path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || STAT_KEYS.some(key => before[key] !== face[key]))
      throw new Error('An indexed font changed; recreate the converter.')
    const bytes = Buffer.alloc(face.size)
    for (let offset = 0; offset < bytes.length;) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count)
        throw new Error('An indexed font was truncated.')
      offset += count
    }
    const after = fstatSync(fd)
    if (STAT_KEYS.some(key => after[key] !== face[key]))
      throw new Error('An indexed font changed while reading.')
    return bytes
  }
  finally {
    closeSync(fd)
  }
}
