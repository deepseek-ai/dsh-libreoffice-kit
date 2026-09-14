/** Conversion-local font imports and exact-family diagnostics. */
import { extname } from 'node:path'
import { SystemFontCatalog, fontFamilyPriority, normalize, readFont } from './fonts.ts'
import type { FontFace, FontMatchRequest } from './fonts.ts'
import type { DocumentFontMetadata } from './ooxml.ts'
import type { ResolvedOptions } from './options.ts'

/** Missing-family choices the native helper writes into its private profile. */
export interface FontSubstitution {
  readonly family: string
  /** Installed family selected for the missing one. */
  readonly substitute: string
}

/** One conversion's font imports: a serialized resolver plus its diagnostics. */
export interface FontLoader {
  /** Declared document families no installed face provides, in discovery order. */
  readonly missingFonts: string[]
  /** Missing families the catalog resolved to an installed substitute. */
  readonly substitutions: FontSubstitution[]
  /** Installed file paths this conversion received, deduplicated by origin. */
  readonly files: string[]
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

/** Build the metadata catalog inside a cancellable conversion worker. */
export function createFontLoader(options: ResolvedOptions, document: DocumentFontMetadata, install: FontInstaller,
  faces: readonly FontFace[]): FontLoader {
  const catalog = new SystemFontCatalog({ faces, fallbackFamilies: options.fontFallbacks })
  const loaded = new Map<string, string>()
  const resolved = new Map<string, string[]>()
  const missing = new Map<string, string>()
  const substitutions = new Map<string, FontSubstitution>()
  const signal = new AbortController().signal
  let bytes = 0
  return {
    get missingFonts() { return [...missing.values()] },
    get substitutions() { return [...substitutions.values()] },
    get files() { return [...loaded.values()] },
    resolve(request) {
      const key = JSON.stringify(request)
      const cached = resolved.get(key)
      if (cached) return cached
      const match = catalog.match(request, signal)
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

/**
 * Fontconfig XML restricts WASM discovery to imported originals in MEMFS.
 * @param families - Ordered family groups; the first name of each group is its canonical spelling.
 * @param requested - Additional family names the document declared.
 * @returns the fontconfig document written into the module's memory filesystem.
 */
export function memoryFontConfig(families: readonly (readonly string[])[], requested: Iterable<string> = []): string {
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  const names = [...new Map([...families.flatMap(group => group.slice(0, 1)), ...requested].map(name => [normalize(name), name])).values()]
  const aliases = names.map((name) => {
    const alternatives = fontFamilyPriority([name], families).filter(family => normalize(family) !== normalize(name))
    return `<alias><family>${escape(name)}</family><accept>${alternatives.map(family => `<family>${escape(family)}</family>`).join('')}</accept></alias>`
  })
  return `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>/dsh-fonts</dir><cachedir>/dsh/font-cache</cachedir>${aliases.join('')}</fontconfig>`
}
