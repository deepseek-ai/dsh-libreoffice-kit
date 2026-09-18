/** Browser owner for an editable document and its ordered engine notifications. */
import { openBrowserConnection } from './connection.ts'
import { BrowserRenderError } from './types.ts'
import type { BrowserEditor, BrowserEditorEvent, BrowserEditorOptions, BrowserEditorState } from './editor-types.ts'
import type { EditorOperation } from './protocol.ts'

/**
 * Import an Office document once and retain its editable model until disposal.
 * @param options - OOXML bytes, version-matched engine resources and Host fonts.
 * @param signal - Document lifetime; visibility changes must not abort it.
 * @returns An editor whose exports remain unsaved until the caller writes them.
 */
export async function openEditor(options: BrowserEditorOptions, signal?: AbortSignal): Promise<BrowserEditor> {
  const listeners = new Set<(event: BrowserEditorEvent) => void>()
  let state: BrowserEditorState | undefined
  const connection = await openBrowserConnection(options, signal, true, (event) => {
    if (event.type === 'state') state = event.state
    for (const listener of listeners) {
      try { listener(event) } catch (error) { console.error('Office editor observer failed', error) }
    }
  })
  state = connection.opened.editor
  if (!state) { await connection.dispose(); throw new BrowserRenderError('invalid-document', 'LibreOffice returned no editing state.') }
  async function edit(operation: EditorOperation) {
    const response = await connection.request({ type: 'edit', operation })
    if (response.type !== 'edited') throw new BrowserRenderError('render-failed', 'LibreOffice returned an unexpected editing response.')
    return response
  }
  return {
    get state() { return state! },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async input(event) { await edit({ type: 'input', event }) },
    async dispatch(command, args) { await edit({ type: 'command', command, ...(args ? { arguments: args } : {}) }) },
    async paste(text) { await edit({ type: 'paste', text }) },
    async copy() { return (await edit({ type: 'copy' })).text ?? '' },
    async setPart(part) { await edit({ type: 'part', part }) },
    async setViewport(rectangle, scale) { await edit({ type: 'viewport', rectangle, scale }) },
    async renderTile(request, tileSignal) {
      const response = await connection.request({ type: 'editor-tile', request }, tileSignal)
      if (response.type !== 'tile') throw new BrowserRenderError('render-failed', 'LibreOffice returned an unexpected tile response.')
      return response.tile
    },
    async capture(request, captureSignal) {
      const response = await connection.request({ type: 'capture', request }, captureSignal)
      if (response.type !== 'captured') throw new BrowserRenderError('render-failed', 'LibreOffice returned an unexpected capture response.')
      return response.capture
    },
    async save() {
      const response = await edit({ type: 'save' })
      if (!response.snapshot) throw new BrowserRenderError('render-failed', 'LibreOffice returned no saved document bytes.')
      return response.snapshot
    },
    dispose() { listeners.clear(); return connection.dispose() },
  }
}
