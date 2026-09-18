/** Installed font files exposed without disclosing Host filesystem paths. */
import type { FontMatchRequest } from './font-request.ts'

export type { FontMatchRequest } from './font-request.ts'

/** Full mode preserves font names, encoding and all glyphs for PDFium. */
export interface FontResolveRequest extends FontMatchRequest { readonly mode?: 'subset' | 'full' }

/** Content identity of one deterministic physical-face Unicode-script subset. */
export type FontAssetId = string & { readonly __fontAssetId: unique symbol }

/** A matched file available through the same font source lifetime. */
export interface FontAsset {
  readonly id: FontAssetId
  readonly bytes: number
  readonly family: string
  /** Browser-only VCL identity distinguishing subsets with the same original family/style. */
  readonly alias: string
  /** Full assets preserve original names; subset remains the default. */
  readonly mode?: 'full'
  readonly format?: 'ttf' | 'otf' | 'ttc'
}

/** Matched font subsets and an unavailable requested family, when applicable. */
export interface FontResolution {
  readonly fonts: readonly FontAsset[]
  readonly missingFamily?: string
  /** Scalars no installed font covers; distinct from a successfully substituted family. */
  readonly unresolvedCodePoints?: readonly number[]
}

/** Font discovery limits; omitted values use the Node converter's font defaults. */
export interface FontSourceOptions {
  readonly fontDirectories?: readonly string[]
  readonly fontFallbacks?: readonly (readonly string[])[]
  readonly maxFontFiles?: number
  readonly maxFontFileBytes?: number
  /** Retained subset bytes in the font Worker; defaults to 128 MiB. */
  readonly maxCachedSubsetBytes?: number
}

/** One lazily indexed Host font catalog with all CPU and file work in its Worker. */
export interface FontSource {
  /** Resolved ordered font family preferences shared with browser Fontconfig. */
  readonly fontFallbacks: readonly (readonly string[])[]
  /**
   * Select deterministic Unicode-script subsets using LibreOffice's requested attributes.
   * @param request - Family, style, language, and required Unicode scalars.
   * @param signal - Checked before dispatch and before publishing the result.
   * @returns subset content identities with no Host paths.
   */
  resolve(request: FontResolveRequest, signal?: AbortSignal): Promise<FontResolution>
  /**
   * Read or regenerate a selected subset while its original font remains unchanged.
   * @param id - Identity returned by resolve in this source lifetime.
   * @param signal - Checked before dispatch and before publishing the result.
   * @returns caller-owned subset sfnt bytes; changed or unknown files reject.
   */
  read(id: FontAssetId, signal?: AbortSignal): Promise<Uint8Array>
  /** Stop pending work, terminate the Worker, and await its exit. */
  dispose(): Promise<void>
}

/** Parent-to-worker operations; neither message contains a caller-selected file path. */
export type FontCommand =
  | { readonly id: number; readonly kind: 'resolve'; readonly request: FontResolveRequest }
  | { readonly id: number; readonly kind: 'read'; readonly asset: FontAssetId }

/** Worker replies retain their operation discriminator across structured cloning. */
export type FontReply =
  | { readonly id: number; readonly kind: 'resolved'; readonly value: FontResolution }
  | { readonly id: number; readonly kind: 'bytes'; readonly value: Uint8Array }
  | { readonly id: number; readonly kind: 'failed'; readonly message: string }
