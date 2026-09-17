# Browser Office editing

`@deepseek-ai/libreoffice-kit-browser` exposes `openEditor` for DOCX, XLSX and PPTX. Each editor owns one LibreOffice instance and a persistent document in a dedicated Worker. Keyboard, mouse, text and IME input mutate that model; LibreOffice reports changed geometry and dirty rectangles for direct Canvas painting. Saving exports OOXML. No PDF is created anywhere in this path.

## Open and retain a document

Pass the source bytes, `extension`, version-matched `assets`, the asynchronous `resolveFonts` callback, `fontFallbacks`, and explicit resource limits used by [the browser API](../packages/browser/README.md). The engine copies borrowed source bytes before transfer. The application must serve the resources from a secure, cross-origin-isolated page and provide fonts for new text as well as imported content. Editing supports the three OOXML suffixes only; legacy binary Office files retain the read-only preview API.

The returned editor remains live until `dispose()` or its lifetime signal aborts. Hiding a tab need not end that lifetime. Retained editors keep their complete models and WASM memory even when no Canvas is mounted. Pixel and font budgets do not bound total process memory.

## Input, state and drawing

- `input(event)` accepts LibreOfficeKit key codes, mouse buttons/modifiers, or IME `update` and `end` events. Coordinates are CSS pixels at 96 DPI. VCL key codes are not DOM key codes; applications translate them. Browser MouseEvents carry the click count needed for double-click text editing.
- `paste(text)` and `copy()` use plain UTF-8 text at the current selection. Rich clipboard transfer is outside this API. `dispatch('.uno:Bold')`, `.uno:Undo`, `.uno:Redo` and typed UNO arguments expose the engine's editing commands. A dispatch completion acknowledges execution; callers observe state/content for its effect. Unknown or inapplicable UNO commands need not change the document.
- `state` and `subscribe(listener)` expose immutable revision, command, cursor, selection, object and geometry snapshots. Invalidations name a part and rectangle; a null rectangle invalidates the whole part, and part `-1` applies to every part. A throwing subscriber does not interrupt other subscribers.
- Writer has one continuous part plus its current page rectangles. Calc parts are worksheets; Impress parts are slides. `setPart(index)` changes the active part. Inactive part dimensions retain their last observation until selected so measurement does not commit an in-progress cell edit. `setViewport(rectangle, scale)` informs the engine of the visible region and zoom.
- `renderTile(request, signal)` returns owned unassociated RGBA pixels without changing the model. The application combines duplicate requests, retains a bounded cache, invalidates intersecting tiles and discards stale results. Aborting one render abandons its result; it does not undo the work or close the editor.

The Worker processes inputs in order and pumps the LibreOffice event loop in non-waiting slices between messages. Drawing requests and inputs share that engine thread. Complex layout, formula recalculation, export or a new font can take longer than an ordinary edit; non-blocking ownership does not promise a fixed completion deadline. The configured operation timeout closes an unresponsive editor.

## Save a snapshot

`save()` returns `{ data, extension, revision }`. It exports the edits ordered before it and does not write a Host file or acknowledge application persistence. The application writes those bytes against the source file's observed version and marks only the returned revision saved after that write succeeds. Input that arrives during the Host write remains dirty. A version conflict must preserve the local model until the user saves a copy or explicitly discards it.

```js
import { openEditor } from '@deepseek-ai/libreoffice-kit-browser';

const editor = await openEditor(options, documentLifetime);
try {
  await editor.input({ type: 'composition', action: 'update', text: '中文编辑' });
  await editor.input({ type: 'composition', action: 'end', text: '' });
  const snapshot = await editor.save();
  // Persist snapshot.data with the Host's version guard before confirming snapshot.revision.
} finally {
  await editor.dispose();
}
```

Applications own dirty-close decisions, file conflicts, undo/format controls and the Canvas overlays. Disposal rejects pending work, destroys the document and office, and terminates pthread Workers, with a bounded shutdown handshake before forced termination.

## Qualification and limits

The installed-editor smoke uses the [independent browser/font candidate](building.md). It verifies Chinese text, DOCX formatting and page geometry, Calc sheet/formula changes and recalculation, Impress object transforms, undo/redo, OOXML snapshots, browser reopen, native reopen, font delivery and Worker termination. Receipt hashes bind both archives to their source commit. Dirty-source receipts remain local development evidence.

The API supplies the LibreOffice model rather than a complete Office user interface. Track changes, charts, pivot tables, slide masters and other advanced interactions require additional application controls and qualification. Fonts and engine differences can change layout or OOXML serialization. Warm-input p95 is measured separately from cold open and complex work; the first-stage 100 ms objective is a measurement target, not a compatibility guarantee.
