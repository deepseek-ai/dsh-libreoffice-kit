/** Private messages exchanged by the document owner and its single engine Worker. */
import type { BrowserDocumentOptions, BrowserFontRequest, BrowserPage, BrowserRenderErrorCode, BrowserTile, BrowserTileRequest } from './types.ts'
import type { BrowserCommandArguments, BrowserEditorEvent, BrowserEditorInput, BrowserEditorOptions, BrowserEditorSnapshot, BrowserEditorState, BrowserEditorTileRequest, BrowserRectangle } from './editor-types.ts'

export const FONT_CHUNK_BYTES = 1024 * 1024
export const FONT_HEADER_BYTES = 8
export const enum FontState { Waiting, Header, Bytes, Done, Error, Cancelled }
export type WorkerOptions = Omit<BrowserDocumentOptions | BrowserEditorOptions, 'resolveFonts' | 'onMissingFonts'>
export type EditorOperation =
  | { readonly type: 'input'; readonly event: BrowserEditorInput }
  | { readonly type: 'command'; readonly command: string; readonly arguments?: BrowserCommandArguments }
  | { readonly type: 'paste'; readonly text: string }
  | { readonly type: 'copy' }
  | { readonly type: 'part'; readonly part: number }
  | { readonly type: 'viewport'; readonly rectangle: BrowserRectangle; readonly scale: number }
  | { readonly type: 'save' }
export type OwnerMessage =
  | { readonly type: 'open'; readonly id: number; readonly options: WorkerOptions; readonly channel: SharedArrayBuffer; readonly editing?: boolean }
  | { readonly type: 'tile'; readonly id: number; readonly request: BrowserTileRequest }
  | { readonly type: 'editor-tile'; readonly id: number; readonly request: BrowserEditorTileRequest }
  | { readonly type: 'edit'; readonly id: number; readonly operation: EditorOperation }
  | { readonly type: 'dispose'; readonly id: number }
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
export type OwnerRequest = WithoutId<OwnerMessage>
export type WorkerMessage =
  | { readonly type: 'opened'; readonly id: number; readonly pages: readonly BrowserPage[]; readonly editor?: BrowserEditorState }
  | { readonly type: 'tile'; readonly id: number; readonly tile: BrowserTile }
  | { readonly type: 'edited'; readonly id: number; readonly text?: string; readonly snapshot?: BrowserEditorSnapshot }
  | { readonly type: 'editor-event'; readonly event: BrowserEditorEvent }
  | { readonly type: 'disposed'; readonly id: number }
  | { readonly type: 'error'; readonly id: number; readonly code: BrowserRenderErrorCode; readonly message: string; readonly fatal: boolean }
  | { readonly type: 'font'; readonly request: BrowserFontRequest }
  | { readonly type: 'font-next' }
  | { readonly type: 'missing-fonts'; readonly families: readonly string[] }
export interface FontHeader {
  readonly fonts: readonly { readonly id: string; readonly bytes: number; readonly family: string; readonly alias: string }[]
  readonly missingFamily?: string
}
