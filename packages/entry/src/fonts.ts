/** Host font metadata snapshots and conversion-local glyph matching over original files. */
import { closeSync, constants, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, posix, win32 } from 'node:path'
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
  readonly postscriptName: string | null
  /** Decoded glyph ranges; absent until a match reads this face's coverage. */
  coverage?: GlyphRange[]
}

/** VCL attributes LibreOffice requests one family for. */
export interface FontMatchRequest {
  readonly family: string
  readonly style: string
  readonly weight: number
  readonly italic: number
  readonly width: number
  readonly pitch: number
  readonly language: string
  readonly codePoints: readonly number[]
}

/** Selected physical files and the requested family the catalog could not find. */
export interface FontMatchResult {
  readonly fonts: FontFace[]
  readonly missingFamily?: string
}

/** One host font snapshot and the ordered fallback groups a conversion supplies. */
export interface SystemFontCatalogOptions {
  readonly faces: readonly FontFace[]
  readonly fallbackFamilies: readonly (readonly string[])[]
}

/** Host font roots and physical file limits. */
export interface FontIndexOptions {
  readonly directories: readonly string[]
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
 * Case- and separator-insensitive family key used to compare names across sources.
 * @param value - Family, style, or postscript name as recorded by a document or font.
 * @returns The normalized key.
 */
export function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replaceAll(/[\s_-]/g, '')
}
/**
 * Order named substitutions and their generic text family without excluding unlisted fonts.
 * @param requested - Original family names, in document order.
 * @param groups - Ordered family groups shared with Fontconfig aliases.
 * @param pitch - VCL pitch; one requests a monospaced fallback.
 * @param symbols - Whether symbol alternatives precede the generic fallback.
 * @returns distinct family names, with original requests first.
 */
export function fontFamilyPriority(requested: readonly string[], groups: readonly (readonly string[])[],
  pitch = 0, symbols = false): string[] {
  const original = requested.map(normalize)
  const matched = groups.filter(group => group.some(family => original.includes(normalize(family))))
  const generic = original.includes('monospace') || pitch === 1 ? 'monospace'
    : original.includes('serif') ? 'serif'
      : matched.flat().map(normalize).find(family => family === 'serif' || family === 'sansserif' || family === 'monospace') ?? 'sansserif'
  const families = [...requested, ...matched.flat()]
  for (const kind of symbols ? ['symbol', generic] : [generic]) {
    for (const group of groups) {
      if (group.some(family => normalize(family) === kind)) families.push(...group)
    }
  }
  const priority = new Map<string, string>()
  for (const family of families) {
    const name = normalize(family)
    if (!priority.has(name)) priority.set(name, family)
  }
  return [...priority.values()]
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
 * VCL weight, width, and fixed-pitch values for one parsed face.
 * @param font - The parsed physical face, whose `OS/2` and `post` tables may be absent.
 * @returns the recorded classes, or the regular defaults for an absent table.
 */
export function faceMetrics(font: Pick<Font, 'OS/2' | 'post'>): { weight: number; width: number; fixed: boolean } {
  const os2 = font['OS/2']
  return {
    weight: os2 === undefined ? 400 : os2.usWeightClass,
    width: os2 === undefined ? 5 : os2.usWidthClass,
    fixed: Boolean(font.post?.isFixedPitch),
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

function regionalPriority(face: FontFace, language: string): number {
  const locale = language.toLowerCase()
  const preferred = locale.startsWith('ja') ? ['jp'] : locale.startsWith('ko') ? ['kr']
    : locale.startsWith('zh') ? (/hant|tw|hk|mo/.test(locale) ? ['tc', 'hk'] : ['sc']) : []
  if (preferred.length === 0)
    return 0
  const name = `${face.family} ${face.postscriptName} ${basename(face.path)}`.toLowerCase()
  const region = name.match(/(?:cjk|[\s_-])(sc|tc|jp|kr|hk)(?=[\s_.-]|$)/)?.[1]
  return region === undefined ? 1 : preferred.includes(region) ? 0 : 2
}
/**
 * Snapshot eligible local font metadata without retaining font bytes or decoding glyph coverage.
 * @param options - Host font roots and physical file limits.
 * @returns metadata reused for the converter lifetime; recreate it after changing installed fonts.
 */
export function indexSystemFonts(options: FontIndexOptions): FontFace[] {
  return fontPaths(options.directories, options.maxFiles).flatMap(path => inspect(path, options.maxFileBytes))
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
     * Exact families precede configured alternatives, symbol families for missing symbols,
     * generic families, then other glyph-covering faces.
     * @param request - VCL family/style attributes and Unicode scalars missing from its current font.
     * @param signal - cancellation checked between synchronous font reads.
     * @returns selected physical files, deduplicated across collection faces; absent glyphs remain unresolved.
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
    const priority = fontFamilyPriority(requested, this.options.fallbackFamilies, request.pitch,
      request.codePoints.some(point => /\p{Symbol}/u.test(String.fromCodePoint(point)))).map(normalize)
    const missing = new Set(request.codePoints)
    const ranked = this.faces.map((face) => {
      const rank = priority.findIndex(family => face.aliases.includes(family))
      const region = regionalPriority(face, request.language)
      const style = (request.style && normalize(request.style) === normalize(face.style) ? -1 : 0)
                + (request.italic === 3 || (request.italic !== 0) === face.italic ? 0 : 100)
                + (request.pitch === 0 || (request.pitch === 1) === face.fixed ? 0 : 50)
                + Math.abs((VCL_WEIGHTS[request.weight] ?? 400) - face.weight) / 100
                + (request.width === 0 ? 0 : Math.abs(request.width - face.width))
      return { face, rank: rank < 0 ? priority.length : rank, region, style }
    }).sort((left, right) => left.rank - right.rank || left.region - right.region || left.style - right.style
            || left.face.path.localeCompare(right.face.path, 'en') || left.face.faceIndex - right.face.faceIndex)
    const selected = []
    const files = new Set()
    for (const { face } of ranked) {
      signal.throwIfAborted()
      const covered = covers(face, [...missing])
      if (missing.size > 0 && covered.length === 0)
        continue
      if (!files.has(face.path)) {
        selected.push(face)
        files.add(face.path)
      }
      for (const point of covered)
        missing.delete(point)
      if (missing.size === 0)
        break
    }
    return { fonts: selected, ...(missingFamily === undefined ? {} : { missingFamily }) }
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
