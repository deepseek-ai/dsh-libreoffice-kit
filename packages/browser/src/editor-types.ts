/** Persistent, single-user Office editing in one browser Worker. */
import type { BrowserDocumentOptions, BrowserPage, BrowserRenderErrorCode, BrowserTile } from './types.ts'

/** Formats qualified for editing and saving in their original container. */
export type BrowserEditorFormat = 'doc' | 'docx' | 'xls' | 'xlsx' | 'ppt' | 'pptx'

/** Editor source, engine resources and Host font service. */
export type BrowserEditorOptions = Omit<BrowserDocumentOptions, 'extension'> & { readonly extension: BrowserEditorFormat; readonly readOnly?: boolean }

/** Document coordinates in CSS pixels at 96 DPI, independent of zoom. */
export interface BrowserRectangle extends BrowserPage { readonly x: number; readonly y: number }

/** A Writer document, Calc worksheet or Impress slide, measured when selected. */
export interface BrowserEditorPart extends BrowserPage { readonly name: string }

/** Geometry and current editing state; snapshots are immutable to consumers. */
export interface BrowserEditorState {
  readonly documentType: 'text' | 'spreadsheet' | 'presentation'
  readonly revision: number
  /** Changes whenever document pixels or geometry are invalidated, independently of saved edits. */
  readonly renderGeneration: number
  readonly part: number
  readonly parts: readonly BrowserEditorPart[]
  /** Writer's visible page rectangles within its continuous document. */
  readonly pages: readonly BrowserRectangle[]
  readonly cursor: BrowserRectangle | null
  readonly cursorVisible: boolean
  readonly selection: readonly BrowserRectangle[]
  readonly graphicSelection: BrowserRectangle | null
  readonly cellAddress: string
  readonly cellFormula: string
  /** UNO command names to their current values, including undo and formatting state. */
  readonly commands: Readonly<Record<string, string>>
}

/** Input codes follow LibreOfficeKit; pointer coordinates use CSS pixels at 96 DPI. */
export type BrowserEditorInput =
  | { readonly type: 'key'; readonly action: 'down' | 'up'; readonly character: number; readonly key: number }
  | { readonly type: 'pointer'; readonly action: 'down' | 'up' | 'move'; readonly x: number; readonly y: number; readonly buttons: number; readonly modifiers: number; readonly clicks: number }
  | { readonly type: 'composition'; readonly action: 'update' | 'end'; readonly text: string }

/** Typed UNO property values, serialized inside the Worker. */
export type BrowserCommandArguments = Readonly<Record<string, { readonly type: 'string' | 'boolean' | 'long' | 'short' | 'float'; readonly value: string | boolean | number }>>

/** One view-relative render request. */
export interface BrowserEditorTileRequest extends BrowserRectangle { readonly part: number; readonly scale: number }

/** One bounded, serialized capture; cached pixels must be current at generation. */
export interface BrowserEditorCaptureRequest {
  readonly generation?: number
  readonly maxPixels: number
  readonly selection?: { readonly sheet?: string; readonly range?: string; readonly scale: number }
  readonly tiles: readonly { readonly request: BrowserEditorTileRequest; readonly cached?: BrowserTile }[]
}

/** Immutable pixels and geometry observed before a later input can run. */
export interface BrowserEditorCapture {
  readonly state: BrowserEditorState
  readonly tiles: readonly BrowserTile[]
  readonly regions: readonly BrowserEditorCaptureRegion[]
}

/** A Writer page, slide, or bounded worksheet data area ready for raster export. */
export interface BrowserEditorCaptureRegion {
  readonly part: number
  readonly rectangle: BrowserRectangle
  readonly sheet?: string
  readonly range?: string
}

/** A complete Office export, associated with the edits it includes. */
export interface BrowserEditorSnapshot { readonly data: Uint8Array<ArrayBuffer>; readonly revision: number; readonly extension: BrowserEditorFormat }

/** State and tile events are delivered in engine order. A null region invalidates the entire part. */
export type BrowserEditorEvent =
  | { readonly type: 'state'; readonly state: BrowserEditorState }
  | { readonly type: 'invalidate'; readonly part: number; readonly rectangle: BrowserRectangle | null; readonly revision: number }
  | { readonly type: 'error'; readonly code: BrowserRenderErrorCode; readonly message: string }

/** A retained editable document; hiding a view does not dispose its session. */
export interface BrowserEditor {
  /** Latest engine snapshot; subscribe for later changes. */
  readonly state: BrowserEditorState
  /** Observe state and invalidation events; one throwing observer cannot interrupt others. */
  subscribe(listener: (event: BrowserEditorEvent) => void): () => void
  /** Apply one keyboard, pointer or IME event in order. */
  input(event: BrowserEditorInput): Promise<void>
  /** Execute a LibreOffice editing command, such as .uno:Bold or .uno:Undo. */
  dispatch(command: string, args?: BrowserCommandArguments): Promise<void>
  /** Insert plain UTF-8 text at the current selection, with engine-owned undo. */
  paste(text: string): Promise<void>
  /** Read the current selection as plain text. */
  copy(): Promise<string>
  /** Activate one worksheet or slide. Writer has a single part. */
  setPart(part: number): Promise<void>
  /** Inform the engine of visible document coordinates and zoom. */
  setViewport(rectangle: BrowserRectangle, scale: number): Promise<void>
  /** Render without changing the document; callers own caching and invalidation. */
  renderTile(request: BrowserEditorTileRequest, signal?: AbortSignal): Promise<BrowserTile>
  /** Capture bounded tiles under one render generation; an empty list is an idle barrier. */
  capture(request: BrowserEditorCaptureRequest, signal?: AbortSignal): Promise<BrowserEditorCapture>
  /** Export the current revision. Only a successful Host write confirms it saved. */
  save(): Promise<BrowserEditorSnapshot>
  /** Await engine and Worker disposal; repeated calls share completion. */
  dispose(): Promise<void>
}
