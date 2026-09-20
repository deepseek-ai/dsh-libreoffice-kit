/** Retained Office reading sessions; this API never exposes document mutation. */
import type { BrowserDocumentOptions, BrowserPage, BrowserRenderErrorCode, BrowserTile } from './types.ts'

/** Office containers supported by the reading engine. */
export type OfficeDocumentFormat = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'
/** Source bytes, engine resources and Host fonts; all sessions are read-only. */
export type OfficeDocumentOptions = Omit<BrowserDocumentOptions, 'extension'> & { readonly extension: OfficeDocumentFormat }
/** Document coordinates in CSS pixels at 96 DPI, independent of zoom. */
export interface OfficeDocumentRectangle extends BrowserPage { readonly x: number; readonly y: number }
/** One Writer document, Calc worksheet or Impress slide. */
export interface OfficeDocumentPart extends BrowserPage { readonly name: string }
/** Writer layout; other document types always remain paginated. */
export type OfficeDocumentLayout = 'paginated' | 'continuous'
/** A point in the previous layout, normally the upper visible line of body text. */
export interface OfficeDocumentAnchor { readonly x: number; readonly y: number }
/** Continuous width is the available content width in document CSS pixels. */
export type OfficeDocumentLayoutRequest =
  | { readonly mode: 'paginated'; readonly anchor?: OfficeDocumentAnchor }
  | { readonly mode: 'continuous'; readonly width: number; readonly anchor?: OfficeDocumentAnchor }
/** An optional body-text rectangle in the new layout for restoring reading position. */
export interface OfficeDocumentLayoutResult { readonly changed: boolean; readonly anchor?: OfficeDocumentRectangle }
/** Geometry and selection; cursor is a navigation/cell rectangle, never an editing caret. */
export interface OfficeDocumentState {
  readonly documentType: 'text' | 'spreadsheet' | 'presentation'
  readonly renderGeneration: number
  readonly layoutGeneration: number
  readonly layout: OfficeDocumentLayout
  readonly part: number
  readonly parts: readonly OfficeDocumentPart[]
  /** Writer page rectangles in paginated mode; one continuous rectangle otherwise. */
  readonly pages: readonly OfficeDocumentRectangle[]
  readonly cursor: OfficeDocumentRectangle | null
  readonly selection: readonly OfficeDocumentRectangle[]
  readonly graphicSelection: OfficeDocumentRectangle | null
  readonly cellAddress: string
  readonly cellFormula: string
}
/** Primary-button selection; modifiers use LOK Shift (0x1000) / Control (0x2000). */
export interface OfficeDocumentPointer {
  readonly action: 'down' | 'up' | 'move'
  readonly x: number
  readonly y: number
  readonly buttons: number
  readonly modifiers: number
  readonly clicks: number
}
/** Only navigation keys are accepted; no arbitrary character or key injection. */
export interface OfficeDocumentNavigation {
  readonly key: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'pageUp' | 'pageDown'
  readonly extend?: boolean
  readonly word?: boolean
}
/** One region of the current part. Pixel density does not change document layout. */
export interface OfficeDocumentTileRequest extends OfficeDocumentRectangle { readonly part: number; readonly scale: number }
/** A null rectangle invalidates an entire part; negative part means every part. */
export type OfficeDocumentEvent =
  | { readonly type: 'state'; readonly state: OfficeDocumentState }
  | { readonly type: 'invalidate'; readonly part: number; readonly rectangle: OfficeDocumentRectangle | null; readonly generation: number }
  | { readonly type: 'error'; readonly code: BrowserRenderErrorCode; readonly message: string }
/** Retain this session while hidden; dispose only when the document is closed. */
export interface OfficeDocument {
  readonly state: OfficeDocumentState
  subscribe(listener: (event: OfficeDocumentEvent) => void): () => void
  pointer(event: OfficeDocumentPointer): Promise<void>
  navigate(event: OfficeDocumentNavigation): Promise<void>
  selectAll(): Promise<void>
  copy(): Promise<string>
  /** Select a bounded A1 cell or range on the current worksheet. */
  goToCell(address: string): Promise<void>
  setPart(part: number): Promise<void>
  setViewport(rectangle: OfficeDocumentRectangle, scale: number): Promise<void>
  /** Coalesces pending widths; superseded callers observe the newest applied layout. */
  setLayout(request: OfficeDocumentLayoutRequest): Promise<OfficeDocumentLayoutResult>
  /** Only the current part can be painted; queued requests for a former part reject with stale-part without changing selection. */
  renderTile(request: OfficeDocumentTileRequest, signal?: AbortSignal): Promise<BrowserTile>
  dispose(): Promise<void>
}
