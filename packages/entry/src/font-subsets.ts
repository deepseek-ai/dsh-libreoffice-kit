/** Lifetime-scoped installed-font matching with deterministic, memory-bounded sfnt subsets. */
import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { extname } from 'node:path'
import { create } from 'fontkit'
import { indexSystemFonts, indexedFace, readFont, SystemFontCatalog } from './fonts.ts'
import type { FontFace, FontIndexOptions } from './fonts.ts'
import type { FontAsset, FontAssetId, FontResolution, FontResolveRequest } from './font-source-types.ts'
import { fontFileFormat, fullFontFile } from './font-full.ts'
import { FONT_SUBSET_VERSION, subsetFont } from './harfbuzz-subset.ts'
import { FONT_PARTITION_VERSION, fontScriptCodePoints, requestedFontScripts } from './unicode-scripts.ts'

/** Source limits and resolved family preferences passed to the private font Worker. */
export interface FontSubsetOptions extends FontIndexOptions {
  readonly fallbackFamilies: readonly (readonly string[])[]
  readonly maxCachedSubsetBytes: number
}
interface SelectedSubset {
  readonly asset: FontAsset
  readonly face: FontFace
  readonly script: string
  readonly sourceHash: string
  readonly key: string
}
const ALGORITHM = `${FONT_SUBSET_VERSION}/${FONT_PARTITION_VERSION}`
const STAT_KEYS = ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'] as const

function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function unchanged(face: FontFace): void {
  const status = statSync(face.path)
  if (!status.isFile() || STAT_KEYS.some(key => status[key] !== face[key])) throw new Error('The selected font changed; resolve it again.')
}
function fileIdentity(face: FontFace, wholeFile = false): string {
  return JSON.stringify([face.path, ...STAT_KEYS.map(key => face[key]), ...(wholeFile ? [] : [face.faceIndex])])
}

/** One Worker-owned font index and LRU whose byte budget excludes transient subsetting input/output. */
export class FontSubsetSource {
  private snapshot: readonly FontFace[] = []
  private catalog: SystemFontCatalog | undefined
  private readonly selected = new Map<FontAssetId, SelectedSubset>()
  private readonly partitions = new Map<string, SelectedSubset>()
  private readonly cached = new Map<string, Uint8Array>()
  private cachedBytes = 0

  /** @param options - Resolved discovery, fallback, and retained subset limits. */
  constructor(private readonly options: FontSubsetOptions) {}

  private retain(key: string, bytes: Uint8Array): void {
    const existing = this.cached.get(key)
    if (existing !== undefined) {
      this.cached.delete(key)
      this.cachedBytes -= existing.byteLength
    }
    if (bytes.byteLength > this.options.maxCachedSubsetBytes) return
    while (this.cachedBytes + bytes.byteLength > this.options.maxCachedSubsetBytes) {
      const oldest = this.cached.entries().next().value!
      this.cached.delete(oldest[0])
      this.cachedBytes -= oldest[1].byteLength
    }
    this.cached.set(key, bytes)
    this.cachedBytes += bytes.byteLength
  }

  private async generate(face: FontFace, script: string, expectedHash?: string): Promise<{ bytes: Uint8Array; sourceHash: string }> {
    if (script === 'full') {
      const result = fullFontFile(face)
      if (expectedHash !== undefined && result.sourceHash !== expectedHash) throw new Error('The selected font content changed.')
      unchanged(face)
      return result
    }
    const original = readFont(face)
    const sourceHash = hash(original)
    if (expectedHash !== undefined && sourceHash !== expectedHash) throw new Error('The selected font content changed.')
    const parsed = create(original)
    const physical = indexedFace(parsed, face)
    const points = await fontScriptCodePoints(physical.characterSet, script)
    // fontkit exposes each dfont resource as its own sfnt stream; HarfBuzz accepts TTC directly.
    const resource = 'fonts' in parsed && parsed.type === 'DFont'
    const bytes = await subsetFont(resource ? physical.stream.buffer : original, resource ? 0 : face.faceIndex, points)
    unchanged(face)
    return { bytes, sourceHash }
  }

  private async describe(face: FontFace, script: string): Promise<FontAsset> {
    unchanged(face)
    // TTC faces share original bytes; dfont resources and subsets remain face-specific.
    const partition = `${fileIdentity(face, script === 'full' && extname(face.path).toLowerCase() !== '.dfont')}/${script}`
    const previous = this.partitions.get(partition)
    if (previous !== undefined) {
      this.selected.set(previous.asset.id, previous)
      return { ...previous.asset, family: face.family, alias: script === 'full' ? face.family : previous.asset.alias }
    }
    const { bytes, sourceHash } = await this.generate(face, script)
    const id = `${script === 'full' ? 'full_' : ''}${hash(bytes)}` as FontAssetId
    const key = script === 'full' ? id : `${sourceHash}/${face.faceIndex}/${ALGORITHM}/${script}`
    const asset: FontAsset = { id, bytes: bytes.byteLength, family: face.family,
      alias: script === 'full' ? face.family : `DSH_${id}`,
      ...(script === 'full' ? { mode: 'full' as const, format: fontFileFormat(bytes) } : {}) }
    const selection = { asset, face, script, sourceHash, key }
    this.selected.set(id, selection)
    this.partitions.set(partition, selection)
    this.retain(key, bytes)
    return asset
  }

  /**
   * Select whole Unicode-script subsets from the source lifetime's installed-font snapshot.
   * @param request - Requested family/style attributes and Unicode scalars.
   * @returns reusable subset identities; unavailable characters remain unresolved.
   */
  async resolve(request: FontResolveRequest): Promise<FontResolution> {
    if (request.mode !== undefined && request.mode !== 'subset' && request.mode !== 'full') throw new TypeError('Unknown font asset mode.')
    if (this.catalog === undefined) {
      this.snapshot = indexSystemFonts(this.options)
      this.catalog = new SystemFontCatalog({ faces: this.snapshot, fallbackFamilies: this.options.fallbackFamilies, deduplicateBy: 'face' })
    }
    const matched = this.catalog.match(request, new AbortController().signal)
    const fonts: FontAsset[] = []
    for (const face of matched.fonts) {
      if (request.mode === 'full') { fonts.push(await this.describe(face, 'full')); continue }
      const points = request.codePoints.filter(point => face.coverage?.some(([first, last]) => point >= first && point <= last))
      for (const script of await requestedFontScripts(points)) {
        fonts.push(await this.describe(face, script))
      }
    }
    return { fonts, ...(matched.missingFamily === undefined ? {} : { missingFamily: matched.missingFamily }),
      ...(matched.unresolvedCodePoints === undefined ? {} : { unresolvedCodePoints: matched.unresolvedCodePoints }) }
  }

  /**
   * Return caller-owned bytes, regenerating an evicted subset from its unchanged original.
   * @param id - Subset identity previously returned by this source.
   * @returns sfnt bytes copied so a Worker transfer cannot detach the retained cache entry.
   */
  async read(id: FontAssetId): Promise<Uint8Array<ArrayBuffer>> {
    const selected = this.selected.get(id)
    if (selected === undefined) throw new Error('The font identity was not selected by this source.')
    unchanged(selected.face)
    let bytes = this.cached.get(selected.key)
    if (bytes === undefined) {
      bytes = (await this.generate(selected.face, selected.script, selected.sourceHash)).bytes
      if (`${selected.script === 'full' ? 'full_' : ''}${hash(bytes)}` !== id) throw new Error('The font subset identity changed during regeneration.')
    }
    this.retain(selected.key, bytes)
    return Uint8Array.from(bytes)
  }
}
