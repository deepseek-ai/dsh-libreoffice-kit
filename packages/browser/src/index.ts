/** Browser Office preview and retained reading entry points. */
import { openBrowserConnection } from './connection.ts'
import { BrowserRenderError } from './types.ts'
import type { BrowserDocument, BrowserDocumentOptions, BrowserTile, BrowserTileRequest } from './types.ts'
export { BrowserRenderError } from './types.ts'
export { openOfficeDocument } from './office.ts'
export { prepareOfficeBrowser } from './preparation.ts'
export type * from './office-types.ts'
export type { BrowserDocument, BrowserDocumentOptions, BrowserEngineAssets, BrowserFontIdentity, BrowserFontRequest, BrowserFontResult, BrowserPage, BrowserRenderErrorCode, BrowserResolvedFont, BrowserTile, BrowserTileRequest, PreparedBrowserEngine } from './types.ts'

/**
 * Open a read-only document; each call owns an independent Worker.
 * @param options - Source bytes, version-matched resources and Host fonts.
 * @param signal - Document lifetime; abort awaits engine teardown.
 * @returns Immutable geometry, serialized tile rendering and disposal.
 */
export async function openDocument(options: BrowserDocumentOptions, signal?: AbortSignal): Promise<BrowserDocument> {
  const connection = await openBrowserConnection(options, signal)
  let queue: Promise<unknown> = Promise.resolve()
  return {
    pages: Object.freeze(connection.opened.pages.map(page => Object.freeze(page))),
    renderTile(request: BrowserTileRequest, tileSignal?: AbortSignal): Promise<BrowserTile> {
      if (tileSignal?.aborted) return Promise.reject(tileSignal.reason)
      const task = queue.catch(() => undefined).then(async () => {
        tileSignal?.throwIfAborted()
        const response = await connection.request({ type: 'tile', request }, tileSignal)
        if (response.type !== 'tile') throw new BrowserRenderError('render-failed', 'LibreOffice returned an unexpected tile response.')
        return response.tile
      })
      queue = task
      if (!tileSignal) return task
      return new Promise((resolve, reject) => {
        const abort = (): void => { reject(tileSignal.reason) }
        tileSignal.addEventListener('abort', abort, { once: true })
        void task.then(resolve, reject).finally(() => tileSignal.removeEventListener('abort', abort))
      })
    },
    dispose: connection.dispose,
  }
}
