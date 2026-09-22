/** Revalidate physical font records and assemble the current ordered catalog. */
import { createHash } from 'node:crypto'
import { indexSystemFonts } from './fonts.ts'
import type { FontFace, FontFileMetadata } from './fonts.ts'
import { officeFontFace, officeFontFiles } from './office-fonts.ts'
import { readFontMetadataCache } from './font-metadata-cache.ts'
import type { ResolvedOptions } from './options.ts'

/** Immutable metadata handed to one operation; generation excludes document-specific matches. */
export interface FontSnapshot {
  readonly faces: FontFace[]
  readonly records: FontFileMetadata[]
  readonly generation: string
}

/** Re-enumerate all configured sources; only unchanged physical files skip inspection. */
export function scanFontSnapshot(options: ResolvedOptions, previous: readonly FontFileMetadata[] = []): FontSnapshot {
  const reusable = new Map([...readFontMetadataCache(options), ...previous].map(file => [file.path, file]))
  const observed = new Map<string, FontFileMetadata>()
  const primary = indexSystemFonts({ directories: options.fontDirectories, maxFiles: options.maxFontFiles,
    maxFileBytes: options.maxFontFileBytes }, reusable, observed)
  let faces = primary
  if (options.includeOfficeFonts) {
    const remaining = Math.max(0, options.maxFontFiles - new Set(primary.map(face => face.path)).size)
    if (remaining > 0) {
      const supplemental = indexSystemFonts({ directories: officeFontFiles().slice(0, remaining), maxFiles: remaining,
        maxFileBytes: options.maxFontFileBytes }, reusable, observed)
      const aliases = new Set(primary.flatMap(face => face.aliases))
      faces = [...primary, ...supplemental.filter(face => officeFontFace(face) && !face.aliases.some(alias => aliases.has(alias)))]
    }
  }
  return { faces, records: [...observed.values()], generation: createHash('sha256').update(JSON.stringify(faces)).digest('hex') }
}
