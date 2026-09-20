/** Browser owner for a retained read-only Office model. */
import { openBrowserConnection } from './connection.ts'
import { BrowserRenderError } from './types.ts'
import type { OfficeDocument, OfficeDocumentEvent, OfficeDocumentOptions, OfficeDocumentState, OfficeDocumentLayoutRequest, OfficeDocumentLayoutResult } from './office-types.ts'
import type { OfficeOperation } from './protocol.ts'

/** Open one read-only Office model; source bytes remain owned by the caller. */
export async function openOfficeDocument(options: OfficeDocumentOptions, signal?: AbortSignal): Promise<OfficeDocument> {
  const listeners = new Set<(event: OfficeDocumentEvent) => void>()
  let state: OfficeDocumentState | undefined
  const connection = await openBrowserConnection(options, signal, true, (event) => {
    if (event.type === 'state') state = event.state
    for (const listener of listeners) {
      try { listener(event) } catch (error) { console.error('Office document observer failed', error) }
    }
  })
  state = connection.opened.office
  if (!state) { await connection.dispose(); throw new BrowserRenderError('invalid-document', 'LibreOffice returned no reading state.') }
  async function operate(operation: OfficeOperation) {
    const response = await connection.request({ type: 'office-operation', operation })
    if (response.type !== 'office-result') throw new BrowserRenderError('render-failed', 'LibreOffice returned an unexpected reading response.')
    return response
  }
  let layoutRunning = false
  let pendingLayout: { request: OfficeDocumentLayoutRequest; waiters: ReturnType<typeof Promise.withResolvers<OfficeDocumentLayoutResult>>[] } | undefined
  async function applyLayouts(): Promise<void> {
    layoutRunning = true
    while (pendingLayout) {
      const next = pendingLayout
      pendingLayout = undefined
      try {
        const response = await operate({ type: 'layout', request: next.request })
        if (!response.layout) throw new BrowserRenderError('render-failed', 'LibreOffice returned no layout result.')
        for (const waiter of next.waiters) waiter.resolve(response.layout)
      } catch (error) { for (const waiter of next.waiters) waiter.reject(error) }
    }
    layoutRunning = false
  }
  return {
    get state() { return state! },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async pointer(event) { await operate({ type: 'pointer', event }) },
    async navigate(event) { await operate({ type: 'navigate', event }) },
    async selectAll() { await operate({ type: 'select-all' }) },
    async copy() { return (await operate({ type: 'copy' })).text ?? '' },
    async goToCell(address) { await operate({ type: 'cell', address }) },
    async setPart(part) { await operate({ type: 'part', part }) },
    async setViewport(rectangle, scale) { await operate({ type: 'viewport', rectangle, scale }) },
    setLayout(request) {
      const waiter = Promise.withResolvers<OfficeDocumentLayoutResult>()
      pendingLayout = { request, waiters: [...(pendingLayout?.waiters ?? []), waiter] }
      if (!layoutRunning) void applyLayouts()
      return waiter.promise
    },
    async renderTile(request, tileSignal) {
      const response = await connection.request({ type: 'office-tile', request }, tileSignal)
      if (response.type !== 'tile') throw new BrowserRenderError('render-failed', 'LibreOffice returned an unexpected tile response.')
      return response.tile
    },
    dispose() { listeners.clear(); return connection.dispose() },
  }
}
