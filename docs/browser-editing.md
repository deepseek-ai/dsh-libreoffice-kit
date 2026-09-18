# Browser Office reading

`@deepseek-ai/libreoffice-kit/browser` exposes `openOfficeDocument` for DOC/DOCX, XLS/XLSX and PPT/PPTX. Each call owns one LibreOffice model and a dedicated Worker. The model is always read-only and paints directly to tiles without a PDF intermediate. The former `openEditor`, text/IME input, arbitrary commands, paste, save and capture APIs are removed in rc5; no editable compatibility mode remains.

## Document ownership and selection

Pass source bytes, `extension`, matching `assets`, asynchronous `resolveFonts`, `fontFallbacks` and explicit limits described by [the browser API](../packages/browser/README.md). The connection copies borrowed source bytes before transfer. Serve the resources from a secure, cross-origin-isolated page. Source and font loading still write internal virtual files, but a reading session cannot export replacement OOXML or write a Host file.

Retain the session while a tab is hidden. Hiding the display can pause viewport and tile requests without destroying the model. Actual close calls `dispose()` or aborts the lifetime signal; disposal rejects pending work, destroys the document and office and joins the Worker with a bounded shutdown handshake. Pixel/font budgets do not bound the complete engine's memory.

- `pointer(event)` accepts primary-button selection with LOK Shift/Control modifiers. `navigate({key, extend?, word?})` accepts only arrow, Home/End and PageUp/PageDown keys. Raw characters, Delete, IME and arbitrary key codes are unavailable.
- `selectAll()` selects content and `copy()` returns plain text. Writer and Calc support text/cell ranges. Impress copies all text in the selected text objects or groups, with line breaks between paragraphs/objects; it does not enter text-edit mode or support substring selection inside an object.
- `setPart(index)` selects a worksheet or slide. `goToCell(address)` selects a bounded A1 cell or range on the current worksheet. `state.cellFormula` is informational and cannot be submitted back as an edit.
- The Worker independently rejects unsupported operations. Kernel loading and view configuration also enforce read-only mode. Node/CLI conversion and recalculation remain separate explicit output APIs.

## Writer layouts and tiles

Writer defaults to `paginated`. `setLayout({mode:'continuous', width, anchor?})` reflows text to the available content width, measured in document CSS pixels at 96 DPI. The application supplies its visual padding outside that width. Width and raster density are independent: pass the available screen width divided by zoom, and reserve DPR for tile density. Fixed tables, images or drawings may extend beyond the available width and need horizontal scrolling.

An optional `anchor:{x,y}` identifies a point in the previous layout. The engine resolves nearby body text and returns its rectangle in the new layout, without moving selection. If no anchor is returned, the application may restore normalized reading progress. `setLayout({mode:'paginated'})` restores the document's original page geometry. Continuous geometry contains one rectangle rather than synthetic paper gaps.

`setViewport(rectangle, scale)` updates only scrolling and raster zoom. Equal widths do not trigger layout; while one layout is running, newer pending widths replace older pending widths. `layoutGeneration` changes when the layout changes; `renderGeneration` changes on pixel/geometry invalidation, including delayed fonts. Invalidation events identify a part and rectangle; a null rectangle means the whole part, and part `-1` means every part.

`renderTile(request, signal)` returns owned RGBA bytes with no selection/cursor controls baked in. It paints only the current worksheet/slide (`request.part === state.part` when the Worker executes it). A queued tile for a former part rejects with `BrowserRenderError.code === 'stale-part'` before painting, preserving the current selection and keeping the document usable. Treat this as an expired display request. Navigate with `setPart()` before requesting that part's tiles; the browser API does not perform background cross-part drawing.

The application deduplicates requests, caches pixels with a bounded budget and discards truly invalid results. Aborting a tile request abandons that consumer's result, rather than closing the document. Keep already-started valid work if another consumer or the cache still needs it. Office image export uses the Node/CLI `render` path, independently of the visible reading session.

```js
import { openOfficeDocument } from '@deepseek-ai/libreoffice-kit/browser';

const document = await openOfficeDocument(options, documentLifetime);
try {
  await document.setLayout({ mode: 'continuous', width: 600 });
  await document.selectAll();
  const selectedText = await document.copy();
  const tile = await document.renderTile({ part: 0, x: 0, y: 0, width: 256, height: 256, scale: 2 });
  // Display tile pixels and use selectedText in the application's copy action.
} finally {
  await document.dispose();
}
```

## Installed qualification

Run `scripts/smoke-browser-preview.mjs` against the [packed two-package candidate](building.md). It installs outside the repository, blocks external browser requests, verifies three-format rendering/selection/copy, sends forbidden operations to the real shipped Worker, compares source and document pixels, exercises Writer reflow and waits for Worker exit. `preview-runtime.json` uses a versioned schema and binds results to both archive hashes and the source commit. Dirty receipts remain local development evidence; the npm staging gate requires clean source and complete runtime evidence.

The SDK supplies reading primitives rather than a complete application interface. Complex layout and new fonts may take longer than normal scrolling. Performance and memory observations describe the measured fixtures and host; they do not establish a universal latency bound.
