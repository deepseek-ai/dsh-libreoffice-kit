/** Conversion-local font imports and exact-family diagnostics. */
import { extname } from 'node:path'
import { SystemFontCatalog, normalize, readFont } from './fonts.ts'
import type { FontFace, FontMatchRequest, FontMatchResult } from './fonts.ts'
import type { DocumentFontMetadata } from './ooxml.ts'
import type { ResolvedOptions } from './options.ts'

/** Missing-family choices the native helper writes into its private profile. */
export interface FontSubstitution {
  readonly family: string
  /** Installed family selected for the missing one. */
  readonly substitute: string
}

/** Serializable font match state shared by compatible process-local converters. */
export interface FontResolutionCacheEntry {
  readonly key: string
  readonly codePoints: number[]
  readonly emptyRequest: boolean
  readonly faces: { readonly path: string; readonly faceIndex: number }[]
  readonly missingFamily?: string
}

/** One conversion's font imports: a serialized resolver plus its diagnostics. */
export interface FontLoader {
  /** Declared document families no installed face provides, in discovery order. */
  readonly missingFonts: string[]
  /** Missing families the catalog resolved to an installed substitute. */
  readonly substitutions: FontSubstitution[]
  /** Installed file paths this conversion received, deduplicated by origin. */
  readonly files: string[]
  /** Most-recently-used entries safe to merge into the process cache. */
  readonly cacheEntries: FontResolutionCacheEntry[]
  /**
   * @param request - VCL family/style attributes and the scalars it still needs.
   * @returns installed file paths for the selected faces.
   */
  resolve(request: FontMatchRequest): string[]
}

/**
 * Place installed original bytes where the engine can read them.
 * @param name - Unique file name within this conversion's font directory.
 * @param bytes - Complete original font bytes.
 * @returns the path the engine should read.
 */
export type FontInstaller = (name: string, bytes: Buffer) => string

const faceKey = (face: Pick<FontFace, 'path' | 'faceIndex'>): string => `${face.path}\0${face.faceIndex}`
const requestKey = ({ codePoints: _codePoints, ...request }: FontMatchRequest): string => JSON.stringify(request)

/** Build the metadata catalog inside a cancellable conversion worker. */
export function createFontLoader(options: ResolvedOptions, document: DocumentFontMetadata, install: FontInstaller,
  faces: readonly FontFace[], cache: readonly FontResolutionCacheEntry[] = []): FontLoader {
  const catalog = new SystemFontCatalog({ faces, fallbackFamilies: options.fontFallbacks })
  const byFace = new Map(faces.map(face => [faceKey(face), face]))
  const matches = new Map<string, FontResolutionCacheEntry>()
  for (const entry of cache.slice(-options.maxFontResolutionEntries)) matches.set(entry.key, {
    ...entry, codePoints: [...entry.codePoints], faces: entry.faces.map(face => ({ ...face })),
  })
  const loaded = new Map<string, string>()
  const resolved = new Map<string, string[]>()
  const missing = new Map<string, string>()
  const substitutions = new Map<string, FontSubstitution>()
  const signal = new AbortController().signal
  let bytes = 0

  function retain(entry: FontResolutionCacheEntry): void {
    matches.delete(entry.key)
    matches.set(entry.key, entry)
    while (matches.size > options.maxFontResolutionEntries) matches.delete(matches.keys().next().value as string)
  }

  function cachedMatch(request: FontMatchRequest): FontMatchResult {
    const key = requestKey(request)
    const points = [...new Set(request.codePoints)].sort((left, right) => left - right)
    const prior = matches.get(key)
    if (prior && ((points.length === 0 && prior.emptyRequest)
      || points.every(point => prior.codePoints.includes(point)))) {
      retain(prior)
      return { fonts: prior.faces.map(reference => byFace.get(faceKey(reference))).filter((face): face is FontFace => face !== undefined),
        ...(prior.missingFamily === undefined ? {} : { missingFamily: prior.missingFamily }) }
    }
    const unknown = prior === undefined ? points : points.filter(point => !prior.codePoints.includes(point))
    const current = catalog.match({ ...request, codePoints: points.length === 0 ? [] : unknown }, signal)
    const references = new Map((prior?.faces ?? []).map(face => [faceKey(face), face]))
    for (const face of current.fonts) references.set(faceKey(face), { path: face.path, faceIndex: face.faceIndex })
    const missingFamily = prior?.missingFamily ?? current.missingFamily
    const entry: FontResolutionCacheEntry = {
      key,
      codePoints: [...new Set([...(prior?.codePoints ?? []), ...points])].sort((left, right) => left - right),
      emptyRequest: prior?.emptyRequest === true || points.length === 0,
      faces: [...references.values()],
      ...(missingFamily === undefined ? {} : { missingFamily }),
    }
    retain(entry)
    return { fonts: entry.faces.map(reference => byFace.get(faceKey(reference))).filter((face): face is FontFace => face !== undefined),
      ...(entry.missingFamily === undefined ? {} : { missingFamily: entry.missingFamily }) }
  }

  return {
    get missingFonts() { return [...missing.values()] },
    get substitutions() { return [...substitutions.values()] },
    get files() { return [...loaded.values()] },
    get cacheEntries() { return [...matches.values()] },
    resolve(request) {
      const key = JSON.stringify(request)
      const cached = resolved.get(key)
      if (cached) return cached
      const match = cachedMatch(request)
      if (match.missingFamily && document.families.has(normalize(match.missingFamily))) {
        const family = normalize(match.missingFamily)
        missing.set(family, match.missingFamily)
        if (match.fonts[0]) substitutions.set(family, { family: match.missingFamily, substitute: match.fonts[0].family })
      }
      const paths = match.fonts.map((face) => {
        const installed = loaded.get(face.path)
        if (installed !== undefined) return installed
        if (bytes + face.size > options.maxLoadedFontBytes) throw new Error('Imported fonts exceed maxLoadedFontBytes.')
        const path = install(`${loaded.size}${extname(face.path)}`, readFont(face))
        bytes += face.size
        loaded.set(face.path, path)
        return path
      })
      resolved.set(key, paths)
      return paths
    },
  }
}

/** Supply native imports and seed WASM's first usable default font. */
export function preloadFonts(loader: FontLoader, options: ResolvedOptions, document: DocumentFontMetadata, native = false): void {
  const families = [...options.initialFontFamilies, ...(native ? [...document.families.values()] : []), 'sans-serif']
  for (const family of families) loader.resolve({ family, style: '', weight: 5, italic: 0, width: 5, pitch: 0, language: '', codePoints: native ? document.codePoints : [] })
}

export { memoryFontConfig } from './font-config.ts'
