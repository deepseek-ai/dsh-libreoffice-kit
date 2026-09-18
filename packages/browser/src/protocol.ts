/** Private messages exchanged by the document owner and its single engine Worker. */
import type { BrowserDocumentOptions, BrowserFontRequest, BrowserPage, BrowserRenderErrorCode, BrowserTile, BrowserTileRequest } from './types.ts'
import type { OfficeDocumentEvent, OfficeDocumentNavigation, OfficeDocumentOptions, OfficeDocumentState, OfficeDocumentPointer, OfficeDocumentLayoutRequest, OfficeDocumentLayoutResult, OfficeDocumentTileRequest, OfficeDocumentRectangle } from './office-types.ts'

export const FONT_CHUNK_BYTES = 1024 * 1024
export const FONT_HEADER_BYTES = 8
export const enum FontState { Waiting, Header, Bytes, Done, Error, Cancelled }
export type WorkerOptions = Omit<BrowserDocumentOptions | OfficeDocumentOptions, 'resolveFonts' | 'onMissingFonts'>
export type OfficeOperation =
  | { readonly type: 'pointer'; readonly event: OfficeDocumentPointer }
  | { readonly type: 'navigate'; readonly event: OfficeDocumentNavigation }
  | { readonly type: 'select-all' }
  | { readonly type: 'cell'; readonly address: string }
  | { readonly type: 'copy' }
  | { readonly type: 'part'; readonly part: number }
  | { readonly type: 'viewport'; readonly rectangle: OfficeDocumentRectangle; readonly scale: number }
  | { readonly type: 'layout'; readonly request: OfficeDocumentLayoutRequest }
export type OwnerMessage =
  | { readonly type: 'open'; readonly id: number; readonly options: WorkerOptions; readonly channel: SharedArrayBuffer; readonly office?: boolean }
  | { readonly type: 'tile'; readonly id: number; readonly request: BrowserTileRequest }
  | { readonly type: 'office-tile'; readonly id: number; readonly request: OfficeDocumentTileRequest }
  | { readonly type: 'office-operation'; readonly id: number; readonly operation: OfficeOperation }
  | { readonly type: 'dispose'; readonly id: number }
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export type OwnerRequest = WithoutId<OwnerMessage>
export type WorkerMessage =
  | { readonly type: 'opened'; readonly id: number; readonly pages: readonly BrowserPage[]; readonly office?: OfficeDocumentState }
  | { readonly type: 'tile'; readonly id: number; readonly tile: BrowserTile }
  | { readonly type: 'office-result'; readonly id: number; readonly text?: string; readonly layout?: OfficeDocumentLayoutResult }
  | { readonly type: 'office-event'; readonly event: OfficeDocumentEvent }
  | { readonly type: 'disposed'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly code: BrowserRenderErrorCode; readonly message: string; readonly fatal: boolean }
  | { readonly type: 'font'; readonly request: BrowserFontRequest; readonly known: readonly FontIdentity[] }
  | { readonly type: 'font-next' }
  | { readonly type: 'missing-fonts'; readonly families: readonly string[] }
/** Immutable bytes already installed in this document's MEMFS. */
export interface FontIdentity { readonly id: string; readonly bytes: number; readonly format?: 'ttf' | 'otf' | 'ttc' }
export interface FontHeader {
  readonly fonts: readonly (FontIdentity & { readonly family: string; readonly alias: string; readonly reference?: true })[]
  readonly missingFamily?: string
}
