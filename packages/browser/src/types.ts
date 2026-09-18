/** Browser-facing document rendering and host font interfaces. */

/** Independently served, version-matched engine resources. */
export interface BrowserEngineAssets {
  readonly workerUrl: string
  readonly loaderUrl: string
  readonly wasmUrl: string
  readonly dataUrl: string
  readonly metadataUrl: string
  readonly programDirectory: string
}

/** VCL attributes passed unchanged to the Host's font matcher. */
export interface BrowserFontRequest {
  readonly mode?: 'full'
  readonly family: string
  readonly style: string
  readonly weight: number
  readonly italic: number
  readonly width: number
  readonly pitch: number
  readonly language: string
  readonly codePoints: readonly number[]
}

/** Immutable per-face font subsets; equal ids and aliases must identify equal bytes. */
export interface BrowserFontResult {
  readonly fonts: readonly { readonly id: string; readonly data: Uint8Array; readonly family: string; readonly alias: string; readonly format?: 'ttf' | 'otf' | 'ttc' }[]
  readonly missingFamily?: string
  /** Missing scalars reported by the Host, independently of a substituted family. */
  readonly unresolvedCodePoints?: readonly number[]
}

/** All sizes are CSS pixels at 96 pixels per inch. */
export interface BrowserPage { readonly width: number; readonly height: number }

/** Page-relative rectangle, rasterized at the requested pixel scale. */
export interface BrowserTileRequest {
  readonly pageIndex: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly scale: number
}

/** Owned, non-premultiplied RGBA pixels accepted by ImageData. */
export interface BrowserTile {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8ClampedArray
}

/** Caller-owned source bytes are copied before Worker transfer. */
export interface BrowserDocumentOptions {
  readonly data: Uint8Array
  readonly extension: 'pdf'
  readonly assets: BrowserEngineAssets
  /** Maximum time for each load, render, font request, or teardown operation. */
  readonly timeoutMs: number
  /** Maximum ZIP entries inspected before LibreOffice loads OOXML. */
  readonly maxArchiveEntries: number
  /** Maximum total declared uncompressed OOXML bytes. */
  readonly maxUncompressedBytes: number
  /** Total distinct font bytes retained in this document's MEMFS. */
  readonly maxLoadedFontBytes: number
  /** The same ordered substitution groups used by the Host font matcher. */
  readonly fontFallbacks: readonly (readonly string[])[]
  /** Match fonts without blocking the browser's main thread. */
  readonly resolveFonts: (request: BrowserFontRequest, signal: AbortSignal) => Promise<BrowserFontResult>
  /** Called with unavailable declared OOXML families; binary DOC/PPT have no font diagnostics. */
  readonly onMissingFonts?: (families: readonly string[]) => void
}

/** One Worker-owned, read-only Office document. */
export interface BrowserDocument {
  /** Visible pages; Writer omits zero-area automatic section parity placeholders. */
  readonly pages: readonly BrowserPage[]
  /** Render a page region; cancellation discards that region without closing the document. */
  renderTile(request: BrowserTileRequest, signal?: AbortSignal): Promise<BrowserTile>
  /** Await document, office and pthread disposal; repeated calls share completion. */
  dispose(): Promise<void>
}

/** Stable failures callers may map to their own localized product copy. */
export type BrowserRenderErrorCode = 'unavailable' | 'invalid-document' | 'timeout' | 'font-limit' | 'font-unavailable' | 'disposed' | 'render-failed' | 'stale-part'

/** A rendering failure with a stable machine-readable category. */
export class BrowserRenderError extends Error {
  constructor(readonly code: BrowserRenderErrorCode, message: string) {
    super(message)
    this.name = 'BrowserRenderError'
  }
}
