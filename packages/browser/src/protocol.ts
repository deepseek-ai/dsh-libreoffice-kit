/** Private messages exchanged by the document owner and its single engine Worker. */
import type { BrowserDocumentOptions, BrowserFontRequest, BrowserPage, BrowserRenderErrorCode, BrowserTile, BrowserTileRequest } from './types.ts'

export const FONT_CHUNK_BYTES = 1024 * 1024
export const FONT_HEADER_BYTES = 8
export const enum FontState { Waiting, Header, Bytes, Done, Error, Cancelled }
export type WorkerOptions = Omit<BrowserDocumentOptions, 'resolveFonts' | 'onMissingFonts'>
export type OwnerMessage =
  | { readonly type: 'open'; readonly id: number; readonly options: WorkerOptions; readonly channel: SharedArrayBuffer }
  | { readonly type: 'tile'; readonly id: number; readonly request: BrowserTileRequest }
  | { readonly type: 'dispose'; readonly id: number }
export type WorkerMessage =
  | { readonly type: 'opened'; readonly id: number; readonly pages: readonly BrowserPage[] }
  | { readonly type: 'tile'; readonly id: number; readonly tile: BrowserTile }
  | { readonly type: 'disposed'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly code: BrowserRenderErrorCode; readonly message: string; readonly fatal: boolean }
  | { readonly type: 'font'; readonly request: BrowserFontRequest }
  | { readonly type: 'font-next' }
  | { readonly type: 'missing-fonts'; readonly families: readonly string[] }
export interface FontHeader {
  readonly fonts: readonly { readonly id: string; readonly bytes: number; readonly family: string; readonly alias: string }[]
  readonly missingFamily?: string
}
